import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { productionDatabaseUrlProblem } from '../dist/connection.js';

test('node-postgres loads the CA file named in the URL and checks the server certificate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tipme-ca-'));
  const ca = join(dir, 'ca.pem');
  writeFileSync(
    ca,
    '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n',
  );
  const client = new pg.Client({
    connectionString: `postgres://u:p@db.example.com:23456/tipme?sslmode=verify-full&sslrootcert=${ca}`,
  });
  const ssl = client.connectionParameters.ssl;
  assert.ok(ssl && typeof ssl === 'object', 'TLS is on');
  assert.match(String(ssl.ca), /BEGIN CERTIFICATE/, 'the CA file is read');
  assert.notEqual(
    ssl.rejectUnauthorized,
    false,
    'an unknown certificate is refused',
  );
});

test('the production rule: TLS with a checked certificate across the network, anything locally', () => {
  const remote = 'postgres://u:p@db.example.com:23456/tipme';
  assert.match(productionDatabaseUrlProblem(remote), /verify-full/);
  assert.match(
    productionDatabaseUrlProblem(`${remote}?sslmode=require`),
    /verify-full/,
  );
  assert.equal(
    productionDatabaseUrlProblem(`${remote}?sslmode=verify-full`),
    null,
  );
  assert.equal(
    productionDatabaseUrlProblem('postgres://u:p@postgres:5432/tipme'),
    null,
  );
  assert.equal(productionDatabaseUrlProblem('not a url'), 'is not a URL');
});
