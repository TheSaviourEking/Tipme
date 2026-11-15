'use client';
import { useId, useState } from 'react';
import { ProMark } from './pro-mark.js';

/**
 * The Pro badge a visitor can press (option A, ProBadge board; the owner's default ruling of
 * 11 Nov 2026): it names a paid plan and says plainly that it is not a check on who runs the page,
 * so nobody reads it as "Verified business". The note sits under the badge, hidden until asked for.
 */
export function ExplainedProBadge({
  className,
  aboutHref = '/pro',
}: {
  className?: string;
  aboutHref?: string;
}) {
  const [open, setOpen] = useState(false);
  const noteId = useId();
  return (
    <>
      <button
        type="button"
        className="tm-pro-badge-button"
        aria-label="TipMe Pro, a paid plan"
        aria-expanded={open}
        aria-controls={noteId}
        onClick={() => setOpen((was) => !was)}
      >
        <ProMark {...(className ? { className } : {})} />
      </button>
      <span id={noteId} className="tm-pro-badge-note" hidden={!open}>
        TipMe Pro is a paid plan. It doesn’t mean TipMe checked who runs this
        page. <a href={aboutHref}>About Pro</a>
      </span>
    </>
  );
}
