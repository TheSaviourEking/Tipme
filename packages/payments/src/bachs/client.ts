import { z } from 'zod';
import {
  BachsApiError,
  BachsProtocolError,
  BachsTransportError,
  UncertainProviderOutcomeError,
} from './errors.js';

const SANDBOX_API_ORIGIN = 'https://sandbox-api.bachs.io';
const LIVE_API_ORIGIN = 'https://api.bachs.io';

/** Which Bachs an adapter talks to. Live moves real money; sandbox never does. */
export type BachsEnvironment = 'sandbox' | 'live';

// Each environment's key only ever goes to that environment's origin.
const ENVIRONMENTS: Readonly<
  Record<BachsEnvironment, { origin: string; keyPrefix: string }>
> = {
  sandbox: { origin: SANDBOX_API_ORIGIN, keyPrefix: 'sk_sandbox_' },
  live: { origin: LIVE_API_ORIGIN, keyPrefix: 'sk_live_' },
};
/** Names TipMe to the partner; no version or host detail. */
const USER_AGENT = 'TipMe/1.0 (+https://usetipme.xyz)';
const timeoutSchema = z.number().int().min(100).max(120_000);

interface RequestOptions<T> {
  method: 'GET' | 'POST';
  path: string;
  schema: z.ZodType<T>;
  body?: unknown;
  accountReference?: string;
  idempotencyKey?: string;
  operationReference?: string;
}

interface BachsClientOptions {
  apiKey: string;
  environment: BachsEnvironment;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFetchFailure(error: unknown): boolean {
  return error instanceof TypeError || error instanceof DOMException;
}

export class BachsApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly origin: string;
  readonly environment: BachsEnvironment;

  constructor(private readonly options: BachsClientOptions) {
    // Checked at run time too: an environment from untyped config must never default to one.
    if (!Object.hasOwn(ENVIRONMENTS, options.environment))
      throw new TypeError('Bachs environment must be sandbox or live');
    const { origin, keyPrefix } = ENVIRONMENTS[options.environment];
    // Messages name the environment only, never any part of the key.
    if (!options.apiKey.startsWith(keyPrefix)) {
      throw new TypeError(
        `Bachs ${options.environment} adapter accepts ${options.environment} API keys only`,
      );
    }
    if (/[\r\n]/.test(options.apiKey))
      throw new TypeError('Invalid Bachs API key');

    this.origin = origin;
    this.environment = options.environment;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = timeoutSchema.parse(options.timeoutMs ?? 10_000);
  }

  async request<T>(options: RequestOptions<T>): Promise<T> {
    const url = new URL(options.path, this.origin);
    if (url.origin !== this.origin)
      throw new TypeError(
        `Bachs API requests must use the ${this.environment} origin`,
      );
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.apiKey}`,
      accept: 'application/json',
      // The partner's edge refuses requests without one (sandbox evidence, 9 Nov 2026).
      'User-Agent': USER_AGENT,
    };
    if (options.body !== undefined)
      headers['content-type'] = 'application/json';
    if (options.accountReference)
      headers['X-Account-Id'] = options.accountReference;
    if (options.idempotencyKey)
      headers['Idempotency-Key'] = options.idempotencyKey;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: options.method,
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (!isFetchFailure(error)) throw error;
      if (options.method === 'POST') {
        throw new UncertainProviderOutcomeError(
          options.operationReference ?? 'unknown',
          'the request may have reached the payment provider but its response was not received',
          { cause: 'no_response' },
        );
      }
      throw new BachsTransportError();
    }

    let responseText: string;
    try {
      responseText = await response.text();
    } catch (error) {
      if (!isFetchFailure(error)) throw error;
      if (options.method === 'POST') {
        throw new UncertainProviderOutcomeError(
          options.operationReference ?? 'unknown',
          'The payment provider accepted the request but its response could not be read',
          { cause: 'unreadable_response' },
        );
      }
      throw new BachsTransportError();
    }

    if (!response.ok) {
      const providerCode = this.getProviderCode(responseText);
      if (
        options.method === 'POST' &&
        (response.status >= 500 || response.status === 409)
      ) {
        throw new UncertainProviderOutcomeError(
          options.operationReference ?? 'unknown',
          `The payment provider returned HTTP ${response.status}`,
          {
            cause: 'http_error',
            httpStatus: response.status,
            ...(providerCode ? { providerCode } : {}),
          },
        );
      }
      throw new BachsApiError(response.status, providerCode);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      if (options.method === 'POST') {
        throw new UncertainProviderOutcomeError(
          options.operationReference ?? 'unknown',
          'The payment provider returned a successful response that could not be parsed',
          { cause: 'unreadable_response' },
        );
      }
      throw new BachsProtocolError(
        'The payment provider returned invalid JSON',
      );
    }

    const parsed = options.schema.safeParse(payload);
    if (!parsed.success) {
      if (options.method === 'POST') {
        throw new UncertainProviderOutcomeError(
          options.operationReference ?? 'unknown',
          'The payment provider returned a successful response with an invalid shape',
          { cause: 'unexpected_shape' },
        );
      }
      throw new BachsProtocolError(
        'The payment provider returned an unexpected response shape',
      );
    }

    return parsed.data;
  }

  private getProviderCode(responseText: string): string | undefined {
    try {
      const payload: unknown = JSON.parse(responseText);
      if (!isRecord(payload)) return undefined;
      // Bachs answers `{ "detail": …, "error_code": … }`; `{ "error": { "code" } }` is also accepted.
      // Only the code is kept: the detail text can echo request values.
      const code = isRecord(payload['error'])
        ? payload['error']['code']
        : payload['error_code'];
      return typeof code === 'string' ? code.slice(0, 80) : undefined;
    } catch {
      return undefined;
    }
  }
}

export { LIVE_API_ORIGIN, SANDBOX_API_ORIGIN };
