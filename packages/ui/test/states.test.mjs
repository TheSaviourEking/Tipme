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

test('an error or unsure slip is an alert; waiting, done and neutral are status', () => {
  for (const [tone, role] of [
    ['error', 'alert'],
    ['unsure', 'alert'],
    ['waiting', 'status'],
    ['done', 'status'],
    ['neutral', 'status'],
  ]) {
    const html = renderToStaticMarkup(h(ui.Slip, { tone, title: 'T' }));
    assert.match(html, new RegExp(`role="${role}"`), tone);
    assert.match(html, new RegExp(`tm-slip--${tone}`));
  }
  assert.match(
    renderToStaticMarkup(h(ui.Slip, { title: 'T' })),
    /role="status"/,
  );
});

test('the stamp is hidden from screen readers and the title says what happened', () => {
  const html = renderToStaticMarkup(
    h(ui.Slip, { tone: 'error', title: 'Not sent yet', stamp: 'Not\nsent' }),
  );
  assert.match(
    html,
    /<span class="tm-slip__stamp tm-slip__stamp--red" aria-hidden="true">Not<br\/>sent<\/span>/,
  );
  assert.match(html, /<strong class="tm-slip__title">Not sent yet<\/strong>/);
  assert.match(html, /tm-slip--stamped/);
});

test('a done slip has a purple stamp and an unsure slip an ink one', () => {
  assert.match(
    renderToStaticMarkup(
      h(ui.Slip, { tone: 'done', title: 'T', stamp: 'Done' }),
    ),
    /tm-slip__stamp--purple/,
  );
  assert.match(
    renderToStaticMarkup(
      h(ui.Slip, { tone: 'unsure', title: 'T', stamp: 'Check' }),
    ),
    /tm-slip__stamp--ink/,
  );
});

test('the safe line renders only when given, inside the slip', () => {
  assert.doesNotMatch(
    renderToStaticMarkup(h(ui.Slip, { tone: 'error', title: 'T' })),
    /tm-slip__safe/,
  );
  assert.match(
    renderToStaticMarkup(
      h(ui.Slip, {
        tone: 'error',
        title: 'T',
        safe: 'You haven’t paid anything.',
      }),
    ),
    /class="tm-slip__safe".*You haven’t paid anything\./s,
  );
});

// Owner rule (states plan, Money-safety proofs): a reassuring money line appears only where the
// code proves it, so only the caller may supply one. No primitive invents "your money is safe".
test('no state primitive renders a money-safety line unless the caller passes one', async () => {
  const reassurance =
    /tm-slip__safe|money|safe|paid|balance|refund|nothing (was|has been) (taken|charged)/i;
  const renders = [];
  for (const tone of ['error', 'unsure', 'waiting', 'done', 'neutral'])
    for (const dense of [false, true])
      for (const stamp of [undefined, 'Not\nsent'])
        renders.push(
          h(ui.Slip, {
            tone,
            dense,
            stamp,
            title: 'T',
            actions: h('button', null, 'Go'),
          }),
        );
  renders.push(
    h(ui.StandingWarning, { title: 'T', actions: h('button', null, 'Go') }),
  );
  for (const html of renders.map((el) => renderToStaticMarkup(el)))
    assert.doesNotMatch(html, reassurance, html);
  for (const empty of [false, null, '']) {
    const html = renderToStaticMarkup(
      h(ui.Slip, { tone: 'error', title: 'T', safe: empty }),
    );
    assert.doesNotMatch(html, /tm-slip__safe/, `safe=${String(empty)}`);
  }
  // And no reassuring words are written into the primitives' source.
  for (const file of ['components.tsx']) {
    const source = await readFile(
      new URL(`../src/${file}`, import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(
      source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''),
      /money is safe|haven[’']t paid|back in your balance|nothing was taken/i,
      file,
    );
  }
});

test('no state primitive puts "!" or "✓" in front of words', () => {
  for (const tone of ['error', 'unsure', 'waiting', 'done', 'neutral'])
    assert.doesNotMatch(
      renderToStaticMarkup(h(ui.Slip, { tone, title: 'Saved' })),
      /[!✓]\s*Saved/,
    );
});

test('a standing warning is a polite status with an amber lamp, never an alert', () => {
  const html = renderToStaticMarkup(
    h(
      ui.StandingWarning,
      { title: 'Withdrawals are OFF for everyone' },
      'Body',
    ),
  );
  assert.match(html, /^<div class="tm-warning" role="status">/);
  assert.match(html, /tm-lamp--amber/);
  assert.doesNotMatch(html, /role="alert"/);
});
