'use client';
import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  PendingEmailRecovery,
  RecoveryEmailStatus,
  MyProfile,
  SessionView,
} from '@tipme/contracts';
import { Button, Card, InputField, Notice } from '@tipme/ui';
import { CodeField } from '@/components/account/code-field';
import { useRecipient } from '@/components/account/recipient-context';
import { RECOVERY_EMAIL_CHANGED } from '@/lib/owner-attention';
import { useLiveEvents } from '@/components/live/live-provider';

const ACCOUNT_CHANGED = ['account.changed'] as const;
import { apiFetch } from '@/lib/session-client';
import { SettingsChapter } from './section';

// Sign-in and security (ScreenSettings): the sign-in email, the recovery email and devices.

const STAFF_EMAIL_LOCKED_NOTE =
  'Staff can’t change their sign-in email here. Contact the owner, who can have it changed.';

/** Someone asked (by email) to move this account to a new number: the owner can stop it. */
export function PendingRecovery() {
  const [pending, setPending] = useState<
    { id: string; newPhoneHint: string; effectiveAt: string }[]
  >([]);
  const [round, setRound] = useState(0);
  // Changed on another tab or device (live updates): read again. Not on a resync: settings.
  useLiveEvents(ACCOUNT_CHANGED, async () => setRound((n) => n + 1), {
    resync: false,
  });
  useEffect(() => {
    void apiFetch<{ id: string; newPhoneHint: string; effectiveAt: string }[]>(
      '/v1/me/recovery',
    ).then((result) => {
      if (result.ok) setPending(result.data);
    });
  }, [round]);
  if (pending.length === 0) return null;
  const cancel = async () => {
    await apiFetch('/v1/me/recovery/cancel', { method: 'POST', body: {} });
    setRound((n) => n + 1);
  };
  return (
    <Notice tone="error" title="Your number is about to change">
      Someone asked to move this account to a number ending{' '}
      {pending[0]?.newPhoneHint} on{' '}
      {new Date(pending[0]?.effectiveAt ?? '').toLocaleString('en-NG', {
        timeZone: 'Africa/Lagos',
      })}
      . If this wasn’t you, cancel it now.{' '}
      <Button variant="secondary" onClick={() => void cancel()}>
        Cancel the change
      </Button>
    </Notice>
  );
}

/** A recovery of this account is waiting out its 24 hours: the owner can stop it. */
export function EmailMoveNotice() {
  const [pending, setPending] = useState<PendingEmailRecovery[]>([]);
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);
  // Changed on another tab or device (live updates): read again. Not on a resync: settings.
  useLiveEvents(ACCOUNT_CHANGED, async () => setRound((n) => n + 1), {
    resync: false,
  });
  useEffect(() => {
    void apiFetch<PendingEmailRecovery[]>('/v1/me/email-recoveries').then(
      (result) => {
        if (result.ok) setPending(result.data);
      },
    );
  }, [round]);
  const first = pending[0];
  if (!first) return null;
  const cancel = async () => {
    const result = await apiFetch('/v1/me/recovery/cancel', {
      method: 'POST',
      body: {},
    });
    if (result.ok) setRound((n) => n + 1);
    else setFailed(true);
  };
  return (
    <Notice tone="error" title="Your account is being moved">
      Your account is being moved to {first.newEmailHint} on{' '}
      {new Date(first.effectiveAt).toLocaleString('en-NG', {
        timeZone: 'Africa/Lagos',
      })}
      . If this wasn’t you, cancel it now.{' '}
      <Button variant="secondary" onClick={() => void cancel()}>
        Cancel the move
      </Button>
      {failed && <p role="alert">That didn’t go through. Try again now.</p>}
    </Notice>
  );
}

