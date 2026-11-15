'use client';
import { useId, useState, type FormEvent } from 'react';
import {
  SUPPORT_BODY_LIMIT,
  SUPPORT_TOPICS,
  SUPPORT_TOPIC_WORDS,
  type MySupportRequest,
  type SupportTopic,
} from '@tipme/contracts';
import { Button, Card, Skeleton, TextareaField } from '@tipme/ui';
import { usePanel } from '@/components/dashboard/use-panel';
import { PILOT_NOTICE_SUPPORT_EMAIL } from '@/lib/pilot';
import { apiFetch } from '@/lib/session-client';
import { madeOn } from '../campaigns/campaigns-view';

/**
 * Get help: the smallest support path (owner default ruling 7). A request goes to TipMe's staff
 * queue; a Pro member's is answered first. No response time is promised.
 */
export default function HelpPage() {
  const id = useId();
  const mine = usePanel<{
    requests: MySupportRequest[];
    proLine: string | null;
  }>('/v1/me/support');
  const [topic, setTopic] = useState<SupportTopic>('withdrawal');
  const [body, setBody] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const length = [...body.trim()].length;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setStatus('');
    if (length === 0) {
      setError('Tell us what happened.');
      return;
    }
    if (length > SUPPORT_BODY_LIMIT) {
      setError(`Please keep it under ${SUPPORT_BODY_LIMIT} characters.`);
      return;
    }
    setBusy(true);
    const result = await apiFetch('/v1/me/support', {
      method: 'POST',
      body: { topic, body },
    });
    setBusy(false);
    if (result.ok) {
      setBody('');
      setStatus('Sent. TipMe support will reply by email.');
      await mine.reload();
    } else
      setError(
        result.code === 'SUPPORT_TOO_MANY_OPEN'
          ? 'You have 3 requests waiting. We’ll answer those first.'
          : 'We couldn’t send it. Please try again.',
      );
  };

  return (
    <div className="dashboard-section help">
      <h1>Get help</h1>
      {mine.data?.proLine && <p className="help-pro">{mine.data.proLine}</p>}
      <Card>
        <form
          aria-label="Send to TipMe support"
          onSubmit={submit}
          noValidate
          className="help-form"
        >
          <div className="tm-field">
            <label htmlFor={`${id}-topic`}>What do you need help with?</label>
            <select
              id={`${id}-topic`}
              className="tm-input"
              value={topic}
              onChange={(e) => setTopic(e.target.value as SupportTopic)}
            >
              {SUPPORT_TOPICS.map((value) => (
                <option key={value} value={value}>
                  {SUPPORT_TOPIC_WORDS[value]}
                </option>
              ))}
            </select>
          </div>
          <TextareaField
            id={`${id}-body`}
            label="Tell us what happened"
            hint={`${length} of ${SUPPORT_BODY_LIMIT} characters. Please don’t include card numbers or codes.`}
            rows={6}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            {...(error ? { error } : {})}
          />
          <Button variant="continue" type="submit" disabled={busy}>
            {busy ? 'Sending…' : 'Send to TipMe support'}
          </Button>
          <p role="status" className="tm-hint">
            {status}
          </p>
        </form>
      </Card>
      <section aria-labelledby={`${id}-mine`} className="help-mine">
        <h2 id={`${id}-mine`}>Your requests</h2>
        {!mine.data ? (
          <Skeleton label="Loading your requests" />
        ) : mine.data.requests.length === 0 ? (
          <p className="tm-hint">None yet.</p>
        ) : (
          <ul>
            {mine.data.requests.map((request) => (
              <li key={request.id}>
                <b>{SUPPORT_TOPIC_WORDS[request.topic]}</b> ·{' '}
                {madeOn(request.createdAt)} ·{' '}
                {request.status === 'waiting' ? 'Waiting' : 'Closed'}
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="tm-hint">
        You can also email{' '}
        <a href={`mailto:${PILOT_NOTICE_SUPPORT_EMAIL}`}>
          {PILOT_NOTICE_SUPPORT_EMAIL}
        </a>
        .
      </p>
    </div>
  );
}
