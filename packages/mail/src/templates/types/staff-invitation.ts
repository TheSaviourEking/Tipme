import { z } from 'zod';
import { defineMailType, mailLink } from '../define.js';
import { letter } from '../layout.js';

/** Carries the one-time enrolment link (30 minutes); the link is its only secret. */
export const staffInvitation = defineMailType({
  id: 'staff_invitation',
  category: 'security',
  sender: 'security',
  preference: null,
  schema: z
    .object({
      code: z.string().regex(/^[A-Z2-7]{10}$/),
      kind: z.enum(['invited', 'reset']),
    })
    .strict(),
  sample: { code: 'SAMPLEC2DE', kind: 'invited' },
  render: (data, ctx) => {
    const invited = data.kind === 'invited';
    const title = invited
      ? 'You’ve been added to the TipMe admin area'
      : 'Set up your TipMe admin authenticator again';
    return letter(
      {
        subject: title,
        heading: title,
        blocks: [
          {
            kind: 'text',
            text: invited
              ? 'Sign in with this email address, then set up an authenticator app to finish. This link works once, for 30 minutes.'
              : 'Your authenticator was reset, so your admin access is paused until you set up a new one. This link works once, for 30 minutes.',
          },
          {
            kind: 'button',
            label: 'Set up your authenticator',
            href: mailLink(ctx, `/ops#enrol=${data.code}`, 'staff_enrol', true),
          },
          {
            kind: 'text',
            text: invited
              ? 'Don’t want this? Open the link, sign in, and choose Decline. If you weren’t expecting it at all, tell the person who runs your TipMe admin area.'
              : 'If you weren’t expecting this, tell the person who runs your TipMe admin area.',
          },
        ],
        reason: invited
          ? 'You get this email because a TipMe admin added this address as staff.'
          : 'You get this email because a TipMe owner reset your admin authenticator.',
      },
      ctx,
    );
  },
});

/**
 * To whoever invited them and to owners: a masked address, enough to recognise. Also to the person,
 * in their own words (`own`), so a decline from a stolen session is not silent.
 */
export const staffInvitationDeclined = defineMailType({
  id: 'staff_invitation_declined',
  category: 'security',
  sender: 'security',
  preference: null,
  schema: z
    .object({
      personHint: z.string().max(260),
      roleName: z.string().max(100),
      own: z.literal(true).optional(),
    })
    .strict(),
  sample: { personHint: 'a•••@example.com', roleName: 'Support' },
  render: (data, ctx) =>
    letter(
      {
        subject: 'A TipMe admin invitation was declined',
        heading: 'Invitation declined',
        // The first text names someone or something private; the preview line must not.
        preheader: 'Invitation declined.',
        blocks: [
          {
            kind: 'text',
            text: data.own
              ? `You declined your invitation to the admin area (role: ${data.roleName}). You have no admin access. If this wasn’t you, someone else may be signed in to your account: tell whoever invited you.`
              : `${data.personHint} declined their invitation to the admin area (role: ${data.roleName}). They have no admin access, and they can be invited again.`,
          },
        ],
        reason: data.own
          ? 'You get this email because a TipMe admin invitation to this address was declined.'
          : 'You get this email because you invited this person or you are a TipMe owner.',
      },
      ctx,
    ),
});

/** To every owner: a serious action ran with no second person. It can't happen quietly (spec 6.5). */
export const staffActedAlone = defineMailType({
  id: 'staff_acted_alone',
  category: 'security',
  sender: 'security',
  preference: null,
  schema: z
    .object({
      personHint: z.string().max(260),
      action: z.string().max(60),
    })
    .strict(),
  sample: { personHint: 'a•••@example.com', action: 'Change a page’s fee' },
  render: (data, ctx) =>
    letter(
      {
        subject: 'A serious TipMe admin action ran without a second person',
        heading: 'Done without a second person',
        // The first text names someone or something private; the preview line must not.
        preheader:
          'The admin audit log has their reason. If you didn’t expect this, check it now.',
        blocks: [
          {
            kind: 'text',
            text: `${data.personHint} took a serious admin action (${data.action}) on their own, because nobody else was available to approve it. The admin audit log has their reason. If you didn’t expect this, check it now.`,
          },
        ],
        reason: 'You get this email because you are a TipMe owner.',
      },
      ctx,
    ),
});

