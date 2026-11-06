import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ADULT_PLATFORMS,
  FREE_LINK_LIMIT,
  PRO_LINK_LIMIT,
  SOCIAL_PLATFORMS,
  detectPlatform,
  linkHandle,
  linksNeedPro,
  mergeFreeSave,
  profilePatchSchema,
  socialLinkProblem,
  socialLinksSchema,
  visibleLinks,
} from '../dist/index.js';

const link = (platform, url, featured) => ({
  platform,
  url,
  ...(featured ? { featured: true } : {}),
});

test('the catalogue: the owner’s Free and Pro sites, and nothing else', () => {
  const tier = (t) =>
    Object.entries(SOCIAL_PLATFORMS)
      .filter(([, p]) => p.tier === t)
      .map(([key]) => key);
  assert.deepEqual(tier('free'), [
    'tiktok',
    'facebook',
    'instagram',
    'youtube',
    'x',
    'snapchat',
    'whatsapp',
    'twitch',
    'kick',
    'audiomack',
    'boomplay',
    'spotify',
    'applemusic',
    'soundcloud',
  ]);
  assert.deepEqual(tier('pro'), [
    'website',
    'telegram',
    'linkedin',
    'threads',
    'patreon',
    'selar',
    'substack',
    'onlyfans',
    'fansly',
  ]);
  assert.equal(FREE_LINK_LIMIT, 3);
  assert.equal(PRO_LINK_LIMIT, 8);
});

test('each site accepts only its own https addresses', () => {
  const ok = [
    ['tiktok', 'https://www.tiktok.com/@ada.edits'],
    ['facebook', 'https://web.facebook.com/ada'],
    ['instagram', 'https://instagram.com/ada.edits'],
    ['youtube', 'https://www.youtube.com/@adaedits'],
    ['x', 'https://twitter.com/ada'],
    ['x', 'https://x.com/ada'],
    ['snapchat', 'https://www.snapchat.com/add/ada'],
    ['whatsapp', 'https://whatsapp.com/channel/0029VaABCDEF'],
    ['twitch', 'https://twitch.tv/adaedits'],
    ['kick', 'https://kick.com/ada'],
    ['audiomack', 'https://audiomack.com/ada'],
    ['boomplay', 'https://www.boomplay.com/artists/123456'],
    ['spotify', 'https://open.spotify.com/artist/1a2b3c'],
    ['applemusic', 'https://music.apple.com/ng/artist/ada/123'],
    ['soundcloud', 'https://soundcloud.com/ada'],
    ['telegram', 'https://t.me/adaedits'],
    ['linkedin', 'https://www.linkedin.com/in/ada-okafor'],
    ['threads', 'https://www.threads.com/@ada'],
    ['threads', 'https://threads.net/@ada'],
    ['patreon', 'https://www.patreon.com/ada'],
    ['selar', 'https://selar.com/ada'],
    ['selar', 'https://selar.co/ada'],
    ['substack', 'https://ada.substack.com'],
    ['substack', 'https://substack.com/@ada'],
    ['onlyfans', 'https://onlyfans.com/ada'],
    ['fansly', 'https://fansly.com/ada'],
    ['website', 'https://adaedits.com'],
  ];
  for (const [platform, url] of ok)
    assert.equal(socialLinkProblem(platform, url), null, `${platform} ${url}`);
  const bad = [
    ['instagram', 'https://evil.example/ada'],
    ['instagram', 'http://instagram.com/ada'],
    ['instagram', 'https://user:pw@instagram.com/ada'],
    ['instagram', 'https://instagram.com.evil.example/ada'],
    ['instagram', 'https://instagram.com/'],
    ['instagram', `https://instagram.com/${'a'.repeat(200)}`],
    ['whatsapp', 'https://whatsapp.com/ada'],
    ['whatsapp', 'https://wa.me/2348030000000'],
    ['telegram', 'https://t.me/+AbCdEf'],
    ['telegram', 'https://t.me/joinchat/AbCdEf'],
    ['tiktok', 'not a url'],
  ];
  for (const [platform, url] of bad)
    assert.equal(
      socialLinkProblem(platform, url),
      'invalid',
      `${platform} ${url}`,
    );
});

test('a website is any https site, but never a link page, a shortener or a listed site', () => {
  for (const url of [
    'https://linktr.ee/ada',
    'https://www.linktr.ee/ada',
    'https://beacons.ai/ada',
    'https://ada.bio.link',
    'https://bit.ly/abc',
    'https://lnk.to/ada',
  ])
    assert.equal(socialLinkProblem('website', url), 'link_page', url);
  for (const url of [
    'https://instagram.com/ada',
    'https://onlyfans.com/ada',
    'https://ada.substack.com',
  ])
    assert.equal(socialLinkProblem('website', url), 'listed_site', url);
  for (const url of [
    'https://127.0.0.1/',
    'https://localhost/',
    'https://[::1]/',
    'https://adaedits.com:8443/',
    'http://adaedits.com',
  ])
    assert.equal(socialLinkProblem('website', url), 'invalid', url);
  // Linktree as any other site is refused too.
  assert.equal(
    socialLinkProblem('instagram', 'https://linktr.ee/ada'),
    'invalid',
  );
});

