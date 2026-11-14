'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { EmailCodeForm } from '@/components/account/email-code-form';
import { safeNext } from '@/lib/safe-next';
import { signedInLanding } from '@/lib/signed-in-landing';

export function SignInView() {
  const router = useRouter();
  const requested = useSearchParams().get('next');
  return (
    <>
      <EmailCodeForm
        onSignedIn={(result) =>
          // Staff may have no page of their own: the admin area never needs one. A business-only
          // login (business sign-up) lands on its business, never /sign-up.
          router.replace(
            signedInLanding(result, safeNext(requested, location.origin)),
          )
        }
      />
      <p className="auth-switch">
        New to TipMe? <Link href="/sign-up">Create your page</Link>
        <br />
        <Link href="/recover">Can’t get into your email?</Link>
      </p>
    </>
  );
}
