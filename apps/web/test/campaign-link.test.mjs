import assert from 'node:assert/strict';
import { test } from 'node:test';
import { campaignFromPath, campaignLink } from '../src/lib/campaign-link.ts';
import { recapShareable } from '../src/lib/month-share.ts';

// Campaign Studio: a campaign link is /@handle/<ending>; the tip page reads the ending from the
// address only, and sends it with the visit and the tip. Nothing about it is shown on the page.
test('the ending is read from /@handle/<ending> (and the internal /people path)', () => {
  assert.equal(campaignFromPath('/@ada/new-single'), 'new-single');
  assert.equal(campaignFromPath('/people/ada/ig'), 'ig');
  assert.equal(campaignFromPath('/@ada/new-single/'), 'new-single');
});

test('no ending on the plain page link, the share card or anything malformed', () => {
  for (const path of [
    '/@ada',
    '/@ada/',
    '/people/ada/share-card',
    '/@ada/New%20Single',
    '/@ada/a/b',
    '/dashboard/campaigns',
    '/@ada/-x',
  ])
    assert.equal(campaignFromPath(path), undefined, path);
});

test('the link and its QR address', () => {
  assert.deepEqual(campaignLink('https://usetipme.xyz', 'ada', 'new-single'), {
    url: 'https://usetipme.xyz/@ada/new-single',
    qr: 'https://usetipme.xyz/@ada/new-single?src=qr',
    label: 'usetipme.xyz/@ada/new-single',
  });
});

test('the recap card takes its fields one by one: no total unless asked, nothing extra', () => {
  const hostile = {
    month: '2026-10',
    tipCount: 41,
    totalNetMinor: '18630000',
    averageMinor: '454390',
    previousNetMinor: '15210000',
    bestWeek: { from: '2026-10-12', to: '2026-10-18', tips: 13 },
    bestDay: { weekday: 5, tips: 13 },
    notes: 7,
    topSupporterLabel: 'Chidi',
    message: 'Thank you so much',
  };
  const owner = { displayName: 'Ada Okafor', handle: 'ada' };
  const plain = recapShareable(hostile, owner, { showTotal: false });
  assert.equal(plain.total, null);
  assert.doesNotMatch(JSON.stringify(plain), /Chidi|Thank you|186,300/);
  assert.equal(plain.monthName, 'October 2026');
  assert.equal(plain.tipCount, 41);
  assert.equal(plain.bestWeek, '12–18 Oct · 13 tips');
  assert.equal(plain.bestDay, 'Saturdays');
  const withTotal = recapShareable(hostile, owner, { showTotal: true });
  assert.equal(withTotal.total, '₦186,300');
});
