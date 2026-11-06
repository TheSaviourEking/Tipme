'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useId, useState } from 'react';
import type {
  ManagerRole,
  OpsBusinessContact,
  OpsBusinessDetail,
} from '@tipme/contracts';
import { Badge, Card, EmptyWell, Skeleton, Slip } from '@tipme/ui';
import {
  ActionOutcome,
  outcomeOf,
  type ActionOutcomeState,
} from '@/components/ops/action-outcome';
import { ReasonAction } from '@/components/ops/reason-action';
import {
  changeBusiness,
  loadBusiness,
  OPS_BUSINESS_STATUS_WORDS,
  revealContact,
} from '@/lib/business/ops-api';
import { can, useOpsAccess, when } from '@/lib/ops-client';
import { outcomeIsUnknown, refusalWords } from '@/lib/ops-answers';

const ROLE_WORDS: Record<ManagerRole, string> = {
  owner: 'Owner',
  location_manager: 'Location manager',
};

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <Card className="settings-section ops-section">
      <section aria-labelledby={id}>
        <h2 id={id}>{title}</h2>
        {children}
      </section>
    </Card>
  );
}

function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="ops-facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Why a change didn't go through, in staff words. */
const refusal = (answer: { status: number; code: string; message?: string }) =>
  answer.code === 'VALIDATION_FAILED'
    ? 'Nothing changed. It may have changed since you opened it: reload and check its status.'
    : answer.code === 'BUSINESS_NOT_VERIFIED'
      ? 'Nothing changed. This business isn’t verified yet, so it has no pages to pause.'
      : answer.code === 'APPROVAL_SUBJECT'
        ? 'Nothing changed. You, or an account sharing your email, manage this business, so you can’t verify it. Another staff member must.'
        : refusalWords(answer);

/**
 * One business for staff (PR B2): masked facts, a reveal with a reason, its locations and managers,
 * and the three changes. Verifying is a serious action and may wait for a second person.
 */
