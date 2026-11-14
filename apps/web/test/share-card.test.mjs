import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// share-card.tsx is TSX with `@/` imports, which node can't load as it is. Transpile it (and the
// two small modules it imports) into a cache folder inside the app, so `@tipme/contracts`
// resolves as it does for the app.
const src = new URL('../src/', import.meta.url);
const out = new URL('../node_modules/.cache/share-card-test/', import.meta.url);
mkdirSync(out, { recursive: true });
function build(from, to) {
  const js = ts
    .transpileModule(readFileSync(new URL(from, src), 'utf8'), {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
      },
    })
    .outputText.replaceAll("'@/lib/wordmark'", "'./wordmark.mjs'")
    .replaceAll("'@/lib/font-cmap'", "'./font-cmap.mjs'")
    .replaceAll("'@/lib/avatar-source'", "'./avatar-source.mjs'");
  writeFileSync(new URL(to, out), js);
}
build('lib/wordmark.ts', 'wordmark.mjs');
build('lib/font-cmap.ts', 'font-cmap.mjs');
build('lib/avatar-source.ts', 'avatar-source.mjs');
build('lib/share-card.tsx', 'share-card.mjs');
build('lib/share-card-photo.ts', 'share-card-photo.mjs');
const { personCardInput, shareCardColours, initialsOf, PersonCard } =
  await import(pathToFileURL(new URL('share-card.mjs', out).pathname).href);
const { shareCardPhoto } = await import(
  pathToFileURL(new URL('share-card-photo.mjs', out).pathname).href
);
const { COVER_COLOURS } = await import('@tipme/contracts');

const PURPLE = { band: '#7a32f9', face: '#5415c9' };
const colour = (id) => COVER_COLOURS.find((c) => c.id === id);

test('personCardInput keeps only name, role, handle, the photo path and the two colours', () => {
  const result = personCardInput({
    handle: 'ada',
    displayName: 'Ada Okafor',
    role: 'Barista',
    craft: 'Coffee',
    note: 'A pinned note',
    avatarPath: '/v1/avatars/0b7c3d4e-1111-4222-8333-944455556666/3.webp',
    bio: 'Private-ish words',
    links: [{ kind: 'website', url: 'https://example.com' }],
    phone: '+2348000000000',
    email: 'ada@example.com',
    celebration: { momentId: 'm1', label: 'Birthday' },
    tipAmounts: { presetsMinor: ['200000'], minMinor: '200000' },
    acceptingTips: true,
    cover: { kind: 'design', design: 'scattered', colour: 'forest' },
    plan: 'pro',
    tippingOpen: true,
  });
  assert.deepEqual(Object.keys(result).sort(), [
    'avatarPath',
    'band',
    'face',
    'handle',
    'name',
    'role',
  ]);
  assert.deepEqual(result, {
    name: 'Ada Okafor',
    role: 'Barista',
    handle: 'ada',
    avatarPath: '/v1/avatars/0b7c3d4e-1111-4222-8333-944455556666/3.webp',
    band: colour('forest').base,
    face: colour('forest').tone,
  });
});

test('personCardInput: no photo, or a path the page would not show, is null', () => {
  assert.equal(
    personCardInput({ handle: 'ada', displayName: 'Ada' }).avatarPath,
    null,
  );
  for (const path of [
    'https://evil.example/x.webp',
    '/v1/avatars/../../etc/passwd',
    '//evil.example/v1/avatars/a/1.webp',
  ])
    assert.equal(
      personCardInput({ handle: 'ada', displayName: 'Ada', avatarPath: path })
        .avatarPath,
      null,
      path,
    );
  assert.equal(
    personCardInput({
      handle: 'ada',
      displayName: 'Ada',
      avatarPath: '/portraits/ada.webp',
    }).avatarPath,
    '/portraits/ada.webp',
  );
});

test('a role that is not public stays out', () => {
  assert.equal(
    personCardInput({ handle: 'ada', displayName: 'Ada' }).role,
    null,
  );
  assert.equal(
    personCardInput({ handle: 'ada', displayName: 'Ada', role: '  ' }).role,
    null,
  );
});

