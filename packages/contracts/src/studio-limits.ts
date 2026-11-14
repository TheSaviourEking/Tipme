/**
 * Page Studio limits (plan 2026-11-12-page-studio, owner ruling 3, approved 14 Nov 2026).
 * Each is one constant, so a change is a one-line edit plus its test. Text limits count code
 * points, so "ẹ" is one character however it is typed.
 */
export const STUDIO_LIMITS = {
  rows: 12,
  blocksPerCell: 3,
  blocks: 40,
  galleryImages: 9,
  /** Photo blocks, gallery photos and photo row backgrounds on one page. */
  pageImages: 24,
  /** Images kept for one page, draft and published together (enforced by Task 7). */
  storedImages: 48,
  videos: 3,
  /** Event items across the page. */
  events: 6,
  /** Service items across the page. */
  services: 12,
  headingText: 80,
  paragraphText: 600,
  /** A paragraph block holds up to this many blank-line breaks (so 4 paragraphs). */
  paragraphBreaks: 3,
  leadText: 200,
  quoteText: 140,
  caption: 80,
  alt: 140,
  serviceName: 40,
  serviceDetail: 60,
  eventTitle: 60,
  eventPlace: 60,
  eventNote: 80,
  videoUrl: 300,
  /** ₦10,000,000, in kobo. */
  priceMaxMinor: 1_000_000_000n,
} as const;

/** The supporter wall block (owner ruling 10) stays refused until Task 13 turns this on. */
export const STUDIO_SUPPORTER_WALL = false as boolean;
