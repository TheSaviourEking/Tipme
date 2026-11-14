'use client';
import Link from 'next/link';
import { useState } from 'react';
import type {
  EarningsPeriod,
  EarningsPeriodView,
  EarningsSummary,
  EarningsTrend,
} from '@tipme/contracts';
import { Button, Card, Notice, Skeleton } from '@tipme/ui';
import { useRecipient } from '@/components/account/recipient-context';
import { BarChart, type Bar } from '@/components/dashboard/bar-chart';
import { usePanel } from '@/components/dashboard/use-panel';
import { naira } from '@/lib/money';
import { apiDownload } from '@/lib/session-client';
import { dayRange, monthNameOf } from '@/lib/month-share';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];
const SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const dayMonth = (date: string) =>
  `${Number(date.slice(8, 10))} ${SHORT[Number(date.slice(5, 7)) - 1] ?? ''}`;
const tipsWord = (n: number) => `${n} ${n === 1 ? 'tip' : 'tips'}`;
const shift = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

/** "up from ₦19,800 last week", "down from …", "the same as …", or nothing to compare. */
function versus(current: string, previous: string, when: string) {
  const now = BigInt(current);
  const before = BigInt(previous);
  if (now === before)
    return before === BigInt(0) ? null : `the same as ${when}`;
  return `${now > before ? 'up' : 'down'} from ${naira(previous)} ${when}`;
}

function Summary({ summary, pro }: { summary: EarningsSummary; pro: boolean }) {
  const monthLabel =
    summary.thisMonth.from === summary.today
      ? `This month, ${dayMonth(summary.today)}`
      : `This month, ${dayRange(summary.thisMonth.from, summary.today)}`;
  const week = versus(
    summary.thisWeek.netMinor,
    summary.thisWeek.previous.netMinor,
    'last week',
  );
  const month = versus(
    summary.thisMonth.netMinor,
    summary.thisMonth.previous.netMinor,
    'the same days last month',
  );
  const joinedThisYear =
    summary.joinedOn.slice(0, 4) === summary.today.slice(0, 4);
  return (
    <section aria-labelledby="earnings-totals" className="earnings-totals">
      <h2 id="earnings-totals" className="sr-only">
        Your totals
      </h2>
      <div className="earnings-total">
        <span>This week</span>
        <strong>{naira(summary.thisWeek.netMinor)}</strong>
        <span className="tm-hint">
          {tipsWord(summary.thisWeek.tips)}
          {week ? ` · ${week}` : ''}
        </span>
      </div>
      <div className="earnings-total">
        <span>{monthLabel}</span>
        <strong>{naira(summary.thisMonth.netMinor)}</strong>
        <span className="tm-hint">
          {tipsWord(summary.thisMonth.tips)}
          {pro && month ? ` · ${month}` : ''}
        </span>
      </div>
      {pro ? (
        <div className="earnings-total">
          <span>This year</span>
          <strong>{naira(summary.thisYear.netMinor)}</strong>
          <span className="tm-hint">
            {tipsWord(summary.thisYear.tips)}
            {joinedThisYear
              ? ` · since you joined in ${monthNameOf(summary.joinedOn.slice(0, 7)).split(' ')[0]}`
              : ''}
          </span>
        </div>
      ) : (
        <div className="earnings-total">
          <span>All time</span>
          <strong>{naira(summary.allTime.netMinor)}</strong>
          <span className="tm-hint">{tipsWord(summary.allTime.tips)}</span>
        </div>
      )}
    </section>
  );
}

