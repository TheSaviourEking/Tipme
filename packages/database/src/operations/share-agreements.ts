import type {
  BusinessShareRow,
  ShareAgreementView,
  ShareCounter,
  ShareProposal,
  ShareReport,
} from '@tipme/contracts';
import {
  isShareBps,
  lagosDateOf,
  lagosMonthOf,
  shareStartsAt,
} from '@tipme/domain';
import { sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { managerOf } from './business-access.js';
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';
import { openIssue } from './issues.js';
import { enqueueMail, type MailSealing } from './mail-queue.js';

// Business release 2, PR R2-C1: a business proposes a share of a staff member's tips there, and the
// staff member accepts, declines or suggests another split. No money moves here (R2-A, R2-C2).
//
// Rules from R2-0 that every write below follows:
// - `proposed_at` is left to its database default, and `accepted_at` is the database's now(),
//   never the app's clock; the start date is computed from the database's now() too.
// - Accepting a change is one transaction: the old agreement names its successor first, then the
//   successor is accepted (the database checks the chain at commit).
// - "In force" is only ever `tipme_share_agreement_at(member, at)`.
// - Agreements are frozen and never deleted: an answer, an end or a successor is set once.
//
// Every write locks the membership row first, then the agreement, so writes about one person run
// one at a time and never deadlock.
//
// The business never learns how the staff member answered its own proposal (spec 11, M14; the
// coordinator's ruling of 6 Nov 2026): accepted, declined or unanswered, the proposal reads
// `pending` until its start date, and from then the business sees only the outcome, the new split
// (`in_force`) or `no_change`. The one exception is a split the staff member suggests instead
// (their counter), which the business sees at once because it must answer it. This is derived
// from the rows and the database's now() (`VISIBLE_PENDING`); nothing is stored for it. A report
// about the business is never shown to it.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MemberRow = {
  member_id: string;
  location_id: string;
  profile_id: string;
  shown_name: string;
  business_id: string;
  business_name: string;
  business_status: string;
  user_id: string | null;
};

type AgreementRow = {
  id: string;
  member_id: string;
  business_bps: number;
  proposed_by: 'business' | 'member';
  effective_from: Date | string;
  accepted_at: Date | string | null;
  declined_at: Date | string | null;
  withdrawn_at: Date | string | null;
  ended_at: Date | string | null;
  superseded_by: string | null;
};

const asDate = (value: Date | string) =>
  value instanceof Date ? value : new Date(value);
const percentOf = (bps: number) => bps / 100;

/** The open membership, locked for this transaction. */
async function lockMember(tx: Tx, memberId: string): Promise<MemberRow | null> {
  if (!UUID.test(memberId)) return null;
  const found = await tx.execute<MemberRow>(sql`
    SELECT bm.id AS member_id, bm.location_id, bm.profile_id, bm.shown_name,
           l.business_id, b.name AS business_name, b.status AS business_status, p.user_id
      FROM business_members bm
      JOIN business_locations l ON l.id = bm.location_id
      JOIN businesses b ON b.id = l.business_id
      JOIN profiles p ON p.id = bm.profile_id
     WHERE bm.id = ${memberId} AND bm.left_at IS NULL
     FOR UPDATE OF bm`);
  return found.rows[0] ?? null;
}

async function lockAgreement(
  tx: Tx,
  agreementId: string,
): Promise<AgreementRow | null> {
  const found = await tx.execute<AgreementRow>(sql`
    SELECT id, member_id, business_bps, proposed_by, effective_from, accepted_at, declined_at,
           withdrawn_at, ended_at, superseded_by
      FROM share_agreements WHERE id = ${agreementId} FOR UPDATE`);
  return found.rows[0] ?? null;
}

/** Whose agreement this is, read without a lock so the membership can be locked first. */
async function memberOfAgreement(
  tx: Tx,
  agreementId: string,
): Promise<string | null> {
  if (!UUID.test(agreementId)) return null;
  const found = await tx.execute<{ member_id: string }>(sql`
    SELECT member_id FROM share_agreements WHERE id = ${agreementId}`);
  return found.rows[0]?.member_id ?? null;
}

