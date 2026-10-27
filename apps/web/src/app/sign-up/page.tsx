import type { Metadata } from 'next';
import { AuthStage } from '@/components/account/auth-stage';
import { SignUpFlow } from './sign-up-flow';

export const metadata: Metadata = {
  title: 'Create your page',
  robots: { index: false, follow: false },
};

export default function SignUpPage() {
  return (
    <AuthStage
      title="Your page, in a minute."
      lede="A phone number and a handle is all it takes to start receiving thanks. Payments are in test mode."
      promises={[
        'No card or bank details to start',
        'Your number stays private',
        'Skip anything and finish later',
      ]}
    >
      <SignUpFlow />
    </AuthStage>
  );
}