test('shareCardColours: a design with a colour uses that colour', () => {
  for (const id of ['violet', 'forest', 'ocean', 'rose', 'sun', 'neutral']) {
    assert.deepEqual(
      shareCardColours({ kind: 'design', design: 'large', colour: id }),
      { band: colour(id).base, face: colour(id).tone },
    );
  }
  assert.deepEqual(
    shareCardColours({
      kind: 'animated',
      animation: 'rising',
      colour: 'ocean',
      play: 'once',
    }),
    { band: colour('ocean').base, face: colour('ocean').tone },
  );
});

test('shareCardColours: a photo, a colourless design, an animation without colour, or no cover is TipMe purple', () => {
  assert.deepEqual(
    shareCardColours({ kind: 'photo', path: '/v1/covers/x.webp' }),
    PURPLE,
  );
  assert.deepEqual(
    shareCardColours({ kind: 'design', design: 'danfo' }),
    PURPLE,
  );
  assert.deepEqual(
    shareCardColours({ kind: 'design', design: 'dark' }),
    PURPLE,
  );
  assert.deepEqual(
    shareCardColours({ kind: 'animated', animation: 'rising', play: 'once' }),
    PURPLE,
  );
  assert.deepEqual(shareCardColours(undefined), PURPLE);
  // A colour id this build does not know (a newer API) is purple, not a crash.
  assert.deepEqual(
    shareCardColours({ kind: 'design', design: 'large', colour: 'teal' }),
    PURPLE,
  );
});

test('initials: first and last word, capitals, whole letters', () => {
  assert.equal(initialsOf('Ada Okafor'), 'AO');
  assert.equal(initialsOf('ada'), 'A');
  assert.equal(initialsOf('  Mary  Jane   Watson '), 'MW');
  assert.equal(initialsOf('Ọlápéjú Ẹ̀kọ́'), 'ỌẸ̀');
  assert.equal(initialsOf('😀 Smile'), '😀S');
  assert.equal(initialsOf(''), '');
});

/** The style of the element whose only child is `text`, in a PersonCard drawing. */
function styleOf(node, text) {
  if (!node || typeof node !== 'object') return undefined;
  if (node.props?.children === text) return node.props.style;
  const children = [node.props?.children].flat();
  for (const child of children) {
    const found = styleOf(child, text);
    if (found) return found;
  }
  return undefined;
}

test('a name DM Serif cannot draw whole is set in Manrope, so no letter or space is lost', async () => {
  const { characterMap } = await import(
    pathToFileURL(new URL('font-cmap.mjs', out).pathname).href
  );
  const serif = characterMap(
    readFileSync(new URL('fonts/og/DMSerifDisplay-Regular.ttf', src)),
  );
  const draw = (name) =>
    PersonCard({
      ...personCardInput({ handle: 'x_1', displayName: name }),
      host: 'tipme.ng',
      serif,
    });
  assert.equal(
    styleOf(draw('Ada Okafor'), 'Ada Okafor').fontFamily,
    'DM Serif Display',
  );
  assert.equal(
    styleOf(draw('Ada Okafor'), 'AO').fontFamily,
    'DM Serif Display',
  );
  const yoruba = 'Ọlápéjú Ẹ̀kọ́';
  assert.equal(styleOf(draw(yoruba), yoruba).fontFamily, 'Manrope');
  assert.equal(styleOf(draw(yoruba), initialsOf(yoruba)).fontFamily, 'Manrope');
  // Only the name is drawn from the profile, with the handle on the foot.
  assert.ok(styleOf(draw('Ada'), 'tipme.ng/@x_1'));
});

/** Every element of a PersonCard drawing, depth first. */
function elements(node, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (node.type) found.push(node);
  for (const child of [node.props?.children].flat()) elements(child, found);
  return found;
}

test('the face shows the photo when there is one, and the initials when not', () => {
  const input = personCardInput({ handle: 'ada', displayName: 'Ada Okafor' });
  const photo = 'data:image/webp;base64,UklGRg==';
  const withPhoto = elements(PersonCard({ ...input, host: 'tipme.ng', photo }));
  const img = withPhoto.filter((el) => el.type === 'img');
  assert.equal(img.length, 1);
  assert.equal(img[0].props.src, photo);
  assert.equal(img[0].props.style.objectFit, 'cover');
  assert.equal(
    styleOf(PersonCard({ ...input, host: 'tipme.ng', photo }), 'AO'),
    undefined,
  );

  for (const none of [null, undefined]) {
    const drawn = PersonCard({ ...input, host: 'tipme.ng', photo: none });
    assert.equal(elements(drawn).filter((el) => el.type === 'img').length, 0);
    assert.ok(styleOf(drawn, 'AO'), 'initials');
  }
});

