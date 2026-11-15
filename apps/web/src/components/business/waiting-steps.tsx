import type { BusinessDetail } from '@tipme/contracts';

// Business sign-up, Task D5: while TipMe checks a new business, what happens next. No date is
// promised (as today); nothing here says approved.

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? '';

export function WaitingSteps({
  business,
  email,
}: {
  business: BusinessDetail;
  /** The login's own email, where TipMe writes. */
  email: string | null;
}) {
  const first = firstName(business.contact.name);
  const location = business.locations.find((place) => !place.closed);
  const sent = new Date(business.appliedAt).toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return (
    <section
      className="business-waiting"
      aria-labelledby="business-waiting-title"
    >
      <h2 id="business-waiting-title">
        Waiting for TipMe to check your business.
      </h2>
      <p>
        {first ? `Thanks, ${first}. ` : 'Thanks. '}TipMe staff check{' '}
        {business.name}’s name, address and contact.{' '}
        {email
          ? `We’ll email you at ${email} as soon as it’s done.`
          : 'We’ll email you as soon as it’s done.'}
      </p>
      <h3 id="business-waiting-next">What happens next</h3>
      <ol
        className="business-waiting__steps"
        aria-labelledby="business-waiting-next"
      >
        <li data-done="true">
          <strong>Sent to TipMe</strong>
          <span>{sent}</span>
        </li>
        <li>
          <strong>TipMe checks your details</strong>
          <span>We may email you a question.</span>
        </li>
        <li>
          <strong>Your codes go live</strong>
          <span>
            {location
              ? `Print one for ${location.name}.`
              : 'Print one for each location.'}
          </span>
        </li>
        <li>
          <strong>Invite your staff</strong>
          <span>Each gets their own page.</span>
        </li>
      </ol>
      <p className="business-waiting__meanwhile">
        <strong>While you wait</strong> You can add your logo and invite staff
        now. Nothing goes live until you’re verified.
      </p>
    </section>
  );
}
