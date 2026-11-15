import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { nextPanelState } from '../src/components/dashboard/panel-state.ts';
import { PANEL_READ_TIMEOUT_MS, readPanel } from '../src/lib/panel-read.ts';

// UI audit (15 Nov 2026), item 4: a panel whose first read fails, or never answers, ends in the
// error state (with Try again), never an endless skeleton.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const empty = { data: null, error: null, updatedAt: null };

test('a first read answered 500 leaves the panel in the load error', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }), {
      status: 500,
    });
  const result = await readPanel('/v1/me/tips');
  assert.equal(result.ok, false);
  assert.equal(nextPanelState(empty, result, new Date()).error, 'load');
});

test('a first read the network drops leaves the panel in the load error', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  const result = await readPanel('/v1/me/earnings');
  assert.deepEqual(result, { ok: false, status: 0, code: 'NETWORK' });
  assert.equal(nextPanelState(empty, result, new Date()).error, 'load');
});

test('a read that never answers gives up, so the skeleton can’t stay forever', async () => {
  let aborted = false;
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
  const result = await readPanel('/v1/me/tips', { timeoutMs: 20 });
  assert.equal(aborted, true);
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(nextPanelState(empty, result, new Date()).error, 'load');
});

test('panels give a read a generous while before giving up', () => {
  assert.ok(PANEL_READ_TIMEOUT_MS >= 10_000);
  assert.ok(PANEL_READ_TIMEOUT_MS <= 30_000);
});

test('a failed refresh after data keeps the data and says refresh', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }), {
      status: 500,
    });
  const at = new Date(0);
  const next = nextPanelState(
    { data: { n: 1 }, error: null, updatedAt: at },
    await readPanel('/v1/me/tips'),
    new Date(),
  );
  assert.deepEqual(next, { data: { n: 1 }, error: 'refresh', updatedAt: at });
});
