'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Skeleton } from '@tipme/ui';
import { AuthProgress } from '@/components/account/auth-stage';
import { HandleClaim } from '@/components/account/handle-claim';
import { PhoneCodeForm } from '@/components/account/phone-code-form';
import { apiFetch } from '@/lib/session-client';

const steps = ['Your number', 'The code', 'Your handle'] as const;

/** Signed out: phone and code. Signed in without a page: choose a handle. With a page: dashboard. */
export function SignUpFlow() {
  const router = useRouter();
  const [step, setStep] = useState<'checking' | 'phone' | 'handle'>('checking');
  const [codeSent, setCodeSent] = useState(false);

  useEffect(() => {
    void apiFetch('/v1/me/profile').then((result) => {
      if (result.ok) router.replace('/dashboard');
      else setStep(result.status === 404 ? 'handle' : 'phone');
    });
  }, [router]);

  if (step === 'checking')
    return <Skeleton label="Checking whether you’re signed in" />;
  return (
    <>
      <AuthProgress
        label="Creating your page"
        steps={steps}
        current={step === 'handle' ? 2 : codeSent ? 1 : 0}
      />
      {step === 'handle' ? (
        // A new page lands on the welcome: greeting first, setup second.
        <HandleClaim onClaimed={() => router.replace('/dashboard/welcome')} />
      ) : (
        <>
          <PhoneCodeForm
            onStepChange={(next) => setCodeSent(next === 'code')}
            onSignedIn={(result) =>
              result.hasProfile
                ? router.replace('/dashboard')
                : setStep('handle')
            }
          />
          <p className="auth-switch">
            Already have a page? <Link href="/sign-in">Sign in</Link>
          </p>
        </>
      )}
    </>
  );
}
