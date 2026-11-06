'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { BusinessDetail, BusinessLocationView } from '@tipme/contracts';
import { Button, InputField, StateLine } from '@tipme/ui';
import {
  addLocation,
  closeLocation,
  updateLocation,
} from '@/lib/business/setup-api';
import {
  setupFieldErrors,
  suggestSlug,
  type SetupField,
} from '@/lib/business/setup-form';

type Draft = { name: string; slug: string; address: string };
type Errors = Partial<Record<SetupField, string>>;

/** One location's fields: adding (the slug suggested from the name) or editing. */
function LocationForm({
  idPrefix,
  initial,
  slugLocked,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  idPrefix: string;
  initial: Draft;
  slugLocked: boolean;
  submitLabel: string;
  onSubmit: (draft: Draft) => Promise<{ errors: Errors; form?: string } | null>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [slugTyped, setSlugTyped] = useState(initial.slug !== '');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  // After a refusal has drawn its errors, focus goes to the first field that needs fixing.
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    if (asked)
      form.current
        ?.querySelector<HTMLElement>('[aria-invalid="true"]')
        ?.focus();
  }, [asked]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const refused = await onSubmit(draft);
    setBusy(false);
    setErrors(refused?.errors ?? {});
    setFormError(refused?.form ?? '');
    if (refused) setAsked((n) => n + 1);
  };

  return (
    <form
      ref={form}
      className="business-location__form"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <InputField
        id={`${idPrefix}-name`}
        label="Location name"
        value={draft.name}
        maxLength={60}
        required
        error={errors['location.name']}
        onChange={(event) => {
          const name = event.target.value;
          setDraft((current) => ({
            ...current,
            name,
            ...(slugTyped ? {} : { slug: suggestSlug(name, 30) }),
          }));
        }}
      />
      {!slugLocked && (
        <InputField
          id={`${idPrefix}-slug`}
          label="Location address on TipMe"
          value={draft.slug}
          maxLength={30}
          required
          autoCapitalize="none"
          spellCheck={false}
          error={errors['location.slug']}
          onChange={(event) => {
            setSlugTyped(true);
            setDraft((current) => ({
              ...current,
              slug: event.target.value.toLowerCase(),
            }));
          }}
        />
      )}
      <InputField
        id={`${idPrefix}-address`}
        label="Street address"
        value={draft.address}
        maxLength={200}
        required
        error={errors['location.address']}
        onChange={(event) =>
          setDraft((current) => ({ ...current, address: event.target.value }))
        }
      />
      <div className="business-location__keys">
        <Button type="submit" variant="secondary" disabled={busy}>
          {busy ? 'Saving…' : submitLabel}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <StateLine tone="error">{formError}</StateLine>
    </form>
  );
}

/**
 * Section "Locations" (PR B1). Owners add and close; an owner or that location's own manager
 * edits. A location's address on TipMe is chosen once: it locks when the business is verified.
 */
export function LocationsCard({
  business,
  onChange,
}: {
  business: BusinessDetail;
  onChange?: (next: BusinessDetail) => void;
}) {
  const id = useId();
  const owner = business.you.role === 'owner';
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);
  const [said, say] = useState<{ tone: 'error' | 'status'; text: string }>({
    tone: 'status',
    text: '',
  });

  const answered = (
    result: Awaited<ReturnType<typeof addLocation>>,
    done: string,
    locationSlug?: string,
  ) => {
    if (result.ok) {
      onChange?.(result.data);
      say({ tone: 'status', text: done });
      return null;
    }
    const told = setupFieldErrors(result, {
      locationAtTop: true,
      locationSlug,
    });
    return { errors: told.fields, form: told.form };
  };

  const close = async (location: BusinessLocationView) => {
    const result = await closeLocation(business.id, location.id);
    setClosing(null);
    if (result.ok) {
      onChange?.(result.data);
      say({ tone: 'status', text: `${location.name} is closed.` });
    } else
      say({
        tone: 'error',
        text: `${location.name} wasn’t closed. Try again in a moment.`,
      });
  };

  return (
    <div className="business-locations">
      <ul className="business-locations__list">
        {business.locations.map((location) => (
          <li
            key={location.id}
            className="business-location"
            data-testid="business-location"
          >
            {editing === location.id ? (
              <LocationForm
                idPrefix={`${id}-${location.id}`}
                initial={{
                  name: location.name,
                  slug: location.slug,
                  address: location.address,
                }}
                slugLocked={business.slugLocked}
                submitLabel="Save location"
                onCancel={() => setEditing(null)}
                onSubmit={async (draft) => {
                  const refused = answered(
                    await updateLocation(business.id, location.id, {
                      name: draft.name,
                      address: draft.address,
                      ...(business.slugLocked ? {} : { slug: draft.slug }),
                    }),
                    `${draft.name} is saved.`,
                    draft.slug,
                  );
                  if (!refused) setEditing(null);
                  return refused;
                }}
              />
            ) : (
              <>
                <div className="business-location__text">
                  <strong>{location.name}</strong>
                  <span>{location.address}</span>
                  <span className="tm-hint">
                    /b/{business.slug}/{location.slug}
                    {location.closed ? ' · Closed' : ''}
                  </span>
                </div>
                {!location.closed && (
                  <div className="business-location__keys">
                    <Button
                      variant="secondary"
                      aria-label={`Edit ${location.name}`}
                      onClick={() => setEditing(location.id)}
                    >
                      Edit
                    </Button>
                    {owner && (
                      <Button
                        variant="secondary"
                        aria-label={`Close ${location.name}`}
                        onClick={() => setClosing(location.id)}
                      >
                        Close
                      </Button>
                    )}
                  </div>
                )}
                {closing === location.id && (
                  <div
                    className="business-location__confirm"
                    role="group"
                    aria-label={`Close ${location.name}?`}
                  >
                    <p>
                      People at {location.name} stay on your team. The location
                      page stops showing.
                    </p>
                    <div className="business-location__keys">
                      <Button
                        variant="secondary"
                        onClick={() => void close(location)}
                      >
                        Yes, close {location.name}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => setClosing(null)}
                      >
                        Keep it open
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      {owner &&
        (adding ? (
          <LocationForm
            idPrefix={`${id}-new`}
            initial={{ name: '', slug: '', address: '' }}
            slugLocked={false}
            submitLabel="Add location"
            onCancel={() => setAdding(false)}
            onSubmit={async (draft) => {
              const refused = answered(
                await addLocation(business.id, draft),
                `${draft.name} is added.`,
                draft.slug,
              );
              if (!refused) setAdding(false);
              return refused;
            }}
          />
        ) : (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Add location
          </Button>
        ))}
      <StateLine tone={said.tone}>{said.text}</StateLine>
    </div>
  );
}
