import type { OpsIssueEvidence } from '@tipme/contracts';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  issueNotes,
  paymentAttempts,
  payouts,
  phoneRecoveries,
  profiles,
  providerEvents,
  statusTransitions,
  tipMessages,
  tips,
  unmatchedProviderEvents,
  users,
} from '../schema.js';
import { maskEmail } from './email.js';
import { guarded } from './errors.js';
import { issueById, relatedOpenIssues } from './issues.js';
import { phoneHint } from './phone.js';
import { tipProof } from './proof.js';

const tail = (value: string | null, n = 6) => (value ? value.slice(-n) : null);
const iso = (value: Date | null) => (value ? value.toISOString() : null);

export type IssueEvidence = OpsIssueEvidence;

export function issueEvidence(
  db: Database,
  issueId: string,
): Promise<IssueEvidence | null> {
  return guarded(async () => {
    const issue = await issueById(db, issueId);
    if (!issue) return null;
    const { subject } = issue;

    const notes = await db
      .select()
      .from(issueNotes)
      .where(eq(issueNotes.issueId, issue.id))
      .orderBy(asc(issueNotes.createdAt));

    const proof = subject.tipId ? await tipProof(db, subject.tipId) : null;
    if (proof?.payment)
      proof.payment.providerReference = tail(proof.payment.providerReference);
    if (proof?.payout)
      proof.payout.providerReference = tail(proof.payout.providerReference);

    const [tip] = subject.tipId
      ? await db
          .select({ intentId: tips.intentId, label: tips.payerDisplayLabel })
          .from(tips)
          .where(eq(tips.id, subject.tipId))
      : [];
    const attemptRows = tip
      ? await db
          .select()
          .from(paymentAttempts)
          .where(eq(paymentAttempts.intentId, tip.intentId))
          .orderBy(asc(paymentAttempts.attemptNumber))
      : [];
    const [message] = subject.tipId
      ? await db
          .select({ tipId: tipMessages.tipId })
          .from(tipMessages)
          .where(eq(tipMessages.tipId, subject.tipId))
      : [];

    const eventFilters = [
      ...(attemptRows.length > 0
        ? [
            inArray(
              providerEvents.attemptId,
              attemptRows.map((a) => a.id),
            ),
          ]
        : []),
      ...(subject.payoutId
        ? [eq(providerEvents.payoutId, subject.payoutId)]
        : []),
      ...(subject.providerEventRowId
        ? [eq(providerEvents.id, subject.providerEventRowId)]
        : []),
    ];
    const events =
      eventFilters.length > 0
        ? await db
            .select()
            .from(providerEvents)
            .where(or(...eventFilters))
            .orderBy(asc(providerEvents.receivedAt))
        : [];

    let payout: IssueEvidence['payout'] = null;
    const payoutId = subject.payoutId ?? proof?.payout?.payoutId;
    if (payoutId) {
      const [row] = await db
        .select()
        .from(payouts)
        .where(eq(payouts.id, payoutId));
      if (row) {
        const history = await db
          .select()
          .from(statusTransitions)
          .where(
            and(
              eq(statusTransitions.entityType, 'payout'),
              eq(statusTransitions.entityId, row.id),
            ),
          )
          .orderBy(asc(statusTransitions.createdAt));
        payout = {
          id: row.id,
          status: row.status,
          amountMinor: row.amountMinor.toString(),
          currency: row.currency,
          referenceTail: tail(row.providerReference),
          createdAt: row.createdAt.toISOString(),
          paidAt: iso(row.paidAt),
          history: history.map((h) => ({
            fromStatus: h.fromStatus,
            toStatus: h.toStatus,
            cause: h.cause,
            at: h.createdAt.toISOString(),
          })),
        };
      }
    }

    const [page] = subject.profileId
      ? await db
          .select()
          .from(profiles)
          .where(eq(profiles.id, subject.profileId))
      : [];
    const userId = subject.userId ?? page?.userId ?? null;
    const [user] = userId
      ? await db.select().from(users).where(eq(users.id, userId))
      : [];

    const [unmatched] = subject.unmatchedId
      ? await db
          .select()
          .from(unmatchedProviderEvents)
          .where(eq(unmatchedProviderEvents.id, subject.unmatchedId))
      : [];
    const [recovery] = subject.recoveryId
      ? await db
          .select()
          .from(phoneRecoveries)
          .where(eq(phoneRecoveries.id, subject.recoveryId))
      : [];

    const traceId =
      [...(proof?.history ?? [])].reverse().find((h) => h.traceId)?.traceId ??
      null;

    return {
      issue,
      notes: notes.map((n) => ({
        id: n.id,
        staffUserId: n.staffUserId,
        text: n.text,
        createdAt: n.createdAt.toISOString(),
      })),
      tipProof: proof,
      attempts: attemptRows.map((a) => ({
        id: a.id,
        status: a.status,
        provider: a.provider,
        referenceTail: tail(a.providerReference),
        createdAt: a.createdAt.toISOString(),
        lastReconciledAt: iso(a.lastReconciledAt),
      })),
      providerEvents: events.map((e) => ({
        id: e.id,
        provider: e.provider,
        eventIdTail: e.providerEventId.slice(-8),
        eventType: e.eventType,
        processingOutcome: e.processingOutcome,
        receivedAt: e.receivedAt.toISOString(),
        processedAt: iso(e.processedAt),
      })),
      payout,
      page: page
        ? {
            profileId: page.id,
            handle: page.handle,
            pageState: page.pageState,
            status: page.status,
            suspendedReason:
              page.status === 'suspended' ? page.suspendedReason : null,
          }
        : null,
      person: user
        ? {
            userId: user.id,
            phoneHint: user.phoneE164 ? phoneHint(user.phoneE164) : null,
            emailMasked: user.email ? maskEmail(user.email) : null,
            emailVerified: Boolean(user.emailVerifiedAt),
            deleted: Boolean(user.deletedAt),
          }
        : null,
      unmatched: unmatched
        ? {
            id: unmatched.id,
            provider: unmatched.provider,
            eventType: unmatched.eventType,
            reason: unmatched.reason,
            receivedAt: unmatched.receivedAt.toISOString(),
          }
        : null,
      recovery: recovery
        ? {
            id: recovery.id,
            newPhoneHint: phoneHint(recovery.newPhoneE164),
            effectiveAt: recovery.effectiveAt.toISOString(),
            cancelledAt: iso(recovery.cancelledAt),
            completedAt: iso(recovery.completedAt),
          }
        : null,
      traceId,
      related: await relatedOpenIssues(db, issue),
      private: {
        message: Boolean(message),
        supporterLabel: Boolean(tip?.label),
        phone: Boolean(user?.phoneE164),
        email: Boolean(user?.email),
      },
    };
  });
}

