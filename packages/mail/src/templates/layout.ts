import type { MailContext, RenderedMail } from './define.js';
import { escapeHtml as e } from './escape.js';

// The email boards' materials (docs/design/redesign/boards/Email*.dc.html), as constants: email
// HTML is inline-styled, so these cannot be tokens. Rgba borders become solid colours for Outlook.
const PAPER = '#F3F2EE';
const CARD = '#FFFEFA';
const INK = '#000000';
const MUTED = '#5D5A54';
const BRAND = '#7A32F9';
const BRAND_DEEP = '#4D16A8';
const LILAC = '#F1E9FF';
const LILAC_INK = '#2D0B66';
const SLAB_LINE = '#EFE6FF';
const WELL = '#ECEAE4';
const LINE = '#DDDAD3';
const NIGHT = '#141210';
const WHITE = '#FFFFFF';

const SANS =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
// The first family is never loaded (emails load nothing remote); it only matches if installed.
const SERIF = "'DM Serif Display',Georgia,'Times New Roman',serif";
const SUPPORT = 'support@usetipme.xyz';
const SAFETY = 'Your account’s safety';

/**
 * One block of an email. Text is plain (escaped here). Each kind has one HTML rendering and one
 * plain-text rendering, so the text part says everything the HTML does.
 */
export type Block =
  | { kind: 'text'; text: string }
  /** Six digits: one cell each, still one copyable string. Anything else: one well. */
  | { kind: 'code'; code: string }
  /** The black key, the boards' "go". One per email. */
  | { kind: 'button'; label: string; href: string }
  /** A small grey line. */
  | { kind: 'quiet'; text: string }
  /** A lilac panel, for how to treat a code. */
  | { kind: 'warn'; text: string }
  /** A black panel: "Wasn’t you?" and what to do. */
  | { kind: 'alarm'; title: string; text: string }
  /** Label and value rows in a well; a `before` row is struck through ("Before: …" in text). */
  | {
      kind: 'facts';
      rows: { label: string; value: string; before?: boolean }[];
    }
  /** Numbered purple dots. */
  | { kind: 'steps'; items: string[] }
  /** Wells side by side, a large value over a small label. */
  | { kind: 'stats'; items: { value: string; label: string }[] }
  /** A purple panel; its title is a link when `href` is set. */
  | { kind: 'signature'; title: string; text: string; href?: string }
  /** A black bar: what happens, and the date it happens. */
  | { kind: 'deadline'; label: string; date: string }
  /** A paragraph whose spans may be bold (staff announcements). */
  | { kind: 'rich'; spans: Span[] }
  /** A bulleted list; each item is spans (staff announcements). */
  | { kind: 'bullets'; items: Span[][] };

/** A run of plain text, bold or not. */
export interface Span {
  text: string;
  bold: boolean;
}

const spansHtml = (spans: Span[]) =>
  spans
    .map((span) =>
      span.bold
        ? `<strong style="font-weight:700;">${e(span.text)}</strong>`
        : e(span.text),
    )
    .join('');
const spansText = (spans: Span[]) => spans.map((span) => span.text).join('');
// The boards' paper slip with a supporter's quote is not a block: tip notes are never copied into
// mail (docs/design/DECISION-LOG.md, 5 Nov 2026).

export interface Letter {
  subject: string;
  heading: string;
  blocks: Block[];
  /** Why the person got this email (always shown in the footer). */
  reason: string;
  /**
   * Hidden preview text, shown on lock screens and in inbox lists. Defaults to the first text
   * block. Never a code, a link or anyone's details.
   */
  preheader?: string;
  /** "Your account’s safety" with the shield, above the heading. */
  tag?: 'safety';
  /** The purple slab with a large amount, in place of the white card's heading (the tip email). */
  slab?: { amount: string; line: string };
}

const STYLE = `<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (max-width:480px){.tm-amount{font-size:54px!important}.tm-slab{padding:24px 22px!important}.tm-slab-h{font-size:30px!important}.tm-card{padding:24px 20px!important}.tm-outer{padding:20px 8px!important}.tm-stat{padding:12px!important}.tm-stat-v{font-size:24px!important}}
@media (prefers-color-scheme: dark){.tm-paper{background:${NIGHT}!important}.tm-card{background:#1E1C19!important;border-color:#34312C!important}.tm-ink{color:${PAPER}!important}.tm-muted{color:#B5B0A6!important}.tm-muted a{color:#B5B0A6!important}.tm-rule{border-color:#34312C!important}.tm-well{background:#2A2723!important;border-color:#3A3631!important;color:${PAPER}!important}.tm-warn{background:#2E1D52!important;color:${SLAB_LINE}!important}.tm-tag{color:#C9A8FF!important}}
</style>`;

