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
export const locationSlugSchema = slug(30);

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
  business: { slug: string; name: string; verified: true };
  location: { slug: string; name: string };
  /** On shift first (by started_at), then everyone else (by shownName). */
  people: StaffCard[];
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
  contact: { name: string; email: string; phone?: string };
  /** A location manager sees only their location. */
  locations: BusinessLocationView[];
  you: { role: ManagerRole; locationId?: string };
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
  tips: Shown;
  notes: Shown;
  tags: Record<BusinessNoteTag, Shown>;
  /** Integer minor units as a string; only with share_amounts and at least 3 tips that week. */
  amountMinor?: string;
}
export interface LocationInsights {
  week: string;
  locationId: string;
  tips: Shown;
  people: MemberWeek[];
  busiest?: {
    day: 0 | 1 | 2 | 3 | 4 | 5 | 6;
    fromHour: number;
    toHour: number;
  };
  topTag?: { tag: BusinessNoteTag; percent: number };
}
export interface BusinessNoteView {
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
export interface BusinessCodes {
  location: { locationId: string; path: string }[];
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
}

/** On a paid tip made at a business: whether the supporter may still write their note (M9). */
export interface TipBusinessNote {
  business: string;
  person: string;
  written: boolean;
  open: boolean;
}
