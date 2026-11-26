import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serverApiOrigin } from '../src/lib/server-api-origin.ts';

// The web server reaches the API at API_INTERNAL_ORIGIN when set (staging: over the edge network),
// else at the browser's address. Compose passes a blank value when the setting is unused, which must
// mean "unset", never an empty origin (every lookup would then fail).
test('API_INTERNAL_ORIGIN wins, then NEXT_PUBLIC_API_ORIGIN, then localhost', () => {
  assert.equal(
    serverApiOrigin({
      API_INTERNAL_ORIGIN: 'http://staging-api:4000',
      NEXT_PUBLIC_API_ORIGIN: 'https://api.example.test',
    }),
    'http://staging-api:4000',
  );
  assert.equal(
    serverApiOrigin({ NEXT_PUBLIC_API_ORIGIN: 'https://api.example.test' }),
    'https://api.example.test',
  );
  assert.equal(serverApiOrigin({}), 'http://localhost:4000');
});

test('a blank API_INTERNAL_ORIGIN counts as unset', () => {
  assert.equal(
    serverApiOrigin({
      API_INTERNAL_ORIGIN: '',
      NEXT_PUBLIC_API_ORIGIN: 'https://api.example.test',
    }),
    'https://api.example.test',
  );
  assert.equal(
    serverApiOrigin({ API_INTERNAL_ORIGIN: '  ', NEXT_PUBLIC_API_ORIGIN: '' }),
    'http://localhost:4000',
  );
});

// Next inlines NEXT_PUBLIC_* at build only where the code reads it literally. The image's runtime
// env has no NEXT_PUBLIC_API_ORIGIN, so a call passing all of process.env would fall to localhost.
test('every caller reads both settings literally, so the build can inline the public one', async () => {
  const { readFileSync } = await import('node:fs');
  for (const file of [
    'src/proxy.ts',
    'src/lib/profiles-api.ts',
    'src/lib/display-settings-api.ts',
  ]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, /serverApiOrigin\(\{/, file);
    assert.match(source, /process\.env\.NEXT_PUBLIC_API_ORIGIN/, file);
    assert.match(source, /process\.env\.API_INTERNAL_ORIGIN/, file);
    assert.doesNotMatch(source, /serverApiOrigin\(process\.env\)/, file);
  }
});
