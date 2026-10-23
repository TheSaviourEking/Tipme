// Load test (PR-011, PRD §10.1): public profile, checkout initialisation and dashboard p95, and
// first-party 5xx, against a throwaway local API (scripts/load-test.mjs). Never a shared copy:
// checkout initialisation writes quotes and pending tips.
import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

const API = __ENV.LOAD_API;
const HANDLE = __ENV.LOAD_HANDLE;
const COOKIE = __ENV.LOAD_COOKIE;
const RATE = Number(__ENV.LOAD_RATE || 20);
const DURATION = __ENV.LOAD_DURATION || '30s';
// Only to prove the thresholds bite: LOAD_BUDGET_SCALE=0.001 must fail the run.
const SCALE = Number(__ENV.LOAD_BUDGET_SCALE || 1);
const budgets = JSON.parse(open('./budgets.json'));

const serverErrors = new Rate('server_errors');

const scenario = (exec) => ({
  executor: 'constant-arrival-rate',
  exec,
  rate: RATE,
  timeUnit: '1s',
  duration: DURATION,
  preAllocatedVUs: 20,
  maxVUs: 100,
});

export const options = {
  scenarios: {
    profile: scenario('profile'),
    checkout: scenario('checkout'),
    dashboard: scenario('dashboard'),
  },
  thresholds: {
    'http_req_duration{scenario:profile}': [
      `p(95)<${budgets.profileP95Ms * SCALE}`,
    ],
    'http_req_duration{scenario:checkout}': [
      `p(95)<${budgets.checkoutP95Ms * SCALE}`,
    ],
    'http_req_duration{scenario:dashboard}': [
      `p(95)<${budgets.dashboardP95Ms * SCALE}`,
    ],
    server_errors: [`rate<${budgets.serverErrorRate}`],
    checks: ['rate>0.999'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

function record(response, expected) {
  serverErrors.add(response.status >= 500);
  check(response, { [`status ${expected}`]: (r) => r.status === expected });
}

export function profile() {
  record(http.get(`${API}/v1/profiles/${HANDLE}`), 200);
}

const json = { 'content-type': 'application/json' };

/** Checkout initialisation: the quote and the pending tip with its (mock) checkout link. */
export function checkout() {
  const quote = http.post(
    `${API}/v1/tip-quotes`,
    JSON.stringify({ handle: HANDLE, amountMinor: '200000', currency: 'NGN' }),
    { headers: json },
  );
  record(quote, 201);
  if (quote.status !== 201) return;
  const intent = http.post(
    `${API}/v1/tip-intents`,
    JSON.stringify({ quoteId: quote.json('data.quoteId') }),
    {
      headers: {
        ...json,
        'idempotency-key': crypto.randomUUID(),
      },
    },
  );
  record(intent, 201);
}

export function dashboard() {
  record(
    http.get(`${API}/v1/me/dashboard`, { headers: { cookie: COOKIE } }),
    200,
  );
}
