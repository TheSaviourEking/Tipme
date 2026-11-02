import type { ReactNode } from 'react';

/**
 * The Tip button with what must be seen beside it. On a phone's public page this whole block is
 * the fixed bar (CSS): the confirmed total, then any notice, then the form's one submit button.
 * The notice is the one copy a phone shows and reads: CSS shows it here and removes the wording
 * under the button on the same phones (and does the reverse everywhere else), so neither the eye
 * nor a screen reader meets it twice.
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
      {notice && <p className="composer-action__notice">{notice}</p>}
      {children}
    </div>
  );
}
