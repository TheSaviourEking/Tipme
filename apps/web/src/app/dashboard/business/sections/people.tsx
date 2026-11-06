'use client';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import type {
  BusinessDetail,
  InvitationRequest,
  InvitationRow,
  InviteeCard,
  ManagerRole,
  MemberRow,
} from '@tipme/contracts';
import { Button, InputField, StateLine } from '@tipme/ui';
import { AvatarImage } from '@/components/avatar';
import { hasAvatar } from '@/lib/avatar-source';
import {
  invite,
  loadInvitations,
  loadMembers,
  removeMember,
  revokeInvitation,
  searchInvitees,
} from '@/lib/business/members-api';
import { useBusinessLive } from '@/lib/business/use-business-live';

// Business PR B3: the Business page's People section: the team per location, Remove, the open
// invitations with Revoke, and Invite by email, one-time link or TipMe username. A business never
// creates an account: whoever accepts uses their own.

type As = 'staff' | ManagerRole;
type Channel = 'email' | 'link' | 'user';
const AS_WORDS: Record<As, string> = {
  staff: 'Team member',
  location_manager: 'Location manager',
  owner: 'Owner',
};
const ERROR_WORDS: Record<string, string> = {
  INVITATIONS_BLOCKED:
    'This person isn’t taking invitations from your business.',
  INVITEE_UNAVAILABLE: 'No TipMe page can be invited with that username.',
  ALREADY_A_MEMBER: 'They’re already on this team.',
  BUSINESS_NOT_VERIFIED:
    'Your business is paused, so it can’t invite anyone right now.',
  RATE_LIMITED:
    'That’s a lot of invitations at once. Wait a minute, then try again.',
};
const dateOf = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Africa/Lagos',
  }).format(new Date(iso));

