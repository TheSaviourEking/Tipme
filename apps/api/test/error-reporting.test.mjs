import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotFoundException } from '@nestjs/common';
import { OperationError } from '@tipme/database';
import { ApiExceptionFilter } from '../dist/http/api-exception.filter.js';

// PR-011: unexpected errors (500 INTERNAL_ERROR) go to the error reporter with the route pattern
// and the request's reference; expected outcomes (4xx, business errors) never do.
function run(exception) {
  const captured = [];
  const reporter = {
    capture: (error, context) => captured.push({ error, context }),
    flush: async () => {},
  };
  const logger = { error: () => {}, warn: () => {}, info: () => {} };
  const filter = new ApiExceptionFilter(logger, reporter);
  const response = {
    locals: { reference: '0123456789abcdef0123456789abcdef' },
    statusCode: 0,
    setHeader() {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json() {},
  };
  const request = {
    route: { path: '/v1/me/profile' },
    url: '/v1/me/profile?phone=0803',
  };
  filter.catch(exception, {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  });
  return { captured, status: response.statusCode };
}

test('an unexpected error is reported with the route pattern and the reference, never the URL', () => {
  const { captured, status } = run(new TypeError('boom'));
  assert.equal(status, 500);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].context, {
    route: '/v1/me/profile',
    traceId: '0123456789abcdef0123456789abcdef',
  });
});

test('expected outcomes are not reported', () => {
  assert.equal(run(new NotFoundException()).captured.length, 0);
  assert.equal(run(new OperationError('HANDLE_TAKEN')).captured.length, 0);
});
