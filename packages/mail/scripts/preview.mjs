// Renders every email from its sample into a folder, for review next to the email boards
// (docs/design/redesign/boards/Email*.dc.html). Run `pnpm --filter @tipme/mail build` first.
// Writes <id>.html, <id>.txt and an index.html that shows each at the boards' two widths.
// MAIL_PREVIEW_DIR changes the folder (default: packages/mail/.preview, which git ignores).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml, MAIL_TYPES, renderMail } from '../dist/index.js';

const dir =
  process.env.MAIL_PREVIEW_DIR ??
  fileURLToPath(new URL('../.preview/', import.meta.url));
mkdirSync(dir, { recursive: true });

const ids = Object.keys(MAIL_TYPES).sort();
const rows = [];
for (const id of ids) {
  const type = MAIL_TYPES[id];
  const out = renderMail(id, type.sample, {
    webOrigin: 'https://usetipme.xyz',
    // A sample settings link, so the footer shows it for types a person can turn off.
    unsubscribeUrl: type.preference
      ? 'https://usetipme.xyz/dashboard/settings?ml=email_settings#emails'
      : null,
  });
  writeFileSync(join(dir, `${id}.html`), out.html);
  writeFileSync(
    join(dir, `${id}.txt`),
    `Subject: ${out.subject}\n\n${out.text}\n`,
  );
  const name = escapeHtml(id);
  rows.push(
    `<section><h2 id="${name}">${name}</h2><p>${escapeHtml(out.subject)} · <a href="${name}.html">html</a> · <a href="${name}.txt">text</a> · ${type.category}${out.snapshot ? '' : ' · no snapshot'}</p><div class="pair"><iframe title="${name} at 720px" src="${name}.html" width="720" height="900"></iframe><iframe title="${name} at 390px" src="${name}.html" width="390" height="900"></iframe></div></section>`,
  );
}

writeFileSync(
  join(dir, 'index.html'),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>TipMe emails: preview</title><style>body{margin:0;padding:24px;background:#e9e6df;font:14px/1.5 -apple-system,system-ui,sans-serif}nav{columns:3;margin-bottom:24px}section{margin:0 0 40px}h2{margin:0;font-size:18px}.pair{display:flex;gap:24px;align-items:flex-start}iframe{border:0;border-radius:12px;background:#f3f2ee}</style></head><body><h1>Every email, from its sample (${ids.length})</h1><nav>${ids.map((id) => `<a href="#${escapeHtml(id)}">${escapeHtml(id)}</a>`).join('<br>')}</nav>${rows.join('')}</body></html>`,
);
console.log(`Wrote ${ids.length} emails to ${dir}`);