const SHIELD = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-4px;margin-right:6px"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z"></path></svg>`;

const table = (inner: string, attrs = '') =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"${attrs}>${inner}</table>`;

const wellStyle = `background:${WELL};border:1px solid ${LINE};border-radius:14px;color:${INK}`;

function codeHtml(code: string): string {
  if (/^\d{6}$/.test(code)) {
    // No whitespace between the cells, so copying them gives the six digits as one string.
    const cells = [...code]
      .map(
        (digit) =>
          `<span class="tm-well" style="display:inline-block;width:14%;margin:0 1%;height:64px;line-height:64px;${wellStyle};text-align:center;">${digit}</span>`,
      )
      .join('');
    return `<!--code--><p style="margin:0;text-align:center;white-space:nowrap;font-family:${SANS};font-size:30px;font-weight:700;font-variant-numeric:tabular-nums;color:${INK};">${cells}</p><!--/code-->`;
  }
  return `<!--code--><p class="tm-well" style="margin:0;padding:14px 18px;${wellStyle};text-align:center;font-family:${SANS};font-size:22px;font-weight:700;letter-spacing:0.18em;">${e(code)}</p><!--/code-->`;
}

const buttonHtml = (label: string, href: string) =>
  table(
    `<tr><td bgcolor="${INK}" align="center" style="background:${INK};border-radius:14px;"><a href="${e(href)}" style="display:block;padding:0 16px;line-height:54px;font-family:${SANS};font-size:16px;font-weight:700;color:${WHITE};text-decoration:none;border-radius:14px;">${e(label)}</a></td></tr>`,
  );

const panel = (bg: string, inner: string, style: string, cls = '') =>
  table(
    `<tr><td${cls ? ` class="${cls}"` : ''} bgcolor="${bg}" style="background:${bg};border-radius:14px;${style}">${inner}</td></tr>`,
  );

