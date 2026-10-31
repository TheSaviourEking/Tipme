import type { Metadata } from 'next';
import { AuthStage } from '@/components/account/auth-stage';
import { RecoverFlow } from './recover-flow';

export const metadata: Metadata = {
  title: 'Can’t get into your email?',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function RecoverPage() {
  return (
    <AuthStage
      title="Can’t get into your email?"
      lede="It happens. If you added a recovery email, we can move your account to a new address."
    >
      <RecoverFlow />
    </AuthStage>
  );
}
