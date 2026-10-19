import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { ConfigError, parseConfig } from '../dist/index.js';

const schema = z.object({
  DATABASE_URL: z.url(),
  PORT: z.coerce.number().int(),
});

test('config errors name variables but never print their values', () => {
  assert.throws(
    () =>
      parseConfig(schema, {
        DATABASE_URL: 'postgres://u:SECRET@h/db',
        PORT: 'x',
      }),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.message, 'Invalid configuration: PORT');
      assert.ok(!error.message.includes('SECRET'));
      return true;
    },
  );
});

test('config errors list every invalid variable, sorted', () => {
  assert.throws(() => parseConfig(schema, {}), {
    message: 'Invalid configuration: DATABASE_URL, PORT',
  });
});

test('valid configuration is parsed and coerced', () => {
  assert.deepEqual(
    parseConfig(schema, { DATABASE_URL: 'postgres://h/db', PORT: '4000' }),
    {
      DATABASE_URL: 'postgres://h/db',
      PORT: 4000,
    },
  );
});
