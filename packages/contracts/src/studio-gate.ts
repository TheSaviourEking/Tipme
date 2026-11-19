/**
 * Free and Pro on a Page Studio document (styles spec §11, §12.5). Two pure functions, shared by
 * the API and the web so both make the same call:
 *
 * - `studioShown(doc, plan)`: what the public page shows. A Pro page shows its design. On Free, a
 *   Pro style shows as Classic with the person's own choices wherever Classic has them, and a free
 *   style keeps its style without the photo accent and the Pro blocks. Nothing is deleted: this is
 *   a read. Null means the standard page.
 * - `studioDraftRefusal(next, held, plan)`: whether a Free save adds something Pro. A draft may keep
 *   or restore (undo, ruling R4) any Pro item the stored draft or the published version holds;
 *   only an addition is refused.
 * - `studioKeepHeld(next, held, plan)`: what of `next` such a save may keep. The refusal is defined
 *   by it, so the editor (repairing a refused undo) and the server can't judge "held" differently.
 */
import {
  STUDIO_PRO_BLOCKS,
  isClassicDefault,
  type StudioBlock,
  type StudioDocument,
} from './studio-document.js';
import { STUDIO_STYLES } from './studio-styles.js';

type Plan = 'free' | 'pro';

const isPro = (b: StudioBlock) => STUDIO_PRO_BLOCKS.includes(b.kind);

/**
 * The blocks a Free page shows (§12.5): text and quote, and nothing else. An allowlist, so a kind
 * added later (the supporter wall) stays hidden on Free until it is placed here on purpose.
 */
const FREE_SHOWN: readonly StudioBlock['kind'][] = ['text', 'quote'];

/**
 * What the public page shows for this plan (§12.5), or null for the standard page. Pro: the
 * document. Free with a Pro style: Classic, with their accent (the photo accent becomes Classic's
 * purple), their mode, their cover where Classic offers it, and their text and quote blocks in
 * order. Free with a free style: the same style, the photo accent back to the style's own, the Pro
 * blocks hidden. Whatever is left at Classic's defaults is the standard page (§9.1). When nothing
 * is hidden, the same document comes back.
 */
export function studioShown(
  doc: StudioDocument,
  plan: Plan,
): StudioDocument | null {
  if (isClassicDefault(doc)) return null;
  if (plan === 'pro') return doc;
  const proStyle = STUDIO_STYLES[doc.style].plan === 'pro';
  const style = proStyle ? 'classic' : doc.style;
  const shown: StudioDocument = {
    v: 2,
    style,
    accent: doc.accent === 'photo' ? null : doc.accent,
    mode: doc.mode,
    cover: STUDIO_STYLES[style].covers.includes(doc.cover)
      ? doc.cover
      : 'yours',
    blocks: doc.blocks.filter((b) => FREE_SHOWN.includes(b.kind)),
  };
  if (isClassicDefault(shown)) return null;
  // Nothing hidden: the document itself, so a caller can tell nothing changed.
  const same =
    shown.style === doc.style &&
    shown.accent === doc.accent &&
    shown.cover === doc.cover &&
    shown.blocks.length === doc.blocks.length;
  return same ? doc : shown;
}

/**
 * Whether a held block covers this one: the same id and kind, with nothing added. Words may change
 * (§11: editing text in any block, Pro ones included) and parts may go; a photo, a video link or
 * an item neither version had may not come in.
 */
function covers(held: StudioBlock, next: StudioBlock): boolean {
  if (held.id !== next.id || held.kind !== next.kind) return false;
  switch (next.kind) {
    case 'photo':
      return held.kind === 'photo' && held.imageId === next.imageId;
    case 'gallery': {
      if (held.kind !== 'gallery') return false;
      const had = new Set(held.images.map((i) => i.imageId));
      return next.images.every((i) => had.has(i.imageId));
    }
    case 'video':
      return held.kind === 'video' && held.url === next.url;
    case 'services':
      return held.kind === 'services' && next.items.length <= held.items.length;
    case 'events':
      return held.kind === 'events' && next.items.length <= held.items.length;
    default:
      return true;
  }
}

/**
 * What of `next` a save on this plan may keep (§11, ruling R4): `next` itself when nothing would be
 * refused. On Free, each Pro part neither the stored draft nor the published version holds goes
 * back to what is held: a Pro style to the stored draft's style (or Classic), its cover kept where
 * that style offers it; the photo accent to the stored draft's accent; a Pro block not covered to
 * the held block with its id and kind (the stored draft's first), or out when nothing holds one.
 * Everything else (free blocks, words, order, mode) is kept as it is.
 */
export function studioKeepHeld(
  next: StudioDocument,
  held: { draft: StudioDocument | null; published: StudioDocument | null },
  plan: Plan,
): StudioDocument {
  if (plan === 'pro') return next;
  const versions = [held.draft, held.published].filter(
    (d): d is StudioDocument => d !== null,
  );
  let kept = next;
  if (
    STUDIO_STYLES[next.style].plan === 'pro' &&
    !versions.some((d) => d.style === next.style)
  ) {
    const style = held.draft?.style ?? 'classic';
    kept = {
      ...kept,
      style,
      cover: STUDIO_STYLES[style].covers.includes(kept.cover)
        ? kept.cover
        : 'yours',
    };
  }
  if (next.accent === 'photo' && !versions.some((d) => d.accent === 'photo'))
    kept = { ...kept, accent: held.draft?.accent ?? null };
  let changed = false;
  const blocks: StudioBlock[] = [];
  for (const block of next.blocks) {
    if (
      !isPro(block) ||
      versions.some((d) => d.blocks.some((h) => covers(h, block)))
    ) {
      blocks.push(block);
      continue;
    }
    changed = true;
    const back = versions
      .flatMap((d) => d.blocks)
      .find((h) => h.id === block.id && h.kind === block.kind);
    if (back && !blocks.some((b) => b.id === back.id)) blocks.push(back);
  }
  return changed ? { ...kept, blocks } : kept;
}

/**
 * Why a draft save is refused for this plan, or null when it saves (§11, ruling R4). Pro saves
 * anything the schema takes. Free is refused, with 403 `STUDIO_PRO_REQUIRED`, only for a Pro
 * style, the photo accent or a Pro block that neither the stored draft nor the published version
 * holds (anything `studioKeepHeld` would take back). So a lapsed Pro draft can still be reordered,
 * have its words edited, lose blocks, and undo back to what it held; it cannot gain anything Pro.
 */
export function studioDraftRefusal(
  next: StudioDocument,
  held: { draft: StudioDocument | null; published: StudioDocument | null },
  plan: Plan,
): 'STUDIO_PRO_REQUIRED' | null {
  return studioKeepHeld(next, held, plan) === next
    ? null
    : 'STUDIO_PRO_REQUIRED';
}
