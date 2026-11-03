'use client';
import { forwardRef } from 'react';

const CELLS = 6;

/**
 * A 6-digit code: ONE native input (so autofill, paste, backspace and screen readers behave) drawn
 * as six cells that mirror its value. The input sits over the cells, transparent; the cells are
 * decoration only, hidden from assistive technology.
 */
export const CodeField = forwardRef<
  HTMLInputElement,
  {
    id: string;
    label: string;
    value: string;
    onChange: (digits: string) => void;
    error?: string;
  }
>(function CodeField({ id, label, value, onChange, error }, ref) {
  const now = Math.min(value.length, CELLS - 1);
  return (
    <div className="tm-field tm-code-field">
      <label htmlFor={id}>{label}</label>
      <div className="tm-code-field__stage">
        <div className="tm-code-cells" aria-hidden="true">
          {Array.from({ length: CELLS }, (_, index) => (
            <span
              key={index}
              className={`tm-code-cell${index === now ? ' is-now' : ''}`}
              data-filled={index < value.length}
            >
              {value[index] ?? ''}
            </span>
          ))}
        </div>
        <input
          ref={ref}
          id={id}
          className="tm-code-field__input"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={CELLS}
          pattern="[0-9]*"
          spellCheck={false}
          value={value}
          onChange={(event) =>
            onChange(event.target.value.replace(/\D/g, '').slice(0, CELLS))
          }
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
        />
      </div>
      {error && (
        <p className="tm-field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
});
