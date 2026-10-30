import { z } from 'zod';

/** By email. Phone is accepted only while messaging is pretend, until phone codes are built. */
export const signInCodeRequestSchema = z.union([
  z.object({ email: z.string().min(3).max(254) }).strict(),
  z.object({ phone: z.string().min(3).max(32) }).strict(),
]);
export type SignInCodeRequest = z.infer<typeof signInCodeRequestSchema>;

const signInCode = {
  code: z.string().regex(/^\d{6}$/),
  deviceLabel: z.string().min(1).max(80).optional(),
};
export const signInVerifySchema = z.union([
  z.object({ email: z.string().min(3).max(254), ...signInCode }).strict(),
  z.object({ phone: z.string().min(3).max(32), ...signInCode }).strict(),
]);

export const emailChangeCodeSchema = z
  .object({ email: z.email().max(254) })
  .strict();
export type EmailChangeCodeRequest = z.infer<typeof emailChangeCodeSchema>;

export const emailChangeConfirmSchema = z
  .object({ email: z.email().max(254), code: z.string().regex(/^\d{6}$/) })
  .strict();
export type EmailChangeConfirmRequest = z.infer<
  typeof emailChangeConfirmSchema
>;
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
