import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as ui from '../dist/index.js';

const css = await readFile(
  new URL('../src/components.css', import.meta.url),
  'utf8',
);

test('a lamp is decoration: hidden from screen readers, one class per tone', () => {
  for (const tone of ['red', 'amber', 'purple', 'off']) {
    const html = renderToStaticMarkup(h(ui.Lamp, { tone }));
    assert.match(html, new RegExp(`class="tm-lamp tm-lamp--${tone}"`));
    assert.match(html, /aria-hidden="true"/);
  }
});
