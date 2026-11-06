import { z } from 'zod';
import type { PagePlan } from './profiles.js';

/**
 * The changelog and What's new (changelog plan, 5 Nov 2026). One entry per pull request merged
 * into dev. Staff edit a working copy; users only ever read the published (approved) copy.
 */
export const CHANGELOG_AUDIENCES = [
  'staff',
  'everyone',
  'pro',
  'early_access',
] as const;
export type ChangelogAudience = (typeof CHANGELOG_AUDIENCES)[number];
/** Who a published user text is for: every audience but staff. */
export type ChangelogUserAudience = Exclude<ChangelogAudience, 'staff'>;

/** Code points, as Postgres char_length counts them. */
export const CHANGELOG_USER_TEXT_LIMIT = 280;
export const CHANGELOG_STAFF_TEXT_LIMIT = 1000;
export const CHANGELOG_TITLE_LIMIT = 256;
export const CHANGELOG_BODY_LIMIT = 65_536;
/** At most this many entry numbers in one release call (and one pending answer). */
export const CHANGELOG_RELEASE_LIMIT = 2000;

export type ChangelogState =
  'draft' | 'approved' | 'live' | 'recorded' | 'withdrawn';

/**
 * The payment provider's name as a whole word. apps/web/test/no-provider-names.test.mjs reads the
 * same word, so the source check and the stored-text check never disagree.
 */
export const PROVIDER_WORD = /\bbachs\b/i;
const REGULATORY_CLAIM =
  /\b(licen[cs]ed|regulated|approved by|authori[sz]ed by|CBN|central bank|insured|guaranteed)\b/i;
const HEADING = /^#{1,6}(\s|$)/;
const FOR_USERS_HEADING = /^#{1,6}\s*for users\s*$/i;

const codePoints = (text: string) => Array.from(text).length;

function withoutComments(body: string): string {
  return body.replace(/<!--[\s\S]*?(-->|$)/g, '');
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Cuts to `limit` code points at a word where it can, marking the cut with an ellipsis. */
function cutAtWord(text: string, limit: number): string {
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  const kept = chars.slice(0, limit - 1).join('');
  const space = kept.lastIndexOf(' ');
  // A word longer than half the room (or no spaces at all) is cut where it stands.
  const atWord =
    space > 0 && codePoints(kept.slice(0, space)) >= limit / 2
      ? kept.slice(0, space)
      : kept;
  return `${atWord.trimEnd()}…`;
}

/**
 * The PR body's first paragraph: the first run of text lines, ending at a blank line or heading,
 * markdown comments removed. Headings before it are skipped, since the PR template opens with them.
 */
export function firstParagraph(body: string | null | undefined): string {
  if (!body) return '';
  const lines: string[] = [];
  for (const line of withoutComments(body).split(/\r?\n/)) {
    const blank = line.trim() === '';
    const heading = HEADING.test(line.trim());
    if (lines.length === 0) {
      if (!blank && !heading) lines.push(line);
      continue;
    }
    if (blank || heading) break;
    lines.push(line);
  }
  return collapse(lines.join(' '));
}

/**
 * The "For users" section: a heading line matching /^#{1,6}\s*for users\s*$/i, up to the next
 * heading. '' when absent. HTML comments (the template's hint) removed, whitespace collapsed.
 */
export function forUsersSection(body: string | null | undefined): string {
  if (!body) return '';
  const lines = withoutComments(body).split(/\r?\n/);
  const start = lines.findIndex((line) => FOR_USERS_HEADING.test(line.trim()));
  if (start === -1) return '';
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (HEADING.test(line.trim())) break;
    section.push(line);
  }
  return collapse(section.join(' '));
}

/**
 * The draft an incoming PR makes. staffText = title + ' — ' + firstParagraph, cut to the limit at a
 * word. No "For users" text → a staff-only entry.
 */
export function draftFromPullRequest(pr: {
  title: string;
  body: string | null;
}): {
  staffText: string;
  userText: string | null;
  audience: ChangelogAudience;
} {
  const title = collapse(pr.title) || 'Untitled pull request';
  const paragraph = firstParagraph(pr.body);
  const staffText = cutAtWord(
    paragraph ? `${title} — ${paragraph}` : title,
    CHANGELOG_STAFF_TEXT_LIMIT,
  );
  const forUsers = forUsersSection(pr.body);
  if (!forUsers) return { staffText, userText: null, audience: 'staff' };
  return {
    staffText,
    userText: cutAtWord(forUsers, CHANGELOG_USER_TEXT_LIMIT),
    audience: 'everyone',
  };
}

export type ChangelogTextProblem =
  'provider_name' | 'regulatory_claim' | 'too_long';

/** Why a user text may not be published: it names the payment provider, implies approval by a regulator, or is too long. */
export function userTextProblems(text: string): ChangelogTextProblem[] {
  const problems: ChangelogTextProblem[] = [];
  if (PROVIDER_WORD.test(text)) problems.push('provider_name');
  if (REGULATORY_CLAIM.test(text)) problems.push('regulatory_claim');
  if (codePoints(text) > CHANGELOG_USER_TEXT_LIMIT) problems.push('too_long');
  return problems;
}

/**
 * An entry's state, derived from its columns and never stored, so the admin list, the entry page
 * and the API agree. An entry approved as staff only (a user text removed, then approved) is
 * recorded. One whose user text was removed but not yet approved keeps its state: users still
 * read the published copy, and hasUnapprovedEdit says so.
 */
export function changelogState(e: {
  audience: ChangelogAudience;
  publishedAudience?: ChangelogAudience | null;
  publishedRevision: number | null;
  liveAt: string | null;
  withdrawnAt: string | null;
}): ChangelogState {
  if (e.withdrawnAt) return 'withdrawn';
  if (e.publishedRevision === null)
    return e.audience === 'staff' ? 'recorded' : 'draft';
  if (e.publishedAudience === 'staff') return 'recorded';
  return e.liveAt ? 'live' : 'approved';
}

