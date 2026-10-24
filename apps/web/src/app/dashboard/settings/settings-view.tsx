'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  MyProfile,
  NotificationPrefs,
  SessionView,
} from '@tipme/contracts';
import { Button, Card, InputField, Notice, TextareaField } from '@tipme/ui';
import { useRecipient } from '@/components/account/recipient-context';
import { Avatar, hasAvatar } from '@/components/avatar';
import { apiFetch } from '@/lib/session-client';
import { shrinkPhoto } from '@/lib/shrink-photo';

function PageState() {
  const { profile, setProfile } = useRecipient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const live = profile.pageState === 'live';
  // A page TipMe paused can be taken offline but not put back live (the dashboard says why).
  const blocked = profile.suspended && !live;
  const toggle = async () => {
    setBusy(true);
    setError('');
    const result = await apiFetch<MyProfile>('/v1/me/page/state', {
      method: 'PUT',
      body: { state: live ? 'not_live' : 'live' },
    });
    setBusy(false);
    if (result.ok) setProfile(result.data);
    else setError('We couldn’t change that. Please try again.');
  };
  return (
    <Card className="settings-section">
      <h2>Your page</h2>
      <p
        role="status"
        className={`page-state page-state--${profile.pageState}`}
      >
        {live ? 'Your page is live' : 'Your page is not live'}
      </p>
      <p className="tm-hint">
        {profile.suspended
          ? 'TipMe has paused your page, so visitors can’t see it and it can’t go live for now.'
          : live
            ? 'Anyone with your link or QR code can open it and tip you.'
            : 'Visitors see “This page isn’t available right now”, and nobody can tip you.'}
      </p>
      <p>
        <Link href={`/@${profile.handle}`}>tipme.app/@{profile.handle}</Link>
      </p>
      {error && (
        <Notice tone="error" title="Not changed">
          {error}
        </Notice>
      )}
      <Button
        variant={live ? 'secondary' : 'primary'}
        onClick={() => void toggle()}
        disabled={busy || blocked}
        aria-busy={busy}
      >
        {live ? 'Take my page offline' : 'Make my page live'}
      </Button>
    </Card>
  );
}

const PREF_LABELS = {
  tipEmails: 'Email me about each tip (when my email is verified)',
  weeklyReports: 'Tell me when my weekly report is ready',
  milestones: 'Tell me about milestones and rewards',
} as const;

/** Notification preferences (PR-013). Sign-in codes and security warnings always go. */
function NotificationSettings() {
  const id = useId();
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void apiFetch<NotificationPrefs>('/v1/me/notification-preferences').then(
      (result) => {
        if (result.ok) setPrefs(result.data);
      },
    );
  }, []);
  // An API older than PR-013 has no preferences: say nothing rather than show a broken form.
  if (!prefs) return null;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setSaved(false);
    setError('');
    const result = await apiFetch<NotificationPrefs>(
      '/v1/me/notification-preferences',
      { method: 'PUT', body: prefs },
    );
    setBusy(false);
    if (result.ok) {
      setPrefs(result.data);
      setSaved(true);
    } else setError('We couldn’t save that. Please try again.');
  };
  return (
    <Card className="settings-section">
      <h2>Notifications</h2>
      <p className="tm-hint">
        You always see your tips in TipMe, and sign-in codes and security
        warnings always reach you.
      </p>
      <form className="settings-form" onSubmit={save} noValidate>
        {(Object.keys(PREF_LABELS) as (keyof NotificationPrefs)[]).map(
          (key) => (
            <label key={key} className="tip-remember" htmlFor={`${id}-${key}`}>
              <input
                id={`${id}-${key}`}
                type="checkbox"
                checked={prefs[key]}
                onChange={(e) => {
                  setPrefs({ ...prefs, [key]: e.target.checked });
                  setSaved(false);
                }}
              />
              <span>{PREF_LABELS[key]}</span>
            </label>
          ),
        )}
        {error && (
          <Notice tone="error" title="Not saved">
            {error}
          </Notice>
        )}
        <p role="status" className="tm-hint">
          {saved ? 'Saved.' : ''}
        </p>
        <Button type="submit" disabled={busy} aria-busy={busy}>
          Save notifications
        </Button>
      </form>
    </Card>
  );
}

