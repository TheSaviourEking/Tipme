'use client';

// Waits this long for the font before a card is drawn in Arial instead: a slow font never holds
// the code back.
const FONT_WAIT_MS = 3000;

let resolved: Promise<string | undefined> | null = null;

/**
 * The page's interface font (`--font-manrope`, set by next/font in the root layout), once the
 * browser has it at the card's boldest weight, for lettering canvas pictures. Undefined when there
 * is no such font or it fails to load in time: the card is then lettered in Arial, as before.
 */
export function interfaceFont(): Promise<string | undefined> {
  resolved ??= load();
  return resolved;
}

async function load(): Promise<string | undefined> {
  if (typeof document === 'undefined' || !document.fonts) return undefined;
  const family = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-manrope')
    .trim();
  if (!family) return undefined;
  try {
    const faces = await Promise.race([
      document.fonts.load(`700 1em ${family}`),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('font timeout')), FONT_WAIT_MS),
      ),
    ]);
    return faces.length > 0 ? family : undefined;
  } catch {
    // Not cached: the next card asks again, in case the font arrives later.
    resolved = null;
    return undefined;
  }
}
