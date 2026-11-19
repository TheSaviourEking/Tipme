// The guard every page-reading rule carries (globals.css: "Only the page on screen"): Next keeps a
// page someone has left mounted, hidden with an inline `display: none`, so `html:has(.marker)`
// would still find it. `unguarded` reads a sheet as it would be without the guard, so tests about
// what a rule does need not repeat it; `pageGuardProblems` checks the guard itself
// (shown-page.test.mjs).

/** What the guard excludes: a hidden element, or anything inside one, with or without a space. */
const GUARD_PARTS = [
  "[style*='display: none']",
  "[style*='display:none']",
  "[style*='display: none'] *",
  "[style*='display:none'] *",
];

const GUARD = new RegExp(
  `:not\\(\\s*${GUARD_PARTS.map((p) =>
    p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, `['"]`),
  ).join(',\\s*')}\\s*\\)`,
  'g',
);

/**
 * The sheet without the guard, each `:has(…)` back on one line as it was written before (Prettier
 * wraps the guarded ones), followed by a space as before.
 */
export const unguarded = (css) =>
  css
    .replace(GUARD, '')
    .replace(
      /:has\(\s*([^(){}]*?)\s*\)\s+(?=[^\s,{])/g,
      (_, inner) => `:has(${inner.replace(/\s+/g, ' ')}) `,
    )
    .replace(
      /:has\(\s*([^(){}]*?)\s*\)/g,
      (_, inner) => `:has(${inner.replace(/\s+/g, ' ')})`,
    );

/**
 * `:has()` rules on the document that read state which isn't a page: allowed without the guard,
 * each for a reason.
 */
export const NOT_THE_PAGE = new Map([
  [
    '.site-nav.is-open',
    'the header’s own open phone menu: the header is outside every page and never kept hidden',
  ],
]);

/** The text from `open` (just past a `(`) to its matching `)`, and where that `)` is. */
function closing(text, open) {
  let depth = 1;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    if (text[i] === ')') depth -= 1;
    if (depth === 0) return { inner: text.slice(open, i), end: i };
  }
  return null;
}

/** A list split at its own commas, not those inside brackets or parentheses. */
function topLevel(list) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    if ('(['.includes(list[i])) depth += 1;
    if (')]'.includes(list[i])) depth -= 1;
    if (list[i] === ',' && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  return [...out, list.slice(start).trim()];
}

const normal = (s) => s.replace(/"/g, "'").replace(/\s+/g, ' ').trim();

/** The document itself: html, body, :root, html[…], or :is()/:where() of them. */
const DOCUMENT =
  /(?:^|[\s,{}(>+~])((?:html|body|:root)(?:\[[^\]]*\])*|:(?:is|where)\(\s*(?:html|body|:root)(?:\s*,\s*(?:html|body|:root))*\s*\))\s*:has\(/g;

/** A marker the checker can read: an optional element name, then classes, ids or attributes. */
const MARKER = /^(?:[a-z][\w-]*)?(?:[.#][\w-]+|\[[^\]]+\])+/i;

/**
 * Every rule in `css` that reads the page from the document without the guard, as messages
 * (`file:line marker: why`). A marker the checker can't read is a problem too, never skipped.
 */
export function pageGuardProblems(css, file = 'css') {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) =>
    c.replace(/[^\n]/g, ' '),
  );
  const problems = [];
  for (const m of text.matchAll(DOCUMENT)) {
    const open = m.index + m[0].length;
    const line = text.slice(0, open).split('\n').length;
    const has = closing(text, open);
    if (!has) {
      problems.push(`${file}:${line} an unclosed :has(`);
      continue;
    }
    for (const part of topLevel(has.inner)) {
      const where = `${file}:${line} ${normal(part) || '(empty)'}`;
      const marker = MARKER.exec(part)?.[0];
      if (!marker) {
        problems.push(`${where}: a marker the checker can't read`);
        continue;
      }
      if (NOT_THE_PAGE.has(normal(marker))) continue;
      const rest = part.slice(marker.length);
      const not = /^:not\(/.exec(rest);
      const guard = not && closing(rest, not[0].length);
      const parts = guard ? new Set(topLevel(guard.inner).map(normal)) : null;
      if (!parts || !GUARD_PARTS.every((p) => parts.has(p)))
        problems.push(`${where}: no guard on ${marker}`);
    }
  }
  return problems;
}

/** How many document `:has()` rules `css` has, guarded or not. */
export const documentHasCount = (css) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(DOCUMENT)].length;
