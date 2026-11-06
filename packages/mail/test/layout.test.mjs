import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAIL_TYPES, mailLink, renderMail } from '../dist/index.js';
import { letter } from '../dist/templates/layout.js';
import { naira, nairaWhole } from '../dist/templates/money.js';
import { preheaderOf } from './preheader.mjs';

const ctx = { webOrigin: 'https://usetipme.xyz', unsubscribeUrl: null };
const withSettings = {
  ...ctx,
  unsubscribeUrl: 'https://usetipme.xyz/email-settings?u=abc&s=def',
};

/** Text a reader would see or copy: tags gone, entities read. */
const visible = (html) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const everyKind = (s) => ({
  subject: `Subject ${s}`,
  heading: `Heading ${s}`,
  reason: `Reason ${s}`,
  blocks: [
    { kind: 'text', text: `Text ${s}` },
    { kind: 'code', code: '482913' },
    { kind: 'button', label: `Button ${s}`, href: 'https://usetipme.xyz/go' },
    { kind: 'quiet', text: `Quiet ${s}` },
    { kind: 'warn', text: `Warn ${s}` },
    { kind: 'alarm', title: `Alarm title ${s}`, text: `Alarm text ${s}` },
    {
      kind: 'facts',
      rows: [
        { label: `Now ${s}`, value: `Value now ${s}` },
        { label: 'Before', value: `Value before ${s}`, before: true },
      ],
    },
    { kind: 'steps', items: [`Step one ${s}`, `Step two ${s}`] },
    {
      kind: 'stats',
      items: [
        { value: `Stat one ${s}`, label: `stat label one ${s}` },
        { value: `Stat two ${s}`, label: `stat label two ${s}` },
      ],
    },
    {
      kind: 'signature',
      title: `Signature ${s}`,
      text: `Signature text ${s}`,
      href: 'https://usetipme.xyz/@ada',
    },
    { kind: 'deadline', label: `Deadline ${s}`, date: `12 November ${s}` },
  ],
});

/** Each string a letter carries, which must reach both the html and the text. */
const wordsOf = (input) => {
  const out = [input.heading, input.reason];
  for (const block of input.blocks) {
    if (block.kind === 'facts')
      for (const row of block.rows) out.push(row.value);
    else if (block.kind === 'steps') out.push(...block.items);
    else if (block.kind === 'stats')
      for (const item of block.items) out.push(item.value, item.label);
    else
      for (const [key, value] of Object.entries(block))
        if (key !== 'kind' && key !== 'href' && typeof value === 'string')
          out.push(value);
  }
  return out;
};

test('every block kind renders in html and in text', () => {
  const input = everyKind('x');
  const out = letter(input, ctx);
  const seen = visible(out.html);
  for (const word of wordsOf(input)) {
    assert.ok(seen.includes(word), `html has ${word}`);
    assert.ok(out.text.includes(word), `text has ${word}`);
  }
  // A facts row's label shows in html; a struck-through row says so in text.
  assert.ok(seen.includes('Now x'));
  assert.ok(out.text.includes('Now x: Value now x'));
  assert.ok(out.text.includes('Before: Value before x'));
  assert.match(out.html, /line-through[^>]*>Value before x/);
  assert.ok(out.text.includes('1. Step one x\n2. Step two x'));
  assert.ok(out.text.includes('Alarm title x Alarm text x'));
  assert.ok(out.text.includes('Stat one x stat label one x'));
  assert.ok(
    out.text.includes(
      'Signature x\nSignature text x\nhttps://usetipme.xyz/@ada',
    ),
  );
  assert.ok(out.text.includes('Deadline x 12 November x'));
  assert.ok(out.text.includes('Button x: https://usetipme.xyz/go'));
  assert.match(out.text, /^482913$/m);
});

test('user text is escaped in every block kind', () => {
  const nasty = '<script>"Ada"</script> 🎉 مرحبا';
  const input = everyKind(nasty);
  input.tag = 'safety';
  input.preheader = `Preheader ${nasty}`;
  const out = letter(input, ctx);
  assert.doesNotMatch(out.html, /<script/i);
  assert.match(out.html, /&quot;Ada&quot;/);
  assert.ok(out.html.includes('🎉 مرحبا'));
  for (const word of wordsOf(input)) {
    assert.ok(out.text.includes(word), `text keeps ${word}`);
    assert.ok(visible(out.html).includes(word), `html keeps ${word}`);
  }
  const slabbed = letter(
    { ...input, slab: { amount: nasty, line: `Line ${nasty}` } },
    ctx,
  );
  assert.doesNotMatch(slabbed.html, /<script/i);
  assert.ok(slabbed.text.includes(`Line ${nasty}`));
});