function Trend() {
  const [unit, setUnit] = useState<'week' | 'month'>('week');
  const trend = usePanel<EarningsTrend>(`/v1/me/earnings/trend?unit=${unit}`, {
    live: ['tips.changed'],
  });
  const bars: Bar[] =
    trend.data?.points.map((point, index, all) => ({
      key: point.from,
      // Every fourth week (or third month) is labelled, and the current one.
      label:
        index === all.length - 1
          ? unit === 'week'
            ? 'This week'
            : 'This month'
          : index % (unit === 'week' ? 4 : 3) === 0
            ? unit === 'week'
              ? dayMonth(point.from)
              : (SHORT[Number(point.from.slice(5, 7)) - 1] ?? '')
            : '',
      name:
        unit === 'week'
          ? `Week of ${dayMonth(point.from)}${point.complete ? '' : ' (so far)'}`
          : `${monthNameOf(point.from.slice(0, 7))}${point.complete ? '' : ' (so far)'}`,
      value: Number(point.netMinor),
      text: `${naira(point.netMinor)} · ${tipsWord(point.tips)}`,
      open: !point.complete,
    })) ?? [];
  return (
    <Card className="earnings-trend">
      <div className="earnings-head">
        <h2 id="earnings-trend">
          {unit === 'week' ? 'Week by week' : 'Month by month'}
        </h2>
        <div
          className="earnings-switch"
          role="group"
          aria-labelledby="earnings-trend"
        >
          {(['week', 'month'] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={unit === value}
              onClick={() => setUnit(value)}
            >
              {value === 'week' ? '12 weeks' : '12 months'}
            </button>
          ))}
        </div>
      </div>
      {trend.data ? (
        <BarChart
          bars={bars}
          caption={`What you received each ${unit}, the last 12 ${unit}s`}
        />
      ) : trend.error === 'load' ? (
        <p className="tm-hint">We couldn’t load the chart. Please reload.</p>
      ) : (
        <Skeleton label="Loading the chart" />
      )}
    </Card>
  );
}

function periodTitle(view: EarningsPeriodView) {
  if (view.period === 'month') return monthNameOf(view.from.slice(0, 7));
  if (view.period === 'year') return view.from.slice(0, 4);
  return `Week of ${dayMonth(view.from)}`;
}
function previousWords(view: EarningsPeriodView) {
  if (!view.complete) return 'the same days before';
  if (view.period === 'month')
    return monthNameOf(view.previous.from.slice(0, 7)).split(' ')[0] ?? '';
  if (view.period === 'year') return view.previous.from.slice(0, 4);
  return 'the week before';
}

