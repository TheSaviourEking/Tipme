import type { ComponentPropsWithRef, HTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'quiet';
const classes = (...values: (string | undefined)[]) =>
  values.filter(Boolean).join(' ');

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
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={classes('tm-card', className)} {...props} />;
}
export function Badge({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return <span className={classes('tm-badge', className)} {...props} />;
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
