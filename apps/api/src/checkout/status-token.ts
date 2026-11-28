import { createHmac, timingSafeEqual } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { z } from 'zod';

const tipIdSchema = z.uuid();

/**
 * A receipt token is HMAC-SHA256(secret, tipId) in base64url: nothing is stored, and an
 * idempotent replay of the same tip naturally returns the same token.
 */
export function createStatusToken(secret: string, tipId: string): string {
  return createHmac('sha256', secret).update(tipId).digest('base64url');
}

export function verifyStatusToken(
  secret: string,
  tipId: string,
  token: string,
): boolean {
  const expected = Buffer.from(createStatusToken(secret, tipId));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The receipt routes' one check (status, recognition stop, the live stream): a missing, malformed
 * or wrong token and a malformed id are all the same 404 as an unknown tip, decided before any
 * database read, so a request reveals nothing about which tips exist.
 */
export function requireStatusToken(
  secret: string,
  tipId: string,
  authorization: string | undefined,
): void {
  const token = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(
    authorization ?? '',
  )?.[1];
  if (
    !token ||
    !tipIdSchema.safeParse(tipId).success ||
    !verifyStatusToken(secret, tipId, token)
  )
    throw new NotFoundException();
}
