import { z } from 'zod';
import type { PublicProfile } from './profiles.js';
import { cleanThanksLine, hasLink } from './thanks.js';

/**
 * TipMe for businesses (plan `docs/superpowers/plans/2026-11-06-business.md`, PR B0): every shape
 * the business lanes share. Release 1 moves no money: a tip made at a business still credits the
 * person tipped, and carries only a label of where it was made.
 */

/** One-tap positive tags only, no ratings (owner item O3, the default list). */
export const BUSINESS_NOTE_TAGS = [
  { id: 'friendly', label: 'Friendly' },
  { id: 'fast', label: 'Fast' },
  { id: 'extra_mile', label: 'Went the extra mile' },
  { id: 'great_advice', label: 'Great advice' },
  { id: 'made_my_day', label: 'Made my day' },
] as const;
export type BusinessNoteTag = (typeof BUSINESS_NOTE_TAGS)[number]['id'];
const TAG_IDS = BUSINESS_NOTE_TAGS.map((tag) => tag.id) as [
  BusinessNoteTag,
  ...BusinessNoteTag[],
];
/** Code points, as Postgres char_length counts them. */
export const BUSINESS_NOTE_LIMIT = 280;
export const BUSINESS_NOTE_MAX_TAGS = 5;
/** Spec goal 6: a group smaller than this is never shown to a business as a number. */
export const MIN_GROUP = 3;

export const BUSINESS_STATUSES = ['pending', 'verified', 'suspended'] as const;
export type BusinessStatus = (typeof BUSINESS_STATUSES)[number];
export const MANAGER_ROLES = ['owner', 'location_manager'] as const;
export type ManagerRole = (typeof MANAGER_ROLES)[number];
export const INVITATION_KINDS = ['staff', 'manager'] as const;
export type InvitationKind = (typeof INVITATION_KINDS)[number];
/**
 * How an invitation reaches the person (owner's answer, 6 Nov 2026): an email, a one-time link the
 * manager sends themselves, or a TipMe username found by search (an in-app notification).
 */
export const INVITATION_TARGETS = ['email', 'link', 'user'] as const;
export type InvitationTarget = (typeof INVITATION_TARGETS)[number];
export const INVITATION_STATES = [
  'open',
  'accepted',
  'declined',
  'revoked',
  'expired',
] as const;
export type InvitationState = (typeof INVITATION_STATES)[number];
/** Who ended a membership. */
export const MEMBER_LEFT_BY = [
  'self',
  'manager',
  'tipme',
  'account_deleted',
] as const;
export const SHIFT_STARTED_BY = ['self', 'manager'] as const;
export const SHIFT_ENDED_BY = ['self', 'manager', 'expired', 'left'] as const;
/** What a check-in or check-out answers (PR B6): the member's shift as it now stands. */
export interface ShiftState {
  onShift: boolean;
  /** ISO time the open shift started; present only while on shift. */
  startedAt?: string;
}
export const NOTE_REPORT_REASONS = ['abusive', 'spam', 'other'] as const;
export const NOTE_REPORTED_BY = ['member', 'manager'] as const;
export const NOTE_REVIEW_OUTCOMES = ['restored', 'removed'] as const;
/** In-app notifications the business lanes write (B3 invitations, B2 verification). */
export const BUSINESS_NOTIFICATION_KINDS = [
  'business_invitation',
  'business_verified',
] as const;

/** A number the business may see, or "fewer than 3". Never a raw count below MIN_GROUP. */
export type Shown = { n: number } | { fewerThan: 3 };
/**
 * A person's tip count withheld so it can't be worked out by subtraction from the location total
 * and the counts shown (complementary suppression, PR B7). Shown as "Hidden to protect a colleague's
 * privacy".
 */
export type ShownOrHidden = Shown | { hidden: true };
/** 0 is shown as 0: there is nobody to protect. 1 and 2 never leave the server as numbers. */
export function shownCount(n: number): Shown {
  if (n === 0) return { n: 0 };
  return n < MIN_GROUP ? { fewerThan: 3 } : { n };
}