const photoErrors: Record<string, string> = {
  INVALID_IMAGE: 'Please choose a JPEG, PNG or WebP photo.',
  PAYLOAD_TOO_LARGE: 'That photo is over 5 MB. Please choose a smaller one.',
};

/** The page's photo (PR-013): resized to a square and stripped of location data by TipMe. */
function PhotoSettings() {
  const id = useId();
  const { profile, setProfile } = useRecipient();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const send = async (method: 'PUT' | 'DELETE', file?: File) => {
    setBusy(true);
    setError('');
    setDone('');
    // Shrunk here first: a phone photo uploads in seconds instead of timing out.
    const photoFile = file ? await shrinkPhoto(file) : undefined;
    if (photoFile && photoFile.size > 5 * 1024 * 1024) {
      setBusy(false);
      setError(photoErrors['PAYLOAD_TOO_LARGE']!);
      return;
    }
    const result = await apiFetch<MyProfile>('/v1/me/avatar', {
      method,
      ...(photoFile ? { file: photoFile } : {}),
    });
    setBusy(false);
    if (result.ok) {
      setProfile(result.data);
      setDone(method === 'PUT' ? 'Photo saved.' : 'Photo removed.');
    } else
      setError(
        photoErrors[result.code] ?? 'We couldn’t save that. Please try again.',
      );
  };
  // An API older than PR-013 has no photos: say nothing rather than show a form that fails.
  if (!('avatarPath' in profile)) return null;
  const photo = profile.avatarPath ?? null;
  return (
    <Card className="settings-section">
      <h2>Your photo</h2>
      <p className="tm-hint">
        Optional. TipMe crops it to a square and removes hidden details such as
        where it was taken. JPEG, PNG or WebP, up to 5 MB.
      </p>
      {hasAvatar(photo) ? (
        <Avatar src={photo} name={profile.displayName} size={96} />
      ) : (
        <p className="tm-hint">No photo yet: your page shows your initials.</p>
      )}
      <div className="tm-field">
        <label htmlFor={`${id}-photo`}>
          {photo ? 'Choose a new photo' : 'Choose a photo'}
        </label>
        <input
          id={`${id}-photo`}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          aria-describedby={error ? `${id}-photo-error` : undefined}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void send('PUT', file);
            event.target.value = '';
          }}
        />
      </div>
      {error && (
        <p className="tm-field-error" role="alert" id={`${id}-photo-error`}>
          {error}
        </p>
      )}
      {/* Always present, so screen readers announce what is written into it. */}
      <p role="status" className="tm-hint">
        {done}
      </p>
      {photo && (
        <Button
          variant="quiet"
          disabled={busy}
          onClick={() => void send('DELETE')}
        >
          Remove photo
        </Button>
      )}
    </Card>
  );
}

const renameErrors: Record<string, string> = {
  HANDLE_TAKEN: 'That handle is taken. Please choose another.',
  HANDLE_RENAME_LIMIT:
    'Your page already keeps 5 old handles. You can switch back to one of them.',
  VALIDATION_FAILED:
    'Use 3 to 30 letters, numbers or underscores, with no spaces.',
};