export default function OpsBusinessPage() {
  const { businessId } = useParams<{ businessId: string }>();
  const access = useOpsAccess();
  const [business, setBusiness] = useState<OpsBusinessDetail | null>(null);
  const [missing, setMissing] = useState<'not_found' | 'failed' | null>(null);
  const [contact, setContact] = useState<OpsBusinessContact | null>(null);
  const [outcome, setOutcome] = useState<ActionOutcomeState | null>(null);

  const show = useCallback(
    (result: Awaited<ReturnType<typeof loadBusiness>>) => {
      if (result.ok) {
        setBusiness(result.data);
        setMissing(null);
      } else setMissing(result.status === 404 ? 'not_found' : 'failed');
    },
    [],
  );
  const load = async () => show(await loadBusiness(businessId));
  useEffect(() => {
    let current = true;
    void loadBusiness(businessId).then((result) => {
      if (current) show(result);
    });
    return () => {
      current = false;
    };
  }, [businessId, show]);

  const change = async (
    action: 'verify' | 'suspend' | 'restore',
    reason: string,
    done: string,
  ) => {
    const answer = await changeBusiness(businessId, action, reason);
    if (answer.kind === 'refused') {
      if (outcomeIsUnknown(answer)) await load();
      return refusal(answer);
    }
    if (answer.kind === 'done') setBusiness(answer.data);
    setOutcome(
      outcomeOf(
        answer,
        done,
        action === 'verify' ? 'Its codes stay off until then.' : undefined,
      ),
    );
    return null;
  };

  if (missing === 'not_found')
    return (
      <section className="dashboard-section">
        <p>
          <Link href="/ops/businesses">← All businesses</Link>
        </p>
        <EmptyWell title="No such business">
          It may have been typed wrong. Find it from the list.
        </EmptyWell>
      </section>
    );
  if (missing === 'failed')
    return (
      <section className="dashboard-section">
        <Slip tone="error" title="Couldn’t load this business" dense>
          Check your connection and reload the page.
        </Slip>
      </section>
    );
  if (!business) return <Skeleton label="Loading the business" />;

  const manage = can(access, 'businesses.manage');
  return (
    <section className="dashboard-section" aria-labelledby="business-title">
      <p>
        <Link href="/ops/businesses">← All businesses</Link>
      </p>
      <h1 id="business-title">{business.name}</h1>
      <p>
        <Badge className={`ops-business-status--${business.status}`}>
          {OPS_BUSINESS_STATUS_WORDS[business.status]}
        </Badge>{' '}
        <span className="tm-hint">usetipme.xyz/b/{business.slug}</span>
      </p>
      {outcome && <ActionOutcome outcome={outcome} />}

      <Section title="Details">
        <Facts
          rows={[
            ['Applied', when(business.createdAt)],
            [
              'Verified',
              business.verifiedAt ? when(business.verifiedAt) : 'Not yet',
            ],
            ...(business.suspendedReason
              ? ([['Pause reason', business.suspendedReason]] as [
                  string,
                  React.ReactNode,
                ][])
              : []),
            ['Staff', String(business.members)],
          ]}
        />
      </Section>

      <Section title="Contact">
        {contact ? (
          <>
            <Facts
              rows={[
                ['Name', contact.contactName],
                ['Email', contact.contactEmail],
                ['Phone', contact.contactPhone ?? null],
                ...contact.managers.map(
                  (manager, index) =>
                    [
                      `${ROLE_WORDS[manager.role]} ${index + 1}`,
                      manager.email ?? 'No email on the account',
                    ] as [string, React.ReactNode],
                ),
              ]}
            />
            <p className="tm-hint">
              Shown because you gave a reason. It is in the audit log.
            </p>
          </>
        ) : (
          <>
            <Facts
              rows={[
                ['Email', business.contactEmailMasked],
                [
                  'Phone',
                  business.contactPhoneLast4
                    ? `Ending ${business.contactPhoneLast4}`
                    : null,
                ],
              ]}
            />
            {can(access, 'private.view') ? (
              <ReasonAction
                open="Reveal contact"
                field="Why do you need the full contact?"
                submit="Reveal"
                onSubmit={async (reason) => {
                  const result = await revealContact(businessId, reason);
                  if (!result.ok) return refusal(result);
                  setContact(result.data);
                  return null;
                }}
              />
            ) : (
              <p className="tm-hint">
                Hidden. Revealing it needs the private details permission.
              </p>
            )}
          </>
        )}
      </Section>

      <Section title="Locations">
        <ul className="ops-list" aria-label="Locations">
          {business.locationList.map((location) => (
            <li key={location.id} className="ops-row">
              <span className="ops-row__head">
                <strong>{location.name}</strong>
                {location.closed && <Badge>Closed</Badge>}
              </span>
              <span>{location.address}</span>
              {/* What supporters see at this location, today: before verification, or while
                  paused or closed, it shows the "isn't taking tips" state. */}
              <a
                className="tm-hint"
                href={`/b/${business.slug}/${location.slug}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`/b/${business.slug}/${location.slug}: ${location.name}’s public page (opens in a new tab)`}
              >
                /b/{business.slug}/{location.slug}
              </a>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Managers">
        <ul className="ops-list" aria-label="Managers">
          {business.managers.map((manager, index) => (
            <li key={index} className="ops-row">
              <strong>{ROLE_WORDS[manager.role]}</strong>
              <span>{manager.userHint}</span>
            </li>
          ))}
        </ul>
      </Section>

      {manage && business.status === 'pending' && (
        <Section title="Verify">
          <p>
            Check its name, address and a contact first. Once verified, its
            codes go live and its pages show “Verified business”. Its web
            address can’t change after that, because printed codes are never
            reprinted.
          </p>
          <ReasonAction
            open="Verify…"
            field="What did you check?"
            submit="Verify this business"
            variant="primary"
            onSubmit={(reason) =>
              change(
                'verify',
                reason,
                `${business.name} is verified. Its owners were told their codes are ready to print.`,
              )
            }
          />
        </Section>
      )}
      {manage && business.status === 'verified' && (
        <Section title="Pause">
          <p>
            Pausing stops its location and staff pages at once and ends every
            shift. Tips through a person’s own page carry on.
          </p>
          <ReasonAction
            open="Pause this business…"
            field="Why pause it?"
            submit="Pause this business"
            onSubmit={(reason) =>
              change('suspend', reason, `${business.name} is paused.`)
            }
          />
        </Section>
      )}
      {manage && business.status === 'suspended' && (
        <Section title="Restore">
          <p>
            Restoring brings its pages back. People check in again when they
            start their next shift.
          </p>
          <ReasonAction
            open="Restore this business…"
            field="Why restore it?"
            submit="Restore this business"
            onSubmit={(reason) =>
              change('restore', reason, `${business.name} is back.`)
            }
          />
        </Section>
      )}
    </section>
  );
}
