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
  assert.equal(shortLinkTarget('/kemi', none), '/@kemi');
  assert.equal(shortLinkTarget('/Kemi', none), '/@kemi');
  assert.equal(
    shortLinkTarget('/kemi', new URLSearchParams('src=qr&x=1')),
    '/@kemi?src=qr',
  );
  assert.equal(
    shortLinkTarget('/kemi', new URLSearchParams('src=qr&src=x')),
    '/@kemi',
  );
  // The example people on TipMe's own pages are reserved (owner, 5 Nov 2026): their pages still open
  // at /@handle, but no short link leads to them.
  for (const example of ['/ada', '/tobi', '/zainab'])
    assert.equal(shortLinkTarget(example, none), null, example);
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
