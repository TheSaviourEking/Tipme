type SentryClient = Pick<
  typeof import('@sentry/nextjs'),
  'captureException' | 'captureRouterTransitionStart'
>;
type RouterTransitionArgs = Parameters<
  SentryClient['captureRouterTransitionStart']
>;
type BrowserWindow = Pick<
  Window,
  'addEventListener' | 'removeEventListener' | 'document' | 'setTimeout'
>;

const MAX_PENDING_ERRORS = 10;
let captureDeferredExceptionHandler: (error: unknown) => void = () => {};

export function captureDeferredException(error: unknown): void {
  captureDeferredExceptionHandler(error);
}

function scheduleAfterLoad(callback: () => void): void {
  window.setTimeout(callback, 0);
}

/**
 * Keeps the error reporter off the critical rendering path while retaining early browser errors.
 */
export function deferSentry(
  load: () => Promise<SentryClient>,
  browser: BrowserWindow = window,
  scheduleDeferred: (callback: () => void) => void = scheduleAfterLoad,
): {
  onRouterTransitionStart: (...args: RouterTransitionArgs) => void;
} {
  let client: SentryClient | undefined;
  const pendingErrors: unknown[] = [];

  const capture = (error: unknown) => {
    if (client) {
      client.captureException(error);
    } else if (pendingErrors.length < MAX_PENDING_ERRORS) {
      pendingErrors.push(error);
    }
  };
  const onError = (event: ErrorEvent) => {
    capture(event.error ?? new Error('Uncaught browser error'));
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    capture(event.reason);
  };
  captureDeferredExceptionHandler = capture;

  browser.addEventListener('error', onError);
  browser.addEventListener('unhandledrejection', onUnhandledRejection);

  const initialize = () => {
    scheduleDeferred(() => {
      void load()
        .then((loadedClient) => {
          client = loadedClient;
          for (const error of pendingErrors) client.captureException(error);
          pendingErrors.length = 0;
        })
        .catch(() => {
          pendingErrors.length = 0;
          if (captureDeferredExceptionHandler === capture)
            captureDeferredExceptionHandler = () => {};
          console.warn('Client error monitoring could not be initialized.');
        })
        .finally(() => {
          browser.removeEventListener('error', onError);
          browser.removeEventListener(
            'unhandledrejection',
            onUnhandledRejection,
          );
        });
    });
  };

  if (browser.document.readyState === 'complete') initialize();
  else browser.addEventListener('load', initialize, { once: true });

  return {
    onRouterTransitionStart(...args) {
      client?.captureRouterTransitionStart(...args);
    },
  };
}
