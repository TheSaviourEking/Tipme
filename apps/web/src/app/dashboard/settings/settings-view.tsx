'use client';
import { CoverSettings } from '@/components/account/cover-settings';
import { GetPaidCard } from '@/components/account/get-paid-card';
import { PaymentAccountCard } from './payment-account-card';
import { DeletePage } from './sections/data';
import {
  AboutYou,
  HandleChange,
  PageState,
  PhotoSettings,
  TipAmountsSettings,
} from './sections/my-page';
import { NotificationSettings } from './sections/notifications';
import { ProPlan } from './sections/plan';
import {
  ContactDetails,
  Devices,
  EmailMoveNotice,
  PendingRecovery,
  RecoveryEmailCard,
} from './sections/security';

export function SettingsView() {
  return (
    <div className="settings-grid">
      <h1>Settings</h1>
      <PendingRecovery />
      <PageState />
      <ProPlan />
      <PaymentAccountCard />
      <GetPaidCard />
      <HandleChange />
      <CoverSettings />
      <PhotoSettings />
      <TipAmountsSettings />
      <AboutYou />
      <EmailMoveNotice />
      <ContactDetails />
      <NotificationSettings />
      <RecoveryEmailCard />
      <Devices />
      <DeletePage />
    </div>
  );
}
