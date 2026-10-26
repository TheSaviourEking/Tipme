import type { Metadata } from 'next';
import { AuthStage } from '@/components/account/auth-stage';
import { RecoverFlow } from './recover-flow';

export const metadata: Metadata = {
  title: 'Lost your number?',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function RecoverPage() {
  return (
    <AuthStage
      title="Lost your number?"
      lede="It happens. If you verified an email, we can move your page to your new number."
    >
      <RecoverFlow />
    </AuthStage>
  );
}
