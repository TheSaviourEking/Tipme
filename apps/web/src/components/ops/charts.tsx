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

/** Horizontal bars, each labelled with its value. */
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
  const height = rows.length * 32;
  return (
    <figure className="ops-chart" aria-labelledby={`${id}-caption`}>
      <figcaption id={`${id}-caption`}>{title}</figcaption>
      {rows.length === 0 ? (
        <p className="tm-hint">Nothing recorded yet.</p>
      ) : (
        <svg
          viewBox={`0 0 320 ${height}`}
          width="100%"
          height={height}
          aria-hidden="true"
          preserveAspectRatio="none"
        >
          {rows.map((row, index) => (
            <g key={row.label} transform={`translate(0 ${index * 32})`}>
              <text x="0" y="18" className="ops-chart__label">
                {row.label}
              </text>
              <rect
                x="110"
                y="6"
                height="18"
                rx="4"
                width={Math.max(2, (row.value / max) * 170)}
                className="ops-chart__bar"
              />
              <text
                x={116 + Math.max(2, (row.value / max) * 170)}
                y="19"
                className="ops-chart__value"
              >
                {row.value}
              </text>
            </g>
          ))}
        </svg>
      )}
      <DataTable rows={rows} unit={unit} />
    </figure>
  );
}

/** One line over time, with the first and last labels on the axis. */
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
    .map((p, i) => `${10 + i * step},${110 - (p.value / max) * 95}`)
    .join(' ');
  return (
    <figure className="ops-chart" aria-labelledby={`${id}-caption`}>
      <figcaption id={`${id}-caption`}>{title}</figcaption>
      <svg viewBox="0 0 320 130" width="100%" aria-hidden="true">
        <line x1="10" y1="110" x2="310" y2="110" className="ops-chart__axis" />
        <polyline points={path} className="ops-chart__line" />
        {points.length > 0 && (
          <>
            <text x="10" y="126" className="ops-chart__label">
              {points[0]!.label}
            </text>
            <text x="310" y="126" textAnchor="end" className="ops-chart__label">
              {points.at(-1)!.label}
            </text>
            <text x="10" y="12" className="ops-chart__label">
              max {max}
            </text>
          </>
        )}
      </svg>
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
