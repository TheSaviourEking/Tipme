'use client';
import { useEffect, useState, type FormEvent } from 'react';
import type { PretendMessage } from '@tipme/contracts';
import { Button, InputField } from '@tipme/ui';
import { apiFetch } from '@/lib/session-client';

const channelName = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  email: 'Email',
} as const;

// On staging the inbox also needs the inbox key (the release token); it is kept for this tab only.
const KEY_STORAGE = 'tipme_inbox_key';
const readKey = () => {
  try {
    return sessionStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
};
const saveKey = (key: string) => {
  try {
    sessionStorage.setItem(KEY_STORAGE, key);
  } catch {
    // Storage blocked: the key works until the page is reloaded.
  }
};

export function InboxView() {
  const [messages, setMessages] = useState<PretendMessage[] | null>(null);
  const [locked, setLocked] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [round, setRound] = useState(0);
  useEffect(() => {
    const current = key ?? readKey();
    void apiFetch<PretendMessage[]>('/v1/dev/inbox', {
      headers: current ? { authorization: `Bearer ${current}` } : {},
    }).then((result) => {
      setLocked(!result.ok && result.status === 404);
      if (result.ok) setMessages(result.data);
    });
  }, [round, key]);

  const unlock = (event: FormEvent) => {
    event.preventDefault();
    saveKey(draft.trim());
    setKey(draft.trim());
    setDraft('');
  };

  if (locked)
    return (
      <form onSubmit={unlock}>
        <InputField
          id="inbox-key"
          label="Inbox key"
          hint="On staging the inbox shows sign-in codes, so it needs its own key as well as the staging password."
          type="password"
          autoComplete="off"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          error={key ? 'That key did not work.' : undefined}
          required
        />
        <Button type="submit">Open inbox</Button>
      </form>
    );
  return (
    <>
      <Button variant="secondary" onClick={() => setRound((n) => n + 1)}>
        Refresh
      </Button>
      {messages?.length === 0 && <p>Nothing has been sent yet.</p>}
      <div className="inbox-list">
        {(messages ?? []).map((message) => (
          <article key={message.id} className="inbox-message">
            <p className="eyebrow">
              {channelName[message.channel]} to {message.to} ·{' '}
              {new Date(message.sentAt).toLocaleTimeString('en-NG')}
            </p>
            {message.subject && <h2>{message.subject}</h2>}
            <p>{message.body}</p>
          </article>
        ))}
      </div>
    </>
  );
}
