#!/usr/bin/env node
// Sends one harmless diagnostic request through the API and worker, then prints where to see its trace.
// Usage: pnpm trace:demo [--mode succeed|fail-once|fail-always] [--api http://127.0.0.1:4000]
import { parseArgs } from 'node:util';

const modes = ['succeed', 'fail-once', 'fail-always'];
const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'succeed' },
    api: { type: 'string', default: 'http://127.0.0.1:4000' },
    jaeger: { type: 'string', default: 'http://127.0.0.1:16686' },
  },
});

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!modes.includes(values.mode))
  fail(`--mode must be one of: ${modes.join(', ')}`);

async function request(path, init) {
  try {
    return await fetch(`${values.api}${path}`, {
      ...init,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return fail(
      `API not reachable at ${values.api}. Start it with \`pnpm dev\` (and \`pnpm infra:up\`).`,
    );
  }
}

const accepted = await request('/v1/diagnostics/trace-probe', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ mode: values.mode }),
});
if (accepted.status === 404)
  fail(
    'Diagnostics are disabled. Set DIAGNOSTICS_ENABLED=true in .env and restart the API.',
  );
if (accepted.status !== 202)
  fail(
    `Probe was not accepted (HTTP ${accepted.status}). Check \`/health/ready\`.`,
  );
const {
  data: { reference, jobId },
} = await accepted.json();
console.log(`Probe accepted (mode ${values.mode}). Waiting for the worker…`);

const deadline = Date.now() + 20_000;
let status;
while (Date.now() < deadline) {
  const response = await request(`/v1/diagnostics/trace-probe/${jobId}`);
  status = response.ok ? (await response.json()).data : undefined;
  if (status && ['completed', 'failed'].includes(status.state)) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!status || !['completed', 'failed'].includes(status.state)) {
  fail(
    `The worker did not finish job ${jobId} in 20 s. Is it running? Reference: ${reference}`,
  );
}

console.log(`Job ${status.state} after ${status.attemptsMade} attempt(s).`);
console.log(`Trace: ${values.jaeger}/trace/${reference}`);
console.log(`Logs:  grep ${reference} <api and worker output>`);