function Period() {
  const [period, setPeriod] = useState<EarningsPeriod>('month');
  const [at, setAt] = useState<string | null>(null);
  const panel = usePanel<EarningsPeriodView>(
    `/v1/me/earnings/period?period=${period}${at ? `&at=${at}` : ''}`,
    { live: ['tips.changed'] },
  );
  const view = panel.data;
  const step = (direction: -1 | 1) => {
    if (!view) return;
    setAt(direction < 0 ? shift(view.from, -1) : shift(view.to, 1));
  };
  const change =
    view && view.changePct !== null
      ? `${view.changePct >= 0 ? 'Up' : 'Down'} ${Math.abs(view.changePct)}% on ${previousWords(view)} (${naira(view.previous.netMinor)})`
      : view && view.previous.tips === 0
        ? `Nothing on ${previousWords(view)}`
        : null;
  return (
    <Card className="earnings-period">
      <div className="earnings-head">
        <h2 id="earnings-period" aria-live="polite">
          {view ? periodTitle(view) : 'Loading'}
        </h2>
        <div className="earnings-step">
          <button
            type="button"
            aria-label="Earlier"
            disabled={!view?.hasEarlier}
            onClick={() => step(-1)}
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="Later"
            disabled={!view || !view.complete}
            onClick={() => step(1)}
          >
            ›
          </button>
        </div>
      </div>
      <div
        className="earnings-switch"
        role="group"
        aria-label="Show a week, month or year"
      >
        {(['week', 'month', 'year'] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={period === value}
            onClick={() => {
              setPeriod(value);
              setAt(null);
            }}
          >
            {value === 'week' ? 'Week' : value === 'month' ? 'Month' : 'Year'}
          </button>
        ))}
      </div>
      {!view ? (
        panel.error === 'load' ? (
          <p className="tm-hint">
            We couldn’t load this period. Please reload.
          </p>
        ) : (
          <Skeleton label="Loading the period" />
        )
      ) : (
        <>
          <dl className="earnings-tiles">
            <div>
              <dt>Received</dt>
              <dd>{naira(view.netMinor)}</dd>
              {change && <dd className="tm-hint">{change}</dd>}
            </div>
            <div>
              <dt>Tips</dt>
              <dd>{view.tips}</dd>
              <dd className="tm-hint">
                {view.previous.tips} on {previousWords(view)}
              </dd>
            </div>
            <div>
              <dt>Average tip</dt>
              <dd>{view.averageMinor ? naira(view.averageMinor) : '—'}</dd>
              {view.previous.averageMinor && (
                <dd className="tm-hint">
                  {naira(view.previous.averageMinor)} on {previousWords(view)}
                </dd>
              )}
            </div>
            <div>
              <dt>Best day of the week</dt>
              <dd>
                {view.bestDay
                  ? DAY_NAMES[view.bestDay.weekday]
                  : 'Not enough tips yet'}
              </dd>
              {view.bestDay && (
                <dd className="tm-hint">
                  {view.bestDay.tips} of {view.tips} tips
                </dd>
              )}
            </div>
          </dl>
          <h3 className="earnings-sub">Tips by day of the week</h3>
          <BarChart
            caption={`Tips by day of the week, ${periodTitle(view)}`}
            bars={view.byWeekday.map((tips, day) => ({
              key: String(day),
              label: DAYS[day] ?? '',
              name: DAY_NAMES[day] ?? '',
              value: tips,
              text: tipsWord(tips),
            }))}
            {...(view.bestDay
              ? { highlight: String(view.bestDay.weekday) }
              : {})}
          />
          <section className="earnings-notes" aria-labelledby="earnings-notes">
            <h3 id="earnings-notes">In {periodTitle(view)}</h3>
            <p className="tm-hint">Plain facts from your tips.</p>
            {view.notes.length > 0 ? (
              <ul>
                {view.notes.map((note) => (
                  <li key={note}>
                    {note}
                    {note.includes('more than once') && (
                      <span className="tm-hint">
                        {' '}
                        Counts only supporters who chose to be recognised.
                        Others aren’t counted, so the real number may be higher.
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p>Notes show once there are at least 10 tips in the period.</p>
            )}
          </section>
          {view.period === 'month' && view.complete && (
            <Link
              className="tm-button tm-button--secondary"
              href={`/dashboard/reports/month/${view.from.slice(0, 7)}`}
            >
              See your {periodTitle(view).split(' ')[0]} recap
            </Link>
          )}
        </>
      )}
    </Card>
  );
}

/** The Free view's preview: an example picture, never the person's own numbers. */
function Preview() {
  const example = [3, 5, 4, 6, 5, 7, 6, 8, 7, 9, 8, 10];
  return (
    <Card className="earnings-preview">
      <div className="earnings-preview__art" aria-hidden="true">
        <span className="earnings-preview__tag">Example</span>
        <div className="earnings-preview__bars">
          {example.map((value, index) => (
            <span key={index} style={{ height: `${value * 10}%` }} />
          ))}
        </div>
      </div>
      <div>
        <h2>See how your appreciation grows</h2>
        <p>
          With TipMe Pro: 12 weeks or 12 months at a glance, your average tip,
          your best day, the change on last month, and plain notes like “Most of
          your tips came on Saturdays.”
        </p>
        <Link className="tm-button tm-button--continue" href="/pro">
          See TipMe Pro
        </Link>
      </div>
    </Card>
  );
}

export default function EarningsPage() {
  const { profile } = useRecipient();
  const pro = profile.plan === 'pro';
  const [download, setDownload] = useState('');
  const summary = usePanel<EarningsSummary>('/v1/me/earnings', {
    live: ['tips.changed'],
  });
  if (summary.error === 'load' && !summary.data)
    return (
      <Notice tone="error" title="We couldn’t load your earnings">
        Please reload the page.
      </Notice>
    );
  return (
    <div className="dashboard-section earnings">
      <header className="earnings-header">
        <h1>Earnings</h1>
        <Button
          variant="secondary"
          onClick={async () => {
            setDownload('Preparing your file…');
            const day = new Date().toISOString().slice(0, 10);
            const result = await apiDownload(
              '/v1/me/exports/tips.csv',
              `tipme-tips-${day}.csv`,
            );
            setDownload(
              result.ok
                ? 'Downloaded.'
                : 'We couldn’t prepare the file. Please try again.',
            );
          }}
        >
          Download as CSV
        </Button>
      </header>
      <p role="status" className="tm-hint">
        {download}
      </p>
      <p className="tm-hint">
        What you received from confirmed tips, after TipMe’s 10%. Days and weeks
        are in Lagos time; weeks start on Monday.
      </p>
      {summary.data ? (
        <Summary summary={summary.data} pro={pro} />
      ) : (
        <Skeleton label="Loading your earnings" />
      )}
      {pro ? (
        <>
          <Trend />
          <Period />
        </>
      ) : (
        <Preview />
      )}
    </div>
  );
}
