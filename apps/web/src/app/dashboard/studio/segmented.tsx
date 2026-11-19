'use client';
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

/**
 * A radio group (WAI-ARIA radio pattern) for the Style tab's style cards, accent swatches and
 * segmented controls (§10, binding accessibility). One stop in the Tab order: the checked choice,
 * or the first when none is. Arrow keys, Home and End move focus within the group only (wrapping),
 * and choose what they land on unless it is `aria-disabled`; a disabled choice stays focusable, so
 * its reason can be read. Space or Enter chooses the focused one. Selection is shown by more than
 * colour: each caller draws a ring, a check or a raised face for `aria-checked`.
 */
export interface RadioItem<T> {
  value: T;
  /** React key (a value can be null: TipMe purple). */
  key: string;
  /** The accessible name, when the visible content doesn't say it (a swatch, a card). */
  label?: string;
  disabled?: boolean;
  /** The id of the text saying why it is disabled, or what it is. */
  describedBy?: string;
}

export function RadioGroup<T>({
  labelledBy,
  label,
  items,
  value,
  onChange,
  className,
  itemClassName,
  render,
  readOnly = false,
}: {
  labelledBy?: string;
  label?: string;
  items: readonly RadioItem<T>[];
  value: T;
  onChange(value: T): void;
  className: string;
  itemClassName: string;
  render(item: RadioItem<T>, checked: boolean): ReactNode;
  /** Nothing can be chosen (another tab saved first): the choices still read. */
  readOnly?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const checkedAt = items.findIndex((item) => item.value === value);
  const stop = checkedAt >= 0 ? checkedAt : 0;

  const choose = (item: RadioItem<T>) => {
    if (item.disabled || readOnly || item.value === value) return;
    onChange(item.value);
  };

  const keys = (event: KeyboardEvent, index: number) => {
    const last = items.length - 1;
    const to =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (to === null) return;
    // Arrow keys stay inside the group: never scroll the page or move to another control.
    event.preventDefault();
    event.stopPropagation();
    refs.current[to]?.focus();
    choose(items[to]!);
  };

  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      className={className}
    >
      {items.map((item, index) => {
        const checked = item.value === value;
        return (
          <button
            key={item.key}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={item.disabled || readOnly || undefined}
            aria-label={item.label}
            aria-describedby={item.describedBy}
            tabIndex={index === stop ? 0 : -1}
            className={itemClassName}
            onClick={() => choose(item)}
            onKeyDown={(event) => keys(event, index)}
          >
            {render(item, checked)}
          </button>
        );
      })}
    </div>
  );
}

/** The segmented control (§10.4–5): 44 tall choices, r9, in an r12 #EEEDE8 track. */
export function Segmented<T extends string>({
  labelledBy,
  options,
  value,
  onChange,
  readOnly,
}: {
  labelledBy: string;
  options: readonly { value: T; label: string; icon?: ReactNode }[];
  value: T;
  onChange(value: T): void;
  readOnly?: boolean;
}) {
  return (
    <RadioGroup
      labelledBy={labelledBy}
      items={options.map((o) => ({ value: o.value, key: o.value }))}
      value={value}
      onChange={onChange}
      readOnly={readOnly ?? false}
      className="pst-seg"
      itemClassName="pst-seg__choice"
      render={(item) => {
        const option = options.find((o) => o.value === item.value)!;
        return (
          <>
            {option.icon}
            {option.label}
          </>
        );
      }}
    />
  );
}

/** A labelled segmented control (a block form's "Heading" or "Paragraph"). */
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
      <Segmented
        labelledBy={id}
        options={options}
        value={value}
        onChange={onChange}
      />
    </div>
  );
}

const stroke = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

/** The canvas's icons for Appearance and Cover. */
export const ICONS = {
  light: (
    <svg {...stroke}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.75v2M12 19.25v2M2.75 12h2M19.25 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M5.5 18.5l1.4-1.4M17.1 6.9l1.4-1.4" />
    </svg>
  ),
  dark: (
    <svg {...stroke}>
      <path d="M19.5 14.5A7.75 7.75 0 1 1 9.5 4.5a6.25 6.25 0 0 0 10 10z" />
    </svg>
  ),
  auto: (
    <svg {...stroke}>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 3.75v16.5" />
    </svg>
  ),
  yours: (
    <svg {...stroke}>
      <rect x="3.75" y="4.75" width="16.5" height="14.5" rx="2.5" />
      <circle cx="9" cy="10" r="1.75" />
      <path d="M20.25 15.5l-4.5-4.5-9 8.25" />
    </svg>
  ),
  gradient: (
    <svg {...stroke}>
      <rect x="3.75" y="4.75" width="16.5" height="14.5" rx="2.5" />
      <path d="M3.75 14.5c4-3 8.5-3.5 16.5-1.5" />
    </svg>
  ),
  plain: (
    <svg {...stroke}>
      <rect x="3.75" y="4.75" width="16.5" height="14.5" rx="2.5" />
    </svg>
  ),
  check: (size: number) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5.5 12.5l4 4 9-9" />
    </svg>
  ),
  chevron: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.5 6.5L15 12l-5.5 5.5" />
    </svg>
  ),
  grip: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6.5h.01M15 6.5h.01M9 12h.01M15 12h.01M9 17.5h.01M15 17.5h.01" />
    </svg>
  ),
  lock: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5.25" y="10.75" width="13.5" height="9.5" rx="2.25" />
      <path d="M8.5 10.75V8a3.5 3.5 0 0 1 7 0v2.75" />
    </svg>
  ),
  sparkle: (
    <svg width="9" height="9" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#FFD56B"
        d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"
      />
      <path
        fill="#FFD56B"
        d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"
      />
    </svg>
  ),
};

/** The canvas's black PRO pill with its gold sparkle. */
export function ProPill({ large = false }: { large?: boolean }) {
  return (
    <span className="pst-pro" data-large={large || undefined}>
      {ICONS.sparkle}PRO
    </span>
  );
}
