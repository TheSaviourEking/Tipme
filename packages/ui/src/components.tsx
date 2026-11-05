import { Fragment } from 'react';
import type { ComponentPropsWithRef, HTMLAttributes, ReactNode } from 'react';

/** `continue` is the black continuation action: the one step forward on a screen. */
type Variant = 'primary' | 'secondary' | 'quiet' | 'continue';
/** `instrument` is the floating card; `paper` is a receipt or note slip resting on the canvas. */
export type Material =
  'canvas' | 'raised' | 'recessed' | 'signature' | 'instrument' | 'paper';
const classes = (...values: (string | undefined)[]) =>
  values.filter(Boolean).join(' ');

/** A small lit mark that carries a state beside its words. Decoration: the words say it. */
export type LampTone = 'red' | 'amber' | 'purple' | 'off';
export function Lamp({
  tone,
  className,
}: {
  tone: LampTone;
  className?: string;
}) {
  return (
    <span
      className={classes('tm-lamp', `tm-lamp--${tone}`, className)}
      aria-hidden="true"
    />
  );
}

export function Button({
  variant = 'primary',
  className,
  type = 'button',
  ...props
}: ComponentPropsWithRef<'button'> & { variant?: Variant }) {
  return (
    <button
      type={type}
      className={classes('tm-button', `tm-button--${variant}`, className)}
      data-material={variant === 'primary' ? 'signature' : 'raised'}
      {...props}
    />
  );
}
export function ActionLink({
  variant = 'primary',
  className,
  ...props
}: ComponentPropsWithRef<'a'> & { variant?: Variant }) {
  return (
    <a
      className={classes('tm-button', `tm-button--${variant}`, className)}
      data-material={variant === 'primary' ? 'signature' : 'raised'}
      {...props}
    />
  );
}
export function Container({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={classes('tm-container', className)} {...props} />;
}
export function Surface({
  material = 'raised',
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { material?: Material }) {
  return (
    <div
      className={classes('tm-surface', `tm-surface--${material}`, className)}
      data-material={material}
      {...props}
    />
  );
}
export function Card({
  material = 'raised',
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { material?: Material }) {
  return (
    <Surface
      material={material}
      className={classes('tm-card', className)}
      {...props}
    />
  );
}
export function Badge({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return <span className={classes('tm-badge', className)} {...props} />;
}

/**
 * The mark of a Pro page, shown with the person's name. The word is what it says; the spark is
 * decoration. It names the plan only: never a price.
 */
export function ProBadge({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={classes('tm-pro-badge', className)} {...props}>
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="tm-pro-badge__spark"
      >
        <path d="M8 0c.5 4.2 3.8 7.5 8 8-4.2.5-7.5 3.8-8 8-.5-4.2-3.8-7.5-8-8 4.2-.5 7.5-3.8 8-8Z" />
      </svg>
      Pro
    </span>
  );
}

type FieldDetails = {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  /** A few words beside the value, inside the well, with a red lamp ("below ₦2,000"). Shown only with an error. */
  flag?: string;
};
/**
 * With an error and a flag, the control sits in a wrap with the flag beside its value. The flag is
 * hidden from screen readers: the error line, linked by aria-describedby, already says it in full.
 */
function Flagged({
  error,
  flag,
  children,
}: {
  error?: string;
  flag?: string;
  children: ReactNode;
}) {
  if (!error || !flag) return children;
  return (
    <div className="tm-input-wrap">
      {children}
      <span className="tm-field-flag" aria-hidden="true">
        <Lamp tone="red" />
        {flag}
      </span>
    </div>
  );
}
export function InputField({
  id,
  label,
  hint,
  error,
  flag,
  className,
  ...props
}: ComponentPropsWithRef<'input'> & FieldDetails) {
  return (
    <div className="tm-field">
      <label htmlFor={id}>{label}</label>
      {hint && (
        <p id={`${id}-hint`} className="tm-hint">
          {hint}
        </p>
      )}
      <Flagged error={error} flag={flag}>
        <input
          {...props}
          id={id}
          className={classes('tm-input', className)}
          aria-invalid={Boolean(error)}
          aria-describedby={
            [
              hint && `${id}-hint`,
              error && `${id}-error`,
              props['aria-describedby'],
            ]
              .filter(Boolean)
              .join(' ') || undefined
          }
        />
      </Flagged>
      {error && (
        <p className="tm-field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export function TextareaField({
  id,
  label,
  hint,
  error,
  flag,
  className,
  ...props
}: ComponentPropsWithRef<'textarea'> & FieldDetails) {
  return (
    <div className="tm-field">
      <label htmlFor={id}>{label}</label>
      {hint && (
        <p id={`${id}-hint`} className="tm-hint">
          {hint}
        </p>
      )}
      <Flagged error={error} flag={flag}>
        <textarea
          rows={3}
          {...props}
          id={id}
          className={classes('tm-input', className)}
          aria-invalid={Boolean(error)}
          aria-describedby={
            [
              hint && `${id}-hint`,
              error && `${id}-error`,
              props['aria-describedby'],
            ]
              .filter(Boolean)
              .join(' ') || undefined
          }
        />
      </Flagged>
      {error && (
        <p className="tm-field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export function Choice({
  children,
  className,
  ...props
}: Omit<ComponentPropsWithRef<'input'>, 'type'> & { children: ReactNode }) {
  return (
    <label className={classes('tm-choice', className)}>
      <input type="radio" {...props} />
      <span>{children}</span>
    </label>
  );
}
export function AmountChoice(
  props: Omit<ComponentPropsWithRef<'input'>, 'type'> & {
    children: ReactNode;
  },
) {
  return (
    <Choice
      {...props}
      className={classes('tm-amount-choice', props.className)}
    />
  );
}
export type SlipTone = 'error' | 'unsure' | 'waiting' | 'done' | 'neutral';
const stampColour: Record<SlipTone, 'red' | 'ink' | 'purple'> = {
  error: 'red',
  unsure: 'ink',
  waiting: 'ink',
  neutral: 'ink',
  done: 'purple',
};
/** Something present beside a value: false, null, undefined and '' are not. */
const given = (node: ReactNode) =>
  node !== undefined && node !== null && node !== false && node !== '';

/**
 * Concept A, the slip: a paper slip for a state that needs explaining (money, account safety,
 * staff actions). Errors and unsure outcomes are alerts; everything else is a polite status.
 */
export function Slip({
  tone = 'neutral',
  title,
  stamp,
  safe,
  actions,
  dense = false,
  children,
  className,
  id,
  'data-testid': testId,
}: {
  tone?: SlipTone;
  /** Some titles come from the server, so any node is allowed. */
  title: ReactNode;
  /** The ink stamp's words. Decoration: the title carries the meaning, so it is aria-hidden. */
  stamp?: string;
  /**
   * The reassuring line. Only where the code proves it (states plan, Money-safety proofs): the slip
   * never writes one of its own.
   */
  safe?: ReactNode;
  /** Keys on the slip: the way out. */
  actions?: ReactNode;
  /** Staff screens: tighter padding, smaller stamp. */
  dense?: boolean;
  children?: ReactNode;
  className?: string;
  id?: string;
  'data-testid'?: string;
}) {
  return (
    <div
      id={id}
      data-testid={testId}
      className={classes(
        'tm-slip',
        `tm-slip--${tone}`,
        dense ? 'tm-slip--dense' : undefined,
        stamp ? 'tm-slip--stamped' : undefined,
        className,
      )}
      role={tone === 'error' || tone === 'unsure' ? 'alert' : 'status'}
    >
      {stamp && (
        <span
          className={`tm-slip__stamp tm-slip__stamp--${stampColour[tone]}`}
          aria-hidden="true"
        >
          {stamp.split('\n').map((line, index) => (
            <Fragment key={index}>
              {index > 0 && <br />}
              {line}
            </Fragment>
          ))}
        </span>
      )}
      <strong className="tm-slip__title">{title}</strong>
      {given(children) && <div className="tm-slip__body">{children}</div>}
      {given(safe) && (
        <div className="tm-slip__safe">
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path
              d="M8 1.5 2.75 3.5v4c0 3.2 2.2 5.9 5.25 7 3.05-1.1 5.25-3.8 5.25-7v-4L8 1.5Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
            <path
              d="m5.5 8 1.75 1.75L10.75 6.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>{safe}</span>
        </div>
      )}
      {given(actions) && <div className="tm-slip__actions">{actions}</div>}
    </div>
  );
}

/**
 * A condition people must know about that isn't a failed action (StatesMap legend). It is usually
 * on the page from the start, where an alert is noise, so it is a polite status with an amber lamp.
 */
export function StandingWarning({
  title,
  children,
  actions,
  dense = false,
  id,
  'data-testid': testId,
}: {
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  dense?: boolean;
  id?: string;
  'data-testid'?: string;
}) {
  return (
    <div
      className={classes('tm-warning', dense ? 'tm-warning--dense' : undefined)}
      role="status"
      id={id}
      data-testid={testId}
    >
      <strong className="tm-warning__title">
        <Lamp tone="amber" />
        {title}
      </strong>
      {given(children) && <div className="tm-warning__body">{children}</div>}
      {given(actions) && <div className="tm-warning__actions">{actions}</div>}
    </div>
  );
}

/** The one plain line under a key, with no box. Always mounted, so a screen reader hears the change. */
export function StateLine({
  tone,
  children,
  id,
  visuallyHidden = false,
}: {
  tone: 'error' | 'status';
  children?: ReactNode;
  id?: string;
  /** The key face already shows it ("Saved."); the words stay for screen readers. */
  visuallyHidden?: boolean;
}) {
  return (
    <p
      className={classes(
        'tm-state-line',
        visuallyHidden ? 'sr-only' : undefined,
      )}
      role={tone === 'error' ? 'alert' : 'status'}
      id={id}
    >
      {children}
    </p>
  );
}

export function Notice({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: 'neutral' | 'error' | 'success';
  title: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={`tm-notice tm-notice--${tone}`}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <strong>
        {tone === 'success' ? '✓ ' : tone === 'error' ? '! ' : ''}
        {title}
      </strong>
      {children && <div>{children}</div>}
    </div>
  );
}
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="tm-empty">
      <span className="tm-empty-mark" aria-hidden="true">
        ✳
      </span>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Skeleton({ label = 'Loading content' }: { label?: string }) {
  return (
    <div className="tm-skeleton" role="status">
      <span className="sr-only">{label}</span>
      <span />
      <span />
      <span />
    </div>
  );
}
export function Motion({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={classes('tm-enter', className)} {...props} />;
}
