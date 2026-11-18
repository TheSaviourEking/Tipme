import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLASSIC_PURPLE,
  STUDIO_ACCENTS,
  STUDIO_ACCENT_IDS,
  STUDIO_FREE_STYLES,
  STUDIO_STYLES,
  STUDIO_STYLE_IDS,
  STUDIO_TILES_RING_MIX,
  accentValues,
  blend,
  contrastRatio,
  studioContrastPairs,
  studioTokens,
} from '../dist/index.js';

const CURATED = STUDIO_ACCENT_IDS.filter((id) => id !== 'photo');
const MODES = ['light', 'dark'];

test('nine styles in the canvas order; Classic, Clear, Journal and Linen are free', () => {
  assert.deepEqual(STUDIO_STYLE_IDS, [
    'classic',
    'clear',
    'journal',
    'stage',
    'signboard',
    'sprint',
    'tiles',
    'linen',
    'horizon',
  ]);
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
  });
  for (const id of STUDIO_STYLE_IDS) {
    const s = STUDIO_STYLES[id];
    assert.equal(s.naturalMode, id === 'stage' ? 'dark' : 'light', id);
    assert.deepEqual(s.modes, ['light', 'dark', 'auto'], id);
    assert.deepEqual(
      s.covers,
      id === 'signboard' || id === 'sprint'
        ? ['yours', 'plain']
        : ['yours', 'gradient', 'plain'],
      id,
    );
    assert.equal(s.needsPhoto, id === 'stage' || id === 'horizon', id);
    assert.ok(s.name.length > 0 && s.mood.length > 0, id);
  }
  assert.equal(STUDIO_STYLES.classic.mood, 'Today’s TipMe page, unchanged');
  assert.equal(STUDIO_STYLES.clear.mood, 'Quiet, bright, precise');
  assert.equal(STUDIO_STYLES.horizon.mood, 'One image, a quiet name');
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

test('every style × accent × mode meets its contrast minimums (exhaustive)', () => {
  let combinations = 0;
  const failures = [];
  for (const style of STUDIO_STYLE_IDS)
    // The 8 curated accents, plus `null`: the style's default (TipMe purple on Classic).
    for (const accent of [...CURATED, null])
      for (const mode of MODES) {
        const pairs = studioContrastPairs(
          style,
          accentValues(style, accent, mode),
          mode,
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
  assert.equal(combinations, 162);
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
