'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { MyTipDetail } from '@tipme/contracts';
import { Card, Notice, Skeleton } from '@tipme/ui';
import { MessageControls } from '@/components/dashboard/message-controls';
import { feeLine } from '@/lib/fee-line';
import { naira } from '@/lib/money';
import { purposeLabels } from '@/lib/tip-purpose';
import { apiFetch } from '@/lib/session-client';

export default function TipDetailPage() {
  const { tipId } = useParams<{ tipId: string }>();
  const [tip, setTip] = useState<MyTipDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    void apiFetch<MyTipDetail>(`/v1/me/tips/${encodeURIComponent(tipId)}`).then(
      (result) => {
        if (result.ok) setTip(result.data);
        else setMissing(true);
      },
    );
  }, [tipId, version]);

  if (missing)
    return (
      <Notice tone="error" title="We couldn’t find that tip">
        <Link href="/dashboard/tips">Back to your tips</Link>
      </Notice>
    );
  if (!tip) return <Skeleton label="Loading the tip" />;
  const fee = feeLine(tip.platformFeeMinor, tip.providerFeeMinor);
  return (
    <div className="dashboard-section tip-detail">
      <Link href="/dashboard/tips">← All tips</Link>
      <h1>Tip from {tip.supporterLabel ?? 'a guest'}</h1>
      <p className="tm-hint">
        {new Date(tip.at).toLocaleString('en-NG', {
          dateStyle: 'full',
          timeStyle: 'short',
          timeZone: 'Africa/Lagos',
        })}
      </p>
      {tip.purpose && (
        <p>
          <strong>For:</strong> {purposeLabels[tip.purpose]}
        </p>
      )}
      {tip.message && (
        <>
          <blockquote className="message-preview">{tip.message}</blockquote>
          <MessageControls
            tipId={tip.tipId}
            onChanged={() => setVersion((v) => v + 1)}
          />
        </>
      )}
      {tip.messageHidden && (
        <p className="tm-hint" role="status">
          {tip.messageReported
            ? 'You reported this message. It is hidden, and TipMe is reviewing it.'
            : 'You hid this message.'}
        </p>
      )}
      <Card>
        <dl className="tip-breakdown">
          <div>
            <dt>They tipped</dt>
            <dd>{naira(tip.grossMinor)}</dd>
          </div>
          <div>
            {/* One line (PRD v1.1): what came off the tip, labelled by what it was. */}
            <dt>{fee.label}</dt>
            <dd>−{naira(fee.minor)}</dd>
          </div>
          <div>
            <dt>You received</dt>
            <dd>
              <strong>{naira(tip.netMinor)}</strong>
            </dd>
          </div>
        </dl>
        <p className="tm-hint">
          Test mode · fees from policy {tip.feePolicyVersion}.
        </p>
      </Card>
      <Card className="proof">
        <h2>Proof</h2>
        {tip.proof.verified ? (
          <>
            <p className="proof__ok">✓ Confirmed by the payment provider</p>
            <p>
              {tip.proof.provider === 'mock'
                ? 'Test provider'
                : tip.proof.provider}
              {tip.proof.referenceTail && (
                <> · Reference ending …{tip.proof.referenceTail}</>
              )}
            </p>
            {tip.proof.verifiedAt && (
              <p className="tm-hint">
                Verified{' '}
                {new Date(tip.proof.verifiedAt).toLocaleString('en-NG', {
                  timeZone: 'Africa/Lagos',
                })}
              </p>
            )}
          </>
        ) : (
          <p>
            Still being confirmed by the payment provider. It is not in your
            balance yet.
          </p>
        )}
      </Card>
    </div>
  );
}
