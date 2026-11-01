'use client';
import Link from 'next/link';
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { FREE_QR_STYLES } from '@tipme/contracts';
import { Button } from '@tipme/ui';
import { useRecipient } from '@/components/account/recipient-context';
import { drawQrCard } from '@/lib/qr-card';
import { track } from '@/lib/analytics';
import { styleById } from '@/lib/qr-render';
import { useArtImage } from '@/lib/qr-art-client';
import { QR_FORMATS, QrFormat, type QrFormatId } from '../formats/formats';

const noSubscription = () => () => undefined;

/** A printable A6 table card, or a Pro design in one of the formats (print stylesheet hides everything else). */
export default function PrintCardPage() {
  const { profile } = useRecipient();
  const id = useId();
  const origin = useSyncExternalStore(
    noSubscription,
    () => location.origin,
    () => '',
  );
  const link = `${origin}/@${profile.handle}`;
  // The code carries a QR tag so scans can be counted (PR-009); the printed text stays plain.
  const url = `${link}?src=qr`;
  const label = link.replace(/^https?:\/\//, '');
  const canvas = useRef<HTMLCanvasElement>(null);
  // The server only sends a real code to a Pro page, and the saved style is `purple` once a page
  // leaves Pro, so a Pro design here always belongs to a Pro page.
  const proDesign =
    profile.plan === 'pro' &&
    !(FREE_QR_STYLES as readonly string[]).includes(profile.qrStyle);
  const [format, setFormat] = useState<QrFormatId>('counter');
  const art = useArtImage(proDesign ? profile.qrStyle : null, 1400);
  useEffect(() => {
    if (!proDesign && origin && canvas.current)
      drawQrCard(canvas.current, {
        url,
        label,
        name: profile.displayName,
        style: styleById(profile.qrStyle),
        size: 1240,
      });
  }, [proDesign, origin, url, label, profile.displayName, profile.qrStyle]);
  const print = () => {
    track('qr_printed', { surface: 'qr' });
    window.print();
  };
  return (
    <div className="print-card">
      <h1 className="print-hide">Print your card</h1>
      {proDesign && art.ready && art.preview ? (
        // The page was moved to Free after this screen loaded: the server drew a marked preview.
        <div className="print-hide qr-locked" role="alert">
          <p>
            This page is on the Free plan now, so this design is only a preview
            that leads to the TipMe home page. It can’t be printed.
          </p>
          <Link
            className="tm-button tm-button--primary"
            href="/dashboard/settings#pro"
          >
            See what Pro includes
          </Link>
        </div>
      ) : proDesign ? (
        <>
          <p className="print-hide tm-hint">
            Choose a format, then print. The code is the same in each one, and
            it leads to your page.
          </p>
          <fieldset className="print-hide qr-formats">
            <legend>Format</legend>
            {QR_FORMATS.map((option) => (
              <label key={option.id} className="qr-style">
                <input
                  type="radio"
                  name={`${id}-format`}
                  value={option.id}
                  checked={format === option.id}
                  onChange={() => setFormat(option.id)}
                />
                <span>
                  {option.name}
                  <small className="qr-style__premium">{option.size}</small>
                </span>
              </label>
            ))}
          </fieldset>
          {art.error ? (
            <div role="alert">
              <p>{art.error.message}</p>
              {(art.error.code === 'QR_ART_PHOTO_REQUIRED' ||
                art.error.code === 'QR_ART_PHOTO_TOO_LARGE') && (
                <Link href="/dashboard/settings#photo">
                  Change your page photo
                </Link>
              )}
            </div>
          ) : art.ready && art.url ? (
            <QrFormat
              format={format}
              src={art.url}
              name={profile.displayName}
              role={profile.role}
              label={label}
            />
          ) : (
            <p className="print-hide">Drawing your design…</p>
          )}
        </>
      ) : (
        <>
          <p className="print-hide tm-hint">
            Prints on A6 (postcard size). Cut along the edge and stand it on the
            counter.
          </p>
          <canvas
            ref={canvas}
            className="print-card__canvas"
            role="img"
            aria-label={`QR code for ${label}`}
          />
          <p className="print-card__label">{label}</p>
        </>
      )}
      <div className="print-hide qr-actions">
        <Button
          onClick={print}
          disabled={proDesign && !(art.ready && !art.preview)}
        >
          Print
        </Button>
        <Link className="tm-button tm-button--secondary" href="/dashboard/qr">
          Back
        </Link>
      </div>
    </div>
  );
}
