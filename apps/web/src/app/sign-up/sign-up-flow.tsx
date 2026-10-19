'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Skeleton } from '@tipme/ui';
import { HandleClaim } from '@/components/account/handle-claim';
import { PhoneCodeForm } from '@/components/account/phone-code-form';
import { apiFetch } from '@/lib/session-client';

/** Signed out: phone and code. Signed in without a page: choose a handle. With a page: dashboard. */
export function SignUpFlow() {
  const router = useRouter();
  const [step, setStep] = useState<'checking' | 'phone' | 'handle'>('checking');

  useEffect(() => {
    void apiFetch('/v1/me/profile').then((result) => {
      if (result.ok) router.replace('/dashboard');
      else setStep(result.status === 404 ? 'handle' : 'phone');
    });
  }, [router]);

  if (step === 'checking')
    return <Skeleton label="Checking whether you’re signed in" />;
  if (step === 'handle')
    return (
      <HandleClaim onClaimed={() => router.replace('/dashboard/settings')} />
    );
  return (
    <>
      <PhoneCodeForm
        onSignedIn={(result) =>
          result.hasProfile ? router.replace('/dashboard') : setStep('handle')
        }
      />
      <p className="auth-switch">
        Already have a page? <Link href="/sign-in">Sign in</Link>
      </p>
    </>
  );
}