function HandleChange() {
  const id = useId();
  const { profile, setProfile } = useRecipient();
  // An API older than PR-011 does not send it (the web app deploys first).
  const previous = profile.previousHandles ?? [];
  const [handle, setHandle] = useState(profile.handle);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setSaved(false);
    const result = await apiFetch<MyProfile>('/v1/me/handle', {
      method: 'PUT',
      body: { handle: handle.trim().replace(/^@/, '') },
    });
    setBusy(false);
    if (result.ok) {
      setProfile(result.data);
      setHandle(result.data.handle);
      setSaved(true);
      return;
    }
    setError(
      renameErrors[result.code] ?? 'We couldn’t change that. Please try again.',
    );
  };
  return (
    <Card className="settings-section">
      <h2>Your handle</h2>
      <p className="tm-hint">
        Your old links and printed QR codes keep working: they lead to your new
        handle, and nobody else can take them.
      </p>
      <form className="settings-form" onSubmit={save} noValidate>
        <InputField
          id={`${id}-handle`}
          label="Handle"
          maxLength={31}
          autoComplete="off"
          spellCheck={false}
          value={handle}
          onChange={(e) => {
            setHandle(e.target.value);
            setSaved(false);
          }}
          error={error || undefined}
        />
        {previous.length > 0 && (
          <p className="tm-hint">
            Old handles that lead here:{' '}
            {previous.map((old) => `@${old}`).join(', ')}
          </p>
        )}
        {saved && (
          <p role="status" className="tm-hint">
            Saved. Your page is now at tipme.app/@{profile.handle}.
          </p>
        )}
        <Button
          type="submit"
          disabled={busy || handle.trim().toLowerCase() === profile.handle}
          aria-busy={busy}
        >
          Change handle
        </Button>
      </form>
    </Card>
  );
}

const nairaText = (minor: string) =>
  new Intl.NumberFormat('en').format(Number(minor) / 100);

/** Whole naira typed by the recipient, as kobo; null when not a whole amount. */
const wholeNairaMinor = (value: string): string | null => {
  const digits = value.trim().replaceAll(',', '');
  return /^\d{1,6}$/.test(digits) ? String(Number(digits) * 100) : null;
};

/** Free pages show the standard amounts; Pro pages choose their own (PR-012). */
function TipAmountsSettings() {
  const id = useId();
  const { profile, setProfile } = useRecipient();
  // An API older than PR-012 sends neither: treat the page as Free with the standard amounts.
  const amounts = profile.tipAmounts ?? {
    presetsMinor: ['100000', '200000', '500000'],
    minMinor: '100000',
  };
  const pro = profile.plan === 'pro';
  const [presets, setPresets] = useState(() =>
    [0, 1, 2, 3].map((i) =>
      amounts.presetsMinor[i] ? nairaText(amounts.presetsMinor[i]) : '',
    ),
  );
  const [minimum, setMinimum] = useState(nairaText(amounts.minMinor));
  // Which field the problem is in, so the message sits next to it.
  const [error, setError] = useState<{
    field: 'presets' | 'minimum';
    text: string;
  } | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!pro)
    return (
      <Card className="settings-section">
        <h2>Tip amounts</h2>
        <p className="tm-hint">
          Your page offers NGN {amounts.presetsMinor.map(nairaText).join(', ')},
          and supporters can tip any amount from NGN{' '}
          {nairaText(amounts.minMinor)}. Choosing your own amounts and minimum
          is part of TipMe Pro.
        </p>
      </Card>
    );
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaved(false);
    const filled = presets.filter((value) => value.trim() !== '');
    const presetsMinor = filled.map(wholeNairaMinor);
    const minMinor = wholeNairaMinor(minimum);
    if (presetsMinor.length === 0 || presetsMinor.includes(null)) {
      setError({
        field: 'presets',
        text: 'Use whole naira amounts, like 2000 or 2,000.',
      });
      return;
    }
    if (!minMinor) {
      setError({
        field: 'minimum',
        text: 'Use a whole naira amount, like 2000 or 2,000.',
      });
      return;
    }
    setBusy(true);
    const result = await apiFetch<MyProfile>('/v1/me/tip-amounts', {
      method: 'PUT',
      body: { presetsMinor, minMinor },
    });
    setBusy(false);
    if (result.ok) {
      setProfile(result.data);
      setSaved(true);
      return;
    }
    if (result.code === 'PRO_REQUIRED')
      setError({
        field: 'presets',
        text: 'Choosing your own amounts is part of TipMe Pro.',
      });
    else if (result.fields?.includes('minMinor'))
      setError({
        field: 'minimum',
        text: 'The smallest tip must be at least NGN 1,000, in whole naira.',
      });
    else
      setError({
        field: 'presets',
        text: 'Use 1 to 4 different amounts, each at least your smallest tip.',
      });
  };
  return (
    <Card className="settings-section">
      <h2>Tip amounts (Pro)</h2>
      <p className="tm-hint">
        Choose the amounts on your page and the smallest tip you accept.
        Supporters can still type their own amount, from your minimum up.
      </p>
      <form className="settings-form" onSubmit={save} noValidate>
        <fieldset className="tip-amount-fields">
          <legend>Amounts on your page (NGN)</legend>
          {presets.map((value, index) => (
            <InputField
              key={index}
              id={`${id}-preset-${index}`}
              label={`Amount ${index + 1}${index === 0 ? '' : ' (optional)'}`}
              inputMode="numeric"
              autoComplete="off"
              value={value}
              {...(index === 0 && error?.field === 'presets'
                ? { error: error.text }
                : {})}
              onChange={(e) => {
                setPresets((current) =>
                  current.map((v, i) => (i === index ? e.target.value : v)),
                );
                setSaved(false);
              }}
            />
          ))}
        </fieldset>
        <InputField
          id={`${id}-minimum`}
          label="Smallest tip (NGN)"
          inputMode="numeric"
          autoComplete="off"
          hint="At least NGN 1,000."
          value={minimum}
          onChange={(e) => {
            setMinimum(e.target.value);
            setSaved(false);
          }}
          {...(error?.field === 'minimum' ? { error: error.text } : {})}
        />
        {saved && (
          <p role="status" className="tm-hint">
            Saved. Your page now shows these amounts.
          </p>
        )}
        <Button type="submit" disabled={busy} aria-busy={busy}>
          Save tip amounts
        </Button>
      </form>
    </Card>
  );
}

