import { z } from 'zod';

/** Social links accepted on a recipient page: https only, on the named site. */
export const SOCIAL_HOSTS = {
  facebook: ['facebook.com', 'www.facebook.com'],
  instagram: ['instagram.com', 'www.instagram.com'],
  x: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'],
} as const;
export type SocialKind = keyof typeof SOCIAL_HOSTS;

const socialUrl = (kind: SocialKind) =>
  z
    .string()
    .max(200)
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          (SOCIAL_HOSTS[kind] as readonly string[]).includes(url.hostname)
        );
      } catch {
        return false;
      }
    });

export const socialsSchema = z
  .object({
    facebook: socialUrl('facebook').optional(),
    instagram: socialUrl('instagram').optional(),
    x: socialUrl('x').optional(),
  })
  .strict();
export type Socials = z.infer<typeof socialsSchema>;

const optionalText = (max: number) => z.string().trim().max(max).nullable();

/** What a recipient may change about their page. Every field is optional. */
export const profilePatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(60),
    role: optionalText(60),
    bio: optionalText(280),
    socials: socialsSchema,
    bioPublic: z.boolean(),
    socialsPublic: z.boolean(),
    phonePublic: z.boolean(),
    emailPublic: z.boolean(),
    qrStyle: z.string().regex(/^[a-z]{3,12}$/),
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
  socials: Socials;
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
  /** The amounts the page shows now (the standard ones on Free). Optional, as `plan`. */
  tipAmounts?: TipAmounts;
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
  socials?: Socials;
  phone?: string;
  email?: string;
  /** A moment the recipient chose to share, for 14 days ("add to the celebration"). */
  celebration?: { momentId: string; label: string };
  /** The amounts this page offers (PR-012). Optional until the release after PR-012. */
  tipAmounts?: TipAmounts;
}

/** Changing the page's handle (PR-011); the old one keeps pointing at the page. */
export const renameHandleSchema = claimHandleSchema;

// Free and Pro (PR-012). Free pages show the standard amounts; staff can make a page Pro, and
// a Pro page chooses its own preset amounts and minimum (never below the ₦1,000 floor).
export type PagePlan = 'free' | 'pro';

/** Kobo as strings. Supporters may type any amount from `minMinor` to `maxMinor`. */
export interface TipAmounts {
  presetsMinor: string[];
  minMinor: string;
  maxMinor: string;
}

const kobo = z.string().regex(/^\d{1,12}$/);
/** Shape only; the amounts themselves are checked by the domain rule on the server. */
export const tipAmountsSchema = z
  .object({ presetsMinor: z.array(kobo).max(8), minMinor: kobo })
  .strict();
export type TipAmountsRequest = z.infer<typeof tipAmountsSchema>;
