'use client';
import { useRef } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';

type LeverProps<T extends string> = {
  /** The accessible name of the group; show a visible label beside the lever if the screen needs one. */
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange(value: T): void;
};

/**
 * A recessed track with a purple thumb that slides to the chosen option. It is a radio group:
 * one tab stop, and the arrow keys move the choice (and focus) with it.
 */
export function Lever<T extends string>({
  label,
  options,
  value,
  onChange,
}: LeverProps<T>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const count = options.length;
  const selected = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  const choose = (index: number) => {
    const option = options[(index + count) % count];
    if (!option) return;
    onChange(option.value);
    buttons.current[(index + count) % count]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = {
      ArrowRight: selected + 1,
      ArrowDown: selected + 1,
      ArrowLeft: selected - 1,
      ArrowUp: selected - 1,
      Home: 0,
      End: count - 1,
    }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    choose(target);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="tm-lever"
      style={
        {
          '--lever-count': count,
          '--lever-index': selected,
        } as CSSProperties
      }
      onKeyDown={onKeyDown}
    >
      <span className="tm-lever__thumb" aria-hidden="true" />
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(node) => {
            buttons.current[index] = node;
          }}
          type="button"
          role="radio"
          aria-checked={index === selected}
          tabIndex={index === selected ? 0 : -1}
          className="tm-lever__option"
          onClick={() => choose(index)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
