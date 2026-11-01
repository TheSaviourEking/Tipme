import type { TipPurpose } from '@tipme/contracts';

export const purposeLabels: Record<TipPurpose, string> = {
  thank_you: 'Saying thank you',
  great_service: 'Great service',
  helped_me: 'You helped me',
  celebration: 'Celebrating something',
  gift: 'A gift',
  other: 'Something else',
};

// Derived from the labels, not the contracts' runtime list: importing a value from the
// contracts barrel ships all of zod to every page that renders the tip form. The Record
// type above fails to compile when a purpose is added, and tip-purpose.test.mjs checks
// the order against the contract.
export const purposeOptions = (Object.keys(purposeLabels) as TipPurpose[]).map(
  (value) => ({ value, label: purposeLabels[value] }),
);
