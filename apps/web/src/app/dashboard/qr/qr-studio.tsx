'use client';
import Link from 'next/link';
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  FREE_QR_STYLES,
  type MyProfile,
  type QrArtCatalogue,
  type QrArtItem,
} from '@tipme/contracts';
import { Button } from '@tipme/ui';
import { useRecipient } from '@/components/account/recipient-context';
import { usePaymentMode } from '@/components/payment-mode-context';
import { paymentModeCopy } from '@/lib/payment-mode-copy';
import { drawQrCard } from '@/lib/qr-card';
import { frameCss, QR_STYLES, styleById } from '@/lib/qr-render';
import { track } from '@/lib/analytics';
import { apiFetch } from '@/lib/session-client';
import { artSrc, fetchArt, useArtImage } from '@/lib/qr-art-client';

const noSubscription = () => () => undefined;
const isFree = (id: string) =>
  (FREE_QR_STYLES as readonly string[]).includes(id);

/** Choose a style, then print, show full screen or share the code. */
export function QrStudio() {
  const id = useId();
  const { profile, setProfile } = useRecipient();
  const copy = paymentModeCopy(usePaymentMode());
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
  const pro = profile.plan === 'pro';
  const [designs, setDesigns] = useState<QrArtItem[] | null>(null);
  const [designsFailed, setDesignsFailed] = useState(false);
  // A design a Free page is only looking at: it is never saved, and never printed.
  const [looking, setLooking] = useState<string | null>(null);
  const current = chosen ?? profile.qrStyle;
  const viewing = looking ?? current;
  const isArt = !isFree(viewing);
  // The list may not have loaded yet (or may have failed): the saved design still shows.
  const design: QrArtItem | null = !isArt
    ? null
    : (designs?.find((item) => item.id === viewing) ?? {
        id: viewing as QrArtItem['id'],
        name: viewing.charAt(0).toUpperCase() + viewing.slice(1),
        kind: 'style',
        locked: !pro,
        thumb: '',
        note: null,
      });
  const style = styleById(isFree(current) ? current : 'purple');
  const art = useArtImage(design ? design.id : null, 1024);
  // What the API actually drew wins over what this page last believed about its plan.
  const previewing =
    design !== null && (art.ready ? art.preview : design.locked);
  const preview = useRef<HTMLCanvasElement>(null);
  const big = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [saved, setSaved] = useState('');

  const freeView = design === null;
  useEffect(() => {
    if (!origin || !preview.current) return;
    drawQrCard(preview.current, {
      url,
      label,
      name: profile.displayName,
      style,
      size: 720,
    });
  }, [origin, url, label, profile.displayName, style, freeView]);

  useEffect(() => {
    let live = true;
    void apiFetch<QrArtCatalogue>('/v1/me/qr-art').then((result) => {
      if (!live) return;
      if (result.ok) setDesigns(result.data.items);
      else setDesignsFailed(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const pick = (styleId: string) => {
    if (isFree(styleId) || pro) {
      setLooking(null);
      void choose(styleId);
      return;
    }
    // Said in the always-present status line, so a screen reader hears it too.
    const name =
      designs?.find((item) => item.id === styleId)?.name ?? 'This design';
    setSaved(
      `${name} is a Pro design. This is a preview, and printing needs Pro.`,
    );
    setLooking(styleId);
  };

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
    } else if (result.code === 'QR_DESIGN_PRO_REQUIRED') {
      // The plan changed under an open page: show what is true, as a preview.
      setChosen(null);
      setLooking(styleId);
      setSaved(
        'Saving a Pro design is part of TipMe Pro, and this page is on the Free plan. You can still preview it.',
      );
    } else {
      setChosen(null);
      setSaved('We couldn’t save the style. Please try again.');
    }
  };

  const downloadDesign = async () => {
    if (!design) return;
    const result = await fetchArt(design.id, 1400);
    if ('error' in result) {
      setSaved(result.error);
      return;
    }
    if (result.preview) {
      // The page lost Pro since this screen loaded: nothing real to save.
      setLooking(design.id);
      setSaved(
        'This page is on the Free plan now, so this design is only a preview.',
      );
      return;
    }
    const download = document.createElement('a');
    download.href = URL.createObjectURL(result.blob);
    download.download = `tipme-${profile.handle}-${design.id}.png`;
    download.click();
    track('qr_downloaded', { surface: 'qr' });
    setTimeout(() => URL.revokeObjectURL(download.href), 1000);
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
    if (!stage.current || (design && !art.ready)) return;
    if (!design && big.current)
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
      <p className="tm-hint">{copy.qrHint}</p>
      <div className="qr-studio__layout">
        {freeView ? (
          <canvas
            ref={preview}
            className="qr-preview"
            role="img"
            aria-label={`QR code for ${label}, ${style.name} style`}
          />
        ) : (
          <div className="qr-design">
            <div
              className="qr-design__plate"
              aria-busy={!art.ready && !art.error}
            >
              {art.error ? (
                <div role="alert" className="qr-design__error">
                  <p>{art.error.message}</p>
                  {(art.error.code === 'QR_ART_PHOTO_REQUIRED' ||
                    art.error.code === 'QR_ART_PHOTO_TOO_LARGE') && (
                    <Link href="/dashboard/settings#photo">
                      Change your page photo
                    </Link>
                  )}
                </div>
              ) : (
                <>
                  {/* While the next picture loads, the last one stays; it fades out under the new one. */}
                  {art.previous && (
                    // eslint-disable-next-line @next/next/no-img-element -- a private image from the API
                    <img
                      className="qr-design__image qr-design__image--under"
                      src={art.previous}
                      alt=""
                    />
                  )}
                  {art.url ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a private image from the API
                    <img
                      key={art.version}
                      className={`qr-design__image${art.previous ? ' qr-design__image--fade' : ''}`}
                      src={art.url}
                      onAnimationEnd={art.clearPrevious}
                      alt={
                        art.ready
                          ? previewing
                            ? `Preview of the ${design.name} QR design. It leads to the TipMe home page, not your page.`
                            : `QR code for ${label}, ${design.name} design`
                          : 'The last design, while the next one is drawn'
                      }
                    />
                  ) : (
                    <p className="qr-design__wait">Drawing your design…</p>
                  )}
                </>
              )}
            </div>
            {design.note && !previewing && (
              <p className="tm-hint">{design.note}</p>
            )}
          </div>
        )}
        <div>
          {previewing && design && (
            <div className="qr-locked">
              <h2>{design.name}</h2>
              <p>
                This is a preview of a Pro design. It doesn’t lead to your page
                yet. Upgrade to Pro to print, download or show it.
              </p>
              <Link
                className="tm-button tm-button--primary"
                href="/dashboard/settings#pro"
              >
                Upgrade to use this design
              </Link>
              <Button
                variant="secondary"
                onClick={() => {
                  setLooking(null);
                  setSaved('');
                  // Leaving the locked panel puts focus on the style in use, so it is never lost.
                  requestAnimationFrame(() =>
                    document.getElementById(`${id}-${current}`)?.focus(),
                  );
                }}
              >
                Use a free style instead
              </Button>
            </div>
          )}
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
                  checked={viewing === option.id}
                  onChange={() => pick(option.id)}
                />
                <span
                  className="qr-style__swatch"
                  style={{ background: frameCss(option.frame) }}
                  aria-hidden="true"
                />
                <span>{option.name}</span>
              </label>
            ))}
          </fieldset>
          {designs && (
            <fieldset className="qr-styles qr-designs">
              <legend>Designs</legend>
              {designs.map((option) => (
                <label
                  key={option.id}
                  className="qr-style qr-style--design"
                  htmlFor={`${id}-${option.id}`}
                >
                  <input
                    id={`${id}-${option.id}`}
                    type="radio"
                    name={`${id}-style`}
                    value={option.id}
                    checked={viewing === option.id}
                    onChange={() => pick(option.id)}
                  />
                  {/* eslint-disable-next-line @next/next/no-img-element -- a private image from the API */}
                  <img
                    className="qr-style__thumb"
                    src={artSrc(option.thumb)}
                    alt=""
                    loading="lazy"
                    width={40}
                    height={40}
                  />
                  <span>
                    {option.name}
                    {option.locked && (
                      <small className="qr-style__premium">Pro design</small>
                    )}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {designsFailed && (
            <p role="alert" className="tm-hint">
              The Pro designs couldn’t be loaded, so only your free styles are
              listed. Please reload to try again.
            </p>
          )}
          <p role="status" className="settings-saved">
            {saved}
          </p>
          <p className="qr-link">{label}</p>
          {!previewing && (
            <div className="qr-actions">
              <Link
                className="tm-button tm-button--secondary"
                href="/dashboard/qr/print"
              >
                Print card
              </Link>
              {/* A design is shown from the picture the API drew: until it has, full screen is blank. */}
              <Button
                variant="secondary"
                disabled={design !== null && !art.ready}
                onClick={() => void fullScreen()}
              >
                Show full screen
              </Button>
              <Button
                onClick={() => void (design ? downloadDesign() : share())}
              >
                {design ? 'Download image' : 'Share image'}
              </Button>
            </div>
          )}
        </div>
      </div>
      <div ref={stage} className="qr-stage">
        {design && !previewing && art.ready ? (
          // eslint-disable-next-line @next/next/no-img-element -- a private image from the API
          <img
            className="qr-stage__image"
            src={art.url ?? undefined}
            alt={`QR code for ${label}`}
          />
        ) : (
          <canvas ref={big} role="img" aria-label={`QR code for ${label}`} />
        )}
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
