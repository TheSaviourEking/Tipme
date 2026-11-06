'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { BusinessDetail } from '@tipme/contracts';
import { Button, InputField, Slip, StateLine } from '@tipme/ui';
import { BusinessLogoTile } from '@/components/business/business-logo-tile';
import {
  removeBusinessLogo,
  uploadBusinessLogo,
  useManagedLogo,
} from '@/lib/business/logo';
import { updateBusiness } from '@/lib/business/setup-api';
import { PHOTO_LIMIT_BYTES, photoErrors } from '@/lib/photo-errors';
import { shrinkPhoto } from '@/lib/shrink-photo';
import { setupFieldErrors, type SetupField } from '@/lib/business/setup-form';

/** Where the business stands with TipMe. Never "approved", "licensed" or "regulated" (M10). */
function Standing({ business }: { business: BusinessDetail }) {
  if (business.status === 'verified')
    return (
      <p className="business-standing" data-testid="business-standing">
        <strong>Verified business</strong>
        <span>TipMe checked this business’s name, address and contact.</span>
      </p>
    );
  if (business.status === 'suspended')
    return (
      <Slip tone="unsure" title="Paused by TipMe" live="none">
        {/* The reason staff wrote, shown as text only. */}
        <p data-testid="business-standing">
          Paused by TipMe: {business.suspendedReason ?? 'No reason given.'}
        </p>
      </Slip>
    );
  return (
    <p className="business-standing" data-testid="business-standing">
      <strong>Waiting to be verified</strong>
      <span>
        TipMe staff will check its name, address and contact. Your codes go live
        once it’s verified.
      </span>
    </p>
  );
}

/**
 * Owners: the square logo the public pages show beside the name (the initial without one). The
 * page photo's pipeline: the same limits, and TipMe re-encodes it without hidden details.
 */
function LogoField({
  business,
  onChange,
}: {
  business: BusinessDetail;
  onChange?: (next: BusinessDetail) => void;
}) {
  const id = useId();
  const logo = useManagedLogo(business);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const chooser = useRef<HTMLInputElement>(null);
  const refocusChooser = useRef(false);
  // After Remove logo the button is gone: focus goes to the chooser, once it is enabled again.
  useEffect(() => {
    if (busy || !refocusChooser.current) return;
    refocusChooser.current = false;
    chooser.current?.focus();
  }, [busy]);
  const send = async (file?: File) => {
    setBusy(true);
    setError('');
    setDone('');
    // A PNG or WebP that already fits is sent as it is, so a transparent logo stays transparent;
    // anything else is shrunk first, like a page photo (a phone photo uploads in seconds).
    const keepsAlpha =
      file &&
      (file.type === 'image/png' || file.type === 'image/webp') &&
      file.size <= PHOTO_LIMIT_BYTES;
    const logoFile = file
      ? keepsAlpha
        ? file
        : await shrinkPhoto(file)
      : undefined;
    if (logoFile && logoFile.size > PHOTO_LIMIT_BYTES) {
      setBusy(false);
      setError(photoErrors['PAYLOAD_TOO_LARGE']!);
      return;
    }
    const result = logoFile
      ? await uploadBusinessLogo(business.id, logoFile)
      : await removeBusinessLogo(business.id);
    setBusy(false);
    if (result.ok) {
      onChange?.(result.data);
      setDone(logoFile ? 'Logo saved.' : 'Logo removed.');
      if (!logoFile) refocusChooser.current = true;
    } else
      setError(
        photoErrors[result.code] ?? 'We couldn’t save that. Please try again.',
      );
  };
  return (
    <div className="business-details__logo">
      <p className="tm-hint">
        Logo (optional). It shows beside your name on your location and staff
        pages. TipMe crops it to a square and removes hidden details such as
        where it was taken. JPEG, PNG or WebP, up to 5 MB.
      </p>
      <BusinessLogoTile
        name={business.name}
        src={logo}
        className="business-page__logo"
      />
      <div className="tm-field">
        <label htmlFor={`${id}-logo`}>
          {business.logoPath ? 'Choose a new logo' : 'Choose a logo'}
        </label>
        <input
          ref={chooser}
          id={`${id}-logo`}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          aria-describedby={error ? `${id}-logo-error` : undefined}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void send(file);
            event.target.value = '';
          }}
        />
      </div>
      {error && (
        <p className="tm-field-error" role="alert" id={`${id}-logo-error`}>
          {error}
        </p>
      )}
      {/* Always present, so screen readers announce what is written into it. */}
      <p role="status" className="tm-hint">
        {done}
      </p>
      {business.logoPath && (
        <Button variant="quiet" disabled={busy} onClick={() => void send()}>
          Remove logo
        </Button>
      )}
    </div>
  );
}

