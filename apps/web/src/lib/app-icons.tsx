import { HEART_MARK } from '@/lib/wordmark';

/** The home-screen icon files, with the size each is drawn at. The tab icon stays `icon.svg`. */
export const APP_ICON_FILES = {
  '192.png': { size: 192, maskable: false, rounded: true },
  '512-maskable.png': { size: 512, maskable: true, rounded: false },
} as const;
export type AppIconFile = keyof typeof APP_ICON_FILES;

export const isAppIconFile = (file: string): file is AppIconFile =>
  Object.hasOwn(APP_ICON_FILES, file);

const BRAND = '#7A32F9';

/** The heart in white, as a data URI: next/og draws it as an image, transform included. */
const heartSrc = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${HEART_MARK.viewBox}"><path d="${HEART_MARK.d}" transform="${HEART_MARK.transform}" fill="#FFFFFF"/></svg>`,
)}`;

/**
 * The purple tile with the heart, for `next/og`. Depth only here (180 px and up): a soft light
 * from the top and a darker lower edge. Rounded uses the tab icon's corner (28 of 120); full bleed
 * is for iOS (which rounds it) and maskable (the platform crops it). Maskable draws the heart at
 * 90%, so its bounds sit well inside the centre safe circle (40% radius); at full scale they reach
 * about 37%.
 */
export function IconTile({
  size,
  maskable = false,
  rounded = false,
}: {
  size: number;
  maskable?: boolean;
  rounded?: boolean;
}) {
  const heart = Math.round(size * (maskable ? 0.9 : 1));
  return (
    <div
      style={{
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        overflow: 'hidden',
        borderRadius: rounded ? (size * 28) / 120 : 0,
        background: BRAND,
      }}
    >
      <div
        style={{
          // next/og ignores `inset`; the overlay needs its own box.
          position: 'absolute',
          top: 0,
          left: 0,
          width: size,
          height: size,
          display: 'flex',
          backgroundImage:
            'linear-gradient(180deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0) 38%)',
        }}
      />
      <div
        style={{
          // next/og ignores `inset`; the overlay needs its own box.
          position: 'absolute',
          top: 0,
          left: 0,
          width: size,
          height: size,
          display: 'flex',
          backgroundImage:
            'linear-gradient(180deg, rgba(40,8,96,0) 70%, rgba(40,8,96,0.35) 100%)',
        }}
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- next/og draws plain img only */}
      <img src={heartSrc} width={heart} height={heart} alt="" />
    </div>
  );
}
