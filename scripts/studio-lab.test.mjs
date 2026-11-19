// The Studio lab's examples are valid documents, and the stress ones really reach the limits.
// (The v1 lab examples, Kemi, Sule, Ify and a specimen per font, went with the v1 renderer in PR 4b.)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STUDIO_LIMITS,
  STUDIO_STYLE_IDS,
  studioDocumentSchema,
} from '../packages/contracts/dist/index.js';
import {
  LAB_LONG_NAMES,
  LAB_STYLE_EXAMPLES,
  labStyleExample,
} from '../apps/web/src/app/dev/studio-lab/examples.ts';

const valid = (name, doc) => {
  const r = studioDocumentSchema.safeParse(doc);
  assert.equal(
    r.success,
    true,
    `${name}: ${JSON.stringify(r.error?.issues?.[0])}`,
  );
};

test('every style has a valid lab example', () => {
  for (const style of STUDIO_STYLE_IDS) {
    const doc = LAB_STYLE_EXAMPLES[style];
    assert.ok(doc, `${style} has an example`);
    assert.equal(doc.style, style);
    valid(style, doc);
  }
});

test('the stress examples are valid v2 documents in every style', () => {
  for (const style of STUDIO_STYLE_IDS)
    for (const example of ['styles-min', 'styles-max', 'hostile']) {
      const doc = labStyleExample(example, style);
      assert.ok(doc, `${style} ${example}`);
      valid(`${style} ${example}`, { ...doc, style });
    }
  assert.equal(labStyleExample('nope', 'clear'), null);
  assert.equal(LAB_LONG_NAMES.length, 3);
});

test('styles-max reaches every page limit a v2 document has', () => {
  const doc = labStyleExample('styles-max', 'clear');
  const count = (kind) => doc.blocks.filter((b) => b.kind === kind).length;
  assert.ok(doc.blocks.length > 20, `${doc.blocks.length} blocks`);
  assert.ok(doc.blocks.length <= STUDIO_LIMITS.blocks);
  assert.equal(count('video'), STUDIO_LIMITS.videos);
  const items = (kind) =>
    doc.blocks
      .filter((b) => b.kind === kind)
      .reduce((sum, b) => sum + b.items.length, 0);
  assert.equal(items('events'), STUDIO_LIMITS.events);
  assert.equal(items('services'), STUDIO_LIMITS.services);
});