/** One block's HTML, and the space above it (px). */
function blockHtml(block: Block): [string, number] {
  switch (block.kind) {
    case 'text':
      return [
        `<p class="tm-ink" style="margin:0;font-size:16px;line-height:1.55;color:${INK};">${e(block.text)}</p>`,
        14,
      ];
    case 'code':
      return [codeHtml(block.code), 22];
    case 'button':
      return [buttonHtml(block.label, block.href), 24];
    case 'quiet':
      return [
        `<p class="tm-muted" style="margin:0;font-size:14px;line-height:1.55;color:${MUTED};">${e(block.text)}</p>`,
        18,
      ];
    case 'warn':
      return [
        panel(
          LILAC,
          e(block.text),
          `padding:14px 16px;color:${LILAC_INK};font-size:14px;line-height:1.5;font-weight:600;`,
          'tm-warn',
        ),
        18,
      ];
    case 'alarm':
      return [
        panel(
          NIGHT,
          `<strong style="display:block;margin-bottom:4px;">${e(block.title)}</strong> ${e(block.text)}`,
          `padding:16px 18px;color:${WHITE};font-size:15px;line-height:1.5;`,
        ),
        18,
      ];
    case 'facts': {
      const rows = block.rows
        .map(
          (row) =>
            `<tr><td style="padding:5px 16px 5px 0;vertical-align:top;font-size:15px;font-weight:600;color:${MUTED};white-space:nowrap;" class="tm-muted">${e(row.label)}</td><td style="padding:5px 0;vertical-align:top;font-size:15px;${row.before ? `font-weight:600;color:${MUTED};text-decoration:line-through;` : 'font-weight:700;'}">${e(row.value)}</td></tr>`,
        )
        .join('');
      return [
        panel(
          WELL,
          `<table role="presentation" cellpadding="0" cellspacing="0" border="0">${rows}</table>`,
          `padding:11px 18px;border:1px solid ${LINE};color:${INK};`,
          'tm-well',
        ),
        18,
      ];
    }
    case 'steps': {
      const rows = block.items
        .map(
          (item, i) =>
            `<tr><td width="40" style="width:40px;padding:0 0 10px;vertical-align:top;"><div style="width:28px;height:28px;line-height:28px;border-radius:50%;background:${BRAND};color:${WHITE};text-align:center;font-size:13px;font-weight:700;">${i + 1}</div></td><td class="tm-ink" style="padding:4px 0 10px;vertical-align:top;font-size:15px;line-height:1.45;color:${INK};">${e(item)}</td></tr>`,
        )
        .join('');
      return [table(rows), 20];
    }
    case 'stats': {
      const cells = block.items
        .map(
          (item) =>
            `<td class="tm-well tm-stat" bgcolor="${WELL}" width="${Math.floor((100 - 3 * (block.items.length - 1)) / block.items.length)}%" style="padding:14px 16px;vertical-align:top;${wellStyle};"><div class="tm-stat-v" style="font-family:${SERIF};font-size:30px;line-height:1.1;">${e(item.value)}</div><div class="tm-muted" style="margin-top:2px;font-size:13px;font-weight:600;color:${MUTED};">${e(item.label)}</div></td>`,
        )
        .join(
          '<td width="3%" style="width:3%;font-size:0;line-height:0;">&nbsp;</td>',
        );
      return [table(`<tr>${cells}</tr>`), 20];
    }
    case 'signature': {
      const titleStyle = `display:block;font-family:${SERIF};font-size:26px;line-height:1.15;color:${WHITE};text-decoration:none;`;
      const title = block.href
        ? `<a href="${e(block.href)}" style="${titleStyle}">${e(block.title)}</a>`
        : `<div style="${titleStyle}">${e(block.title)}</div>`;
      return [
        table(
          `<tr><td bgcolor="${BRAND}" style="background:${BRAND};border-radius:18px;padding:22px;color:${WHITE};">${title}<div style="margin-top:6px;font-size:14.5px;line-height:1.5;color:${SLAB_LINE};">${e(block.text)}</div></td></tr>`,
        ),
        16,
      ];
    }
    case 'rich':
      return [
        `<p class="tm-ink" style="margin:0;font-size:16px;line-height:1.55;color:${INK};">${spansHtml(block.spans)}</p>`,
        14,
      ];
    case 'bullets':
      return [
        `<ul class="tm-ink" style="margin:0;padding:0 0 0 22px;font-size:16px;line-height:1.55;color:${INK};">${block.items
          .map(
            (item, i) =>
              `<li style="margin:${i === 0 ? 0 : 6}px 0 0;">${spansHtml(item)}</li>`,
          )
          .join('')}</ul>`,
        14,
      ];
    case 'deadline':
      return [
        panel(
          NIGHT,
          table(
            `<tr><td style="font-size:15px;color:${WHITE};vertical-align:middle;">${e(block.label)}</td><td align="right" style="font-family:${SERIF};font-size:22px;color:${WHITE};vertical-align:middle;white-space:nowrap;"> ${e(block.date)}</td></tr>`,
          ),
          `padding:14px 18px;color:${WHITE};`,
        ),
        18,
      ];
  }
}

/** One block's plain text: the same words, in reading order. */
function blockText(block: Block): string {
  switch (block.kind) {
    case 'text':
    case 'quiet':
    case 'warn':
      return block.text;
    case 'code':
      return block.code;
    case 'button':
      return `${block.label}: ${block.href}`;
    case 'alarm':
      return `${block.title} ${block.text}`;
    case 'facts':
      return block.rows
        .map((row) =>
          row.before ? `Before: ${row.value}` : `${row.label}: ${row.value}`,
        )
        .join('\n');
    case 'steps':
      return block.items.map((item, i) => `${i + 1}. ${item}`).join('\n');
    case 'stats':
      return block.items
        .map((item) => `${item.value} ${item.label}`)
        .join('\n');
    case 'signature':
      return [
        block.title,
        block.text,
        ...(block.href ? [block.href] : []),
      ].join('\n');
    case 'deadline':
      return `${block.label} ${block.date}`;
    case 'rich':
      return spansText(block.spans);
    case 'bullets':
      return block.items.map((item) => `- ${spansText(item)}`).join('\n');
  }
}

