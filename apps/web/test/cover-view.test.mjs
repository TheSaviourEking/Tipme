import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ANIMATED_LAYERS, coverView } from '../src/lib/cover-view.ts';

const API = 'https://api.example.test';
const animated = (extra = {}) => ({
  kind: 'animated',
  animation: 'night',
  play: 'loop',
  ...extra,
});

test('an animated cover has the animation palette and five layers', () => {
  const view = coverView(animated(), API, true);
  assert.equal(view.kind, 'animated');
  assert.equal(view.base, '#101a3a');
  assert.equal(view.tone, '#3e5aa8');
  assert.equal(view.play, 'loop');
  assert.equal(view.layers, ANIMATED_LAYERS);
  assert.equal(ANIMATED_LAYERS.length, 5);
});

test('a Pro colour replaces the palette', () => {
  const view = coverView(animated({ colour: 'ocean' }), API, true);
  assert.equal(view.base, '#1d4e89');
  assert.equal(view.tone, '#3a79c2');
});

test('without animate the cover is still', () => {
  assert.equal(coverView(animated(), API).play, 'still');
  assert.equal(coverView(animated(), API, true).play, 'loop');
});

test('an unknown kind or animation draws the automatic cover', () => {
  for (const cover of [
    { kind: 'hologram', thing: 1 },
    animated({ animation: 'gone' }),
  ]) {
    const view = coverView(cover, API, true);
    assert.equal(view.kind, 'hearts');
    assert.equal(view.design, 'scattered');
  }
});
