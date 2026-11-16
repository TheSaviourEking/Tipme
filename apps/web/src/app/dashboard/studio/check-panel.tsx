'use client';
import { useRef, useState } from 'react';
import type {
  StudioCheckResult,
  StudioDocument,
  StudioIssue,
} from '@tipme/contracts';
import { Button } from '@tipme/ui';
import { fixesNow, passingWords } from './studio-editor-model';

/**
 * The design check (StudioEditor board §1, right panel; the Check tab): what must be fixed before
 * publishing, each with its one-click fixes; what the page corrected by itself ("Fixed for you");
 * and what passes. The same check runs on our servers, and their answer replaces this one after
 * every save.
 */
export function CheckPanel({
  id,
  check,
  draft,
  onFix,
  readOnly,
}: {
  /** Unique per copy: the panel shows beside the preview and in the Check tab. */
  id: string;
  check: StudioCheckResult;
  draft: StudioDocument;
  onFix(issue: StudioIssue, fixId: string): void;
  readOnly: boolean;
}) {
  const summary = useRef<HTMLParagraphElement>(null);
  const [fixed, setFixed] = useState('');
  const count = check.issues.length;
  const passing = passingWords(check, draft);
  const apply = (issue: StudioIssue, fixId: string, label: string) => {
    onFix(issue, fixId);
    setFixed(`Done: ${label.toLowerCase()}.`);
    // The issue and its buttons are gone: the next thing to read is the count.
    summary.current?.focus();
  };
  return (
    <section className="pst-check" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="pst-check__title">
        Design check
      </h2>
      <p className="pst-hint">
        Runs on every change and again before publishing. The same check runs on
        our servers, so a page can’t skip it.
      </p>
      <p
        ref={summary}
        tabIndex={-1}
        className="pst-check__count"
        data-clear={count === 0 ? '' : undefined}
      >
        {count === 0
          ? 'Every check passes'
          : `${count} to fix before publishing`}
      </p>
      <p className="sr-only" role="status">
        {fixed}
      </p>
      {count > 0 && (
        <ul className="pst-issues">
          {check.issues.map((issue) => (
            <li
              key={`${issue.rule}:${issue.at.row}:${issue.at.block ?? ''}:${issue.at.cell ?? ''}`}
              className="pst-issue"
            >
              <b>{issue.message}</b>
              {issue.detail && <p>{issue.detail}</p>}
              {fixesNow(issue).length > 0 && (
                <div className="pst-issue__fixes">
                  {fixesNow(issue).map((f) => (
                    <Button
                      key={f.id}
                      variant="secondary"
                      disabled={readOnly}
                      onClick={() => apply(issue, f.id, f.label)}
                    >
                      {f.label}
                    </Button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {check.notices.length > 0 && (
        <>
          <h3 className="pst-label">Fixed for you</h3>
          <ul className="pst-fixed">
            {check.notices.map((n) => (
              <li key={n.message}>{n.message}</li>
            ))}
          </ul>
        </>
      )}
      {passing.length > 0 && (
        <>
          <h3 className="pst-label">Passing</h3>
          <ul className="pst-passing">
            {passing.map((words) => (
              <li key={words}>
                <span>{words}</span>
                <span>Pass</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
