// Page Studio renderer source rules (plan Task 5): no raw HTML or user-built styles, a grid that
// matches the design check's layout model, and nothing that reaches into TipMe's tip block.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { STUDIO_GRID } from '../packages/contracts/dist/index.js';
import { STUDIO_COLOUR_TOKENS } from '../apps/web/src/components/studio/studio-theme.ts';

const DIR = new URL('../apps/web/src/components/studio/', import.meta.url);
const files = readdirSync(DIR).filter((f) => /\.(tsx?|css)$/.test(f));
const read = (f) => readFileSync(new URL(f, DIR), 'utf8');
const css = read('studio.css');
const code = files.filter((f) => /\.tsx?$/.test(f)).map((f) => [f, read(f)]);

test('no studio component renders raw HTML or builds a style from user content', () => {
  for (const [file, src] of code) {
    assert.doesNotMatch(
      src,
      /dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write/,
      file,
    );
    // Inline styles only from the theme, which reads engine tokens and registry ids.
    for (const m of src.matchAll(/style=\{([^}]*)\}/g))
      assert.match(m[1], /^\s*studioStyle\(/, `${file}: style={${m[1]}}`);
    assert.doesNotMatch(src, /\beval\(|new Function\(/, file);
  }
  // The stylesheet loader (it renders nothing; it keeps studio.css off the /@username route so a
  // prefetch never preloads it, studio-styles.tsx). The video island moved to studio-styles/.
  assert.deepEqual(
    code.filter(([, src]) => /^['"]use client['"]/m.test(src)).map(([f]) => f),
    ['studio-sheet.tsx', 'studio-styles.tsx'],
  );
  assert.match(read('studio-sheet.tsx'), /return null;/);
});

test('the grid CSS and the layout model use the same constants', () => {
  const px = (name) => {
    const m = new RegExp(`--studio-grid-${name}:\\s*([\\d.]+)px`).exec(css);
    assert.ok(m, `--studio-grid-${name} is not set in studio.css`);
    return Number(m[1]);
  };
  assert.equal(px('max'), STUDIO_GRID.maxWidth);
  assert.equal(px('rail'), STUDIO_GRID.rail);
  assert.equal(px('rail-gap'), STUDIO_GRID.railGap);
  assert.equal(px('pad-phone'), STUDIO_GRID.padding.phone);
  assert.equal(px('pad-tablet'), STUDIO_GRID.padding.tablet);
  assert.equal(px('pad-desktop'), STUDIO_GRID.padding.desktop);
  assert.equal(px('gap-phone'), STUDIO_GRID.gap.phone);
  assert.equal(px('gap-tablet'), STUDIO_GRID.gap.tablet);
  assert.equal(px('gap-desktop'), STUDIO_GRID.gap.desktop);
  assert.equal(px('inset-phone'), STUDIO_GRID.inset.phone);
  assert.equal(px('inset-wide'), STUDIO_GRID.inset.wide);
  assert.equal(px('tile-gap'), STUDIO_GRID.tileGap);
  const widths = [...css.matchAll(/@media \(min-width: (\d+)px\)/g)].map((m) =>
    Number(m[1]),
  );
  assert.deepEqual(
    [...new Set(widths)].sort((a, b) => a - b),
    [STUDIO_GRID.tablet, STUDIO_GRID.desktop],
  );
  assert.match(css, /repeat\(12, minmax\(0, 1fr\)\)/);
});

test('studio.css never styles inside the tip block, and the fixed parts reset every studio token', () => {
  const selectors = [...css.matchAll(/([^{}]+)\{/g)]
    .map((m) => m[1].trim())
    .filter((s) => !s.startsWith('@'));
  for (const s of selectors)
    assert.doesNotMatch(
      s,
      /tip-instrument|profile-composer|data-tip-panel|appreciation|tm-/,
      s,
    );
  const fixed = /\.studio-fixed\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  const declared = new Set(
    [...css.matchAll(/(--studio-[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
  );
  for (const t of STUDIO_COLOUR_TOKENS)
    declared.add(`--studio-c-${t}`).add(`--studio-t-${t}`);
  for (const name of declared)
    if (!name.startsWith('--studio-grid-'))
      assert.match(fixed, new RegExp(`${name}:\\s*initial`), name);
});

test('every user-text element wraps instead of overflowing', () => {
  assert.match(
    css,
    /\.studio-text[^{]*\{[^}]*overflow-wrap:\s*anywhere[^}]*min-width:\s*0/,
  );
  assert.match(css, /max-inline-size:\s*68ch/);
});

test('text on a photo always sits on the scrim', () => {
  const blocks = read('studio-blocks.tsx') + read('studio-row.tsx');
  assert.match(blocks, /studio-scrim/);
  assert.match(
    css,
    /\.studio-scrim\s*\{[^}]*background:\s*rgb\(0 0 0 \/ 0\.62\)/,
  );
});

test('the services block ends with the fixed line the owner set (16 Nov 2026)', () => {
  const blocks = read('studio-blocks.tsx');
  // JSX text: the formatter may wrap it between any two words.
  const line =
    'Prices are for information. Tips here are a gift, not a payment for a service.';
  assert.match(
    blocks,
    new RegExp(
      line
        .split(' ')
        .map((w) => w.replace(/[.,]/g, '\\$&'))
        .join('\\s+'),
    ),
  );
  // The plan's first wording called a tip "thanks"; money is "tips" in TipMe's copy.
  assert.doesNotMatch(blocks, /Tips here are thanks/);
});

// Page Studio styles (spec 2026-11-17-page-studio-styles §13): the same source rules for the style
// renderer. Its only inline style is the token map (styleTokens), built from the registry; its
// only client code is the video island, the per-style stylesheet loader and the sheets themselves.
const STYLES_DIR = new URL(
  '../apps/web/src/components/studio-styles/',
  import.meta.url,
);
const styleFiles = readdirSync(STYLES_DIR, { recursive: true })
  .map(String)
  .filter((f) => /\.(tsx?|css)$/.test(f));
const readStyle = (f) => readFileSync(new URL(f, STYLES_DIR), 'utf8');

test('no style component renders raw HTML or builds a style from user content', () => {
  const styleCode = styleFiles
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => [f, readStyle(f)]);
  assert.ok(styleCode.some(([f]) => f === 'style-page.tsx'));
  for (const [file, src] of styleCode) {
    assert.doesNotMatch(
      src,
      /dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write/,
      file,
    );
    // The `style` prop only (not `data-style`), and only from the token map.
    for (const m of src.matchAll(/(?<![\w-])style=\{([^}]*)\}/g))
      assert.match(m[1], /^\s*styleTokens\(/, `${file}: style={${m[1]}}`);
    assert.doesNotMatch(src, /\beval\(|new Function\(/, file);
  }
  assert.deepEqual(
    styleCode
      .filter(([, src]) => /^['"]use client['"]/m.test(src))
      .map(([f]) => f.replaceAll('\\', '/'))
      .sort(),
    [
      'sheets/classic.tsx',
      'sheets/clear.tsx',
      'sheets/journal.tsx',
      'sheets/linen.tsx',
      'style-sheets.tsx',
      'video-embed.tsx',
    ],
  );
  // A sheet renders nothing: importing it brings the style's CSS.
  assert.match(readStyle('sheets/clear.tsx'), /return null;/);
  assert.match(readStyle('sheets/classic.tsx'), /return null;/);
  assert.match(readStyle('sheets/journal.tsx'), /return null;/);
  assert.match(readStyle('sheets/linen.tsx'), /return null;/);
  // The old renderer uses the shared video island.
  assert.match(
    read('studio-blocks.tsx'),
    /from '\.\.\/studio-styles\/video-embed'/,
  );
});

/** A selector list split at its own commas, not those inside :is() or :has(). */
const topLevel = (list) => {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === '(') depth += 1;
    if (list[i] === ')') depth -= 1;
    if (list[i] === ',' && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  return [...out, list.slice(start).trim()];
};

test('every style rule is scoped to a styled Studio page', () => {
  for (const file of styleFiles.filter((f) => f.endsWith('.css'))) {
    const selectors = [
      ...readStyle(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .matchAll(/([^{}]+)\{/g),
    ]
      .map((m) => m[1].trim())
      .filter((s) => !s.startsWith('@'))
      // Keyframe steps are not selectors.
      .filter((s) => !/^(from|to|[\d.]+%)$/.test(s))
      .flatMap(topLevel);
    assert.ok(selectors.length > 10, `${file} has its rules`);
    const own = file === 'frame.css' ? '' : file.replace('.css', '');
    for (const s of selectors)
      assert.match(
        s,
        // Classic is today's page with its choices (§9.1): its root is the profile's <main>,
        // and its tokens sit on :root while that page is shown.
        own === 'classic'
          ? /^(:root:has\()?\.profile-page--studio\[data-style=['"]?classic['"]?\]/
          : own
            ? new RegExp(`^\\.studio\\[data-style=['"]?${own}['"]?\\]`)
            : /^(html:has\()?\.studio\[data-style\]/,
        `${file}: "${s}"`,
      );
  }
});
