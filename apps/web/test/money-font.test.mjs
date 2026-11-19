import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { woff2CharacterMap } from '../src/lib/font-cmap.ts';
import {
  GLYPH_FALLBACK_RANGE,
  withGlyphFallback,
} from '../src/lib/font-stack.ts';

// The owner's three fixes of 17 Nov 2026: money in Inter with tabular figures, Inter as the backup
// for letters the display fonts lack, and a darker hint colour.

const src = new URL('../src/', import.meta.url);
const read = (path) => readFileSync(new URL(path, src), 'utf8');
const ui = (path) =>
  readFileSync(
    new URL(`../../../packages/ui/src/${path}`, import.meta.url),
    'utf8',
  );

function files(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) files(url, out);
    else if (entry.name.endsWith('.tsx')) out.push(url);
  }
  return out;
}

/** The formatters that write an amount of money as text. */
const MONEY_CALLS = new Set([
  'formatNaira',
  'formatDemoAmount',
  'naira',
  'nairaCode',
]);

const isJsx = (node) =>
  ts.isJsxElement(node) ||
  ts.isJsxSelfClosingElement(node) ||
  ts.isJsxFragment(node);

/**
 * Whether an expression writes money as text (not looking inside nested JSX): a formatter call,
 * or a name in `names` (a constant or helper of the same file that holds or returns one).
 */
function writesMoney(node, names = new Set(), inLists = true) {
  if (isJsx(node)) return false;
  // Copy tables (arrays and objects of sentences) are followed only where they render.
  if (
    !inLists &&
    (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node))
  )
    return false;
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    MONEY_CALLS.has(node.expression.text)
  )
    return true;
  if (
    ts.isIdentifier(node) &&
    names.has(node.text) &&
    !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
  )
    return true;
  return (
    ts.forEachChild(node, (child) => writesMoney(child, names, inLists)) ??
    false
  );
}

/** The file's constants and helpers that hold or return a formatted amount. */
function moneyNames(sourceFile) {
  const names = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    const visit = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        !names.has(node.name.text) &&
        node.initializer &&
        writesMoney(node.initializer, names, false)
      ) {
        names.add(node.name.text);
        grew = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return names;
}

/** Whether a JSX element sets its text in the money face: <Money> or a `money` class. */
function moneyElement(element, sourceFile) {
  const opening = ts.isJsxElement(element) ? element.openingElement : element;
  if (opening.tagName.getText(sourceFile) === 'Money') return true;
  return opening.attributes.properties.some(
    (attribute) =>
      ts.isJsxAttribute(attribute) &&
      attribute.name.getText(sourceFile) === 'className' &&
      /(?<![\w-])money(?![\w-])/.test(
        attribute.initializer?.getText(sourceFile) ?? '',
      ),
  );
}

function inMoneyElement(node, sourceFile) {
  for (let at = node.parent; at; at = at.parent)
    if (ts.isJsxElement(at) || ts.isJsxSelfClosingElement(at))
      if (moneyElement(at, sourceFile)) return true;
  return false;
}

