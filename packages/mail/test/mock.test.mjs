import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMockMailProvider } from '../dist/index.js';

const mail = {
  reference: '01a18300-0000-7000-8000-000000000001',
  to: 'ada@example.com',
  from: { address: 'hello@mail.usetipme.xyz', name: 'TipMe' },
  subject: 'You got a tip',
  text: 'Hello',
  html: '<p>Hello</p>',
  headers: {},
  tracking: false,
};

test('the pretend provider hands the rendered mail to its sink', async () => {
  const sunk = [];
  const provider = createMockMailProvider(async (m) => {
    sunk.push(m);
  });
  const sent = await provider.send(mail);
  assert.deepEqual(sent, { providerMessageId: `mock-${mail.reference}` });
  assert.equal(sunk.length, 1);
  assert.equal(sunk[0].reference, mail.reference);
  assert.equal(sunk[0].to, mail.to);
  assert.equal(sunk[0].subject, mail.subject);
  assert.equal(sunk[0].tracking, false);
});

test('the pretend provider accepts no webhooks', () => {
  const provider = createMockMailProvider(async () => {});
  assert.deepEqual(provider.verifyWebhook(Buffer.from('{}'), {}, new Date()), {
    ok: false,
    reason: 'signature',
  });
});

test('the pretend provider reports no sandbox', async () => {
  const provider = createMockMailProvider(async () => {});
  assert.deepEqual(await provider.status(), {
    sandbox: null,
    detail: 'pretend',
  });
});
