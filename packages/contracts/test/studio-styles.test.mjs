import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLASSIC_PURPLE,
  STUDIO_ACCENTS,
  STUDIO_ACCENT_IDS,
  STUDIO_FREE_STYLES,
  STUDIO_STYLES,
  STUDIO_STYLE_IDS,
  STUDIO_DEEP_SHEEN,
  STUDIO_TILES_RING_MIX,
  accentValues,
  blend,
  contrastRatio,
  hexToOklch,
  oklchToHex,
  studioContrastPairs,
  studioTokens,
} from '../dist/index.js';

const CURATED = STUDIO_ACCENT_IDS.filter((id) => id !== 'photo');
const MODES = ['light', 'dark'];

// The canvas's nine, in its order; Creator and Professional (addendum §5.1) follow them.
const ORIGINAL_NINE = [
  'classic',
  'clear',
  'journal',
  'stage',
  'signboard',
  'sprint',
  'tiles',
  'linen',
  'horizon',
];
const NEW_STYLES = ['creator', 'professional'];

test('eleven styles: the canvas nine, then Creator and Professional; Classic, Clear, Journal and Linen are free', () => {
  assert.deepEqual(STUDIO_STYLE_IDS, [...ORIGINAL_NINE, ...NEW_STYLES]);
  assert.deepEqual(STUDIO_ACCENT_IDS, [
    'ink',
    'blue',
    'lagoon',
    'green',
    'violet',
    'rose',
    'coral',
    'amber',
    'photo',
  ]);
  assert.deepEqual(STUDIO_FREE_STYLES, [
    'classic',
    'clear',
    'journal',
    'linen',
  ]);
  for (const id of STUDIO_STYLE_IDS) {
    assert.equal(STUDIO_STYLES[id].id, id);
    assert.equal(
      STUDIO_STYLES[id].plan,
      STUDIO_FREE_STYLES.includes(id) ? 'free' : 'pro',
      id,
    );
  }
  assert.deepEqual(Object.keys(STUDIO_STYLES), [...STUDIO_STYLE_IDS]);
});

test('each style opens differently (pass 2 defaults)', () => {
  const defaults = Object.fromEntries(
    STUDIO_STYLE_IDS.map((id) => [id, STUDIO_STYLES[id].defaultAccent]),
  );
  assert.deepEqual(defaults, {
    classic: null,
    clear: 'blue',
    journal: 'green',
    stage: 'violet',
    signboard: 'amber',
    sprint: 'ink',
    tiles: 'rose',
    linen: 'coral',
    horizon: 'lagoon',
    // null: TipMe purple (addendum §6.1).
    creator: null,
    professional: 'ink',
  });
  const faces = Object.fromEntries(
    STUDIO_STYLE_IDS.map((id) => [id, STUDIO_STYLES[id].displayFont]),
  );
  assert.deepEqual(faces, {
    classic: 'dm-serif-display',
    clear: null,
    journal: 'source-serif-4',
    stage: null,
    signboard: 'unbounded',
    sprint: 'anton',
    tiles: null,
    linen: 'linen-serif',
    horizon: null,
    creator: null,
    professional: null,
  });
  for (const id of STUDIO_STYLE_IDS) {
    const s = STUDIO_STYLES[id];
    assert.equal(
      s.naturalMode,
      id === 'stage' || id === 'creator' ? 'dark' : 'light',
      id,
    );
    assert.deepEqual(s.modes, ['light', 'dark', 'auto'], id);
    assert.deepEqual(
      s.covers,
      id === 'signboard' || id === 'sprint'
        ? ['yours', 'plain']
        : ['yours', 'gradient', 'plain'],
      id,
    );
    assert.equal(
      s.needsPhoto,
      id === 'stage' || id === 'horizon' || id === 'creator',
      id,
    );
    assert.ok(s.name.length > 0 && s.mood.length > 0, id);
  }
  assert.equal(STUDIO_STYLES.classic.mood, 'Today’s TipMe page, unchanged');
  assert.equal(STUDIO_STYLES.clear.mood, 'Quiet, bright, precise');
  assert.equal(STUDIO_STYLES.horizon.mood, 'One image, a quiet name');
  for (const id of NEW_STYLES) {
    assert.equal(STUDIO_STYLES[id].plan, 'pro', id);
    assert.equal(STUDIO_STYLES[id].linksAt, 'after-identity', id);
  }
});

test('Creator and Professional have the addendum’s names and moods', () => {
  assert.equal(STUDIO_STYLES.creator.name, 'Creator');
  assert.equal(STUDIO_STYLES.creator.mood, 'Bold, personal, made to be shared');
  assert.equal(STUDIO_STYLES.professional.name, 'Professional');
  assert.equal(
    STUDIO_STYLES.professional.mood,
    'Clean, composed, easy to trust',
  );
});

