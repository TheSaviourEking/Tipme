'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type {
  InvitationAnswer,
  InvitationPreview,
  MyInvitations,
} from '@tipme/contracts';
import { Button, Slip, StateLine } from '@tipme/ui';
import { clearJoinLink, takeJoinCode } from '@/lib/business/join-link';
import {
  acceptInvitation,
  declineInvitation,
  loadMyInvitations,
  previewInvitation,
  setInvitationBlock,
  workChanged,
} from '@/lib/business/members-api';

/** "{business} · {location} invites you to receive tips there." and its manager forms. */
function inviteLine(invitation: InvitationPreview): string {
  const where = invitation.locationName
    ? `${invitation.businessName} · ${invitation.locationName}`
    : invitation.businessName;
  if (invitation.kind === 'staff')
    return `${where} invites you to receive tips there.`;
  return invitation.role === 'owner'
    ? `${where} invites you to help manage it, as an owner.`
    : `${where} invites you to manage this location.`;
}

type Problem = 'not_live' | 'invalid' | 'already' | 'failed';
const PROBLEM_WORDS: Record<Exclude<Problem, 'not_live'>, string> = {
  invalid:
    'That invitation isn’t valid any more. Ask the business for a new one.',
  already: 'You’re already there, so there’s nothing to accept.',
  failed: 'We couldn’t do that just now. Please try again.',
};
const problemOf = (code: string): Problem =>
  code === 'MEMBER_NOT_TIPPABLE'
    ? 'not_live'
    : code === 'INVITATION_INVALID'
      ? 'invalid'
      : code === 'ALREADY_A_MEMBER'
        ? 'already'
        : 'failed';

/** One invitation with Accept and Decline (and, for one sent to this account, Stop). */
function InvitationCard({
  invitation,
  answer,
  businessId,
  onAnswered,
}: {
  invitation: InvitationPreview;
  answer: InvitationAnswer;
  /** Set for invitations addressed to this account: it can stop that business inviting it. */
  businessId?: string;
  onAnswered: (outcome: 'accepted' | 'declined' | 'stopped') => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const run = async (
    step: () => Promise<{ ok: boolean; code?: string }>,
    outcome: 'accepted' | 'declined' | 'stopped',
  ) => {
    setBusy(true);
    setProblem(null);
    const result = await step();
    setBusy(false);
    if (result.ok) onAnswered(outcome);
    else setProblem(problemOf(result.code ?? ''));
  };
  const name = invitation.businessName;
  return (
    <li className="work-invitation">
      <p className="work-invitation__line">{inviteLine(invitation)}</p>
      <p className="tm-hint">
        {invitation.kind === 'staff'
          ? 'Your tips go to your own TipMe balance. You can leave at any time.'
          : 'Your own tips still go to your own TipMe balance. You can step down at any time.'}
      </p>
      {!invitation.verified && (
        <p className="tm-hint">TipMe hasn’t verified this business yet.</p>
      )}
      <div className="work-invitation__actions">
        <Button
          disabled={busy}
          onClick={() =>
            void run(
              () =>
                acceptInvitation(answer).then((r) => ({
                  ok: r.ok,
                  ...(r.ok ? {} : { code: r.code }),
                })),
              'accepted',
            )
          }
        >
          Accept
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void run(
              () =>
                declineInvitation(answer).then((r) => ({
                  ok: r.ok,
                  ...(r.ok ? {} : { code: r.code }),
                })),
              'declined',
            )
          }
        >
          Decline
        </Button>
        {businessId && (
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() =>
              void run(
                () =>
                  setInvitationBlock(businessId, true).then((r) => ({
                    ok: r.ok,
                    ...(r.ok ? {} : { code: r.code }),
                  })),
                'stopped',
              )
            }
          >
            Stop invitations from {name}
          </Button>
        )}
      </div>
      {problem === 'not_live' ? (
        <StateLine tone="error">
          Your TipMe page needs to be live first.{' '}
          <Link href="/dashboard/settings">Go to Settings</Link>
        </StateLine>
      ) : (
        problem && <StateLine tone="error">{PROBLEM_WORDS[problem]}</StateLine>
      )}
    </li>
  );
}

/**
 * The Work page's invitations (business PR B3): one opened from a link or an email (`#join=`,
 * kept through sign-in), and those sent to this account's username or proven email.
 */
export function InvitationsPanel() {
  const [linked, setLinked] = useState<
    | { code: string; preview: InvitationPreview }
    | { code: string; invalid: true }
    | null
  >(null);
  const [mine, setMine] = useState<MyInvitations | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const reload = useCallback(() => {
    void loadMyInvitations().then((result) =>
      setMine(result.ok ? result.data : null),
    );
  }, []);
  useEffect(() => {
    reload();
    const code = takeJoinCode();
    if (!code) return;
    void previewInvitation({ code }).then((result) => {
      if (result.ok) setLinked({ code, preview: result.data });
      else if (result.status === 404) {
        setLinked({ code, invalid: true });
        clearJoinLink();
      }
      // A passing failure keeps the link, so a reload can try again.
    });
  }, [reload]);

  const answered =
    (name: string) => (outcome: 'accepted' | 'declined' | 'stopped') => {
      setSaid(
        outcome === 'accepted'
          ? `You joined ${name}.`
          : outcome === 'declined'
            ? `You declined the invitation from ${name}.`
            : `${name} can’t invite you any more.`,
      );
      reload();
      if (outcome === 'accepted') workChanged();
    };

  const invitations = mine?.invitations ?? [];
  const blocked = mine?.blocked ?? [];
  const showLinked =
    linked &&
    'preview' in linked &&
    // The same invitation listed below needs only one card.
    !invitations.some(
      (i) =>
        i.businessName === linked.preview.businessName &&
        i.locationName === linked.preview.locationName &&
        i.kind === linked.preview.kind,
    );
  if (!linked && invitations.length === 0 && blocked.length === 0 && !said)
    return null;
  return (
    <section
      aria-labelledby="work-invitations-title"
      className="work-section work-invitations"
    >
      <h2 id="work-invitations-title">Invitations</h2>
      {said && <StateLine tone="status">{said}</StateLine>}
      {linked && 'invalid' in linked && (
        <Slip tone="error" title="That invitation isn’t valid any more">
          It may have been used, withdrawn, or sent to another account. Ask the
          business for a new one.
        </Slip>
      )}
      {(showLinked || invitations.length > 0) && (
        <ul className="work-invitations__list">
          {showLinked && linked && 'preview' in linked && (
            <InvitationCard
              invitation={linked.preview}
              answer={{ code: linked.code }}
              onAnswered={(outcome) => {
                clearJoinLink();
                setLinked(null);
                answered(linked.preview.businessName)(outcome);
              }}
            />
          )}
          {invitations.map((invitation) => (
            <InvitationCard
              key={invitation.id}
              invitation={invitation}
              answer={{ invitationId: invitation.id }}
              businessId={invitation.businessId}
              onAnswered={answered(invitation.businessName)}
            />
          ))}
        </ul>
      )}
      {blocked.length > 0 && (
        <div className="work-invitations__blocked">
          <h3>Stopped invitations</h3>
          <ul>
            {blocked.map((entry) => (
              <li key={entry.businessId}>
                <span>{entry.name}</span>
                <Button
                  variant="quiet"
                  onClick={() =>
                    void setInvitationBlock(entry.businessId, false).then(
                      (result) => {
                        if (result.ok) {
                          setSaid(`${entry.name} can invite you again.`);
                          reload();
                        }
                      },
                    )
                  }
                >
                  Allow {entry.name} to invite you again
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