const codePoints = (text: string) => Array.from(text).length;
// Invisible format and control characters out, spaces collapsed (the thank-you line's rule, which
// keeps a zero-width joiner inside joined emoji). Every check reads the cleaned text.
const plain = (max: number) =>
  z
    .string()
    .max(max * 8)
    .transform(cleanThanksLine)
    .refine((text) => text.length > 0 && codePoints(text) <= max, {
      message: `1 to ${max} characters.`,
    });

const EMAIL_IN_TEXT = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
// Seven or more digits, allowing spaces, dashes, dots, brackets and a leading + between them.
const PHONE_IN_TEXT = /\+?\d(?:[\s\-.()]*\d){6,}/;

/** True when the text holds an email address or something that reads as a phone number. */
export function hasContactDetails(text: string): boolean {
  const visible = cleanThanksLine(text);
  return EMAIL_IN_TEXT.test(visible) || PHONE_IN_TEXT.test(visible);
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const slug = (max: number) =>
  z.string().trim().toLowerCase().max(max).regex(SLUG, {
    message: 'Lower-case letters, numbers and hyphens inside.',
  });
/** `/b/<slug>` (M7): locked once the business is verified. */
export const businessSlugSchema = slug(40);
/**
 * Location slugs a business can't take: `/b/<business>/people` is the public "I don't see them"
 * search (PR B4), matched before `/b/<business>/<location>`, so a location with it could never open.
 */
export const RESERVED_LOCATION_SLUGS = ['people'] as const;
export const locationSlugSchema = slug(30).refine(
  (value) => !(RESERVED_LOCATION_SLUGS as readonly string[]).includes(value),
  { message: 'That address is kept for TipMe. Try another.' },
);

const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
const phoneSchema = z
  .string()
  .trim()
  .max(32)
  .regex(/^\+?[\d\s\-()]{7,}$/);
const handleSchema = z
  .string()
  .trim()
  .transform((raw) => raw.replace(/^@/, '').toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9_]{3,30}$/));

export const locationInputSchema = z
  .object({
    name: plain(60),
    slug: locationSlugSchema,
    address: plain(200),
  })
  .strict();
export type LocationInput = z.infer<typeof locationInputSchema>;

/** Anyone signed in may apply (owner's answer Q3); TipMe staff verify before codes go live. */
export const businessApplicationSchema = z
  .object({
    name: plain(80),
    slug: businessSlugSchema,
    contactName: plain(80),
    contactEmail: emailSchema,
    contactPhone: phoneSchema.optional(),
    location: locationInputSchema,
  })
  .strict();
export type BusinessApplication = z.infer<typeof businessApplicationSchema>;

export const businessUpdateSchema = z
  .object({
    name: plain(80).optional(),
    contactName: plain(80).optional(),
    contactEmail: emailSchema.optional(),
    contactPhone: phoneSchema.nullable().optional(),
    slug: businessSlugSchema.optional(),
  })
  .strict();
export type BusinessUpdate = z.infer<typeof businessUpdateSchema>;

export const locationUpdateSchema = locationInputSchema.partial().strict();
export type LocationUpdate = z.infer<typeof locationUpdateSchema>;

const invitationTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('email'), email: emailSchema }).strict(),
  z.object({ kind: z.literal('link') }).strict(),
  z.object({ kind: z.literal('user'), handle: handleSchema }).strict(),
]);
export type InvitationTargetRequest = z.infer<typeof invitationTargetSchema>;

/** Staff join one location; an owner manages every location, a location manager one. */
export const invitationRequestSchema = z.union([
  z
    .object({
      kind: z.literal('staff'),
      locationId: z.uuid(),
      target: invitationTargetSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('manager'),
      role: z.literal('owner'),
      target: invitationTargetSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('manager'),
      role: z.literal('location_manager'),
      locationId: z.uuid(),
      target: invitationTargetSchema,
    })
    .strict(),
]);
export type InvitationRequest = z.infer<typeof invitationRequestSchema>;