const fieldLabels: Record<string, string> = {
  displayName: 'Display name',
  role: 'What you do',
  bio: 'Bio',
  'socials.facebook': 'Facebook link',
  'socials.instagram': 'Instagram link',
  'socials.x': 'X (Twitter) link',
};

function AboutYou() {
  const id = useId();
  const { profile, setProfile } = useRecipient();
  const [form, setForm] = useState({
    displayName: profile.displayName,
    role: profile.role ?? '',
    bio: profile.bio ?? '',
    facebook: profile.socials.facebook ?? '',
    instagram: profile.socials.instagram ?? '',
    x: profile.socials.x ?? '',
    bioPublic: profile.bioPublic,
    socialsPublic: profile.socialsPublic,
    phonePublic: profile.phonePublic,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (value: string | boolean) => {
    setForm((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    const socials = Object.fromEntries(
      (['facebook', 'instagram', 'x'] as const)
        .map((kind) => [kind, form[kind].trim()])
        .filter(([, url]) => url),
    );
    const result = await apiFetch<MyProfile>('/v1/me/profile', {
      method: 'PATCH',
      body: {
        displayName: form.displayName,
        role: form.role,
        bio: form.bio,
        socials,
        bioPublic: form.bioPublic,
        socialsPublic: form.socialsPublic,
        phonePublic: form.phonePublic,
      },
    });
    setBusy(false);
    if (result.ok) {
      setProfile(result.data);
      setSaved(true);
      return;
    }
    const fields = result.fields ?? [];
    setErrors(
      Object.fromEntries(
        fields.map((field) => [
          field,
          field.startsWith('socials.')
            ? 'Use a full https:// link on that site.'
            : `Check the ${fieldLabels[field]?.toLowerCase() ?? 'value'}.`,
        ]),
      ),
    );
    if (fields.length === 0)
      setErrors({ form: 'We couldn’t save. Please try again.' });
  };

  const check = (
    key: 'bioPublic' | 'socialsPublic' | 'phonePublic',
    label: string,
  ) => (
    <label className="tip-remember" htmlFor={`${id}-${key}`}>
      <input
        id={`${id}-${key}`}
        type="checkbox"
        checked={form[key]}
        onChange={(event) => set(key)(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );

  return (
    <Card className="settings-section">
      <h2>About you</h2>
      <p className="tm-hint">
        Everything here is optional. You decide what supporters see.
      </p>
      <form className="settings-form" onSubmit={save} noValidate>
        <InputField
          id={`${id}-name`}
          label="Display name"
          maxLength={60}
          value={form.displayName}
          onChange={(e) => set('displayName')(e.target.value)}
          error={errors.displayName}
        />
        <InputField
          id={`${id}-role`}
          label="What you do"
          maxLength={60}
          placeholder="Barista at Bean There"
          value={form.role}
          onChange={(e) => set('role')(e.target.value)}
          error={errors.role}
        />
        <TextareaField
          id={`${id}-bio`}
          label="Bio"
          maxLength={280}
          value={form.bio}
          onChange={(e) => set('bio')(e.target.value)}
          hint={`${form.bio.length}/280 characters.`}
          error={errors.bio}
        />
        {check('bioPublic', 'Show my bio on my page')}
        <InputField
          id={`${id}-fb`}
          label="Facebook link"
          type="url"
          inputMode="url"
          placeholder="https://facebook.com/you"
          value={form.facebook}
          onChange={(e) => set('facebook')(e.target.value)}
          error={errors['socials.facebook']}
        />
        <InputField
          id={`${id}-ig`}
          label="Instagram link"
          type="url"
          inputMode="url"
          placeholder="https://instagram.com/you"
          value={form.instagram}
          onChange={(e) => set('instagram')(e.target.value)}
          error={errors['socials.instagram']}
        />
        <InputField
          id={`${id}-x`}
          label="X (Twitter) link"
          type="url"
          inputMode="url"
          placeholder="https://x.com/you"
          value={form.x}
          onChange={(e) => set('x')(e.target.value)}
          error={errors['socials.x']}
        />
        {check('socialsPublic', 'Show my social links on my page')}
        <p className="tm-hint">
          Your phone number: {profile.phone ?? 'not set'}
        </p>
        {check('phonePublic', 'Show my phone number on my page')}
        {errors.form && (
          <Notice tone="error" title="Not saved">
            {errors.form}
          </Notice>
        )}
        <Button type="submit" disabled={busy} aria-busy={busy}>
          Save changes
        </Button>
        <p role="status" className="settings-saved">
          {saved ? 'Saved' : ''}
        </p>
      </form>
    </Card>
  );
}

/** Someone asked (by email) to move this account to a new number: the owner can stop it. */
function PendingRecovery() {
  const [pending, setPending] = useState<
    { id: string; newPhoneHint: string; effectiveAt: string }[]
  >([]);
  const [round, setRound] = useState(0);
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

function ContactDetails() {
  const id = useId();
  const { profile, setProfile } = useRecipient();
  const [email, setEmail] = useState('');
  const [emailNote, setEmailNote] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [phoneStep, setPhoneStep] = useState<'idle' | 'code'>('idle');
  const [phoneNote, setPhoneNote] = useState('');

  const sendLink = async (event: FormEvent) => {
    event.preventDefault();
    const result = await apiFetch('/v1/me/email', {
      method: 'POST',
      body: { email },
    });
    setEmailNote(
      result.ok
        ? `We sent a link to ${email}. Open it to confirm the address.`
        : 'Check the email address and try again.',
    );
  };
  const toggleEmailPublic = async (emailPublic: boolean) => {
    const result = await apiFetch<MyProfile>('/v1/me/profile', {
      method: 'PATCH',
      body: { emailPublic },
    });
    if (result.ok) setProfile(result.data);
  };
  const sendPhoneCode = async (event: FormEvent) => {
    event.preventDefault();
    if (phoneStep === 'idle') {
      const result = await apiFetch('/v1/me/phone/code', {
        method: 'POST',
        body: { phone },
      });
      if (result.ok) {
        setPhoneStep('code');
        setPhoneNote(`We sent a code to ${phone}.`);
      } else setPhoneNote('We couldn’t send a code. Please try again.');
      return;
    }
    const result = await apiFetch<MyProfile>('/v1/me/phone', {
      method: 'PUT',
      body: { phone, code },
    });
    if (result.ok) {
      setProfile(result.data);
      setPhoneStep('idle');
      setPhone('');
      setCode('');
      setPhoneNote('Your number was changed. Other devices were signed out.');
    } else
      setPhoneNote(
        result.code === 'PHONE_TAKEN'
          ? 'That number belongs to another account.'
          : 'That code isn’t right or has expired.',
      );
  };

  return (
    <Card className="settings-section">
      <h2>Phone and email</h2>
      <p>
        Phone: <strong>{profile.phone}</strong>
      </p>
      <form className="settings-form" onSubmit={sendPhoneCode} noValidate>
        <InputField
          id={`${id}-phone`}
          label="New phone number"
          type="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          disabled={phoneStep === 'code'}
        />
        {phoneStep === 'code' && (
          <InputField
            id={`${id}-code`}
            label="Code sent to the new number"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
        )}
        <Button type="submit" variant="secondary">
          {phoneStep === 'idle' ? 'Send code to new number' : 'Change number'}
        </Button>
        <p role="status" className="tm-hint">
          {phoneNote}
        </p>
      </form>
      <p>
        Email:{' '}
        <strong>
          {profile.email
            ? `${profile.email} · ${profile.emailVerified ? 'Verified' : 'Not verified'}`
            : 'not added'}
        </strong>
      </p>
      <p className="tm-hint">
        A verified email gets tip notifications and can recover your account if
        you lose your number.
      </p>
      <form className="settings-form" onSubmit={sendLink} noValidate>
        <InputField
          id={`${id}-email`}
          label="Email address"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Button type="submit" variant="secondary">
          Send confirmation link
        </Button>
        <p role="status" className="tm-hint">
          {emailNote}
        </p>
      </form>
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

function Devices() {
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [round, setRound] = useState(0);
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
      <h2>Devices</h2>
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

function DeletePage() {
  const id = useId();
  const router = useRouter();
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const remove = async (event: FormEvent) => {
    event.preventDefault();
    if (confirm !== 'DELETE') {
      setError('Type DELETE to confirm.');
      return;
    }
    const result = await apiFetch('/v1/me/account', {
      method: 'DELETE',
      body: { confirm },
    });
    if (result.ok) {
      router.replace('/');
      return;
    }
    setError(
      result.code === 'HAS_BALANCE'
        ? 'You can’t delete your page while money is still confirming or in your balance.'
        : 'We couldn’t delete your page. Please try again.',
    );
  };
  return (
    <Card className="settings-section settings-section--danger">
      <h2>Delete page</h2>
      <p>
        This removes your page and your details. Records of past tips are kept,
        as the law requires, without your details. Your handle is held for 90
        days.
      </p>
      <form onSubmit={remove} noValidate className="settings-form">
        <InputField
          id={`${id}-confirm`}
          label="Type DELETE to confirm"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={error || undefined}
          autoComplete="off"
        />
        <Button type="submit" variant="secondary">
          Delete my page and account
        </Button>
      </form>
    </Card>
  );
}

export function SettingsView() {
  return (
    <div className="settings-grid">
      <h1>Settings</h1>
      <PendingRecovery />
      <PageState />
      <HandleChange />
      <PhotoSettings />
      <TipAmountsSettings />
      <AboutYou />
      <ContactDetails />
      <NotificationSettings />
      <Devices />
      <DeletePage />
    </div>
  );
}
