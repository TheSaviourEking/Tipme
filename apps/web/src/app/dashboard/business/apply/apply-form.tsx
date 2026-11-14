'use client';
import Link from 'next/link';
import { useContext, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { BusinessDetail } from '@tipme/contracts';
import { Button, InputField, Slip, StateLine } from '@tipme/ui';
import { RecipientContext } from '@/components/account/recipient-context';
import { useAccount } from '@/components/account/account-context';
import {
  announceRolesChanged,
  applyForBusiness,
} from '@/lib/business/setup-api';
import {
  setupFieldErrors,
  suggestSlug,
  type SetupField,
} from '@/lib/business/setup-form';

/**
 * Create a business (PR B1, owner's answer Q3): anyone signed in, with their own account. It waits
 * for TipMe staff to check its name, address and contact before its codes go live (PR B2), so
 * the confirmation promises no time and no approval.
 */
export function ApplyForm() {
  const id = useId();
  // The login's own email (business sign-up: a login with no page applies too); the page's name
  // when there is one.
  const profile = useContext(RecipientContext)?.profile ?? null;
  const { account } = useAccount();
  const emailVerified = account?.emailVerified ?? false;
  // Drawn in the browser only (the dashboard waits for the signed-in profile), so this is safe.
  const [host] = useState(() =>
    typeof window === 'undefined' ? 'usetipme.xyz' : window.location.host,
  );
  const [form, setForm] = useState({
    name: '',
    slug: '',
    locationName: '',
    locationSlug: '',
    address: '',
    contactName: profile?.displayName ?? '',
    contactEmail: emailVerified ? (account?.email ?? '') : '',
    contactPhone: '',
  });
  // Suggested from the names until the person types an address of their own.
  const [slugTyped, setSlugTyped] = useState({
    business: false,
    location: false,
  });
  const [errors, setErrors] = useState<Partial<Record<SetupField, string>>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<BusinessDetail | null>(null);
  const fields = useRef<HTMLFormElement>(null);
  const done = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (made) done.current?.querySelector<HTMLElement>('a, button')?.focus();
  }, [made]);
  // After a refusal has drawn its errors, focus goes to the first field that needs fixing.
  const [refused, setRefused] = useState(0);
  useEffect(() => {
    if (refused)
      fields.current
        ?.querySelector<HTMLElement>('[aria-invalid="true"]')
        ?.focus();
  }, [refused]);

  const set = (key: keyof typeof form, value: string) =>
    setForm((current) => {
      const next = { ...current, [key]: value };
      if (key === 'name' && !slugTyped.business)
        next.slug = suggestSlug(value, 40);
      if (key === 'locationName' && !slugTyped.location)
        next.locationSlug = suggestSlug(value, 30);
      return next;
    });

  if (!emailVerified)
    return (
      <div className="dashboard-section business-apply">
        <h1>Create your business</h1>
        <Slip
          tone="unsure"
          title="Confirm your email first."
          actions={<Link href="/dashboard/settings">Go to Settings</Link>}
        >
          <p>
            TipMe writes to you there about your business, so your account needs
            a confirmed email before you create one.
          </p>
        </Slip>
      </div>
    );

  if (made)
    return (
      <div className="dashboard-section business-apply" ref={done}>
        <h1>Create your business</h1>
        <Slip
          tone="waiting"
          title={`Thanks. TipMe staff will check ${made.name}’s name, address and contact.`}
          actions={
            <Link href={`/dashboard/business?business=${made.id}`}>
              Go to your business
            </Link>
          }
          data-testid="business-applied"
        >
          <p>Your codes go live once it’s verified.</p>
        </Slip>
      </div>
    );

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setErrors({});
    setFormError('');
    const phone = form.contactPhone.trim();
    const result = await applyForBusiness({
      name: form.name,
      slug: form.slug,
      contactName: form.contactName,
      contactEmail: form.contactEmail,
      ...(phone ? { contactPhone: phone } : {}),
      location: {
        name: form.locationName,
        slug: form.locationSlug,
        address: form.address,
      },
    });
    setBusy(false);
    if (result.ok) {
      announceRolesChanged();
      setMade(result.data);
      return;
    }
    const told = setupFieldErrors(result, {
      locationSlug: form.locationSlug,
    });
    setErrors(told.fields);
    setFormError(told.form ?? '');
    setRefused((n) => n + 1);
  };

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

  return (
    <div className="dashboard-section business-apply">
      <h1>Create your business</h1>
      <p className="tm-hint">
        Your business uses your own TipMe account. TipMe staff check its name,
        address and contact before its codes go live.
      </p>
      <form
        ref={fields}
        className="business-apply__form"
        noValidate
        onSubmit={(event) => void submit(event)}
        aria-describedby={formError ? `${id}-form-error` : undefined}
      >
        <fieldset className="business-apply__group">
          <legend>Your business</legend>
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
              setSlugTyped((t) => ({ ...t, business: true }));
              set('slug', event.target.value.toLowerCase());
            },
          })}
        </fieldset>
        <fieldset className="business-apply__group">
          <legend>First location</legend>
          {field('locationName', 'Location name', 'location.name', {
            maxLength: 60,
            required: true,
            placeholder: 'Victoria Island',
          })}
          {field('locationSlug', 'Location address on TipMe', 'location.slug', {
            maxLength: 30,
            required: true,
            autoCapitalize: 'none',
            spellCheck: false,
            hint: `${host}/b/${form.slug || 'your-business'}/${form.locationSlug || 'location'}`,
            onChange: (event) => {
              setSlugTyped((t) => ({ ...t, location: true }));
              set('locationSlug', event.target.value.toLowerCase());
            },
          })}
          {field('address', 'Street address', 'location.address', {
            maxLength: 200,
            required: true,
            autoComplete: 'street-address',
          })}
        </fieldset>
        <fieldset className="business-apply__group">
          <legend>Contact for TipMe</legend>
          <p className="tm-hint">
            Only you and TipMe staff see this. Customers never do.
          </p>
          {field('contactName', 'Contact name', 'contactName', {
            maxLength: 80,
            required: true,
            autoComplete: 'name',
          })}
          {field('contactEmail', 'Contact email', 'contactEmail', {
            type: 'email',
            maxLength: 254,
            required: true,
            autoComplete: 'email',
          })}
          {field('contactPhone', 'Contact phone (optional)', 'contactPhone', {
            type: 'tel',
            maxLength: 32,
            autoComplete: 'tel',
          })}
        </fieldset>
        <div className="business-apply__send">
          <Button type="submit" variant="continue" disabled={busy}>
            {busy ? 'Sending…' : 'Create business'}
          </Button>
          <StateLine tone="error" id={`${id}-form-error`}>
            {formError}
          </StateLine>
        </div>
      </form>
    </div>
  );
}
