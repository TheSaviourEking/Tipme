import { naira } from '@/lib/money';

/** Seven bars plus a text table, so the trend is readable without the picture. */
export function TrendChart({
  days,
}: {
  days: { date: string; netMinor: string }[];
}) {
  const max = Math.max(1, ...days.map((day) => Number(day.netMinor)));
  const label = (date: string) =>
    new Date(`${date}T12:00:00Z`).toLocaleDateString('en-NG', {
      weekday: 'short',
    });
  return (
    <figure className="trend">
      <svg
        viewBox="0 0 140 48"
        aria-hidden="true"
        focusable="false"
        className="trend__bars"
      >
        {days.map((day, index) => {
          const height = Math.max(2, (Number(day.netMinor) / max) * 44);
          return (
            <rect
              key={day.date}
              x={index * 20 + 3}
              y={46 - height}
              width="14"
              height={height}
              rx="3"
            />
          );
        })}
      </svg>
      <figcaption className="tm-hint">Last 7 days</figcaption>
      {/* Tables ignore the sr-only clip width, so the wrapper carries it. */}
      <div className="sr-only">
        <table>
          <caption>What you received each day for the last 7 days</caption>
          <tbody>
            {days.map((day) => (
              <tr key={day.date}>
                <th scope="row">{label(day.date)}</th>
                <td>{naira(day.netMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
