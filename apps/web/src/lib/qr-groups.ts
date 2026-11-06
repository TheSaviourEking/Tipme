import type { QrArtItem } from '@tipme/contracts';

export type QrDesignGroupId = 'patterns' | 'cards' | 'photo';

export interface QrDesignGroup {
  id: QrDesignGroupId;
  legend: string;
  items: QrArtItem[];
}

const GROUPS: readonly { id: QrDesignGroupId; legend: string; kind: string }[] =
  [
    { id: 'patterns', legend: 'Patterns', kind: 'style' },
    { id: 'cards', legend: 'Cards', kind: 'card' },
    { id: 'photo', legend: 'Photo', kind: 'photo' },
  ];

/**
 * The studio's design lists, by the API's `kind`, each in the API's order. A kind a newer API
 * sends that this page does not know joins Patterns, so no design is ever hidden; empty groups are
 * dropped.
 */
export function groupDesigns(items: readonly QrArtItem[]): QrDesignGroup[] {
  const known = new Set(GROUPS.map((group) => group.kind));
  return GROUPS.map(({ id, legend, kind }) => ({
    id,
    legend,
    items: items.filter((item) =>
      kind === 'style'
        ? item.kind === 'style' || !known.has(item.kind)
        : item.kind === kind,
    ),
  })).filter((group) => group.items.length > 0);
}
