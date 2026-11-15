import { z } from 'zod';

// Priority support (owner default ruling 7): a support request opens an ops issue; a Pro member's
// is marked priority and sorted first. No response time is promised until the owner sets one.

export const SUPPORT_TOPICS = [
  'withdrawal',
  'tip',
  'page',
  'account',
  'pro',
  'other',
] as const;
export type SupportTopic = (typeof SUPPORT_TOPICS)[number];

export const SUPPORT_TOPIC_WORDS: Record<SupportTopic, string> = {
  withdrawal: 'A withdrawal',
  tip: 'A tip',
  page: 'My page',
  account: 'My account',
  pro: 'TipMe Pro',
  other: 'Something else',
};

export const SUPPORT_BODY_LIMIT = 2000;
/** At most this many waiting requests per person. */
export const SUPPORT_OPEN_LIMIT = 3;
export const SUPPORT_PRO_LINE = 'Pro requests are answered first.';

export const supportRequestSchema = z
  .object({
    topic: z.enum(SUPPORT_TOPICS),
    body: z
      .string()
      // Control characters out, except new lines.
      .transform((value) => value.replace(/[^\P{Cc}\n]/gu, '').trim())
      .pipe(z.string().min(1).max(SUPPORT_BODY_LIMIT)),
  })
  .strict();
export type SupportRequestInput = z.infer<typeof supportRequestSchema>;

export interface MySupportRequest {
  id: string;
  topic: SupportTopic;
  createdAt: string;
  status: 'waiting' | 'closed';
  /** Whether it was sent while on Pro. */
  priority: boolean;
}
