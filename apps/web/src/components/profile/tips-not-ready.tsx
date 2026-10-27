import { Card } from '@tipme/ui';

/**
 * In place of the tip form while the owner is still setting up payments: said before a
 * supporter chooses an amount, not after they press Tip ("Not sent yet").
 */
export function TipsNotReady({ recipient }: { recipient: string }) {
  return (
    <Card className="appreciation-card tips-not-ready">
      <h2>{recipient} can’t receive tips just yet.</h2>
      <p className="composer-description">
        They’re still setting up payments. Come back soon: this page will take
        tips as soon as they’re ready.
      </p>
    </Card>
  );
}
