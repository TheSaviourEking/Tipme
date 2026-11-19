// Page Studio source rules: no raw HTML or user-built styles, scoped selectors, and nothing that
// reaches into TipMe's tip block. (The v1 renderer's rules left with it in PR 4b, below.)
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

// Page Studio styles (spec 2026-11-17-page-studio-styles §13): the source rules for the style
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
      'sheets/horizon.tsx',
      'sheets/journal.tsx',
      'sheets/linen.tsx',
      'sheets/signboard.tsx',
      'sheets/sprint.tsx',
      'sheets/stage.tsx',
      'sheets/tiles.tsx',
      'style-sheets.tsx',
      'video-embed.tsx',
    ],
  );
  // A sheet renders nothing: importing it brings the style's CSS.
  assert.match(readStyle('sheets/clear.tsx'), /return null;/);
  assert.match(readStyle('sheets/classic.tsx'), /return null;/);
  assert.match(readStyle('sheets/journal.tsx'), /return null;/);
  assert.match(readStyle('sheets/linen.tsx'), /return null;/);
  assert.match(readStyle('sheets/stage.tsx'), /return null;/);
  assert.match(readStyle('sheets/horizon.tsx'), /return null;/);
  for (const style of ['signboard', 'sprint', 'tiles'])
    assert.match(readStyle(`sheets/${style}.tsx`), /return null;/, style);
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

// PR 4b (plan Task 13): the v1 renderer, layout model and check are retired. The editor writes v2
// only and the API refuses v1 writes; stored v1 rows are still read through resolveStudio, which
// needs only studio-document-v1.ts (schema and resolver).
// A path ending in a v1 renderer module: '../studio/studio-theme', './studio-row', and the old
// '../studio/studio-styles' (its stylesheet loader), but not the v2 folder components/studio-styles/.
const V1_MODULE_IMPORT =
  /['"][^'"\n]*\/studio(-(theme|row|blocks|sheet|page)|\/studio-styles)['"]/;

test('the v1 module pattern matches v1 imports and not the v2 folder', () => {
  for (const bad of [
    "from '../studio/studio-theme'",
    "from './studio-row'",
    'from "@/components/studio/studio-page"',
    "from '../studio/studio-styles'",
  ])
    assert.match(bad, V1_MODULE_IMPORT, bad);
  for (const good of [
    "from '@/components/studio-styles/style-page'",
    "from '../studio-styles/video-embed'",
    "from './studio-styles/parts'",
    "from '../studio/studio-editor-model'",
  ])
    assert.doesNotMatch(good, V1_MODULE_IMPORT, good);
});

test('nothing imports the v1 renderer, layout model or v1 check', () => {
  const root = new URL('../', import.meta.url);
  const SKIP = new Set([
    'node_modules',
    '.next',
    'dist',
    '.turbo',
    '.vercel',
    'coverage',
    'test-results',
    'playwright-report',
  ]);
  const SOURCE = /\.(tsx?|mjs|cjs|js|css|json)$/;
  const walk = (dir) =>
    readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((e) =>
      SKIP.has(e.name)
        ? []
        : e.isDirectory()
          ? walk(`${dir}${e.name}/`)
          : SOURCE.test(e.name) && !e.name.endsWith('.tsbuildinfo')
            ? [`${dir}${e.name}`]
            : [],
    );
  const packages = readdirSync(new URL('packages/', root)).map(
    (p) => `packages/${p}/src/`,
  );
  // Package sources, and now also their tests, the browser tests and the support files. The v1
  // fixtures (studio-examples.mjs) and the frozen v1 font table are stored-row data, not imports
  // of the deleted modules, and name none of the banned words.
  const scanned = [
    ...walk('apps/'),
    ...walk('tests/'),
    ...packages.filter((p) => existsSync(new URL(p, root))).flatMap(walk),
    ...readdirSync(new URL('packages/', root)).flatMap((p) =>
      existsSync(new URL(`packages/${p}/test/`, root))
        ? walk(`packages/${p}/test/`)
        : [],
    ),
  ];
  assert.ok(scanned.length > 500, `scanned ${scanned.length} files`);
  const banned = [
    /components\/studio\//,
    // A relative import of a v1 renderer module, e.g. '../studio/studio-theme' or './studio-row'.
    V1_MODULE_IMPORT,
    /studio-layout/,
    /studio-check-v3/,
    /\bcheckDesignV1\b/,
    /\bapplyStudioFixV1\b/,
    /\bSTUDIO_GRID\b/,
  ];
  const hits = scanned.flatMap((file) => {
    const text = readFileSync(new URL(file, root), 'utf8');
    return banned.filter((re) => re.test(text)).map((re) => `${file}: ${re}`);
  });
  assert.deepEqual(hits, []);
  for (const gone of [
    'apps/web/src/components/studio/',
    'packages/contracts/src/studio-layout.ts',
    'packages/contracts/src/studio-check-v3.ts',
  ])
    assert.equal(existsSync(new URL(gone, root)), false, `${gone} is gone`);
});
