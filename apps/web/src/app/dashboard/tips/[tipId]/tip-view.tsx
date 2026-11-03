'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { MyTipDetail } from '@tipme/contracts';
import { Notice, Skeleton, Surface } from '@tipme/ui';
import { MessageControls } from '@/components/dashboard/message-controls';
import { usePanel } from '@/components/dashboard/use-panel';
import { usePaymentMode } from '@/components/payment-mode-context';
import { paymentModeCopy } from '@/lib/payment-mode-copy';
import { feeLine } from '@/lib/fee-line';
import { formatNaira } from '@/lib/demo-amount';
import { purposeLabels } from '@/lib/tip-purpose';

const statusText = {
  paid: 'In your balance',
  confirming: 'Being confirmed',
  failed: 'Declined',
  cancelled: 'Expired',
} as const;
const lagos = (iso: string, options: Intl.DateTimeFormatOptions) =>
  new Date(iso).toLocaleString('en-NG', {
    timeZone: 'Africa/Lagos',
    ...options,
  });

export default function TipDetailPage() {
  const { tipId } = useParams<{ tipId: string }>();
  const copy = paymentModeCopy(usePaymentMode());
  // One loader: data, error and reload(). A failed refresh keeps the receipt on screen.
  const {
    data: tip,
    error,
    reload,
  } = usePanel<MyTipDetail>(`/v1/me/tips/${encodeURIComponent(tipId)}`);

  if (error === 'load' && !tip)
    return (
      <Notice tone="error" title="We couldn’t find that tip">
        <Link href="/dashboard/tips">Back to your tips</Link>
      </Notice>
    );
  if (!tip) return <Skeleton label="Loading the tip" />;
  const who = tip.supporterLabel ?? 'A guest';
  const fee = feeLine(
    tip.platformFeeMinor,
    tip.providerFeeMinor,
    tip.grossMinor,
  );
  return (
    <div className="dashboard-section tip-detail">
      <p className="tip-detail__back">
        <Link href="/dashboard/tips">Back to tips</Link>
      </p>
      <Surface material="paper" className="receipt">
        <h1>
          {formatNaira(Number(tip.netMinor))} from{' '}
          {tip.supporterLabel ?? 'a guest'}
        </h1>
        <p className="receipt__when">
          {lagos(tip.at, { dateStyle: 'medium', timeStyle: 'short' })}
        </p>
        {tip.message && (
          <blockquote className="receipt__note">{tip.message}</blockquote>
        )}
        {tip.messageHidden && (
          <p className="receipt__hidden" role="status">
            {tip.messageReported
              ? 'You reported this note. It is hidden, and TipMe is reviewing it.'
              : 'You hid this note.'}
          </p>
        )}
        <dl className="receipt__rows">
          <div className="rrow">
            <dt>{who} tipped</dt>
            <dd>{formatNaira(Number(tip.grossMinor))}</dd>
          </div>
          <div className="rrow">
            {/* One line (PRD v1.1): what came off the tip, labelled by what it was. */}
            <dt>{fee.label}</dt>
            <dd>−{formatNaira(Number(fee.minor))}</dd>
          </div>
          <div className="rrow">
            <dt>You received</dt>
            <dd>{formatNaira(Number(tip.netMinor))}</dd>
          </div>
          {tip.purpose && (
            <div className="rrow">
              <dt>For</dt>
              <dd>{purposeLabels[tip.purpose]}</dd>
            </div>
          )}
          <div className="rrow">
            <dt>Status</dt>
            <dd>{statusText[tip.state]}</dd>
          </div>
          {tip.proof.referenceTail && (
            <div className="rrow">
              <dt>Reference</dt>
              <dd>…{tip.proof.referenceTail}</dd>
            </div>
          )}
        </dl>
        <p className="receipt__fine">
          {tip.proof.verified
            ? `Confirmed by our payment partner${tip.proof.verifiedAt ? ` on ${lagos(tip.proof.verifiedAt, { dateStyle: 'medium', timeStyle: 'short' })}` : ''}. `
            : 'Still being confirmed by our payment partner. It is not in your balance yet. '}
          {copy.tipFeesPrefix} {tip.feePolicyVersion}.
        </p>
        {error === 'refresh' && (
          <p className="receipt__fine">Couldn’t refresh</p>
        )}
      </Surface>
      {tip.message && (
        <MessageControls tipId={tip.tipId} onChanged={() => void reload()} />
      )}
    </div>
  );
}
