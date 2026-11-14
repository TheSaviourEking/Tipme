'use client';
import { createContext, useContext } from 'react';
import type { MyAccount, MyBusinessRoles } from '@tipme/contracts';
import type { ReleaseFlags } from '@/lib/business/available';

// Business sign-up, Task D4: the login itself, for every dashboard page, with or without a page.

export interface AccountContextValue {
  /** The login. With a page it is drawn from the page's own read (no extra request). */
  account: MyAccount | null;
  roles: MyBusinessRoles | null;
  /** The business flags; null until read. */
  flags: ReleaseFlags | null;
  /** A login with a business (or a manager invitation) and no page. */
  accountOnly: boolean;
  /** Reads the login again (after an email change, say). */
  refreshAccount: () => void;
}

export const AccountContext = createContext<AccountContextValue | null>(null);

export function useAccount(): AccountContextValue {
  const value = useContext(AccountContext);
  if (!value) throw new Error('useAccount must be used inside the dashboard');
  return value;
}
