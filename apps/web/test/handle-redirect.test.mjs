import assert from 'node:assert/strict';
import { test } from 'node:test';
import { movedProfilePath } from '../src/lib/handle-redirect.ts';

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