test('the accent set is the canvas table', () => {
  const table = {
    ink: [
      'Ink',
      '#1d1d1f',
      '#ffffff',
      '#1d1d1f',
      '#f2f2f4',
      '#111113',
      '#f2f2f4',
    ],
    blue: [
      'Blue',
      '#0a5bd3',
      '#ffffff',
      '#0a5bd3',
      '#7ab0ff',
      '#0e1116',
      '#7ab0ff',
    ],
    lagoon: [
      'Lagoon',
      '#00707a',
      '#ffffff',
      '#00707a',
      '#4fd1d9',
      '#0e1116',
      '#4fd1d9',
    ],
    green: [
      'Green',
      '#0b7a4b',
      '#ffffff',
      '#0b7a4b',
      '#5fd49a',
      '#0e1116',
      '#5fd49a',
    ],
    violet: [
      'Violet',
      '#6b3fd0',
      '#ffffff',
      '#6b3fd0',
      '#b49bff',
      '#0e1116',
      '#b49bff',
    ],
    rose: [
      'Rose',
      '#b8235f',
      '#ffffff',
      '#b8235f',
      '#ff8db8',
      '#0e1116',
      '#ff8db8',
    ],
    coral: [
      'Coral',
      '#c4362b',
      '#ffffff',
      '#c4362b',
      '#ff8a7a',
      '#0e1116',
      '#ff8a7a',
    ],
    amber: [
      'Amber',
      '#f2b12e',
      '#1a1300',
      '#8a5800',
      '#f5c25a',
      '#1a1300',
      '#f5c25a',
    ],
  };
  assert.deepEqual(Object.keys(STUDIO_ACCENTS), CURATED);
  for (const [id, [name, lf, ll, lt, df, dl, dt]] of Object.entries(table)) {
    const a = STUDIO_ACCENTS[id];
    assert.equal(a.name, name);
    assert.deepEqual(a.light, { fill: lf, label: ll, text: lt }, `${id} light`);
    assert.deepEqual(a.dark, { fill: df, label: dl, text: dt }, `${id} dark`);
  }
  assert.deepEqual(STUDIO_ACCENTS.amber.light, {
    fill: '#f2b12e',
    label: '#1a1300',
    text: '#8a5800',
  });
  assert.deepEqual(STUDIO_ACCENTS.violet.dark, {
    fill: '#b49bff',
    label: '#0e1116',
    text: '#b49bff',
  });
  assert.equal(CLASSIC_PURPLE.name, 'TipMe purple');
  assert.equal(CLASSIC_PURPLE.light.fill, '#7a32f9');
  assert.equal(CLASSIC_PURPLE.light.label, '#ffffff');
  assert.equal(CLASSIC_PURPLE.dark.fill, '#c8aeff');
  assert.equal(CLASSIC_PURPLE.dark.label, '#141210');
});

