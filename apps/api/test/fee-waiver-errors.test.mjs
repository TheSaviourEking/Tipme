import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OperationError } from '@tipme/database';
import { ApiExceptionFilter } from '../dist/http/api-exception.filter.js';

// Fee waivers (plan Task 3): what `fee_waiver.set`'s refusals answer once a route asks for it.
function answerTo(exception) {
  const filter = new ApiExceptionFilter(
    { warn() {}, error() {} },
    { capture() {} },
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
  filter.catch(exception, {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ route: { path: '/v1/ops/fee-waivers' } }),
    }),
  });
  return { status: sent.status, code: sent.body.error.code };
}

test('an unknown page or business is a 404; a missing cost confirm is a 400', () => {
  assert.deepEqual(answerTo(new OperationError('PROFILE_NOT_FOUND')), {
    status: 404,
    code: 'PROFILE_NOT_FOUND',
  });
  assert.deepEqual(answerTo(new OperationError('BUSINESS_NOT_FOUND')), {
    status: 404,
    code: 'BUSINESS_NOT_FOUND',
  });
  assert.deepEqual(
    answerTo(
      new OperationError('FEE_WAIVER_CONFIRM_REQUIRED', 'estimate_moved'),
    ),
    { status: 400, code: 'FEE_WAIVER_CONFIRM_REQUIRED' },
  );
});
