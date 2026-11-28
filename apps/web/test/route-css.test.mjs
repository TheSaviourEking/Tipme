import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { STUDIO_STYLE_IDS } from '@tipme/contracts';

// The home page's first paint waits for its whole stylesheet. Dashboard and admin styles live in
// their own stylesheets (app/dashboard/dashboard.css, app/ops/ops.css), loaded only there (15 Nov
// 2026: globals.css had grown to 300 KB and the home page missed its 2000 ms LCP budget).

const read = (path) =>
  readFileSync(new URL(`../src/app/${path}`, import.meta.url), 'utf8');

/** Every rule with its at-rule and nesting context, comments removed: [{ key, body }]. */
function rules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found = [];
  const stack = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '{') {
      stack.push({ head: text.slice(start, i).trim().replace(/\s+/g, ' ') });
      stack.at(-1).bodyStart = i + 1;
      start = i + 1;
    } else if (text[i] === '}') {
      const open = stack.pop();
      // The rule's own declarations: its text without nested blocks.
      let body = '';
      let depth = 0;
      for (const ch of text.slice(open.bodyStart, i)) {
        if (ch === '{') depth += 1;
        if (depth === 0) body += ch;
        if (ch === '}') depth -= 1;
      }
      const declarations = body
        .split(';')
        .map((d) => d.trim().replace(/\s+/g, ' '))
        .filter((d) => d.includes(':') && !d.includes('}'));
      if (!open.head.startsWith('@'))
        found.push({
          key: [...stack.map((s) => s.head), open.head].join(' / '),
          body: declarations.join('; '),
        });
      start = i + 1;
    }
  }
  return found;
}

const globals = rules(read('globals.css'));
const globalBodies = new Map();
for (const { key, body } of globals)
  globalBodies.set(key, [...(globalBodies.get(key) ?? []), body]);

for (const area of ['dashboard/dashboard.css', 'ops/ops.css']) {
  test(`${area}: a rule repeated from globals.css (to keep its order) is word for word the same`, () => {
    const own = rules(read(area));
    assert.ok(own.length > 50, `${area} has its rules`);
    let repeated = 0;
    for (const { key, body } of own) {
      const there = globalBodies.get(key);
      if (!there) continue;
      repeated += 1;
      assert.ok(
        there.includes(body),
        `${area}: "${key}" differs from globals.css. Change both copies, or move the rule out of globals.css if only this area uses it.`,
      );
    }
    assert.ok(repeated > 0, `${area} repeats rules of globals.css`);
  });
}

test('the area stylesheets load only in their own areas', () => {
  assert.match(read('dashboard/layout.tsx'), /import '\.\/dashboard\.css';/);
  assert.match(read('ops/layout.tsx'), /import '\.\/ops\.css';/);
  assert.doesNotMatch(read('layout.tsx'), /dashboard\.css|ops\.css/);
});

// The home page's stylesheets, as the production build serves them (`pnpm build` runs first in CI).
const built = new URL('../.next/', import.meta.url);
const homeHtml = new URL('server/app/index.html', built);
// 27.9 KB when this was set (15 Nov 2026); 46.5 KB before the split.
const HOME_CSS_BUDGET = 32 * 1024;

test(
  'the home page downloads at most 32 KB of stylesheet (gzip) before it can paint',
  { skip: !existsSync(homeHtml) && 'no production build (run pnpm build)' },
  () => {
    const html = readFileSync(homeHtml, 'utf8');
    const sheets = [
      ...html.matchAll(/<link rel="stylesheet" href="\/_next\/([^"]+\.css)"/g),
    ].map((m) => m[1]);
    assert.ok(sheets.length > 0, 'the home page links its stylesheets');
    const bytes = sheets.reduce(
      (sum, sheet) =>
        sum +
        gzipSync(readFileSync(new URL(sheet, built)), { level: 9 }).length,
      0,
    );
    assert.ok(
      bytes <= HOME_CSS_BUDGET,
      `the home page's stylesheets are ${(bytes / 1024).toFixed(1)} KB gzip (budget 32 KB). Styles used only in the dashboard or admin go in app/dashboard/dashboard.css or app/ops/ops.css, not globals.css.`,
    );
  },
);

