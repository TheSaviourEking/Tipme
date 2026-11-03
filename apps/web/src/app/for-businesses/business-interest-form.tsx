'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ActionLink, Button, Surface } from '@tipme/ui';

const businessContact = 'usetipme@gmail.com';

/**
 * Interest is a mailto draft to the owner's inbox, not a server submission (DECISION-LOG,
 * 2026-10-27): TipMe stores nothing here, and the visitor sends the email themselves.
 */
export function BusinessInterestForm() {
  const [email, setEmail] = useState('');
  const [draftUrl, setDraftUrl] = useState('');

  const prepareEmail = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = [
      'Please let me know when TipMe business pages are available.',
      '',
      `My email: ${email.trim()}`,
    ].join('\n');
    const query = new URLSearchParams({
      subject: 'TipMe business pages',
      body,
    });
    setDraftUrl(`mailto:${businessContact}?${query.toString()}`);
  };

  return (
    <Surface material="instrument" className="business-card">
      {draftUrl ? (
        <div
          className="business-card__done"
          role="status"
          data-testid="interest-done"
        >
          <p className="business-card__big">Your email is ready to send.</p>
          <p>
            Sending it is what registers your interest: open the draft to{' '}
            {businessContact} and press Send. Once it arrives, we’ll write to
            you when TipMe for businesses is ready.
          </p>
          <ActionLink variant="continue" href={draftUrl}>
            Open email app
          </ActionLink>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setDraftUrl('')}
          >
            Use a different email
          </Button>
        </div>
      ) : (
        <form
          className="business-card__form"
          aria-label="Register interest"
          onSubmit={prepareEmail}
        >
          <label
            className="business-card__label"
            htmlFor="business-interest-email"
          >
            Work email
          </label>
          <input
            id="business-interest-email"
            className="tm-well business-card__input"
            type="email"
            autoComplete="email"
            placeholder="you@yourbusiness.com"
            maxLength={254}
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Button type="submit" variant="continue">
            Tell me when it&apos;s ready
          </Button>
        </form>
      )}
      <p className="business-card__note">
        If you send it, we’ll use your email only to tell you about TipMe for
        businesses. Working for yourself?{' '}
        <Link href="/sign-up">You can start today</Link>.
      </p>
    </Surface>
  );
}
