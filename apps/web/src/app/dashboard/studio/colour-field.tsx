'use client';
import { useId, useState, type ReactNode } from 'react';
import type { Hex } from '@tipme/contracts';
import { normaliseHex } from './studio-editor-model';

/**
 * One brand colour (StudioEditor board, "Your colours"): the swatch is the browser's own colour
 * picker, and the code beside it can be typed. Any #rrggbb is allowed; the engine makes it work.
 */
export function ColourField({
  label,
  value,
  onChange,
  action,
}: {
  label: string;
  value: Hex;
  onChange(hex: Hex): void;
  /** "Remove", for the optional second colour. */
  action?: ReactNode;
}) {
  const id = useId();
  const [text, setText] = useState(value.toUpperCase());
  const [shown, setShown] = useState(value);
  const [error, setError] = useState('');
  // The colour changed from outside (the picker, a fix, a reload): the code follows it.
  if (shown !== value) {
    setShown(value);
    setText(value.toUpperCase());
    setError('');
  }
  const type = (next: string) => {
    setText(next);
    const hex = normaliseHex(next);
    if (hex) {
      setError('');
      setShown(hex);
      onChange(hex);
    }
  };
  return (
    <div className="pst-colour">
      <input
        type="color"
        className="pst-colour__swatch"
        aria-label={`Pick the ${label.replace(' (optional)', '').toLowerCase()}`}
        value={value}
        onChange={(e) => {
          const hex = normaliseHex(e.target.value);
          if (hex) onChange(hex);
        }}
      />
      <div className="pst-colour__code">
        <label htmlFor={`${id}-code`}>{label}</label>
        <input
          id={`${id}-code`}
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={7}
          value={text}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => type(e.target.value)}
          onBlur={() => {
            if (!normaliseHex(text))
              setError('Use a colour code like #7A32F9: 6 letters or numbers.');
            else setText(value.toUpperCase());
          }}
        />
      </div>
      {action}
      {error && (
        <p id={`${id}-error`} className="pst-colour__error">
          {error}
        </p>
      )}
    </div>
  );
}
