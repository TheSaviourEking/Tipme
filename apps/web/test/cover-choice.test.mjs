import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  choiceBody,
  draftFromChoice,
  draftPreview,
  sameDraft,
  takesColours,
} from '../src/lib/cover-choice.ts';

test('nothing chosen starts with no design and the neutral colour', () => {
  assert.deepEqual(draftFromChoice(undefined), {
    design: null,
    colour: 'neutral',
  });
  assert.deepEqual(
    draftFromChoice({ design: null, colour: null, hasPhoto: false }),
    { design: null, colour: 'neutral' },
  );
});

test('a saved design and colour are kept', () => {
  assert.deepEqual(
    draftFromChoice({ design: 'ripple', colour: 'forest', hasPhoto: false }),
    { design: 'ripple', colour: 'forest' },
  );
});

test('a design the catalogue dropped falls back to nothing chosen', () => {
  assert.deepEqual(
    draftFromChoice({ design: 'retired', colour: 'violet', hasPhoto: false }),
    { design: null, colour: 'neutral' },
  );
});

test('a dropped colour falls back to neutral, and a design without colours ignores it', () => {
  assert.deepEqual(
    draftFromChoice({ design: 'large', colour: 'gone', hasPhoto: false }),
    { design: 'large', colour: 'neutral' },
  );
  assert.deepEqual(
    draftFromChoice({ design: 'indigo', colour: 'violet', hasPhoto: false }),
    { design: 'indigo', colour: 'neutral' },
  );
});

test('only heart designs other than dark take colours', () => {
  assert.equal(takesColours('scattered'), true);
  assert.equal(takesColours('rising'), true);
  assert.equal(takesColours('dark'), false);
  assert.equal(takesColours('indigo'), false);
  assert.equal(takesColours(null), false);
  assert.equal(takesColours('nope'), false);
});

test('the request sends a colour only for designs that take one', () => {
  // Going back to automatic is a save too: the API takes `design: null` as "TipMe picks".
  assert.deepEqual(choiceBody({ design: null, colour: 'neutral' }), {
    design: null,
  });
  assert.deepEqual(choiceBody({ design: 'outline', colour: 'rose' }), {
    design: 'outline',
    colour: 'rose',
  });
  assert.deepEqual(choiceBody({ design: 'dark', colour: 'rose' }), {
    design: 'dark',
  });
});

test('the preview shows the draft, or the automatic design for the handle', () => {
  assert.deepEqual(draftPreview({ design: 'ripple', colour: 'ocean' }, 'ada'), {
    kind: 'design',
    design: 'ripple',
    colour: 'ocean',
  });
  assert.equal(
    draftPreview({ design: null, colour: 'neutral' }, 'ada').kind,
    'design',
  );
});

test('drafts compare by what would be saved', () => {
  assert.equal(
    sameDraft(
      { design: 'dark', colour: 'rose' },
      { design: 'dark', colour: 'neutral' },
    ),
    true,
  );
  assert.equal(
    sameDraft(
      { design: 'large', colour: 'rose' },
      { design: 'large', colour: 'neutral' },
    ),
    false,
  );
});

test('going back to the automatic cover counts as a change from a saved design', () => {
  const saved = { design: 'ripple', colour: 'forest' };
  const automatic = { design: null, colour: 'forest' };
  assert.equal(sameDraft(automatic, saved), false);
  assert.equal(sameDraft(automatic, { design: null, colour: 'neutral' }), true);
});
