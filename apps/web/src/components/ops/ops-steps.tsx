'use client';
import QRCode from 'qrcode';
import { useId, useState, type FormEvent } from 'react';
import type { OpsEnrolment } from '@tipme/contracts';
import { Button, Card, InputField, Notice } from '@tipme/ui';
import { apiFetch } from '@/lib/session-client';

const problems: Record<string, string> = {
  ENROLMENT_INVALID:
    'That enrolment code is not right or has expired. Run pnpm ops:grant-owner again for a new one.',
  CODE_INVALID:
    'That code didn’t work. Wait for the next code in your app and try again.',
  OPS_LOCKED: 'Too many wrong codes. Admin access is locked for 15 minutes.',
  RATE_LIMITED: 'Too many attempts. Please wait a minute and try again.',
};
const problem = (code: string) =>
  problems[code] ?? 'Something went wrong. Please try again.';

function CodeField({ id }: { id: string }) {
  return (
    <InputField
      id={id}
      name="code"
      label="Authenticator code"
      hint="The 6-digit code your authenticator app shows now."
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={6}
      required
    />
  );
}

/** First visit: the enrolment code from `pnpm ops:grant-owner`, then the app's first code. */
export function OpsEnrol({ onDone }: { onDone: () => void }) {
  const id = useId();
  const [enrolment, setEnrolment] = useState<
    (OpsEnrolment & { qr: string }) | null
  >(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const start = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const enrolmentCode = String(
      new FormData(event.currentTarget).get('enrolmentCode') ?? '',
    )
      .trim()
      .toUpperCase();
    setBusy(true);
    setError('');
    const result = await apiFetch<OpsEnrolment>('/v1/ops/enrol', {
      method: 'POST',
      body: { enrolmentCode },
    });
    if (!result.ok) {
      setBusy(false);
      setError(
        result.code === 'VALIDATION_FAILED'
          ? 'The enrolment code is 10 letters and digits.'
          : problem(result.code),
      );
      return;
    }
    const qr = await QRCode.toDataURL(result.data.otpauthUrl, {
      margin: 2,
      width: 220,
      color: { dark: '#000000', light: '#ffffff' },
    });
    setBusy(false);
    setEnrolment({ ...result.data, qr });
  };

  const confirm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code') ?? '');
    setBusy(true);
    setError('');
    const result = await apiFetch('/v1/ops/enrol/confirm', {
      method: 'POST',
      body: { code },
    });
    setBusy(false);
    if (result.ok) onDone();
    else setError(problem(result.code));
  };

  return (
    <Card className="ops-step">
      <h1>Set up your authenticator</h1>
      <p className="tm-hint">
        The admin area needs a second step: a code from an authenticator app
        (for example Google Authenticator, 1Password or Authy).
      </p>
      {error && (
        <Notice tone="error" title="Not done">
          {error}
        </Notice>
      )}
      {!enrolment ? (
        <form className="settings-form" onSubmit={(e) => void start(e)}>
          <InputField
            id={`${id}-enrolment`}
            name="enrolmentCode"
            label="Enrolment code"
            hint="The 10-character code printed by pnpm ops:grant-owner."
            autoComplete="off"
            autoCapitalize="characters"
            maxLength={10}
            required
          />
          <Button type="submit" disabled={busy} aria-busy={busy}>
            Continue
          </Button>
        </form>
      ) : (
        <form className="settings-form" onSubmit={(e) => void confirm(e)}>
          <p>Scan this with your authenticator app:</p>
          {/* eslint-disable-next-line @next/next/no-img-element -- a generated data URL */}
          <img
            className="ops-qr"
            src={enrolment.qr}
            width={220}
            height={220}
            alt="QR code for your authenticator app"
          />
          <p>
            Or type this key into the app:{' '}
            <code className="ops-secret" data-testid="totp-secret">
              {enrolment.secret.match(/.{1,4}/g)?.join(' ')}
            </code>
          </p>
          <CodeField id={`${id}-code`} />
          <Button type="submit" disabled={busy} aria-busy={busy}>
            Confirm
          </Button>
        </form>
      )}
    </Card>
  );
}

/** Every new admin visit (12 hours at most, 1 hour idle): a fresh code from the app. */
export function OpsCode({ onDone }: { onDone: () => void }) {
  const id = useId();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code') ?? '');
    setBusy(true);
    setError('');
    const result = await apiFetch('/v1/ops/grant', {
      method: 'POST',
      body: { code },
    });
    setBusy(false);
    if (result.ok) onDone();
    else setError(problem(result.code));
  };
  return (
    <Card className="ops-step">
      <h1>Confirm it’s you</h1>
      <p className="tm-hint">
        Enter the current code from your authenticator app to open the admin
        area.
      </p>
      {error && (
        <Notice tone="error" title="Not signed in to admin">
          {error}
        </Notice>
      )}
      <form className="settings-form" onSubmit={(e) => void submit(e)}>
        <CodeField id={`${id}-code`} />
        <Button type="submit" disabled={busy} aria-busy={busy}>
          Continue
        </Button>
      </form>
    </Card>
  );
}
