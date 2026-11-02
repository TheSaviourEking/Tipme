import { readFile } from 'node:fs/promises';

// The artwork around each QR card, drawn by `node scripts/design/covers.mjs` into
// apps/api/assets/qr-cards: the web app and the API deploy separately, so the API carries its own
// copy. This file runs from src/qr or dist/qr, and the folder is two levels up from both.
const FOLDER = new URL('../../assets/qr-cards/', import.meta.url);

export type CardCover =
  | 'indigo'
  | 'woven'
  | 'danfo'
  | 'harmattan'
  | 'lagoon'
  | 'citylights'
  | 'vinyl'
  | 'sunburst'
  | 'engraved'
  | 'contour'
  | 'geometry'
  | 'paper';

/** Where the white panel sits on the frame, as parts of its width (the script draws it there). */
export const CARD_PANEL = { at: 0.15, size: 0.7 } as const;

const frames = new Map<CardCover, Promise<Buffer>>();

/** A card's frame as a square WebP, read from disk once per process. */
export function cardFrame(cover: CardCover): Promise<Buffer> {
  let frame = frames.get(cover);
  if (!frame) {
    frame = readFile(new URL(`${cover}.webp`, FOLDER));
    frames.set(cover, frame);
    frame.catch(() => frames.delete(cover));
  }
  return frame;
}
