import { z } from 'zod';
import type { ResolvedCover } from './covers.js';
import { qrStyleSchema } from './qr.js';
import type { SocialLink } from './social-links.js';

/**
 * The three fixed links pages had before the catalogue (5 Nov 2026). Kept as a type only: APIs
 * older than `links` send it, and stale tabs read it from `MyProfile`.
 */
export type Socials = Partial<Record<'facebook' | 'instagram' | 'x', string>>;

const optionalText = (max: number) => z.string().trim().max(max).nullable();

/** What a recipient may change about their page. Every field is optional. */
export const profilePatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(60),
    role: optionalText(60),
    bio: optionalText(280),
    bioPublic: z.boolean(),
    socialsPublic: z.boolean(),
    phonePublic: z.boolean(),
    emailPublic: z.boolean(),
    qrStyle: qrStyleSchema,
  })
  .partial()
  .strict();
export type ProfilePatch = z.infer<typeof profilePatchSchema>;

export const claimHandleSchema = z
  .object({ handle: z.string().min(1).max(40) })
  .strict();
export const pageStateSchema = z
  .object({ state: z.enum(['live', 'not_live']) })
  .strict();
export const deleteAccountSchema = z
  .object({ confirm: z.literal('DELETE') })
  .strict();

export type PageState = 'live' | 'not_live' | 'deleted';
export type HandleStatus = 'available' | 'taken' | 'reserved' | 'invalid';

export interface HandleChanges {
  used: number;
  allowed: number;
}

export interface MyProfile {
  handle: string;
  /**
   * Old handles that still lead to this page (PR-011), oldest first. Optional until the release
   * after PR-011: the web app deploys before the API, so it may talk to an API without it.
   */
  previousHandles?: string[];
  displayName: string;
  role: string | null;
  bio: string | null;
  /** Deprecated: the first Facebook, Instagram and X links, for tabs opened before `links`. */
  socials: Socials;
  /**
   * Every stored link in order, hidden ones included (a lapsed Pro page keeps them). Optional
   * until the release after this one: the web app deploys before the API.
   */
  links?: SocialLink[];
  bioPublic: boolean;
  socialsPublic: boolean;
  phonePublic: boolean;
  emailPublic: boolean;
  pageState: PageState;
  qrStyle: string;
  phone: string | null;
  email: string | null;
  emailVerified: boolean;
  /** TipMe paused the page (PR-009): it cannot go live; the reason is shown to the recipient. */
  suspended: boolean;
  suspendedReason: string | null;
  /** Free or Pro (PR-012). Optional until the release after PR-012 (the web deploys first). */
  plan?: PagePlan;
  /** The page's photo (PR-013): an API path, e.g. /v1/avatars/<page>/<n>.webp. Optional, as `plan`. */
  avatarPath?: string | null;
  /** The amounts the page shows now (the standard ones on Free). Optional, as `plan`. */
  tipAmounts?: TipAmounts;
  /**
   * Handle changes counted so far and allowed in total (Pro pages only can use them). Optional
   * until the release after this one: the web app deploys before the API.
   */
  handleChanges?: HandleChanges;
  /** What the page's cover resolves to now. Optional, as `handleChanges`. */
  cover?: ResolvedCover;
  /** What the owner chose, as opposed to what shows. Optional, as `handleChanges`. */
  coverChoice?: {
    design: string | null;
    colour: string | null;
    hasPhoto: boolean;
  };
}

/** The public page: each detail is present only when the recipient made it public. */
export interface PublicProfile {
  handle: string;
  displayName: string;
  role?: string;
  craft?: string;
  note?: string;
  avatarPath?: string;
  bio?: string;
  /** Sent by APIs older than `links` only. */
  socials?: Socials;
  /** The links this page's plan shows, in order (see `visibleLinks`). */
  links?: SocialLink[];
  phone?: string;
  email?: string;
  /** A moment the recipient chose to share, for 14 days ("add to the celebration"). */
  celebration?: { momentId: string; label: string };
  /** The amounts this page offers (PR-012). Optional until the release after PR-012. */
  tipAmounts?: TipAmounts;
  /**
   * False while the owner hasn't finished setting up the payment account that tips need, so the
   * page says so before a supporter fills in the form. Absent from older APIs: treat as true.
   */
  acceptingTips?: boolean;
  /** The page's cover. Absent from older APIs: the web app deploys first. */
  cover?: ResolvedCover;
  /** Free or Pro, and nothing else about the plan. Pro pages hide TipMe's own invitation. */
  plan?: PagePlan;
  /**
   * Whether this page may take tips at all on this copy right now (closed checkout, or a live copy
   * limited to named pages). Checkout enforces the same rule. Older APIs send nothing.
   */
  tippingOpen?: boolean;
}

/** Changing the page's handle (Pro only, counted); the old one keeps pointing at the page. */
export const renameHandleSchema = claimHandleSchema;

// Free and Pro (PR-012). Free pages show the standard amounts; staff can make a page Pro, and
// a Pro page chooses its own preset amounts and minimum (never below the ₦2,000 floor).
export type PagePlan = 'free' | 'pro';

/** Kobo as strings. Supporters may type any amount from `minMinor` up; there is no maximum. */
export interface TipAmounts {
  presetsMinor: string[];
  minMinor: string;
}

const kobo = z.string().regex(/^\d{1,12}$/);
/** Shape only; the amounts themselves are checked by the domain rule on the server. */
export const tipAmountsSchema = z
  .object({ presetsMinor: z.array(kobo).max(8), minMinor: kobo })
  .strict();
export type TipAmountsRequest = z.infer<typeof tipAmountsSchema>;

// Reporting a page (PR-013, PRD v1.1 FR-01). A reason from this list only: no free text, so a
// report can never carry a stranger's words or personal data.
export const PROFILE_REPORT_REASONS = [
  'impersonation',
  'scam',
  'abusive',
  'other',
] as const;
export type ProfileReportReason = (typeof PROFILE_REPORT_REASONS)[number];
export const profileReportSchema = z
  .object({ reason: z.enum(PROFILE_REPORT_REASONS) })
  .strict();

// Notification preferences (PR-013, PRD v1.1 FR-05). All on by default. Sign-in codes, recovery
// warnings and in-app tip notices are never optional, so they are not listed here.
export const notificationPrefsSchema = z
  .object({
    tipEmails: z.boolean(),
    weeklyReports: z.boolean(),
    milestones: z.boolean(),
    /** Guides and suggestions (engagement mail without a switch of its own). */
    guideEmails: z.boolean(),
  })
  .strict();
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;
