import type { ActivityRow, DashboardSummary } from '@tipme/contracts';

/**
 * How a refetched list or summary is merged on screen (spec §6.3). Signals never change the screen;
 * these compare what the API returned before and after. Only a tip the API calls paid "arrives".
 */

/** Rows are keyed by kind and id, as the list keys them. */
const keyOf = (row: Pick<ActivityRow, 'kind' | 'id'>) =>
  `${row.kind}-${row.id}`;

export function idsOf(rows: readonly ActivityRow[]): Set<string> {
  return new Set(rows.map(keyOf));
}

export function statesOf(rows: readonly ActivityRow[]): Map<string, string> {
  return new Map(rows.map((row) => [keyOf(row), row.state]));
}

/** Ids of paid tip rows not in `before`; empty on the first load (before === null). */
export function arrivals(
  before: ReadonlySet<string> | null,
  rows: readonly ActivityRow[],
): Set<string> {
  if (!before) return new Set();
  return new Set(
    rows
      .filter(
        (row) =>
          row.kind === 'tip' && row.state === 'paid' && !before.has(keyOf(row)),
      )
      .map((row) => row.id),
  );
}

/** Rows that were confirming and are now paid: same id, a highlight, no motion. */
export function newlyConfirmed(
  before: ReadonlyMap<string, string> | null,
  rows: readonly ActivityRow[],
): Set<string> {
  if (!before) return new Set();
  return new Set(
    rows
      .filter(
        (row) =>
          row.kind === 'tip' &&
          row.state === 'paid' &&
          before.get(keyOf(row)) === 'confirming',
      )
      .map((row) => row.id),
  );
}

/** True only when availableMinor rose (BigInt compare); a fall or the first load is false. */
export function balanceRose(
  before: Pick<DashboardSummary, 'availableMinor'> | null,
  after: Pick<DashboardSummary, 'availableMinor'>,
): boolean {
  if (!before) return false;
  return BigInt(after.availableMinor) > BigInt(before.availableMinor);
}

const LAGOS_TIME = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Africa/Lagos',
});

/** "Updated 14:02": the browser's clock at the last good read, in Lagos time, 24-hour. */
export function updatedLabel(at: Date): string {
  return `Updated ${LAGOS_TIME.format(at)}`;
}

/** Tips page: may the first page be replaced in place? Not under a search or a deeper page. */
export function canInsertInPlace(o: {
  searched: string;
  extraPages: number;
}): boolean {
  return o.searched.trim() === '' && o.extraPages === 0;
}
