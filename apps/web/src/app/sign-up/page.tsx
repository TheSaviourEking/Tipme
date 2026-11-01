import type { Metadata } from 'next';
import { AuthStage } from '@/components/account/auth-stage';
import { getPaymentMode } from '@/lib/payment-mode-api';
import { paymentModeCopy } from '@/lib/payment-mode-copy';
import { SignUpFlow } from './sign-up-flow';

export const metadata: Metadata = {
  title: 'Create your page',
  robots: { index: false, follow: false },
};

export default async function SignUpPage() {
  const copy = paymentModeCopy(await getPaymentMode());
  return (
    <AuthStage
      title="Your page, in a minute."
      lede={copy.signUpLede}
      promises={[
        'No card or bank details to start',
        'Your email stays private',
        'Skip anything and finish later',
      ]}
    >
      <SignUpFlow />
    </AuthStage>
  );
}