const UPLOADED = '/v1/avatars/0b7c3d4e-1111-4222-8333-944455556666/3.webp';
const PNG = Buffer.from('\x89PNG\r\n\x1a\nfake', 'binary');
const WEBP = Buffer.from('RIFF\0\0\0\0WEBPVP8 tiny', 'binary');
/** A fetch that records its calls and answers with `answer(url, init)`. */
function fakeFetch(answer) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return answer(String(url), init);
  };
  return { fetch, calls };
}
const image = (bytes, type = 'image/webp') =>
  new Response(bytes, { status: 200, headers: { 'content-type': type } });
const OPTIONS = {
  apiOrigin: 'http://api.internal:4000',
  siteOrigin: 'https://tipme.ng',
};

test('shareCardPhoto: an uploaded photo is fetched from the API as its PNG and drawn as data', async () => {
  const { fetch, calls } = fakeFetch(() => image(PNG, 'image/png'));
  const photo = await shareCardPhoto(UPLOADED, {
    ...OPTIONS,
    headers: { 'x-tipme-preview-key': 'k' },
    fetch,
  });
  assert.equal(photo, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.equal(calls.length, 1);
  // next/og cannot draw WebP, so the API's PNG rendition of the same photo.
  assert.equal(
    calls[0].url,
    `http://api.internal:4000${UPLOADED.replace(/\.webp$/, '.png')}`,
  );
  assert.equal(calls[0].init.headers['x-tipme-preview-key'], 'k');
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(calls[0].init.signal, 'a timeout');
});

test('shareCardPhoto: a demo illustration comes from the site itself, without the API key', async () => {
  const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const { fetch, calls } = fakeFetch(() => image(SVG, 'image/svg+xml'));
  assert.equal(
    await shareCardPhoto('/illustrations/kemi.svg', {
      ...OPTIONS,
      headers: { 'x-tipme-preview-key': 'k' },
      fetch,
    }),
    `data:image/svg+xml;base64,${SVG.toString('base64')}`,
  );
  assert.equal(calls[0].url, 'https://tipme.ng/illustrations/kemi.svg');
  assert.equal(calls[0].init.headers['x-tipme-preview-key'], undefined);
});

test('shareCardPhoto: a WebP is never handed to next/og (it would draw a blank face)', async () => {
  const { fetch, calls } = fakeFetch(() => image(WEBP));
  // A demo portrait is WebP and has no PNG rendition: the initials, without a request.
  assert.equal(
    await shareCardPhoto('/portraits/ada.webp', { ...OPTIONS, fetch }),
    null,
  );
  assert.equal(calls.length, 0);
  // An API that answers WebP for the PNG name is not drawn either.
  assert.equal(await shareCardPhoto(UPLOADED, { ...OPTIONS, fetch }), null);
});

test('shareCardPhoto: no photo, a path the page would not show, or any failure is null (initials)', async () => {
  const never = fakeFetch(() => {
    throw new Error('not called');
  });
  for (const path of [null, undefined, '', 'https://evil.example/a.webp'])
    assert.equal(
      await shareCardPhoto(path, { ...OPTIONS, fetch: never.fetch }),
      null,
    );
  assert.equal(never.calls.length, 0);

  const answers = [
    () => new Response('gone', { status: 404 }),
    () => image(Buffer.from('<html>'), 'text/html'),
    () => image(Buffer.alloc(0)),
    () => image(Buffer.alloc(3_000_000)),
    () => {
      throw new TypeError('fetch failed');
    },
  ];
  for (const answer of answers)
    assert.equal(
      await shareCardPhoto(UPLOADED, {
        ...OPTIONS,
        fetch: fakeFetch(answer).fetch,
      }),
      null,
    );
});

test('shareCardPhoto: a slow API gives up after the timeout, and the card still draws', async () => {
  const hang = (_url, init) =>
    new Promise((_, reject) =>
      init.signal.addEventListener('abort', () => reject(init.signal.reason)),
    );
  const started = Date.now();
  assert.equal(
    await shareCardPhoto(UPLOADED, {
      ...OPTIONS,
      fetch: fakeFetch(hang).fetch,
      timeoutMs: 50,
    }),
    null,
  );
  assert.ok(Date.now() - started < 1000);
});
