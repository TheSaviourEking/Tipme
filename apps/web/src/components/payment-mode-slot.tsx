import { Suspense, type ReactNode } from 'react';
import { getPaymentMode } from '@/lib/payment-mode-api';
import type { PaymentMode } from '@/lib/payment-mode';
import { paymentModeCopy, type PaymentModeCopy } from '@/lib/payment-mode-copy';
import { PaymentModeProvider } from './payment-mode-context';

// Server-only helpers. The mode is read per request (never baked in at build), so whatever
// depends on it streams in a Suspense boundary while the rest of the page stays prerendered.

async function Resolved({
  children,
}: {
  children: (mode: PaymentMode, copy: PaymentModeCopy) => ReactNode;
}) {
  const mode = await getPaymentMode();
  return children(mode, paymentModeCopy(mode));
}

/** Renders `children` for this copy's mode; `fallback` (nothing by default) until it is known. */
export function PaymentModeSlot({
  children,
  fallback = null,
}: {
  children: (mode: PaymentMode, copy: PaymentModeCopy) => ReactNode;
  fallback?: ReactNode;
}) {
  return (
    <Suspense fallback={fallback}>
      <Resolved>{children}</Resolved>
    </Suspense>
  );
}

type TextKey = {
  [K in keyof PaymentModeCopy]: PaymentModeCopy[K] extends string | null
    ? K
    : never;
}[keyof PaymentModeCopy];

/**
 * One mode-dependent sentence. Until the mode is known it shows the live wording, which claims
 * neither a test nor that tipping is closed.
 */
export function ModeText({ pick }: { pick: TextKey }) {
  return (
    <PaymentModeSlot fallback={paymentModeCopy('live')[pick]}>
      {(_mode, copy) => copy[pick]}
    </PaymentModeSlot>
  );
}

/** Links and notes about the preview and the fictional demo page: test copies only. */
export function TestModeOnly({ children }: { children: ReactNode }) {
  return (
    <PaymentModeSlot>
      {(_mode, copy) => (copy.previewPages ? children : null)}
    </PaymentModeSlot>
  );
}

/**
 * Gives client views below the mode (usePaymentMode). Place it inside an existing Suspense
 * boundary: it waits for the mode.
 */
export async function PaymentModeScope({ children }: { children: ReactNode }) {
  return (
    <PaymentModeProvider mode={await getPaymentMode()}>
      {children}
    </PaymentModeProvider>
  );
}
