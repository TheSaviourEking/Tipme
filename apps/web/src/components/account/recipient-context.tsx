'use client';
import { createContext, useContext } from 'react';
import type { MyProfile } from '@tipme/contracts';

export interface RecipientContextValue {
  profile: MyProfile;
  setProfile: (profile: MyProfile) => void;
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