test('every style’s neutrals are the spec’s', () => {
  const core = (n) => ({
    bg: n.bg,
    card: n.card,
    el2: n.el2,
    fg: n.fg,
    fg2: n.fg2,
    line: n.line,
  });
  const n = (id, mode) => core(STUDIO_STYLES[id].neutrals[mode]);
  const row = (bg, card, el2, fg, fg2, line) => ({
    bg,
    card,
    el2,
    fg,
    fg2,
    line,
  });

  // §9.1 and the canvas "Classic · phone" palette. Classic's line is the canvas border
  // (rgba 14%) composited over its canvas colour.
  assert.deepEqual(
    n('classic', 'light'),
    row(
      '#f3f2ee',
      '#fffefa',
      '#eeede8',
      '#000000',
      '#5d5a54',
      blend('#141210', 0.14, '#f3f2ee'),
    ),
  );
  assert.deepEqual(
    n('classic', 'dark'),
    row(
      '#141210',
      '#1e1b18',
      '#2a2622',
      '#f3f2ee',
      '#c9c4ba',
      blend('#ffffff', 0.14, '#141210'),
    ),
  );
  assert.equal(STUDIO_STYLES.classic.neutrals.light.base, '#ffffff');
  assert.equal(STUDIO_STYLES.classic.neutrals.dark.base, '#2a2622');
  // §9.2
  assert.deepEqual(
    n('clear', 'light'),
    row('#f5f5f7', '#ffffff', '#ececf0', '#1d1d1f', '#6e6e73', '#e3e3e8'),
  );
  assert.deepEqual(
    n('clear', 'dark'),
    row('#111113', '#1c1c1e', '#2a2a2e', '#f5f5f7', '#a1a1a6', '#2e2e33'),
  );
  assert.equal(STUDIO_STYLES.clear.neutrals.light.track, '#e8e8ed');
  assert.equal(STUDIO_STYLES.clear.neutrals.light.thumb, '#ffffff');
  assert.equal(STUDIO_STYLES.clear.neutrals.dark.track, '#1c1c1e');
  assert.equal(STUDIO_STYLES.clear.neutrals.dark.thumb, '#3a3a3f');
  // §9.3
  assert.deepEqual(
    n('journal', 'light'),
    row('#ffffff', '#ffffff', '#f4f2ef', '#1c1b1a', '#686460', '#e4e1dc'),
  );
  assert.deepEqual(
    n('journal', 'dark'),
    row('#141413', '#1d1c1a', '#262522', '#edebe8', '#a8a39d', '#2f2d2a'),
  );
  // §9.4
  assert.deepEqual(
    n('stage', 'light'),
    row('#f2f2f4', '#ffffff', '#e8e8ec', '#16161a', '#64646c', '#dedee3'),
  );
  assert.deepEqual(
    n('stage', 'dark'),
    row('#0f0f12', '#1a1a1f', '#25252b', '#f4f4f6', '#a3a3ad', '#2c2c33'),
  );
  assert.equal(STUDIO_STYLES.stage.neutrals.light.chip, '#ffffff');
  assert.equal(STUDIO_STYLES.stage.neutrals.dark.chip, '#1a1a1f');
  assert.equal(STUDIO_STYLES.stage.neutrals.light.scrimEnd, 'rgba(8,8,10,.86)');
  assert.equal(STUDIO_STYLES.stage.neutrals.dark.scrimEnd, '#0f0f12');
  // The canvas's desktop Tip card sets its chips on `chipIn` (StageDesktop: --chip: var(--chipIn)).
  assert.equal(STUDIO_STYLES.stage.neutrals.light.chipIn, '#f2f2f4');
  assert.equal(STUDIO_STYLES.stage.neutrals.dark.chipIn, '#25252b');
  // §9.5
  assert.deepEqual(
    n('signboard', 'light'),
    row('#faf8f3', '#ffffff', '#f1ede3', '#17150f', '#5e584c', '#17150f'),
  );
  assert.deepEqual(
    n('signboard', 'dark'),
    row('#14130f', '#1f1d18', '#2a2721', '#f3f0e8', '#ada697', '#cfc8b8'),
  );
  assert.equal(STUDIO_STYLES.signboard.neutrals.light.ink, '#17150f');
  assert.equal(STUDIO_STYLES.signboard.neutrals.light.shadow, '#17150f');
  assert.equal(STUDIO_STYLES.signboard.neutrals.dark.ink, '#cfc8b8');
  assert.equal(STUDIO_STYLES.signboard.neutrals.dark.shadow, '#000000');
  // §9.6
  assert.deepEqual(
    n('sprint', 'light'),
    row('#ffffff', '#f5f5f5', '#ededed', '#111111', '#6b6b6d', '#e2e2e2'),
  );
  assert.deepEqual(
    n('sprint', 'dark'),
    row('#121212', '#1e1e1e', '#2a2a2a', '#f5f5f5', '#a8a8aa', '#2e2e2e'),
  );
  // §9.7
  assert.deepEqual(
    n('tiles', 'light'),
    row('#eeeef1', '#ffffff', '#f4f4f6', '#1d1d1f', '#6a6a70', '#e3e3e8'),
  );
  assert.deepEqual(
    n('tiles', 'dark'),
    row('#0f0f11', '#1c1c1f', '#26262a', '#f5f5f7', '#a1a1a8', '#2c2c31'),
  );
  assert.equal(
    STUDIO_STYLES.tiles.neutrals.light.shadow,
    '0 1px 2px rgba(20,20,30,.05), 0 6px 16px rgba(20,20,30,.05)',
  );
  assert.equal(STUDIO_STYLES.tiles.neutrals.dark.shadow, 'none');
  // §9.8
  assert.deepEqual(
    n('linen', 'light'),
    row('#f6f1e8', '#fffdf8', '#efe8db', '#2b2520', '#6a5f55', '#e3d9c8'),
  );
  assert.deepEqual(
    n('linen', 'dark'),
    row('#1a1613', '#24201b', '#2e2923', '#f1eadf', '#aea293', '#3a332b'),
  );
  assert.equal(STUDIO_STYLES.linen.neutrals.light.mat, '#fffdf8');
  assert.equal(STUDIO_STYLES.linen.neutrals.dark.mat, '#2e2923');
  // §9.9
  assert.deepEqual(
    n('horizon', 'light'),
    row('#ffffff', '#f4f4f4', '#eaeaea', '#171a20', '#5c5e62', '#e2e2e2'),
  );
  assert.deepEqual(
    n('horizon', 'dark'),
    row('#111214', '#1c1d20', '#27282c', '#f2f3f5', '#a4a7ad', '#2d2e32'),
  );
  // Addendum §5.2.
  assert.deepEqual(
    n('creator', 'dark'),
    row('#0e0b16', '#1a1626', '#262033', '#f5f3fa', '#aba5ba', '#2e2840'),
  );
  assert.deepEqual(
    n('creator', 'light'),
    row('#f7f5fc', '#ffffff', '#eeeaf6', '#17131f', '#5f5970', '#e2ddec'),
  );
  assert.deepEqual(
    n('professional', 'light'),
    row('#f2efea', '#faf8f4', '#ece8e1', '#16151a', '#5e5b63', '#e4dfd6'),
  );
  assert.deepEqual(
    n('professional', 'dark'),
    row('#0f0f11', '#18181b', '#2a2a2f', '#f4f4f6', '#a6a6ae', '#2e2e33'),
  );
  assert.equal(STUDIO_STYLES.creator.neutrals.dark.control, '#6e6780');
  assert.equal(STUDIO_STYLES.creator.neutrals.light.control, '#8f889e');
  assert.equal(STUDIO_STYLES.professional.neutrals.light.control, '#8a857d');
  assert.equal(STUDIO_STYLES.professional.neutrals.dark.control, '#6c6c74');
  assert.equal(STUDIO_STYLES.professional.neutrals.light.row, '#ffffff');
  assert.equal(STUDIO_STYLES.professional.neutrals.dark.row, '#202024');
  assert.equal(STUDIO_STYLES.creator.neutrals.light.row, undefined);
  assert.equal(STUDIO_STYLES.creator.neutrals.dark.row, undefined);

  // Dark mode never uses #000 surfaces (§4.2).
  for (const id of STUDIO_STYLE_IDS)
    for (const k of ['bg', 'card', 'el2'])
      assert.notEqual(
        STUDIO_STYLES[id].neutrals.dark[k],
        '#000000',
        `${id} ${k}`,
      );
});

