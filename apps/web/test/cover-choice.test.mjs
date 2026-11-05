import assert from 'node:assert/strict';
import { test } from 'node:test';
import { automaticColour, automaticCover } from '@tipme/contracts';
import {
  automaticLabel,
  choiceBody,
  draftFromChoice,
  differsFromSaved,
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

// Settings' "Let TipMe pick" must show what the page shows, in the same colour, and name it in
// words so the colour is never the only signal.
test('"Let TipMe pick" previews the handle’s automatic design and colour whatever the draft colour', () => {
  for (const handle of ['ada', 'tobi', 'chioma', 'emeka', 'a1b']) {
    for (const colour of ['neutral', 'rose', 'ocean']) {
      assert.deepEqual(draftPreview({ design: null, colour }, handle), {
        kind: 'design',
        design: automaticCover(handle),
        colour: automaticColour(handle),
      });
    }
  }
});

test('the automatic pick is named, design and colour', () => {
  assert.equal(automaticLabel('ada'), 'One large heart in Ocean');
  assert.equal(automaticLabel('tobi'), 'Rising hearts in Violet');
  assert.equal(automaticLabel('emeka'), 'Scattered hearts in Violet');
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

// Animated covers (owner's decision, 2 Nov 2026): a draft may hold an animation, a motion and,
// on Pro, a colour of its own.
test('choiceBody for a Free animation sends no motion and no colour', () => {
  const draft = {
    design: null,
    colour: 'neutral',
    animation: 'drift',
    motion: 'loop',
    animationColour: 'ocean',
  };
  assert.deepEqual(choiceBody(draft, false), {
    design: null,
    animation: 'drift',
  });
});

test('choiceBody for a Pro animation sends its motion and colour', () => {
  const draft = {
    design: null,
    colour: 'neutral',
    animation: 'night',
    motion: 'loop',
    animationColour: 'ocean',
  };
  assert.deepEqual(choiceBody(draft, true), {
    design: null,
    animation: 'night',
    motion: 'loop',
    colour: 'ocean',
  });
  assert.deepEqual(choiceBody({ ...draft, animationColour: null }, true), {
    design: null,
    animation: 'night',
    motion: 'loop',
  });
  // A still design is as before, on any plan.
  assert.deepEqual(choiceBody({ design: 'outline', colour: 'rose' }, true), {
    design: 'outline',
    colour: 'rose',
  });
});

test('draftFromChoice opens an unknown animation as nothing chosen', () => {
  assert.deepEqual(
    draftFromChoice({
      design: null,
      colour: null,
      animation: 'retired',
      motion: 'loop',
      hasPhoto: false,
    }),
    { design: null, colour: 'neutral' },
  );
  assert.deepEqual(
    draftFromChoice({
      design: null,
      colour: 'ocean',
      animation: 'night',
      motion: 'loop',
      hasPhoto: false,
    }),
    {
      design: null,
      colour: 'neutral',
      animation: 'night',
      motion: 'loop',
      animationColour: 'ocean',
    },
  );
  assert.equal(
    draftFromChoice({
      design: null,
      colour: null,
      animation: 'drift',
      motion: null,
      hasPhoto: false,
    }).motion,
    'once',
  );
});

test('sameDraft treats a motion change as a change', () => {
  const a = {
    design: null,
    colour: 'neutral',
    animation: 'night',
    motion: 'once',
    animationColour: null,
  };
  assert.equal(sameDraft(a, { ...a, motion: 'loop' }), false);
  assert.equal(sameDraft(a, { ...a }), true);
  assert.equal(sameDraft(a, { ...a, animationColour: 'rose' }), false);
});

test('the preview of an animation carries the plan, so a Free page plays once', () => {
  const draft = {
    design: null,
    colour: 'neutral',
    animation: 'drift',
    motion: 'loop',
    animationColour: null,
  };
  assert.deepEqual(draftPreview(draft, 'ada', 'free'), {
    kind: 'animated',
    animation: 'drift',
    play: 'once',
  });
  assert.equal(
    draftPreview({ ...draft, animation: 'night' }, 'ada', 'pro').play,
    'loop',
  );
});

// A page that left Pro (review M1): the draft opens without the Pro parts, and saving strips them.
const leftPro = {
  design: null,
  colour: 'ocean',
  animation: 'drift',
  motion: 'loop',
  hasPhoto: false,
};

test('a Free page opens a saved loop and colour as plays once, in its own colours', () => {
  const draft = draftFromChoice(leftPro, false);
  assert.equal(draft.motion, 'once');
  assert.equal(draft.animationColour, null);
  // Pro keeps them.
  const pro = draftFromChoice(leftPro, true);
  assert.equal(pro.motion, 'loop');
  assert.equal(pro.animationColour, 'ocean');
});

test('on Free, stale Pro settings make the draft differ from what is saved, so it can be re-saved', () => {
  const stored = draftFromChoice(leftPro, true);
  assert.equal(
    differsFromSaved(draftFromChoice(leftPro, false), stored, false),
    true,
  );
  // A Free page's ordinary saved cover is not a change.
  const plain = draftFromChoice(
    {
      design: null,
      colour: null,
      animation: 'drift',
      motion: null,
      hasPhoto: false,
    },
    false,
  );
  assert.equal(differsFromSaved(plain, plain, false), false);
  // A Pro page choosing a loop is.
  const night = draftFromChoice(
    {
      design: null,
      colour: null,
      animation: 'night',
      motion: 'once',
      hasPhoto: false,
    },
    true,
  );
  assert.equal(
    differsFromSaved({ ...night, motion: 'loop' }, night, true),
    true,
  );
  assert.equal(differsFromSaved(night, night, true), false);
});