/** To every owner: one person lifted a takeover freeze, which needs no second person (spec 6.5). */
export const staffFreezeReleased = defineMailType({
  id: 'staff_freeze_released',
  category: 'security',
  sender: 'security',
  preference: null,
  schema: z
    .object({
      personHint: z.string().max(260),
      stillHeld: z.boolean(),
    })
    .strict(),
  sample: { personHint: 'a•••@example.com', stillHeld: false },
  render: (data, ctx) =>
    letter(
      {
        subject: 'A TipMe withdrawal freeze was released',
        heading: 'A withdrawal freeze was released',
        // The first text names someone or something private; the preview line must not.
        preheader:
          'The admin audit log has their reason. If you didn’t expect this, check it now.',
        blocks: [
          {
            kind: 'text',
            text: `${data.personHint} closed a reported account takeover, which releases its freeze. ${
              data.stillHeld
                ? 'Another open issue still holds this recipient’s withdrawals.'
                : 'This recipient can withdraw again.'
            } The admin audit log has their reason. If you didn’t expect this, check it now.`,
          },
        ],
        reason: 'You get this email because you are a TipMe owner.',
      },
      ctx,
    ),
});

/** To everyone qualified to decide it, not the person who asked (spec 6.5 step 2). */
export const staffApprovalPending = defineMailType({
  id: 'staff_approval_pending',
  category: 'security',
  sender: 'security',
  preference: null,
  schema: z
    .object({
      personHint: z.string().max(260),
      action: z.string().max(60),
    })
    .strict(),
  sample: { personHint: 'a•••@example.com', action: 'Change a page’s fee' },
  render: (data, ctx) =>
    letter(
      {
        subject: 'A serious TipMe admin action is waiting for you',
        heading: 'Waiting for a second person',
        // The first text names someone or something private; the preview line must not.
        preheader:
          'Nothing has happened yet. It closes by itself after 24 hours.',
        blocks: [
          {
            kind: 'text',
            text: `${data.personHint} asked for a serious admin action (${data.action}). Nothing has happened yet. Open Approvals in the admin area to see exactly what would change, and approve or reject it. It closes by itself after 24 hours.`,
          },
        ],
        reason:
          'You get this email because you hold the permission this action needs.',
      },
      ctx,
    ),
});

/** To every owner: nobody else can now approve, so someone can act alone (spec 6.5). */
export const staffLastApproverRemoved = defineMailType({
  id: 'staff_last_approver_removed',
  category: 'security',
  sender: 'security',
  preference: null,
  schema: z
    .object({
      personHint: z.string().max(260),
      permissions: z.string().max(400),
    })
    .strict(),
  sample: {
    personHint: 'a•••@example.com',
    permissions: 'fees.manage,staff.manage',
  },
  render: (data, ctx) =>
    letter(
      {
        subject: 'A TipMe staff change removed the last second person',
        heading: 'No second person left',
        // The first text names someone or something private; the preview line must not.
        preheader:
          'One person can now take those actions alone. The admin audit log has their reason.',
        blocks: [
          {
            kind: 'text',
            text: `A staff change by ${data.personHint} left nobody else to approve serious admin actions under these permissions: ${data.permissions}. One person can now take those actions alone. The admin audit log has their reason. If you didn’t expect this, check it now.`,
          },
        ],
        reason: 'You get this email because you are a TipMe owner.',
      },
      ctx,
    ),
});

const OUTCOME_WORDS = {
  approved: 'was approved and has run.',
  rejected:
    'was rejected. Nothing ran. The admin area shows who decided, and why.',
  stale:
    'stopped when someone tried to approve it, because things had changed. Nothing ran. Ask again if it is still needed.',
  expired:
    'passed its 24 hours with no decision, so it closed. Nothing ran. Ask again if it is still needed.',
} as const;

/** To the person who asked, so a request doesn't just go quiet. */
export const staffApprovalOutcome = defineMailType({
  id: 'staff_approval_outcome',
  category: 'security',
  sender: 'security',
  preference: null,
  schema: z
    .object({
      action: z.string().max(60),
      outcome: z.enum(['approved', 'rejected', 'stale', 'expired']),
    })
    .strict(),
  sample: { action: 'Change a page’s fee', outcome: 'approved' as const },
  render: (data, ctx) =>
    letter(
      {
        subject: 'Your serious TipMe admin request has an outcome',
        heading: 'Your request has an outcome',
        // The first text names someone or something private; the preview line must not.
        preheader: 'Your request has an outcome.',
        blocks: [
          {
            kind: 'text',
            text: `Your request (${data.action}) ${OUTCOME_WORDS[data.outcome]}`,
          },
        ],
        reason: 'You get this email because you asked for this admin action.',
      },
      ctx,
    ),
});
