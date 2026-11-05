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
};
export function InputField({
  id,
  label,
  hint,
  error,
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
