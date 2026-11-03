'use client';
import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { HandleStatus, MyProfile } from '@tipme/contracts';
import { Button, Card, InputField, Notice, TextareaField } from '@tipme/ui';
import { useRecipient } from '@/components/account/recipient-context';
import { Avatar } from '@/components/avatar';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { hasAvatar } from '@/lib/avatar-source';
import { apiFetch } from '@/lib/session-client';
import { PHOTO_LIMIT_BYTES, photoErrors } from '@/lib/photo-errors';
import { shrinkPhoto } from '@/lib/shrink-photo';
import { useSiteHost } from '@/lib/site-host';

// My page (ScreenSettings): whether the page is live, its photo, handle, amounts and words.

export function PageState() {
  const { profile, setProfile } = useRecipient();
  const host = useSiteHost();
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
    <Card id="page" className="settings-section">
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
        <Link href={`/@${profile.handle}`}>
          {host}/@{profile.handle}
        </Link>
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

/** The page's photo (PR-013): resized to a square and stripped of location data by TipMe. */
export function PhotoSettings() {
  const id = useId();
  const { profile, setProfile } = useRecipient();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const chooser = useRef<HTMLInputElement>(null);
  const refocusChooser = useRef(false);
  // After Remove photo the button is gone, and focus would fall to the page body: it goes to the
  // chooser instead, once that is enabled again.
  useEffect(() => {
    if (busy || !refocusChooser.current) return;
    refocusChooser.current = false;
    chooser.current?.focus();
  }, [busy]);
  const send = async (method: 'PUT' | 'DELETE', file?: File) => {
    setBusy(true);
    setError('');
    setDone('');
    // Shrunk here first: a phone photo uploads in seconds instead of timing out.
    const photoFile = file ? await shrinkPhoto(file) : undefined;
    if (photoFile && photoFile.size > PHOTO_LIMIT_BYTES) {
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
      if (method === 'DELETE') refocusChooser.current = true;
    } else
      setError(
        photoErrors[result.code] ?? 'We couldn’t save that. Please try again.',
      );
  };
  // An API older than PR-013 has no photos: say nothing rather than show a form that fails.
  if (!('avatarPath' in profile)) return null;
  const photo = profile.avatarPath ?? null;
  return (
    <Card id="photo" className="settings-section">
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
          ref={chooser}
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
  HANDLE_CHANGE_PRO_REQUIRED: 'Handle changes are part of TipMe Pro.',
  HANDLE_CHANGE_LIMIT: 'You’ve used all your handle changes.',
  VALIDATION_FAILED:
    'Use 3 to 30 letters, numbers or underscores, with no spaces.',
};

/** Long enough for a slow phone connection; a modal can't wait on a request for ever. */
const HANDLE_REQUEST_TIMEOUT_MS = 15_000;

const changesLeft = (n: number) =>
  n === 0 ? 'no changes left' : `${n} ${n === 1 ? 'change' : 'changes'} left`;

/**
 * Free pages keep the handle they claimed; Pro pages get a counted number of changes, and at the
 * end the form gives way to how to reach the team. The server decides all of this.
 */
export function HandleChange() {
  const id = useId();
  const { profile, setProfile } = useRecipient();
  const host = useSiteHost();
  // An API older than PR-011 does not send it (the web app deploys first).
  const previous = profile.previousHandles ?? [];
  // Nor does an API older than the handle rule send the count: no number to show, but it can go on.
  const counted = profile.handleChanges;
  const left = counted ? Math.max(0, counted.allowed - counted.used) : null;
  const [handle, setHandle] = useState(profile.handle);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState('');
  // Counts each error, so the same message a second time still moves focus to it.
  const [errorCount, setErrorCount] = useState(0);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const savedMessage = useRef<HTMLParagraphElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const closeConfirm = useCallback(() => setConfirming(null), []);
  const wanted = handle.trim().replace(/^@/, '').toLowerCase();

  // Keyboard and screen reader users land on the outcome once the dialog has gone.
  useEffect(() => {
    if (saved) savedMessage.current?.focus();
  }, [saved]);
  // The field, or the heading when the card has just swapped to one with no form.
  useEffect(() => {
    if (errorCount > 0)
      (document.getElementById(`${id}-handle`) ?? heading.current)?.focus();
  }, [errorCount, id]);
  const fail = (message: string) => {
    setError(message);
    setErrorCount((count) => count + 1);
  };

  /** Only asks to confirm a handle that can work; the server still has the last word. */
  const review = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    setSaved(false);
    if (wanted.length < 3) {
      fail(renameErrors.VALIDATION_FAILED!);
      return;
    }
    setBusy(true);
    const check = await apiFetch<{ status: HandleStatus }>(
      `/v1/handles/${encodeURIComponent(wanted)}/availability`,
      { timeoutMs: HANDLE_REQUEST_TIMEOUT_MS },
    );
    setBusy(false);
    const status = check.ok ? check.data.status : 'available';
    if (status === 'invalid') fail(renameErrors.VALIDATION_FAILED!);
    else if (
      status === 'reserved' ||
      (status === 'taken' && !previous.includes(wanted))
    )
      fail(renameErrors.HANDLE_TAKEN!);
    else setConfirming(wanted);
  };

  const save = async (next: string) => {
    setBusy(true);
    const result = await apiFetch<MyProfile>('/v1/me/handle', {
      method: 'PUT',
      body: { handle: next },
      timeoutMs: HANDLE_REQUEST_TIMEOUT_MS,
    });
    const succeeded = (mine: MyProfile) => {
      setProfile(mine);
      setHandle(mine.handle);
      setSaved(true);
    };
    if (result.ok) {
      setBusy(false);
      setConfirming(null);
      succeeded(result.data);
      return;
    }
    // Refused for a reason, or the outcome is unknown (a lost connection, a timeout, a 5xx): either
    // way, show what is true now. Only a request that failed validation changed nothing for sure.
    const fresh =
      result.code === 'VALIDATION_FAILED'
        ? null
        : await apiFetch<MyProfile>('/v1/me/profile', {
            timeoutMs: HANDLE_REQUEST_TIMEOUT_MS,
          });
    setBusy(false);
    setConfirming(null);
    if (fresh?.ok && fresh.data.handle === next) {
      succeeded(fresh.data);
      return;
    }
    if (fresh?.ok) setProfile(fresh.data);
    fail(
      renameErrors[result.code] ??
        (fresh?.ok
          ? 'We couldn’t change that. Please try again.'
          : 'We couldn’t tell whether that went through. Reload this page to see your handle.'),
    );
  };

  const oldHandles = previous.length > 0 && (
    <p className="tm-hint">
      Old handles that lead here: {previous.map((old) => `@${old}`).join(', ')}
    </p>
  );
  const savedNotice = saved && (
    <p
      key={profile.handle}
      ref={savedMessage}
      role="status"
      tabIndex={-1}
      className="tm-hint handle-saved"
    >
      Saved. Your page is now at {host}/@{profile.handle}.
    </p>
  );

  if (profile.plan !== 'pro')
    return (
      <Card id="handle" className="settings-section">
        <h2 ref={heading} tabIndex={-1}>
          Your handle
        </h2>
        <p className="tm-hint" role={error ? 'alert' : undefined}>
          Your page is at {host}/@{profile.handle}. Handle changes are part of
          TipMe Pro.
        </p>
        {oldHandles}
      </Card>
    );

  if (left === 0)
    return (
      <Card className="settings-section">
        <h2 ref={heading} tabIndex={-1}>
          Your handle
        </h2>
        {savedNotice}
        <p role={error ? 'alert' : undefined}>
          You’ve used all your handle changes.{' '}
          <a href="mailto:support@usetipme.xyz">Contact the TipMe team</a> to
          change it again.
        </p>
        {oldHandles}
      </Card>
    );

  return (
    <Card className="settings-section">
      <h2>Your handle</h2>
      <p className="tm-hint">
        {left !== null && <strong>{changesLeft(left)}. </strong>}
        Switching back to an old handle counts as a change. Your old links and
        printed QR codes keep working: they lead to your new handle, and nobody
        else can take them.
      </p>
      <form
        className="settings-form"
        onSubmit={(event) => void review(event)}
        noValidate
      >
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
            setError('');
          }}
          error={error || undefined}
        />
        {oldHandles}
        {savedNotice}
        {/* Stays enabled while checking: a disabled button would drop keyboard focus. */}
        <Button
          type="submit"
          disabled={wanted === profile.handle}
          aria-busy={busy}
        >
          Change handle
        </Button>
      </form>
      {confirming && (
        <ConfirmDialog
          title={`Change your handle to @${confirming}?`}
          confirm="Yes, change it"
          busy={busy}
          onConfirm={() => void save(confirming)}
          onCancel={closeConfirm}
        >
          <p>
            Your page moves to {host}/@{confirming}. Old links and printed QR
            codes keep working.
          </p>
          {left !== null && (
            <p>You’ll have {changesLeft(left - 1)} after this.</p>
          )}
        </ConfirmDialog>
      )}
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
export function TipAmountsSettings() {
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
        text: 'The smallest tip must be at least NGN 2,000, in whole naira.',
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
          hint="At least NGN 2,000."
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

export function AboutYou() {
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
        {profile.phone && (
          <>
            <p className="tm-hint">Your phone number: {profile.phone}</p>
            {check('phonePublic', 'Show my phone number on my page')}
          </>
        )}
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
