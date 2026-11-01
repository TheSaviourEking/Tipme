import type { Metadata } from 'next';
import { AuthStage } from '@/components/account/auth-stage';
import { ModeText } from '@/components/payment-mode-slot';
import { SignUpFlow } from './sign-up-flow';

export const metadata: Metadata = {
  title: 'Create your page',
  robots: { index: false, follow: false },
};

export default function SignUpPage() {
  return (
    <AuthStage
      title="Your page, in a minute."
      lede={<ModeText pick="signUpLede" />}
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