const failuresOf = (pairs) =>
  pairs
    .map((p) => ({ ...p, ratio: contrastRatio(p.fg, p.bg) }))
    .filter((p) => p.ratio < p.min)
    .map(
      (p) => `${p.name}: ${p.fg} on ${p.bg} ${p.ratio.toFixed(2)} < ${p.min}`,
    );

const creatorTip = (accent, mode, photo) => {
  const t = studioTokens('creator', accent, photo)[mode];
  return { fill: t.deep, label: t.deepLabel };
};

test('every style × accent × mode meets its contrast minimums (exhaustive)', () => {
  let combinations = 0;
  const failures = [];
  for (const style of STUDIO_STYLE_IDS)
    // The 8 curated accents, plus `null`: the style's default (TipMe purple on Classic).
    for (const accent of [...CURATED, null])
      for (const mode of MODES) {
        // Creator's Tip draws the light pair in dark too (studioDeep): the exhaustive proof
        // passes the pair the page draws, so its edge is proven against each mode's page.
        const tip = style === 'creator' ? creatorTip(accent, mode) : undefined;
        const pairs = studioContrastPairs(
          style,
          accentValues(style, accent, mode),
          mode,
          tip,
        );
        // 10 pairs every style draws, plus at least one signature selected-state pair.
        assert.ok(
          pairs.length >= 11,
          `${style} ${accent} ${mode}: ${pairs.length} pairs`,
        );
        for (const f of failuresOf(pairs))
          failures.push(`${style} · ${accent ?? 'default'} · ${mode} · ${f}`);
        combinations += 1;
      }
  // 11 styles × (8 curated + the default) × 2 modes.
  assert.equal(combinations, 198);
  assert.deepEqual(failures, []);
});

test('every style but Classic proves its unselected chip border at 3:1', () => {
  const controls = {
    clear: ['#8e8d92', '#66676c'],
    journal: ['#979490', '#696763'],
    stage: ['#8c8b90', '#65656d'],
    sprint: ['#8e8e8e', '#696868'],
    linen: ['#948a7b', '#716961'],
    horizon: ['#8e8d8e', '#66686c'],
    creator: ['#8f889e', '#6e6780'],
    professional: ['#8a857d', '#6c6c74'],
  };
  for (const [id, [light, dark]] of Object.entries(controls)) {
    assert.equal(STUDIO_STYLES[id].neutrals.light.control, light, id);
    assert.equal(STUDIO_STYLES[id].neutrals.dark.control, dark, id);
  }
  assert.equal(STUDIO_TILES_RING_MIX, 0.64);
  for (const style of STUDIO_STYLE_IDS)
    for (const mode of MODES) {
      const borders = studioContrastPairs(
        style,
        accentValues(style, null, mode),
        mode,
      ).filter((p) => p.name.startsWith('unselected chip border'));
      if (style === 'classic') assert.equal(borders.length, 0);
      else {
        assert.ok(borders.length >= 1, `${style} ${mode}`);
        for (const p of borders) assert.equal(p.min, 3);
      }
    }
});

