import { z } from 'zod';

/** What a recipient's dashboard shows. Amounts are decimal strings of minor units. */
export interface DashboardSummary {
  currency: string;
  availableMinor: string;
  confirmingMinor: string;
  today: string;
  yesterday: string;
  thisWeek: string;
  lastWeek: string;
  last7Days: { date: string; netMinor: string }[];
}

export type TipState = 'paid' | 'confirming' | 'failed' | 'cancelled';

export interface MyTipRow {
  tipId: string;
  at: string;
  supporterLabel: string | null;
  hasMessage: boolean;
  grossMinor: string;
  netMinor: string;
  state: TipState;
}

export interface MyTipDetail {
  tipId: string;
  state: TipState;
  at: string;
  supporterLabel: string | null;
  message: string | null;
  currency: string;
  grossMinor: string;
  platformFeeMinor: string;
  providerFeeMinor: string;
  netMinor: string;
  feePolicyVersion: string;
  proof: {
    verified: boolean;
    provider: string | null;
    referenceTail: string | null;
    verifiedAt: string | null;
    ledgerTransactionId: string | null;
  };
}

export interface ActivityRow {
  kind: 'tip' | 'withdrawal';
  id: string;
  at: string;
  amountMinor: string;
  state: string;
  supporterLabel: string | null;
}

export const withdrawalRequestSchema = z
  .object({ amountMinor: z.string().regex(/^\d{1,12}$/) })
  .strict();

export interface NotificationView {
  id: string;
  kind: string;
  tipId: string | null;
  momentId: string | null;
  reportId: string | null;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}

/** A recipient's week. `topSupporterLabel` is private: it never goes into anything shareable. */
export interface WeeklyReportData {
  week: string;
  totalNetMinor: string;
  changePct: number | null;
  tipCount: number;
  notesCount: number;
  bestDay: { date: string; netMinor: string } | null;
  topSupporterLabel: string | null;
  moments: { key: string; title: string }[];
}

export interface MomentView {
  id: string;
  key: string;
  kind: string;
  title: string;
  sharedAt: string | null;
  createdAt: string;
}