/** The private details behind an issue. The caller must hold `private.view` and audit the reason. */
export function revealPrivate(
  db: Database,
  issueId: string,
): Promise<{
  message?: string;
  supporterLabel?: string;
  phone?: string;
  email?: string;
} | null> {
  return guarded(async () => {
    const issue = await issueById(db, issueId);
    if (!issue) return null;
    const out: {
      message?: string;
      supporterLabel?: string;
      phone?: string;
      email?: string;
    } = {};
    if (issue.subject.tipId) {
      const [tip] = await db
        .select({ label: tips.payerDisplayLabel, profileId: tips.profileId })
        .from(tips)
        .where(eq(tips.id, issue.subject.tipId));
      if (tip?.label) out.supporterLabel = tip.label;
      const [message] = await db
        .select({ body: tipMessages.body })
        .from(tipMessages)
        .where(eq(tipMessages.tipId, issue.subject.tipId));
      if (message) out.message = message.body;
    }
    let userId = issue.subject.userId;
    if (!userId && issue.subject.profileId) {
      const [page] = await db
        .select({ userId: profiles.userId })
        .from(profiles)
        .where(eq(profiles.id, issue.subject.profileId));
      userId = page?.userId ?? undefined;
    }
    if (userId) {
      const [user] = await db
        .select({ phone: users.phoneE164, email: users.email })
        .from(users)
        .where(eq(users.id, userId));
      if (user?.phone) out.phone = user.phone;
      if (user?.email) out.email = user.email;
    }
    return out;
  });
}
