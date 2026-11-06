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

test('a stamp is read aloud, in its own words, one class per tone', () => {
  for (const tone of ['wait', 'ok', 'bad', 'ink']) {
    const html = renderToStaticMarkup(h(ui.Stamp, { tone }, 'Paid'));
    assert.equal(html, `<span class="tm-stamp tm-stamp--${tone}">Paid</span>`);
  }
  assert.equal(
    renderToStaticMarkup(h(ui.Stamp, { tone: 'ok', className: 'x' }, 'Paid')),
    '<span class="tm-stamp tm-stamp--ok x">Paid</span>',
  );
  // It doesn't move, and the word reads as a stamp in capitals only through CSS.
  const rule = css.match(/\.tm-stamp\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(rule, /text-transform: uppercase/);
  assert.match(rule, /border: 1\.5px solid currentColor/);
  assert.doesNotMatch(rule, /animation|transition/);
  for (const [tone, colour] of [
    ['wait', '--brand-ink'],
    ['ok', '--stamp-ok'],
    ['bad', '--state-danger'],
    ['ink', '--stamp-ink'],
  ])
    assert.match(
      css,
      new RegExp(`\\.tm-stamp--${tone}\\s*\\{[^}]*color: var\\(${colour}\\)`),
      tone,
    );
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
    h(ui.Steps, { labels: ['One', 'Two', 'Three'], filled: 1 }),
    h(ui.Steps, { labels: ['One', 'Two', 'Three'], filled: 0, failed: true }),
    h(ui.EmptySlip, {
      title: 'T',
      caption: 'C',
      action: h('button', null, 'Go'),
    }),
    h(ui.EmptyWell, { title: 'T', action: h('button', null, 'Go') }),
    h(ui.InputField, { id: 'f', label: 'L', error: 'E', flag: 'F' }),
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
      /money is (safe|fine)|haven[’']t paid|back in your balance|nothing was (taken|charged)|weren[’']t charged|refunded/i,
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
    /<button type="button" class="tm-key-result__again" aria-describedby="[^"]+">Try again<\/button>/,
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

test('without an error the flag text never shows, but a flagged field keeps its wrap so the input never remounts', () => {
  const calm = renderToStaticMarkup(
    h(ui.InputField, { id: 'a', label: 'L', flag: 'below 2,000' }),
  );
  assert.match(calm, /<div class="tm-input-wrap"><input/);
  assert.doesNotMatch(calm, /tm-field-flag|below 2,000/);
  const invalid = renderToStaticMarkup(
    h(ui.InputField, { id: 'a', label: 'L', flag: 'below 2,000', error: 'E' }),
  );
  // The same element path to the input with and without the error: React keeps the input.
  const path = (html) => html.slice(0, html.indexOf('<input'));
  assert.equal(
    path(calm).replace(/ aria-invalid="false"/, ''),
    path(invalid).replace(/ aria-invalid="true"/, ''),
  );
  // Without a flag prop the markup is as before.
  assert.doesNotMatch(
    renderToStaticMarkup(h(ui.InputField, { id: 'a', label: 'L', error: 'E' })),
    /tm-input-wrap/,
  );
  const area = renderToStaticMarkup(
    h(ui.TextareaField, { id: 't', label: 'L', error: 'E', flag: 'too long' }),
  );
  assert.match(area, /<div class="tm-input-wrap"><textarea/);
});

test('state CSS: the red edge, one shake that reduced motion stops, edges in forced colours', () => {
  // Doubled class: app rules such as .withdraw__form .tm-input must not reset the edge.
  assert.match(
    css,
    /\.tm-input\.tm-input\[aria-invalid='true'\]\s*\{[^}]*inset 3px 0 0 var\(--lamp-red\)/,
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
    '.tm-empty-well',
    '.tm-empty-slip',
    '.tm-stamp',
  ])
    assert.ok(forced.includes(s), `forced colours miss ${s}`);
});

test('an empty slip keeps a real heading, hides its blank, and has one action', () => {
  const html = renderToStaticMarkup(
    h(ui.EmptySlip, {
      title: 'No tips here yet.',
      caption: 'Your first note lands here',
      action: h('button', null, 'Copy your link'),
    }),
  );
  assert.match(html, /<div class="tm-empty-slip__blank" aria-hidden="true">/);
  assert.match(
    html,
    /<h2 class="tm-empty-slip__title">No tips here yet\.<\/h2>/,
  );
  assert.equal(html.match(/<button/g).length, 1);
});

test('an empty well has an unlit lamp and an h3 when asked', () => {
  const html = renderToStaticMarkup(
    h(ui.EmptyWell, { title: 'Nothing is waiting', headingLevel: 3 }),
  );
  assert.match(html, /tm-lamp--off/);
  assert.match(html, /<h3[^>]*>Nothing is waiting<\/h3>/);
  assert.doesNotMatch(html, /<p/);
});

test('steps say done or not yet, and a failure lights only the first lamp red', () => {
  const labels = ['Requested', 'Sent to our payment partner', 'Paid'];
  const two = renderToStaticMarkup(h(ui.Steps, { labels, filled: 2 }));
  assert.match(two, /^<ol class="tm-steps" aria-label="Progress">/);
  assert.equal(two.match(/tm-lamp--purple/g).length, 2);
  assert.equal(two.match(/tm-lamp--off/g).length, 1);
  assert.equal(two.match(/data-filled="true"/g).length, 2);
  assert.match(two, /Paid<\/span><span class="sr-only">, not yet<\/span>/);
  assert.match(two, /Requested<\/span><span class="sr-only">, done<\/span>/);
  const failed = renderToStaticMarkup(
    h(ui.Steps, { labels, filled: 0, failed: true }),
  );
  assert.equal(failed.match(/tm-lamp--red/g).length, 1);
  assert.equal(failed.match(/tm-lamp--off/g).length, 2);
  assert.match(
    failed,
    /Requested<\/span><span class="sr-only">, didn’t go through<\/span>/,
  );
  assert.match(
    renderToStaticMarkup(
      h(ui.Steps, { labels, filled: 1, label: 'Withdrawal' }),
    ),
    /aria-label="Withdrawal"/,
  );
});

test('an error line is black only beside an invalid field; a line with no edge stays red', () => {
  // The rule for .tm-field-error alone (not the shared .tm-hint, .tm-field-error block).
  const base = css.match(/\}\n\n\.tm-field-error\s*\{([^}]*)\}/);
  assert.ok(base, 'base .tm-field-error rule');
  assert.match(base[1], /color: var\(--state-danger\)/);
  assert.match(
    css,
    /\.tm-field:has\(\.tm-input\[aria-invalid='true'\]\)\s*>\s*\.tm-field-error\s*\{[^}]*color: var\(--text-primary\)/,
  );
});

