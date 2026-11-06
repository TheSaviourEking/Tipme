// Repeat supporters (Pro additions, the owner's decision of 5 Nov 2026, option (a)). A supporter
// may choose, on the tip form, to let a Pro recipient recognise them next time. Their browser
// keeps a random key for that one recipient; the server keeps only its SHA-256. It is never a
// card, IP, device or browser fingerprint, and keys are per recipient, so stored data cannot
// link one supporter's tips across different recipients.

/** 32 random bytes, base64url without padding: 43 characters. */
export const SUPPORTER_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** One opted-in supporter, as their Pro recipient sees them (PR 4). Never the key or its hash. */
export interface MySupporter {
  /** The supporters row id: opaque. */
  id: string;
  /** The name they typed most recently with this key. */
  name: string;
  /** Paid tips only. */
  tips: number;
  /** The sum of what the Tips list shows for each tip (recipient net), kobo as a string. */
  totalNetMinor: string;
  lastAt: string;
  /** tips >= 2 */
  returning: boolean;
}

export interface MySupporterNote {
  tipId: string;
  body: string;
  at: string;
}
