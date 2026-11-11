'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import {
  CAMPAIGN_NAME_MAX,
  FREE_QR_STYLES,
  type CampaignDetail,
} from '@tipme/contracts';
import { Button, Card, InputField, Notice, Skeleton } from '@tipme/ui';
import { BarChart } from '@/components/dashboard/bar-chart';
import { usePanel } from '@/components/dashboard/use-panel';
import { track } from '@/lib/analytics';
import { interfaceFont } from '@/lib/brand-font';
import { campaignLink } from '@/lib/campaign-link';
import { naira } from '@/lib/money';
import { drawQrCard } from '@/lib/qr-card';
import { styleById } from '@/lib/qr-render';
import { apiFetch } from '@/lib/session-client';
import { madeOn, useOrigin } from '../campaigns-view';

/** The campaign's QR: the same card, looks and download as My QR, holding the campaign link. */
function CampaignQr({ detail }: { detail: CampaignDetail }) {
  const origin = useOrigin();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [look, setLook] = useState<string>('purple');
  const [font, setFont] = useState<string | undefined | null>(null);
  const link = origin ? campaignLink(origin, detail.handle, detail.slug) : null;
  const qr = link?.qr;
  const label = link?.label;
  useEffect(() => {
    let live = true;
    void interfaceFont().then((family) => live && setFont(family));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!qr || !label || !canvas.current || font === null) return;
    drawQrCard(canvas.current, {
      url: qr,
      label,
      name: detail.displayName,
      style: styleById(look),
      size: 720,
      ...(font ? { fontFamily: font } : {}),
    });
  }, [qr, label, detail.displayName, look, font]);
  const download = () => {
    if (!link || !canvas.current) return;
    const big = document.createElement('canvas');
    drawQrCard(big, {
      url: link.qr,
      label: link.label,
      name: detail.displayName,
      style: styleById(look),
      size: 2048,
      ...(font ? { fontFamily: font } : {}),
    });
    big.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `tipme-${detail.handle}-${detail.slug}.png`;
      a.click();
      track('qr_downloaded', { surface: 'qr' });
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/png');
  };
  return (
    <div className="campaign-qr">
      <canvas
        ref={canvas}
        className="campaign-qr__card"
        role="img"
        aria-label={`QR code for ${link?.label ?? 'this campaign'}`}
      />
      <fieldset className="campaign-qr__looks">
        <legend>Look</legend>
        {FREE_QR_STYLES.map((id) => (
          <label key={id} className="campaign-qr__look">
            <input
              type="radio"
              name="campaign-look"
              value={id}
              checked={look === id}
              onChange={() => setLook(id)}
            />
            {styleById(id).name}
          </label>
        ))}
      </fieldset>
      <Button variant="continue" onClick={download}>
        Download
      </Button>
      <p className="tm-hint">
        The same looks and downloads as <Link href="/dashboard/qr">My QR</Link>.
        The code holds the campaign link.
      </p>
    </div>
  );
}

