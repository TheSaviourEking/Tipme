'use client';
import { GetPaidCard } from '@/components/account/get-paid-card';
import { PaymentAccountCard } from '../payment-account-card';
import { SettingsChapter } from './section';

/**
 * Getting paid (ScreenSettings): the payment account, when our payment partner needs one, and the
 * bank account withdrawals go to. Each card keeps its own id (#payments, #get-paid) for old links.
 */
export function GettingPaidSection() {
  return (
    <SettingsChapter id="paid">
      <PaymentAccountCard />
      <GetPaidCard />
    </SettingsChapter>
  );
}
