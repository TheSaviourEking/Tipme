import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

// Fences for the public tip form (public-boards plan, PR 8): restyles must never move the pay path.
const src = new URL('../src/', import.meta.url).pathname;
const formPath = join(src, 'components/appreciation-form.tsx');
const form = readFileSync(formPath, 'utf8');

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|mjs)$/.test(name) ? [path] : [];
  });
}

test('the tip form has exactly one way to pay: location.assign(result.data.checkoutUrl) after result.ok', () => {
  const assigns = form.match(/location\.assign\(/g) ?? [];
  assert.equal(assigns.length, 1);
  assert.match(form, /location\.assign\(result\.data\.checkoutUrl\)/);
  const ok = form.indexOf('if (result.ok) {');
  const pay = form.indexOf('location.assign(result.data.checkoutUrl)');
  assert.ok(ok > 0 && pay > ok, 'the redirect sits inside if (result.ok)');
  assert.doesNotMatch(form.slice(ok, pay), /\breturn\b/);
  assert.equal((form.match(/checkoutUrl/g) ?? []).length, 1);
});

test('nothing in the web app opens a checkout another way', () => {
  for (const file of sources(src)) {
    const text = readFileSync(file, 'utf8');
    const name = relative(src, file);
    assert.doesNotMatch(text, /window\.open\(/, name);
    // Forms post only to this site's own fixed paths (sign-up, the staging password), never to
    // a checkout link or another site.
    assert.doesNotMatch(text, /<form[^>]*\saction=(?!"\/[\w-]+")/, name);
    // Pro plan purchases have their own checkout (Settings > Plan, lib/pro-buy.ts); a tip's
    // checkout link is read only by the tip form.
    if (/checkoutUrl/.test(text) && file !== formPath)
      assert.match(name, /(^|\/)(pro-[\w-]+\.ts|sections\/plan\.tsx)$/, name);
  }
});

test('the form refuses an amount the quote does not match', () => {
  assert.match(
    form,
    /Number\(current\.tipMinor\) !== amount \|\|\s*Number\(current\.payerTotalMinor\) !== amount/,
  );
});
