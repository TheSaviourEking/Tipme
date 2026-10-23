import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deviceIsMobile,
  referrerChannel,
  shouldTrack,
} from '../src/lib/analytics-core.ts';

test('the arrival channel comes from the QR tag or the referrer, never the URL itself', () => {
  assert.equal(referrerChannel('', '?src=qr'), 'qr');
  assert.equal(
    referrerChannel('https://l.instagram.com/?u=x', ''),
    'instagram',
  );
  assert.equal(referrerChannel('https://www.instagram.com/', ''), 'instagram');
  assert.equal(referrerChannel('https://t.co/abc', ''), 'x');
  assert.equal(referrerChannel('https://x.com/someone', ''), 'x');
  assert.equal(referrerChannel('https://m.facebook.com/', ''), 'facebook');
  assert.equal(referrerChannel('https://l.facebook.com/l.php', ''), 'facebook');
  assert.equal(referrerChannel('https://web.whatsapp.com/', ''), 'whatsapp');
  assert.equal(referrerChannel('https://www.google.com/', ''), 'search');
  assert.equal(
    referrerChannel('https://www.bing.com/search?q=x', ''),
    'search',
  );
  assert.equal(referrerChannel('https://duckduckgo.com/', ''), 'search');
  assert.equal(referrerChannel('', ''), 'direct');
  assert.equal(referrerChannel('https://someblog.example/post', ''), 'link');
  assert.equal(referrerChannel('not a url', ''), 'other');
});

test('nothing is sent when the browser asks not to be tracked', () => {
  assert.equal(shouldTrack({ globalPrivacyControl: true }), false);
  assert.equal(shouldTrack({ doNotTrack: '1' }), false);
  assert.equal(shouldTrack({ doNotTrack: null }), true);
  assert.equal(shouldTrack({}), true);
});

test('device class only, from the user agent', () => {
  assert.equal(
    deviceIsMobile('Mozilla/5.0 (Linux; Android 14) Mobile Safari'),
    true,
  );
  assert.equal(
    deviceIsMobile('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)'),
    true,
  );
  assert.equal(
    deviceIsMobile('Mozilla/5.0 (Macintosh; Intel Mac OS X)'),
    false,
  );
});

test('web vitals name only the kind of page, and staff or developer pages send nothing', async () => {
  const { vitalPage, vitalPayload } =
    await import('../src/lib/analytics-core.ts');
  assert.equal(vitalPage('/'), 'home');
  assert.equal(vitalPage('/how-it-works'), 'marketing');
  assert.equal(vitalPage('/legal/terms'), 'marketing');
  assert.equal(vitalPage('/people/ada'), 'profile');
  assert.equal(vitalPage('/@ada'), 'profile');
  assert.equal(vitalPage('/mock-checkout/abc'), 'checkout');
  assert.equal(vitalPage('/tip/abc'), 'status');
  assert.equal(vitalPage('/dashboard/tips/123'), 'dashboard');
  assert.equal(vitalPage('/sign-in'), 'account');
  for (const path of [
    '/ops',
    '/ops/issues',
    '/dev/inbox',
    '/design-system',
    '/preview-login',
    '/unknown',
  ])
    assert.equal(vitalPage(path), null, path);
  assert.deepEqual(vitalPayload({ name: 'LCP', value: 1834.6 }, 'profile'), {
    metric: 'LCP',
    value: 1835,
    page: 'profile',
  });
  assert.deepEqual(vitalPayload({ name: 'CLS', value: 0.01234 }, 'home'), {
    metric: 'CLS',
    value: 0.012,
    page: 'home',
  });
  assert.equal(vitalPayload({ name: 'FID', value: 3 }, 'home'), null);
});
