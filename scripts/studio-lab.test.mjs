// The Studio lab's examples (plan Task 6) are valid documents, the board's three match the design
// check's fixtures, and `max` really reaches every limit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STUDIO_FONTS,
  STUDIO_LIMITS,
  studioCounts,
  studioDocumentV1Schema,
} from '../packages/contracts/dist/index.js';
import {
  IFY,
  KEMI,
  SULE,
} from '../packages/contracts/test/fixtures/studio-examples.mjs';
import {
  STUDIO_EXAMPLES,
  fontSpecimen,
} from '../apps/web/src/app/dev/studio-lab/examples.ts';

test('the board examples are the design check fixtures', () => {
  assert.deepEqual(STUDIO_EXAMPLES.kemi, KEMI);
  assert.deepEqual(STUDIO_EXAMPLES.sule, SULE);
  assert.deepEqual(STUDIO_EXAMPLES.ify, IFY);
});

test('every lab example is a valid document', () => {
  const all = {
    ...STUDIO_EXAMPLES,
    ...Object.fromEntries(
      STUDIO_FONTS.map((f) => [`fonts-${f.id}`, fontSpecimen(f.id)]),
    ),
  };
  for (const [name, doc] of Object.entries(all)) {
    const r = studioDocumentV1Schema.safeParse(doc);
    assert.equal(
      r.success,
      true,
      `${name}: ${JSON.stringify(r.error?.issues?.[0])}`,
    );
  }
});

test('max reaches every page limit', () => {
  const c = studioCounts(STUDIO_EXAMPLES.max);
  assert.equal(STUDIO_EXAMPLES.max.rows.length, STUDIO_LIMITS.rows);
  assert.equal(c.images, STUDIO_LIMITS.pageImages);
  assert.equal(c.videos, STUDIO_LIMITS.videos);
  assert.equal(c.events, STUDIO_LIMITS.events);
  assert.equal(c.services, STUDIO_LIMITS.services);
});
