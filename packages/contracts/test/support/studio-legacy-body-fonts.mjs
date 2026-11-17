/**
 * v1 body fonts that lack some Hausa hooked letters, which became required with the styles. The v1
 * editor still offers them (plan ruling R3), so they stay body fonts with `wordFallback: true`.
 * Remove in PR 4b (Task 13, v1 retired). Shared by the contracts and scripts font tests.
 */
export const LEGACY_BODY_WORD_FALLBACK = [
  'work-sans',
  'nunito',
  'source-serif-4',
];
