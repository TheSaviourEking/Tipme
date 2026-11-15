'use client';
import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@tipme/ui';

// Business sign-up, Task D3: "What brings you to TipMe?" Two choices of the same weight, so a
// market trader and a restaurant owner both feel expected.

export type ForkChoice = 'tipped' | 'business';

export function SignUpFork({
  onChoose,
}: {
  onChoose: (choice: ForkChoice) => void;
}) {
  const id = useId();
  const [choice, setChoice] = useState<ForkChoice | null>(null);
  const [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!choice) {
      setError('Choose one to continue. You can add the other later.');
      return;
    }
    onChoose(choice);
  };
  const option = (value: ForkChoice, title: string, text: string) => (
    <label className="sign-up-fork__choice">
      <input
        type="radio"
        name={`${id}-path`}
        value={value}
        checked={choice === value}
        onChange={() => {
          setChoice(value);
          setError('');
        }}
      />
      <span className="sign-up-fork__words">
        <strong>{title}</strong>
        <span>{text}</span>
      </span>
    </label>
  );
  return (
    <form className="auth-form sign-up-fork" onSubmit={submit} noValidate>
      <div
        role="radiogroup"
        aria-labelledby={`${id}-question`}
        aria-describedby={error ? `${id}-error` : undefined}
        className="sign-up-fork__choices"
      >
        <h2 id={`${id}-question`}>What brings you to TipMe?</h2>
        {option(
          'tipped',
          'Get tipped',
          'Your own page and QR code. For anyone who gets thanked.',
        )}
        {option(
          'business',
          'For businesses',
          'A page and codes for your places. Tips reach your staff.',
        )}
      </div>
      {error && (
        <p className="tm-field-error" role="alert" id={`${id}-error`}>
          {error}
        </p>
      )}
      <Button type="submit" variant="continue">
        Continue
      </Button>
      <p className="tm-hint">
        Invited to work somewhere? Open the link in your invitation instead.
      </p>
      <p className="auth-switch">
        Already have a page? <Link href="/sign-in">Sign in</Link>
      </p>
    </form>
  );
}