// Page Studio: no Studio rule lives in globals.css or the root layout. Every style's rules ship in
// their own stylesheet behind next/dynamic (components/studio-styles/style-sheets.tsx), and the
// selector scoping of those sheets is held by scripts/studio-source.test.mjs.
test('Studio styles stay out of globals.css and the root layout', () => {
  assert.doesNotMatch(read('globals.css'), /\.studio[\w-]*|studio\.css/);
  assert.doesNotMatch(read('layout.tsx'), /studio/);
});

test(
  'the home page loads no Studio styles',
  { skip: !existsSync(homeHtml) && 'no production build (run pnpm build)' },
  () => {
    const html = readFileSync(homeHtml, 'utf8');
    for (const [, sheet] of html.matchAll(
      /<link rel="stylesheet" href="\/_next\/([^"]+\.css)"/g,
    ))
      assert.doesNotMatch(
        readFileSync(new URL(sheet, built), 'utf8'),
        /\.studio\[data-style|\.profile-page--studio/,
        sheet,
      );
  },
);

// Chrome warned "preloaded using link preload but not used" (17 Nov 2026): a stylesheet imported by
// code the /@username route links statically is linked on every profile page, so every prefetched
// link to a public page preloaded it. Only the dynamically loaded sheets import any Studio CSS.
test('Studio CSS loads only through the dynamic sheets, never with the /@username route', () => {
  const dir = new URL('../src/components/studio-styles/', import.meta.url);
  const sheets = readFileSync(new URL('style-sheets.tsx', dir), 'utf8');
  assert.match(sheets, /dynamic\(\(\) => import\('\.\/sheets\/clear'\)\)/);
  for (const file of ['style-page.tsx', 'parts.tsx', 'style-sheets.tsx'])
    assert.doesNotMatch(
      readFileSync(new URL(file, dir), 'utf8'),
      /import '[^']*\.css'/,
      file,
    );
});

// Page Studio styles (spec 2026-11-17-page-studio-styles §4.3). Every style's rules ship in their
// own stylesheet behind next/dynamic (components/studio-styles/style-sheets.tsx: frame.css plus the
// style's own file), linked only in the HTML of a page that renders that style. So a standard or
// Classic /@username page downloads only what its route links (no Studio rules today), and a
// styled page that plus its style's sheet. Both are measured on the production build.
// The standard budget was 8 KB (spec §4.3). Measured on the production build for PR 4b (18 Nov
// 2026, studio.css and the v1 renderer gone): a standard page links 20 bytes gzip of Studio rules and
// a Classic page with choices 1,675 bytes (its sheet), so the line is lowered to 3 KB, a margin of
// about 80% over Classic. It is never raised: a style's rules belong in its own sheet.
const STUDIO_STANDARD_BUDGET = 3 * 1024;
const STUDIO_STYLED_BUDGET = 12 * 1024;
const routeManifest = (route) =>
  new URL(`server/app/${route}/page_client-reference-manifest.js`, built);
const profileRoute = 'people/[handle]';

/** The stylesheets a route links on every visit, from its client reference manifest. */
function routeSheets(route) {
  const scope = {};
  new Function('globalThis', readFileSync(routeManifest(route), 'utf8'))(scope);
  const manifest = Object.values(scope.__RSC_MANIFEST ?? {})[0];
  assert.ok(manifest, `${route}: a client reference manifest`);
  const css =
    manifest.entryCSSFiles[`[project]/apps/web/src/app/${route}/page`];
  assert.ok(css?.length, `${route}: its stylesheets`);
  return css.map((f) => f.path);
}

/** The Studio rules in a stylesheet (selectors scoped to a Studio page), as text. */
const studioRules = (css) =>
  rules(css)
    .filter(({ key }) => /\.studio\b|\.profile-page--studio\b/.test(key))
    .map(({ key, body }) => `${key}{${body}}`)
    .join('');
const gzip = (text) => gzipSync(text, { level: 9 }).length;

// The routes that render a style: the lab now, the public page from PR 3a.
const styledRoutes = ['dev/studio-lab', profileRoute];
const styleSheetsSource = readFileSync(
  new URL('../src/components/studio-styles/style-sheets.tsx', import.meta.url),
  'utf8',
);
const STYLES_WITH_SHEETS = [
  ...styleSheetsSource.matchAll(/import\('\.\/sheets\/([a-z]+)'\)/g),
].map((m) => m[1]);