/** Taking the way back in away needs the sign-in email too, not just a session. */
function RemoveRecoveryEmail({ onRemoved }: { onRemoved: () => void }) {
  const id = useId();
  const [asked, setAsked] = useState(false);
  const [signInCode, setSignInCode] = useState('');
  const [note, setNote] = useState('');
  const ask = async () => {
    const result = await apiFetch('/v1/me/recovery-email/change-code', {
      method: 'POST',
      body: {},
    });
    if (result.ok) setAsked(true);
    else setNote(codeRequestProblem(result.code));
  };
  const remove = async () => {
    const result = await apiFetch('/v1/me/recovery-email/remove', {
      method: 'POST',
      body: { signInCode },
    });
    if (result.ok) onRemoved();
    else setNote('That code isn’t right or has expired.');
  };
  return (
    <div className="settings-form">
      {asked && (
        <CodeField
          id={`${id}-code`}
          label="Code sent to your sign-in email"
          value={signInCode}
          onChange={setSignInCode}
        />
      )}
      <Button variant="quiet" onClick={() => void (asked ? remove() : ask())}>
        {asked ? 'Confirm removal' : 'Remove recovery email'}
      </Button>
      <p role="status" className="tm-hint">
        {note}
      </p>
    </div>
  );
}

const codeRequestProblem = (code: string | undefined) =>
  code === 'SAME_AS_SIGN_IN_EMAIL'
    ? 'Use a different address from your sign-in email.'
    : code === 'TOO_MANY_CODES'
      ? 'Too many codes for that address. Try again in an hour.'
      : code === 'EMAIL_INVALID'
        ? 'Check the address and try again.'
        : 'We couldn’t send a code. Try again in a while.';

/** The way back in if the sign-in email is lost. */
export function RecoveryEmailCard() {
  const id = useId();
  const [status, setStatus] = useState<RecoveryEmailStatus | null>(null);
  const [round, setRound] = useState(0);
  // Changed on another tab or device (live updates): read again. Not on a resync: settings.
  useLiveEvents(ACCOUNT_CHANGED, async () => setRound((n) => n + 1), {
    resync: false,
  });
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [signInCode, setSignInCode] = useState('');
  const [step, setStep] = useState<'idle' | 'code'>('idle');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void apiFetch<RecoveryEmailStatus>('/v1/me/recovery-email').then(
      (result) => {
        if (result.ok) setStatus(result.data);
      },
    );
  }, [round]);
  const replacing = Boolean(status?.confirmed);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !status) return;
    setBusy(true);
    setNote('');
    try {
      if (step === 'idle') {
        const result = await apiFetch('/v1/me/recovery-email/code', {
          method: 'POST',
          body: { email: address.trim() },
        });
        if (!result.ok) {
          setNote(codeRequestProblem(result.code));
          return;
        }
        if (replacing) {
          const owner = await apiFetch('/v1/me/recovery-email/change-code', {
            method: 'POST',
            body: {},
          });
          if (!owner.ok) {
            setNote(codeRequestProblem(owner.code));
            return;
          }
        }
        setStep('code');
        setNote(
          replacing
            ? 'We sent a code to each address.'
            : `We sent a code to ${address.trim()}.`,
        );
        return;
      }
      const result = await apiFetch('/v1/me/recovery-email', {
        method: 'POST',
        body: {
          email: address.trim(),
          code,
          ...(replacing ? { signInCode } : {}),
        },
      });
      if (result.ok) {
        setStep('idle');
        setAddress('');
        setCode('');
        setSignInCode('');
        setNote('Your recovery email is confirmed.');
        setRound((n) => n + 1);
        window.dispatchEvent(new Event(RECOVERY_EMAIL_CHANGED));
      } else if (result.code === 'EMAIL_TAKEN') {
        setStep('idle');
        setCode('');
        setSignInCode('');
        setNote(
          'That address is used by another account. Try a different one.',
        );
      } else if (result.code === 'SAME_AS_SIGN_IN_EMAIL') {
        setStep('idle');
        setNote('Use a different address from your sign-in email.');
      } else {
        setNote(
          replacing
            ? 'One of those codes isn’t right or has expired. After 5 wrong tries, wait 15 minutes.'
            : 'That code isn’t right or has expired. After 5 wrong tries, wait 15 minutes.',
        );
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card id="recovery" className="settings-section">
      <h3>Recovery email</h3>
      <p>
        {status?.confirmed
          ? `Recovery email: ${status.hint}`
          : 'Add a second address, so you can get back in if you lose access to your email.'}
      </p>
      <form
        className="settings-form"
        onSubmit={(e) => void submit(e)}
        noValidate
      >
        <InputField
          id={`${id}-address`}
          label="Recovery email address"
          type="email"
          autoComplete="off"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          disabled={step === 'code'}
        />
        {step === 'code' && (
          <CodeField
            id={`${id}-code`}
            label="Code sent to your recovery email"
            value={code}
            onChange={setCode}
          />
        )}
        {step === 'code' && replacing && (
          <CodeField
            id={`${id}-sign-in-code`}
            label="Code sent to your sign-in email"
            value={signInCode}
            onChange={setSignInCode}
          />
        )}
        <Button type="submit" variant="secondary" disabled={busy || !status}>
          {step === 'idle'
            ? 'Send code to recovery email'
            : 'Confirm recovery email'}
        </Button>
        {step === 'code' && (
          <Button
            variant="quiet"
            onClick={() => {
              setStep('idle');
              setCode('');
              setNote('');
            }}
          >
            Use a different address
          </Button>
        )}
        <p role="status" className="tm-hint">
          {note}
        </p>
      </form>
      {status?.confirmed && step === 'idle' && (
        <RemoveRecoveryEmail
          onRemoved={() => {
            setNote('Your recovery email was removed.');
            setRound((n) => n + 1);
            window.dispatchEvent(new Event(RECOVERY_EMAIL_CHANGED));
          }}
        />
      )}
    </Card>
  );
}