const blocksTable = (blocks: Block[], firstGap: number | null) =>
  table(
    blocks
      .map((block, i) => {
        const [html, gap] = blockHtml(block);
        const top = i === 0 && firstGap !== null ? firstGap : gap;
        return `<tr><td style="padding-top:${top}px;font-family:${SANS};">${html}</td></tr>`;
      })
      .join(''),
  );

/**
 * Table-based, inline-styled HTML (600px) in the boards' paper-and-slab frame, and a matching
 * plain-text body. Nothing is loaded from anywhere: no images, fonts or stylesheets.
 */
export function letter(input: Letter, ctx: MailContext): RenderedMail {
  const firstText = input.blocks.find((block) => block.kind === 'text');
  const preheader =
    input.preheader ?? (firstText?.kind === 'text' ? firstText.text : '');
  const tag = input.tag
    ? `<p class="tm-tag" style="margin:0 0 14px;font-size:13px;font-weight:700;color:${BRAND_DEEP};">${SHIELD}${SAFETY}</p>`
    : '';

  const body = input.slab
    ? `<tr><td class="tm-slab" bgcolor="${BRAND}" style="background:${BRAND};border-radius:24px;padding:30px 30px 28px;font-family:${SANS};color:${WHITE};">${tag}<h1 class="tm-slab-h" style="margin:0;font-family:${SERIF};font-size:34px;font-weight:400;line-height:1.08;color:${WHITE};">${e(input.heading)}</h1><p class="tm-amount" style="font-size:64px;margin:18px 0 0;font-family:${SERIF};font-weight:400;line-height:1;color:${WHITE};">${e(input.slab.amount)}</p><p style="margin:10px 0 0;font-size:15px;line-height:1.5;color:${SLAB_LINE};">${e(input.slab.line)}</p></td></tr>${input.blocks.length ? `<tr><td style="padding:0 4px;">${blocksTable(input.blocks, 26)}</td></tr>` : ''}`
    : `<tr><td class="tm-card" bgcolor="${CARD}" style="background:${CARD};border:1px solid ${LINE};border-radius:24px;padding:28px;font-family:${SANS};color:${INK};">${tag}<h1 class="tm-ink" style="margin:0;font-family:${SERIF};font-size:31px;font-weight:400;line-height:1.1;color:${INK};">${e(input.heading)}</h1>${input.blocks.length ? blocksTable(input.blocks, null) : ''}</td></tr>`;

  const settings = ctx.unsubscribeUrl
    ? ` <a href="${e(ctx.unsubscribeUrl)}" style="color:${MUTED};">Email settings</a>.`
    : '';
  const footer = `<tr><td style="padding:32px 4px 0;">${table(`<tr><td class="tm-muted tm-rule" style="padding-top:18px;border-top:1px solid ${LINE};font-family:${SANS};font-size:12.5px;line-height:1.6;color:${MUTED};">${e(input.reason)}${settings} Questions? <a href="mailto:${SUPPORT}" style="color:${MUTED};">${SUPPORT}</a></td></tr>`)}</td></tr>`;

  // Hidden filler after the preheader keeps clients from running the body text into the preview.
  const filler = '&#847;&zwnj;&nbsp;'.repeat(40);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${e(input.subject)}</title>${STYLE}</head><body class="tm-paper" style="margin:0;padding:0;background:${PAPER};"><div data-preheader style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:${PAPER};">${e(preheader)}${filler}</div>${table(`<tr><td class="tm-outer" align="center" style="padding:28px 12px 36px;">${table(`<tr><td class="tm-ink" style="padding:0 4px 18px;font-family:${SANS};font-size:22px;font-weight:800;letter-spacing:-0.02em;line-height:1;color:${INK};">tipme <span style="color:${BRAND};">&#9829;&#xFE0E;</span></td></tr>${body}${footer}`, ' style="max-width:600px;"')}</td></tr>`, ` class="tm-paper" bgcolor="${PAPER}" style="background:${PAPER};"`)}</body></html>`;

  const text = [
    ...(input.tag ? [SAFETY, ''] : []),
    input.heading,
    '',
    ...(input.slab ? [input.slab.amount, input.slab.line, ''] : []),
    ...input.blocks.map(blockText).flatMap((line) => [line, '']),
    '—',
    input.reason,
    ...(ctx.unsubscribeUrl ? [`Email settings: ${ctx.unsubscribeUrl}`] : []),
    `Questions? ${SUPPORT}`,
  ].join('\n');
  return { subject: input.subject, text, html };
}
