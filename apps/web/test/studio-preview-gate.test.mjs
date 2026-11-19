import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pageStudioOn } from '../src/lib/page-studio-switch.ts';

// The editor's preview document (/studio-preview) is a Studio route: with the `page_studio` switch
// off it answers 404, like every other Studio route (controller ruling AJ). It reads the switch
// from the API's public /health/release; anything unreadable is off.

test('the preview route is open only while page_studio is on', () => {
  assert.equal(pageStudioOn({ pageStudio: true }), true);
  for (const off of [
    { pageStudio: false },
    { pageStudio: 'true' },
    {},
    null,
    undefined,
    'pageStudio',
  ])
    assert.equal(pageStudioOn(off), false, JSON.stringify(off));
});

test('the preview page answers notFound() while the switch is off', () => {
  const source = readFileSync(
    new URL('../src/app/studio-preview/page.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /if \(!\(await getPageStudioOn\(\)\)\) notFound\(\);/);
});
