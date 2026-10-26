import { useId } from 'react';
import { Card } from '@tipme/ui';

// Hand-made SVG charts for the admin area (no chart library). Every chart is a <figure> named
// by its caption, with the numbers repeated in a visually hidden table for screen readers.

type Row = { label: string; value: number };

function DataTable({ rows, unit }: { rows: Row[]; unit: string }) {
  return (
    <table className="sr-only">
      <thead>
        <tr>
          <th scope="col">Item</th>
          <th scope="col">{unit}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <th scope="row">{row.label}</th>
            <td>{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Tile({
  label,
  value,
  previous,
}: {
  label: string;
  value: string;
  previous?: string;
}) {
  return (
    <Card className="ops-tile">
      <p className="ops-tile__label">{label}</p>
      <p className="ops-tile__value">{value}</p>
      {previous && <p className="tm-hint">{previous}</p>}
    </Card>
  );
}

/**
 * Horizontal bars, each labelled with its value. Labels are HTML beside a stretched bar (as in
 * the funnel): text inside a stretched SVG would stretch with it.
 */
export function BarChart({
  title,
  rows,
  unit,
}: {
  title: string;
  rows: Row[];
  unit: string;
}) {
  const id = useId();
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <figure className="ops-chart" aria-labelledby={`${id}-caption`}>
      <figcaption id={`${id}-caption`}>{title}</figcaption>
      {rows.length === 0 ? (
        <p className="tm-hint">Nothing recorded yet.</p>
      ) : (
        <ul className="ops-funnel" aria-hidden="true">
          {rows.map((row) => (
            <li key={row.label}>
              <span className="ops-funnel__label">{row.label}</span>
              <svg
                viewBox="0 0 200 14"
                width="100%"
                height="14"
                preserveAspectRatio="none"
              >
                <rect
                  width={Math.max(2, (row.value / max) * 200)}
                  height="14"
                  rx="4"
                  className="ops-chart__bar"
                />
              </svg>
              <span className="ops-funnel__value">{row.value}</span>
            </li>
          ))}
        </ul>
      )}
      <DataTable rows={rows} unit={unit} />
    </figure>
  );
}

/** One line over time; the axis labels sit in HTML so they stay at reading size at any width. */
export function LineChart({
  title,
  points,
  unit,
}: {
  title: string;
  points: Row[];
  unit: string;
}) {
  const id = useId();
  const max = Math.max(1, ...points.map((p) => p.value));
  const step = points.length > 1 ? 300 / (points.length - 1) : 0;
  const path = points
    .map((p, i) => `${i * step},${100 - (p.value / max) * 95}`)
    .join(' ');
  return (
    <figure className="ops-chart" aria-labelledby={`${id}-caption`}>
      <figcaption id={`${id}-caption`}>{title}</figcaption>
      {points.length > 0 && (
        <p className="ops-chart__max" aria-hidden="true">
          Peak {max}
        </p>
      )}
      <svg
        className="ops-chart__plot"
        viewBox="0 0 300 100"
        width="100%"
        height="160"
        aria-hidden="true"
        preserveAspectRatio="none"
      >
        <line x1="0" y1="100" x2="300" y2="100" className="ops-chart__axis" />
        <polyline points={path} className="ops-chart__line" />
      </svg>
      {points.length > 0 && (
        <div className="ops-chart__axis-labels" aria-hidden="true">
          <span>{points[0]!.label}</span>
          <span>{points.at(-1)!.label}</span>
        </div>
      )}
      <DataTable rows={points} unit={unit} />
    </figure>
  );
}

/** Each step as a bar, with how many carried on from the step before. */
export function Funnel({ title, steps }: { title: string; steps: Row[] }) {
  const id = useId();
  const max = Math.max(1, steps[0]?.value ?? 0);
  return (
    <figure className="ops-chart" aria-labelledby={`${id}-caption`}>
      <figcaption id={`${id}-caption`}>{title}</figcaption>
      <ol className="ops-funnel">
        {steps.map((step, index) => {
          const before = steps[index - 1]?.value;
          const share =
            before && before > 0
              ? `${Math.round((step.value / before) * 100)}% of the step before`
              : '';
          return (
            <li key={step.label}>
              <span className="ops-funnel__label">{step.label}</span>
              <svg
                viewBox="0 0 200 14"
                width="100%"
                height="14"
                aria-hidden="true"
                preserveAspectRatio="none"
              >
                <rect
                  width={Math.max(2, (step.value / max) * 200)}
                  height="14"
                  rx="4"
                  className="ops-chart__bar"
                />
              </svg>
              <span className="ops-funnel__value">
                {step.value}
                {share && <span className="tm-hint"> · {share}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </figure>
  );
}
