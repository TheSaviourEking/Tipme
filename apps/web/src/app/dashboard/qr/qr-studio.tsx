'use client';
import Link from 'next/link';
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { MyProfile } from '@tipme/contracts';
import { Button } from '@tipme/ui';
import { useRecipient } from '@/components/account/recipient-context';
import { drawQrCard } from '@/lib/qr-card';
import { frameCss, QR_STYLES, styleById } from '@/lib/qr-render';
import { track } from '@/lib/analytics';
import { apiFetch } from '@/lib/session-client';

const noSubscription = () => () => undefined;

/** Choose a style, then print, show full screen or share the code. */
export function QrStudio() {
  const id = useId();
  const { profile, setProfile } = useRecipient();
  const origin = useSyncExternalStore(
    noSubscription,
    () => location.origin,
    () => '',
  );
  const link = `${origin}/@${profile.handle}`;
  // The code carries a QR tag so scans can be counted (PR-009); the printed text stays plain.
  const url = `${link}?src=qr`;
  const label = link.replace(/^https?:\/\//, '');
  // The choice shows at once; the saved profile catches up (and wins back if saving fails).
  const [chosen, setChosen] = useState<string | null>(null);
  const style = styleById(chosen ?? profile.qrStyle);
  const preview = useRef<HTMLCanvasElement>(null);
  const big = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [saved, setSaved] = useState('');

  useEffect(() => {
    if (!origin || !preview.current) return;
    drawQrCard(preview.current, {
      url,
      label,
      name: profile.displayName,
      style,
      size: 720,
    });
  }, [origin, url, label, profile.displayName, style]);

  const choose = async (styleId: string) => {
    setChosen(styleId);
    setSaved('');
    const result = await apiFetch<MyProfile>('/v1/me/profile', {
      method: 'PATCH',
      body: { qrStyle: styleId },
    });
    if (result.ok) {
      setProfile(result.data);
      setSaved('Style saved');
    } else {
      setChosen(null);
      setSaved('We couldn’t save the style. Please try again.');
    }
  };

  const share = async () => {
    const canvas = document.createElement('canvas');
    drawQrCard(canvas, {
      url,
      label,
      name: profile.displayName,
      style,
      size: 1080,
    });
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    if (!blob) return;
    const name = `tipme-${profile.handle}.png`;
    const file = new File([blob], name, { type: 'image/png' });
    if (
      typeof navigator.share === 'function' &&
      navigator.canShare?.({ files: [file] })
    ) {
      try {
        await navigator.share({
          files: [file],
          title: `Tip ${profile.displayName} on TipMe`,
          url: link,
        });
        track('recipient_shared_link', { surface: 'qr' });
      } catch {
        // Closed the share sheet.
      }
      return;
    }
    const download = document.createElement('a');
    download.href = URL.createObjectURL(blob);
    download.download = name;
    download.click();
    track('qr_downloaded', { surface: 'qr' });
    setTimeout(() => URL.revokeObjectURL(download.href), 1000);
  };

  const fullScreen = async () => {
    if (!stage.current || !big.current) return;
    drawQrCard(big.current, {
      url,
      label,
      name: profile.displayName,
      style,
      size: 1200,
    });
    await stage.current.requestFullscreen().catch(() => undefined);
    // Keep the screen on while someone scans, where the browser allows it.
    await (
      navigator as Navigator & {
        wakeLock?: { request(type: 'screen'): Promise<unknown> };
      }
    ).wakeLock
      ?.request('screen')
      .catch(() => undefined);
  };

  return (
    <div className="qr-studio">
      <h1>My QR code</h1>
      <p className="tm-hint">
        Anyone who scans it lands on your page. Test mode.
      </p>
      <div className="qr-studio__layout">
        <canvas
          ref={preview}
          className="qr-preview"
          role="img"
          aria-label={`QR code for ${label}, ${style.name} style`}
        />
        <div>
          <fieldset className="qr-styles">
            <legend>Style</legend>
            {QR_STYLES.map((option) => (
              <label
                key={option.id}
                className="qr-style"
                htmlFor={`${id}-${option.id}`}
              >
                <input
                  id={`${id}-${option.id}`}
                  type="radio"
                  name={`${id}-style`}
                  value={option.id}
                  checked={style.id === option.id}
                  onChange={() => void choose(option.id)}
                />
                <span
                  className="qr-style__swatch"
                  style={{ background: frameCss(option.frame) }}
                  aria-hidden="true"
                />
                <span>
                  {option.name}
                  {option.premium && (
                    <small className="qr-style__premium">
                      Premium · free in preview
                    </small>
                  )}
                </span>
              </label>
            ))}
          </fieldset>
          <p role="status" className="settings-saved">
            {saved}
          </p>
          <p className="qr-link">{label}</p>
          <div className="qr-actions">
            <Link
              className="tm-button tm-button--secondary"
              href="/dashboard/qr/print"
            >
              Print card
            </Link>
            <Button variant="secondary" onClick={() => void fullScreen()}>
              Show full screen
            </Button>
            <Button onClick={() => void share()}>Share image</Button>
          </div>
        </div>
      </div>
      <div ref={stage} className="qr-stage">
        <canvas ref={big} role="img" aria-label={`QR code for ${label}`} />
        <Button
          variant="secondary"
          onClick={() => void document.exitFullscreen().catch(() => undefined)}
        >
          Close
        </Button>
      </div>
    </div>
  );
}