test('Classic’s fg3 is today’s tertiary text, proved at 4.5:1 wherever a style defines fg3', () => {
  // packages/ui/src/tokens.css --text-tertiary (17 Nov: #77736b failed 4.5:1).
  assert.equal(STUDIO_STYLES.classic.neutrals.light.fg3, '#6e6a63');
  assert.equal(STUDIO_STYLES.classic.neutrals.dark.fg3, '#a39e94');
  for (const style of STUDIO_STYLE_IDS)
    for (const mode of MODES) {
      const n = STUDIO_STYLES[style].neutrals[mode];
      const fg3 = studioContrastPairs(
        style,
        accentValues(style, null, mode),
        mode,
      ).filter((p) => p.name.startsWith('fg3 on'));
      if (!n.fg3) {
        assert.equal(fg3.length, 0, `${style} ${mode}`);
        continue;
      }
      assert.deepEqual(
        fg3.map((p) => [p.fg, p.bg, p.min]),
        [n.bg, n.card, n.el2].map((bg) => [n.fg3, bg, 4.5]),
        `${style} ${mode}`,
      );
    }
});

test('Tiles’ focus ring inside the Tip tile is accLabel, proved on acc', () => {
  for (const accent of [...CURATED, null])
    for (const mode of MODES) {
      const a = accentValues('tiles', accent, mode);
      const pair = studioContrastPairs('tiles', a, mode).find(
        (p) => p.name === 'focus ring inside the Tip tile',
      );
      assert.deepEqual(pair, {
        name: 'focus ring inside the Tip tile',
        fg: a.label,
        bg: a.fill,
        min: 3,
      });
      assert.equal(studioTokens('tiles', accent)[mode].tileFocus, a.label);
    }
  assert.equal(studioTokens('clear', null).light.tileFocus, undefined);
});

test('Classic is checked on every surface it puts link text on', () => {
  const light = studioContrastPairs('classic', CLASSIC_PURPLE.light, 'light');
  const dark = studioContrastPairs('classic', CLASSIC_PURPLE.dark, 'dark');
  const linkBgs = (pairs) =>
    pairs.filter((p) => p.name.startsWith('link')).map((p) => p.bg);
  assert.deepEqual(linkBgs(light), [
    '#f3f2ee',
    '#fffefa',
    '#eeede8',
    '#ffffff',
  ]);
  assert.deepEqual(linkBgs(dark), ['#141210', '#1e1b18', '#2a2622']);
});

test('on Clear the lowest accent ratio is violet on the dark segmented thumb, 4.9:1', () => {
  let lowest = { ratio: Infinity };
  for (const accent of [...CURATED, null])
    for (const mode of MODES)
      for (const p of studioContrastPairs(
        'clear',
        accentValues('clear', accent, mode),
        mode,
      )) {
        if (!/acc/.test(p.name)) continue; // the board's numbers are the accent's pairs
        const ratio = contrastRatio(p.fg, p.bg);
        if (ratio < lowest.ratio) lowest = { ...p, ratio, accent, mode };
      }
  assert.equal(Math.round(lowest.ratio * 10) / 10, 4.9);
  assert.equal(lowest.name, 'accText on thumb');
  assert.equal(lowest.accent, 'violet');
  assert.equal(lowest.mode, 'dark');
});

test('the checker catches a failing pair', () => {
  const bad = { fill: '#ffff00', label: '#ffffff', text: '#ffff00' };
  for (const style of STUDIO_STYLE_IDS)
    assert.ok(
      failuresOf(studioContrastPairs(style, bad, 'light')).length > 0,
      style,
    );
});

test('photo accent uses the stored photo values, and falls back to the style default without them', () => {
  const photo = {
    light: { fill: '#a2461e', label: '#ffffff', text: '#a2461e' },
    dark: { fill: '#f29a6b', label: '#140c08', text: '#f29a6b' },
  };
  assert.deepEqual(accentValues('clear', 'photo', 'dark', photo), photo.dark);
  assert.deepEqual(
    accentValues('clear', 'photo', 'light', null),
    STUDIO_ACCENTS.blue.light,
  );
  assert.deepEqual(
    accentValues('classic', 'photo', 'dark'),
    CLASSIC_PURPLE.dark,
  );
  assert.deepEqual(
    accentValues('classic', null, 'light'),
    CLASSIC_PURPLE.light,
  );
  assert.deepEqual(
    accentValues('tiles', null, 'dark'),
    STUDIO_ACCENTS.rose.dark,
  );
  assert.deepEqual(
    accentValues('tiles', 'amber', 'light'),
    STUDIO_ACCENTS.amber.light,
  );
});

test('chipOn is the accent mixed into bg in OKLab, and matches the board for Green', () => {
  const close = (a, b, units) => {
    for (const i of [1, 3, 5])
      assert.ok(
        Math.abs(
          Number.parseInt(a.slice(i, i + 2), 16) -
            Number.parseInt(b.slice(i, i + 2), 16),
        ) <= units,
        `${a} vs ${b}`,
      );
  };
  close(studioTokens('journal', 'green').light.chipOn, '#f1f7f3', 1);
  // The board's dark chipOn is no exact OKLab mix of any amount; the nearest is 2 units off.
  close(studioTokens('journal', 'green').dark.chipOn, '#1a2620', 2);
  // Only the chip styles carry it, and it follows the accent.
  assert.notEqual(
    studioTokens('linen', 'rose').light.chipOn,
    studioTokens('linen', 'green').light.chipOn,
  );
  assert.equal(studioTokens('clear', null).light.chipOn, undefined);
});

