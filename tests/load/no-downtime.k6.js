// No-downtime rehearsal load (scripts/rehearse-production.sh): a steady stream of public reads
// through the edge Caddy while a deploy and a rollback switch the colours. Any failed request
// fails the run. The rehearsal runs in password-protected preview (production mode cannot boot
// until bachs-live exists), so the reads are the ones the preview gate leaves open: readiness,
// the release info and the backup status (a database read).
import http from 'k6/http';
import exec from 'k6/execution';

const API = __ENV.REHEARSAL_API;
const RATE = Number(__ENV.REHEARSAL_RATE || 30);
const DURATION = __ENV.REHEARSAL_DURATION || '90s';

// `served` reads stand for what people send and must never fail. Readiness is Caddy's own signal,
// read here only to show the drain: a stopping copy answers it 503 `draining` on purpose, and for up
// to one 2 s health-check interval Caddy still routes some requests to it (31 Oct 2026 rehearsal:
// 16 readiness 503s across two switches, 0 failures on the other reads in the same windows).
const READS = [
  { name: 'ready', path: '/health/ready', served: 'no' },
  { name: 'release', path: '/health/release', served: 'yes' },
  { name: 'backups', path: '/health/backups', served: 'yes' },
];

export const options = {
  scenarios: {
    reads: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 30,
      maxVUs: 200,
    },
  },
  thresholds: {
    'http_req_failed{served:yes}': ['rate==0'],
    // Per read, so the summary shows where any failure was.
    'http_req_failed{read:release}': ['rate==0'],
    'http_req_failed{read:backups}': ['rate==0'],
    // Shown, never failing: only a 503 `draining` is expected here (anything else is logged as
    // FAILED with its status and fails the check in rehearse-production.sh).
    'http_req_failed{read:ready}': ['rate>=0'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const read = READS[exec.scenario.iterationInTest % READS.length];
  const res = http.get(`${API}${read.path}`, {
    tags: { read: read.name, served: read.served },
    timeout: '10s',
  });
  // Each failure with its time, status and error, so the run says what failed, not only how many.
  if (res.status < 200 || res.status >= 400)
    console.log(
      `FAILED ${new Date().toISOString()} ${read.name} status=${res.status} error=${res.error_code || '-'} body=${String(res.body || '').slice(0, 80)}`,
    );
}
