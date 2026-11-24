'use client';
import Link from 'next/link';
import { Lamp, Slip } from '@tipme/ui';
import { Money } from '@/components/money';
import type { ExtraNotice, PartView } from '@/lib/withdraw-state';

/**
 * A request paid as more than one payment (spec §6): each part's amount and state, amounts only.
 * The lamp is decoration; the words carry the state.
 */
export function PartList({ parts }: { parts: PartView[] }) {
  return (
    <ul className="withdraw__parts" aria-label="Payments">
      {parts.map((part, index) => (
        <li key={index}>
          <Lamp tone={part.tone} />
          <Money minor={part.amountMinor} /> {part.words}
        </li>
      ))}
    </ul>
  );
}

/** The ready quote's notices (spec §6), each a plain slip beside the usable form. */
export function ExtraNotices({ notices }: { notices: ExtraNotice[] }) {
  return notices.map((notice) => (
    <Slip
      key={notice.body}
      tone="neutral"
      title={notice.title}
      data-testid="withdraw-extra-notice"
      actions={
        notice.href &&
        notice.linkLabel && (
          <Link className="tm-button tm-button--continue" href={notice.href}>
            {notice.linkLabel}
          </Link>
        )
      }
    >
      {notice.body}
    </Slip>
  ));
}
