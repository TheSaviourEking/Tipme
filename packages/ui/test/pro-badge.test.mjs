import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as ui from '../dist/index.js';

// The Pro badge, option A (owner's default ruling, 11 Nov 2026): a paid plan, never a check.
const css = await readFile(
  new URL('../src/components.css', import.meta.url),
  'utf8',
);

test('the plain badge is unchanged: the spark and the word Pro, nothing to press', () => {
  const html = renderToStaticMarkup(h(ui.ProBadge));
  assert.match(html, /class="tm-pro-badge"/);
  assert.match(html, />Pro<\/span>$/);
  assert.doesNotMatch(html, /<button/);
});

test('explain makes the badge a real button named as a paid plan, with its note closed', () => {
  const html = renderToStaticMarkup(h(ui.ProBadge, { explain: true }));
  assert.match(html, /<button type="button"/);
  assert.match(html, /aria-label="TipMe Pro, a paid plan"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="[^"]+"/);
  assert.match(html, /class="tm-pro-badge"/);
  // The note is there for the button to point at, and hidden until it is asked for.
  const id = /aria-controls="([^"]+)"/.exec(html)?.[1];
  assert.match(html, new RegExp(`id="${id}"[^>]*hidden`));
  assert.match(
    html,
    /TipMe Pro is a paid plan\. It doesn’t mean TipMe checked who runs this page\./,
  );
  assert.match(html, /<a href="\/pro">About Pro<\/a>/);
});

test('the badge never looks or reads like a verified mark', () => {
  for (const html of [
    renderToStaticMarkup(h(ui.ProBadge)),
    renderToStaticMarkup(h(ui.ProBadge, { explain: true })),
  ]) {
    assert.doesNotMatch(html, /verif/i);
    // The tick of "Verified business" is a stroked path; the spark is a filled one.
    assert.doesNotMatch(html, /stroke/);
  }
});

test('the badge button is a 44px target and shows focus', () => {
  const rule = /\.tm-pro-badge-button\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.match(rule, /min-height:\s*44px/);
  assert.match(rule, /min-width:\s*44px/);
  assert.ok(css.includes('.tm-pro-badge-button:focus-visible'));
  assert.ok(css.includes('.tm-pro-badge-note'));
});
