'use client';
import { useEffect, useState } from 'react';
import type { PretendMessage } from '@tipme/contracts';
import { Button } from '@tipme/ui';
import { apiFetch } from '@/lib/session-client';

const channelName = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  email: 'Email',
} as const;

export function InboxView() {
  const [messages, setMessages] = useState<PretendMessage[] | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    void apiFetch<PretendMessage[]>('/v1/dev/inbox').then((result) => {
      if (result.ok) setMessages(result.data);
    });
  }, [round]);
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
