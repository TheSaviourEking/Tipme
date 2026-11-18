'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DESIGN_CHECK_VERSION_V1,
  STUDIO_SPACING,
  deriveStudioPalette,
  resolveCover,
  studioTypeScale,
  type MyProfile,
  type PublicProfile,
  type PublicStudioV1,
  type StudioDocumentV1,
  type StudioImage,
} from '@tipme/contracts';
import { ProBadge } from '@tipme/ui';
import { AvatarImage } from '@/components/avatar';
import { ProfileCover } from '@/components/profile/cover';
import { StudioPage } from '@/components/studio/studio-page';
import { apiUrl } from '@/lib/session-client';
import { amountOptions } from '@/lib/tip-amounts';
import { Money } from '@/components/money';

export type PreviewDevice = 'phone' | 'desktop';

/** The widths the preview draws the page at (board: "Preview · desktop, 1280 px"). */
export const PREVIEW_WIDTH: Record<PreviewDevice, number> = {
  phone: 390,
  desktop: 1280,
};

/** A part of the page that is always TipMe's (board: the dashed outline and its label). */
function Locked({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="pst-locked">
      <span className="pst-locked__chip">{label}</span>
      {children}
    </div>
  );
}

/**
 * The page as supporters will see it, drawn by the real renderer (StudioPage) from the draft being
 * edited, around stand-ins for TipMe's own parts: the identity, tip block and footer, which no
 * design can move or style. It is a picture: nothing in it can be focused or pressed.
 *
 * The renderer's layout follows the screen's width (studio.css media queries). The preview pins it
 * to the chosen device instead: the desktop page is drawn 1280 px wide and scaled to fit; the
 * phone page is drawn 390 px wide, with the phone layout and phone sizes kept even on a wide screen
 * (studio-editor.css, and the sizes below).
 */
export function StudioPreview({
  draft,
  images,
  profile,
  device,
  grid = false,
  outlineRow = -1,
}: {
  draft: StudioDocumentV1;
  images: StudioImage[];
  profile: MyProfile;
  device: PreviewDevice;
  /** "Show grid": the 12 columns the rows sit on. */
  grid?: boolean;
  /** The row open in the Blocks tab (its index), outlined; -1 for none. */
  outlineRow?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<number>(PREVIEW_WIDTH[device]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setRoom(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const width = PREVIEW_WIDTH[device];
  const zoom = Math.min(1, room / width);
  const palette = useMemo(
    () => deriveStudioPalette(draft.brand),
    [draft.brand],
  );
  const studio: PublicStudioV1 = {
    document: draft,
    palette,
    images: Object.fromEntries(
      images.map((i) => [
        i.imageId,
        { path: apiUrl(i.path), width: i.width, height: i.height },
      ]),
    ),
    checkVersion: DESIGN_CHECK_VERSION_V1,
  };
  const shown: PublicProfile = {
    handle: profile.handle,
    displayName: profile.displayName,
    plan: 'pro',
    ...(profile.bioPublic && profile.bio ? { bio: profile.bio } : {}),
    ...(profile.links ? { links: profile.links } : {}),
  };
  const firstName = profile.displayName.split(/\s+/)[0] ?? profile.displayName;
  const cover =
    profile.cover ??
    resolveCover({
      handle: profile.handle,
      coverPath: null,
      coverDesign: null,
      coverColour: null,
    });
  const amounts = amountOptions(profile.tipAmounts);
  // Phone sizes on any screen: each clamp() at its 320 px end.
  const scale = studioTypeScale(draft.scale);
  const phoneSizes =
    device === 'phone'
      ? `.pst-preview__page[data-device='phone'] .studio {${Object.entries(
          scale,
        )
          .map(
            ([role, size]) =>
              `--studio-size-${role}: ${size.min}px !important;`,
          )
          .join(' ')} ${Object.entries(STUDIO_SPACING)
          .map(([step, s]) => `--studio-space-${step}: ${s.min}px !important;`)
          .join(' ')}}`
      : '';
  return (
    <div ref={box} className="pst-preview__room">
      {phoneSizes && <style>{phoneSizes}</style>}
      {outlineRow >= 0 && (
        <style>{`.pst-preview__page .studio-rows > .studio-row:nth-child(${outlineRow + 1}) { outline: 2px solid var(--brand-primary); outline-offset: 2px; }`}</style>
      )}
      <div
        className="pst-preview__page"
        data-device={device}
        data-grid={grid || undefined}
        inert
        style={{ width, zoom }}
      >
        <StudioPage
          studio={studio}
          profile={shown}
          cover={<ProfileCover cover={cover} sizes="640px" />}
          identity={
            <Locked label="Always TipMe: name, photo, @username, badge">
              <div className="pst-id">
                <AvatarImage
                  className="pst-id__photo"
                  src={profile.avatarPath ?? ''}
                  name={profile.displayName}
                  width={96}
                  height={96}
                  sizes="96px"
                />
                <div>
                  <p className="pst-id__name">{profile.displayName}</p>
                  <p className="pst-id__handle">
                    @{profile.handle} <ProBadge />
                  </p>
                </div>
              </div>
            </Locked>
          }
          tipBlock={
            <Locked label="Always TipMe">
              <div className="pst-tip">
                <p className="pst-tip__title">Tip {firstName}</p>
                <ul className="pst-tip__amounts">
                  {amounts.presets.map((p) => (
                    <li
                      key={p.minor}
                      data-on={p.minor === amounts.defaultMinor || undefined}
                    >
                      <Money minor={p.minor} />
                    </li>
                  ))}
                </ul>
                {amounts.defaultMinor !== null && (
                  <p className="pst-tip__go">
                    Tip <Money minor={amounts.defaultMinor} />
                  </p>
                )}
                <p className="pst-tip__fee">Fees are shown before you pay.</p>
              </div>
            </Locked>
          }
          footer={
            <p className="pst-foot">Report this page · Privacy · Terms</p>
          }
        />
      </div>
    </div>
  );
}
