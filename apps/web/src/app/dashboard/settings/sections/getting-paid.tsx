'use client';
import { Button, Card, Slip } from '@tipme/ui';
import { CollectBankCard } from '@/components/account/collect-bank-card';
import { GetPaidCard } from '@/components/account/get-paid-card';
import { useCollectStatus } from '@/components/dashboard/collect-status';
import { PaymentAccountCard } from '../payment-account-card';
import { SettingsChapter } from './section';

/**
 * Getting paid (ScreenSettings): the payment account, when our payment partner needs one, and the
 * bank account withdrawals go to. Each card keeps its own id (#payments, #get-paid) for old links.
 * A recipient on You collect has no payment account to set up (TipMe takes their tips) and adds
 * their bank through the You collect form (plan Task 14, review I2).
 */
export function GettingPaidSection() {
  const { collect, known, failed, reload } = useCollectStatus();
  return (
    <SettingsChapter id="paid">
      {failed ? (
        <Card id="get-paid" className="settings-section">
          <h3>Get paid</h3>
          <Slip
            tone="error"
            title="Couldn’t load your bank account"
            actions={
              <Button variant="secondary" onClick={() => void reload()}>
                Try again
              </Button>
            }
          >
            Please try again.
          </Slip>
        </Card>
      ) : !known ? (
        <Card id="get-paid" className="settings-section" aria-busy="true">
          <h3>Get paid</h3>
          <p className="tm-hint">Checking your bank account…</p>
        </Card>
      ) : collect ? (
        <CollectBankCard collect={collect} reload={reload} />
      ) : (
        <>
          <PaymentAccountCard />
          <GetPaidCard />
        </>
      )}
    </SettingsChapter>
  );
}
