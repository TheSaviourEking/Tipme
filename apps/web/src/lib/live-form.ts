/**
 * The dirty-form rule for live updates (plan Task 13, spec §6.3). When a saved value changes
 * elsewhere (another tab, another device, staff), the fields the person hasn't touched take the new
 * value; a field they are editing keeps their input, and `changedElsewhere` says so, so the form
 * can show "This changed on another device." with "Show the latest". Pure, for tests.
 */
export function mergeServerIntoForm<T extends Record<string, unknown>>(o: {
  server: T;
  previousServer: T;
  local: T;
  dirty: ReadonlySet<keyof T>;
}): { next: T; changedElsewhere: boolean } {
  const next = { ...o.server };
  let changedElsewhere = false;
  for (const key of o.dirty) {
    next[key] = o.local[key];
    // News only when the saved value moved and isn't simply what this form just saved.
    if (
      !same(o.server[key], o.previousServer[key]) &&
      !same(o.server[key], o.local[key])
    )
      changedElsewhere = true;
  }
  return { next, changedElsewhere };
}

/** Form values are strings, numbers, booleans and small arrays or objects of them. */
function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** What the notice says, in one place for Settings and the QR studio. */
export const CHANGED_ELSEWHERE = {
  message: 'This changed on another device.',
  action: 'Show the latest',
} as const;

/** The fields whose input differs from the last saved value: what the person is editing. */
export function dirtyKeys<T extends Record<string, unknown>>(
  local: T,
  saved: T,
): Set<keyof T> {
  return new Set(
    (Object.keys(local) as (keyof T)[]).filter(
      (key) => !same(local[key], saved[key]),
    ),
  );
}
