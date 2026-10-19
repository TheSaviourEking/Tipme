import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { startTelemetry, shutdownTelemetry } from '../dist/index.js';
import { InMemorySpanExporter } from '../dist/testing.js';

const spans = new InMemorySpanExporter();
startTelemetry({
  serviceName: 'tipme-test',
  sampleRatio: 1,
  spanExporter: spans,
});
// Loaded with require after telemetry starts, as Nest/Express load it, so the instrumentation patches it.
const http = createRequire(import.meta.url)('node:http');

test('HTTP spans never record query strings', async (t) => {
  const server = http.createServer((_request, response) => response.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address();
  await (await fetch(`http://127.0.0.1:${port}/path?secret=abc`)).text();
  // Read before shutdown: the in-memory exporter clears its spans on shutdown.
  const serverSpans = spans.getFinishedSpans();
  await shutdownTelemetry();
  assert.ok(serverSpans.length > 0, 'expected an HTTP server span');
  const serialized = JSON.stringify(serverSpans.map((span) => span.attributes));
  assert.ok(serialized.includes('/path'), serialized);
  assert.ok(!serialized.includes('secret=abc'), serialized);
});
