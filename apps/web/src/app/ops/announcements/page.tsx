'use client';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import {
  ANNOUNCEMENT_AUDIENCES,
  ANNOUNCEMENT_AUDIENCE_WORDS,
  ANNOUNCEMENT_LIMITS,
  announcementTextProblems,
  type AnnouncementAudience,
  type OpsAnnouncement,
  type OpsAnnouncementDraft,
  type OpsAnnouncementList,
  type OpsAnnouncementPreview,
  type OpsAnnouncementTestSent,
} from '@tipme/contracts';
import {
  Button,
  Card,
  EmptyState,
  InputField,
  Notice,
  Skeleton,
  TextareaField,
} from '@tipme/ui';
import {
  ActionOutcome,
  outcomeOf,
  type ActionOutcomeState,
} from '@/components/ops/action-outcome';
import { ReasonAction } from '@/components/ops/reason-action';
import { refusalWords } from '@/lib/ops-answers';
import { when } from '@/lib/ops-client';
import { opsAct, opsFetch } from '@/lib/ops-staff-api';
import type { SessionResult } from '@/lib/session-client';

const fetchList = () => opsFetch<OpsAnnouncementList>('/v1/ops/announcements');

/*
 * Staff announcements by email (owner-approved, 14 Nov 2026). Staff write the words, preview the real
 * email light and dark, send themselves a test, and ask a second person to send it. While it sends,
 * the screen shows "x of N" and can stop it.
 */

const EMPTY: OpsAnnouncementDraft = {
  subject: '',
  preheader: '',
  text: '',
  buttonLabel: null,
  buttonUrl: null,
  audience: 'everyone',
};

const count = (n: number) =>
  `${n.toLocaleString('en-NG')} ${n === 1 ? 'person' : 'people'}`;

/** One line for the list and the heading: never "sent" for a send still going. */
function stateWords(a: OpsAnnouncement): string {
  const progress = `${a.queuedCount.toLocaleString('en-NG')} of ${(a.recipientCount ?? 0).toLocaleString('en-NG')}`;
  switch (a.state) {
    case 'draft':
      return 'Draft';
    case 'waiting':
      return 'Waiting for approval';
    case 'sending':
      return `Sending: ${progress}`;
    case 'sent':
      return `Sent: ${progress} queued`;
    case 'cancelled':
      return a.sendStartedAt ? `Cancelled after ${progress}` : 'Cancelled';
  }
}

const draftOf = (a: OpsAnnouncement): OpsAnnouncementDraft => ({
  subject: a.subject,
  preheader: a.preheader,
  text: a.text,
  buttonLabel: a.buttonLabel,
  buttonUrl: a.buttonUrl,
  audience: a.audience,
});

const same = (a: OpsAnnouncementDraft, b: OpsAnnouncementDraft) =>
  JSON.stringify(a) === JSON.stringify(b);

/** The email's own dark rules, applied whatever this screen's theme is. */
const darkened = (html: string) =>
  html.replace('@media (prefers-color-scheme: dark)', '@media all');

function Preview({ preview }: { preview: OpsAnnouncementPreview }) {
  return (
    <div className="ops-announcement-previews">
      {(['Light', 'Dark'] as const).map((theme) => (
        <figure key={theme}>
          <figcaption>{theme}</figcaption>
          {/* sandbox="": no scripts, no same-origin access, links can't navigate this page. */}
          <iframe
            className="ops-email-preview"
            title={`Email preview, ${theme.toLowerCase()}: ${preview.subject}`}
            sandbox=""
            srcDoc={theme === 'Dark' ? darkened(preview.html) : preview.html}
          />
        </figure>
      ))}
    </div>
  );
}