export default function CampaignPage() {
  const id = useId();
  const { id: campaignId } = useParams<{ id: string }>();
  const origin = useOrigin();
  const panel = usePanel<CampaignDetail>(
    `/v1/me/campaigns/${encodeURIComponent(campaignId)}`,
    { live: ['tips.changed'] },
  );
  const [status, setStatus] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const detail = panel.data;
  if (panel.error === 'load' && !detail)
    return (
      <Notice tone="error" title="We couldn’t find that campaign">
        <Link href="/dashboard/campaigns">Back to your campaigns</Link>
      </Notice>
    );
  if (!detail) return <Skeleton label="Loading the campaign" />;
  const link = origin ? campaignLink(origin, detail.handle, detail.slug) : null;
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setStatus('Link copied');
    } catch {
      setStatus('Couldn’t copy. Select the link and copy it.');
    }
  };
  const share = async () => {
    if (!link) return;
    track('recipient_shared_link', { surface: 'dashboard' });
    if (navigator.share)
      await navigator.share({ url: link.url }).catch(() => undefined);
    else await copy();
  };
  const rename = async () => {
    const result = await apiFetch(`/v1/me/campaigns/${detail.id}`, {
      method: 'PATCH',
      body: { name: name.trim() },
    });
    setStatus(
      result.ok ? 'Renamed' : 'We couldn’t rename it. Please try again.',
    );
    if (result.ok) {
      setRenaming(false);
      await panel.reload();
    }
  };
  const stop = async () => {
    const result = await apiFetch(`/v1/me/campaigns/${detail.id}/stop`, {
      method: 'POST',
    });
    setStatus(
      result.ok
        ? 'Stopped. Its results are kept, and its link opens your page like your usual link.'
        : 'We couldn’t stop it. Please try again.',
    );
    if (result.ok) await panel.reload();
  };
  return (
    <div className="dashboard-section campaign-detail">
      <p className="campaign-crumb">
        <Link href="/dashboard/campaigns">Campaigns</Link> / {detail.name}
      </p>
      <header className="campaign-detail__head">
        <div>
          <h1>{detail.name}</h1>
          <p className="campaign-detail__link">
            {link?.label ?? `/@${detail.handle}/${detail.slug}`}
          </p>
          {detail.stoppedAt && (
            <p className="tm-hint">
              Stopped {madeOn(detail.stoppedAt)}. New tips from this link aren’t
              counted here.
            </p>
          )}
        </div>
        <div className="campaign-detail__actions">
          <Button variant="secondary" onClick={() => void copy()}>
            Copy link
          </Button>
          <Button variant="secondary" onClick={() => void share()}>
            Share
          </Button>
        </div>
      </header>
      <p role="status" className="tm-hint">
        {status}
      </p>
      <div className="campaign-detail__grid">
        <section aria-labelledby={`${id}-results`} className="campaign-results">
          <div className="campaign-results__head">
            <h2 id={`${id}-results`}>Results</h2>
            <span className="tm-hint">Since {madeOn(detail.createdAt)}</span>
          </div>
          <dl className="earnings-tiles">
            <div>
              <dt>Visits</dt>
              <dd>{detail.visits ?? 'Not counted yet'}</dd>
              <dd className="tm-hint">
                Times the page was opened from this link or its QR
              </dd>
            </div>
            <div>
              <dt>Tips</dt>
              <dd>{detail.tips ?? 'Fewer than 3'}</dd>
              <dd className="tm-hint">Confirmed tips started from this link</dd>
            </div>
            <div>
              <dt>Received</dt>
              <dd>
                {detail.receivedNetMinor === null
                  ? 'Hidden'
                  : naira(detail.receivedNetMinor)}
              </dd>
              <dd className="tm-hint">After TipMe’s 10%</dd>
            </div>
          </dl>
          <Card>
            <h3 className="earnings-sub">Tips each week</h3>
            <BarChart
              caption={`Tips from ${detail.name} each week`}
              bars={detail.weeks.map((week) => ({
                key: week.from,
                label: madeOn(`${week.from}T12:00:00Z`),
                name: `Week of ${madeOn(`${week.from}T12:00:00Z`)}`,
                value: week.tips ?? 0,
                text:
                  week.tips === null
                    ? 'Fewer than 3'
                    : `${week.tips} ${week.tips === 1 ? 'tip' : 'tips'}`,
              }))}
            />
          </Card>
          <p className="tm-hint">
            Counts only. TipMe doesn’t know who opened the link, and a tip’s
            supporter isn’t shown here. A week with fewer than 3 tips shows
            “Fewer than 3”, so no single supporter can be picked out.
          </p>
          {renaming ? (
            <form
              className="campaign-rename"
              onSubmit={(event) => {
                event.preventDefault();
                void rename();
              }}
            >
              <InputField
                id={`${id}-rename`}
                label="New name"
                maxLength={CAMPAIGN_NAME_MAX}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Button variant="continue" type="submit" disabled={!name.trim()}>
                Save name
              </Button>
              <Button variant="quiet" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            <div className="campaign-detail__actions">
              <Button
                variant="secondary"
                onClick={() => {
                  setName(detail.name);
                  setRenaming(true);
                }}
              >
                Rename
              </Button>
              {!detail.stoppedAt && (
                <Button variant="secondary" onClick={() => void stop()}>
                  Stop this campaign
                </Button>
              )}
            </div>
          )}
        </section>
        <CampaignQr detail={detail} />
      </div>
    </div>
  );
}
