'use client';
import { useId, useState } from 'react';

export interface Bar {
  key: string;
  /** Under the bar (an axis label); empty to leave it out at this point. */
  label: string;
  /** The row header in the table. */
  name: string;
  value: number;
  /** What the table and the bar's tip say: "₦38,600 · 9 tips". */
  text: string;
  /** Drawn open: a period that isn't over. */
  open?: boolean;
}

/**
 * The dashboard's bar chart (the trend-chart convention, ProEarnings board): plain bars in TipMe
 * purple, one series, one axis. The bars are decoration for sighted readers; every value is in a
 * table, which screen readers always get and anyone can show with "Show as a table". Labels are
 * HTML, never text in a stretched SVG (design decision log, 25 Oct 2026).
 */
export function BarChart({
  bars,
  caption,
  highlight,
}: {
  bars: Bar[];
  caption: string;
  /** The bar to point out (a best day); others are drawn quieter. */
  highlight?: string;
}) {
  const id = useId();
  const [table, setTable] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const max = Math.max(1, ...bars.map((bar) => bar.value));
  const shown = bars.find((bar) => bar.key === picked);
  return (
    <figure className="bar-chart" aria-labelledby={`${id}-caption`}>
      <figcaption id={`${id}-caption`} className="sr-only">
        {caption}
      </figcaption>
      <div className="bar-chart__plot" aria-hidden="true">
        {bars.map((bar) => (
          <button
            type="button"
            tabIndex={-1}
            key={bar.key}
            className={[
              'bar-chart__bar',
              bar.open ? 'bar-chart__bar--open' : '',
              highlight && bar.key !== highlight ? 'bar-chart__bar--quiet' : '',
              picked === bar.key ? 'bar-chart__bar--picked' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => setPicked(picked === bar.key ? null : bar.key)}
            onPointerEnter={() => setPicked(bar.key)}
          >
            <span
              className="bar-chart__fill"
              style={{ height: `${Math.max(2, (bar.value / max) * 100)}%` }}
            />
            <span className="bar-chart__label">{bar.label}</span>
          </button>
        ))}
      </div>
      <p className="tm-hint bar-chart__readout" aria-hidden="true">
        {shown ? `${shown.name} · ${shown.text}` : ' '}
      </p>
      <button
        type="button"
        className="bar-chart__toggle"
        aria-expanded={table}
        aria-controls={`${id}-table`}
        onClick={() => setTable(!table)}
      >
        {table ? 'Hide the table' : 'Show as a table'}
      </button>
      {/* Tables ignore the sr-only clip width, so the wrapper carries it. */}
      <div
        id={`${id}-table`}
        className={table ? 'bar-chart__table' : 'sr-only'}
      >
        <table>
          <caption>{caption}</caption>
          <tbody>
            {bars.map((bar) => (
              <tr key={bar.key}>
                <th scope="row">{bar.name}</th>
                <td>{bar.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
