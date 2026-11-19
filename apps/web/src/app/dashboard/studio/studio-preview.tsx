'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  MyProfile,
  PhotoAccentFailed,
  PhotoAccentValues,
  PublicProfile,
  StudioDocument,
  StudioImage,
} from '@tipme/contracts';
import { usePaymentMode } from '@/components/payment-mode-context';
import { apiUrl } from '@/lib/session-client';
import {
  PREVIEW_READY,
  PREVIEW_SHOW,
  isPreviewMessage,
  type PreviewMessage,
  type PreviewPayload,
} from '../../studio-preview/preview-message';

export type PreviewDevice = 'phone' | 'desktop';

/** The page sizes the preview draws (CSS px), before it is scaled into its frame. */
export const PREVIEW_PAGE: Record<PreviewDevice, { w: number; h: number }> = {
  phone: { w: 390, h: 650 },
  desktop: { w: 1280, h: 800 },
};

/**
 * The live preview (styles spec §10.1): the person's real page, drawn by the real renderer in its
 * own document (/studio-preview, in a frame) from the draft being edited, so each style's layout
 * follows the preview's width and only that style's sheet and fonts load. `frame` is the canvas's
 * size: 'small' is the phone tab's 174 × 290 phone (r22, padding 6), 'phone' the desktop's
 * 312 × 520 (r40, padding 10), 'desktop' a 1280 px page scaled to the room it has.
 */
export function StudioPreview({
  draft,
  images,
  profile,
  photoAccent,
  frame,
}: {
  draft: StudioDocument;
  images: StudioImage[];
  profile: MyProfile;
  photoAccent: PhotoAccentValues | PhotoAccentFailed | null;
  frame: 'small' | 'phone' | 'desktop';
}) {
  const paymentMode = usePaymentMode();
  const iframe = useRef<HTMLIFrameElement>(null);
  const room = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const page = PREVIEW_PAGE[frame === 'desktop' ? 'desktop' : 'phone'];
  const shownWidth = frame === 'small' ? 174 : frame === 'phone' ? 312 : width;
  const scale = shownWidth > 0 ? shownWidth / page.w : 0;

  useEffect(() => {
    if (frame !== 'desktop') return;
    const el = room.current;
    if (!el) return;
    const measure = () => setWidth(Math.min(el.clientWidth, page.w));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [frame, page.w]);

  const payload = useMemo<PreviewPayload>(() => {
    const shown: PublicProfile = {
      handle: profile.handle,
      displayName: profile.displayName,
      plan: profile.plan ?? 'free',
      acceptingTips: true,
      ...(profile.role ? { role: profile.role } : {}),
      ...(profile.avatarPath ? { avatarPath: profile.avatarPath } : {}),
      ...(profile.bioPublic && profile.bio ? { bio: profile.bio } : {}),
      ...(profile.links ? { links: profile.links } : {}),
      ...(profile.cover ? { cover: profile.cover } : {}),
      ...(profile.tipAmounts ? { tipAmounts: profile.tipAmounts } : {}),
    };
    return {
      document: draft,
      profile: shown,
      images: Object.fromEntries(
        images.map((i) => [
          i.imageId,
          { path: apiUrl(i.path), width: i.width, height: i.height },
        ]),
      ),
      photoAccent,
      paymentMode,
    };
  }, [draft, images, profile, photoAccent, paymentMode]);

  // The frame says when it is ready; every change after that is posted as it happens.
  const latest = useRef(payload);
  useEffect(() => {
    latest.current = payload;
    const target = iframe.current?.contentWindow;
    target?.postMessage(
      { type: PREVIEW_SHOW, payload } satisfies PreviewMessage,
      window.location.origin,
    );
  }, [payload]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const target = iframe.current?.contentWindow;
      if (
        !target ||
        event.source !== target ||
        event.origin !== window.location.origin ||
        !isPreviewMessage(event.data) ||
        event.data.type !== PREVIEW_READY
      )
        return;
      target.postMessage(
        {
          type: PREVIEW_SHOW,
          payload: latest.current,
        } satisfies PreviewMessage,
        window.location.origin,
      );
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <div
      ref={room}
      className="pst-frame"
      data-frame={frame}
      style={{ ['--pst-scale' as string]: String(scale) }}
    >
      {/* The frame is a picture of the page: hidden from screen readers, which read this instead. */}
      <p className="sr-only">Preview of your page</p>
      <div
        className="pst-frame__screen"
        style={{
          width: shownWidth || undefined,
          height: scale ? page.h * scale : undefined,
        }}
      >
        <iframe
          ref={iframe}
          className="pst-frame__page"
          src="/studio-preview"
          title="Preview of your page"
          aria-hidden="true"
          tabIndex={-1}
          width={page.w}
          height={page.h}
          style={{ transform: `scale(${scale})` }}
        />
      </div>
    </div>
  );
}
