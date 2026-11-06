import { Lamp } from '@tipme/ui';

/**
 * Test mode as one calm pill in the dashboard header (WithdrawRedesign §3). It opens its sentence.
 * A native disclosure: keyboard and screen-reader behaviour come from the browser, with no script.
 * Below 40rem the detail is hidden (the board's phone pill reads "Test mode").
 */
export function TestModePill({
  label,
  detail,
  sentence,
}: {
  label: string;
  detail: string | null;
  sentence: string | null;
}) {
  return (
    <details className="test-pill">
      <summary>
        <Lamp tone="amber" />
        {label}
        {detail && <span className="test-pill__detail"> · {detail}</span>}
      </summary>
      {sentence && <p className="test-pill__sentence">{sentence}</p>}
    </details>
  );
}
