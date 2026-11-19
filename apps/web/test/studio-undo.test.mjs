import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PRO_UNDO_REFUSED,
  UNDO_PAUSE_MS,
  createUndoStack,
  describeChange,
  undoButtonName,
} from '../src/app/dashboard/studio/undo-stack.ts';

// Page Studio undo (styles spec §12.2; plan Task 15, PR 5b): a step is each change to style,
// accent, mode, cover, block order, adding or removing a block, or one field of a block per pause
// (the 800 ms save debounce). The stack is in memory and holds at most 50 steps.

const base = {
  v: 2,
  style: 'classic',
  accent: null,
  mode: 'light',
  cover: 'yours',
  blocks: [
    { id: 'undo0001', kind: 'text', variant: 'heading', text: 'New single' },
    { id: 'undo0002', kind: 'quote', text: 'Sang like home.' },
    {
      id: 'undo0003',
      kind: 'text',
      variant: 'paragraph',
      text: 'Out on Friday.',
    },
  ],
};
const doc = (patch) => ({ ...base, ...patch });

/** A clock the test moves by hand. */
function clock() {
  let t = 1_000_000;
  return {
    now: () => t,
    wait: (ms) => {
      t += ms;
    },
  };
}

test('each change is one step and field edits coalesce per pause', () => {
  const time = clock();
  const stack = createUndoStack(50, time.now);
  const a = doc({});
  const b = doc({ style: 'clear' });
  const c = doc({ style: 'clear', accent: 'rose' });
  stack.push(a, 'style changed to Clear');
  stack.push(b, 'accent changed to Rose');
  assert.equal(stack.size, 2);

  // Typing a heading: three edits inside one pause are one step, back to before the first.
  const typed = (text) =>
    doc({
      style: 'clear',
      accent: 'rose',
      blocks: [{ ...base.blocks[0], text }, ...base.blocks.slice(1)],
    });
  stack.push(c, 'heading edited', 'undo0001:text');
  time.wait(300);
  stack.push(typed('New s'), 'heading edited', 'undo0001:text');
  time.wait(UNDO_PAUSE_MS - 1);
  stack.push(typed('New si'), 'heading edited', 'undo0001:text');
  assert.equal(stack.size, 3);
  // A pause ends the step: the next edit to the same field is a new one.
  time.wait(UNDO_PAUSE_MS);
  stack.push(typed('New sin'), 'heading edited', 'undo0001:text');
  assert.equal(stack.size, 4);
  // Another field is another step, pause or not.
  stack.push(typed('New sing'), 'paragraph edited', 'undo0003:text');
  assert.equal(stack.size, 5);
  // A change that isn't a field edit never merges into one.
  stack.push(typed('New sing'), 'block moved');
  stack.push(typed('New sing'), 'block moved');
  assert.equal(stack.size, 7);

  stack.pop();
  stack.pop();
  assert.equal(stack.pop()?.label, 'paragraph edited');
  assert.deepEqual(stack.pop()?.doc, typed('New sin'));
  // The coalesced step goes back to the draft before its first edit.
  const first = stack.pop();
  assert.equal(first?.label, 'heading edited');
  assert.deepEqual(first?.doc, c);
  // After an undo, the next edit to that field starts a new step even inside the pause.
  stack.push(c, 'heading edited', 'undo0001:text');
  time.wait(10);
  stack.push(typed('X'), 'heading edited', 'undo0001:text');
  assert.equal(stack.size, 3);
  assert.deepEqual(stack.pop()?.doc, c);
  assert.deepEqual(stack.pop()?.doc, b);
  assert.deepEqual(stack.pop()?.doc, a);
  assert.equal(stack.pop(), null);
  assert.equal(stack.size, 0);

  stack.push(a, 'style changed to Clear');
  stack.clear();
  assert.equal(stack.size, 0);
  assert.equal(stack.peek(), null);
});

test('the stack holds at most 50 steps', () => {
  const stack = createUndoStack();
  for (let i = 0; i < 60; i++)
    stack.push(doc({ blocks: base.blocks.slice(0, i % 3) }), `step ${i}`);
  assert.equal(stack.size, 50);
  // The oldest ten went; the newest is on top.
  assert.equal(stack.peek()?.label, 'step 59');
  let last = null;
  while (stack.size) last = stack.pop();
  assert.equal(last?.label, 'step 10');

  const small = createUndoStack(3);
  for (let i = 0; i < 5; i++) small.push(doc({}), `s${i}`);
  assert.equal(small.size, 3);
});

test('the undo label says what it undoes', () => {
  const said = (prev, next) => describeChange(prev, next)?.label;
  assert.equal(said(base, doc({ style: 'clear' })), 'style changed to Clear');
  assert.equal(said(base, doc({ accent: 'rose' })), 'accent changed to Rose');
  assert.equal(
    said(doc({ accent: 'rose' }), doc({ accent: null })),
    'accent changed to TipMe purple',
  );
  assert.equal(said(base, doc({ mode: 'dark' })), 'mode changed to Dark');
  assert.equal(
    said(base, doc({ cover: 'gradient' })),
    'cover changed to Gradient',
  );
  // A style switch that also moves the cover is a style change.
  assert.equal(
    said(
      doc({ cover: 'gradient' }),
      doc({ style: 'signboard', cover: 'yours' }),
    ),
    'style changed to Signboard',
  );
  const [h, q, p] = base.blocks;
  assert.equal(said(base, doc({ blocks: [q, h, p] })), 'block moved');
  assert.equal(said(base, doc({ blocks: [h, p] })), 'block removed');
  assert.equal(
    said(
      base,
      doc({
        blocks: [...base.blocks, { id: 'undo0004', kind: 'quote', text: '' }],
      }),
    ),
    'block added',
  );
  const heading = describeChange(
    base,
    doc({ blocks: [{ ...h, text: 'New album' }, q, p] }),
  );
  assert.deepEqual(heading, {
    label: 'heading edited',
    field: 'undo0001:text',
  });
  assert.deepEqual(
    describeChange(base, doc({ blocks: [h, { ...q, text: 'Hi' }, p] })),
    { label: 'quote edited', field: 'undo0002:text' },
  );
  assert.equal(
    said(base, doc({ blocks: [h, q, { ...p, text: 'Soon.' }] })),
    'paragraph edited',
  );
  // A field inside a list item is its own field.
  const services = {
    id: 'undo0005',
    kind: 'services',
    items: [{ name: 'Lessons', priceMinor: '500000' }],
  };
  assert.deepEqual(
    describeChange(
      doc({ blocks: [services] }),
      doc({
        blocks: [
          { ...services, items: [{ name: 'Lesson', priceMinor: '500000' }] },
        ],
      }),
    ),
    { label: 'services edited', field: 'undo0005:items.0.name' },
  );
  // Nothing changed: no step.
  assert.equal(describeChange(base, doc({})), null);

  assert.equal(
    undoButtonName('style changed to Clear'),
    'Undo: style changed to Clear',
  );
  assert.equal(undoButtonName(null), 'Undo');
  assert.equal(
    PRO_UNDO_REFUSED,
    'Adding this back needs Pro. Everything else is kept.',
  );
});