test('tokens carry neutrals and accent for both modes; Classic with no accent is TipMe purple', () => {
  assert.equal(studioTokens('clear', null).light.acc, '#0a5bd3');
  assert.equal(studioTokens('clear', null).dark.acc, '#7ab0ff');
  assert.equal(studioTokens('classic', null).dark.acc, '#c8aeff');
  assert.equal(studioTokens('classic', null).light.acc, '#7a32f9');
  assert.equal(studioTokens('signboard', null).light.accText, '#8a5800');
  assert.equal(studioTokens('signboard', null).light.accLabel, '#1a1300');
  assert.equal(studioTokens('clear', null).light.bar, '#f5f5f7d9');
  assert.equal(studioTokens('clear', null).dark.thumb, '#3a3a3f');
  assert.equal(studioTokens('stage', null).dark.glow, '#b49bff');
  assert.equal(studioTokens('stage', null).light.glow, 'none');
  for (const style of STUDIO_STYLE_IDS)
    for (const accent of [...STUDIO_ACCENT_IDS, null]) {
      const t = studioTokens(style, accent);
      for (const mode of MODES) {
        for (const [k, v] of Object.entries(t[mode])) {
          assert.match(k, /^[a-zA-Z0-9]+$/, `${style} ${mode} ${k}`);
          assert.equal(typeof v, 'string');
        }
        for (const k of [
          'bg',
          'card',
          'el2',
          'fg',
          'fg2',
          'line',
          'acc',
          'accLabel',
          'accText',
          'bar',
        ])
          assert.ok(t[mode][k], `${style} ${accent} ${mode} ${k}`);
      }
    }
});

test("Stage proves its chips on chip and on the desktop card's chipIn, in both modes", () => {
  for (const mode of MODES)
    for (const accent of [...CURATED, null]) {
      const names = studioContrastPairs(
        'stage',
        accentValues('stage', accent, mode),
        mode,
      ).map((p) => p.name);
      for (const name of [
        'chip label (fg) on chip',
        'selected ring (accText) on chip',
        'chip label (fg) on chipIn',
        'selected ring (accText) on chipIn',
      ])
        assert.ok(names.includes(name), `${accent} ${mode}: ${name}`);
    }
});

// Addendum §6.1: Creator's big Tip uses the accent's light pair in both modes, except where the
// light pair is Ink's (a near-black button would vanish on the dark page): there the dark pair.
test('deep tokens exist in both modes and follow the Ink exception by value', () => {
  const blue = studioTokens('creator', 'blue');
  assert.equal(blue.dark.deep, '#0a5bd3');
  assert.equal(blue.dark.deepLabel, '#ffffff');
  assert.equal(studioTokens('creator', null).dark.deep, '#7a32f9');
  assert.equal(studioTokens('creator', null).dark.deepLabel, '#ffffff');
  const ink = studioTokens('creator', 'ink');
  assert.equal(ink.dark.deep, '#f2f2f4');
  assert.equal(ink.dark.deepLabel, '#111113');
  assert.equal(ink.light.deep, '#1d1d1f');
  // "From your photo" stored as failed with Ink as its fallback resolves to Ink's values.
  const failed = studioTokens('creator', 'photo', {
    failed: true,
    fallback: 'ink',
  });
  assert.equal(failed.dark.deep, '#f2f2f4');
  assert.equal(failed.dark.deepLabel, '#111113');
  const photo = {
    light: { fill: '#a2461e', label: '#ffffff', text: '#a2461e' },
    dark: { fill: '#f29a6b', label: '#140c08', text: '#f29a6b' },
  };
  const fromPhoto = studioTokens('creator', 'photo', photo);
  assert.equal(fromPhoto.dark.deep, photo.light.fill);
  assert.equal(fromPhoto.dark.deepLabel, photo.light.label);
  for (const accent of [...STUDIO_ACCENT_IDS, null]) {
    const t = studioTokens('creator', accent);
    assert.equal(t.light.deep, t.light.acc, `${accent}`);
    assert.equal(t.light.deepLabel, t.light.accLabel, `${accent}`);
    // The sheen's lower end: deep darkened in OKLCH lightness, hue and chroma kept.
    for (const mode of MODES) {
      const { l, c, h } = hexToOklch(t[mode].deep);
      assert.equal(
        t[mode].deepEnd,
        oklchToHex({ l: l - STUDIO_DEEP_SHEEN, c, h }),
        `${accent} ${mode}`,
      );
    }
  }
  assert.ok(STUDIO_DEEP_SHEEN >= 0 && STUDIO_DEEP_SHEEN <= 0.06);
  for (const style of STUDIO_STYLE_IDS) {
    if (style === 'creator') continue;
    for (const mode of MODES) {
      const t = studioTokens(style, null)[mode];
      for (const k of ['deep', 'deepEnd', 'deepLabel'])
        assert.equal(t[k], undefined, `${style} ${mode} ${k}`);
    }
  }
});

