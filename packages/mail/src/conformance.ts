import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { MailRejectedError, MailTemporaryError } from './errors.js';
import type { MailProvider, OutgoingMail } from './provider.js';

/** What the fake transport answers to the next send. */
export type TransportOutcome =
  | { kind: 'ok'; id: string }
  | { kind: 'permanent'; code: string }
  | { kind: 'temporary'; code: string }
  | { kind: 'timeout' };

export interface ConformanceHarness {
  provider: MailProvider;
  /** Scripts the provider's transport for the next send. */
  respond(outcome: TransportOutcome): void;
  /** A genuine, signed webhook reporting one hard bounce for `reference`. */
  signedBounce(
    reference: string,
    signedAt: Date,
  ): { body: Buffer; headers: Record<string, string> };
  /** A genuine, signed webhook of an event kind TipMe ignores. */
  signedUnknown(signedAt: Date): {
    body: Buffer;
    headers: Record<string, string>;
  };
  /** How old a signature may be before the adapter calls it stale. */
  staleAfterMs: number;
}

const sample: OutgoingMail = {
  reference: '01a18300-0000-7000-8000-00000000c0f1',
  to: 'ada@example.com',
  from: { address: 'hello@mail.usetipme.xyz', name: 'TipMe' },
  subject: 'Conformance',
  text: 'Hello',
  html: '<p>Hello</p>',
  headers: {},
  tracking: true,
};

/** The behaviour every mail adapter must share. Run it from each adapter's own tests. */
export async function runMailProviderConformance(
  t: TestContext,
  make: () => ConformanceHarness | Promise<ConformanceHarness>,
): Promise<void> {
  const now = new Date();
  const verify = async (
    h: ConformanceHarness,
    signed: { body: Buffer; headers: Record<string, string> },
  ) => {
    await h.provider.prepareWebhook?.(signed.body);
    return h.provider.verifyWebhook(signed.body, signed.headers, now);
  };

  await t.test('a sent mail returns the provider id', async () => {
    const h = await make();
    h.respond({ kind: 'ok', id: 'prov-123' });
    assert.deepEqual(await h.provider.send(sample), {
      providerMessageId: 'prov-123',
    });
  });
  await t.test('a permanent refusal is never retried', async () => {
    const h = await make();
    h.respond({ kind: 'permanent', code: 'bad-address' });
    await assert.rejects(h.provider.send(sample), (error) => {
      assert.ok(error instanceof MailRejectedError);
      return true;
    });
  });
  await t.test('a temporary failure is retried later', async () => {
    const h = await make();
    h.respond({ kind: 'temporary', code: 'busy' });
    await assert.rejects(h.provider.send(sample), (error) => {
      assert.ok(error instanceof MailTemporaryError);
      return true;
    });
  });
  await t.test('a timeout is a temporary failure', async () => {
    const h = await make();
    h.respond({ kind: 'timeout' });
    await assert.rejects(h.provider.send(sample), (error) => {
      assert.ok(error instanceof MailTemporaryError);
      assert.equal((error as MailTemporaryError).code, 'timeout');
      return true;
    });
  });
  await t.test('a signed bounce is accepted and normalised', async () => {
    const h = await make();
    const result = await verify(h, h.signedBounce(sample.reference, now));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]!.kind, 'hard_bounce');
    assert.equal(result.events[0]!.reference, sample.reference);
  });
  await t.test('a tampered webhook is refused', async () => {
    const h = await make();
    const signed = h.signedBounce(sample.reference, now);
    const tampered = Buffer.from(
      signed.body.toString('utf8').replace('ada', 'eve'),
    );
    const result = await verify(h, { body: tampered, headers: signed.headers });
    assert.deepEqual(result, { ok: false, reason: 'signature' });
  });
  await t.test('a stale webhook is refused', async () => {
    const h = await make();
    const signedAt = new Date(now.getTime() - h.staleAfterMs - 60_000);
    const result = await verify(h, h.signedBounce(sample.reference, signedAt));
    assert.deepEqual(result, { ok: false, reason: 'stale' });
  });
  await t.test(
    'an event kind TipMe ignores is accepted with no events',
    async () => {
      const h = await make();
      const result = await verify(h, h.signedUnknown(now));
      assert.deepEqual(result, { ok: true, events: [] });
    },
  );
}
