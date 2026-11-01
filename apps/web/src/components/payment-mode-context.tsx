'use client';
import { createContext, useContext } from 'react';
import type { PaymentMode } from '@/lib/payment-mode';

// PaymentModeScope (dashboard, admin, receipt) reads the mode on the server; client views read
// it here. Outside a scope the mode is closed: no pay button, no "test mode" claim.
const PaymentModeContext = createContext<PaymentMode>('closed');

export function PaymentModeProvider({
  mode,
  children,
}: {
  mode: PaymentMode;
  children: React.ReactNode;
}) {
  return <PaymentModeContext value={mode}>{children}</PaymentModeContext>;
}

export const usePaymentMode = (): PaymentMode => useContext(PaymentModeContext);
