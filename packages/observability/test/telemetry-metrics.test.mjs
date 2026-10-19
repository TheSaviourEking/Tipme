import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getMeter, startTelemetry, shutdownTelemetry } from '../dist/index.js';
import { getFreePort } from '../dist/testing.js';

test('metrics are readable in Prometheus format on a loopback port', async (t) => {
  const metricsPort = await getFreePort();
  startTelemetry({ serviceName: 'tipme-test', sampleRatio: 1, metricsPort });
  t.after(() => shutdownTelemetry());
  getMeter('t').createCounter('tipme.test').add(1);
  const response = await fetch(`http://127.0.0.1:${metricsPort}/metrics`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /tipme_test/);
});
