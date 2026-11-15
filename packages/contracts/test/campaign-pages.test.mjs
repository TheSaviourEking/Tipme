import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CAMPAIGN_DESCRIPTION_MAX,
  CAMPAIGN_HEADLINE_MAX,
  campaignPageSchema,
} from '../dist/index.js';

// Campaign pages (plan 2026-11-14 Task 3; board ProCampaignPages section 2).
const page = (over = {}) => ({
  on: true,
  headline: 'Thank you for dancing with me',
  description: null,
  cover: null,
  ...over,
});
const parse = (body) => campaignPageSchema.safeParse(body);

test('headline is cleaned and limited to 60 code points', () => {
  assert.equal(CAMPAIGN_HEADLINE_MAX, 60);
  assert.equal(parse(page({ headline: 'é'.repeat(61) })).success, false);
  assert.equal(parse(page({ headline: 'é'.repeat(60) })).success, true);
  // An emoji counts once, as in Postgres char_length.
  assert.equal(parse(page({ headline: '🎉'.repeat(60) })).success, true);
  const cleaned = parse(page({ headline: '  Hi​ there\n ' }));
  assert.equal(cleaned.success, true);
  assert.equal(cleaned.data.headline, 'Hi there');
  // Only invisible characters: no headline.
  const empty = parse(page({ on: false, headline: '​ ' }));
  assert.equal(empty.data.headline, null);
});

test('links are refused in headline and description', () => {
  assert.equal(parse(page({ headline: 'see tipme.xyz/@ada' })).success, false);
  assert.equal(
    parse(page({ description: 'see tipme.xyz/@ada' })).success,
    false,
  );
  const result = parse(page({ description: 'www.example' }));
  assert.equal(result.success, false);
  assert.match(result.error.issues[0].message, /No links/);
});

test('description over 200 refused', () => {
  assert.equal(CAMPAIGN_DESCRIPTION_MAX, 200);
  assert.equal(parse(page({ description: 'a'.repeat(201) })).success, false);
  const ok = parse(page({ description: 'a'.repeat(200) }));
  assert.equal(ok.success, true);
  assert.equal(parse(page({ description: '   ' })).data.description, null);
});

test('on without a headline is refused', () => {
  const result = parse(page({ headline: null }));
  assert.equal(result.success, false);
  assert.equal(
    result.error.issues[0].message,
    'Add a headline to give it its own page.',
  );
  assert.equal(parse(page({ on: false, headline: null })).success, true);
});

test('cover null means same as page', () => {
  const result = parse(page({ cover: null }));
  assert.equal(result.success, true);
  assert.equal(result.data.cover, null);
  // An empty choice (no design, no animation) is "same as page" too.
  assert.equal(parse(page({ cover: { design: null } })).data.cover, null);
});

test('cover uses the cover rules', () => {
  assert.equal(
    parse(page({ cover: { design: 'no-such-design' } })).success,
    false,
  );
  assert.equal(
    parse(page({ cover: { design: null, animation: 'nope' } })).success,
    false,
  );
  const animated = parse(
    page({ cover: { design: null, animation: 'drift', motion: 'loop' } }),
  );
  assert.equal(animated.success, true);
  assert.deepEqual(animated.data.cover, {
    design: null,
    animation: 'drift',
    motion: 'loop',
  });
  // Unknown fields are refused (strict).
  assert.equal(parse({ ...page(), extra: 1 }).success, false);
});
