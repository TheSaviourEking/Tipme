'use client';
import { createContext, useContext } from 'react';
import type { MyProfile } from '@tipme/contracts';
import type { AttentionItem } from '@/lib/owner-attention';

export interface RecipientContextValue {
  profile: MyProfile;
  setProfile: (profile: MyProfile) => void;
  /** What stops the owner earning; null until the payment account has been read. */
  attention: AttentionItem[] | null;
  /** Whether payments need the owner's own provider account; null until known. */
  paymentsNeedSetup: boolean | null;
  /** Re-reads the payment account, after a change made outside the profile. */
  refreshAttention: () => void;
}

export const RecipientContext = createContext<RecipientContextValue | null>(
  null,
);

/** The signed-in recipient's own page, loaded once by the dashboard layout. */
export function useRecipient(): RecipientContextValue {
  const value = useContext(RecipientContext);
  if (!value) throw new Error('useRecipient must be used inside the dashboard');
  return value;
}
