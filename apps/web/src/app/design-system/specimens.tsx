import { Button, Surface } from '@tipme/ui';

function SparkSymbol() {
  return (
    <svg viewBox="0 0 48 48" role="img" aria-labelledby="spark-title">
      <title id="spark-title">Appreciation spark</title>
      <path d="M24 5v12M24 31v12M5 24h12M31 24h12" />
      <path d="m10.6 10.6 8.5 8.5M28.9 28.9l8.5 8.5M37.4 10.6l-8.5 8.5M19.1 28.9l-8.5 8.5" />
      <circle cx="24" cy="24" r="4.5" />
    </svg>
  );
}

export function SymbolSpecimen() {
  return (
    <section data-testid="symbol-specimen" aria-labelledby="ds-symbols">
      <h2 id="ds-symbols">Symbols</h2>
      <Surface className="symbol-specimen" material="raised">
        <SparkSymbol />
        <p>
          <strong>Authored, quiet, ownable.</strong>
          <span>
            Used to acknowledge appreciation—not decorate every surface.
          </span>
        </p>
      </Surface>
    </section>
  );
}

export function MotionSpecimen() {
  return (
    <section data-testid="motion-specimen" aria-labelledby="ds-motion">
      <h2 id="ds-motion">Motion</h2>
      <Surface className="motion-specimen" material="recessed">
        <span className="motion-specimen__object" aria-hidden="true" />
        <p>One spatial acknowledgement with an immediate static equivalent.</p>
      </Surface>
    </section>
  );
}

export function ResponsiveSpecimen() {
  return (
    <section data-testid="responsive-specimen" aria-labelledby="ds-responsive">
      <h2 id="ds-responsive">Responsive composition</h2>
      <div className="responsive-specimens">
        <Surface
          className="responsive-frame responsive-frame--wide"
          material="raised"
        >
          <span />
          <span />
        </Surface>
        <Surface
          className="responsive-frame responsive-frame--narrow"
          material="raised"
        >
          <span />
          <span />
        </Surface>
      </div>
      <Button variant="secondary">Tactile at every size</Button>
    </section>
  );
}