async function databaseNow(tx: Tx): Promise<Date> {
  const found = await tx.execute<{ now: Date | string }>(
    sql`SELECT now() AS now`,
  );
  return asDate(found.rows[0]!.now);
}

/**
 * Open and still answerable: not accepted, declined or withdrawn, and its start date not reached.
 * A proposal not answered by its start date lapses (a minor call: the plan suggested 30 days, but
 * an acceptance after the start date would apply from a date the person was never shown, with less
 * notice than proposed). A lapsed one reads `no_change` to the business, like a declined one.
 */
const isAnswerable = (agreement: AgreementRow, now: Date) =>
  agreement.accepted_at === null &&
  agreement.declined_at === null &&
  agreement.withdrawn_at === null &&
  asDate(agreement.effective_from) > now;

/** The newest accepted agreement (in force, or starting later), which a change supersedes. */
async function latestAccepted(
  tx: Tx,
  memberId: string,
): Promise<AgreementRow | null> {
  const found = await tx.execute<AgreementRow>(sql`
    SELECT id, member_id, business_bps, proposed_by, effective_from, accepted_at, declined_at,
           withdrawn_at, ended_at, superseded_by
      FROM share_agreements
     WHERE member_id = ${memberId} AND accepted_at IS NOT NULL
       AND ended_at IS NULL AND superseded_by IS NULL`);
  return found.rows[0] ?? null;
}

/**
 * At most one change takes effect per member per Lagos calendar month (M15), and each change starts
 * after the one it replaces (the database's successor rule). Otherwise SHARE_CHANGE_TOO_SOON.
 */
async function checkChangeAllowed(
  tx: Tx,
  memberId: string,
  startsAt: Date,
  except?: string,
): Promise<void> {
  const accepted = await tx.execute<{ effective_from: Date | string }>(sql`
    SELECT effective_from FROM share_agreements
     WHERE member_id = ${memberId} AND accepted_at IS NOT NULL
       ${except ? sql`AND id <> ${except}` : sql``}`);
  const month = lagosMonthOf(startsAt);
  for (const { effective_from } of accepted.rows) {
    const from = asDate(effective_from);
    if (lagosMonthOf(from) === month || from >= startsAt)
      throw new OperationError('SHARE_CHANGE_TOO_SOON');
  }
}

/**
 * Closes a proposal whose start date passed unanswered, so a new one can be made (the database
 * allows one open proposal per member). It is recorded as withdrawn: nobody declined it.
 */
