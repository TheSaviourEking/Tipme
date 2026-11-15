import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Make-it-yours PR D owns the selected key's fill and edge (--page-accent); the public form's
// restyle may add a highlight and an inner edge, never the colour.
const css = readFileSync(
  new URL('../src/app/globals.css', import.meta.url),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

function rules(text) {
  const found = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of text.matchAll(pattern))
    found.push({ selector: match[1].trim(), body: match[2] });
  return found;
}

test('the restyle never sets the selected key’s fill or edge', () => {
  const checked = rules(css).filter(
    ({ selector }) =>
      selector.includes('.profile-composer') &&
      selector.includes(':checked + span'),
  );
  assert.ok(checked.length > 0, 'the restyle styles the selected key');
  for (const { selector, body } of checked) {
    assert.doesNotMatch(body, /(^|;|\s)background-color\s*:/, selector);
    assert.doesNotMatch(body, /(^|;|\s)border(-color)?\s*:/, selector);
    // A `background:` shorthand would reset the colour; only background-image is allowed.
    assert.doesNotMatch(body, /(^|;|\s)background\s*:/, selector);
  }
});
