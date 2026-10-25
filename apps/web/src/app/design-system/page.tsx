import {
  Badge,
  Button,
  Card,
  Choice,
  Container,
  EmptyState,
  InputField,
  Notice,
  Skeleton,
  TextareaField,
} from '@tipme/ui';
import { previewMetadata } from '@/lib/metadata';

export const metadata = previewMetadata(
  'Design foundation',
  'Development specimen of TipMe tokens and accessible interface primitives.',
  '/design-system',
);

const swatches = [
  {
    token: '--brand-primary',
    value: '#7A32F9',
    use: 'Brand, selected and focus',
  },
  { token: '--surface-base', value: '#FFFFFF', use: 'Canvas and surfaces' },
  {
    token: '--text-primary',
    value: '#000000',
    use: 'Headlines and essential text',
  },
  {
    token: '--brand-ink',
    value: '#511CB0',
    use: 'Purple text on light surfaces',
  },
  { token: '--brand-soft', value: '#F1E9FF', use: 'Quiet emphasis surfaces' },
  { token: '--text-secondary', value: '#555555', use: 'Supporting text' },
];

const materials = [
  { token: '--canvas', label: 'Canvas', use: 'Stable page ground' },
  {
    token: '--surface-raised',
    label: 'Raised',
    use: 'Cards and tactile controls',
  },
  {
    token: '--surface-recessed',
    label: 'Recessed',
    use: 'Inputs and financial wells',
  },
  {
    token: '--surface-signature',
    label: 'Signature',
    use: 'Selection and primary action',
  },
];

export default function DesignSystem() {
  return (
    <main id="main" tabIndex={-1}>
      <Container className="section-space">
        <p className="eyebrow">Development specimen · Not a product page</p>
        <h1 className="page-title">Design foundation.</h1>
        <p>
          Tokens and primitives from <code>@tipme/ui</code>. Controls here are
          static specimens and do nothing.
        </p>
        <div className="specimen-grid">
          <section aria-labelledby="ds-colour">
            <h2 id="ds-colour">Colour</h2>
            <ul className="specimen-row" role="list">
              {swatches.map((swatch) => (
                <li key={swatch.token}>
                  <div
                    className="token-swatch"
                    style={{ background: `var(${swatch.token})` }}
                    aria-hidden="true"
                  />
                  <p>
                    <strong>{swatch.value}</strong>
                    <br />
                    <code>{swatch.token}</code>
                    <br />
                    <small>{swatch.use}</small>
                  </p>
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="ds-type">
            <h2 id="ds-type">Typography</h2>
            <p className="eyebrow">Eyebrow label</p>
            <p
              style={{
                fontSize: 'var(--text-heading)',
                lineHeight: 1.08,
                letterSpacing: '-.055em',
                margin: 0,
              }}
            >
              Heading{' '}
              <em style={{ fontFamily: 'var(--font-editorial)' }}>accent</em>
            </p>
            <p>
              Body copy uses the system sans stack at a comfortable 1.7 line
              height for long-form reading.
            </p>
          </section>
          <section aria-labelledby="ds-materials">
            <h2 id="ds-materials">Materials</h2>
            <div className="material-specimens">
              {materials.map((material) => (
                <article
                  className={`material-specimen material-specimen--${material.label.toLowerCase()}`}
                  key={material.token}
                >
                  <span
                    className="material-specimen__surface"
                    style={{ background: `var(${material.token})` }}
                    aria-hidden="true"
                  />
                  <strong>{material.label}</strong>
                  <small>{material.use}</small>
                  <code>{material.token}</code>
                </article>
              ))}
            </div>
          </section>
          <section aria-labelledby="ds-actions">
            <h2 id="ds-actions">Actions</h2>
            <div className="specimen-row">
              <Button>Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="quiet">Quiet</Button>
              <Button disabled>Disabled</Button>
            </div>
            <div className="specimen-row">
              <Badge>Badge</Badge>
              <Badge>Demo only</Badge>
            </div>
          </section>
          <section aria-labelledby="ds-fields">
            <h2 id="ds-fields">Fields</h2>
            <InputField
              id="ds-name"
              label="Display name"
              hint="Hint text sits between label and control."
              defaultValue="Ada"
            />
            <InputField
              id="ds-invalid"
              label="Field with an error"
              defaultValue="??"
              error="Describe the problem and how to fix it."
            />
            <InputField
              id="ds-disabled"
              label="Disabled field"
              disabled
              defaultValue="Unavailable"
            />
            <TextareaField
              id="ds-note"
              label="Multi-line field"
              hint="Resizes vertically."
            />
          </section>
          <section aria-labelledby="ds-choice">
            <h2 id="ds-choice">Choice</h2>
            <fieldset>
              <legend>Choose a sample option</legend>
              <div className="amount-options">
                <Choice name="ds-choice" value="a" defaultChecked>
                  Selected
                </Choice>
                <Choice name="ds-choice" value="b">
                  Option
                </Choice>
                <Choice name="ds-choice" value="c" disabled>
                  Disabled
                </Choice>
              </div>
            </fieldset>
          </section>
          <section aria-labelledby="ds-feedback">
            <h2 id="ds-feedback">Feedback</h2>
            <Notice title="Neutral notice">
              Supporting context for the current step.
            </Notice>
            <Notice tone="success" title="Preferences saved">
              A generic, non-financial success example.
            </Notice>
            <Card>
              <Skeleton label="Loading specimen" />
            </Card>
          </section>
        </div>
        <EmptyState title="Nothing here yet">
          Empty states explain what is missing and what to do next.
        </EmptyState>
      </Container>
    </main>
  );
}
