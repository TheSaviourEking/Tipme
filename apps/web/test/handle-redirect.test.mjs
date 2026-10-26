import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  movedProfilePath,
  shortLinkTarget,
} from '../src/lib/handle-redirect.ts';

test('an old handle leads to the new page, keeping only the QR marker', () => {
  assert.equal(movedProfilePath('ada_new', {}), '/@ada_new');
  assert.equal(movedProfilePath('ada_new', { src: 'qr' }), '/@ada_new?src=qr');
  assert.equal(
    movedProfilePath('ada_new', { src: 'qr', next: 'https://evil.example' }),
    '/@ada_new?src=qr',
  );
  assert.equal(movedProfilePath('ada_new', { src: ['qr', 'x'] }), '/@ada_new');
  assert.equal(movedProfilePath('ada_new', { src: 'other' }), '/@ada_new');
});

test('a short link leads to the canonical page; TipMe pages and non-handles are left alone', () => {
  const none = new URLSearchParams();
  assert.equal(shortLinkTarget('/ada', none), '/@ada');
  assert.equal(shortLinkTarget('/Ada', none), '/@ada');
  assert.equal(
    shortLinkTarget('/ada', new URLSearchParams('src=qr&x=1')),
    '/@ada?src=qr',
  );
  assert.equal(
    shortLinkTarget('/ada', new URLSearchParams('src=qr&src=x')),
    '/@ada',
  );
  for (const path of [
    '/dashboard',
    '/ops',
    '/tip',
    '/portraits',
    '/sign-in',
    '/@ada',
    '/people/ada',
    '/ab',
    '/a%ZZ',
    '/',
    '/ada/more',
    '/robots.txt',
  ])
    assert.equal(shortLinkTarget(path, none), null, path);
});
