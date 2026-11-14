'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { MyAccount } from '@tipme/contracts';
import { Button, InputField, Skeleton, StateLine } from '@tipme/ui';
import { uploadBusinessLogo } from '@/lib/business/logo';
import {
  announceRolesChanged,
  applyForBusiness,
} from '@/lib/business/setup-api';
import {
  setupFieldErrors,
  suggestSlug,
  type SetupField,
} from '@/lib/business/setup-form';
import { PHOTO_LIMIT_BYTES } from '@/lib/photo-errors';
import { apiFetch } from '@/lib/session-client';
import { shrinkPhoto } from '@/lib/shrink-photo';

// Business sign-up, Task D3: steps 3 and 4 of "For businesses", after the email code. Today's
// application fields (apply-form.tsx), split in two so a phone never scrolls far. The code just
// confirmed the email, which is the contact for TipMe. The business is made only at "Send to
// TipMe"; a logo chosen at step 3 is held here and uploaded right after (R17).

const BUSINESS_FIELDS: SetupField[] = ['name', 'slug'];

export function BusinessSteps({
  onStepChange,
}: {
  onStepChange: (step: 'business' | 'location') => void;
}) {
  const id = useId();
  const router = useRouter();
  const [account, setAccount] = useState<MyAccount | null>(null);
  const [step, setStepState] = useState<'business' | 'location'>('business');
  const setStep = (next: 'business' | 'location') => {
    setStepState(next);
    onStepChange(next);
  };
  const [host] = useState(() =>
    typeof window === 'undefined' ? 'usetipme.xyz' : window.location.host,
  );
  const [form, setForm] = useState({
    name: '',
    slug: '',
    ownerName: '',
    locationName: '',
    locationSlug: '',
    address: '',
    contactPhone: '',
  });
  const [slugTyped, setSlugTyped] = useState({
    business: false,
    location: false,
  });
  const [logo, setLogo] = useState<File | null>(null);
  const [errors, setErrors] = useState<Partial<Record<SetupField, string>>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const fields = useRef<HTMLFormElement>(null);
  const [refused, setRefused] = useState(0);

  useEffect(() => {
    void apiFetch<MyAccount>('/v1/me/account').then((result) => {
      if (result.ok) setAccount(result.data);
    });
  }, []);
  // Each step starts at its first field; after a refusal, at the first field to fix.
  useEffect(() => {
    const first = fields.current?.querySelector<HTMLElement>(
      refused ? '[aria-invalid="true"]' : 'input',
    );
    first?.focus();
  }, [step, refused]);

  const set = (key: keyof typeof form, value: string) =>
    setForm((current) => {
      const next = { ...current, [key]: value };
      if (key === 'name' && !slugTyped.business)
        next.slug = suggestSlug(value, 40);
      if (key === 'locationName' && !slugTyped.location)
        next.locationSlug = suggestSlug(value, 30);
      return next;
    });

  if (!account) return <Skeleton label="Loading your account" />;
  const email = account.emailVerified ? account.email : null;

  const field = (
    key: keyof typeof form,
    label: string,
    error: SetupField,
    props: Partial<Parameters<typeof InputField>[0]> = {},
  ) => (
    <InputField
      id={`${id}-${key}`}
      label={label}
      value={form[key]}
      error={errors[error]}
      onChange={(event) => set(key, event.target.value)}
      {...props}
    />
  );

  const toLocation = (event: FormEvent) => {
    event.preventDefault();
    const missing: Partial<Record<SetupField, string>> = {};
    if (!form.name.trim()) missing.name = 'Enter your business’s name.';
    if (!form.slug.trim()) missing.slug = 'Choose an address on TipMe.';
    setErrors(missing);
    if (Object.keys(missing).length > 0) {
      setRefused((n) => n + 1);
      return;
    }
    setStep('location');
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !email) return;
    setBusy(true);
    setErrors({});
    setFormError('');
    const phone = form.contactPhone.trim();
    const result = await applyForBusiness({
      name: form.name,
      slug: form.slug,
      contactName: form.ownerName,
      contactEmail: email,
      ownerName: form.ownerName,
      ...(phone ? { contactPhone: phone } : {}),
      location: {
        name: form.locationName,
        slug: form.locationSlug,
        address: form.address,
      },
    });
    if (!result.ok) {
      setBusy(false);
      const told = setupFieldErrors(result, {
        locationSlug: form.locationSlug,
      });
      setErrors(told.fields);
      setFormError(told.form ?? '');
      // A name or address problem is fixed on the step that asked for it.
      if (BUSINESS_FIELDS.some((key) => told.fields[key])) setStep('business');
      setRefused((n) => n + 1);
      return;
    }
    announceRolesChanged();
    // The business is made; a logo that fails to upload can be added from the business (R17).
    if (logo) {
      const keeps =
        (logo.type === 'image/png' || logo.type === 'image/webp') &&
        logo.size <= PHOTO_LIMIT_BYTES;
      const file = keeps ? logo : await shrinkPhoto(logo).catch(() => null);
      if (file && file.size <= PHOTO_LIMIT_BYTES)
        await uploadBusinessLogo(result.data.id, file);
    }
    router.replace(`/dashboard/business?business=${result.data.id}`);
  };

  if (step === 'business')
    return (
      <form
        ref={fields}
        className="auth-form business-steps"
        onSubmit={toLocation}
        noValidate
      >
        <h2>Tell us about your business.</h2>
        <p className="tm-hint">
          This is what customers see on your page and on your QR codes. You can
          change it later.
        </p>
        {field('name', 'Business name', 'name', {
          maxLength: 80,
          required: true,
          autoComplete: 'organization',
        })}
        {field('slug', 'Address on TipMe', 'slug', {
          maxLength: 40,
          required: true,
          autoCapitalize: 'none',
          spellCheck: false,
          hint: `${host}/b/${form.slug || 'your-business'}`,
          onChange: (event) => {
            setSlugTyped((typed) => ({ ...typed, business: true }));
            set('slug', event.target.value.toLowerCase());
          },
        })}
        <div className="tm-field">
          <label htmlFor={`${id}-logo`}>Logo (optional)</label>
          <input
            id={`${id}-logo`}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            aria-describedby={`${id}-logo-hint`}
            onChange={(event) => setLogo(event.target.files?.[0] ?? null)}
          />
          <p className="tm-hint" id={`${id}-logo-hint`}>
            {logo ? `Chosen: ${logo.name}.` : 'Add one now or skip it.'} JPEG,
            PNG or WebP, up to 5 MB.
          </p>
        </div>
        <Button type="submit" variant="continue">
          Continue
        </Button>
      </form>
    );

  return (
    <form
      ref={fields}
      className="auth-form business-steps"
      onSubmit={(event) => void send(event)}
      noValidate
      aria-describedby={formError ? `${id}-form-error` : undefined}
    >
      <h2>Where do customers find you?</h2>
      <p className="tm-hint">
        Each place gets its own QR code. Start with one; add more once you’re
        verified.
      </p>
      <fieldset className="business-steps__group">
        <legend>Contact for TipMe</legend>
        {field('ownerName', 'Your name', 'contactName', {
          maxLength: 60,
          required: true,
          autoComplete: 'name',
        })}
        <p className="business-steps__email">{email}</p>
        <p className="tm-hint">Only you and TipMe staff see this.</p>
      </fieldset>
      {field('locationName', 'Location name', 'location.name', {
        maxLength: 60,
        required: true,
      })}
      {field('locationSlug', 'Location address on TipMe', 'location.slug', {
        maxLength: 30,
        required: true,
        autoCapitalize: 'none',
        spellCheck: false,
        hint: `${host}/b/${form.slug || 'your-business'}/${form.locationSlug || 'location'}`,
        onChange: (event) => {
          setSlugTyped((typed) => ({ ...typed, location: true }));
          set('locationSlug', event.target.value.toLowerCase());
        },
      })}
      {field('address', 'Street address', 'location.address', {
        maxLength: 200,
        required: true,
        autoComplete: 'street-address',
      })}
      {field('contactPhone', 'Contact phone (optional)', 'contactPhone', {
        type: 'tel',
        maxLength: 32,
        autoComplete: 'tel',
      })}
      <Button type="submit" variant="continue" disabled={busy}>
        {busy ? 'Sending…' : 'Send to TipMe'}
      </Button>
      <StateLine tone="error" id={`${id}-form-error`}>
        {formError}
      </StateLine>
      <Button variant="quiet" onClick={() => setStep('business')}>
        Back to your business
      </Button>
    </form>
  );
}
