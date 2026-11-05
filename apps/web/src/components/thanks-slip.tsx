import type { ThanksSlip as Slip } from '@tipme/contracts';

/**
 * The recipient's thank-you line, as the supporter reads it on their receipt ("Make it yours"),
 * and as Settings previews it. React renders the line as text. The quote mark is CSS, so it is
 * never read out.
 */
export function ThanksSlip({ slip }: { slip: Slip }) {
  return (
    <figure className="thanks-slip" data-style={slip.style}>
      <blockquote>
        <p>{slip.line}</p>
      </blockquote>
      {slip.signature && <figcaption>{slip.signature}</figcaption>}
    </figure>
  );
}
