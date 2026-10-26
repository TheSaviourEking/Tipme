import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as ui from '../dist/index.js';

const css = await readFile(
  new URL('../src/components.css', import.meta.url),
  'utf8',
);

test('the public UI API exposes material surfaces and amount choices', () => {
  assert.equal(typeof ui.Surface, 'function');
  assert.equal(typeof ui.Card, 'function');
  assert.equal(typeof ui.AmountChoice, 'function');
  assert.equal(typeof ui.Button, 'function');
});

test('shared primitives implement semantic material and interaction states', () => {
  for (const selector of [
    '.tm-surface--raised',
    '.tm-surface--recessed',
    '.tm-surface--signature',
    '.tm-button[aria-busy=',
    '.tm-choice input:checked + span',
    '@media (hover: hover)',
    '@media (forced-colors: active)',
  ]) {
    assert.ok(css.includes(selector), `missing ${selector}`);
  }
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i);
});