// A stub sheet (Creator plan ruling P1: Creator and Professional until their renderers land) is a
// style whose own CSS holds no rule yet: there is nothing of its to measure, though it still needs
// a sheet. Derived from the source, so the day a stub gains a rule it is measured against the
// 12 KB budget with nothing to take off a list.
const styleCss = (style) =>
  readFileSync(
    new URL(`../src/components/studio-styles/${style}.css`, import.meta.url),
    'utf8',
  );
const STUB_STYLES = STUDIO_STYLE_IDS.filter(
  (s) => rules(styleCss(s)).length === 0,
);

// Every style the registry has is drawn (PR 2e drew the last three): each has its own sheet.
const DRAWN_STYLES = STUDIO_STYLE_IDS.filter(
  (s) => s !== 'classic' && !STUB_STYLES.includes(s),
);

test('every style the registry has has its own sheet', () => {
  for (const style of STUDIO_STYLE_IDS)
    assert.ok(STYLES_WITH_SHEETS.includes(style), `${style} has no sheet`);
});

/** The Studio CSS every /@username page links with its route, gzip. */
const routeStudioBytes = () =>
  gzip(
    routeSheets(profileRoute)
      .map((sheet) => studioRules(readFileSync(new URL(sheet, built), 'utf8')))
      .join(''),
  );

/** A style's dynamic sheet files (from the routes' loadable manifests), gzip, summed. */
function styleSheetBytes(style) {
  const entries = styledRoutes.flatMap((route) => {
    const file = new URL(
      `server/app/${route}/page/react-loadable-manifest.json`,
      built,
    );
    if (!existsSync(file)) return [];
    return Object.values(JSON.parse(readFileSync(file, 'utf8'))).map((e) =>
      e.files.filter((f) => f.endsWith('.css')),
    );
  });
  const marker = new RegExp(`\\[data-style=["']?${style}["']?\\]`);
  const sheets = entries.find((files) =>
    files.some((f) => marker.test(readFileSync(new URL(f, built), 'utf8'))),
  );
  assert.ok(sheets, `${style}: no built stylesheet holds its rules`);
  return sheets.reduce(
    (sum, f) => sum + gzip(readFileSync(new URL(f, built))),
    0,
  );
}

// A Classic page with choices (§4.3, §9.1) links the route's sheets plus classic.css, and stays
// in the standard budget; a standard page (or Classic with every default) links only the route's.
test(
  'a standard or Classic profile page downloads at most 3 KB gzip of Studio CSS',
  {
    skip:
      !existsSync(routeManifest(profileRoute)) &&
      'no production build (run pnpm build)',
  },
  () => {
    const standard = routeStudioBytes();
    assert.ok(STYLES_WITH_SHEETS.includes('classic'), 'Classic has its sheet');
    const classic = standard + styleSheetBytes('classic');
    console.log(`STUDIO_STANDARD_CSS ${JSON.stringify({ standard, classic })}`);
    assert.ok(
      standard <= STUDIO_STANDARD_BUDGET,
      `a standard /@username page downloads ${(standard / 1024).toFixed(1)} KB gzip of Studio CSS (budget 3 KB). Per-style rules belong in the style's own sheet (studio-styles/style-sheets.tsx), not in a stylesheet the route links.`,
    );
    assert.ok(
      classic <= STUDIO_STANDARD_BUDGET,
      `a Classic page downloads ${(classic / 1024).toFixed(1)} KB gzip of Studio CSS (budget 3 KB)`,
    );
  },
);

test(
  'a styled profile page downloads at most 12 KB gzip of Studio CSS',
  {
    skip:
      !existsSync(routeManifest(profileRoute)) &&
      'no production build (run pnpm build)',
  },
  () => {
    const base = routeStudioBytes();
    // Every style in the registry but Classic (held to the standard budget above), so a style
    // drawn without a sheet fails here instead of passing unmeasured.
    for (const style of DRAWN_STYLES) {
      assert.ok(
        STYLES_WITH_SHEETS.includes(style),
        `${style} has its sheet in style-sheets.tsx`,
      );
      const bytes = base + styleSheetBytes(style);
      console.log(`STUDIO_STYLE_CSS ${JSON.stringify({ style, bytes })}`);
      assert.ok(
        bytes <= STUDIO_STYLED_BUDGET,
        `a ${style} page downloads ${(bytes / 1024).toFixed(1)} KB gzip of Studio CSS (budget 12 KB)`,
      );
    }
  },
);
