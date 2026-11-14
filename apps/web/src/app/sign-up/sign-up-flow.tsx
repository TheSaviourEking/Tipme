'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Skeleton } from '@tipme/ui';
import { AuthProgress, AuthStage } from '@/components/account/auth-stage';
import { HandleClaim } from '@/components/account/handle-claim';
import { EmailCodeForm } from '@/components/account/email-code-form';
import { takeJoinCode } from '@/lib/business/join-link';
import { handleFromSearch } from '@/lib/handle-hint';
import { apiFetch } from '@/lib/session-client';
import { signUpPath } from '@/lib/sign-up-path';
import { BusinessSteps } from './business-steps';
import { SignUpFork, type ForkChoice } from './fork';

const tippedSteps = ['Your email', 'The code', 'Your handle'] as const;
const businessSteps = [
  'Your email',
  'The code',
  'Your business',
  'First location',
] as const;

const PROMISES = [
  'No card or bank details to start',
  'Your email stays private',
  'Skip anything and finish later',
] as const;

type Step = 'checking' | 'fork' | 'email' | 'handle' | 'business' | 'location';

/**
 * Sign-up: the stage and the card. With business sign-up off (or not yet known) it is today's
 * three steps exactly: signed out → email and code; signed in without a page → the handle; with a
 * page → the dashboard. With it on (Task D3), the card first asks "Get tipped" or "For businesses"
 * unless the link already says (`?for=business`, the home claim's handle, an invitation's
 * `#join=`), and "For businesses" runs four steps with no handle.
 */
export function SignUpFlow({
  todayLede,
  businessSignup = false,
}: {
  todayLede: ReactNode;
  /** BUSINESS_SIGNUP_ENABLED, read on the server. */
  businessSignup?: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>('checking');
  const [path, setPath] = useState<ForkChoice>('tipped');
  const [signup, setSignup] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  // Home's claim field sends the handle in the link. It is read once and kept in state, so it is
  // still here when the email and code steps are done and the handle step opens.
  const [hint] = useState(() =>
    typeof window === 'undefined'
      ? ''
      : handleFromSearch(window.location.search),
  );

  useEffect(() => {
    let live = true;
    void apiFetch('/v1/me/profile').then((profile) => {
      if (!live) return;
      if (!businessSignup) {
        // Today's flow, exactly.
        if (profile.ok) router.replace('/dashboard');
        else setStep(profile.status === 404 ? 'handle' : 'email');
        return;
      }
      setSignup(true);
      // An invitation link kept through sign-in counts as one in the address bar.
      const asked = signUpPath(
        window.location.search,
        window.location.hash || (takeJoinCode() ? '#join=' : ''),
      );
      const chosen: ForkChoice = asked === 'business' ? 'business' : 'tipped';
      setPath(chosen);
      if (profile.ok) {
        // Someone with a page adding a business uses the dashboard's own form.
        router.replace(
          chosen === 'business' ? '/dashboard/business/apply' : '/dashboard',
        );
        return;
      }
      const hasLogin = profile.status === 404;
      setSignedIn(hasLogin);
      if (asked === 'ask') setStep('fork');
      else if (!hasLogin) setStep('email');
      else setStep(chosen === 'business' ? 'business' : 'handle');
    });
    return () => {
      live = false;
    };
  }, [router, businessSignup]);

  const choose = (choice: ForkChoice) => {
    setPath(choice);
    if (!signedIn) setStep('email');
    else setStep(choice === 'business' ? 'business' : 'handle');
  };

  const business = signup && path === 'business';
  const steps = business ? businessSteps : tippedSteps;
  const current =
    step === 'handle' || step === 'business'
      ? 2
      : step === 'location'
        ? 3
        : codeSent
          ? 1
          : 0;
  const intro = business
    ? {
        title: 'Your business on TipMe.',
        lede: 'One QR code for each place. Tips reach your staff, and you see what customers say.',
      }
    : signup
      ? {
          title: 'Your page, in a minute.',
          lede: 'Or your business. Pick one now; you can add the other later on the same login.',
        }
      : { title: 'Your page, in a minute.', lede: todayLede };

  return (
    <AuthStage title={intro.title} lede={intro.lede} promises={PROMISES}>
      {step === 'checking' ? (
        <Skeleton label="Checking whether you’re signed in" />
      ) : step === 'fork' ? (
        <SignUpFork onChoose={choose} />
      ) : (
        <>
          <AuthProgress
            label={business ? 'Signing up your business' : 'Creating your page'}
            steps={steps}
            current={current}
          />
          {step === 'handle' ? (
            // A new page lands on the welcome: greeting first, setup second.
            <HandleClaim
              initial={hint}
              onClaimed={() => router.replace('/dashboard/welcome')}
            />
          ) : step === 'business' || step === 'location' ? (
            <BusinessSteps onStepChange={setStep} />
          ) : (
            <>
              <EmailCodeForm
                onStepChange={(next) => setCodeSent(next === 'code')}
                onSignedIn={(result) => {
                  if (business) setStep('business');
                  else if (result.hasProfile) router.replace('/dashboard');
                  else setStep('handle');
                }}
              />
              <p className="auth-switch">
                Already have a page? <Link href="/sign-in">Sign in</Link>
              </p>
            </>
          )}
        </>
      )}
    </AuthStage>
  );
}