async function closeLapsed(tx: Tx, memberId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE share_agreements SET withdrawn_at = now()
     WHERE member_id = ${memberId} AND accepted_at IS NULL AND declined_at IS NULL
       AND withdrawn_at IS NULL AND effective_from <= now()`);
}

/**
 * What the business reads as `pending` for a member, as a condition on agreement alias `a`:
 * - its own proposal whose start date hasn't come, whatever the member did, unless the member
 *   answered it with a counter (a counter declines the proposal in the same transaction, so its
 *   `declined_at` equals the counter's `proposed_at`; the business sees the counter instead);
 * - the member's counter, while it waits for the business's answer.
 * A proposal withdrawn by the system (lapsed, or closed on leaving) is not pending.
 */
const VISIBLE_PENDING = sql.raw(`
  a.effective_from > now() AND (
    (a.proposed_by = 'business' AND a.withdrawn_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM share_agreements c
         WHERE c.member_id = a.member_id AND c.proposed_by = 'member'
           AND c.proposed_at = a.declined_at))
    OR (a.proposed_by = 'member' AND a.accepted_at IS NULL AND a.declined_at IS NULL
      AND a.withdrawn_at IS NULL))`);

/** A new proposal, after the checks both sides share. `proposed_at` is the database's default. */
async function insertProposal(
  tx: Tx,
  member: MemberRow,
  input: { bps: number; by: 'business' | 'member'; userId: string },
): Promise<{ id: string; startsAt: Date }> {
  if (!isShareBps(input.bps)) throw new OperationError('INVALID_INPUT');
  if (member.business_status !== 'verified')
    throw new OperationError('BUSINESS_NOT_VERIFIED');
  await closeLapsed(tx, member.member_id);
  // While the business reads a proposal as pending, it can't make another, whatever the member
  // did: the refusal is the same for an accepted, a declined and an unanswered proposal.
  if (input.by === 'business') {
    const pending = await tx.execute<{ id: string }>(sql`
      SELECT a.id FROM share_agreements a
       WHERE a.member_id = ${member.member_id} AND ${VISIBLE_PENDING}`);
    if (pending.rows[0]) throw new OperationError('SHARE_NOT_ALLOWED');
  }
  const open = await tx.execute<{ id: string }>(sql`
    SELECT id FROM share_agreements
     WHERE member_id = ${member.member_id} AND accepted_at IS NULL AND declined_at IS NULL
       AND withdrawn_at IS NULL`);
  if (open.rows[0]) throw new OperationError('SHARE_NOT_ALLOWED');
  const latest = await latestAccepted(tx, member.member_id);
  // A proposal must change something: the newest agreed split, or 100/0 when there is none.
  if (input.bps === (latest?.business_bps ?? 0))
    throw new OperationError('SHARE_NOT_ALLOWED');
  const startsAt = shareStartsAt(await databaseNow(tx));
  await checkChangeAllowed(tx, member.member_id, startsAt);
  const id = newId();
  await tx.execute(sql`
    INSERT INTO share_agreements (id, member_id, business_bps, proposed_by, proposed_by_user,
                                  effective_from)
    VALUES (${id}, ${member.member_id}, ${input.bps}, ${input.by}, ${input.userId}, ${startsAt})`);
  return { id, startsAt };
}

/**
 * Accepts an open proposal in one transaction: the newest accepted agreement names this one as its
 * successor, then this one is accepted at the database's now(). The caller holds both locks.
 */
async function acceptLocked(
  tx: Tx,
  member: MemberRow,
  agreement: AgreementRow,
): Promise<void> {
  if (member.business_status !== 'verified')
    throw new OperationError('BUSINESS_NOT_VERIFIED');
  await checkChangeAllowed(
    tx,
    member.member_id,
    asDate(agreement.effective_from),
    agreement.id,
  );
  const latest = await latestAccepted(tx, member.member_id);
  if (latest)
    await tx.execute(sql`
      UPDATE share_agreements SET superseded_by = ${agreement.id} WHERE id = ${latest.id}`);
  await tx.execute(sql`
    UPDATE share_agreements SET accepted_at = now() WHERE id = ${agreement.id}`);
}

// ---- The business's side ----

/** One row per open member the manager may see: owners every location, a location manager theirs. */
async function businessRows(
  tx: Database | Tx,
  businessId: string,
  locationId: string | null,
  onlyMember?: string,
): Promise<BusinessShareRow[]> {
  const found = await tx.execute<{
    member_id: string;
    shown_name: string;
    open_id: string | null;
    open_bps: number | null;
    open_from: Date | string | null;
    open_by: 'business' | 'member' | null;
    agreed_id: string | null;
    agreed_bps: number | null;
    agreed_from: Date | string | null;
  }>(sql`
    SELECT bm.id AS member_id, bm.shown_name,
           o.id AS open_id, o.business_bps AS open_bps, o.effective_from AS open_from,
           o.proposed_by AS open_by,
           a.id AS agreed_id, a.business_bps AS agreed_bps, a.effective_from AS agreed_from
      FROM business_members bm
      JOIN business_locations l ON l.id = bm.location_id
      LEFT JOIN LATERAL (
        SELECT a.id, a.business_bps, a.effective_from, a.proposed_by FROM share_agreements a
         WHERE a.member_id = bm.id AND ${VISIBLE_PENDING}
         ORDER BY a.proposed_at DESC
         LIMIT 1
      ) o ON true
      LEFT JOIN LATERAL (
        SELECT id, business_bps, effective_from FROM share_agreements
         WHERE member_id = bm.id AND accepted_at IS NOT NULL AND ended_at IS NULL
           AND superseded_by IS NULL
      ) a ON true
     WHERE l.business_id = ${businessId} AND bm.left_at IS NULL
       ${locationId ? sql`AND bm.location_id = ${locationId}` : sql``}
       ${onlyMember ? sql`AND bm.id = ${onlyMember}` : sql``}
     ORDER BY bm.shown_name, bm.id`);
  return found.rows.map((row): BusinessShareRow => {
    const base = { memberId: row.member_id, shownName: row.shown_name };
    if (row.open_id && row.open_bps !== null && row.open_from && row.open_by)
      return {
        ...base,
        agreementId: row.open_id,
        state: 'pending',
        businessPercent: percentOf(row.open_bps),
        startsOn: lagosDateOf(asDate(row.open_from)),
        proposedBy: row.open_by,
      };
    // Accepted: in force now, or (a counter the business accepted) starting on `startsOn`. A
    // business proposal accepted but not started yet is still `pending` above.
    if (row.agreed_id && row.agreed_bps !== null && row.agreed_from)
      return {
        ...base,
        agreementId: row.agreed_id,
        state: 'in_force',
        businessPercent: percentOf(row.agreed_bps),
        startsOn: lagosDateOf(asDate(row.agreed_from)),
      };
    // Never a share, or a proposal that ended without one: all read the same.
    return { ...base, state: 'no_change' };
  });
}

/** The share of every member the signed-in manager may see. */
export function listBusinessShares(
  db: Database,
  userId: string,
  businessId: string,
): Promise<BusinessShareRow[]> {
  return guarded(async () => {
    const manager = await managerOf(db, userId, businessId);
    return businessRows(db, businessId, manager.locationId);
  });
}

/**
 * The business proposes a split to one staff member: an owner, or the manager of their location.
 * It starts at the first Lagos midnight at least 14 days on, once the member accepts. The member is
 * emailed (percentages and the date only) when they have a confirmed address.
 */
export function proposeShare(
  db: Database,
  sealing: MailSealing,
  userId: string,
  businessId: string,
  input: ShareProposal,
): Promise<BusinessShareRow> {
  return guarded(() =>
    db.transaction(async (tx) => {
      await managerOf(tx, userId, businessId);
      const member = await lockMember(tx, input.memberId);
      if (!member || member.business_id !== businessId)
        throw new OperationError('NO_MEMBERSHIP');
      // A location manager elsewhere reads as an unknown business, as everywhere in B0's access.
      await managerOf(tx, userId, businessId, {
        locationId: member.location_id,
      });
      const { id, startsAt } = await insertProposal(tx, member, {
        bps: input.businessBps,
        by: 'business',
        userId,
      });
      if (input.businessBps > 0) {
        const to = await tx.execute<{ email: string }>(sql`
          SELECT email FROM users
           WHERE id = ${member.user_id} AND email IS NOT NULL
             AND email_verified_at IS NOT NULL AND deleted_at IS NULL`);
        const email = to.rows[0]?.email;
        if (email)
          await enqueueMail(tx, sealing, {
            type: 'share_proposed',
            to: email,
            userId: member.user_id,
            data: {
              businessName: member.business_name,
              businessPercent: percentOf(input.businessBps),
              startsOn: lagosDateOf(startsAt),
            },
            dedupeKey: `share_proposed.${id}`,
            expiresAt: startsAt,
          });
      }
      const [row] = await businessRows(tx, businessId, null, member.member_id);
      return row!;
    }),
  );
}

/** The business answers a split the staff member suggested (their counter). */
export function answerSuggestedShare(
  db: Database,
  userId: string,
  businessId: string,
  agreementId: string,
  answer: 'accept' | 'decline',
): Promise<BusinessShareRow> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const { member, agreement } = await businessAgreement(
        tx,
        userId,
        businessId,
        agreementId,
      );
      if (
        agreement.proposed_by !== 'member' ||
        !isAnswerable(agreement, await databaseNow(tx))
      )
        throw new OperationError('SHARE_NOT_OPEN');
      if (answer === 'accept') await acceptLocked(tx, member, agreement);
      else
        await tx.execute(sql`
          UPDATE share_agreements SET declined_at = now() WHERE id = ${agreement.id}`);
      const [row] = await businessRows(tx, businessId, null, member.member_id);
      return row!;
    }),
  );
}

/** A business-side agreement, both locks held, after the manager's access is checked. */
async function businessAgreement(
  tx: Tx,
  userId: string,
  businessId: string,
  agreementId: string,
): Promise<{ member: MemberRow; agreement: AgreementRow }> {
  await managerOf(tx, userId, businessId);
  const memberId = await memberOfAgreement(tx, agreementId);
  const member = memberId ? await lockMember(tx, memberId) : null;
  if (!member || member.business_id !== businessId)
    throw new OperationError('SHARE_NOT_OPEN');
  try {
    await managerOf(tx, userId, businessId, {
      locationId: member.location_id,
    });
  } catch {
    throw new OperationError('SHARE_NOT_OPEN');
  }
  const agreement = await lockAgreement(tx, agreementId);
  if (!agreement) throw new OperationError('SHARE_NOT_OPEN');
  return { member, agreement };
}

// ---- The staff member's side ----

async function memberViews(
  tx: Database | Tx,
  userId: string,
  onlyAgreement?: string,
): Promise<ShareAgreementView[]> {
  const found = await tx.execute<{
    id: string;
    member_id: string;
    business_name: string;
    business_bps: number;
    effective_from: Date | string;
    proposed_by: 'business' | 'member';
    state: 'proposed' | 'scheduled' | 'in_force';
  }>(sql`
    SELECT * FROM (
      SELECT a.id, a.member_id, b.name AS business_name, a.business_bps, a.effective_from,
             a.proposed_by,
             CASE
               WHEN a.accepted_at IS NULL THEN 'proposed'
               WHEN a.id = tipme_share_agreement_at(a.member_id, now()) THEN 'in_force'
               ELSE 'scheduled'
             END AS state
        FROM share_agreements a
        JOIN business_members bm ON bm.id = a.member_id
        JOIN business_locations l ON l.id = bm.location_id
        JOIN businesses b ON b.id = l.business_id
        JOIN profiles p ON p.id = bm.profile_id
       WHERE p.user_id = ${userId} AND bm.left_at IS NULL
         ${onlyAgreement ? sql`AND a.id = ${onlyAgreement}` : sql``}
         AND (
           -- open and answerable
           (a.accepted_at IS NULL AND a.declined_at IS NULL AND a.withdrawn_at IS NULL
             AND a.effective_from > now())
           -- in force now
           OR a.id = tipme_share_agreement_at(a.member_id, now())
           -- accepted, starting later
           OR (a.accepted_at IS NOT NULL AND a.ended_at IS NULL AND a.superseded_by IS NULL
             AND a.effective_from > now())
         )
    ) s
    ORDER BY s.member_id,
             CASE s.state WHEN 'in_force' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END`);
  return found.rows.map((row) => ({
    agreementId: row.id,
    memberId: row.member_id,
    businessName: row.business_name,
    youKeepPercent: 100 - percentOf(row.business_bps),
    startsOn: lagosDateOf(asDate(row.effective_from)),
    state: row.state,
    proposedBy: row.proposed_by,
  }));
}

/**
 * The signed-in person's shares at every place they work: the split in force, one accepted to
 * start later, and an open proposal (theirs to answer, or their own suggestion waiting).
 */
export function myShares(
  db: Database,
  userId: string,
): Promise<ShareAgreementView[]> {
  return guarded(() => memberViews(db, userId));
}

/** A business proposal to the signed-in person, both locks held. Anything else is SHARE_NOT_OPEN. */
async function memberAgreement(
  tx: Tx,
  userId: string,
  agreementId: string,
): Promise<{ member: MemberRow; agreement: AgreementRow }> {
  const memberId = await memberOfAgreement(tx, agreementId);
  const member = memberId ? await lockMember(tx, memberId) : null;
  if (!member || member.user_id !== userId)
    throw new OperationError('SHARE_NOT_OPEN');
  const agreement = await lockAgreement(tx, agreementId);
  if (
    !agreement ||
    agreement.proposed_by !== 'business' ||
    !isAnswerable(agreement, await databaseNow(tx))
  )
    throw new OperationError('SHARE_NOT_OPEN');
  return { member, agreement };
}

/** The staff member accepts the business's proposal. It applies from its start date. */
export function acceptShare(
  db: Database,
  userId: string,
  agreementId: string,
): Promise<ShareAgreementView> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const { member, agreement } = await memberAgreement(
        tx,
        userId,
        agreementId,
      );
      await acceptLocked(tx, member, agreement);
      const [view] = await memberViews(tx, userId, agreement.id);
      return view!;
    }),
  );
}

/** The staff member declines. The business only ever reads `no_change`. */
export function declineShare(
  db: Database,
  userId: string,
  agreementId: string,
): Promise<void> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const { agreement } = await memberAgreement(tx, userId, agreementId);
      await tx.execute(sql`
        UPDATE share_agreements SET declined_at = now() WHERE id = ${agreement.id}`);
    }),
  );
}

/**
 * The staff member suggests another split: the business's proposal is declined (hidden, as any
 * decline) and theirs is made, for the business to accept or decline. Same notice and monthly rule.
 */
export function counterShare(
  db: Database,
  userId: string,
  agreementId: string,
  input: ShareCounter,
): Promise<ShareAgreementView> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const { member, agreement } = await memberAgreement(
        tx,
        userId,
        agreementId,
      );
      if (input.businessBps === agreement.business_bps)
        throw new OperationError('SHARE_NOT_ALLOWED');
      await tx.execute(sql`
        UPDATE share_agreements SET declined_at = now() WHERE id = ${agreement.id}`);
      const { id } = await insertProposal(tx, member, {
        bps: input.businessBps,
        by: 'member',
        userId,
      });
      const [view] = await memberViews(tx, userId, id);
      return view!;
    }),
  );
}

/**
 * The staff member reports their business to TipMe. The words stay in `share_reports`; the issue
 * carries ids and fixed words only, one a day per person, and the business is never told.
 */
export function reportBusiness(
  db: Database,
  userId: string,
  memberId: string,
  input: ShareReport,
): Promise<void> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const member = await lockMember(tx, memberId);
      if (!member || member.user_id !== userId)
        throw new OperationError('NO_MEMBERSHIP');
      const now = await databaseNow(tx);
      await tx.execute(sql`
        INSERT INTO share_reports (id, member_id, business_id, reason, body)
        VALUES (${newId()}, ${member.member_id}, ${member.business_id}, ${input.reason},
                ${input.body ?? null})`);
      await openIssue(tx, {
        dedupeKey: `share_report.${member.member_id}.${lagosDateOf(now)}`,
        kind: 'share_report',
        subject: {
          businessId: member.business_id,
          profileId: member.profile_id,
        },
        now,
        note: `Reason: ${input.reason}. Member ${member.member_id}.`,
      });
    }),
  );
}

/**
 * Leaving ends a share at once (M16): every accepted agreement still in force or still to start
 * ends now, and an open proposal is closed. For B3's `endMembership` (leave, removal, account
 * deletion), in its transaction. A rejoin is a new membership, so it starts at 100/0.
 */
export async function endShareAgreements(
  tx: Tx,
  memberId: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE share_agreements a SET ended_at = now()
     WHERE a.member_id = ${memberId} AND a.accepted_at IS NOT NULL AND a.ended_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM share_agreements s
          WHERE s.id = a.superseded_by AND s.effective_from <= now())`);
  await tx.execute(sql`
    UPDATE share_agreements SET withdrawn_at = now()
     WHERE member_id = ${memberId} AND accepted_at IS NULL AND declined_at IS NULL
       AND withdrawn_at IS NULL`);
}