export default function AnnouncementsPage() {
  const id = useId();
  const [list, setList] = useState<OpsAnnouncement[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<OpsAnnouncement | null>(null);
  const [draft, setDraft] = useState<OpsAnnouncementDraft>(EMPTY);
  const [preview, setPreview] = useState<OpsAnnouncementPreview | null>(null);
  const [error, setError] = useState('');
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcomeState | null>(null);

  const apply = useCallback((result: SessionResult<OpsAnnouncementList>) => {
    if (!result.ok) return setFailed(true);
    setList(result.data.rows);
    setOpen((current) =>
      current
        ? (result.data.rows.find((row) => row.id === current.id) ?? current)
        : current,
    );
  }, []);
  const load = useCallback(() => fetchList().then(apply), [apply]);

  useEffect(() => {
    void fetchList().then(apply);
  }, [apply]);

  // While one sends, its count moves: read it again every 5 seconds.
  const sending = list?.some((row) => row.state === 'sending') ?? false;
  useEffect(() => {
    if (!sending) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [sending, load]);

  const choose = (a: OpsAnnouncement | null) => {
    setOpen(a);
    setDraft(a ? draftOf(a) : EMPTY);
    setPreview(null);
    setError('');
    setSaid('');
    setOutcome(null);
  };

  const editable = !open || open.state === 'draft';
  const unsaved = !open || !same(draftOf(open), draft);
  const problems = [
    ...announcementTextProblems(
      [
        draft.subject,
        draft.preheader,
        draft.text,
        draft.buttonLabel ?? '',
      ].join('\n'),
    ),
  ];

  const set = <K extends keyof OpsAnnouncementDraft>(
    key: K,
    value: OpsAnnouncementDraft[K],
  ) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setSaid('');
  };

  const fail = (answer: { status: number; code: string; message?: string }) =>
    setError(
      answer.code === 'VALIDATION_FAILED'
        ? 'Check the words: a subject and some text, a button needs both a label and a link (a TipMe path like /pro, or an https link), and never the payment partner’s name.'
        : refusalWords(answer),
    );

  const save = async (): Promise<OpsAnnouncement | null> => {
    setError('');
    const answer = await opsAct<OpsAnnouncement>(
      open ? `/v1/ops/announcements/${open.id}` : '/v1/ops/announcements',
      {
        method: open ? 'PUT' : 'POST',
        body: open ? { ...draft, revision: open.revision } : draft,
      },
    );
    if (answer.kind !== 'done') {
      if (answer.kind === 'refused') fail(answer);
      return null;
    }
    setOpen(answer.data);
    setDraft(draftOf(answer.data));
    void load();
    return answer.data;
  };

  const onSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    const saved = await save();
    setBusy(false);
    if (saved) setSaid('Draft saved.');
  };

  const showPreview = async () => {
    setBusy(true);
    setError('');
    const result = await opsFetch<OpsAnnouncementPreview>(
      '/v1/ops/announcements/preview',
      { method: 'POST', body: draft },
    );
    setBusy(false);
    if (result.ok) setPreview(result.data);
    else fail(result);
  };

  const sendTest = async () => {
    setBusy(true);
    setSaid('');
    const saved = unsaved || !open ? await save() : open;
    if (!saved) return setBusy(false);
    const answer = await opsAct<OpsAnnouncementTestSent>(
      `/v1/ops/announcements/${saved.id}/test`,
      { method: 'POST' },
    );
    setBusy(false);
    if (answer.kind === 'refused')
      return setError(
        answer.code === 'INVALID_INPUT'
          ? 'Your staff account has no email address to send a test to.'
          : refusalWords(answer),
      );
    if (answer.kind === 'done')
      setSaid(`Test sent to ${answer.data.toHint}. It can take a minute.`);
  };

  const ask = async (reason: string): Promise<string | null> => {
    if (!open) return 'Save the draft first.';
    if (unsaved) return 'Save your changes first, so the approver sees them.';
    const answer = await opsAct<OpsAnnouncement>(
      `/v1/ops/announcements/${open.id}/send`,
      { method: 'POST', body: { reason, revision: open.revision } },
    );
    if (answer.kind === 'refused')
      return answer.code === 'ANNOUNCEMENT_NO_RECIPIENTS'
        ? 'Nobody in this audience can get announcements right now, so there is nothing to send.'
        : refusalWords(answer);
    setOutcome(
      outcomeOf(
        answer,
        'Sending has started. It goes out at a steady rate.',
        'Nothing is sent until then.',
      ),
    );
    await load();
    return null;
  };

  const cancel = async (reason: string): Promise<string | null> => {
    if (!open) return null;
    const answer = await opsAct<OpsAnnouncement>(
      `/v1/ops/announcements/${open.id}/cancel`,
      { method: 'POST', body: { reason } },
    );
    if (answer.kind === 'refused') return refusalWords(answer);
    if (answer.kind === 'done') setOpen(answer.data);
    await load();
    return null;
  };

  if (failed)
    return (
      <section className="dashboard-section">
        <h1>Announcements</h1>
        <Notice tone="error" title="Couldn’t load announcements">
          Your role may not include them, or the connection failed.
        </Notice>
      </section>
    );
  if (!list)
    return (
      <section className="dashboard-section">
        <h1>Announcements</h1>
        <Skeleton label="Loading announcements" />
      </section>
    );

  const textHint = `Plain paragraphs, with a blank line between them. **Two stars** around words make them bold; a line starting “- ” is a bullet. Up to ${ANNOUNCEMENT_LIMITS.text.toLocaleString('en-NG')} characters.`;

  return (
    <section className="dashboard-section">
      <h1>Announcements</h1>
      <p className="tm-hint">
        One email to many people, such as a change to fees. Sending needs a
        second person. It reaches only people whose email settings allow news
        and announcements, and each email has the unsubscribe link.
      </p>

      <Card className="settings-section">
        <h2 id={`${id}-list`}>Announcements</h2>
        {list.length === 0 ? (
          <EmptyState title="None yet">
            Announcements appear here once you save one.
          </EmptyState>
        ) : (
          <ol aria-labelledby={`${id}-list`} className="ops-list">
            {list.map((row) => (
              <li key={row.id}>
                <strong>{row.subject}</strong> ·{' '}
                <span data-testid="announcement-state">{stateWords(row)}</span>{' '}
                · {when(row.createdAt)}{' '}
                <Button
                  variant="quiet"
                  onClick={() => choose(row)}
                  aria-label={`Open ${row.subject}`}
                >
                  Open
                </Button>
              </li>
            ))}
          </ol>
        )}
        <Button variant="secondary" onClick={() => choose(null)}>
          New announcement
        </Button>
      </Card>

      <Card className="settings-section">
        <h2 id={`${id}-editor`}>{open ? open.subject : 'New announcement'}</h2>
        {open && (
          <p data-testid="announcement-progress">
            <strong>{stateWords(open)}</strong>
            {open.sendStartedAt && ` · started ${when(open.sendStartedAt)}`}
          </p>
        )}
        {open && open.state === 'sending' && open.recipientCount ? (
          <progress
            className="ops-announcement-progress"
            max={open.recipientCount}
            value={open.queuedCount}
            aria-label="Emails queued so far"
          />
        ) : null}

        <form
          className="ops-reason"
          onSubmit={(e) => void onSave(e)}
          noValidate
        >
          <fieldset disabled={!editable} className="ops-announcement-fields">
            <InputField
              id={`${id}-subject`}
              label="Subject"
              value={draft.subject}
              maxLength={ANNOUNCEMENT_LIMITS.subject}
              onChange={(e) => set('subject', e.target.value)}
            />
            <InputField
              id={`${id}-preheader`}
              label="Preview line"
              hint="Shown after the subject in most inboxes. No one’s private details."
              value={draft.preheader}
              maxLength={ANNOUNCEMENT_LIMITS.preheader}
              onChange={(e) => set('preheader', e.target.value)}
            />
            <TextareaField
              id={`${id}-text`}
              label="Text"
              hint={textHint}
              rows={12}
              value={draft.text}
              maxLength={ANNOUNCEMENT_LIMITS.text}
              onChange={(e) => set('text', e.target.value)}
            />
            <InputField
              id={`${id}-button-label`}
              label="Button label (optional)"
              value={draft.buttonLabel ?? ''}
              maxLength={ANNOUNCEMENT_LIMITS.buttonLabel}
              onChange={(e) => set('buttonLabel', e.target.value || null)}
            />
            <InputField
              id={`${id}-button-url`}
              label="Button link (optional)"
              hint="A TipMe path such as /pro, or an https link."
              value={draft.buttonUrl ?? ''}
              maxLength={ANNOUNCEMENT_LIMITS.buttonUrl}
              onChange={(e) => set('buttonUrl', e.target.value || null)}
            />
            <div className="tm-field">
              <label htmlFor={`${id}-audience`}>Who gets it</label>
              <select
                id={`${id}-audience`}
                className="tm-input"
                value={draft.audience}
                onChange={(e) =>
                  set('audience', e.target.value as AnnouncementAudience)
                }
              >
                {ANNOUNCEMENT_AUDIENCES.map((audience) => (
                  <option key={audience} value={audience}>
                    {ANNOUNCEMENT_AUDIENCE_WORDS[audience]}
                  </option>
                ))}
              </select>
            </div>
          </fieldset>
          {problems.length > 0 && (
            <Notice tone="error" title="This can’t go to users as it is">
              {problems.includes('provider_name') &&
                'Say “our payment partner”, never its name. '}
              {problems.includes('regulatory_claim') &&
                'Don’t say or imply that a regulator approved TipMe.'}
            </Notice>
          )}
          {error && (
            <Notice tone="error" title="Not done">
              {error}
            </Notice>
          )}
          {said && (
            <Notice tone="success" title="Done">
              {said}
            </Notice>
          )}
          <div className="ops-actions">
            {editable && (
              <Button
                type="submit"
                disabled={busy || !unsaved}
                aria-busy={busy}
              >
                Save draft
              </Button>
            )}
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void showPreview()}
            >
              Preview
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void sendTest()}
            >
              Send a test to me
            </Button>
          </div>
        </form>
        {preview && <Preview preview={preview} />}
      </Card>

      {open && (open.state === 'draft' || open.state === 'waiting') && (
        <Card className="settings-section">
          <h2>Send</h2>
          {outcome && <ActionOutcome outcome={outcome} />}
          <p data-testid="announcement-audience">
            {ANNOUNCEMENT_AUDIENCE_WORDS[open.audience]}:{' '}
            <strong>{count(open.audienceCount ?? 0)}</strong> now. It is counted
            again when sending starts.
          </p>
          {open.audienceCount === 0 && (
            <Notice tone="neutral" title="Nobody to send to yet">
              Nobody in this audience has turned on news and announcements in
              their email settings.
            </Notice>
          )}
          {open.state === 'waiting' && !outcome ? (
            <Notice tone="neutral" title="Waiting for a second person">
              Sending is waiting in Approvals. Nothing has been sent.
            </Notice>
          ) : open.state === 'draft' && !outcome ? (
            <ReasonAction
              open="Ask to send…"
              field="Why send this now?"
              submit="Ask for approval"
              variant="primary"
              onSubmit={ask}
            />
          ) : null}
        </Card>
      )}

      {open &&
        (open.state === 'sending' ||
          open.state === 'draft' ||
          open.state === 'waiting') && (
          <Card className="settings-section">
            <h2>
              {open.state === 'sending' ? 'Stop sending' : 'Drop this draft'}
            </h2>
            <p className="tm-hint">
              {open.state === 'sending'
                ? 'No more emails are queued after this. Emails already queued still go.'
                : 'It stays in the list as cancelled. A waiting approval can no longer run.'}
            </p>
            <ReasonAction
              open={open.state === 'sending' ? 'Stop sending…' : 'Cancel…'}
              field="Why stop it?"
              submit={open.state === 'sending' ? 'Stop sending' : 'Cancel it'}
              onSubmit={cancel}
            />
          </Card>
        )}
    </section>
  );
}