const draftOf = (business: BusinessDetail) => ({
  name: business.name,
  slug: business.slug,
  contactName: business.contact.name,
  contactEmail: business.contact.email,
  contactPhone: business.contact.phone ?? '',
});

/** Section "Details" (PR B1): owners edit; a location manager reads the name only. */
export function DetailsCard({
  business,
  onChange,
}: {
  business: BusinessDetail;
  onChange?: (next: BusinessDetail) => void;
}) {
  const id = useId();
  const owner = business.you.role === 'owner';
  const [draft, setDraft] = useState(() => draftOf(business));
  const [errors, setErrors] = useState<Partial<Record<SetupField, string>>>({});
  const [line, setLine] = useState<{ tone: 'error' | 'status'; text: string }>({
    tone: 'status',
    text: '',
  });
  const [busy, setBusy] = useState(false);
  // A newer business from the page (a save here or elsewhere) resets the fields to it.
  const [shown, setShown] = useState(business);
  if (shown !== business) {
    setShown(business);
    setDraft(draftOf(business));
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setErrors({});
    setLine({ tone: 'status', text: '' });
    const phone = draft.contactPhone.trim();
    const result = await updateBusiness(business.id, {
      // Locked with the slug once verified: sent only while it can change.
      ...(business.slugLocked ? {} : { name: draft.name }),
      contactName: draft.contactName,
      contactEmail: draft.contactEmail,
      contactPhone: phone ? phone : null,
      ...(business.slugLocked ? {} : { slug: draft.slug }),
    });
    setBusy(false);
    if (result.ok) {
      onChange?.(result.data);
      setLine({ tone: 'status', text: 'Saved.' });
      return;
    }
    const told = setupFieldErrors(result);
    setErrors(told.fields);
    if (told.form) setLine({ tone: 'error', text: told.form });
  };

  const input = (
    key: keyof typeof draft,
    label: string,
    props: Partial<Parameters<typeof InputField>[0]> = {},
  ) => (
    <InputField
      id={`${id}-${key}`}
      label={label}
      value={draft[key]}
      error={errors[key]}
      onChange={(event) =>
        setDraft((current) => ({ ...current, [key]: event.target.value }))
      }
      {...props}
    />
  );

  return (
    <div className="business-details">
      <Standing business={business} />
      {owner && <LogoField business={business} onChange={onChange} />}
      {owner ? (
        <form
          className="business-details__form"
          noValidate
          onSubmit={(event) => void save(event)}
        >
          {business.slugLocked ? (
            <div className="business-details__locked">
              <p>
                <span className="tm-hint">Business name</span>{' '}
                <strong data-testid="business-name">{business.name}</strong>
              </p>
              <p className="tm-hint">
                Your name was checked by TipMe. To change it, contact TipMe.
              </p>
            </div>
          ) : (
            input('name', 'Business name', { maxLength: 80, required: true })
          )}
          {business.slugLocked ? (
            <p className="tm-hint" data-testid="business-slug">
              Address on TipMe: /b/{business.slug}. It can’t change now that the
              business is verified, because printed codes use it.
            </p>
          ) : (
            input('slug', 'Address on TipMe', {
              maxLength: 40,
              required: true,
              autoCapitalize: 'none',
              spellCheck: false,
              hint: `/b/${draft.slug}. You can change it until TipMe verifies the business.`,
            })
          )}
          {input('contactName', 'Contact name', {
            maxLength: 80,
            required: true,
          })}
          {input('contactEmail', 'Contact email', {
            type: 'email',
            maxLength: 254,
            required: true,
          })}
          {input('contactPhone', 'Contact phone (optional)', {
            type: 'tel',
            maxLength: 32,
          })}
          <div className="business-details__send">
            <Button type="submit" variant="secondary" disabled={busy}>
              {busy ? 'Saving…' : 'Save details'}
            </Button>
            <StateLine tone={line.tone}>{line.text}</StateLine>
          </div>
        </form>
      ) : (
        <p className="tm-hint">
          Only an owner of {business.name} can change its details.
        </p>
      )}
    </div>
  );
}
