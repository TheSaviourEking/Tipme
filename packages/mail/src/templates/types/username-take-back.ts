import { z } from 'zod';
import { defineMailType, mailLink, type MailContext } from '../define.js';
import { letter } from '../layout.js';

/*
 * The username take-back emails (username reservation spec, section 6). The words are fixed: the
 * only "why" a user reads is one of the category sentences below, never anything staff typed
 * (owner answer 3), so the schemas have no free-text field. These must equal `TAKE_BACK_WHY` in
 * @tipme/contracts (this package doesn't depend on it); the database tests queue every one of them.
 */
const WHY_SENTENCES = [
  'We need it to protect a brand, a public figure or one of our own names.',
  'The username impersonates someone.',
  'The username infringes a trademark.',
  'The law requires us to change it.',
] as const;

const handle = z.string().regex(/^[A-Za-z0-9_]{3,30}$/);
const why = z.enum(WHY_SENTENCES);
// A Lagos date written out, as lagosDateWords makes it: "10 November 2026".
const date = z.string().regex(/^\d{1,2} [A-Z][a-z]+ \d{4}$/);

const REASON =
  'You get this email when TipMe needs a username back. It can’t be turned off.';

const chooseButton = (ctx: MailContext) => ({
  kind: 'button' as const,
  label: 'Choose a new username',
  href: mailLink(ctx, '/dashboard/settings#handle', 'choose_username'),
});

const pageAt = (ctx: MailContext, name: string) => `${ctx.webOrigin}/@${name}`;

export const usernameTakeBackNotice = defineMailType({
  id: 'username_take_back_notice',
  category: 'account',
  sender: 'notifications',
  preference: null,
  schema: z
    .object({
      kind: z.enum(['current', 'old']),
      old: handle,
      current: handle,
      why,
      dueDate: date,
    })
    .strict(),
  sample: {
    kind: 'current',
    old: 'kemi',
    current: 'kemi',
    why: WHY_SENTENCES[0],
    dueDate: '10 November 2026',
  },
  render: (data, ctx) =>
    data.kind === 'current'
      ? letter(
          {
            subject: 'We need your TipMe username back',
            heading: 'We need your username back',
            blocks: [
              {
                kind: 'text',
                text: `TipMe needs the username @${data.old} back. ${data.why}`,
              },
              {
                kind: 'text',
                text: `Please choose a new username by the end of ${data.dueDate}. You can do it in Settings, and it won’t use up any of your username changes.`,
              },
              {
                kind: 'text',
                text: `Your page, your tips and your balance stay yours under the new username. Links and QR codes that use @${data.old} will stop working, so update them once you have chosen.`,
              },
              {
                kind: 'text',
                text: 'If you haven’t chosen by then, we will give your page a new username and email it to you.',
              },
              {
                kind: 'text',
                text: 'Reply to this email if you have a question.',
              },
              chooseButton(ctx),
            ],
            reason: REASON,
          },
          ctx,
        )
      : letter(
          {
            subject: 'A link to your TipMe page will stop working',
            heading: 'An old link will stop working',
            blocks: [
              {
                kind: 'text',
                text: `Your page keeps its username @${data.current}. Links and QR codes that still use your old username @${data.old} will stop working after ${data.dueDate}. ${data.why} Share your current link and print a new QR code if you need one.`,
              },
            ],
            reason: REASON,
          },
          ctx,
        ),
});

export const usernameTakeBackReminder = defineMailType({
  id: 'username_take_back_reminder',
  category: 'account',
  sender: 'notifications',
  preference: null,
  schema: z.object({ old: handle, dueDate: date }).strict(),
  sample: { old: 'kemi', dueDate: '10 November 2026' },
  render: (data, ctx) =>
    letter(
      {
        subject: '2 days left to choose a new TipMe username',
        heading: '2 days left to choose a new username',
        blocks: [
          {
            kind: 'text',
            text: `This is a reminder that TipMe needs the username @${data.old} back. Please choose a new username in Settings by the end of ${data.dueDate}. If you don’t, we will give your page one and email it to you. Your page, tips and balance stay yours.`,
          },
          chooseButton(ctx),
        ],
        reason: REASON,
      },
      ctx,
    ),
});

const DONE_VARIANTS = [
  'assigned',
  'user_chose',
  'old',
  'without_notice',
  'unreached',
] as const;