export function ContactDetails() {
  const id = useId();
  const { profile, setProfile } = useRecipient();
  const [email, setEmail] = useState('');
  const [emailNote, setEmailNote] = useState('');
  const [code, setCode] = useState('');
  const [emailStep, setEmailStep] = useState<'idle' | 'code'>('idle');

  const changeEmail = async (event: FormEvent) => {
    event.preventDefault();
    if (emailStep === 'idle') {
      const result = await apiFetch('/v1/me/email/code', {
        method: 'POST',
        body: { email: email.trim() },
      });
      if (result.ok) {
        setEmailStep('code');
        setEmailNote(`We sent a code to ${email.trim()}.`);
      } else
        setEmailNote(
          result.code === 'STAFF_EMAIL_LOCKED'
            ? STAFF_EMAIL_LOCKED_NOTE
            : 'Check the email address and try again.',
        );
      return;
    }
    const result = await apiFetch<{ email: string }>('/v1/me/email/confirm', {
      method: 'POST',
      body: { email: email.trim(), code },
    });
    if (result.ok) {
      setProfile({
        ...profile,
        email: result.data.email,
        emailVerified: true,
      });
      setEmailStep('idle');
      setEmail('');
      setCode('');
      setEmailNote(
        'Your email was changed. We told the old address, and other devices were signed out.',
      );
    } else {
      if (result.code === 'EMAIL_TAKEN') {
        setEmailStep('idle');
        setCode('');
      }
      setEmailNote(
        result.code === 'EMAIL_TAKEN'
          ? 'That email belongs to another account. Try a different one.'
          : result.code === 'STAFF_EMAIL_LOCKED'
            ? STAFF_EMAIL_LOCKED_NOTE
            : result.code === 'SIGN_IN_LOCKED'
              ? 'Too many wrong codes. Please wait 15 minutes and try again.'
              : 'That code isn’t right or has expired.',
      );
    }
  };
  const toggleEmailPublic = async (emailPublic: boolean) => {
    const result = await apiFetch<MyProfile>('/v1/me/profile', {
      method: 'PATCH',
      body: { emailPublic },
    });
    if (result.ok) setProfile(result.data);
  };

  return (
    <Card id="contact" className="settings-section">
      <h3>Your email</h3>
      <p>
        You sign in with:{' '}
        <strong>
          {profile.email
            ? `${profile.email}${profile.emailVerified ? '' : ' (not confirmed)'}`
            : 'no email yet'}
        </strong>
      </p>
      <form
        className="settings-form"
        onSubmit={(e) => void changeEmail(e)}
        noValidate
      >
        <InputField
          id={`${id}-email`}
          label="New email address"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={emailStep === 'code'}
        />
        {emailStep === 'code' && (
          <CodeField
            id={`${id}-email-code`}
            label="Code sent to the new address"
            value={code}
            onChange={setCode}
          />
        )}
        <Button type="submit" variant="secondary">
          {emailStep === 'idle' ? 'Send code to new address' : 'Change email'}
        </Button>
        {emailStep === 'code' && (
          <Button
            variant="quiet"
            onClick={() => {
              setEmailStep('idle');
              setCode('');
              setEmailNote('');
            }}
          >
            Use a different address
          </Button>
        )}
        <p role="status" className="tm-hint">
          {emailNote}
        </p>
      </form>
      <p className="tm-hint">
        Phone numbers are coming soon.{' '}
        {profile.phone ? `Yours on file: ${profile.phone}.` : ''}
      </p>
      {profile.emailVerified && (
        <label className="tip-remember" htmlFor={`${id}-email-public`}>
          <input
            id={`${id}-email-public`}
            type="checkbox"
            checked={profile.emailPublic}
            onChange={(e) => void toggleEmailPublic(e.target.checked)}
          />
          <span>Show my email on my page</span>
        </label>
      )}
    </Card>
  );
}

