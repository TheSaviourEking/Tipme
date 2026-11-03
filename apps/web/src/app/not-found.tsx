'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ActionLink } from '@tipme/ui';
import { QuietScreen } from '@/components/quiet-screen';
import { missingHandle } from '@/lib/missing-handle';

export default function NotFound() {
  const handle = missingHandle(usePathname());
  return (
    <QuietScreen
      title={handle ? `We can’t find @${handle}.` : 'We can’t find that page.'}
      action={
        <ActionLink variant="continue" href="/">
          Go to TipMe
        </ActionLink>
      }
      foot={
        <Link className="text-link" href="/sign-up">
          Get your own page
        </Link>
      }
    >
      <p>
        {handle
          ? 'Check the spelling, or ask them for their link. They may have changed their handle.'
          : 'Check the link, or ask the person for their TipMe link or QR code.'}
      </p>
    </QuietScreen>
  );
}