test('the flag reserves its space only when shown, above app padding, and centres in any height', () => {
  assert.match(
    css,
    /\.tm-input-wrap:has\(\.tm-field-flag\)\s*>\s*\.tm-input\s*\{[^}]*padding-inline-end: var\(--flag-space\)/,
  );
  const flag = css.match(/\n\.tm-field-flag\s*\{([^}]*)\}/);
  assert.ok(flag);
  assert.match(flag[1], /inset-block: 0/);
  assert.doesNotMatch(flag[1], /(^|\s)height:/);
});

test('Try again is described by the key face, and the failed key keeps the caller’s id, test id and description', () => {
  const html = renderToStaticMarkup(
    h(
      ui.ResultKey,
      {
        id: 'save',
        'data-testid': 'save-key',
        'aria-describedby': 'save-line',
        result: {
          kind: 'failed',
          label: 'Not saved',
          retryLabel: 'Try again',
          onRetry() {},
        },
      },
      'Save',
    ),
  );
  assert.match(
    html,
    /^<div class="tm-key-result tm-key-result--failed" data-result="failed" id="save" data-testid="save-key">/,
  );
  const face = html.match(/<span class="tm-key-result__face" id="([^"]+)">/);
  assert.ok(face, 'the face has an id');
  assert.match(
    html,
    new RegExp(
      `class="tm-key-result__again" aria-describedby="${face[1]} save-line"`,
    ),
  );
});

test('a pending key stays focusable: aria-busy and aria-disabled, never disabled', () => {
  const html = renderToStaticMarkup(
    h(ui.ResultKey, { pending: true, variant: 'continue' }, 'Save'),
  );
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /aria-disabled="true"/);
  assert.doesNotMatch(html, / disabled=""/);
});

test('a slip inside an existing live region can drop or change its role', () => {
  assert.doesNotMatch(
    renderToStaticMarkup(
      h(ui.Slip, { tone: 'error', title: 'T', live: 'none' }),
    ),
    /role=/,
  );
  assert.match(
    renderToStaticMarkup(
      h(ui.Slip, { tone: 'error', title: 'T', live: 'status' }),
    ),
    /role="status"/,
  );
});

test('warnings, empties and steps pass className, id and data-testid through', () => {
  const props = { className: 'x', id: 'i', 'data-testid': 't' };
  for (const el of [
    h(ui.StandingWarning, { title: 'T', ...props }),
    h(ui.EmptySlip, { title: 'T', ...props }),
    h(ui.EmptyWell, { title: 'T', ...props }),
    h(ui.Steps, { labels: ['A'], filled: 0, ...props }),
  ]) {
    const html = renderToStaticMarkup(el);
    assert.match(html, /^<[a-z]+ class="[^"]*\bx\b[^"]*"/, html);
    assert.match(html, /id="i"/, html);
    assert.match(html, /data-testid="t"/, html);
  }
});

test('empties wrap their explanation in a div, so block content nests validly', () => {
  for (const el of [
    h(ui.EmptySlip, { title: 'T' }, h('p', null, 'Body')),
    h(ui.EmptyWell, { title: 'T' }, h('p', null, 'Body')),
  ]) {
    const html = renderToStaticMarkup(el);
    assert.match(
      html,
      /<div class="tm-empty-(slip|well)__body"><p>Body<\/p><\/div>/,
    );
  }
});

test('a failed key with no retry has no Try again button, never a dead one', () => {
  const html = renderToStaticMarkup(
    h(
      ui.ResultKey,
      {
        result: { kind: 'failed', label: 'Not saved', retryLabel: 'Try again' },
      },
      'Save',
    ),
  );
  assert.match(html, /data-result="failed"/);
  assert.match(html, /Not saved/);
  assert.doesNotMatch(html, /tm-key-result__again|Try again/);
});

test('useKeyResult needs its retry: the hook takes onRetry, not a bare duration', async () => {
  const source = await readFile(
    new URL('../src/result-key.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /onRetry: \(\) => void;/);
  assert.doesNotMatch(source, /onRetry\?: \(\) => void/);
  assert.doesNotMatch(source, /options: number \|/);
});
