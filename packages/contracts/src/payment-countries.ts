/**
 * The countries a recipient can set up a payment account in: our payment partner's payout
 * countries (owner's choice, 14 Nov 2026). Nigeria first, then A–Z by English name. Web shows these
 * as the Country choices; the API accepts only these codes.
 *
 * Payouts by country at the partner: NG Nigerian bank transfer; GH, KE, TZ, UG bank transfer (GH,
 * KE, TZ also mobile money); GB Faster Payments; the 20 SEPA (EUR) countries; US ACH, wire or RTP;
 * CA EFT or Interac. TipMe itself still settles in naira to Nigerian banks only.
 */
export const PAYMENT_COUNTRIES = [
  { code: 'NG', name: 'Nigeria' },
  { code: 'AT', name: 'Austria' },
  { code: 'BE', name: 'Belgium' },
  { code: 'CA', name: 'Canada' },
  { code: 'HR', name: 'Croatia' },
  { code: 'CY', name: 'Cyprus' },
  { code: 'EE', name: 'Estonia' },
  { code: 'FI', name: 'Finland' },
  { code: 'FR', name: 'France' },
  { code: 'DE', name: 'Germany' },
  { code: 'GH', name: 'Ghana' },
  { code: 'GR', name: 'Greece' },
  { code: 'IE', name: 'Ireland' },
  { code: 'IT', name: 'Italy' },
  { code: 'KE', name: 'Kenya' },
  { code: 'LV', name: 'Latvia' },
  { code: 'LT', name: 'Lithuania' },
  { code: 'LU', name: 'Luxembourg' },
  { code: 'MT', name: 'Malta' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'PT', name: 'Portugal' },
  { code: 'SK', name: 'Slovakia' },
  { code: 'SI', name: 'Slovenia' },
  { code: 'ES', name: 'Spain' },
  { code: 'TZ', name: 'Tanzania' },
  { code: 'UG', name: 'Uganda' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'US', name: 'United States' },
] as const satisfies readonly { code: string; name: string }[];

export type PaymentCountryCode = (typeof PAYMENT_COUNTRIES)[number]['code'];

/** Preselected on the card: TipMe pays out in naira to Nigerian banks. */
export const DEFAULT_PAYMENT_COUNTRY: PaymentCountryCode = 'NG';

export const PAYMENT_COUNTRY_CODES = PAYMENT_COUNTRIES.map(
  (country) => country.code,
) as [PaymentCountryCode, ...PaymentCountryCode[]];

const codes: ReadonlySet<string> = new Set(PAYMENT_COUNTRY_CODES);

/** Exactly as written: lowercase or an unlisted code is not a payment country. */
export function isPaymentCountry(value: unknown): value is PaymentCountryCode {
  return typeof value === 'string' && codes.has(value);
}
