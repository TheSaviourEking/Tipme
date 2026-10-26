'use client';
import Link from 'next/link';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Button } from '@tipme/ui';
import { useRecipient } from '@/components/account/recipient-context';
import { drawQrCard } from '@/lib/qr-card';
import { track } from '@/lib/analytics';
import { styleById } from '@/lib/qr-render';

const noSubscription = () => () => undefined;

/** A printable A6 table card (print stylesheet hides everything else). */
export default function PrintCardPage() {
  const { profile } = useRecipient();
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
  useEffect(() => {
    if (origin && canvas.current)
      drawQrCard(canvas.current, {
        url,
        label,
        name: profile.displayName,
        style: styleById(profile.qrStyle),
        size: 1240,
      });
  }, [origin, url, label, profile.displayName, profile.qrStyle]);
  return (
    <div className="print-card">
      <h1 className="print-hide">Print your card</h1>
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
      <div className="print-hide qr-actions">
        <Button
          onClick={() => {
            track('qr_printed', { surface: 'qr' });
            window.print();
          }}
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