export const usernameTakeBackDone = defineMailType({
  id: 'username_take_back_done',
  category: 'account',
  sender: 'notifications',
  preference: null,
  schema: z
    .object({
      variant: z.enum(DONE_VARIANTS),
      old: handle,
      new: handle.nullable(),
      current: handle,
      why,
      noticeDate: date.nullable(),
      freeChangeDate: date.nullable(),
    })
    .strict()
    .superRefine((data, issues) => {
      // Each variant says these, so it must have them: an email with a gap is refused, not sent.
      const needs: Array<keyof typeof data> =
        data.variant === 'assigned'
          ? ['new', 'noticeDate', 'freeChangeDate']
          : data.variant === 'without_notice' || data.variant === 'unreached'
            ? ['new', 'freeChangeDate']
            : data.variant === 'user_chose'
              ? ['new']
              : [];
      for (const key of needs)
        if (data[key] === null)
          issues.addIssue({
            code: 'custom',
            path: [key],
            message: `${data.variant} needs ${key}`,
          });
    }),
  sample: {
    variant: 'assigned',
    old: 'kemi',
    new: 'page_x7k2qd',
    current: 'page_x7k2qd',
    why: WHY_SENTENCES[0],
    noticeDate: '3 November 2026',
    freeChangeDate: '10 December 2026',
  },
  render: (data, ctx) => {
    const name = data.new ?? data.current;
    switch (data.variant) {
      case 'assigned':
        return letter(
          {
            subject: 'Your TipMe page has a new username',
            heading: 'Your page has a new username',
            blocks: [
              {
                kind: 'text',
                text: `As we said on ${data.noticeDate}, TipMe has taken back @${data.old}. Your page is now at ${pageAt(ctx, name)}. Your tips and balance haven’t changed. Links and QR codes with @${data.old} no longer work, so share your new link and print a new QR code. You can change your new username once, for free, in Settings until ${data.freeChangeDate}.`,
              },
              chooseButton(ctx),
            ],
            reason: REASON,
          },
          ctx,
        );
      case 'unreached':
        return letter(
          {
            subject: 'Your TipMe page has a new username',
            heading: 'Your page has a new username',
            blocks: [
              {
                kind: 'text',
                text: `We couldn’t reach you about the username @${data.old}, so, as our terms say, TipMe has taken it back. ${data.why} Your page is now at ${pageAt(ctx, name)}. Your tips and balance haven’t changed. Links and QR codes with @${data.old} no longer work, so share your new link and print a new QR code. You can change your new username once, for free, in Settings until ${data.freeChangeDate}.`,
              },
              chooseButton(ctx),
            ],
            reason: REASON,
          },
          ctx,
        );
      case 'without_notice':
        return letter(
          {
            subject: 'We changed your TipMe username',
            heading: 'We changed your username',
            blocks: [
              {
                kind: 'text',
                text: `We have changed your page’s username from @${data.old} to @${name}, without notice, as our terms allow in this case. ${data.why} Your page, your tips and your balance are unchanged. Links and QR codes with @${data.old} no longer work. You can change your new username once, for free, in Settings until ${data.freeChangeDate}. Reply to this email if you think this is a mistake.`,
              },
              chooseButton(ctx),
            ],
            reason: REASON,
          },
          ctx,
        );
      case 'user_chose':
        return letter(
          {
            subject: 'Your new TipMe username is ready',
            heading: 'Your new username is ready',
            blocks: [
              {
                kind: 'text',
                text: `Your page is now at ${pageAt(ctx, name)}. The username @${data.old} is no longer yours, and links with it no longer work.`,
              },
            ],
            reason: REASON,
          },
          ctx,
        );
      case 'old':
        return letter(
          {
            subject: 'An old link to your TipMe page has stopped working',
            heading: 'An old link has stopped working',
            blocks: [
              {
                kind: 'text',
                text: `Links and QR codes with @${data.old} no longer lead to your page. Your page is still at ${pageAt(ctx, data.current)}.`,
              },
            ],
            reason: REASON,
          },
          ctx,
        );
    }
  },
});

export const usernameTakeBackCancelled = defineMailType({
  id: 'username_take_back_cancelled',
  category: 'account',
  sender: 'notifications',
  preference: null,
  schema: z.object({ old: handle }).strict(),
  sample: { old: 'kemi' },
  render: (data, ctx) =>
    letter(
      {
        subject: 'You can keep your TipMe username',
        heading: 'You can keep your username',
        blocks: [
          {
            kind: 'text',
            text: `We no longer need the username @${data.old}. It stays yours, and your links and QR codes keep working. You don’t need to do anything.`,
          },
        ],
        reason: REASON,
      },
      ctx,
    ),
});
