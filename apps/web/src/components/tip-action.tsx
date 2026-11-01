import type { ReactNode } from 'react';

/**
 * The Tip button with what must be seen beside it. On a phone's public page this whole block is
 * the fixed bar (CSS): the confirmed total, then any notice, then the form's one submit button.
 * The notice is shown only in the bar and is read once, from the wording under the button, so it
 * is hidden from assistive technology here.
 */
export function TipAction({
  quote,
  notice,
  children,
}: {
  quote?: ReactNode;
  notice?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="composer-action">
      {quote}
      {notice && (
        <p className="composer-action__notice" aria-hidden="true">
          {notice}
        </p>
      )}
      {children}
    </div>
  );
}
