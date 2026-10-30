'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { EmailCodeForm } from '@/components/account/email-code-form';
import { safeNext } from '@/lib/safe-next';

export function SignInView() {
  const router = useRouter();
  const requested = useSearchParams().get('next');
  return (
    <>
      <EmailCodeForm
        onSignedIn={(result) => {
          const next = safeNext(requested, location.origin);
          // Staff may have no page of their own: the admin area never needs one.
          const admin = next === '/ops' || next.startsWith('/ops/');
          router.replace(result.hasProfile || admin ? next : '/sign-up');
        }}
      />
      <p className="auth-switch">
        New to TipMe? <Link href="/sign-up">Create your page</Link>
      </p>
    </>
  );
}
