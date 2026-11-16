'use client';
import { useId, useMemo } from 'react';
import {
  STUDIO_FONTS,
  contrastRatio,
  deriveStudioPalette,
  type Hex,
  type StudioCheckResult,
  type StudioDocument,
  type StudioFontId,
} from '@tipme/contracts';
import { Button } from '@tipme/ui';
import { ColourField } from './colour-field';
import {
  colourNotes,
  colourUse,
  fontChoices,
  formatRatio,
  paletteChips,
  withFont,
  withSecondColour,
} from './studio-editor-model';

/** Black or white, whichever reads better on a chip (one of them always passes 4.5 to 1). */
const inkOn = (hex: Hex) =>
  contrastRatio(hex, '#000000') >= contrastRatio(hex, '#ffffff')
    ? '#000000'
    : '#ffffff';

const CATEGORY = {
  sans: 'sans',
  serif: 'serif',
  rounded: 'rounded',
  display: 'display',
} as const;

/** A row of choices: the dashboard's segmented control (filter-row), the current one raised. */
export function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange(value: T): void;
}) {
  const id = useId();
  return (
    <div className="pst-field">
      <p id={id} className="pst-label">
        {label}
      </p>
      <div className="filter-row pst-choice" role="group" aria-labelledby={id}>
        {options.map((option) => (
          <Button
            key={option.value}
            variant="secondary"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function FontPicker({
  slot,
  value,
  onChange,
}: {
  slot: 'heading' | 'body';
  value: StudioFontId;
  onChange(id: StudioFontId): void;
}) {
  const id = useId();
  const font = STUDIO_FONTS.find((f) => f.id === value);
  return (
    <div className="pst-font">
      <label htmlFor={id}>
        <span className="pst-font__role">
          {slot === 'heading' ? 'Headings' : 'Text'}
        </span>
        <span className="pst-font__name">{font?.name ?? value}</span>
        <small>{font ? CATEGORY[font.category] : ''}</small>
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as StudioFontId)}
      >
        {fontChoices(slot).map((f) => (
          <option key={f.id} value={f.id}>
            {f.name} · {CATEGORY[f.category]}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The Style tab (StudioEditor board §1): brand colours with the palette made from them, the page's
 * mode, its two fonts, the text size and the corners. Each choice is a typed value the schema
 * accepts; the engine and the type scale turn it into CSS.
 */
export function StyleTab({
  draft,
  check,
  onChange,
  readOnly,
}: {
  draft: StudioDocument;
  check: StudioCheckResult;
  onChange(next: StudioDocument): void;
  readOnly: boolean;
}) {
  const palette = useMemo(
    () => deriveStudioPalette(draft.brand),
    [draft.brand],
  );
  const notes = colourNotes(check);
  const modes =
    draft.mode === 'auto' ? (['light', 'dark'] as const) : [draft.mode];
  const [main, second] = draft.brand;
  const set = (patch: Partial<StudioDocument>) =>
    onChange({ ...draft, ...patch });
  const accentOnly = (index: 0 | 1, mode: 'light' | 'dark') =>
    palette.notes[mode].some(
      (n) => n.colour === index && n.code !== 'NEUTRAL_FALLBACK',
    );
  return (
    <fieldset className="pst-style" disabled={readOnly}>
      <legend className="sr-only">Style</legend>
      <h2 className="pst-label">Your colours</h2>
      <ColourField
        label="Main colour"
        value={main}
        onChange={(hex: Hex) => set({ brand: second ? [hex, second] : [hex] })}
      />
      {second ? (
        <ColourField
          label="Second colour (optional)"
          value={second}
          onChange={(hex: Hex) => onChange(withSecondColour(draft, hex))}
          action={
            <Button
              variant="quiet"
              className="pst-colour__remove"
              onClick={() => onChange(withSecondColour(draft, null))}
            >
              Remove<span className="sr-only"> the second colour</span>
            </Button>
          }
        />
      ) : (
        <Button
          variant="secondary"
          className="pst-add-colour"
          onClick={() => onChange(withSecondColour(draft, '#ff7a59'))}
        >
          Add a second colour
        </Button>
      )}
      {notes.length > 0 && (
        <div className="pst-notes" aria-live="polite">
          {notes.map((note) => (
            <p key={note.lead + note.rest} className="pst-note">
              <b>{note.lead}</b> {note.rest}
            </p>
          ))}
          {modes.flatMap((mode) =>
            ([0, 1] as const)
              .filter((i) => draft.brand[i] && accentOnly(i, mode))
              .map((i) => (
                <div key={`${mode}-${i}`} className="pst-use">
                  <p className="pst-use__title">
                    How {i === 0 ? 'your main colour' : 'your second colour'} is
                    used{draft.mode === 'auto' ? ` on the ${mode} page` : ''}
                  </p>
                  <ul>
                    {colourUse(palette, mode, i, draft.brand[i] as Hex).map(
                      (use) => (
                        <li key={use.label}>
                          <span>{use.label}</span>
                          <span>
                            {formatRatio(use.ratio)}
                            {use.used ? '' : ', not used'}
                          </span>
                        </li>
                      ),
                    )}
                  </ul>
                </div>
              )),
          )}
        </div>
      )}
      {modes.map((mode) => (
        <div key={mode} className="pst-palette">
          <p className="pst-palette__title">
            Made from your colours · {mode} page
          </p>
          <ul className="pst-chips">
            {paletteChips(palette, mode).map((chip) => (
              <li
                key={chip.label}
                className="pst-chip"
                // The engine's own colour, never a typed value; its words in black or white,
                // whichever reads on it. The ratio is the colour's on the page.
                style={{ background: chip.hex, color: inkOn(chip.hex) }}
              >
                <b>{chip.label}</b>
                <span>
                  {chip.ratio === null
                    ? chip.label === 'Lines'
                      ? 'decor'
                      : chip.hex.toUpperCase()
                    : formatRatio(chip.ratio)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="pst-hint">
        Every pair is checked for you: 4.5 to 1 for text, 3 to 1 for headings
        and buttons, on the light and the dark page.
      </p>
      <Choice
        label="Page"
        value={draft.mode}
        onChange={(mode) => set({ mode })}
        options={[
          { value: 'light', label: 'Light page' },
          { value: 'dark', label: 'Dark page' },
          { value: 'auto', label: 'Follow the visitor' },
        ]}
      />
      <h2 className="pst-label">
        Fonts · {new Set([draft.fonts.heading, draft.fonts.body]).size} of 2{' '}
        {draft.fonts.heading === draft.fonts.body ? 'family' : 'families'}
      </h2>
      <div className="pst-fonts">
        <FontPicker
          slot="heading"
          value={draft.fonts.heading}
          onChange={(id) => onChange(withFont(draft, 'heading', id))}
        />
        <FontPicker
          slot="body"
          value={draft.fonts.body}
          onChange={(id) => onChange(withFont(draft, 'body', id))}
        />
      </div>
      <Choice
        label="Text size"
        value={draft.scale}
        onChange={(scale) => set({ scale })}
        options={[
          { value: 'compact', label: 'Compact' },
          { value: 'standard', label: 'Standard' },
          { value: 'roomy', label: 'Roomy' },
        ]}
      />
      <p className="pst-hint">
        Sizes come from a type scale and grow with the screen. Line length and
        spacing follow from it.
      </p>
      <Choice
        label="Corners"
        value={draft.corners}
        onChange={(corners) => set({ corners })}
        options={[
          { value: 'square', label: 'Square' },
          { value: 'soft', label: 'Soft' },
          { value: 'round', label: 'Round' },
        ]}
      />
    </fieldset>
  );
}