const TIP_PAIRS = [
  'deepLabel on deep',
  'deepLabel on deep (sheen end)',
  'second line on deep',
  'second line on deep (sheen end)',
];
const pairNames = (style, values, mode) =>
  studioContrastPairs(style, values, mode).map((p) => p.name);

test('Creator proves its Tip at both sheen ends and its second line, in light, and in dark only for Ink’s values', () => {
  const light = pairNames('creator', STUDIO_ACCENTS.blue.light, 'light');
  const dark = pairNames('creator', STUDIO_ACCENTS.blue.dark, 'dark');
  const inkDark = pairNames('creator', STUDIO_ACCENTS.ink.dark, 'dark');
  for (const name of TIP_PAIRS) {
    assert.ok(light.includes(name), `light: ${name}`);
    assert.ok(!dark.includes(name), `dark: ${name}`);
    assert.ok(inkDark.includes(name), `Ink dark: ${name}`);
  }
  // In light the Tip is the light pair; the sheen end is the fill darkened by the sheen.
  const pairs = studioContrastPairs(
    'creator',
    STUDIO_ACCENTS.blue.light,
    'light',
  );
  const by = (name) => pairs.find((p) => p.name === name);
  assert.deepEqual(by('deepLabel on deep'), {
    name: 'deepLabel on deep',
    fg: '#ffffff',
    bg: '#0a5bd3',
    min: 4.5,
  });
  assert.equal(
    by('deepLabel on deep (sheen end)').bg,
    studioTokens('creator', 'blue').light.deepEnd,
  );
  // Ruling P2: the second line is drawn at full opacity, so its pair is deepLabel itself.
  assert.equal(by('second line on deep').fg, '#ffffff');
  assert.equal(by('second line on deep').min, 4.5);
  // Nine other styles never carry them.
  for (const style of ORIGINAL_NINE)
    for (const name of TIP_PAIRS)
      assert.ok(
        !pairNames(style, STUDIO_ACCENTS.ink.dark, 'dark').includes(name),
        `${style}: ${name}`,
      );
});

const everyAccentAndMode = (style, names) => {
  for (const accent of [...CURATED, null])
    for (const mode of MODES) {
      const have = pairNames(style, accentValues(style, accent, mode), mode);
      for (const name of names)
        assert.ok(have.includes(name), `${style} ${accent} ${mode}: ${name}`);
    }
};

test('Creator proves chip label and selected ring on card, the badge on el2, chip borders on bg and card', () => {
  everyAccentAndMode('creator', [
    'chip label (fg) on card',
    'selected ring (accText) on card',
    'icon badge (fg) on el2',
    'unselected chip border on bg',
    'unselected chip border on card',
  ]);
});

test('Professional proves fg, fg2 and accText on row, chip borders on row and card, the selected border on row, and the badge on el2', () => {
  everyAccentAndMode('professional', [
    'fg on row',
    'fg2 on row',
    'accText on row',
    'unselected chip border on row',
    'unselected chip border on card',
    'selected border (accText) on row',
    'icon badge (fg) on el2',
  ]);
});

// Addendum §5.2, the envelope rule: a new surface an accent value is drawn on is no darker (light)
// or no lighter (dark) than the nine's extremes, so every stored photo accent stays valid.
test('new surfaces sit inside the photo-accent envelope', () => {
  const luminance = (hex) => (contrastRatio(hex, '#000000') - 1) * 0.05;
  const surfaces = (id, mode) => {
    const n = STUDIO_STYLES[id].neutrals[mode];
    return [n.bg, n.card, n.row].filter(Boolean);
  };
  const lightFloor = Math.min(
    ...ORIGINAL_NINE.flatMap((id) => surfaces(id, 'light')).map(luminance),
  );
  const darkCeiling = Math.max(
    ...ORIGINAL_NINE.flatMap((id) => surfaces(id, 'dark')).map(luminance),
  );
  assert.equal(Number(lightFloor.toPrecision(3)), 0.857);
  assert.equal(luminance('#eeeef1'), lightFloor, 'Tiles bg');
  assert.equal(Number(darkCeiling.toPrecision(3)), 0.0149);
  assert.equal(luminance('#24201b'), darkCeiling, 'Linen card');
  for (const id of NEW_STYLES) {
    for (const hex of surfaces(id, 'light'))
      assert.ok(luminance(hex) >= lightFloor, `${id} light ${hex}`);
    for (const hex of surfaces(id, 'dark'))
      assert.ok(luminance(hex) <= darkCeiling, `${id} dark ${hex}`);
  }
  assert.equal(surfaces('professional', 'light').length, 3);
  assert.equal(surfaces('professional', 'dark').length, 3);
});