test('pasting a link finds its site', () => {
  assert.equal(detectPlatform('https://www.tiktok.com/@ada?_t=8x'), 'tiktok');
  assert.equal(detectPlatform('https://ada.substack.com/p/hi'), 'substack');
  assert.equal(detectPlatform('https://adaedits.com'), 'website');
  assert.equal(detectPlatform('https://linktr.ee/ada'), null);
  assert.equal(detectPlatform('tiktok.com/@ada'), null);
});

test('the handle shown is read from the link', () => {
  assert.equal(
    linkHandle(link('tiktok', 'https://tiktok.com/@ada.edits')),
    '@ada.edits',
  );
  assert.equal(
    linkHandle(link('instagram', 'https://instagram.com/ada.edits/')),
    '@ada.edits',
  );
  assert.equal(
    linkHandle(link('instagram', 'https://instagram.com/p/xyz')),
    null,
  );
  assert.equal(
    linkHandle(link('youtube', 'https://youtube.com/@adaedits')),
    '@adaedits',
  );
  assert.equal(
    linkHandle(link('youtube', 'https://youtube.com/channel/UC1')),
    null,
  );
  assert.equal(
    linkHandle(link('twitch', 'https://twitch.tv/adaedits')),
    '@adaedits',
  );
  assert.equal(
    linkHandle(link('linkedin', 'https://linkedin.com/in/ada-o')),
    'in/ada-o',
  );
  assert.equal(
    linkHandle(link('website', 'https://www.adaedits.com/shop')),
    'adaedits.com',
  );
  assert.equal(
    linkHandle(link('substack', 'https://ada.substack.com')),
    'ada.substack.com',
  );
  assert.equal(
    linkHandle(link('spotify', 'https://open.spotify.com/artist/1')),
    null,
  );
});

test('the list: at most 11 stored, one featured, no repeated link, errors by position', () => {
  const tt = link('tiktok', 'https://tiktok.com/@ada');
  assert.equal(socialLinksSchema.safeParse([]).success, true);
  assert.equal(socialLinksSchema.safeParse([tt, tt]).success, false);
  const two = socialLinksSchema.safeParse([
    link('tiktok', 'https://tiktok.com/@a', true),
    link('twitch', 'https://twitch.tv/a', true),
  ]);
  assert.equal(two.success, false);
  const bad = socialLinksSchema.safeParse([
    tt,
    link('instagram', 'https://evil.example/ada'),
  ]);
  assert.deepEqual(
    bad.error.issues.map((issue) => issue.path.join('.')),
    ['1.url'],
  );
  assert.equal(
    socialLinksSchema.safeParse([
      { platform: 'myspace', url: 'https://myspace.com/a' },
    ]).success,
    false,
  );
  const many = Array.from({ length: 12 }, (_, i) =>
    link('website', `https://ada${i}.com`),
  );
  assert.equal(socialLinksSchema.safeParse(many).success, false);
});

test('what needs Pro: a fourth link, a Pro site, a featured link or a custom order', () => {
  const tt = link('tiktok', 'https://tiktok.com/@ada');
  const ig = link('instagram', 'https://instagram.com/ada');
  const yt = link('youtube', 'https://youtube.com/@ada');
  const x = link('x', 'https://x.com/ada');
  assert.equal(linksNeedPro([tt, ig, yt]), false);
  assert.equal(linksNeedPro([tt, ig, yt, x]), true);
  assert.equal(linksNeedPro([link('telegram', 'https://t.me/adaedits')]), true);
  assert.equal(linksNeedPro([{ ...tt, featured: true }]), true);
  assert.equal(linksNeedPro([ig, tt]), true);
  // Two of one site may sit together in either order.
  assert.equal(
    linksNeedPro([tt, link('tiktok', 'https://tiktok.com/@ada2')]),
    false,
  );
});

