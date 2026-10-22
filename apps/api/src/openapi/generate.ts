import { readFileSync, writeFileSync } from 'node:fs';
import { buildOpenApi, createOpenApiApp } from './document.js';

// pnpm api:openapi           writes docs/api/openapi.json
// pnpm api:openapi --check   fails when the committed file is stale (CI)
const target = new URL('../../../../docs/api/openapi.json', import.meta.url);
const app = await createOpenApiApp();
const text = `${JSON.stringify(buildOpenApi(app), null, 2)}\n`;
await app.close();
if (process.argv.includes('--check')) {
  let committed = '';
  try {
    committed = readFileSync(target, 'utf8');
  } catch {
    // Missing counts as stale.
  }
  if (committed !== text) {
    console.error(
      'docs/api/openapi.json is stale: run pnpm api:openapi and commit it.',
    );
    process.exit(1);
  }
  console.log('docs/api/openapi.json is up to date.');
} else {
  writeFileSync(target, text);
  console.log('Wrote docs/api/openapi.json');
}
