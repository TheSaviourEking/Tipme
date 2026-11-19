import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onProfilePage } from '../src/lib/profile-path.ts';

// The site header's links don't prefetch on a public profile (Task 10 fix round 1), and do
// everywhere else.

test('a public profile is /@username, a campaign link, or the /people route behind them', () => {
  for (const path of ['/@kemi', '/@kemi/lekki', '/people/kemi'])
    assert.equal(onProfilePage(path), true, path);
  for (const path of [
    '/',
    '/pro',
    '/dashboard',
    '/sign-in',
    '/for-creators',
    '/peoplepage',
    '/a@b',
  ])
    assert.equal(onProfilePage(path), false, path);
});
