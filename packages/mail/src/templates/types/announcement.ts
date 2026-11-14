import { z } from 'zod';
import { defineMailType, mailLink } from '../define.js';
import { letter, type Block, type Span } from '../layout.js';

/*
 * Staff announcements (owner-approved, 14 Nov 2026). Staff write the subject, a preview line and a
 * body of plain paragraphs, with optional **bold**, "- " bullet lines and one optional button. No
 * HTML: every character they type is escaped. Marketing mail, so it is sent only to people whose
 * email preferences allow it and always carries the email settings link (mail-delivery mailGate).
 */

export const ANNOUNCEMENT_LIMITS = {
  subject: 120,
  preheader: 150,
  text: 5000,
  buttonLabel: 40,
  buttonUrl: 500,
} as const;

// Users never see the payment partner's name (owner, 1 Nov 2026).
const PARTNER_NAME = /\bbachs\b/i;
const BULLET = /^\s*[-•*]\s+/;

const noPartner = (value: string) => !PARTNER_NAME.test(value);

/** `**bold**` pairs; an unclosed `**` stays as typed. */
function spansOf(text: string): Span[] {
  const spans: Span[] = [];
  const parts = text.split('**');
  // An even count of parts means one `**` is unpaired: it goes back into the last plain run.
  const paired = parts.length % 2 === 1 ? parts : parts.slice(0, -1);
  paired.forEach((part, i) => {
    if (part) spans.push({ text: part, bold: i % 2 === 1 });
  });
  if (paired !== parts) {
    const rest = `**${parts[parts.length - 1]}`;
    const last = spans[spans.length - 1];
    if (last && !last.bold) last.text += rest;
    else spans.push({ text: rest, bold: false });
  }
  // Neighbouring plain runs (an empty bold between them) read as one.
  return spans.reduce<Span[]>((joined, span) => {
    const last = joined[joined.length - 1];
    if (last && !last.bold && !span.bold) last.text += span.text;
    else joined.push({ ...span });
    return joined;
  }, []);
}

/**
 * The body as blocks: a blank line ends a paragraph, lines starting "- " (or "•") are bullets, and
 * other lines in a paragraph join with a space.
 */
export function announcementBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (paragraph.length > 0)
      blocks.push({ kind: 'rich', spans: spansOf(paragraph.join(' ')) });
    if (bullets.length > 0)
      blocks.push({ kind: 'bullets', items: bullets.map(spansOf) });
    paragraph = [];
    bullets = [];
  };
  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (BULLET.test(raw)) {
      if (paragraph.length > 0) flush();
      bullets.push(line.replace(BULLET, '').trim());
    } else {
      if (bullets.length > 0) flush();
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

/** A TipMe path ("/pro") or an https link; nothing else can sit behind the button. */
const buttonUrl = z
  .string()
  .trim()
  .max(ANNOUNCEMENT_LIMITS.buttonUrl)
  .refine((value) => {
    if (/^\/(?!\/)/.test(value)) return true;
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  });

export const announcementSchema = z
  .object({
    subject: z
      .string()
      .trim()
      .min(1)
      .max(ANNOUNCEMENT_LIMITS.subject)
      .refine(noPartner),
    preheader: z
      .string()
      .trim()
      .max(ANNOUNCEMENT_LIMITS.preheader)
      .refine(noPartner),
    // Staff's words (named `text`: no mail schema has a `body`, which is how tip notes are kept out).
    text: z
      .string()
      .trim()
      .min(1)
      .max(ANNOUNCEMENT_LIMITS.text)
      .refine(noPartner),
    button: z
      .object({
        label: z
          .string()
          .trim()
          .min(1)
          .max(ANNOUNCEMENT_LIMITS.buttonLabel)
          .refine(noPartner),
        url: buttonUrl,
      })
      .strict()
      .optional(),
  })
  .strict();

export type AnnouncementData = z.infer<typeof announcementSchema>;

export const announcement = defineMailType({
  id: 'announcement',
  category: 'marketing',
  sender: 'news',
  preference: null,
  schema: announcementSchema,
  sample: {
    subject: 'Lower fees on TipMe',
    preheader: 'TipMe’s fee on each tip is going down.',
    text: 'From 1 December, TipMe’s fee on each tip is going down.\n\n- **TipMe Free: 7% per tip**\n- **TipMe Pro: 5% per tip**\n\nYour supporters still pay exactly the tip they choose.',
    button: { label: 'See the new fees', url: '/pro' },
  },
  render: (data, ctx) => {
    const blocks = announcementBlocks(data.text);
    const first = blocks[0];
    const preheader =
      data.preheader ||
      (first?.kind === 'rich'
        ? first.spans.map((span) => span.text).join('')
        : '');
    if (data.button)
      blocks.push({
        kind: 'button',
        label: data.button.label,
        href: data.button.url.startsWith('/')
          ? mailLink(ctx, data.button.url, 'announcement_button')
          : data.button.url,
      });
    return letter(
      {
        subject: data.subject,
        heading: data.subject,
        preheader,
        blocks,
        reason:
          'You get news and announcements from TipMe because you have a TipMe account. Turn them off in Email settings.',
      },
      ctx,
    );
  },
});
