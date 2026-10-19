import { z } from 'zod';

export const signInCodeRequestSchema = z
  .object({ phone: z.string().min(3).max(32) })
  .strict();
export type SignInCodeRequest = z.infer<typeof signInCodeRequestSchema>;

export const signInVerifySchema = z
  .object({
    phone: z.string().min(3).max(32),
    code: z.string().regex(/^\d{6}$/),
    deviceLabel: z.string().min(1).max(80).optional(),
  })
  .strict();
export type SignInVerifyRequest = z.infer<typeof signInVerifySchema>;

export interface SignInVerified {
  userId: string;
  isNew: boolean;
  hasProfile: boolean;
}

export interface SessionView {
  id: string;
  deviceLabel: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

/** Development only: what the pretend messenger or mailbox would have delivered. */
export interface PretendMessage {
  id: string;
  channel: 'whatsapp' | 'sms' | 'email';
  to: string;
  subject: string | null;
  body: string;
  sentAt: string;
}
