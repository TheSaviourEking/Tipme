import assert from 'node:assert/strict';
import { test } from 'node:test';
import { avatarSource } from '../src/lib/avatar-source.ts';

test('an uploaded photo is served by the API; the demo illustrations by the web app', () => {
  assert.deepEqual(
    avatarSource(
      '/v1/avatars/abc/3.webp',
      'Ada Bello',
      'https://api.example.test',
    ),
    {
      src: 'https://api.example.test/v1/avatars/abc/3.webp',
      alt: 'Photo of Ada Bello',
    },
  );
  assert.deepEqual(
    avatarSource('/illustrations/ada.svg', 'Ada', 'https://api.example.test'),
    {
      src: '/illustrations/ada.svg',
      alt: 'Illustrated avatar of Ada, a fictional demo recipient',
    },
  );
  assert.deepEqual(
    avatarSource('/portraits/ada.webp', 'Ada', 'https://api.example.test'),
    {
      src: '/portraits/ada.webp',
      alt: 'Portrait of Ada, a fictional demo recipient',
    },
  );
  assert.equal(
    avatarSource('/portraits/../x.webp', 'Ada', 'https://api.example.test'),
    null,
  );
  // Nothing else is ever turned into an image source.
  assert.equal(
    avatarSource(
      'https://evil.example/x.png',
      'Ada',
      'https://api.example.test',
    ),
    null,
  );
  assert.equal(
    avatarSource('javascript:alert(1)', 'Ada', 'https://api.example.test'),
    null,
  );
});
