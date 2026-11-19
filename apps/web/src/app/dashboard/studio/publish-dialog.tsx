'use client';
import Link from 'next/link';
import { useEffect, useId, useRef } from 'react';
import type { StudioCheckResult, StudioIssue } from '@tipme/contracts';
import { Button } from '@tipme/ui';
import {
  blockedIntro,
  fixesInput,
  fixesLinks,
  fixesNow,
  publishFailureWords,
  publishTally,
  type PublishFailure,
  type SaveState,
} from './studio-editor-model';

/**
 * The publish gate (styles spec §12.1). While the check lists issues it is "Your page can’t be
 * published yet", with each issue and its fixes; once every check passes it is "Publish your
 * page?", with the summary and "Design check: N of N pass". The same dialog turns from one into
 * the other as fixes land, or back after the server refuses (its issues replace the editor's).
 * There is no "publish anyway", for staff either (plan ruling 12).
 *
 * The browser's own modal keeps focus inside. Shown by rendering it; `onClose` is Escape, Close or
 * Cancel, and the editor puts focus back on Publish. A fix that needs the person (the style cards,
 * a block's field) goes through `onInput`, which closes the dialog first.
 */
export function PublishDialog({
  check,
  summary,
  busy,
  failure,
  save,
  unsaved = false,
  readOnly,
  onPublish,
  onShowLatest,
  onFix,
  onInput,
  onClose,
}: {
  check: StudioCheckResult;
  /** "Clear · Blue · Auto · Your cover · 5 blocks". */
  summary: string;
  busy: boolean;
  /** Why the last try didn't go through, said in the dialog. */
  failure: PublishFailure | null;
  /** The draft's save state: the list says "Your draft is saved." only when it is. */
  save: SaveState;
  /** This tab has edits the server doesn't have: "Show the latest" would drop them, so it says so. */
  unsaved?: boolean;
  readOnly: boolean;
  onPublish(): void;
  /** After another tab saved first: what the banner's "Show the latest" does. */
  onShowLatest(): void;
  onFix(issue: StudioIssue, fixId: string): void;
  onInput(issue: StudioIssue, fixId: string): void;
  onClose(): void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const showLatest = useRef<HTMLButtonElement>(null);
  const count = check.issues.length;
  const view = count > 0 ? 'blocked' : 'confirm';

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  // Focus on opening and whenever the dialog turns: the question starts on Cancel, so a stray
  // Enter can't publish; the list starts on its title, read before the issues.
  useEffect(() => {
    if (view === 'confirm') cancel.current?.focus({ preventScroll: true });
    else title.current?.focus({ preventScroll: true });
  }, [view]);

  // Another tab saved first: Publish turns disabled under the focus, so focus goes to what helps.
  useEffect(() => {
    if (failure === 'stale') showLatest.current?.focus({ preventScroll: true });
  }, [failure]);

  const apply = (issue: StudioIssue, fixId: string) => {
    onFix(issue, fixId);
    // Its button is gone with the issue: the next thing to read is the title (and the count).
    title.current?.focus({ preventScroll: true });
  };

  return (
    <dialog
      ref={dialog}
      className="confirm-dialog pst-publish"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-intro`}
      data-view={view}
      onCancel={(event) => {
        // Escape: closing is ours, so React's state and the dialog can't disagree.
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id={`${id}-title`} ref={title} tabIndex={-1}>
        {view === 'blocked'
          ? 'Your page can’t be published yet'
          : 'Publish your page?'}
      </h2>
      {view === 'blocked' ? (
        <div id={`${id}-body`} className="confirm-dialog__body">
          <p id={`${id}-intro`}>{blockedIntro(count, save)}</p>
          <ul className="pst-issues" aria-label="To fix">
            {check.issues.map((issue) => (
              <li
                key={`${issue.rule}:${issue.at.row}:${issue.at.block ?? ''}`}
                className="pst-issue"
                data-rule={issue.rule}
              >
                <b>{issue.message}</b>
                {issue.detail && <p>{issue.detail}</p>}
                {issue.fixes.length > 0 && (
                  <div className="pst-issue__fixes">
                    {fixesNow(issue).map((f) => (
                      <Button
                        key={f.id}
                        variant="secondary"
                        disabled={readOnly}
                        onClick={() => apply(issue, f.id)}
                      >
                        {f.label}
                      </Button>
                    ))}
                    {fixesInput(issue).map((f) => (
                      <Button
                        key={f.id}
                        variant="quiet"
                        disabled={readOnly}
                        onClick={() => onInput(issue, f.id)}
                      >
                        {f.label}
                      </Button>
                    ))}
                    {fixesLinks(issue).map((f) => (
                      <Link
                        key={f.id}
                        className="tm-button tm-button--quiet"
                        href="/pro"
                      >
                        {f.label}
                      </Link>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div id={`${id}-body`} className="confirm-dialog__body">
          <p id={`${id}-intro`}>
            Everyone who opens your page will see this design.
          </p>
          <p className="pst-publish__summary">{summary}</p>
          <p className="pst-publish__tally">{publishTally(check)}</p>
          {failure && (
            <p className="pst-publish__failed" role="alert">
              {publishFailureWords(failure, !readOnly, unsaved)}
            </p>
          )}
        </div>
      )}
      <div className="confirm-dialog__actions">
        {view === 'blocked' ? (
          <Button variant="quiet" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            {failure === 'stale' && (
              <Button
                ref={showLatest}
                variant="secondary"
                onClick={onShowLatest}
              >
                Show the latest
              </Button>
            )}
            <Button
              ref={cancel}
              variant="quiet"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            {/* Busy keeps its focus (aria-disabled, not disabled); the editor ignores a second press. */}
            <Button
              disabled={readOnly}
              aria-disabled={busy || undefined}
              aria-busy={busy}
              onClick={onPublish}
            >
              Publish
            </Button>
          </>
        )}
      </div>
    </dialog>
  );
}
