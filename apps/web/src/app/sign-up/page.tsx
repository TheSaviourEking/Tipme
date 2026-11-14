import type { Metadata } from 'next';
import { Skeleton } from '@tipme/ui';
import { AuthStage } from '@/components/account/auth-stage';
import { ModeText } from '@/components/payment-mode-slot';
import { ReleaseFlagsSlot } from '@/components/release-flags-slot';
import { SignUpFlow } from './sign-up-flow';

export const metadata: Metadata = {
  title: 'Create your page',
  robots: { index: false, follow: false },
};

export default function SignUpPage() {
  const todayLede = <ModeText pick="signUpLede" />;
  // The stage's words follow the path the card is on (business sign-up), so the flow draws it.
  // Until the flags are read, today's stage with the card still checking.
  return (
    <ReleaseFlagsSlot
      fallback={
        <AuthStage title="Your page, in a minute." lede={todayLede}>
          <Skeleton label="Checking whether you’re signed in" />
        </AuthStage>
      }
    >
      {(flags) => (
        <SignUpFlow
          todayLede={todayLede}
          businessSignup={flags.businessSignup}
        />
      )}
    </ReleaseFlagsSlot>
  );
}
