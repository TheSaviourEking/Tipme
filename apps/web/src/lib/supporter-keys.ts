/**
 * "Let {recipient} recognise me next time" (Pro additions, option (a)). One random key per
 * recipient, made only when the supporter ticks the box, kept only in this browser. The server
 * stores a one-way hash of it, never the key. Nothing here is derived from the browser, the
 * device or a card: it is not a fingerprint. Analytics never reads this store.
 */
export const SUPPORTER_KEYS = 'tipme.supporters.v1';
const MAX_HANDLES = 500;
// Far above 500 entries of a 60-character handle and a 43-character key; anything larger is not ours.
const MAX_BYTES = 200_000;
const KEY = /^[A-Za-z0-9_-]{43}$/;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Keys = Record<string, string>;

/** Corrupt, foreign, oversized or unreadable records read as empty; null when storage can't be read. */
function readKeys(storage: StorageLike): Keys | null {
  let raw: string | null;
  try {
    raw = storage.getItem(SUPPORTER_KEYS);
  } catch {
    return null;
  }
  if (!raw || raw.length > MAX_BYTES) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const { v, keys } = parsed as Record<string, unknown>;
    if (v !== 1 || typeof keys !== 'object' || keys === null) return {};
    if (Array.isArray(keys)) return {};
    const entries = Object.entries(keys as Record<string, unknown>);
    if (
      entries.length > MAX_HANDLES ||
      !entries.every(
        ([handle, key]) =>
          handle.length <= 60 && typeof key === 'string' && KEY.test(key),
      )
    )
      return {};
    return Object.fromEntries(entries) as Keys;
  } catch {
    return {};
  }
}

function writeKeys(storage: StorageLike, keys: Keys): boolean {
  try {
    storage.setItem(SUPPORTER_KEYS, JSON.stringify({ v: 1, keys }));
    return true;
  } catch {
    return false;
  }
}

/** 32 bytes from the platform's secure random source, base64url without padding (43 characters). */
function newKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * The key for this recipient. With `create`, one is made and saved if there is none yet. Null when
 * there is none, or when it could not be saved: a key the browser can't keep is never sent, or
 * every tip would make a new supporter.
 */
export function supporterKeyFor(
  storage: StorageLike | undefined,
  handle: string,
  create: boolean,
): string | null {
  if (!storage) return null;
  const keys = readKeys(storage);
  if (keys === null) return null;
  const name = handle.toLowerCase();
  const known = keys[name];
  if (known) return known;
  if (!create) return null;
  const key = newKey();
  const all = Object.entries(keys);
  // Newest last; past the cap the oldest go first.
  const kept = all.slice(Math.max(0, all.length - (MAX_HANDLES - 1)));
  return writeKeys(storage, { ...Object.fromEntries(kept), [name]: key })
    ? key
    : null;
}

/** After "Stop {name} recognising me": this recipient's key is gone, so the next tip starts afresh. */
export function dropSupporterKey(
  storage: StorageLike | undefined,
  handle: string,
): void {
  if (!storage) return;
  const keys = readKeys(storage);
  if (!keys) return;
  const name = handle.toLowerCase();
  if (!(name in keys)) return;
  delete keys[name];
  writeKeys(storage, keys);
}

/** "Forget my tips and keys on this phone": only the browser's copy. */
export function forgetSupporterKeys(storage: StorageLike | undefined): void {
  try {
    storage?.removeItem(SUPPORTER_KEYS);
  } catch {
    // Nothing to forget if storage is unavailable.
  }
}
