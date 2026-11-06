'use client';
import { useEffect, useId, useState } from 'react';
import {
  BUSINESS_NOTE_TAGS,
  type BusinessDetail,
  type LocationInsights,
  type MemberWeek,
} from '@tipme/contracts';
import { Button, EmptySlip, Skeleton, StateLine } from '@tipme/ui';
import {
  busiestText,
  currentWeek,
  loadInsights,
  setInsightsView,
  shownText,
  stepWeek,
  tagLabel,
  useInsightsView,
  weekText,
} from '@/lib/business/insights-api';
import { naira } from '@/lib/money';

/** A person's tags with any mention, most first; under 3 reads "fewer than 3", never a number. */
function topTags(person: MemberWeek): string {
  const mentioned = BUSINESS_NOTE_TAGS.map((tag) => ({
    label: tag.label,
    shown: person.tags[tag.id],
  })).filter(({ shown }) => !('n' in shown) || shown.n > 0);
  if (mentioned.length === 0) return '—';
  const rank = (shown: (typeof mentioned)[number]['shown']) =>
    'n' in shown ? shown.n : 0;
  return mentioned
    .sort((a, b) => rank(b.shown) - rank(a.shown))
    .slice(0, 3)
    .map(({ label, shown }) =>
      'n' in shown ? `${label} ${shown.n}` : `${label} (fewer than 3)`,
    )
    .join(', ');
}

/**
 * This week (PR B7, board section 4): who's thanked most at one location, in groups of 3 or
 * more, with the busiest hours and the most-mentioned tag. No naira except the weekly totals of
 * people who chose to share theirs.
 */
export function ThisWeekCard({ business }: { business: BusinessDetail }) {
  const pickerId = useId();
  const view = useInsightsView();
  const open = business.locations.filter((location) => !location.closed);
  const fallback = open[0] ?? business.locations[0];
  const [loaded, setLoaded] = useState<{
    key: string;
    data: LocationInsights | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Start at this week and the first location; keep the view if it is this business's.
  useEffect(() => {
    if (!fallback) return;
    if (view?.businessId === business.id) return;
    setInsightsView({
      businessId: business.id,
      locationId: fallback.id,
      week: currentWeek(),
    });
  }, [business.id, fallback, view?.businessId]);

  const key = view ? `${view.locationId}|${view.week}|${attempt}` : '';
  useEffect(() => {
    if (!view || view.businessId !== business.id) return;
    let live = true;
    void loadInsights(business.id, view.locationId, view.week).then(
      (result) => {
        if (live) setLoaded({ key, data: result.ok ? result.data : null });
      },
    );
    return () => {
      live = false;
    };
  }, [business.id, key, view]);

  if (!fallback)
    return (
      <EmptySlip title="No locations yet.">
        <p>Add a location, and its week shows here.</p>
      </EmptySlip>
    );
  if (!view || view.businessId !== business.id) return <Skeleton />;
  const thisWeek = currentWeek();
  const location =
    business.locations.find((entry) => entry.id === view.locationId) ??
    fallback;
  const insights = loaded?.key === key ? loaded.data : undefined;
  const shares = insights?.people.some(
    (person) => person.amountMinor !== undefined,
  );

  return (
    <div className="insights">
      <div className="insights__controls">
        {business.you.role === 'owner' && business.locations.length > 1 && (
          <div className="tm-field insights__location">
            <label htmlFor={pickerId}>Location</label>
            <select
              id={pickerId}
              className="tm-input"
              value={view.locationId}
              onChange={(event) =>
                setInsightsView({ ...view, locationId: event.target.value })
              }
            >
              {business.locations.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="insights__week" role="group" aria-label="Week">
          <Button
            variant="secondary"
            onClick={() =>
              setInsightsView({ ...view, week: stepWeek(view.week, -1) })
            }
          >
            Previous week
          </Button>
          <p className="insights__week-name" aria-live="polite">
            {view.week === thisWeek ? 'This week, ' : ''}
            {weekText(view.week)}
          </p>
          <Button
            variant="secondary"
            disabled={view.week >= thisWeek}
            onClick={() =>
              setInsightsView({ ...view, week: stepWeek(view.week, 1) })
            }
          >
            Next week
          </Button>
        </div>
      </div>

      {insights === undefined ? (
        <Skeleton label="Loading the week" />
      ) : insights === null ? (
        <div className="insights__error">
          <StateLine tone="error">
            We couldn’t load this week. Please try again.
          </StateLine>
          <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </div>
      ) : 'n' in insights.tips && insights.tips.n === 0 ? (
        <EmptySlip title={`No tips at ${location.name} this week.`}>
          <p>When customers tip your team here, it shows up here.</p>
        </EmptySlip>
      ) : (
        <>
          <p className="insights__total">
            Tips at {location.name}:{' '}
            <strong data-testid="insights-total">
              {shownText(insights.tips)}
            </strong>
          </p>
          {insights.people.length > 0 && (
            <div className="insights__table-wrap">
              <table className="insights__table">
                <caption>Who’s thanked most</caption>
                <thead>
                  <tr>
                    <th scope="col">Staff</th>
                    <th scope="col">Tips</th>
                    <th scope="col">Notes</th>
                    <th scope="col">Top tags</th>
                    {shares && <th scope="col">Tip amounts</th>}
                  </tr>
                </thead>
                <tbody>
                  {insights.people.map((person) => (
                    <tr key={person.memberId}>
                      <th scope="row">{person.shownName}</th>
                      <td>{shownText(person.tips)}</td>
                      <td>{shownText(person.notes)}</td>
                      <td>{topTags(person)}</td>
                      {shares && (
                        <td>
                          {person.amountMinor !== undefined
                            ? naira(person.amountMinor)
                            : 'Not shared'}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(insights.busiest || insights.topTag) && (
            <ul className="insights__tiles">
              {insights.busiest && (
                <li>
                  <span>Busiest hours for tips</span>
                  <strong>{busiestText(insights.busiest)}</strong>
                </li>
              )}
              {insights.topTag && (
                <li>
                  <span>Most mentioned</span>
                  <strong>
                    “{tagLabel(insights.topTag.tag)}” in{' '}
                    {insights.topTag.percent}% of notes
                  </strong>
                </li>
              )}
            </ul>
          )}
        </>
      )}
      <p className="tm-hint insights__privacy">
        Built from tips and notes only. Customers’ names and contact details
        never reach you. Any number under 3 shows as “Fewer than 3”.
      </p>
    </div>
  );
}