/** 16 base32 characters; only its sha256 is stored. It travels in bodies, never in a URL path. */
export const invitationCodeSchema = z
  .object({ code: z.string().regex(/^[A-Z2-7]{16}$/) })
  .strict();
export type InvitationCode = z.infer<typeof invitationCodeSchema>;

/**
 * Answering an invitation on the Work page (PR B3): with the code from a link or an email, or, for
 * one addressed to this account (its username or proven email), by the invitation's id.
 */
export const invitationAnswerSchema = z.union([
  invitationCodeSchema,
  z.object({ invitationId: z.uuid() }).strict(),
]);
export type InvitationAnswer = z.infer<typeof invitationAnswerSchema>;

/** The invited person stops (or allows again) invitations from one business. */
export const invitationBlockSchema = z
  .object({ blocked: z.boolean() })
  .strict();
export type InvitationBlock = z.infer<typeof invitationBlockSchema>;

/** A manager searching TipMe usernames to invite: a handle prefix. */
export const inviteeQuerySchema = z
  .object({ q: z.string().trim().min(2).max(30) })
  .strict();
export type InviteeQuery = z.infer<typeof inviteeQuerySchema>;

export const memberDisplaySchema = z
  .object({
    shownName: plain(30).optional(),
    showPhoto: z.boolean().optional(),
  })
  .strict();
export type MemberDisplay = z.infer<typeof memberDisplaySchema>;

export const shareAmountsSchema = z.object({ share: z.boolean() }).strict();
export type ShareAmounts = z.infer<typeof shareAmountsSchema>;

export const businessNoteRequestSchema = z
  .object({
    tags: z
      .array(z.enum(TAG_IDS))
      .max(BUSINESS_NOTE_MAX_TAGS)
      .refine((tags) => new Set(tags).size === tags.length, {
        message: 'Each tag once.',
      })
      .default([]),
    body: z
      .string()
      .max(BUSINESS_NOTE_LIMIT * 8)
      .transform((raw) => {
        const cleaned = cleanThanksLine(raw);
        return cleaned === '' ? undefined : cleaned;
      })
      .refine(
        (body) => body === undefined || codePoints(body) <= BUSINESS_NOTE_LIMIT,
        { message: `At most ${BUSINESS_NOTE_LIMIT} characters.` },
      )
      .refine(
        (body) =>
          body === undefined || (!hasLink(body) && !hasContactDetails(body)),
        { message: 'Links, emails and phone numbers can’t be sent.' },
      )
      .optional(),
  })
  .strict()
  .refine((note) => note.tags.length > 0 || note.body !== undefined, {
    message: 'Choose a tag or write a few words.',
    path: ['tags'],
  });
export type BusinessNoteRequest = z.infer<typeof businessNoteRequestSchema>;

export const noteReportSchema = z
  .object({ reason: z.enum(NOTE_REPORT_REASONS) })
  .strict();
export type NoteReport = z.infer<typeof noteReportSchema>;

