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
    h(ui.ResultKey, { result: { kind: 'done', label: 'Saved.' } }, 'Save'),
    h(
      ui.ResultKey,
      {
        result: {
          kind: 'failed',
          label: 'Not saved',
          retryLabel: 'Try again',
          onRetry() {},
        },
      },
      'Save',
    ),
    h(ui.StateLine, { tone: 'error' }),
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
  for (const file of ['components.tsx', 'result-key.tsx']) {
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

test('at rest a result key is the same button', () => {
  const html = renderToStaticMarkup(
    h(
      ui.ResultKey,
      { type: 'submit', variant: 'continue' },
      'Save notifications',
    ),
  );
  assert.match(
    html,
    /<button type="submit" class="tm-button tm-button--continue"/,
  );
  assert.match(html, />Save notifications<\/button>$/);
  assert.equal(
    html,
    renderToStaticMarkup(
      h(
        ui.Button,
        { type: 'submit', variant: 'continue' },
        'Save notifications',
      ),
    ),
  );
});

test('done: the key face shows a purple lamp and the label, and the button keeps its props', () => {
  const html = renderToStaticMarkup(
    h(
      ui.ResultKey,
      {
        type: 'submit',
        disabled: false,
        result: { kind: 'done', label: 'Saved.' },
      },
      'Save',
    ),
  );
  assert.match(html, /^<button type="submit"/);
  assert.match(html, /data-result="done"/);
  assert.match(html, /tm-key-result--done/);
  assert.match(html, /tm-lamp--purple/);
  assert.match(html, /Saved\.<\/button>/);
  assert.doesNotMatch(html, />Save<\/button>/);
});

test('failed: a red lamp and the label on the face, and Try again is a real button', () => {
  const html = renderToStaticMarkup(
    h(
      ui.ResultKey,
      {
        result: {
          kind: 'failed',
          label: 'Not saved',
          detail: '· notifications',
          retryLabel: 'Try again',
          onRetry() {},
        },
      },
      'Save',
    ),
  );
  assert.match(
    html,
    /class="tm-key-result tm-key-result--failed" data-result="failed"/,
  );
  assert.match(html, /tm-lamp--red.*Not saved<small>· notifications<\/small>/s);
  assert.match(
    html,
    /<button type="button" class="tm-key-result__again">Try again<\/button>/,
  );
  assert.doesNotMatch(html, />Save</);
});

test('a state line is always mounted: an alert for errors, a status otherwise, and can be hidden', () => {
  assert.equal(
    renderToStaticMarkup(h(ui.StateLine, { tone: 'error' })),
    '<p class="tm-state-line" role="alert"></p>',
  );
  assert.match(
    renderToStaticMarkup(
      h(ui.StateLine, { tone: 'status', visuallyHidden: true }, 'Saved.'),
    ),
    /class="tm-state-line sr-only" role="status">Saved\./,
  );
});

test('useKeyResult is exported for the client', () => {
  assert.equal(typeof ui.useKeyResult, 'function');
});

test('key CSS: the split key keeps 44px targets and wraps, and reduced motion stops the settle', () => {
  assert.match(css, /\.tm-key-result__again\s*\{[^}]*min-height: 44px/);
  assert.match(css, /\.tm-key-result--failed\s*\{[^}]*min-height: 52px/);
  assert.doesNotMatch(
    css.slice(css.indexOf('.tm-key-result')),
    /white-space: nowrap/,
  );
  const reduced = css.slice(
    css.lastIndexOf('@media (prefers-reduced-motion: reduce)'),
  );
  assert.match(reduced, /\.tm-key-result--done[^{]*\{[^}]*transform: none/);
});

test('a field with an error is invalid, its line is linked, and the flag is hidden from screen readers', () => {
  const html = renderToStaticMarkup(
    h(ui.InputField, {
      id: 'a',
      label: 'Other amount',
      error: 'Enter an amount of NGN 2,000 or more.',
      flag: 'below 2,000',
    }),
  );
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /aria-describedby="a-error"/);
  assert.match(html, /<div class="tm-input-wrap"><input/);
  assert.match(
    html,
    /<span class="tm-field-flag" aria-hidden="true"><span class="tm-lamp tm-lamp--red" aria-hidden="true"><\/span>below 2,000<\/span>/,
  );
  assert.match(html, /<p class="tm-field-error" id="a-error" role="alert">/);
});

test('without an error the flag never shows, and the markup is as before', () => {
  const html = renderToStaticMarkup(
    h(ui.InputField, { id: 'a', label: 'L', flag: 'below 2,000' }),
  );
  assert.doesNotMatch(html, /tm-field-flag|tm-input-wrap|flag=/);
  assert.equal(
    html,
    renderToStaticMarkup(h(ui.InputField, { id: 'a', label: 'L' })),
  );
  const area = renderToStaticMarkup(
    h(ui.TextareaField, { id: 't', label: 'L', error: 'E', flag: 'too long' }),
  );
  assert.match(area, /<div class="tm-input-wrap"><textarea/);
});

test('state CSS: the red edge, one shake that reduced motion stops, edges in forced colours', () => {
  assert.match(
    css,
    /\.tm-input\[aria-invalid='true'\]\s*\{[^}]*inset 3px 0 0 var\(--lamp-red\)/,
  );
  assert.doesNotMatch(
    css,
    /\.tm-input\[aria-invalid='true'\]\s*\{[^}]*--state-danger-soft/,
  );
  assert.match(css, /@keyframes tm-shake/);
  const reduced = css.slice(
    css.lastIndexOf('@media (prefers-reduced-motion: reduce)'),
  );
  assert.match(reduced, /\.tm-input[^{]*\{[^}]*animation: none/);
  const forced = css.slice(css.indexOf('@media (forced-colors: active)'));
  for (const s of [
    '.tm-slip',
    '.tm-warning',
    '.tm-lamp',
    '.tm-key-result__face',
  ])
    assert.ok(forced.includes(s), `forced colours miss ${s}`);
});
