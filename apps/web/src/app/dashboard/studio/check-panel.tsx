'use client';
import Link from 'next/link';
import { useRef, useState } from 'react';
import type { StudioCheckResult, StudioIssue } from '@tipme/contracts';
import { Button } from '@tipme/ui';
import {
  fixesInput,
  fixesLinks,
  fixesNow,
  passingWords,
} from './studio-editor-model';

/**
 * The design check (the Check tab): what must be fixed before publishing, each with its fixes; the
 * page's notices; and what passes. Page-level issues (a Pro style or the photo accent on Free,
 * `at.row` 'style' or 'accent') are listed like any other; "Choose a free style" opens the style
 * cards, "See Pro" is a link. The same check runs on our servers, and their answer replaces this
 * one after every save.
 */
export function CheckPanel({
  id,
  check,
  onFix,
  onInput,
  readOnly,
}: {
  id: string;
  check: StudioCheckResult;
  onFix(issue: StudioIssue, fixId: string): void;
  /** A fix that needs the person's input: the style cards, or the block's form at the field. */
  onInput(issue: StudioIssue, fixId: string): void;
  readOnly: boolean;
}) {
  const summary = useRef<HTMLParagraphElement>(null);
  const [fixed, setFixed] = useState('');
  const count = check.issues.length;
  const passing = passingWords(check);
  const apply = (issue: StudioIssue, fixId: string, label: string) => {
    onFix(issue, fixId);
    setFixed(`Done: ${label.toLowerCase()}.`);
    // The issue and its buttons are gone: the next thing to read is the count.
    summary.current?.focus();
  };
  return (
    <section className="pst-check" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="pst-section__title">
        Design check
      </h2>
      <p className="pst-note">
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
                      onClick={() => apply(issue, f.id, f.label)}
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
      )}
      {check.notices.length > 0 && (
        <>
          <h3 className="pst-label">Good to know</h3>
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