/** TipMe staff decide a reported note (PR B5): shown to the business again, or never again. */
export const noteReviewSchema = z
  .object({
    outcome: z.enum(NOTE_REVIEW_OUTCOMES),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();
export type NoteReview = z.infer<typeof noteReviewSchema>;

/** An ISO week in Lagos time; the operation refuses a week that does not exist. */
export const insightsQuerySchema = z
  .object({
    locationId: z.uuid(),
    week: z.string().regex(/^\d{4}-W\d{2}$/),
  })
  .strict();
export type InsightsQuery = z.infer<typeof insightsQuerySchema>;

/** Public: one person on a location page. Only verified, not suspended, open locations. */
export interface StaffCard {
  memberId: string;
  handle: string;
  shownName: string;
  avatarPath?: string;
  onShift: boolean;
}
export interface PublicLocation {
  /** `logoPath`: the uploaded logo (`/v1/business-logos/…`); without one, the tile shows the initial. */
  business: { slug: string; name: string; verified: true; logoPath?: string };
  location: { slug: string; name: string };
  /** On shift first (by started_at), then everyone else (by shownName). */
  people: StaffCard[];
}
/**
 * Public: the business page (`/b/<business>`, BusinessProfile board Variant A). A verified, not
 * suspended business and its open locations in the order they were added. Never any person.
 */
export interface PublicBusiness {
  business: PublicLocation['business'];
  locations: { slug: string; name: string; address: string }[];
}
export interface PublicStaffTipPage {
  business: PublicLocation['business'];
  location: PublicLocation['location'];
  person: StaffCard;
  /** Exactly what the person's own page gives the tip form, its "opens soon" state included. */
  profile: Pick<
    PublicProfile,
    | 'handle'
    | 'displayName'
    | 'tipAmounts'
    | 'acceptingTips'
    | 'plan'
    | 'tippingOpen'
  >;
}
/**
 * A staff code that no longer names someone working here (they left, the business is paused or
 * the location closed): their own page instead, and the tip is not labelled (M2).
 */
export interface StaffPageRedirect {
  redirectTo: string;
}
/** "I don't see them": a person anywhere at the business, with where they work. */
export interface BusinessPersonMatch extends StaffCard {
  locationSlug: string;
  locationName: string;
}
/**
 * The search's query: the start of a shown name. Under 2 characters is no search and answers an
 * empty list rather than an error (the operation decides), so only its length is bounded here.
 */
export const businessPeopleQuerySchema = z.object({
  q: z.string().trim().max(60).default(''),
});
export type BusinessPeopleQuery = z.infer<typeof businessPeopleQuerySchema>;

/** A username's public card, for a manager inviting by username: never contact details. */
export interface InviteeCard {
  handle: string;
  displayName: string;
  avatarPath?: string;
}

/** Signed-in: what the dashboard needs to show the Business and Work links. */
export interface MyBusinessRoles {
  manages: {
    businessId: string;
    /** The business's address on TipMe: its public page knows a manager by it. */
    slug: string;
    name: string;
    status: BusinessStatus;
    role: ManagerRole;
    locationId?: string;
  }[];
  works: { memberId: string; businessName: string; locationName: string }[];
  /** Open invitations to this account: its proven email or its username, not blocked. */
  invitations: number;
}

export interface BusinessLocationView {
  id: string;
  slug: string;
  name: string;
  address: string;
  closed: boolean;
}
export interface ManagerRow {
  managerId: string;
  role: ManagerRole;
  locationId?: string;
  /** The manager's display name, or their handle, as their own page shows it. */
  name: string;
  you: boolean;
}
/** A manager's own business: the contact is unmasked, it is theirs. */
export interface BusinessDetail {
  id: string;
  slug: string;
  name: string;
  status: BusinessStatus;
  suspendedReason?: string;
  slugLocked: boolean;
  /** The uploaded logo's served address; it is served publicly only once the business is verified. */
  logoPath?: string;
  contact: { name: string; email: string; phone?: string };
  /** A location manager sees only their location. */
  locations: BusinessLocationView[];
  you: { role: ManagerRole; locationId?: string };
  /** Business Pro (plan Task A4): present only with BUSINESS_PRO_ENABLED on. */
  plan?: BusinessPlanName;
  usage?: BusinessUsage;
  /** When Business Pro last ended; absent while it runs or never ran. */
  proLapsedAt?: string;
}
/** Business Free or Business Pro. */
export type BusinessPlanName = 'free' | 'pro';
/**
 * What a business uses of its plan's limits (Business Pro, owner 14 Nov 2026). Staff are distinct
 * people at any of its locations plus open staff invitations, never its open owners. `used` may be
 * above `limit`: a business over a limit keeps everyone and only stops adding.
 */
export interface BusinessUsage {
  plan: BusinessPlanName;
  staff: { used: number; limit: number };
  locations: { used: number; limit: number };
}
export interface MemberRow {
  memberId: string;
  profileHandle: string;
  shownName: string;
  showPhoto: boolean;
  onShift: boolean;
  joinedAt: string;
  locationId: string;
}
export interface InvitationRow {
  id: string;
  kind: InvitationKind;
  role?: ManagerRole;
  locationId?: string;
  target: InvitationTarget;
  /** The address the business typed (email invitations only). */
  email?: string;
  /** The username invited (user invitations only). */
  handle?: string;
  state: InvitationState;
  expiresAt: string;
}
/** The link is shown once (owner's answer Q2): only its hash is kept. */
export interface InvitationCreated {
  id: string;
  link?: string;
}
export interface InvitationPreview {
  businessName: string;
  locationName?: string;
  kind: InvitationKind;
  role?: ManagerRole;
  verified: boolean;
}
/** An invitation to this account by username or proven email, shown on the Work page. */
export interface MyInvitation extends InvitationPreview {
  id: string;
  businessId: string;
  expiresAt: string;
}
/** The Work page's invitations, and the businesses this account stopped inviting it. */
export interface MyInvitations {
  invitations: MyInvitation[];
  blocked: { businessId: string; name: string }[];
}
/** What accepting made: a place on a team, or a manager's seat at a business. */
export type InvitationAccepted =
  | { kind: 'staff'; membership: MyMembership }
  | { kind: 'manager'; businessId: string };
export interface MyMembership {
  memberId: string;
  business: { id: string; name: string; slug: string; status: BusinessStatus };
  location: { id: string; name: string; slug: string };
  shownName: string;
  showPhoto: boolean;
  shareAmounts: boolean;
  onShift: boolean;
  shiftStartedAt?: string;
  /** `/b/<business>/<location>/<handle>` (M2). */
  staffCodePath: string;
}
export interface MemberWeek {
  /** Absent for people who left: they count in the location total only (M6). */
  memberId?: string;
  shownName?: string;
  left: boolean;
  tips: ShownOrHidden;
  notes: Shown;
  tags: Record<BusinessNoteTag, Shown>;
  /** Integer minor units as a string; only with share_amounts, at least 3 tips, and not hidden. */
  amountMinor?: string;
}
export interface LocationInsights {
  week: string;
  locationId: string;
  tips: Shown;
  people: MemberWeek[];
  /**
   * True when no person's row can be shown without giving someone's count away by subtraction:
   * `people` is then empty and only the location total shows.
   */
  peopleHidden?: true;
  /** The 2-hour window with the most tips (3 or more), Lagos time; day 0 is Sunday (as getDay). */
  busiest?: {
    day: 0 | 1 | 2 | 3 | 4 | 5 | 6;
    fromHour: number;
    toHour: number;
  };
  topTag?: { tag: BusinessNoteTag; percent: number };
}
export interface BusinessNoteView {
  /**
   * On the business's list (B7) this is an opaque reference to the note, not the tip's id: tip
   * ids are UUIDv7 and carry the time the tip started. `noteTipOf` resolves it for that business.
   */
  tipId: string;
  shownName: string;
  /** YYYY-MM-DD in Lagos: never a time (M5). */
  date: string;
  tags: BusinessNoteTag[];
  body?: string;
  reported: boolean;
  /** On the member's own list: TipMe removed it after a report (the body is not sent). */
  removed?: boolean;
}
/** The member's own list (PR B5): every membership's notes, current and past, newest first. */
export interface WorkNoteView extends BusinessNoteView {
  memberId: string;
  business: string;
  location: string;
  /** The membership has ended; its notes stay the person's own (spec 8). */
  left: boolean;
  /** Nobody has reported it yet. */
  canReport: boolean;
}
/** Ops: a reported note, read only through a reasoned, audited reveal (PR B5). */
export interface OpsBusinessNote {
  tipId: string;
  business: string;
  location: string;
  shownName: string;
  /** YYYY-MM-DD in Lagos. */
  date: string;
  tags: BusinessNoteTag[];
  body?: string;
  report: {
    reportedAt: string;
    reportedBy: (typeof NOTE_REPORTED_BY)[number];
    reason: (typeof NOTE_REPORT_REASONS)[number];
    outcome?: (typeof NOTE_REVIEW_OUTCOMES)[number];
    reviewedAt?: string;
  };
}
/**
 * The codes a manager may print (PR B8), only once the business is verified (M12). Each `path`
 * already carries `?src=qr`; the web puts its own origin in front. The names are what the printed
 * sign and badge show, so the print view needs nothing else.
 */
export interface BusinessCodes {
  business: { name: string; slug: string };
  /** Open locations in the manager's scope, by name. */
  location: { locationId: string; slug: string; name: string; path: string }[];
  /** Active members at those locations whose page is live, by location then shown name. */
  staff: {
    memberId: string;
    locationId: string;
    shownName: string;
    path: string;
  }[];
}

/** Ops (masked by default; the full contact needs `private.view` and a reason). */
export interface OpsBusinessRow {
  id: string;
  slug: string;
  name: string;
  status: BusinessStatus;
  createdAt: string;
  contactEmailMasked: string;
  contactPhoneLast4?: string;
  locations: number;
  members: number;
}
export interface OpsBusinessDetail extends OpsBusinessRow {
  // `locations` is the row's count; the list has its own name.
  locationList: BusinessLocationView[];
  managers: { userHint: string; role: ManagerRole }[];
  verifiedAt?: string;
  suspendedReason?: string;
  /** Whether the owners uploaded a logo; staff read it through their own route, whatever the status. */
  hasLogo?: boolean;
}
/**
 * PR B2: the Businesses list's filter and search. `q` matches the name or the slug only, never a
 * contact detail, so a search can't be used to confirm someone's email.
 */
export const opsBusinessListQuerySchema = z
  .object({
    status: z.enum(BUSINESS_STATUSES).optional(),
    q: z.string().trim().min(2).max(80).optional(),
  })
  .strict();
export type OpsBusinessListQuery = z.infer<typeof opsBusinessListQuerySchema>;
/** PR B2: what a `private.view` reveal with a reason shows. Managers without an email say so. */
export interface OpsBusinessContact {
  contactName: string;
  contactEmail: string;
  contactPhone?: string;
  managers: { email?: string; role: ManagerRole }[];
}

/** On a paid tip made at a business: whether the supporter may still write their note (M9). */
export interface TipBusinessNote {
  business: string;
  person: string;
  written: boolean;
  open: boolean;
}

// ---- Release 2 (plan R2-0 Task 27; owner's answers, 6 Nov 2026) ----
// Each part is behind its own flag on top of BUSINESS_ENABLED: BUSINESS_SHARES_ENABLED for the
// share agreement and TEAM_TIPS_ENABLED for team tips. Table cards ride BUSINESS_ENABLED.

/**
 * What the business takes, in basis points of what the person receives after TipMe's fee (Q9):
 * staff keeps / business takes 100/0, 90/10, 80/20, 70/30, 50/50. The cap is 50%. The same list
 * is `SHARE_OPTIONS_BPS` in `@tipme/domain`; a database test checks the two agree.
 */
export const SHARE_OPTIONS_BPS = [0, 1000, 2000, 3000, 5000] as const;
export type ShareBps = (typeof SHARE_OPTIONS_BPS)[number];
export const shareBpsSchema = z.literal([...SHARE_OPTIONS_BPS]);
export const SHARE_PROPOSED_BY = ['business', 'member'] as const;
export const SHARE_REPORT_REASONS = [
  'pressure',
  'wrong_share',
  'other',
] as const;
export type ShareReportReason = (typeof SHARE_REPORT_REASONS)[number];
export const SHARE_REPORT_LIMIT = 280;

/** A business proposes a split to one staff member (an owner, or the manager of their location). */
export const shareProposalSchema = z
  .object({ memberId: z.uuid(), businessBps: shareBpsSchema })
  .strict();
export type ShareProposal = z.infer<typeof shareProposalSchema>;
/** The staff member answers a proposal with another option from the list (M14). */
export const shareCounterSchema = z
  .object({ businessBps: shareBpsSchema })
  .strict();
export type ShareCounter = z.infer<typeof shareCounterSchema>;
/** A staff member reports their business to TipMe. Never shown to the business. */
export const shareReportSchema = z
  .object({
    reason: z.enum(SHARE_REPORT_REASONS),
    body: plain(SHARE_REPORT_LIMIT).optional(),
  })
  .strict();
export type ShareReport = z.infer<typeof shareReportSchema>;

/**
 * The member's side of an agreement. `proposed` waits for their answer; `scheduled` is accepted
 * and starts on `startsOn`; `in_force` applies now; `ended` stopped (left, or replaced).
 */
export type ShareAgreementState =
  'proposed' | 'scheduled' | 'in_force' | 'ended';
export interface ShareAgreementView {
  agreementId: string;
  memberId: string;
  businessName: string;
  /** 100 minus the business's percent: what the person keeps of what they receive. */
  youKeepPercent: number;
  /** YYYY-MM-DD, the Lagos date the split starts. */
  startsOn: string;
  state: ShareAgreementState;
  proposedBy: (typeof SHARE_PROPOSED_BY)[number];
}

/**
 * The business's side. A declined proposal, and one left unanswered until it lapsed, both read
 * `no_change`: nothing in this shape tells them apart (spec 11, M14).
 */
export interface BusinessShareRow {
  agreementId?: string;
  memberId: string;
  shownName: string;
  state: 'in_force' | 'pending' | 'no_change';
  /** The business's percent: the one in force, or the one pending. */
  businessPercent?: number;
  startsOn?: string;
  /**
   * Who proposed a pending change (R2-C1): `member` is the staff member's suggested split, which
   * the business accepts or declines. Set only while `pending`.
   */
  proposedBy?: (typeof SHARE_PROPOSED_BY)[number];
}

/** What the supporter is told before paying, and on the receipt. Percentages only, never naira. */
export interface ShareDisclosure {
  personKeepsPercent: number;
  businessPercent: number;
  businessName: string;
}

/** Tip the whole team at a location (R2-D): split equally among the people on shift (M17). */
export const teamTipQuoteRequestSchema = z
  .object({
    locationId: z.uuid(),
    amountMinor: z.string().regex(/^\d{1,12}$/),
    currency: z.literal('NGN'),
  })
  .strict();
export type TeamTipQuoteRequest = z.infer<typeof teamTipQuoteRequestSchema>;
export interface TeamTipQuote {
  quoteId: string;
  business: { slug: string; name: string };
  location: { slug: string; name: string };
  currency: string;
  tipMinor: string;
  platformFeeMinor: string;
  providerFeeMinor: string;
  recipientNetMinor: string;
  payerTotalMinor: string;
  expiresAt: string;
  feePolicyVersion: string;
  /** People on shift now. The split itself is fixed when the tip is made. */
  people: number;
}

/** Table cards that name the server for a shift (R2-E, M18). */
export const TABLE_CARD_CODE = /^[a-z2-7]{10}$/;
export const tableCardCreateSchema = z.object({ label: plain(20) }).strict();
export type TableCardCreate = z.infer<typeof tableCardCreateSchema>;
export const tableCardAssignSchema = z.object({ memberId: z.uuid() }).strict();
export type TableCardAssign = z.infer<typeof tableCardAssignSchema>;
export interface TableCardRow {
  cardId: string;
  locationId: string;
  label: string;
  /** `/b/<business>/<location>/t/<code>`. */
  path: string;
  retired: boolean;
  assigned?: { memberId: string; shownName: string; since: string };
}

/** A business's own balance (R2-B): what TipMe owes it from shares. Owners only. */
export interface BusinessBalance {
  businessId: string;
  currency: string;
  /** May be negative after a reversal (Q8); withdrawals then stop. */
  balanceMinor: string;
  canWithdraw: boolean;
}
