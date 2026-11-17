import { formatDemoAmount, formatNaira } from '@/lib/demo-amount';

/**
 * An amount of naira as people see it: ₦2,000 (or NGN 2,000.00 with `code`, for the staff console
 * and the mock checkout), in the `.money` face: Inter with tabular figures. Every amount a page
 * shows goes through this or carries the `money` class (test/money-font.test.mjs checks).
 */
export function Money({
  minor,
  code = false,
  className,
}: {
  minor: string | number | bigint;
  code?: boolean;
  className?: string;
}) {
  return (
    <span className={className ? `money ${className}` : 'money'}>
      {code ? formatDemoAmount(Number(minor)) : formatNaira(minor)}
    </span>
  );
}