export function Devices() {
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [round, setRound] = useState(0);
  // Changed on another tab or device (live updates): read again. Not on a resync: settings.
  useLiveEvents(ACCOUNT_CHANGED, async () => setRound((n) => n + 1), {
    resync: false,
  });
  useEffect(() => {
    void apiFetch<SessionView[]>('/v1/me/sessions').then((result) => {
      if (result.ok) setSessions(result.data);
    });
  }, [round]);
  const revoke = async (id: string) => {
    await apiFetch(`/v1/me/sessions/${id}`, { method: 'DELETE' });
    setRound((n) => n + 1);
  };
  const others = async () => {
    await apiFetch('/v1/me/sessions/sign-out-others', {
      method: 'POST',
      body: {},
    });
    setRound((n) => n + 1);
  };
  return (
    <Card className="settings-section">
      <h3>Devices</h3>
      <ul className="device-list">
        {(sessions ?? []).map((session) => (
          <li key={session.id}>
            <span>
              {session.deviceLabel}
              {session.current && <strong> · This device</strong>}
              <small>
                Last used {new Date(session.lastSeenAt).toLocaleString('en-NG')}
              </small>
            </span>
            {!session.current && (
              <Button variant="quiet" onClick={() => void revoke(session.id)}>
                Sign out<span className="sr-only"> {session.deviceLabel}</span>
              </Button>
            )}
          </li>
        ))}
      </ul>
      {(sessions?.length ?? 0) > 1 && (
        <Button variant="secondary" onClick={() => void others()}>
          Sign out of all other devices
        </Button>
      )}
    </Card>
  );
}

/** Sign-in and security (ScreenSettings): a pending move first, then email, recovery and devices. */
export function SecuritySection() {
  return (
    <SettingsChapter id="security">
      <EmailMoveNotice />
      <ContactDetails />
      <RecoveryEmailCard />
      <Devices />
    </SettingsChapter>
  );
}
