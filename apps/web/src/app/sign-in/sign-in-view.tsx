'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { EmailCodeForm } from '@/components/account/email-code-form';
import { takeJoinCode } from '@/lib/business/join-link';
import { safeNext } from '@/lib/safe-next';
import { signedInLanding } from '@/lib/signed-in-landing';

export function SignInView({
  businessSignup = false,
}: {
  /** BUSINESS_SIGNUP_ENABLED, read on the server. */
  businessSignup?: boolean;
}) {
  const router = useRouter();
  const requested = useSearchParams().get('next');
  return (
    <>
      <EmailCodeForm
        onSignedIn={(result) => {
          // Staff may have no page of their own: the admin area never needs one. A business-only
          // login (business sign-up) lands on its business, never /sign-up.
          const next = safeNext(requested, location.origin);
          const landing = signedInLanding(result, next);
          // Business sign-up: an invitation link kept through sign-in goes back to Work, which
          // answers a manager's with no page; staff still choose a handle first (the dashboard
          // sends them to /sign-up, as today).
          const toWork =
            landing === '/sign-up' &&
            next.startsWith('/dashboard/work') &&
            takeJoinCode() !== null &&
            businessSignup;
          router.replace(toWork ? next : landing);
        }}
      />
      <p className="auth-switch">
        New to TipMe? <Link href="/sign-up">Create your page</Link>
        <br />
        <Link href="/recover">Can’t get into your email?</Link>
      </p>
    </>
  );
}