/** A one-time link, shown once: copy it, or share it on WhatsApp from the manager's own phone. */
function OneTimeLink({
  link,
  businessName,
  onDone,
}: {
  link: string;
  businessName: string;
  onDone: () => void;
}) {
  const id = useId();
  const [copied, setCopied] = useState<boolean | null>(null);
  const url = new URL(link, window.location.origin).toString();
  const message = `${businessName} invites you to receive tips there on TipMe. Open this link to join: ${url}`;
  return (
    <div
      className="business-people__link"
      aria-labelledby={`${id}-title`}
      role="group"
    >
      <p id={`${id}-title`} className="business-people__link-title">
        Your invitation link
      </p>
      <InputField id={`${id}-url`} label="Link" value={url} readOnly />
      <p className="tm-hint">
        This link works once, for 7 days. Anyone who opens it can join, so send
        it only to them.
      </p>
      <div className="business-people__actions">
        <Button
          onClick={() =>
            void navigator.clipboard
              ?.writeText(url)
              .then(() => setCopied(true))
              .catch(() => setCopied(false))
          }
        >
          Copy link
        </Button>
        <a
          className="tm-button tm-button--secondary"
          data-material="raised"
          href={`https://wa.me/?text=${encodeURIComponent(message)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Share on WhatsApp
        </a>
        <Button variant="quiet" onClick={onDone}>
          Done
        </Button>
      </div>
      {copied === true && <StateLine tone="status">Copied.</StateLine>}
      {copied === false && (
        <StateLine tone="error">
          We couldn’t copy it. Select the link and copy it yourself.
        </StateLine>
      )}
    </div>
  );
}

function InviteForm({
  business,
  onInvited,
}: {
  business: BusinessDetail;
  onInvited: () => void;
}) {
  const id = useId();
  const owner = business.you.role === 'owner';
  const open = business.locations.filter((location) => !location.closed);
  const [as, setAs] = useState<As>('staff');
  const [locationId, setLocationId] = useState(
    business.you.locationId ?? open[0]?.id ?? '',
  );
  const [channel, setChannel] = useState<Channel>('email');
  const [email, setEmail] = useState('');
  const [query, setQuery] = useState('');
  // Kept with the query it answers, so a stale answer never shows under a newer query.
  const [answer, setAnswer] = useState<{
    q: string;
    cards: InviteeCard[];
  } | null>(null);
  const searched = query.trim().replace(/^@/, '');
  const found =
    answer && answer.q === searched && searched.length >= 2
      ? answer.cards
      : null;
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{
    field?: 'email' | 'user';
    words: string;
  } | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  // A short pause after typing, so a search doesn't run on every key.
  useEffect(() => {
    if (channel !== 'user') return;
    if (searched.length < 2) return;
    const timer = setTimeout(() => {
      void searchInvitees(business.id, searched).then((result) =>
        setAnswer({ q: searched, cards: result.ok ? result.data : [] }),
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [business.id, channel, searched]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSent(null);
    const target =
      channel === 'email'
        ? { kind: 'email' as const, email: email.trim() }
        : channel === 'user'
          ? { kind: 'user' as const, handle: chosen ?? '' }
          : { kind: 'link' as const };
    if (
      target.kind === 'email' &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target.email)
    ) {
      setError({ field: 'email', words: 'Enter an email address.' });
      return;
    }
    if (target.kind === 'user' && !chosen) {
      setError({ field: 'user', words: 'Choose who to invite from the list.' });
      return;
    }
    const request: InvitationRequest =
      as === 'staff'
        ? { kind: 'staff', locationId, target }
        : as === 'owner'
          ? { kind: 'manager', role: 'owner', target }
          : { kind: 'manager', role: 'location_manager', locationId, target };
    setBusy(true);
    const result = await invite(business.id, request);
    setBusy(false);
    if (!result.ok) {
      setError({
        ...(target.kind === 'email' && result.code === 'VALIDATION_FAILED'
          ? { field: 'email' as const }
          : target.kind === 'user'
            ? { field: 'user' as const }
            : {}),
        words:
          ERROR_WORDS[result.code] ??
          (result.code === 'VALIDATION_FAILED' && target.kind === 'email'
            ? 'Enter an email address.'
            : 'We couldn’t send that. Please try again.'),
      });
      return;
    }
    onInvited();
    if (result.data.link) setLink(result.data.link);
    else {
      setSent(
        target.kind === 'email'
          ? `Invitation sent to ${target.email}.`
          : `Invitation sent to @${target.handle}. They’ll see it on their Work page.`,
      );
      setEmail('');
      setQuery('');
      setChosen(null);
      setAnswer(null);
    }
  };

  if (link)
    return (
      <OneTimeLink
        link={link}
        businessName={business.name}
        onDone={() => setLink(null)}
      />
    );
  return (
    <form className="business-people__invite" onSubmit={submit} noValidate>
      {owner && (
        <fieldset className="business-people__choice">
          <legend>Invite them as</legend>
          {(['staff', 'location_manager', 'owner'] as const).map((value) => (
            <label key={value} className="tip-remember">
              <input
                type="radio"
                name={`${id}-as`}
                value={value}
                checked={as === value}
                onChange={() => setAs(value)}
              />
              <span>{AS_WORDS[value]}</span>
            </label>
          ))}
        </fieldset>
      )}
      {as !== 'owner' && (
        <div className="tm-field">
          <label htmlFor={`${id}-location`}>Location</label>
          <select
            id={`${id}-location`}
            className="tm-input"
            value={locationId}
            disabled={!owner}
            onChange={(event) => setLocationId(event.target.value)}
          >
            {open.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <fieldset className="business-people__choice">
        <legend>How should we reach them?</legend>
        {(
          [
            ['email', 'Email'],
            ['link', 'Link'],
            ['user', 'TipMe username'],
          ] as const
        ).map(([value, words]) => (
          <label key={value} className="tip-remember">
            <input
              type="radio"
              name={`${id}-channel`}
              value={value}
              checked={channel === value}
              onChange={() => {
                setChannel(value);
                setError(null);
                setSent(null);
              }}
            />
            <span>{words}</span>
          </label>
        ))}
      </fieldset>
      {channel === 'email' && (
        <InputField
          id={`${id}-email`}
          label="Their email address"
          type="email"
          autoComplete="off"
          value={email}
          error={error?.field === 'email' ? error.words : undefined}
          onChange={(event) => setEmail(event.target.value)}
        />
      )}
      {channel === 'link' && (
        <p className="tm-hint">
          You’ll get a link to send them yourself, by WhatsApp or a message.
        </p>
      )}
      {channel === 'user' && (
        <div className="business-people__search">
          <InputField
            id={`${id}-user`}
            label="Their TipMe username"
            hint="Only live TipMe pages show. We never show anyone’s phone or email."
            autoComplete="off"
            value={query}
            error={error?.field === 'user' ? error.words : undefined}
            onChange={(event) => {
              setQuery(event.target.value);
              setChosen(null);
            }}
          />
          {found && found.length === 0 && (
            <StateLine tone="status">
              No live TipMe page has that username.
            </StateLine>
          )}
          {found && found.length > 0 && (
            <ul
              className="business-people__found"
              aria-label="TipMe pages found"
            >
              {found.map((card) => (
                <li key={card.handle}>
                  <button
                    type="button"
                    className="business-people__card"
                    aria-pressed={chosen === card.handle}
                    onClick={() => setChosen(card.handle)}
                  >
                    <span className="business-people__photo" aria-hidden="true">
                      {hasAvatar(card.avatarPath) ? (
                        <AvatarImage
                          src={card.avatarPath}
                          name={card.displayName}
                          width={40}
                          height={40}
                          sizes="40px"
                        />
                      ) : (
                        <span className="avatar--initials">
                          {Array.from(card.displayName)[0]?.toUpperCase()}
                        </span>
                      )}
                    </span>
                    <span>
                      <strong>{card.displayName}</strong>
                      <span className="tm-hint">@{card.handle}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="business-people__actions">
        <Button type="submit" disabled={busy}>
          {channel === 'link' ? 'Make a link' : 'Send invitation'}
        </Button>
      </div>
      {error && !error.field && (
        <StateLine tone="error">{error.words}</StateLine>
      )}
      {sent && <StateLine tone="status">{sent}</StateLine>}
    </form>
  );
}

function invitationWho(row: InvitationRow): string {
  if (row.target === 'email') return row.email ?? 'Email';
  if (row.target === 'user')
    return row.handle ? `@${row.handle}` : 'A TipMe page';
  return 'One-time link';
}

/** The People section's card, drawn per business by the Business page. */
export function PeopleCard({ business }: { business: BusinessDetail }) {
  const [members, setMembers] = useState<MemberRow[] | null | undefined>(
    undefined,
  );
  const [invitations, setInvitations] = useState<InvitationRow[] | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [said, setSaid] = useState<{
    tone: 'status' | 'error';
    words: string;
  } | null>(null);

  const reload = useCallback(() => {
    void loadMembers(business.id).then((result) =>
      setMembers(result.ok ? result.data : null),
    );
    void loadInvitations(business.id).then((result) =>
      setInvitations(result.ok ? result.data : null),
    );
  }, [business.id]);
  useEffect(reload, [reload]);
  useBusinessLive(reload);

  const locationName = (locationId?: string) =>
    business.locations.find((location) => location.id === locationId)?.name ??
    '';
  const open = (invitations ?? []).filter((row) => row.state === 'open');

  const remove = async (member: MemberRow) => {
    const result = await removeMember(business.id, member.memberId);
    setConfirm(null);
    setSaid(
      result.ok || result.status === 404
        ? {
            tone: 'status',
            words: `${member.shownName} is no longer on the team.`,
          }
        : {
            tone: 'error',
            words: 'We couldn’t do that just now. Please try again.',
          },
    );
    reload();
  };
  const revoke = async (row: InvitationRow) => {
    const result = await revokeInvitation(business.id, row.id);
    setSaid(
      result.ok
        ? { tone: 'status', words: 'Invitation withdrawn.' }
        : { tone: 'error', words: 'That invitation was already answered.' },
    );
    reload();
  };

  return (
    <div className="business-people">
      {said && <StateLine tone={said.tone}>{said.words}</StateLine>}
      <h3>Team</h3>
      {members === undefined ? (
        <p className="tm-hint">Loading the team…</p>
      ) : members === null ? (
        <StateLine tone="error">We couldn’t load the team just now.</StateLine>
      ) : members.length === 0 ? (
        <p className="tm-hint">
          Nobody has joined yet. Invite your team below.
        </p>
      ) : (
        <ul className="business-people__list">
          {members.map((member) => (
            <li key={member.memberId}>
              <span className="business-people__who">
                <strong>{member.shownName}</strong>
                <span className="tm-hint">
                  @{member.profileHandle} · {locationName(member.locationId)}
                  {member.onShift ? ' · On shift' : ''}
                </span>
              </span>
              {confirm === member.memberId ? (
                <span
                  className="business-people__actions"
                  role="group"
                  aria-label={`Remove ${member.shownName}?`}
                >
                  <span>
                    They stop showing straight away. Their tips stay theirs.
                  </span>
                  <Button onClick={() => void remove(member)}>
                    Yes, remove {member.shownName}
                  </Button>
                  <Button variant="secondary" onClick={() => setConfirm(null)}>
                    Keep
                  </Button>
                </span>
              ) : (
                <Button
                  variant="quiet"
                  onClick={() => setConfirm(member.memberId)}
                >
                  Remove {member.shownName}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {open.length > 0 && (
        <>
          <h3>Waiting to answer</h3>
          <ul className="business-people__list">
            {open.map((row) => (
              <li key={row.id}>
                <span className="business-people__who">
                  <strong>{invitationWho(row)}</strong>
                  <span className="tm-hint">
                    {row.kind === 'staff'
                      ? 'Team member'
                      : AS_WORDS[row.role ?? 'owner']}
                    {row.locationId ? ` · ${locationName(row.locationId)}` : ''}{' '}
                    · until {dateOf(row.expiresAt)}
                  </span>
                </span>
                <Button variant="quiet" onClick={() => void revoke(row)}>
                  Withdraw invitation for {invitationWho(row)}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>Invite someone</h3>
      <p className="tm-hint">
        They join with their own TipMe account, and their tips go to their own
        balance.
      </p>
      <InviteForm business={business} onInvited={reload} />
    </div>
  );
}
