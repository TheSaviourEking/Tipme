import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const tokens = await readFile(
  new URL('../src/tokens.css', import.meta.url),
  'utf8',
);
const components = await readFile(
  new URL('../src/components.css', import.meta.url),
  'utf8',
);

test('the material contract exposes one semantic token for every physical role', () => {
  for (const name of [
    'canvas',
    'surface-raised',
    'surface-recessed',
    'surface-signature',
    'edge-light',
    'border-material',
    'shadow-raised-1',
    'shadow-raised-2',
    'shadow-recessed',
    'radius-control',
    'radius-field',
    'radius-card',
    'font-interface',
    'font-editorial',
    'numeric-variant',
    'duration-tactile',
    'duration-component',
    'duration-spatial',
    'duration-appreciation',
    'ease-physical',
  ]) {
    const declarations = tokens.match(new RegExp(`--${name}:`, 'g')) ?? [];
    assert.equal(declarations.length, 1, `--${name} must be declared once`);
  }
});

test('the locked palette remains exact and shared components use semantic elevation', () => {
  assert.match(tokens, /--brand-primary:\s*#7a32f9;/i);
  assert.match(tokens, /--surface-base:\s*#ffffff;/i);
  assert.match(tokens, /--text-primary:\s*#000000;/i);
  assert.doesNotMatch(components, /var\(--shadow-(?:card|float)\)/);
});