test('a code in cells copies as one string', () => {
  const codeHtml = (code) => {
    const out = letter(
      {
        subject: 's',
        heading: 'h',
        reason: 'r',
        blocks: [{ kind: 'code', code }],
      },
      ctx,
    );
    const block = /<!--code-->([\s\S]*?)<!--\/code-->/.exec(out.html);
    assert.ok(block, 'the code block is marked');
    return block[1];
  };
  const cells = codeHtml('482913');
  assert.equal(visible(cells), '482913');
  assert.equal((cells.match(/<span/g) ?? []).length, 6, 'six cells');
  const well = codeHtml('SAMPLEC2DE');
  assert.equal(visible(well), 'SAMPLEC2DE');
  assert.doesNotMatch(well, /<span/, 'anything else is one well');
});

test('an email loads nothing from anywhere', () => {
  for (const [id, type] of Object.entries(MAIL_TYPES)) {
    const out = renderMail(id, type.sample, withSettings);
    for (const html of [out.html, out.snapshot?.html].filter(Boolean))
      for (const banned of ['<img', '<link', '@import', 'url(', 'src='])
        assert.ok(!html.includes(banned), `${id} has no ${banned}`);
  }
  const all = letter({ ...everyKind('x'), tag: 'safety' }, ctx).html;
  for (const banned of ['<img', '<link', '@import', 'url(', 'src='])
    assert.ok(!all.includes(banned), `every kind: no ${banned}`);
});

test('every link in the html is in the text', () => {
  const check = (id, out) => {
    const hrefs = [...out.html.matchAll(/href="([^"]*)"/g)]
      .map((m) => visible(m[1]))
      .filter((href) => !href.startsWith('mailto:'));
    for (const href of hrefs)
      assert.ok(out.text.includes(href), `${id}: ${href} is in the text`);
  };
  for (const [id, type] of Object.entries(MAIL_TYPES)) {
    const out = renderMail(id, type.sample, withSettings);
    check(id, out);
    if (out.snapshot) check(`${id} snapshot`, out.snapshot);
  }
  check('every kind', letter(everyKind('x'), withSettings));
});

test('the preheader is never a code or a link', () => {
  for (const [id, type] of Object.entries(MAIL_TYPES)) {
    const out = renderMail(id, type.sample, withSettings);
    const pre = preheaderOf(out.html);
    assert.ok(pre.length > 0, `${id} has a preheader`);
    assert.doesNotMatch(pre, /\d{6}/, `${id} preheader has no code`);
    assert.doesNotMatch(pre, /http|www\.|@/, `${id} preheader has no link`);
  }
});

test('the preheader defaults to the first text block, or says what it is told', () => {
  const base = {
    subject: 's',
    heading: 'Heading',
    reason: 'r',
    blocks: [
      { kind: 'code', code: '482913' },
      { kind: 'text', text: 'First words.' },
      { kind: 'text', text: 'Second words.' },
    ],
  };
  assert.equal(preheaderOf(letter(base, ctx).html), 'First words.');
  assert.equal(
    preheaderOf(letter({ ...base, preheader: 'Told.' }, ctx).html),
    'Told.',
  );
  // The preheader is the first thing in the body, hidden everywhere.
  assert.match(
    letter(base, ctx).html,
    /<body[^>]*><div data-preheader style="display:none;[^"]*mso-hide:all/,
  );
});

test('each email stays under 90 KB', () => {
  for (const [id, type] of Object.entries(MAIL_TYPES)) {
    const out = renderMail(id, type.sample, withSettings);
    assert.ok(
      Buffer.byteLength(out.html) < 90 * 1024,
      `${id} is ${Buffer.byteLength(out.html)} bytes`,
    );
  }
  assert.ok(Buffer.byteLength(letter(everyKind('x'), ctx).html) < 90 * 1024);
});

