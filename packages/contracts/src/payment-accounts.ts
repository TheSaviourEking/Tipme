import { z } from 'zod';

export const bachsOnboardingRequestSchema = z
  .object({
    country: z.string().regex(/^[A-Z]{2}$/),
    entityType: z.enum(['individual', 'company']),
  })
  .strict();
export type BachsOnboardingRequest = z.infer<
  typeof bachsOnboardingRequestSchema
>;

export type BachsPaymentAccountStatus = {
  enabled: boolean;
  environment: 'sandbox' | 'live' | null;
  status:
    | 'CREATING'
    | 'UNKNOWN'
    | 'ONBOARDING'
    | 'ACTIVE'
    | 'RESTRICTED'
    | 'FAILED'
    | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  feeCollector: 'platform' | 'connected_account' | 'unknown' | null;
  requirementsDue: string[];
  lastSyncedAt: string | null;
};

export type BachsOnboardingResponse =
  | { status: 'CREATING' | 'UNKNOWN' }
  | { status: 'ACTIVE'; chargesEnabled: true }
  | {
      status: 'ONBOARDING' | 'RESTRICTED';
      onboardingUrl: string;
      requirementsDue: string[];
    };

const bankCodeSchema = z.string().regex(/^[\w-]{1,20}$/);
const accountNumberSchema = z.string().regex(/^\d{10}$/);

export const payoutBankResolveSchema = z
  .object({ bankCode: bankCodeSchema, accountNumber: accountNumberSchema })
  .strict();
export type PayoutBankResolveRequest = z.infer<typeof payoutBankResolveSchema>;

export const payoutDestinationUpdateSchema = z
  .object({
    bankCode: bankCodeSchema,
    accountNumber: accountNumberSchema,
    accountName: z.string().trim().min(1).max(100),
    emailCode: z.string().regex(/^\d{6}$/),
  })
  .strict();
export type PayoutDestinationUpdateRequest = z.infer<
  typeof payoutDestinationUpdateSchema
>;

export type PayoutBank = { code: string; name: string };

export type PayoutBankResolveResponse =
  { resolved: true; accountName: string } | { resolved: false };

/** All a recipient ever sees of their bank account: never the number or a provider reference. */
export type PayoutDestinationView = {
  status: 'usable' | 'pending_review' | 'rejected';
  bankName: string;
  last4: string;
};
