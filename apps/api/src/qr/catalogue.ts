// The Pro QR designs (design spec section 7). Ids are what a page stores as its `qrStyle`, so they
// are short lowercase words. The Lagoon card is `lagooncard` because `lagoon` is the gradient style.
export type QrArtKind = 'style' | 'card' | 'photo';

export const QR_ART = [
  { id: 'heart', name: 'Heart modules', kind: 'style' },
  { id: 'jewel', name: 'Jewel', kind: 'style' },
  { id: 'stitch', name: 'Cross-stitch', kind: 'style' },
  { id: 'keys', name: 'Raised keys', kind: 'style' },
  { id: 'petals', name: 'Petals', kind: 'style' },
  { id: 'chips', name: 'Stone chips', kind: 'style' },
  { id: 'coin', name: 'Coin', kind: 'style' },
  { id: 'heartshape', name: 'Heart shape', kind: 'style' },
  { id: 'liquid', name: 'Liquid', kind: 'style' },
  { id: 'pillars', name: 'Pillars', kind: 'style' },
  { id: 'diamond', name: 'Diamond', kind: 'style' },
  { id: 'sparkle', name: 'Sparkle', kind: 'style' },
  { id: 'circles', name: 'Circles', kind: 'style' },
  { id: 'leaf', name: 'Leaf', kind: 'style' },
  { id: 'dusk', name: 'Dusk gradient', kind: 'style' },
  { id: 'lagoon', name: 'Lagoon gradient', kind: 'style' },
  { id: 'naira', name: 'Naira centre', kind: 'style' },
  { id: 'mosaic', name: 'Photo mosaic', kind: 'photo' },
  { id: 'indigo', name: 'Indigo Grid', kind: 'card' },
  { id: 'woven', name: 'Woven Strips', kind: 'card' },
  { id: 'danfo', name: 'Danfo', kind: 'card' },
  { id: 'harmattan', name: 'Harmattan', kind: 'card' },
  { id: 'lagooncard', name: 'Lagoon', kind: 'card' },
  { id: 'citylights', name: 'City Lights', kind: 'card' },
  { id: 'vinyl', name: 'Vinyl', kind: 'card' },
  { id: 'sunburst', name: 'Sunburst', kind: 'card' },
  { id: 'engraved', name: 'Engraved', kind: 'card' },
  { id: 'contour', name: 'Contour', kind: 'card' },
  { id: 'geometry', name: 'Geometry', kind: 'card' },
  { id: 'paper', name: 'Paper Hearts', kind: 'card' },
] as const satisfies readonly { id: string; name: string; kind: QrArtKind }[];

export type QrArtId = (typeof QR_ART)[number]['id'];
