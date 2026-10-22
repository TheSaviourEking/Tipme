import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import {
  createOpenApiApp,
  buildOpenApi,
} from '../../apps/api/dist/openapi/document.js';

// OpenAPI 3.1 (PR-011, PRD §8): generated from the routes Nest actually registers and the zod
// schemas their validation pipes hold, so it cannot drift. Compared here against Express's own
// route table, and against the committed docs/api/openapi.json.

let app;
let document;
before(async () => {
  app = await createOpenApiApp();
  document = buildOpenApi(app);
});
after(async () => {
  await app.close();
});

/** Every "METHOD /path" Express will answer, path parameters written {like_this}. */
function registeredRoutes() {
  const express = app.getHttpAdapter().getInstance();
  const routes = new Set();
  for (const layer of express.router.stack) {
    if (!layer.route) continue;
    for (const [method, on] of Object.entries(layer.route.methods))
      if (on && method !== '_all')
        routes.add(
          `${method.toUpperCase()} ${layer.route.path.replace(/:(\w+)/g, '{$1}')}`,
        );
  }
  return routes;
}

const documented = () => {
  const routes = new Set();
  for (const [path, item] of Object.entries(document.paths))
    for (const method of Object.keys(item))
      routes.add(`${method.toUpperCase()} ${path}`);
  return routes;
};

test('every route the API answers is documented, and nothing else is', () => {
  const real = registeredRoutes();
  assert.ok(real.size > 50, `found ${real.size} routes`);
  assert.deepEqual([...documented()].sort(), [...real].sort());
});

test('operations carry ids, request schemas from the contracts, auth and permissions', () => {
  assert.equal(document.openapi, '3.1.0');
  const ops = Object.values(document.paths).flatMap((item) =>
    Object.values(item),
  );
  const ids = ops.map((op) => op.operationId);
  assert.equal(new Set(ids).size, ids.length, 'operation ids are unique');

  const quote = document.paths['/v1/tip-quotes'].post;
  const body = quote.requestBody.content['application/json'].schema;
  assert.deepEqual(Object.keys(body.properties).sort(), [
    'amountMinor',
    'currency',
    'handle',
  ]);
  assert.equal(body.additionalProperties, false);
  assert.equal(quote.security, undefined, 'checkout needs no account');

  const rename = document.paths['/v1/me/handle'].put;
  assert.deepEqual(rename.security, [{ session: [] }]);
  assert.ok(rename.requestBody);

  const issues = document.paths['/v1/ops/issues'].get;
  assert.deepEqual(issues.security, [{ session: [] }]);
  assert.equal(issues['x-tipme-permission'], 'issues.view');

  const tip = document.paths['/v1/me/tips/{tipId}'].get;
  assert.deepEqual(
    tip.parameters.map((p) => [p.name, p.in, p.required]),
    [['tipId', 'path', true]],
  );
  assert.ok(document.paths['/v1/dev/inbox'].get.tags.includes('pretend only'));
});

test('docs/api/openapi.json is up to date (pnpm api:openapi regenerates it)', () => {
  const committed = JSON.parse(
    readFileSync(new URL('../../docs/api/openapi.json', import.meta.url)),
  );
  assert.deepEqual(committed, document);
});
