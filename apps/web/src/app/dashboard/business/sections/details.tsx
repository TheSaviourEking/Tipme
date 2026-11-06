'use client';
import Link from 'next/link';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { BusinessDetail } from '@tipme/contracts';
import { Button, InputField, Slip, StateLine } from '@tipme/ui';
import { updateBusiness } from '@/lib/business/setup-api';
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
              Address on TipMe:{' '}
              <Link href={`/b/${business.slug}`}>/b/{business.slug}</Link>. It
              can’t change now that the business is verified, because printed
              codes use it.
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
