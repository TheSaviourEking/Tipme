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
  environment: 'sandbox' | null;
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
