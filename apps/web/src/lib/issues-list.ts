import type { OpsIssue } from '@tipme/contracts';

type Row = Pick<OpsIssue, 'id' | 'status' | 'priority'>;

/**
 * The issues screen's list. A first-page read (signal, resync, timer, filters, "New changes: show")
 * and a "Show more" can be in flight at once, so each answer is applied to the list as it is when
 * it lands: neither may drop the other's rows or mix an old first page with a new one.
 */
export interface IssuesListState<T extends Row = OpsIssue> {
  issues: T[] | null;
  more: boolean;
  /** More than the first page is showing. */
  extraPages: boolean;
  newChanges: boolean;
  failed: boolean;
  /** Bumped each time a first page replaces the list: a "Show more" asked of an older one is dropped. */
  generation: number;
}

export const INITIAL_ISSUES_LIST: IssuesListState<never> = {
  issues: null,
  more: false,
  extraPages: false,
  newChanges: false,
  failed: false,
  generation: 0,
};

/**
 * How a landed first page applies: `replace` always (filters, "New changes: show", today's timer);
 * `signal` replaces unless more pages are showing, then offers the change; `check` (a resync) does
 * the same but offers it only if the first page differs from the one showing.
 */
export type FirstPageMode = 'replace' | 'signal' | 'check';

export type IssuesListAction<T extends Row = OpsIssue> =
  | { type: 'first'; rows: T[]; mode: FirstPageMode }
  | { type: 'firstFailed' }
  /** `after`: the id of the last row the page was asked after (its cursor). */
  | { type: 'more'; rows: T[]; generation: number; after: string };

const PAGE = 50;

/** The rows that decide whether a first page changed: order, status and priority. */
const shape = (rows: readonly Row[]) =>
  rows.map((i) => `${i.id}:${i.status}:${i.priority ? 1 : 0}`).join(',');

export function issuesListReducer<T extends Row>(
  state: IssuesListState<T>,
  action: IssuesListAction<T>,
): IssuesListState<T> {
  switch (action.type) {
    case 'firstFailed':
      return { ...state, failed: true };
    case 'more':
      // Asked of an older list, or after a row that is no longer last (a double-click, or an
      // earlier "Show more" answered later): dropped, so no row shows twice.
      if (
        action.generation !== state.generation ||
        !state.issues ||
        state.issues.at(-1)?.id !== action.after
      )
        return state;
      return {
        ...state,
        issues: [...state.issues, ...action.rows],
        more: action.rows.length === PAGE,
        extraPages: true,
      };
    case 'first': {
      if (action.mode !== 'replace' && state.extraPages) {
        const changed =
          action.mode === 'signal' ||
          shape(action.rows) !== shape((state.issues ?? []).slice(0, PAGE));
        return {
          ...state,
          failed: false,
          newChanges: state.newChanges || changed,
        };
      }
      return {
        issues: action.rows,
        more: action.rows.length === PAGE,
        extraPages: false,
        newChanges: false,
        failed: false,
        generation: state.generation + 1,
      };
    }
  }
}

const STRENGTH: Record<FirstPageMode, number> = {
  check: 0,
  signal: 1,
  replace: 2,
};

/**
 * The first-page reads in flight. The newest answer wins (an older one is dropped), but it takes
 * the strongest mode asked since a read last landed: a filter change or "New changes: show" (a
 * replace) is never cancelled by a signal or resync read that starts before it lands. A failed
 * read keeps the pending mode for the next one.
 */
export function createFirstPageReads() {
  let asked = 0;
  let pending: FirstPageMode | null = null;
  return {
    start(mode: FirstPageMode): number {
      if (pending === null || STRENGTH[mode] > STRENGTH[pending])
        pending = mode;
      return ++asked;
    },
    /** The mode to apply the answer with, or null when a newer read is in flight. */
    land(ticket: number, ok: boolean): FirstPageMode | null {
      if (ticket !== asked || pending === null) return null;
      const mode = pending;
      if (ok) pending = null;
      return mode;
    },
  };
}
