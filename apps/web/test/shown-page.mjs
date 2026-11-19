// The guard every page-reading rule carries (globals.css: "only the page on screen"): Next keeps a
// page someone has left mounted, hidden with an inline `display: none`, so `html:has(.marker)`
// would still find it. `unguarded` reads a sheet as it would be without the guard, so tests about
// what a rule does need not repeat it; shown-page.test.mjs checks the guard itself.
const GUARD =
  /:not\(\s*\[style\*=(['"])display: none\1\],\s*\[style\*=(['"])display: none\2\] \*\s*\)/g;

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