// Ruling S-R2 (owner, 28 Nov: every design passes contrast and visibility): Creator's Tip keeps
// 3:1 against the page at its weakest point (WCAG 1.4.11). The sheen darkens its lower end, so the
// button carries a 1 px edge (`deepEdge`): the fill itself where the fill reaches 3:1 on bg, else
// the fill's hue moved in lightness to the nearest value that does.
test('Creator’s Tip keeps 3:1 against the page at its weakest edge, every accent and mode', () => {
  let lowest = Infinity;
  for (const accent of [...CURATED, null])
    for (const mode of MODES) {
      const t = studioTokens('creator', accent)[mode];
      assert.match(t.deepEdge, /^#[0-9a-f]{6}$/, `${accent} ${mode}`);
      const edge = contrastRatio(t.deepEdge, t.bg);
      assert.ok(edge >= 3, `${accent} ${mode}: edge ${edge.toFixed(2)}`);
      lowest = Math.min(lowest, edge);
      // The look is kept: where the fill already reaches 3:1 the edge is the fill.
      if (contrastRatio(t.deep, t.bg) >= 3)
        assert.equal(t.deepEdge, t.deep, `${accent} ${mode}`);
      const pair = studioContrastPairs(
        'creator',
        accentValues('creator', accent, mode),
        mode,
        creatorTip(accent, mode),
      ).find((p) => p.name === 'Tip edge (deepEdge) on bg');
      assert.deepEqual(pair, {
        name: 'Tip edge (deepEdge) on bg',
        fg: t.deepEdge,
        bg: t.bg,
        min: 3,
      });
    }
  assert.ok(lowest >= 3);
});

// Ruling S-R2, the phone's sticky bar (Creator plan Task 3): its `deep` pill sits on `bar`, the
// page's bg at 85% (d9) over whatever scrolls under it, so its 1 px edge (`deepBarEdge`) keeps 3:1
// against that bar over pure white and over pure black, the two ends anything under it can make.
test('Creator’s sticky Tip pill keeps 3:1 against its 85% bar over anything, every accent and mode', () => {
  const BAR = 217 / 255;
  let lowest = Infinity;
  for (const accent of [...CURATED, null])
    for (const mode of MODES) {
      const t = studioTokens('creator', accent)[mode];
      assert.equal(t.bar, `${t.bg}d9`);
      assert.match(t.deepBarEdge, /^#[0-9a-f]{6}$/, `${accent} ${mode}`);
      const pairs = studioContrastPairs(
        'creator',
        accentValues('creator', accent, mode),
        mode,
        creatorTip(accent, mode),
      );
      for (const under of ['#ffffff', '#000000']) {
        const bar = blend(t.bg, BAR, under);
        const edge = contrastRatio(t.deepBarEdge, bar);
        assert.ok(
          edge >= 3,
          `${accent} ${mode} over ${under}: ${edge.toFixed(2)}`,
        );
        lowest = Math.min(lowest, edge);
        assert.deepEqual(
          pairs.find(
            (p) =>
              p.name === `sticky Tip edge (deepBarEdge) on bar over ${under}`,
          ),
          {
            name: `sticky Tip edge (deepBarEdge) on bar over ${under}`,
            fg: t.deepBarEdge,
            bg: bar,
            min: 3,
          },
        );
      }
      // The look is kept where the in-page edge already holds on the bar.
      if (
        ['#ffffff', '#000000'].every(
          (u) => contrastRatio(t.deepEdge, blend(t.bg, BAR, u)) >= 3,
        )
      )
        assert.equal(t.deepBarEdge, t.deepEdge, `${accent} ${mode}`);
    }
  assert.ok(lowest >= 3);
});

test('Creator’s Tip edge holds 3:1 for every light fill the photo accent can make, in both modes', () => {
  // §6 step 3: light fills are clamped to OKLCH L .45–.55, chroma at most .16; labels are white.
  const dark = STUDIO_ACCENTS.blue.dark;
  for (const l of [0.45, 0.5, 0.55])
    for (const c of [0.04, 0.1, 0.16])
      for (let h = 0; h < 360; h += 10) {
        const fill = oklchToHex({ l, c, h });
        const tip = { fill, label: '#ffffff' };
        for (const [mode, values] of [
          ['light', { fill, label: '#ffffff', text: fill }],
          ['dark', dark],
        ]) {
          const pair = studioContrastPairs('creator', values, mode, tip).find(
            (p) => p.name === 'Tip edge (deepEdge) on bg',
          );
          assert.ok(pair, `${fill} ${mode}`);
          assert.ok(
            contrastRatio(pair.fg, pair.bg) >= 3,
            `${fill} ${mode}: ${contrastRatio(pair.fg, pair.bg).toFixed(2)}`,
          );
        }
      }
});

test('Creator and Professional prove fg2 on el2 (row hover, recessed surfaces)', () => {
  everyAccentAndMode('creator', ['fg2 on el2']);
  everyAccentAndMode('professional', ['fg2 on el2']);
});
