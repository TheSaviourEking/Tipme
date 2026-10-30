import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import type { Database } from '../client.js';
import { sessions, users } from '../schema.js';
import { guarded } from './errors.js';
import { newId } from './ids.js';

/** A session ends this long after sign-in, however often it is used (the cookie's own life). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

/** A new session. The token goes into the cookie; only its SHA-256 is stored. */
export function createSession(
  db: Database,
  input: {
    userId: string;
    deviceLabel: string;
    deviceHash?: string | null;
    now?: Date;
  },
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const token = randomBytes(32).toString('base64url');
  const sessionId = newId();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  return guarded(async () => {
    await db.insert(sessions).values({
      id: sessionId,
      userId: input.userId,
      tokenSha256: hashToken(token),
      deviceLabel: input.deviceLabel.slice(0, 80),
      deviceHash: input.deviceHash ?? null,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
    });
    return { token, sessionId, expiresAt };
  });
}

/** The live session for a cookie token, or null. Use is recorded but never extends it. */
export function resolveSession(
  db: Database,
  token: string,
  now: Date,
): Promise<{ sessionId: string; userId: string } | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return Promise.resolve(null);
  return guarded(async () => {
    const [row] = await db
      .update(sessions)
      .set({ lastSeenAt: now })
      .where(
        and(
          eq(sessions.tokenSha256, hashToken(token)),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
        ),
      )
      .returning({ sessionId: sessions.id, userId: sessions.userId });
    if (!row) return null;
    const [user] = await db
      .select({ deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, row.userId));
    return user && !user.deletedAt ? row : null;
  });
}

export function listSessions(
  db: Database,
  userId: string,
  now: Date = new Date(),
): Promise<
  {
    id: string;
    deviceLabel: string;
    createdAt: Date;
    lastSeenAt: Date;
    expiresAt: Date;
  }[]
> {
  return guarded(() =>
    db
      .select({
        id: sessions.id,
        deviceLabel: sessions.deviceLabel,
        createdAt: sessions.createdAt,
        lastSeenAt: sessions.lastSeenAt,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
        ),
      )
      .orderBy(desc(sessions.lastSeenAt)),
  );
}

/** Revokes one of the user's own sessions; another user's session is never touched. */
export function revokeSession(
  db: Database,
  input: { userId: string; sessionId: string; now?: Date },
): Promise<void> {
  return guarded(async () => {
    await db
      .update(sessions)
      .set({ revokedAt: input.now ?? new Date() })
      .where(
        and(
          eq(sessions.id, input.sessionId),
          eq(sessions.userId, input.userId),
          isNull(sessions.revokedAt),
        ),
      );
  });
}

export function revokeAllSessions(
  db: Database,
  input: { userId: string; exceptSessionId?: string; now?: Date },
): Promise<void> {
  return guarded(async () => {
    await db
      .update(sessions)
      .set({ revokedAt: input.now ?? new Date() })
      .where(
        and(
          eq(sessions.userId, input.userId),
          isNull(sessions.revokedAt),
          ...(input.exceptSessionId
            ? [ne(sessions.id, input.exceptSessionId)]
            : []),
        ),
      );
  });
}
