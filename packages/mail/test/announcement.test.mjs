import assert from 'node:assert/strict';
import { test } from 'node:test';
import { announcementBlocks, MAIL_TYPES, renderMail } from '../dist/index.js';
import { preheaderOf } from './preheader.mjs';

// Staff announcements (owner-approved, 14 Nov 2026): staff write plain paragraphs, with optional
// **bold**, "- " bullet lines and one optional button. The email is the usual letter.
const ctx = { webOrigin: 'https://usetipme.xyz', unsubscribeUrl: null };
const withSettings = {
  ...ctx,
  unsubscribeUrl: 'https://api.usetipme.xyz/v1/mail/unsubscribe?t=abc.def',
};

const data = (extra = {}) => ({
  subject: 'Lower fees on TipMe',
  preheader: 'TipMe’s fee drops from 10% to 7%, or 5% on Pro.',
  text: [
    'From 1 December, TipMe’s fee on each tip is going down.',
    '',
    '- **TipMe Free: 7% per tip** (was 10%).',
    '- **TipMe Pro: 5% per tip**, for ₦5,000 a month.',
    '',
    'Your supporters still pay exactly the tip they choose.',
  ].join('\n'),
  ...extra,
});

const render = (extra, context = withSettings) =>
  renderMail('announcement', data(extra), context);

test('an announcement is marketing mail from news@, with no switch of its own', () => {
  const type = MAIL_TYPES.announcement;
  assert.equal(type.category, 'marketing');
  assert.equal(type.sender, 'news');
  assert.equal(type.preference, null);
  // Like other non-security mail: the provider's open and click tracking, nothing more.
  assert.equal(type.tracking, true);
});

test('paragraphs, bullets and bold become blocks in reading order', () => {
  assert.deepEqual(
    announcementBlocks(
      'One **two** three.\nStill one.\n\n- a\n- **b** c\n\nEnd',
    ),
    [
      {
        kind: 'rich',
        spans: [
          { text: 'One ', bold: false },
          { text: 'two', bold: true },
          { text: ' three. Still one.', bold: false },
        ],
      },
      {
        kind: 'bullets',
        items: [
          [{ text: 'a', bold: false }],
          [
            { text: 'b', bold: true },
            { text: ' c', bold: false },
          ],
        ],
      },
      { kind: 'rich', spans: [{ text: 'End', bold: false }] },
    ],
  );
});

test('an unclosed ** stays as typed, and "•" starts a bullet too', () => {
  assert.deepEqual(announcementBlocks('2 ** 3 = 8\n\n• one'), [
    { kind: 'rich', spans: [{ text: '2 ** 3 = 8', bold: false }] },
    { kind: 'bullets', items: [[{ text: 'one', bold: false }]] },
  ]);
});

test('the HTML has the bold and the list; the text says the same words', () => {
  const out = render();
  assert.equal(out.subject, 'Lower fees on TipMe');
  assert.match(out.html, /<strong[^>]*>TipMe Free: 7% per tip<\/strong>/);
  assert.match(out.html, /<ul[^>]*>[\s\S]*<li[^>]*>[\s\S]*TipMe Pro/);
  assert.ok(out.text.includes('- TipMe Free: 7% per tip (was 10%).'), out.text);
  assert.ok(
    out.text.includes('Your supporters still pay exactly the tip they choose.'),
  );
  assert.doesNotMatch(out.text, /\*\*/);
  assert.equal(
    preheaderOf(out.html),
    'TipMe’s fee drops from 10% to 7%, or 5% on Pro.',
  );
});

test('staff text is escaped in HTML and intact in text', () => {
  const out = render({
    subject: 'News <b>"now"</b>',
    text: 'Hello <script>alert(1)</script> & **<i>bye</i>**',
  });
  assert.doesNotMatch(out.html, /<script|<i>|<b>"now"/);
  assert.match(out.html, /&lt;script&gt;/);
  assert.ok(out.text.includes('Hello <script>alert(1)</script> & <i>bye</i>'));
  assert.equal(out.subject, 'News <b>"now"</b>');
});

test('every announcement carries the reason and the email settings link', () => {
  const out = render();
  assert.match(out.text, /news and announcements from TipMe/);
  assert.ok(
    out.text.includes(`Email settings: ${withSettings.unsubscribeUrl}`),
  );
  assert.ok(out.html.includes('abc.def'));
  // Nothing loaded from anywhere: no tracking pixel of our own.
  assert.doesNotMatch(out.html, /<img/i);
});

test('one optional button: a TipMe path gets the link key, an https link goes as it is', () => {
  assert.doesNotMatch(render().html, /line-height:54px/);
  const inside = render({ button: { label: 'See the new fees', url: '/pro' } });
  const href = /<a href="([^"]+)"[^>]*line-height:54px/.exec(inside.html)?.[1];
  assert.ok(href, inside.html);
  const url = new URL(href.replaceAll('&amp;', '&'));
  assert.equal(url.origin, 'https://usetipme.xyz');
  assert.equal(url.pathname, '/pro');
  assert.equal(url.searchParams.get('ml'), 'announcement_button');
  assert.ok(inside.text.includes('See the new fees: https://usetipme.xyz/pro'));
  const outside = render({
    button: { label: 'Read more', url: 'https://help.usetipme.xyz/fees' },
  });
  assert.ok(outside.html.includes('href="https://help.usetipme.xyz/fees"'));
});

test('the schema refuses what an announcement may not hold', () => {
  const bad = [
    { subject: '' },
    { subject: 'x'.repeat(121) },
    { preheader: 'x'.repeat(151) },
    { text: '   ' },
    { text: 'x'.repeat(5001) },
    { button: { label: 'Go', url: 'javascript:alert(1)' } },
    { button: { label: 'Go', url: 'http://example.com' } },
    { button: { label: 'Go', url: '//evil.example' } },
    { button: { label: '', url: '/pro' } },
    // Users never see the payment partner's name.
    { text: 'Our partner Bachs charges ₦50.' },
    { subject: 'BACHS update' },
    { extra: true },
  ];
  for (const change of bad)
    assert.throws(
      () => renderMail('announcement', data(change), ctx),
      JSON.stringify(change),
    );
});

test('the sample renders with no leftover markup', () => {
  const out = renderMail('announcement', MAIL_TYPES.announcement.sample, ctx);
  assert.doesNotMatch(out.text + out.html, /\*\*|undefined|null/);
});
