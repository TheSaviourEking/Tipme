import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRetryablePersistenceError } from '../dist/webhooks/retryable.js';

test('only availability failures ask the provider to retry', () => {
  for (const sqlState of [
    undefined,
    '08006',
    '53300',
    '57P01',
    '40001',
    '40P01',
  ]) {
    assert.equal(
      isRetryablePersistenceError({ name: 'PersistenceError', sqlState }),
      true,
      String(sqlState),
    );
  }
  for (const sqlState of ['22P05', '23514', '23505', '42703']) {
    assert.equal(
      isRetryablePersistenceError({ name: 'PersistenceError', sqlState }),
      false,
      sqlState,
    );
  }
});

test('a database failure outside guarded is a 503 that names its cause in the log', async () => {
  const { ApiExceptionFilter } =
    await import('../dist/http/api-exception.filter.js');
  const logged = [];
  const reported = [];
  const filter = new ApiExceptionFilter(
    { warn: (line) => logged.push(line), error: (line) => logged.push(line) },
    { capture: (error) => reported.push(error) },
  );
  const sent = {};
  const response = {
    getHeader: () => undefined,
    setHeader() {},
    locals: {},
    status(code) {
      sent.status = code;
      return this;
    },
    json(body) {
      sent.body = body;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ route: { path: '/v1/me/dashboard' } }),
    }),
  };
  filter.catch(
    Object.assign(new Error('Failed query: select password'), {
      cause: Object.assign(new Error('too many'), { code: '53300' }),
    }),
    host,
  );
  assert.equal(sent.status, 503);
  assert.equal(sent.body.error.code, 'DEPENDENCY_UNAVAILABLE');
  assert.equal(logged[0].event, 'http.dependency_unavailable');
  assert.equal(logged[0].sql_state, '53300');
  assert.equal(logged[0].route, '/v1/me/dashboard');
  assert.ok(!JSON.stringify(logged).includes('password'));
  assert.ok(!reported[0].message.includes('password'));
  assert.match(reported[0].message, /53300/);
});