test('when Pro lapses: the first 3 Free-site links show, unfeatured, and nothing is lost', () => {
  const stored = [
    link('twitch', 'https://twitch.tv/ada', true),
    link('telegram', 'https://t.me/adaedits'),
    link('tiktok', 'https://tiktok.com/@ada'),
    link('instagram', 'https://instagram.com/ada'),
    link('youtube', 'https://youtube.com/@ada'),
    link('website', 'https://adaedits.com'),
  ];
  assert.deepEqual(visibleLinks(stored, 'pro'), stored);
  assert.deepEqual(visibleLinks(stored, 'free'), [
    link('twitch', 'https://twitch.tv/ada'),
    link('tiktok', 'https://tiktok.com/@ada'),
    link('instagram', 'https://instagram.com/ada'),
  ]);
  // Pro shows at most 8, even if more were kept.
  const eleven = Array.from({ length: 11 }, (_, i) =>
    link('website', `https://ada${i}.com`),
  );
  assert.equal(visibleLinks(eleven, 'pro').length, 8);

  // A Free save replaces the links that show and keeps the hidden ones after them.
  const saved = mergeFreeSave(stored, [
    link('facebook', 'https://facebook.com/ada'),
    link('youtube', 'https://youtube.com/@ada'),
  ]);
  assert.deepEqual(saved, [
    link('facebook', 'https://facebook.com/ada'),
    link('youtube', 'https://youtube.com/@ada'),
    link('telegram', 'https://t.me/adaedits'),
    link('website', 'https://adaedits.com'),
  ]);
  assert.deepEqual(visibleLinks(saved, 'free'), [
    link('facebook', 'https://facebook.com/ada'),
    link('youtube', 'https://youtube.com/@ada'),
  ]);
  // Once a kept link is saved again on Free, it isn't kept twice.
  assert.deepEqual(
    mergeFreeSave(
      [
        link('tiktok', 'https://tiktok.com/@a'),
        link('kick', 'https://kick.com/a'),
        link('x', 'https://x.com/a'),
        link('twitch', 'https://twitch.tv/a'),
      ],
      [
        link('tiktok', 'https://tiktok.com/@a'),
        link('twitch', 'https://twitch.tv/a'),
      ],
    ),
    [
      link('tiktok', 'https://tiktok.com/@a'),
      link('twitch', 'https://twitch.tv/a'),
    ],
  );
});

test('links are stored normalised, and repeats are found on the normalised form', () => {
  const parsed = socialLinksSchema.safeParse([
    link('instagram', '  https://Instagram.com/ada  '),
  ]);
  assert.equal(parsed.success, true);
  assert.equal(parsed.data[0].url, 'https://instagram.com/ada');
  for (const url of [
    'https://insta\ngram.com/ada',
    'https:\\\\instagram.com\\ada',
    'https://instagram.com/a da',
  ])
    assert.equal(socialLinkProblem('instagram', url), 'invalid', url);
  for (const pair of [
    ['https://x.com/a', 'https://x.com/a/'],
    ['https://x.com/a', 'https://X.com/a'],
  ])
    assert.equal(
      socialLinksSchema.safeParse(pair.map((url) => link('x', url))).success,
      false,
      pair.join(' '),
    );
});

test('redirect pages on listed sites are refused like link pages', () => {
  assert.equal(
    socialLinkProblem(
      'facebook',
      'https://facebook.com/l.php?u=https%3A%2F%2Flinktr.ee%2Fx',
    ),
    'link_page',
  );
  assert.equal(
    socialLinkProblem(
      'youtube',
      'https://www.youtube.com/redirect?q=https://a.b',
    ),
    'link_page',
  );
  for (const url of [
    'https://l.instagram.com/?u=x',
    'https://l.facebook.com/l.php',
  ])
    assert.equal(socialLinkProblem('website', url), 'link_page', url);
  for (const url of [
    'https://linktree.co/ada',
    'https://stan.store/ada',
    'https://taplink.cc/ada',
    'https://ada.carrd.co',
  ])
    assert.equal(socialLinkProblem('website', url), 'link_page', url);
});

test('a Free save keeps only the hidden links the owner still lists', () => {
  const stored = [
    link('tiktok', 'https://tiktok.com/@a'),
    link('telegram', 'https://t.me/adaedits'),
    link('onlyfans', 'https://onlyfans.com/ada'),
  ];
  assert.deepEqual(
    mergeFreeSave(
      stored,
      [link('tiktok', 'https://tiktok.com/@a')],
      ['https://t.me/adaedits'],
    ),
    [
      link('tiktok', 'https://tiktok.com/@a'),
      link('telegram', 'https://t.me/adaedits'),
    ],
  );
  // A hidden link can't be brought in by naming it: only stored ones are kept.
  assert.deepEqual(mergeFreeSave(stored, [], ['https://kick.com/new']), []);
});

test('adult platforms can be switched off: hidden from the page, never deleted', () => {
  const stored = [
    link('onlyfans', 'https://onlyfans.com/ada'),
    link('tiktok', 'https://tiktok.com/@a'),
  ];
  assert.deepEqual(visibleLinks(stored, 'pro', { adult: false }), [
    link('tiktok', 'https://tiktok.com/@a'),
  ]);
  assert.deepEqual(visibleLinks(stored, 'pro'), stored);
  assert.deepEqual([...ADULT_PLATFORMS], ['onlyfans', 'fansly']);
});

test('the profile form still takes, and ignores, the old three links for one release', () => {
  const parsed = profilePatchSchema.safeParse({
    displayName: 'Ada',
    socials: { instagram: 'https://instagram.com/ada' },
    socialsPublic: true,
  });
  assert.equal(parsed.success, true);
});
