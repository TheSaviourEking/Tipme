'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  CHANGELOG_STAFF_TEXT_LIMIT,
  CHANGELOG_USER_TEXT_LIMIT,
  userLine,
  userTextProblems,
  type ChangelogUserAudience,
  type OpsActedAlone,
  type OpsChangelogEntry,
  type OpsChangelogEdit,
} from '@tipme/contracts';
import {
  Choice,
  ResultKey,
  Skeleton,
  Slip,
  StateLine,
  TextareaField,
  useKeyResult,
  type SlipTone,
} from '@tipme/ui';
import { ReasonAction } from '@/components/ops/reason-action';
import {
  changelogNotes,
  changelogStamp,
  codePointCount,
  problemWords,
} from '@/lib/changelog-words';
import { can, useOpsAccess, when } from '@/lib/ops-client';
import { outcomeIsUnknown, refusalWords } from '@/lib/ops-answers';
import { opsAct, opsFetch } from '@/lib/ops-staff-api';

type Said = { tone: SlipTone; title: string; text: string };

const AUDIENCES: {
  value: ChangelogUserAudience;
  label: string;
  hint: string;
}[] = [
  { value: 'everyone', label: 'Everyone', hint: 'Every page.' },
  { value: 'pro', label: 'Pro pages', hint: 'Starts “On Pro…”.' },
  {
    value: 'early_access',
    label: 'Pro pages with early access',
    // Early access isn't built yet: say plainly that this audience is empty today.
    hint: 'Nobody sees these until early access exists.',
  },
];

const AUDIENCE_WORDS: Record<string, string> = {
  everyone: 'Everyone',
  pro: 'Pro pages',
  early_access: 'Pro pages with early access',
  staff: 'Staff only',
};

type Draft = {
  staffText: string;
  userText: string;
  audience: ChangelogUserAudience;
};

const draftOf = (entry: OpsChangelogEntry): Draft => ({
  staffText: entry.staffText,
  userText: entry.userText ?? '',
  audience: entry.audience === 'staff' ? 'everyone' : entry.audience,
});

/** Only what changed, so a staff-text save never bumps the revision users' text is approved at. */
function patchOf(entry: OpsChangelogEntry, draft: Draft): OpsChangelogEdit {
  const patch: OpsChangelogEdit = { revision: entry.revision };
  if (draft.staffText !== entry.staffText) patch.staffText = draft.staffText;
  const userText = draft.userText.trim() ? draft.userText : null;
  if (userText !== entry.userText) patch.userText = userText;
  if (userText !== null && draft.audience !== entry.audience)
    patch.audience = draft.audience;
  return patch;
}

/**
 * One changelog entry (changelog plan, Design §5): staff text, the text users read and who sees it,
 * then Approve (changelog.publish) or Ask for approval (changelog.edit). Withdraw hides it at once.
 */
