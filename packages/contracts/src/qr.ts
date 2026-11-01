import { z } from 'zod';
import type { PagePlan } from './profiles.js';

// QR styles a page can save as its `qrStyle`. The three Free styles are drawn in the browser; the
// Pro designs are drawn only by the server (design spec section 7), so the web app holds their
// ids and nothing about how they look. `sunset`, `glow` and `stripe` are retired: they are not
// accepted any more, and a page still holding one shows `purple`.
export const FREE_QR_STYLES = ['purple', 'night', 'clean'] as const;
export const PRO_QR_STYLES = [
  'heart',
  'jewel',
  'stitch',
  'keys',
  'petals',
  'chips',
  'coin',
  'heartshape',
  'liquid',
  'pillars',
  'diamond',
  'sparkle',
  'circles',
  'leaf',
  'dusk',
  'lagoon',
  'naira',
  'mosaic',
  'indigo',
  'woven',
  'danfo',
  'harmattan',
  'lagooncard',
  'citylights',
  'vinyl',
  'sunburst',
  'engraved',
  'contour',
  'geometry',
  'paper',
] as const;
export type FreeQrStyle = (typeof FREE_QR_STYLES)[number];
export type ProQrStyle = (typeof PRO_QR_STYLES)[number];

export const qrStyleSchema = z.enum([...FREE_QR_STYLES, ...PRO_QR_STYLES]);

export const isProQrStyle = (id: string): id is ProQrStyle =>
  (PRO_QR_STYLES as readonly string[]).includes(id);

/**
 * The style a page shows. A retired style, or a Pro design on a page that is no longer Pro, shows
 * `purple`; nothing is deleted, so a page that returns to Pro gets its design back.
 */
export function shownQrStyle(stored: string, plan: PagePlan | undefined) {
  if ((FREE_QR_STYLES as readonly string[]).includes(stored))
    return stored as FreeQrStyle;
  return plan === 'pro' && isProQrStyle(stored) ? stored : 'purple';
}

/** Image sizes the art route draws, in pixels: a fixed list, so a request cannot ask for a huge one. */
export const QR_ART_SIZES = [512, 1024, 1400] as const;
/** The small picture in the design list, which has its own routes and limits. */
export const QR_ART_THUMB_SIZE = 256;
export type QrArtSize = (typeof QR_ART_SIZES)[number];

export interface QrArtItem {
  id: ProQrStyle;
  name: string;
  kind: 'style' | 'card' | 'photo';
  /** True on a Free page: the image is a marked preview that leads to the TipMe home page. */
  locked: boolean;
  /** Where the list picture is: shared and public for a Free page, the page's own for a Pro one. */
  thumb: string;
  /** Plain words about this design for this page's link, or null. Never set on a preview. */
  note: string | null;
}
export interface QrArtCatalogue {
  items: QrArtItem[];
}
