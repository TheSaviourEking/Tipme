import type {
  OpsReservation,
  OpsUsernameCheck,
  OpsUsernamesList,
} from '@tipme/contracts';
import {
  RESERVED_HANDLES,
  isReservedHandle,
  reservationKey,
} from '@tipme/domain';
import { and, desc, eq, gt, isNull, like, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  handleAliases,
  handleHolds,
  handleReservations,
  profiles,
  users,
} from '../schema.js';
import { recordAudit } from './audit.js';
import { maskEmail } from './email-address.js';
import { guarded, OperationError, sqlStateOf } from './errors.js';
import { newId } from './ids.js';
import { activeReservation, opsPageByHandle } from './profiles.js';
import { checkedReason, withAuditChange } from './staff.js';
import {
  listTakeBacks,
  openTakeBackView,
  pendingTakeBacks,
  takeBackFacts,
} from './username-take-backs.js';

/*
 * Staff reservations of usernames (username reservation spec, sections 3 to 5). Instant for anyone
 * holding `usernames.manage`, with a reason, audited. A reservation only blocks a name: the
 * built-in list stays in code and is never a row, and a name a page holds is never reserved here
 * (taking it from the page is a take-back, username-take-backs.ts). The database triggers of migration 0072 back every
 * refusal, under the same per-handle lock this module takes.
 */

const PERMISSION = 'usernames.manage';
const LIST_LIMIT = 200;

/** Built-in words are checked on the name as typed, so 'me' and 'how-it-works' are found too. */
const isBuiltIn = (raw: string) => isReservedHandle(raw.trim());

