import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { postProbe, startStack, waitForState } from './helpers.mjs';

// Check 7: nothing listens on port 1, so every export fails.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  otlpEndpoint: 'http://127.0.0.1:1',
});
let stack;
before(async () => {
  stack = await startStack();
});
after(() => stack.stop());

test('requests and jobs succeed while the trace collector is down', async () => {
  const { status, body } = await postProbe(stack.api, { mode: 'succeed' });
  assert.equal(status, 202);
  assert.equal(
    (await waitForState(stack.api, body.data.jobId, ['completed', 'failed']))
      .state,
    'completed',
  );
});
