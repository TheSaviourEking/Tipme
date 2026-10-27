'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { ActionLink, Button, InputField } from '@tipme/ui';

const businessContact = 'usetipme@gmail.com';

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
    <div className="business-interest">
      <h2>Interested in TipMe for your business?</h2>
      <p>
        Prepare an email to register your interest. Your email stays in this
        form until you open and send the draft; TipMe does not store it here.
      </p>
      <form className="business-interest__form" onSubmit={prepareEmail}>
        <InputField
          id="business-interest-email"
          label="Your email address"
          type="email"
          autoComplete="email"
          maxLength={254}
          required
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setDraftUrl('');
          }}
        />
        <Button type="submit" variant="secondary">
          Prepare email
        </Button>
      </form>
      {draftUrl && (
        <p role="status">
          Open the draft to {businessContact} and press Send to register your
          interest. <ActionLink href={draftUrl}>Open email app</ActionLink>
        </p>
      )}
    </div>
  );
}
