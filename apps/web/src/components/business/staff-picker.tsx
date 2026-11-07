'use client';
import { useId, useRef, useState, useSyncExternalStore } from 'react';
import type { BusinessPersonMatch, StaffCard } from '@tipme/contracts';
import { Button, EmptySlip, InputField, StateLine } from '@tipme/ui';
import { AvatarImage } from '@/components/avatar';
import { hasAvatar } from '@/lib/avatar-source';
import { searchPeople } from '@/lib/business/public-search';
import { lastAtBusiness } from '@/lib/recognition';

// PR B4, board section 2: pick the person who served you. A grid of first names and the photos
// people chose to show; on shift first. "I don't see them" looks across the whole business.

// The memory changes only when this browser pays a tip, never while this page is open.
const noSubscription = () => () => {};
function rememberedHandle(business: string): string | null {
  let storage: Storage | undefined;
  try {
    storage = localStorage;
  } catch {
    storage = undefined;
  }
  return lastAtBusiness(storage, business)?.handle.toLowerCase() ?? null;
}

const starts = (name: string, query: string) =>
  name.toLocaleLowerCase('en').startsWith(query.toLocaleLowerCase('en'));

function PersonFace({ person }: { person: StaffCard }) {
  if (person.avatarPath && hasAvatar(person.avatarPath))
    return (
      <AvatarImage
        className="staff-card__face"
        src={person.avatarPath}
        name={person.shownName}
        width={56}
        height={56}
        sizes="56px"
      />
    );
  return (
    <span className="staff-card__face staff-card__face--initial">
      {Array.from(person.shownName)[0]?.toUpperCase()}
    </span>
  );
}

function PersonLink({
  person,
  href,
  where,
}: {
  person: StaffCard;
  href: string;
  where?: string;
}) {
  return (
    <a className="staff-card" href={href}>
      {/* The name says who; the picture is a likeness, not a second label. */}
      <span className="staff-card__picture" aria-hidden="true">
        <PersonFace person={person} />
      </span>
      <span className="staff-card__name">{person.shownName}</span>
      {where && <span className="staff-card__where">{where}</span>}
    </a>
  );
}

type Search =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'found'; query: string; people: BusinessPersonMatch[] }
  | { kind: 'problem'; message: string };

export function StaffPicker({
  business,
  businessName,
  location,
  locationName,
  people,
  qr,
}: {
  business: string;
  businessName: string;
  location: string;
  locationName: string;
  people: StaffCard[];
  /** The page was opened from a printed code: links keep saying so. */
  qr: boolean;
}) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<Search>({ kind: 'idle' });
  const pathOf = (locationSlug: string, handle: string) =>
    `/b/${business}/${locationSlug}/${handle}${qr ? '?src=qr' : ''}`;

  // Only what this browser kept, and only with the supporter's own opt-in (M8). Read after
  // hydration (the server has no such memory), as a string so the snapshot is stable.
  const againHandle = useSyncExternalStore(
    noSubscription,
    () => rememberedHandle(business),
    () => null,
  );
  const again = againHandle
    ? (people.find((card) => card.handle.toLowerCase() === againHandle) ?? null)
    : null;

  const wanted = query.trim();
  const shown = wanted
    ? people.filter((p) => starts(p.shownName, wanted))
    : people;
  const onToday = shown.filter((person) => person.onShift);
  const others = shown.filter((person) => !person.onShift);

  const lookEverywhere = async () => {
    if (Array.from(wanted).length < 2) {
      setSearch({
        kind: 'problem',
        message: 'Type at least 2 letters of their name first.',
      });
      field.current?.focus();
      return;
    }
    setSearch({ kind: 'searching' });
    const result = await searchPeople(business, wanted);
    if (result.ok) {
      setSearch({ kind: 'found', query: wanted, people: result.people });
      return;
    }
    setSearch({
      kind: 'problem',
      message:
        result.reason === 'rate_limited'
          ? 'That was a lot of searches. Please wait a minute, then try again.'
          : result.reason === 'network'
            ? 'We couldn’t reach TipMe. Check your connection and try again.'
            : 'Something went wrong on our side. Please try again.',
    });
  };

  const grid = (cards: StaffCard[]) => (
    <ul className="staff-grid" role="list">
      {cards.map((person) => (
        <li key={person.memberId}>
          <PersonLink person={person} href={pathOf(location, person.handle)} />
        </li>
      ))}
    </ul>
  );

  return (
    <div className="staff-picker">
      {again && (
        <a
          className="staff-again"
          href={pathOf(location, again.handle)}
          data-testid="tip-again"
        >
          <span className="staff-card__picture" aria-hidden="true">
            <PersonFace person={again} />
          </span>
          <span className="staff-again__words">
            <span className="staff-again__title">
              Tip {again.shownName} again
            </span>
            <span className="staff-again__hint">
              Remembered on this phone, from your last tip here.
            </span>
          </span>
        </a>
      )}
      {people.length === 0 ? (
        <EmptySlip title="Nobody here is taking tips on TipMe yet.">
          <p>If you know their name, you can still look for them.</p>
        </EmptySlip>
      ) : null}
      <InputField
        id={`${id}-search`}
        ref={field}
        label="Search a name"
        type="search"
        autoComplete="off"
        enterKeyHint="search"
        maxLength={30}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          if (search.kind !== 'searching') setSearch({ kind: 'idle' });
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (wanted && shown.length === 0) void lookEverywhere();
          }
        }}
      />
      {onToday.length > 0 && (
        <section aria-labelledby={`${id}-today`}>
          <h2 className="staff-section__title" id={`${id}-today`}>
            On today
          </h2>
          {grid(onToday)}
        </section>
      )}
      {others.length > 0 && (
        <section aria-labelledby={`${id}-others`}>
          <h2 className="staff-section__title" id={`${id}-others`}>
            {onToday.length > 0 || people.some((p) => p.onShift)
              ? `Also at ${locationName}`
              : `At ${locationName}`}
          </h2>
          {grid(others)}
        </section>
      )}
      {people.length > 0 && wanted && shown.length === 0 && (
        <p className="staff-picker__none">
          Nobody here by that name takes tips on TipMe.
        </p>
      )}
      <div className="staff-picker__more">
        <Button
          variant="quiet"
          className="staff-picker__look"
          disabled={search.kind === 'searching'}
          onClick={() => void lookEverywhere()}
        >
          I don’t see them
        </Button>
        {search.kind === 'searching' && (
          <StateLine tone="status">Looking across {businessName}…</StateLine>
        )}
        {search.kind === 'problem' && (
          <StateLine tone="error">{search.message}</StateLine>
        )}
        {search.kind === 'found' &&
          (search.people.length === 0 ? (
            <StateLine tone="status">
              Nobody at {businessName} called “{search.query}” takes tips on
              TipMe yet.
            </StateLine>
          ) : (
            <section aria-labelledby={`${id}-found`}>
              <StateLine tone="status">
                <span id={`${id}-found`}>
                  {search.people.length === 1
                    ? `1 person at ${businessName}`
                    : `${search.people.length} people at ${businessName}`}
                </span>
              </StateLine>
              <ul className="staff-grid" role="list">
                {search.people.map((person) => (
                  <li key={person.memberId}>
                    <PersonLink
                      person={person}
                      href={pathOf(person.locationSlug, person.handle)}
                      where={
                        person.locationSlug === location
                          ? undefined
                          : `at ${person.locationName}`
                      }
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
      </div>
    </div>
  );
}