export default function ChangelogEntryPage() {
  const id = useId();
  const raw = useParams<{ number: string }>().number;
  const access = useOpsAccess();
  const mayPublish = can(access, 'changelog.publish');
  const mayEdit = can(access, 'changelog.edit') || mayPublish;
  const [entry, setEntry] = useState<OpsChangelogEntry | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [failed, setFailed] = useState('');
  const [said, setSaid] = useState<Said | null>(null);
  const [savedLine, setSavedLine] = useState('');
  const [refusedProblems, setRefusedProblems] = useState<string[]>([]);
  const saidAt = useRef<HTMLDivElement>(null);

  const fetchEntry = useCallback(
    () =>
      opsFetch<OpsChangelogEntry>(
        `/v1/ops/changelog/${encodeURIComponent(raw)}`,
      ),
    [raw],
  );
  const show = (next: OpsChangelogEntry) => {
    setEntry(next);
    setDraft(draftOf(next));
    setRefusedProblems([]);
  };
  const reload = async () => {
    const result = await fetchEntry();
    if (result.ok) show(result.data);
  };

  useEffect(() => {
    if (!mayEdit) return;
    let current = true;
    void fetchEntry().then((result) => {
      if (!current) return;
      if (result.ok) {
        setEntry(result.data);
        setDraft(draftOf(result.data));
      } else setFailed(refusalWords(result));
    });
    return () => {
      current = false;
    };
  }, [mayEdit, fetchEntry]);

  const say = (next: Said) => {
    setSaid(next);
    requestAnimationFrame(() => saidAt.current?.focus());
  };

  const save = useKeyResult({ onRetry: () => void onSave() });
  const onSave = async () => {
    if (!entry || !draft) return;
    save.start();
    setSavedLine('');
    const result = await opsFetch<OpsChangelogEntry>(
      `/v1/ops/changelog/${entry.number}`,
      { method: 'PUT', body: patchOf(entry, draft) },
    );
    if (result.ok) {
      show(result.data);
      save.done('Saved.');
      setSavedLine(
        result.data.unapprovedEdit || result.data.state === 'draft'
          ? 'Saved. Users don’t read this text until it is approved.'
          : 'Saved.',
      );
      return;
    }
    if (result.code === 'CHANGELOG_EDITED_ELSEWHERE') {
      save.clear();
      await reload();
      say({
        tone: 'error',
        title: 'Not saved',
        text: refusalWords(result),
      });
      return;
    }
    save.failed({
      label: outcomeIsUnknown(result) ? 'Not sure it saved' : 'Not saved',
      detail: refusalWords(result),
      retryLabel: 'Try again',
    });
  };

  // Approve and Ask share their refusals: a 422 names the problems by the field.
  const refused = async (result: {
    status: number;
    code: string;
    reason?: string;
    message?: string;
  }) => {
    if (result.status === 400) return refusalWords(result);
    if (result.code === 'CHANGELOG_TEXT_NOT_ALLOWED') {
      setRefusedProblems(problemWords((result.reason ?? '').split(',')));
      say({ tone: 'error', title: 'Not approved', text: refusalWords(result) });
      return null;
    }
    await reload();
    say({
      tone: outcomeIsUnknown(result) ? 'unsure' : 'error',
      title: outcomeIsUnknown(result)
        ? 'We can’t say what happened'
        : 'Not done',
      text: refusalWords(result),
    });
    return null;
  };

  const onApprove = async (reason: string) => {
    if (!entry) return null;
    const result = await opsAct<OpsChangelogEntry>(
      `/v1/ops/changelog/${entry.number}/approve`,
      { method: 'POST', body: { revision: entry.revision, reason } },
    );
    if (result.kind === 'refused') return refused(result);
    if (result.kind === 'waiting') return null;
    show(result.data);
    say({
      tone: 'done',
      title: 'Approved',
      text:
        result.data.state === 'live'
          ? 'Users can read it in What’s new now.'
          : 'Users read it in What’s new once this change is live in production.',
    });
    return null;
  };

  const onAsk = async (reason: string) => {
    if (!entry) return null;
    const result = await opsAct<OpsChangelogEntry & OpsActedAlone>(
      `/v1/ops/changelog/${entry.number}/ask`,
      { method: 'POST', body: { revision: entry.revision, reason } },
    );
    if (result.kind === 'refused') return refused(result);
    await reload();
    say(
      result.kind === 'waiting'
        ? {
            tone: 'waiting',
            title: 'Waiting in Approvals',
            text: result.repeat
              ? 'This was already waiting. A publisher decides it in Approvals.'
              : 'A publisher decides it in Approvals. Users see nothing until then.',
          }
        : {
            tone: 'done',
            title: result.actedAlone ? 'Approved alone' : 'Approved',
            text: result.actedAlone
              ? 'Nobody else could approve it, so it was approved now, and the owners were alerted.'
              : 'Users read it in What’s new once this change is live in production.',
          },
    );
    return null;
  };

  const onWithdraw = async (reason: string) => {
    if (!entry) return null;
    const result = await opsAct<OpsChangelogEntry>(
      `/v1/ops/changelog/${entry.number}/withdraw`,
      { method: 'POST', body: { reason } },
    );
    if (result.kind === 'refused') return refused(result);
    if (result.kind === 'waiting') return null;
    show(result.data);
    say({
      tone: 'done',
      title: 'Withdrawn',
      text: 'Users no longer see it. It stays here, marked Withdrawn. To show it again, edit it and approve it again.',
    });
    return null;
  };

  if (!mayEdit)
    return (
      <Slip tone="neutral" title="Not part of your role" dense>
        The changelog needs changelog.edit or changelog.publish.
      </Slip>
    );
  if (failed)
    return (
      <section className="dashboard-section">
        <h1>Changelog entry</h1>
        <Slip tone="error" title="Couldn’t load this entry" dense>
          {failed}
        </Slip>
        <p>
          <Link href="/ops/changelog">Back to the changelog</Link>
        </p>
      </section>
    );
  if (!entry || !draft) return <Skeleton label="Loading the entry" />;

  const userText = draft.userText.trim();
  const userCount = codePointCount(draft.userText);
  const staffCount = codePointCount(draft.staffText);
  const liveProblems = userText
    ? problemWords(userTextProblems(draft.userText))
    : [];
  const problems = liveProblems.length > 0 ? liveProblems : refusedProblems;
  const patch = patchOf(entry, draft);
  const dirty = Object.keys(patch).length > 1;
  const staffInvalid =
    !draft.staffText.trim() || staffCount > CHANGELOG_STAFF_TEXT_LIMIT;
  const notes = changelogNotes(entry);
  // Something users would read that isn't approved yet (Design §4, PR 4 rulings 5 and 6).
  const approvable =
    entry.publishedRevision === null
      ? entry.userText !== null
      : entry.revision !== entry.publishedRevision;
  const waiting = entry.waitingRequestId !== null;
  const askable =
    entry.userText !== null &&
    approvable &&
    (!waiting || entry.editedSinceAsking === true);

  return (
    <section className="dashboard-section ops-changelog">
      <p>
        <Link href="/ops/changelog">Changelog</Link>
      </p>
      <h1>
        #{entry.number} {entry.title}
      </h1>
      <dl className="ops-facts">
        <div>
          <dt>State</dt>
          <dd>
            <StateLine tone="status">
              {[changelogStamp(entry), ...notes].join(' · ')}
            </StateLine>
          </dd>
        </div>
        <div>
          <dt>Merged</dt>
          <dd>{when(entry.mergedAt)}</dd>
        </div>
        {entry.withdrawnAt && (
          <div>
            <dt>Withdrawn</dt>
            <dd>
              {when(entry.withdrawnAt)}: {entry.withdrawnReason}
            </dd>
          </div>
        )}
      </dl>
      {waiting && (
        <p>
          {entry.editedSinceAsking
            ? 'Edited since asking: the request in Approvals is for an older text, and approving it will stop without running. '
            : 'A request to show this is waiting for a publisher. '}
          <Link href="/ops/approvals">Open Approvals</Link>
        </p>
      )}

      <div ref={saidAt} tabIndex={-1}>
        {said && (
          <Slip tone={said.tone} title={said.title} dense>
            {said.text}
          </Slip>
        )}
      </div>

      {entry.publishedText !== null &&
        entry.publishedAudience &&
        entry.publishedAudience !== 'staff' && (
          <section aria-labelledby={`${id}-now`} className="ops-section">
            <h2 id={`${id}-now`}>What users read now</h2>
            <blockquote>
              <p>
                {userLine({
                  text: entry.publishedText,
                  audience: entry.publishedAudience,
                })}
              </p>
            </blockquote>
            <p className="tm-hint">
              {AUDIENCE_WORDS[entry.publishedAudience]}. Approved
              {entry.approvedAt ? ` ${when(entry.approvedAt)}` : ''}
              {entry.approvedBy ? ` by ${entry.approvedBy}` : ''}.
              {entry.state === 'withdrawn'
                ? ' Withdrawn: users don’t see it.'
                : ''}
            </p>
          </section>
        )}

      <form
        className="settings-form"
        aria-labelledby={`${id}-edit`}
        onSubmit={(event) => {
          event.preventDefault();
          if (!staffInvalid && dirty) void onSave();
        }}
      >
        <h2 id={`${id}-edit`}>Edit</h2>
        <TextareaField
          id={`${id}-staff`}
          label="Staff text"
          hint={`Only staff read this. ${staffCount} of ${CHANGELOG_STAFF_TEXT_LIMIT} characters.`}
          rows={4}
          value={draft.staffText}
          error={
            !draft.staffText.trim()
              ? 'Write at least a few words for staff.'
              : staffCount > CHANGELOG_STAFF_TEXT_LIMIT
                ? `Keep it to ${CHANGELOG_STAFF_TEXT_LIMIT} characters.`
                : undefined
          }
          onChange={(e) => setDraft({ ...draft, staffText: e.target.value })}
        />
        <TextareaField
          id={`${id}-user`}
          label="For users"
          hint="Leave empty to keep this staff only. Never name our payment partner or say TipMe is approved or licensed."
          rows={3}
          value={draft.userText}
          error={problems.length > 0 ? problems.join(' ') : undefined}
          aria-describedby={`${id}-count`}
          onChange={(e) => {
            setRefusedProblems([]);
            setDraft({ ...draft, userText: e.target.value });
          }}
        />
        <p
          id={`${id}-count`}
          className="tm-hint"
          data-over={userCount > CHANGELOG_USER_TEXT_LIMIT ? 'true' : undefined}
        >
          {userCount} of {CHANGELOG_USER_TEXT_LIMIT} characters
        </p>
        <fieldset className="ops-changelog__audience" disabled={!userText}>
          <legend>Who sees it</legend>
          {!userText && (
            <p className="tm-hint">Write a text for users to choose.</p>
          )}
          {AUDIENCES.map((option) => (
            <Choice
              key={option.value}
              name={`${id}-audience`}
              value={option.value}
              checked={draft.audience === option.value}
              onChange={() => setDraft({ ...draft, audience: option.value })}
            >
              {option.label} <span className="tm-hint">({option.hint})</span>
            </Choice>
          ))}
        </fieldset>
        {userText && (
          <section aria-labelledby={`${id}-preview`}>
            <h3 id={`${id}-preview`}>Users would read</h3>
            <blockquote>
              <p data-testid="changelog-preview">
                {userLine({ text: userText, audience: draft.audience })}
              </p>
            </blockquote>
          </section>
        )}
        <div className="ops-actions">
          <ResultKey
            type="submit"
            result={save.result}
            pending={save.pending}
            disabled={!dirty || staffInvalid}
          >
            Save
          </ResultKey>
        </div>
        <StateLine tone="status" visuallyHidden={save.result?.kind === 'done'}>
          {savedLine}
        </StateLine>
      </form>

      <div className="ops-actions">
        {dirty ? (
          <p className="tm-hint">
            Save your changes first; approval is for what is saved.
          </p>
        ) : mayPublish ? (
          approvable && (
            <ReasonAction
              open="Approve…"
              field="Why show this to users?"
              submit="Approve and show users"
              variant="primary"
              onSubmit={onApprove}
            />
          )
        ) : (
          askable && (
            <ReasonAction
              open={waiting ? 'Ask again…' : 'Ask for approval…'}
              field="Why should users see this?"
              submit="Ask for approval"
              variant="primary"
              hint="A publisher reads this with the text in Approvals. Recorded in the audit log with your name and the time."
              onSubmit={onAsk}
            />
          )
        )}
        {entry.state !== 'withdrawn' && (
          <ReasonAction
            open="Withdraw…"
            field="Why withdraw this from users?"
            submit="Withdraw"
            hint="Users stop seeing it at once. Recorded in the audit log with your name and the time."
            onSubmit={onWithdraw}
          />
        )}
      </div>
    </section>
  );
}
