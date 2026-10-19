'use client';
import { useEffect, useId, useState, type FormEvent } from 'react';
import type { MarketCategory, MarketEntry } from '@tipme/contracts';
import {
  Button,
  Card,
  EmptyState,
  InputField,
  Notice,
  Skeleton,
  TextareaField,
} from '@tipme/ui';
import { LineChart } from '@/components/ops/charts';
import { can, useOpsAccess } from '@/lib/ops-client';
import { apiFetch } from '@/lib/session-client';

const CATEGORIES: Record<MarketCategory, string> = {
  competitor: 'Competitor',
  social: 'Social mention',
  app_store: 'App store',
  press: 'Press',
  other: 'Other',
};
type Point = { observedOn: string; value: number };
const seriesKey = (e: { name: string; metric: string }) =>
  `${e.name} · ${e.metric}`;

function AddObservation({ onSaved }: { onSaved: () => void }) {
  const id = useId();
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = (key: string) => String(data.get(key) ?? '').trim();
    const value = text('value');
    setBusy(true);
    setError('');
    setSaved('');
    const result = await apiFetch<MarketEntry>('/v1/ops/market', {
      method: 'POST',
      body: {
        observedOn: text('observedOn'),
        category: text('category'),
        name: text('name'),
        metric: text('metric'),
        sourceUrl: text('sourceUrl'),
        ...(value ? { value: Number(value.replace(/,/g, '')) } : {}),
        ...(text('text') ? { text: text('text') } : {}),
        ...(text('note') ? { note: text('note') } : {}),
      },
    });
    setBusy(false);
    if (!result.ok) {
      setError(
        result.code === 'VALIDATION_FAILED'
          ? 'Please check the fields: a past date, a name, what was measured, and an https source link.'
          : 'That didn’t save. Please try again.',
      );
      return;
    }
    setSaved('Observation saved.');
    form.reset();
    onSaved();
  };
  return (
    <Card className="settings-section">
      <h2>Add an observation</h2>
      <form className="settings-form" onSubmit={(e) => void submit(e)}>
        <InputField
          id={`${id}-date`}
          name="observedOn"
          type="date"
          label="Date observed"
          required
        />
        <div className="tm-field">
          <label htmlFor={`${id}-category`}>Category</label>
          <select
            id={`${id}-category`}
            name="category"
            className="tm-input"
            defaultValue="competitor"
          >
            {Object.entries(CATEGORIES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <InputField
          id={`${id}-name`}
          name="name"
          label="Name"
          hint="The competitor, account, app or publication."
          maxLength={80}
          required
        />
        <InputField
          id={`${id}-metric`}
          name="metric"
          label="What was measured"
          hint="For example “Fee %”, “Followers”, “Rating”."
          maxLength={60}
          required
        />
        <InputField
          id={`${id}-value`}
          name="value"
          label="Value (optional)"
          inputMode="decimal"
          maxLength={20}
        />
        <TextareaField
          id={`${id}-text`}
          name="text"
          label="Details (optional)"
          maxLength={500}
        />
        <InputField
          id={`${id}-source`}
          name="sourceUrl"
          type="url"
          label="Source link"
          hint="Must start with https://"
          maxLength={500}
          required
        />
        <TextareaField
          id={`${id}-note`}
          name="note"
          label="Note (optional)"
          maxLength={500}
        />
        {error && (
          <Notice tone="error" title="Not saved">
            {error}
          </Notice>
        )}
        {saved && (
          <p role="status" className="settings-saved">
            {saved}
          </p>
        )}
        <Button type="submit" disabled={busy} aria-busy={busy}>
          Save observation
        </Button>
      </form>
    </Card>
  );
}

/** Outside visibility recorded by hand: competitors, mentions, ratings (feeds come later). */
export default function MarketPage() {
  const id = useId();
  const access = useOpsAccess();
  const [entries, setEntries] = useState<MarketEntry[] | null>(null);
  const [chosen, setChosen] = useState('');
  const [series, setSeries] = useState<Point[]>([]);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    void apiFetch<MarketEntry[]>('/v1/ops/market').then((result) =>
      setEntries(result.ok ? result.data : []),
    );
  }, [version]);

  const options = [
    ...new Map(
      (entries ?? [])
        .filter((e) => e.value !== null)
        .map((e) => [seriesKey(e), e] as const),
    ).values(),
  ];
  const current = options.find((e) => seriesKey(e) === chosen) ?? options[0];

  const seriesName = current?.name;
  const seriesMetric = current?.metric;
  useEffect(() => {
    if (!seriesName || !seriesMetric) return;
    const params = new URLSearchParams({
      name: seriesName,
      metric: seriesMetric,
    });
    void apiFetch<Point[]>(`/v1/ops/market/series?${params.toString()}`).then(
      (result) => setSeries(result.ok ? result.data : []),
    );
  }, [seriesName, seriesMetric, version]);

  const archive = async (entryId: string) => {
    await apiFetch(`/v1/ops/market/${entryId}/archive`, {
      method: 'POST',
      body: {},
    });
    setVersion((v) => v + 1);
  };

  return (
    <div className="ops-dashboard">
      <h1>Market</h1>
      <p className="tm-hint">
        Outside observations recorded by hand, each with its source. Automatic
        feeds (social listening, search, app stores) come later.
      </p>
      {can(access, 'market.edit') && (
        <AddObservation onSaved={() => setVersion((v) => v + 1)} />
      )}
      {!entries && <Skeleton label="Loading observations" />}
      {entries?.length === 0 && (
        <EmptyState title="No observations yet">
          Add the first one above, for example a competitor’s fee.
        </EmptyState>
      )}
      {current && (
        <Card className="settings-section">
          <div className="tm-field">
            <label htmlFor={`${id}-series`}>Chart</label>
            <select
              id={`${id}-series`}
              className="tm-input"
              value={seriesKey(current)}
              onChange={(e) => setChosen(e.target.value)}
            >
              {options.map((e) => (
                <option key={seriesKey(e)} value={seriesKey(e)}>
                  {seriesKey(e)}
                </option>
              ))}
            </select>
          </div>
          <LineChart
            title={`${seriesKey(current)} over time`}
            unit={current.metric}
            points={series.map((p) => ({
              label: p.observedOn,
              value: p.value,
            }))}
          />
        </Card>
      )}
      {entries && entries.length > 0 && (
        <Card className="settings-section">
          <h2>All observations</h2>
          <div
            className="ops-table-wrap"
            role="region"
            aria-label="Observations"
            tabIndex={0}
          >
            <table className="ops-table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Category</th>
                  <th scope="col">Name</th>
                  <th scope="col">Measured</th>
                  <th scope="col">Value</th>
                  <th scope="col">Source</th>
                  {can(access, 'market.edit') && (
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.observedOn}</td>
                    <td>{CATEGORIES[entry.category]}</td>
                    <td>{entry.name}</td>
                    <td>{entry.metric}</td>
                    <td>{entry.value ?? entry.text ?? '—'}</td>
                    <td>
                      <a
                        href={entry.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Source
                        <span className="sr-only"> for {entry.name}</span>
                      </a>
                    </td>
                    {can(access, 'market.edit') && (
                      <td>
                        <Button
                          variant="quiet"
                          onClick={() => void archive(entry.id)}
                        >
                          Archive
                          <span className="sr-only">
                            {' '}
                            {entry.name} {entry.observedOn}
                          </span>
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
