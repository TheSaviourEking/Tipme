import type { TipPurpose } from '@tipme/contracts';
import { tipPurposes } from '@tipme/contracts';

export const purposeLabels: Record<TipPurpose, string> = {
  thank_you: 'Saying thank you',
  great_service: 'Great service',
  helped_me: 'You helped me',
  celebration: 'Celebrating something',
  gift: 'A gift',
  other: 'Something else',
};

export const purposeOptions = tipPurposes.map((value) => ({
  value,
  label: purposeLabels[value],
}));
