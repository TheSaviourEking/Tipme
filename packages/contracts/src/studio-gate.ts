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
    blocks: doc.blocks.filter((b) => !isPro(b)),
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
 * Why a draft save is refused for this plan, or null when it saves (§11, ruling R4). Pro saves
 * anything the schema takes. Free is refused, with 403 `STUDIO_PRO_REQUIRED`, only for a Pro
 * style, the photo accent or a Pro block that neither the stored draft nor the published version
 * holds. So a lapsed Pro draft can still be reordered, have its words edited, lose blocks, and
 * undo back to what it held; it cannot gain anything Pro.
 */
export function studioDraftRefusal(
  next: StudioDocument,
  held: { draft: StudioDocument | null; published: StudioDocument | null },
  plan: Plan,
): 'STUDIO_PRO_REQUIRED' | null {
  if (plan === 'pro') return null;
  const versions = [held.draft, held.published].filter(
    (d): d is StudioDocument => d !== null,
  );
  if (
    STUDIO_STYLES[next.style].plan === 'pro' &&
    !versions.some((d) => d.style === next.style)
  )
    return 'STUDIO_PRO_REQUIRED';
  if (next.accent === 'photo' && !versions.some((d) => d.accent === 'photo'))
    return 'STUDIO_PRO_REQUIRED';
  for (const block of next.blocks.filter(isPro))
    if (!versions.some((d) => d.blocks.some((h) => covers(h, block))))
      return 'STUDIO_PRO_REQUIRED';
  return null;
}