/** True when the working copy moved on since the approved one. */
export function hasUnapprovedEdit(e: {
  revision: number;
  publishedRevision: number | null;
}): boolean {
  return e.publishedRevision !== null && e.revision !== e.publishedRevision;
}

/** Who may read a published entry in What's new. Pro entries reach every page, worded "On Pro, …". */
export function shownToUser(
  e: { publishedAudience: ChangelogAudience | null },
  who: { plan: PagePlan | undefined; earlyAccess: boolean },
): boolean {
  switch (e.publishedAudience) {
    case 'everyone':
    case 'pro':
      return true;
    case 'early_access':
      return who.plan === 'pro' && who.earlyAccess;
    default:
      return false;
  }
}

/** The line users read: "On Pro, " goes in front of a Pro entry unless it already starts with "On Pro". */
export function userLine(e: {
  text: string;
  audience: ChangelogUserAudience;
}): string {
  if (e.audience !== 'pro' || /^on pro\b/i.test(e.text)) return e.text;
  // "You can…" reads "On Pro, you can…"; an acronym or a name keeps its capital.
  const rest = /^[A-Z][a-z]/.test(e.text)
    ? e.text[0]!.toLowerCase() + e.text.slice(1)
    : e.text;
  return `On Pro, ${rest}`;
}

const sha40 = z.string().regex(/^[0-9a-f]{40}$/);
const environment = z.enum(['staging', 'production']);
const prNumber = z.number().int().positive().max(2_147_483_647);

// Wire shapes, CI → TipMe. Checked only after the signature (changelog plan, Design §3).
export const changelogDraftSchema = z
  .object({
    number: prNumber,
    title: z.string().min(1).max(CHANGELOG_TITLE_LIMIT),
    body: z.string().max(CHANGELOG_BODY_LIMIT).nullable(),
    mergeCommitSha: sha40,
    mergedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type ChangelogDraft = z.infer<typeof changelogDraftSchema>;

export const changelogPendingSchema = z.object({ environment }).strict();
export type ChangelogPendingRequest = z.infer<typeof changelogPendingSchema>;
/** TipMe's answer to `pending`: numbers and merge commits only. */
export interface ChangelogPendingEntry {
  number: number;
  mergeSha: string;
}

export const changelogReleaseSchema = z
  .object({
    environment,
    version: z.string().regex(/^[0-9a-f]{12}$/),
    contained: z
      .array(prNumber)
      .max(CHANGELOG_RELEASE_LIMIT)
      .refine((numbers) => new Set(numbers).size === numbers.length, {
        message: 'numbers must be unique',
      }),
  })
  .strict();
export type ChangelogRelease = z.infer<typeof changelogReleaseSchema>;

// Admin.
export interface OpsChangelogRow {
  number: number;
  title: string;
  staffText: string;
  state: ChangelogState;
  unapprovedEdit: boolean;
  audience: ChangelogAudience;
  publishedAudience: ChangelogAudience | null;
  mergedAt: string;
  stagingAt: string | null;
  liveAt: string | null;
  /** The approval request waiting for a publisher, if any. */
  waitingRequestId: string | null;
}

export interface OpsChangelogEntry extends OpsChangelogRow {
  userText: string | null;
  publishedText: string | null;
  revision: number;
  publishedRevision: number | null;
  approvedAt: string | null;
  /** Masked email. */
  approvedBy: string | null;
  withdrawnAt: string | null;
  withdrawnReason: string | null;
  problems: ChangelogTextProblem[];
}

export const OPS_CHANGELOG_VIEWS = ['all', 'drafts', 'users', 'staff'] as const;
export type OpsChangelogView = (typeof OPS_CHANGELOG_VIEWS)[number];

export const opsChangelogQuerySchema = z
  .object({
    view: z.enum(OPS_CHANGELOG_VIEWS).default('all'),
    before: z.coerce.number().int().positive().optional(),
  })
  .strict();
export type OpsChangelogQuery = z.infer<typeof opsChangelogQuerySchema>;

const limitedText = (limit: number) =>
  z
    .string()
    .refine((text) => codePoints(text) >= 1 && codePoints(text) <= limit, {
      message: `between 1 and ${limit} characters`,
    });

export const opsChangelogEditSchema = z
  .object({
    staffText: limitedText(CHANGELOG_STAFF_TEXT_LIMIT).optional(),
    userText: limitedText(CHANGELOG_USER_TEXT_LIMIT).nullable().optional(),
    audience: z.enum(CHANGELOG_AUDIENCES).optional(),
    /** The revision the editor saw; a moved one is refused (CHANGELOG_EDITED_ELSEWHERE). */
    revision: z.number().int().positive(),
  })
  .strict();
export type OpsChangelogEdit = z.infer<typeof opsChangelogEditSchema>;

// Users.
export interface WhatsNewEntry {
  number: number;
  line: string;
  pro: boolean;
  /** YYYY-MM-DD, Africa/Lagos. */
  liveOn: string;
  /**
   * The instant it went live (ISO). The seen call sends this back, so a person who opened What's
   * new is marked up to exactly the newest entry they were shown, not to the start of its day.
   */
  liveAt: string;
}

export interface WhatsNewList {
  entries: WhatsNewEntry[];
  unseen: number;
}

export interface WhatsNewStatus {
  unseen: number;
  newest: WhatsNewEntry | null;
}

export const whatsNewSeenSchema = z
  .object({ through: z.iso.datetime({ offset: true }) })
  .strict();
export type WhatsNewSeen = z.infer<typeof whatsNewSeenSchema>;