const lockName = (tx: Tx, key: string) =>
  tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`tipme.handle:${key}`}::text))`,
  );

async function holdsName(db: Database | Tx, key: string): Promise<boolean> {
  const [page] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.handleLower, key));
  if (page) return true;
  const [alias] = await db
    .select({ id: handleAliases.profileId })
    .from(handleAliases)
    .where(eq(handleAliases.handleLower, key));
  return alias !== undefined;
}

const reservationColumns = {
  id: handleReservations.id,
  name: handleReservations.handleLower,
  source: handleReservations.source,
  reason: handleReservations.reason,
  reservedAt: handleReservations.reservedAt,
  takeBackId: handleReservations.takeBackId,
  email: users.email,
};

type ReservationRow = {
  id: string;
  name: string;
  source: string;
  reason: string;
  reservedAt: Date;
  takeBackId: string | null;
  email: string | null;
};

const toReservation = (row: ReservationRow): OpsReservation => ({
  id: row.id,
  name: row.name,
  source: row.source as OpsReservation['source'],
  reason: row.reason,
  reservedBy: row.email ? maskEmail(row.email) : null,
  reservedAt: row.reservedAt.toISOString(),
  takeBackId: row.takeBackId,
});

async function activeRow(
  db: Database | Tx,
  key: string,
): Promise<OpsReservation | null> {
  const [row] = await db
    .select(reservationColumns)
    .from(handleReservations)
    .leftJoin(users, eq(users.id, handleReservations.reservedBy))
    .where(
      and(
        eq(handleReservations.handleLower, key),
        isNull(handleReservations.releasedAt),
      ),
    );
  return row ? toReservation(row) : null;
}

/** Reserves a free name (or one only in a deletion hold). Audited as `username.reserved`. */
export function reserveUsername(
  db: Database,
  input: { staffId: string; name: string; reason: string; now?: Date },
): Promise<OpsReservation> {
  const now = input.now ?? new Date();
  return guarded(async () => {
    if (isBuiltIn(input.name)) throw new OperationError('USERNAME_BUILT_IN');
    const key = reservationKey(input.name);
    if (!key) throw new OperationError('INVALID_INPUT');
    const reason = checkedReason(input.reason);
    try {
      return await db.transaction(async (tx) => {
        await lockName(tx, key);
        const existing = await activeReservation(tx, key);
        if (existing)
          throw new OperationError('USERNAME_RESERVED', existing.id);
        if (await holdsName(tx, key))
          throw new OperationError('USERNAME_HELD_BY_PAGE');
        const id = newId();
        await tx.insert(handleReservations).values({
          id,
          handleLower: key,
          source: 'staff',
          reason,
          reservedBy: input.staffId,
          reservedAt: now,
        });
        await recordAudit(tx, {
          staffUserId: input.staffId,
          action: 'username.reserved',
          permission: PERMISSION,
          subjectType: 'username',
          subjectId: key,
          reason,
          now,
        });
        return (await activeRow(tx, key))!;
      });
    } catch (error) {
      // The lock serialises writers, so this is a writer that took no lock (an older release, or a
      // claim racing in): the database refused, and the winner is read back to say which.
      if (sqlStateOf(error) !== '23505') throw error;
      const winner = await activeReservation(db, key);
      if (winner) throw new OperationError('USERNAME_RESERVED', winner.id);
      throw new OperationError('USERNAME_HELD_BY_PAGE');
    }
  });
}

/**
 * Releases the active reservation of a name; the row stays as history. A built-in word is refused
 * before any lookup. Audited as `username.released`, naming the take-back when it came from one.
 */
export function releaseUsername(
  db: Database,
  input: { staffId: string; name: string; reason: string; now?: Date },
): Promise<{ name: string }> {
  const now = input.now ?? new Date();
  return guarded(async () => {
    if (isBuiltIn(input.name)) throw new OperationError('USERNAME_BUILT_IN');
    const key = reservationKey(input.name);
    if (!key) throw new OperationError('USERNAME_NOT_RESERVED');
    const reason = checkedReason(input.reason);
    return db.transaction(async (tx) => {
      await lockName(tx, key);
      const [released] = await tx
        .update(handleReservations)
        .set({
          releasedAt: now,
          releasedBy: input.staffId,
          releaseReason: reason,
        })
        .where(
          and(
            eq(handleReservations.handleLower, key),
            isNull(handleReservations.releasedAt),
          ),
        )
        .returning({ takeBackId: handleReservations.takeBackId });
      if (!released) throw new OperationError('USERNAME_NOT_RESERVED');
      await recordAudit(tx, {
        staffUserId: input.staffId,
        action: 'username.released',
        permission: PERMISSION,
        subjectType: 'username',
        subjectId: key,
        reason: released.takeBackId
          ? withAuditChange(reason, { takeBackId: released.takeBackId })
          : reason,
        now,
      });
      return { name: key };
    });
  });
}

/** What a name is right now: built-in, reserved, a page's (current or old), or free. */
export function checkUsername(
  db: Database,
  raw: string,
  now: Date = new Date(),
): Promise<OpsUsernameCheck> {
  return guarded(async () => {
    const key = reservationKey(raw);
    if (isBuiltIn(raw))
      return { name: key ?? raw.trim().toLowerCase(), state: 'built_in' };
    if (!key) return { name: raw.trim(), state: 'invalid' };
    const reservation = await activeRow(db, key);
    if (reservation) return { name: key, state: 'reserved', reservation };
    const page = await opsPageByHandle(db, key);
    if (page) {
      const pending = (await pendingTakeBacks(db, now)).find(
        (request) => request.name === key,
      );
      return {
        name: key,
        state: 'page',
        kind: page.handle.toLowerCase() === key ? 'current' : 'old',
        page,
        // The API adds liveCheckoutListed, from its own settings.
        facts: {
          ...(await takeBackFacts(db, page.profileId)),
          liveCheckoutListed: false,
        },
        openTakeBack: await openTakeBackView(db, key),
        pendingRequestId: pending?.requestId ?? null,
      };
    }
    const [hold] = await db
      .select({ until: handleHolds.until })
      .from(handleHolds)
      .where(and(eq(handleHolds.handleLower, key), gt(handleHolds.until, now)));
    return {
      name: key,
      state: 'free',
      heldUntil: hold ? hold.until.toISOString() : null,
    };
  });
}

/** The newest 200 active reservations, by name prefix and source, whether more match; and the built-in list. */
export function listUsernames(
  db: Database,
  input: { q?: string; state?: 'staff' | 'take_back' },
): Promise<OpsUsernamesList> {
  return guarded(async () => {
    // Folded like a key, and escaped: a prefix search only, so '_' and '%' match themselves.
    const prefix = (input.q ?? '').trim().toLowerCase().replaceAll('-', '_');
    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = await db
      .select(reservationColumns)
      .from(handleReservations)
      .leftJoin(users, eq(users.id, handleReservations.reservedBy))
      .where(
        and(
          isNull(handleReservations.releasedAt),
          prefix
            ? like(handleReservations.handleLower, `${escaped}%`)
            : undefined,
          input.state ? eq(handleReservations.source, input.state) : undefined,
        ),
      )
      .orderBy(desc(handleReservations.reservedAt), desc(handleReservations.id))
      // One more than is shown, to know whether there are more.
      .limit(LIST_LIMIT + 1);
    return {
      reservations: rows.slice(0, LIST_LIMIT).map(toReservation),
      more: rows.length > LIST_LIMIT,
      builtIn: RESERVED_HANDLES,
      takeBacks: await listTakeBacks(db),
      pending: await pendingTakeBacks(db),
    };
  });
}