test('the slab shows the amount and the line, and the text starts with them', () => {
  const out = letter(
    {
      subject: 'You got a ₦4,500 tip on TipMe',
      heading: 'Ada, you got a tip.',
      reason: 'r',
      slab: {
        amount: '₦4,500',
        line: 'From Chidi. Confirmed by our payment partner.',
      },
      blocks: [
        {
          kind: 'button',
          label: 'See your tips',
          href: 'https://usetipme.xyz/dashboard/tips',
        },
      ],
    },
    ctx,
  );
  assert.ok(
    out.text.startsWith(
      'Ada, you got a tip.\n\n₦4,500\nFrom Chidi. Confirmed by our payment partner.\n',
    ),
  );
  assert.match(out.html, /#7A32F9/);
  assert.match(out.html, /font-size:64px[^>]*>₦4,500</);
  assert.ok(visible(out.html).includes('From Chidi.'));
  assert.match(out.html, /@media[^{]*max-width:\s*480px/);
});

test('the safety line sits above the heading', () => {
  const out = letter(
    {
      subject: 's',
      heading: 'A new device signed in',
      reason: 'r',
      tag: 'safety',
      blocks: [{ kind: 'text', text: 't' }],
    },
    ctx,
  );
  const seen = visible(out.html);
  assert.ok(
    seen.indexOf('Your account’s safety') <
      seen.indexOf('A new device signed in'),
  );
  assert.ok(out.text.startsWith('Your account’s safety\n\nA new device'));
});

test('the frame wears the paper, the wordmark, a black key and a dark mode', () => {
  const out = letter(everyKind('x'), withSettings);
  assert.match(out.html, /background:#F3F2EE/);
  assert.match(out.html, /background:#FFFEFA/);
  assert.ok(visible(out.html).includes('tipme'));
  assert.match(out.html, /color:#7A32F9[^>]*>&#9829;&#xFE0E;</);
  assert.match(out.html, /bgcolor="#000000"/);
  assert.match(out.html, /Georgia/);
  assert.match(out.html, /@media \(prefers-color-scheme: dark\)/);
  // The footer keeps today's words and links.
  assert.ok(visible(out.html).includes('Reason x Email settings.'));
  assert.ok(visible(out.html).includes('Questions? support@usetipme.xyz'));
  assert.ok(out.text.endsWith('Questions? support@usetipme.xyz'));
});

test('today’s three blocks keep their plain text exactly', () => {
  const out = letter(
    {
      subject: 's',
      heading: 'Heading',
      reason: 'Reason.',
      blocks: [
        { kind: 'text', text: 'Hello.' },
        { kind: 'code', code: '482913' },
        { kind: 'button', label: 'Go', href: 'https://usetipme.xyz/go' },
      ],
    },
    withSettings,
  );
  assert.equal(
    out.text,
    [
      'Heading',
      '',
      'Hello.',
      '',
      '482913',
      '',
      'Go: https://usetipme.xyz/go',
      '',
      '—',
      'Reason.',
      'Email settings: https://usetipme.xyz/email-settings?u=abc&s=def',
      'Questions? support@usetipme.xyz',
    ].join('\n'),
  );
});

test('personal links are redacted in every block kind', () => {
  const redacted = { ...ctx, redact: true };
  const out = letter(
    {
      subject: 's',
      heading: 'h',
      reason: 'r',
      blocks: [
        {
          kind: 'button',
          label: 'Open',
          href: mailLink(redacted, '/enrol#t=secret-token-123', 'enrol', true),
        },
        {
          kind: 'signature',
          title: 'Your page',
          text: 'Share it.',
          href: mailLink(redacted, '/recover#r=secret-token-123', 'r', true),
        },
      ],
    },
    redacted,
  );
  for (const part of [out.html, out.text]) {
    assert.ok(part.includes('[personal link]'));
    assert.ok(!part.includes('secret-token-123'));
  }
});

test('kobo show only when they are not zero', () => {
  assert.equal(naira('450000'), '₦4,500');
  assert.equal(naira('405050'), '₦4,050.50');
  assert.equal(naira('5'), '₦0.05');
  assert.equal(naira('0'), '₦0');
  assert.equal(naira('123456789012345678901'), '₦1,234,567,890,123,456,789.01');
  // Subjects stop truncating kobo.
  assert.equal(nairaWhole('405050'), '₦4,050.50');
});
