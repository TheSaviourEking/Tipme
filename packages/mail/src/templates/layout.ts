import type { MailContext, RenderedMail } from './define.js';
import { escapeHtml } from './escape.js';

const BRAND = '#7A32F9';
const SUPPORT = 'support@usetipme.xyz';

/** One block of an email. Text is plain (escaped here); a button is a single call to action. */
export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'code'; code: string }
  | { kind: 'button'; label: string; href: string };

export interface Letter {
  subject: string;
  heading: string;
  blocks: Block[];
  /** Why the person got this email (always shown in the footer). */
  reason: string;
}

/** Table-based, inline-styled HTML (≤600px) and a matching plain-text body. */
export function letter(input: Letter, ctx: MailContext): RenderedMail {
  const htmlBlocks = input.blocks
    .map((block) => {
      if (block.kind === 'text')
        return `<p style="margin:0 0 16px;font-size:16px;line-height:24px;">${escapeHtml(block.text)}</p>`;
      if (block.kind === 'code')
        return `<p style="margin:0 0 16px;font-size:32px;line-height:40px;font-weight:700;letter-spacing:6px;">${escapeHtml(block.code)}</p>`;
      return `<p style="margin:8px 0 24px;"><a href="${escapeHtml(block.href)}" style="display:inline-block;background:${BRAND};color:#FFFFFF;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;">${escapeHtml(block.label)}</a></p>`;
    })
    .join('');
  const settings = ctx.unsubscribeUrl
    ? ` <a href="${escapeHtml(ctx.unsubscribeUrl)}" style="color:#5B5B66;">Email settings</a>.`
    : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escapeHtml(input.subject)}</title></head><body style="margin:0;padding:0;background:#F5F5F7;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F7;"><tr><td align="center" style="padding:24px 12px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF;border-radius:12px;"><tr><td style="padding:28px 28px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#000000;"><p style="margin:0 0 20px;font-size:18px;font-weight:700;color:${BRAND};">TipMe</p><h1 style="margin:0 0 16px;font-size:22px;line-height:30px;">${escapeHtml(input.heading)}</h1>${htmlBlocks}</td></tr><tr><td style="padding:16px 28px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:#5B5B66;">${escapeHtml(input.reason)}${settings} Questions? <a href="mailto:${SUPPORT}" style="color:#5B5B66;">${SUPPORT}</a></td></tr></table></td></tr></table></body></html>`;
  const textBlocks = input.blocks.map((block) =>
    block.kind === 'text'
      ? block.text
      : block.kind === 'code'
        ? block.code
        : `${block.label}: ${block.href}`,
  );
  const text = [
    input.heading,
    '',
    ...textBlocks.flatMap((line) => [line, '']),
    '—',
    input.reason,
    ...(ctx.unsubscribeUrl ? [`Email settings: ${ctx.unsubscribeUrl}`] : []),
    `Questions? ${SUPPORT}`,
  ].join('\n');
  return { subject: input.subject, text, html };
}
