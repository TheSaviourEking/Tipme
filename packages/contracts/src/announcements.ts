import { z } from 'zod';
import { PROVIDER_WORD, REGULATORY_CLAIM } from './changelog.js';
import { opsReasonSchema } from './ops.js';

/*
 * Staff announcements by email (owner-approved, 14 Nov 2026). Staff write a subject, a preview line
 * and plain paragraphs (optional **bold**, "- " bullets, one optional button), choose an audience,
 * preview and test it, and a second person approves sending. The worker queues it in batches.
 */

/** The same limits the email template enforces (packages/mail announcement schema). */
export const ANNOUNCEMENT_LIMITS = {
  subject: 120,
  preheader: 150,
  text: 5000,
  buttonLabel: 40,
  buttonUrl: 500,
} as const;

export const ANNOUNCEMENT_AUDIENCES = [
  'everyone',
  'free',
  'pro',
  'business_owners',
] as const;
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];

export const ANNOUNCEMENT_AUDIENCE_WORDS: Record<AnnouncementAudience, string> =
  {
    everyone: 'Everyone with a confirmed email',
    free: 'Free pages only',
    pro: 'Pro pages only',
    business_owners: 'Business owners only',
  };

/** What is stored. "Waiting for approval" is a draft with a pending request, never a column. */
export const ANNOUNCEMENT_STATUSES = [
  'draft',
  'sending',
  'sent',
  'cancelled',
] as const;
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number];
export type AnnouncementState = AnnouncementStatus | 'waiting';

export type AnnouncementTextProblem = 'provider_name' | 'regulatory_claim';

/** Why staff words may not go to users: the payment partner's name, or a claim of approval. */
export function announcementTextProblems(
  text: string,
): AnnouncementTextProblem[] {
  const problems: AnnouncementTextProblem[] = [];
  if (PROVIDER_WORD.test(text)) problems.push('provider_name');
  if (REGULATORY_CLAIM.test(text)) problems.push('regulatory_claim');
  return problems;
}

const userWords = (max: number, min = 0) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => announcementTextProblems(value).length === 0, {
      message: 'names the payment partner or claims an approval',
    });

/** A TipMe path ("/pro") or an https link. */
const buttonUrl = z
  .string()
  .trim()
  .max(ANNOUNCEMENT_LIMITS.buttonUrl)
  .refine((value) => {
    if (/^\/(?!\/)/.test(value)) return true;
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  });

const draftShape = {
  subject: userWords(ANNOUNCEMENT_LIMITS.subject, 1),
  preheader: userWords(ANNOUNCEMENT_LIMITS.preheader),
  text: userWords(ANNOUNCEMENT_LIMITS.text, 1),
  buttonLabel: userWords(ANNOUNCEMENT_LIMITS.buttonLabel, 1).nullable(),
  buttonUrl: buttonUrl.nullable(),
  audience: z.enum(ANNOUNCEMENT_AUDIENCES),
};

const bothOrNeither = (value: {
  buttonLabel: string | null;
  buttonUrl: string | null;
}) => (value.buttonLabel === null) === (value.buttonUrl === null);

/** `POST /v1/ops/announcements` (a new draft) and `POST …/preview`. */
export const opsAnnouncementDraftSchema = z
  .object(draftShape)
  .strict()
  .refine(bothOrNeither, { message: 'a button needs a label and a link' });
export type OpsAnnouncementDraft = z.infer<typeof opsAnnouncementDraftSchema>;

/** `PUT /v1/ops/announcements/:id`: the revision the editor read, so a moved draft is refused. */
export const opsAnnouncementEditSchema = z
  .object({ ...draftShape, revision: z.number().int().min(1) })
  .strict()
  .refine(bothOrNeither, { message: 'a button needs a label and a link' });
export type OpsAnnouncementEdit = z.infer<typeof opsAnnouncementEditSchema>;

/** `POST …/:id/send`: asks a second person to send the revision the asker read. */
export const opsAnnouncementSendSchema = opsReasonSchema
  .extend({ revision: z.number().int().min(1) })
  .strict();
export type OpsAnnouncementSend = z.infer<typeof opsAnnouncementSendSchema>;

/** One announcement, for staff. Counts are whole people. */
export interface OpsAnnouncement {
  id: string;
  subject: string;
  preheader: string;
  text: string;
  buttonLabel: string | null;
  buttonUrl: string | null;
  audience: AnnouncementAudience;
  state: AnnouncementState;
  revision: number;
  /** Who it would reach now (drafts), counted live. Null once sending started. */
  audienceCount: number | null;
  /** Counted again when the send was approved: the N in "x of N". */
  recipientCount: number | null;
  /** Emails handed to the mail queue so far: the x. */
  queuedCount: number;
  createdAt: string;
  updatedAt: string;
  sendStartedAt: string | null;
  finishedAt: string | null;
  cancelledAt: string | null;
  waitingRequestId: string | null;
}

export interface OpsAnnouncementList {
  rows: OpsAnnouncement[];
}

/** The email exactly as it will be sent, rendered by the server's template. */
export interface OpsAnnouncementPreview {
  subject: string;
  html: string;
  text: string;
}

/** `POST …/:id/test`: where the test went, masked. */
export interface OpsAnnouncementTestSent {
  toHint: string;
}
