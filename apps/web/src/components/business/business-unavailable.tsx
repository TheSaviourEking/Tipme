import { ActionLink } from '@tipme/ui';
import { QuietScreen } from '@/components/quiet-screen';

/**
 * A business location or staff page that can't take tips (M11): unknown, waiting to be verified,
 * paused, closed, or the feature switched off. One screen for every case, so nothing is revealed.
 */
export function BusinessUnavailable() {
  return (
    <QuietScreen
      title="This business isn’t taking tips on TipMe right now."
      action={
        <ActionLink variant="continue" href="/">
          Go to TipMe
        </ActionLink>
      }
    >
      <p>
        If you came here from a code at a business, please ask a member of
        staff.
      </p>
    </QuietScreen>
  );
}
