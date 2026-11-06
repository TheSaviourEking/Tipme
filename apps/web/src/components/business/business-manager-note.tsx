'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { MyBusinessRoles } from '@tipme/contracts';
import { loadBusinessRoles } from '@/lib/business/roles-api';
import { readSignedInHint } from '@/lib/signed-in-hint';

type Managed = MyBusinessRoles['manages'][number];

/** The board's three wordings, and one for a verified business with every place closed. */
function wording(managed: Managed, shown: 'places' | 'unavailable'): string {
  if (shown === 'places')
    return `This is what customers see at your address. Only managers of ${managed.name} see this note.`;
  if (managed.status === 'pending')
    return `Customers see the screen below until TipMe verifies ${managed.name}. Only managers see this note.`;
  if (managed.status === 'suspended')
    return `Customers see the screen below while TipMe has paused ${managed.name}. Your dashboard says why.`;
  return `Customers see the screen below while none of ${managed.name}’s places is open. Only managers see this note.`;
}

/**
 * The business page's quiet note for its own managers (BusinessProfile board, section 3). Added in
 * the browser after the roles read, so the cached public HTML is the same for every visitor.
 */
export function BusinessManagerNote({
  business,
  shown,
}: {
  business: string;
  /** What visitors get at this address: the places list, or the "isn't taking tips" screen. */
  shown: 'places' | 'unavailable';
}) {
  const [managed, setManaged] = useState<Managed | null>(null);
  useEffect(() => {
    // Signed-out visitors never ask the API who they are.
    if (!readSignedInHint()) return;
    const slug = business.toLowerCase();
    let live = true;
    void loadBusinessRoles().then((roles) => {
      if (live)
        setManaged(roles?.manages.find((row) => row.slug === slug) ?? null);
    });
    return () => {
      live = false;
    };
  }, [business]);
  if (!managed) return null;
  return (
    <div className="business-manager-note" role="note">
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
        <circle
          cx="12"
          cy="12"
          r="3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
      </svg>
      <p>
        {wording(managed, shown)}{' '}
        <Link href="/dashboard/business">Go to your business dashboard</Link>
      </p>
    </div>
  );
}
