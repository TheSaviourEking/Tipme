#!/usr/bin/env node
// The local review gallery (docs/superpowers/plans/2026-11-03-screen-redesign.md, Task 1): every
// redesigned screen at desktop and phone size, beside the board it is built to. The owner approves
// the redesign from this page before anything goes to dev.
//
//   node scripts/review-gallery.mjs   reads review-screens/shots.jsonl, writes review-screens/index.html
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const OUT = 'review-screens';

const escape = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );

/** One entry per screen, from the shots the review run took at each size, in the order taken. */
export function entriesFromShots(shots) {
  const entries = new Map();
  for (const shot of shots) {
    const key = `${shot.group}\u0000${shot.name}`;
    const entry = entries.get(key) ?? {
      group: shot.group,
      name: shot.name,
      board: shot.board,
      desktop: undefined,
      phone: undefined,
    };
    entry[shot.project] = shot.file;
    entries.set(key, entry);
  }
  return [...entries.values()];
}

const image = (src, alt) =>
  src
    ? `<a href="${escape(src)}"><img src="${escape(src)}" alt="${escape(alt)}" loading="lazy"></a>`
    : '<p class="missing">Not taken</p>';

const figure = (entry) => `
  <figure>
    <figcaption><strong>${escape(entry.name)}</strong><span>Board: docs/design/redesign/boards/${escape(entry.board)}.dc.html</span></figcaption>
    <div class="pair">
      <div class="desktop">${image(entry.desktop, `${entry.name}, desktop`)}</div>
      <div class="phone">${image(entry.phone, `${entry.name}, phone`)}</div>
    </div>
  </figure>`;

/** The gallery page: one section per group, each screen at desktop and phone size side by side. */
export function buildGallery(entries) {
  const groups = new Map();
  for (const entry of entries)
    groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry]);
  const sections = [...groups]
    .map(
      ([group, list]) =>
        `<section><h2>${escape(group)}</h2>${list.map(figure).join('')}</section>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TipMe screen review</title>
<style>
  body { margin: 0; padding: 32px; background: #f3f2ee; color: #000; font: 16px/1.5 system-ui, sans-serif; }
  h1 { margin: 0 0 4px; font-size: 32px; }
  h2 { margin: 48px 0 16px; font-size: 24px; }
  figure { margin: 0 0 40px; }
  figcaption { display: flex; gap: 16px; align-items: baseline; margin-bottom: 12px; }
  figcaption span { color: #5d5a54; font-size: 14px; }
  .pair { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 1fr); gap: 24px; align-items: start; }
  img { display: block; width: 100%; height: auto; border: 1px solid rgba(20,18,16,.15); border-radius: 8px; background: #fff; }
  .missing { color: #5d5a54; }
</style>
</head>
<body>
<h1>TipMe screen review</h1>
<p>Each screen at desktop (1440 wide) and phone (390 wide) size. Select a picture to open it full size.</p>
${sections}
</body>
</html>
`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const shots = readFileSync(`${OUT}/shots.jsonl`, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  writeFileSync(`${OUT}/index.html`, buildGallery(entriesFromShots(shots)));
  console.log(`Wrote ${OUT}/index.html (${shots.length} pictures).`);
}
