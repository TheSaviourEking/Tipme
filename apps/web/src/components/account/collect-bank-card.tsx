'use client';
import { useEffect, useState } from 'react';
import type { CollectStatusView, PayoutBank } from '@tipme/contracts';
import { Button, Card } from '@tipme/ui';
import { CollectBankForm } from '@/app/dashboard/withdraw/collect-bank-form';
import { apiFetch } from '@/lib/session-client';

/**
 * Get paid for a recipient on You collect (plan Task 14, review I2): their bank goes through our
 * payment partner's name check and an email code, never today's form (the API refuses that one for
 * them). Before verification it is the add form; once verified, their bank and Change, which adds
 * another under the same locked name (a different name is `NAME_LOCKED`, in the server's words).
 * Keeps the #get-paid id that Withdraw and the payout emails link to.
 */
export function CollectBankCard({
  collect,
  reload,
}: {
  collect: CollectStatusView;
  reload: () => Promise<void>;
}) {
  const [banks, setBanks] = useState<PayoutBank[] | null>(null);
  const [changing, setChanging] = useState(false);
  useEffect(() => {
    let current = true;
    void apiFetch<PayoutBank[]>('/v1/payout-banks').then((result) => {
      if (current && result.ok) setBanks(result.data);
    });
    return () => {
      current = false;
    };
  }, []);
  // As GetPaidCard: this card draws after the browser looked for the anchor.
  useEffect(() => {
    if (location.hash === '#get-paid')
      document.getElementById('get-paid')?.scrollIntoView();
  }, []);

  const { bank } = collect;
  const settled = collect.verified && bank?.state === 'verified' ? bank : null;
  return (
    <Card id="get-paid" className="settings-section">
      <h3>Get paid</h3>
      <p className="tm-hint">The bank account your withdrawals go to.</p>
      {settled && !changing && (
        <>
          <p role="status">
            {settled.bankName} ••{settled.last4}
          </p>
          <Button variant="secondary" onClick={() => setChanging(true)}>
            Change bank account
          </Button>
        </>
      )}
      {settled && changing && (
        <>
          <CollectBankForm
            bank={null}
            read={collect}
            banks={banks}
            title="Change bank account"
            onCheckAgain={reload}
            onAdded={() => {
              setChanging(false);
              void reload();
            }}
          />
          <Button variant="secondary" onClick={() => setChanging(false)}>
            Keep my current account
          </Button>
        </>
      )}
      {!settled && (
        <CollectBankForm
          bank={bank}
          read={collect}
          banks={banks}
          onCheckAgain={reload}
          onAdded={() => void reload()}
        />
      )}
    </Card>
  );
}
