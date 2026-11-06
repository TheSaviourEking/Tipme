// Pure helpers for the business setup forms (PR B1). No imports with '@/': unit tests load this
// file directly.
import { RESERVED_LOCATION_SLUGS } from '@tipme/contracts';

const RESERVED_WORDS = 'That address is kept for TipMe. Try another.';

/** A slug suggested from a name, as `/b/<slug>` wants it: lower case, letters, digits, hyphens. */
export function suggestSlug(name: string, max: number): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

export type SetupField =
  | 'name'
  | 'slug'
  | 'contactName'
  | 'contactEmail'
  | 'contactPhone'
  | 'location.name'
  | 'location.slug'
  | 'location.address'
  | 'address';

const WORDS: Partial<Record<SetupField, string>> = {
  name: 'Enter a name, up to 80 characters.',
  slug: 'Use lower-case letters, numbers and hyphens inside.',
  contactName: 'Enter a name, up to 80 characters.',
  contactEmail: 'Enter an email address.',
  contactPhone:
    'Enter a phone number with at least 7 digits, or leave it empty.',
  'location.name': 'Enter a name, up to 60 characters.',
  'location.slug': 'Use lower-case letters, numbers and hyphens inside.',
  'location.address': 'Enter the address, up to 200 characters.',
  address: 'Enter the address, up to 200 characters.',
};

/**
 * What a refused write says next to each field. `prefix` is 'location.' when the form's location
 * fields are sent at the top level (adding or editing a location), so its slug and name map to
 * the same ids as in the application.
 */
export function setupFieldErrors(
  result: { code: string; fields?: string[] },
  options: { locationAtTop?: boolean; locationSlug?: string } = {},
): { fields: Partial<Record<SetupField, string>>; form?: string } {
  const top = options.locationAtTop;
  if (result.code === 'BUSINESS_SLUG_TAKEN')
    return {
      fields: { slug: 'That address is taken. Try another.' },
    };
  if (result.code === 'LOCATION_SLUG_TAKEN')
    return {
      fields: {
        'location.slug':
          'This business already has a location with that address.',
      },
    };
  if (result.code === 'BUSINESS_NAME_LOCKED')
    return {
      fields: {
        name: 'Your name was checked by TipMe. To change it, contact TipMe.',
      },
    };
  if (result.code === 'SLUG_LOCKED')
    return {
      fields: {
        [top ? 'location.slug' : 'slug']:
          'The address can’t change once the business is verified, because printed codes use it.',
      },
    };
  if (result.code === 'VALIDATION_FAILED' && result.fields?.length) {
    const fields: Partial<Record<SetupField, string>> = {};
    for (const raw of result.fields) {
      const field = (
        top && ['name', 'slug', 'address'].includes(raw)
          ? `location.${raw}`
          : raw
      ) as SetupField;
      // A location slug TipMe keeps (`people`, the public search) says so, not "lower-case".
      const reserved =
        field === 'location.slug' &&
        (RESERVED_LOCATION_SLUGS as readonly string[]).includes(
          (options.locationSlug ?? '').trim().toLowerCase(),
        );
      const words = reserved ? RESERVED_WORDS : WORDS[field];
      if (words) fields[field] = words;
    }
    if (Object.keys(fields).length) return { fields };
  }
  if (result.code === 'EMAIL_VERIFICATION_REQUIRED')
    return {
      fields: {},
      form: 'Confirm your email in Settings first: TipMe writes to you there about your business.',
    };
  if (result.code === 'RATE_LIMITED')
    return {
      fields: {},
      form: 'You’ve sent a lot of these. Try again in an hour.',
    };
  if (result.code === 'NETWORK')
    return {
      fields: {},
      form: 'We couldn’t reach TipMe. Check your connection and try again.',
    };
  return {
    fields: {},
    form: 'That didn’t save. Try again in a moment.',
  };
}