/** Every place a page writes an amount as text outside the money face: "file:line text". */
function moneyOutsideTheFace() {
  const found = [];
  for (const url of files(src)) {
    const text = readFileSync(url, 'utf8');
    const sourceFile = ts.createSourceFile(
      url.pathname,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const where = (node) =>
      `${url.pathname.slice(src.pathname.length)}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1} ${node.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 80)}`;
    const names = moneyNames(sourceFile);
    const visit = (node) => {
      const child =
        node.parent &&
        (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent));
      if (
        child &&
        ((ts.isJsxExpression(node) &&
          node.expression &&
          writesMoney(node.expression, names)) ||
          (ts.isJsxText(node) && /₦\s*\{?|₦\d/.test(node.text))) &&
        !inMoneyElement(node, sourceFile)
      )
        found.push(where(node));
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return found;
}

test('every amount a page shows is set in the money face (<Money> or the money class)', () => {
  assert.deepEqual(moneyOutsideTheFace(), []);
});

test('the money face is Inter with tabular figures, and the Inter file has tabular figures', () => {
  assert.match(ui('tokens.css'), /--font-money:\s*var\(--font-inter\),/);
  assert.match(
    ui('components.css'),
    /\.money \{\s*font-family: var\(--font-money\) !important;\s*font-variant-numeric: var\(--numeric-variant\) !important;/,
  );
  assert.match(ui('tokens.css'), /--numeric-variant:\s*tabular-nums/);
  const layout = read('app/layout.tsx');
  assert.match(
    layout,
    /const interMoney = localFont\(\{\s*src: '\.\.\/fonts\/Inter-400-700\.woff2',[\s\S]*?variable: '--font-inter'/,
  );
  // The Studio cut of Inter has no `tnum` (pyftsubset drops features it is not asked for), so
  // tabular-nums would do nothing with it. This file is the same cut with `tnum` added
  // (docs/third-party-component-register.md has the command).
  const inter = readFileSync(new URL('fonts/Inter-400-700.woff2', src));
  assert.equal(
    createHash('sha256').update(inter).digest('hex'),
    'c865eb6651d3810dd796086aa888738d7c28ae96636462fe548827e439e58eae',
  );
});

test('Inter draws every letter the display fonts lack; they lack them', () => {
  const font = (path) => woff2CharacterMap(readFileSync(new URL(path, src)));
  const inter = font('fonts/Inter-400-700.woff2');
  const manrope = font('fonts/Manrope-Latin.woff2');
  const serif = font('fonts/DMSerifDisplay-Latin.woff2');
  // ₦, ẹ ọ ṣ, combining dot below, ɓ ɗ ƙ ƴ
  const needed = [
    0x20a6, 0x1eb9, 0x1ecd, 0x1e63, 0x0323, 0x0253, 0x0257, 0x0199, 0x01b4,
  ];
  for (const code of needed) {
    assert.ok(inter.has(code), `Inter draws U+${code.toString(16)}`);
    const inRange = GLYPH_FALLBACK_RANGE.split(', ').some((part) => {
      const [from, to = from] = part.slice(2).split('-');
      return code >= parseInt(from, 16) && code <= parseInt(to, 16);
    });
    assert.ok(inRange, `the fallback range covers U+${code.toString(16)}`);
  }
  assert.equal(manrope.has(0x20a6) || serif.has(0x20a6), false);
  // Basic Latin stays out of the range, so a page in plain English never downloads the face.
  assert.equal(/U\+00|U\+0000/.test(GLYPH_FALLBACK_RANGE), false);
});

test('the interface and editorial stacks have Inter straight after their own face', () => {
  const layout = read('app/layout.tsx');
  const range = /prop: 'unicode-range',\s*value: '([^']+)'/.exec(layout)?.[1];
  assert.equal(range, GLYPH_FALLBACK_RANGE);
  assert.match(layout, /variable: '--font-glyph-fallback'/);
  for (const font of ['manrope', 'dmSerif'])
    assert.match(
      layout,
      new RegExp(
        `withGlyphFallback\\(\\s*${font}\\.style\\.fontFamily,\\s*interGlyphs\\.style\\.fontFamily,?\\s*\\)`,
      ),
    );
  assert.match(layout, /style=\{fontStacks\}/);
  assert.equal(
    withGlyphFallback("'Manrope', 'Manrope Fallback'", "'Inter Glyphs'"),
    "'Manrope', 'Inter Glyphs', 'Manrope Fallback'",
  );
  assert.equal(
    withGlyphFallback("'Manrope'", "'Inter Glyphs'"),
    "'Manrope', 'Inter Glyphs'",
  );
  const tokens = ui('tokens.css');
  assert.match(tokens, /--font-interface:\s*var\(--font-manrope\),/);
  assert.match(tokens, /--font-editorial:\s*var\(--font-dm-serif\),/);
});

/** WCAG relative luminance contrast of two #rrggbb colours. */
function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('hint text is at least 4.5:1 on every surface it sits on', () => {
  const tokens = ui('tokens.css');
  const value = (name) =>
    new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`, 'i').exec(tokens)?.[1];
  const hint = value('text-tertiary');
  assert.equal(hint, '#6e6a63');
  for (const surface of [
    'canvas',
    'surface-base',
    'surface-raised',
    'surface-subtle',
    'surface-recessed',
  ]) {
    const ratio = contrast(hint, value(surface));
    assert.ok(ratio >= 4.5, `${surface}: ${ratio.toFixed(2)}:1`);
  }
});

test('an email sets its large amount and figures in Inter (where installed) with tabular figures', () => {
  const layout = readFileSync(
    new URL('../../../packages/mail/src/templates/layout.ts', import.meta.url),
    'utf8',
  );
  assert.match(layout, /const MONEY = `Inter,\$\{SANS\}`;/);
  for (const cls of ['tm-amount', 'tm-stat-v'])
    assert.match(
      layout,
      new RegExp(
        `class="${cls}" style="[^"]*font-family:\\$\\{MONEY\\};[^"]*font-variant-numeric:tabular-nums;`,
      ),
    );
});
