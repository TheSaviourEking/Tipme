'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '@tipme/ui';

/** Two-thirds of the entry, as `.confirm-dialog[data-leaving]` plays it. */
const LEAVE_MS = 160;

/**
 * A modal question. The browser's own dialog keeps focus inside and the rest of the page out of
 * reach; focus starts on Cancel, so a stray Enter can't confirm, and goes back on closing. Shown
 * by rendering it, and closed by no longer rendering it (`onCancel` comes after it has left).
 * Motion is in `.confirm-dialog`: docs/design/EXPERIENCE-AND-MOTION.md 7.8 and 7.9.
 */
export function ConfirmDialog({
  title,
  confirm,
  busy = false,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  confirm: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const before = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    cancel.current?.focus({ preventScroll: true });
    return () => {
      element?.close();
      if (before instanceof HTMLElement && before.isConnected)
        before.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(onCancel, LEAVE_MS);
    return () => clearTimeout(timer);
  }, [leaving, onCancel]);
  const leave = () => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) onCancel();
    else setLeaving(true);
  };
  const locked = busy || leaving;
  return (
    <dialog
      ref={dialog}
      className="confirm-dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
      data-leaving={leaving || undefined}
      onCancel={(event) => {
        // Escape: closing is ours, so React's state and the dialog can't disagree.
        event.preventDefault();
        if (!locked) leave();
      }}
    >
      <h2 id={`${id}-title`}>{title}</h2>
      <div id={`${id}-body`} className="confirm-dialog__body">
        {children}
      </div>
      <div className="confirm-dialog__actions">
        <Button ref={cancel} variant="quiet" disabled={locked} onClick={leave}>
          Cancel
        </Button>
        <Button disabled={locked} aria-busy={busy} onClick={onConfirm}>
          {confirm}
        </Button>
      </div>
    </dialog>
  );
}
