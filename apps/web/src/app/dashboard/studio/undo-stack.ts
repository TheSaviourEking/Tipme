/**
 * Page Studio undo (styles spec §12.2; plan Task 15, PR 5b): the stack and the words for each step.
 * Plain TypeScript with no `@/` imports, so its unit test runs in Node (test/studio-undo.test.mjs).
 *
 * A step is each change to style, accent, mode, cover, block order, adding or removing a block, or
 * one field of a block per pause (the 800 ms save debounce). The stack lives in memory for the
 * session: cleared on reload and on discard, at most 50 steps (builder's call on the cap).
 */
import {
  STUDIO_STYLES,
  type StudioBlock,
  type StudioDocument,
} from '@tipme/contracts';
import { COVER_LABEL, MODE_LABEL, accentHeading } from './style-tab-model.ts';

/** A field's edits within this long of each other are one step: the save debounce. */
export const UNDO_PAUSE_MS = 800;

/** What the editor says when the server refuses an undo that re-adds a Pro item (R4). */
export const PRO_UNDO_REFUSED =
  'Adding this back needs Pro. Everything else is kept.';

export interface UndoStep {
  /** The draft before the change. */
  doc: StudioDocument;
  /** What undoing it undoes: "style changed to Clear". */
  label: string;
}

export interface UndoStack {
  /**
   * Records the draft before a change. `field` names a block field ("undo0001:text"): edits to the
   * same field with no pause between them stay one step, which goes back to before the first.
   */
  push(prev: StudioDocument, label: string, field?: string): void;
  pop(): UndoStep | null;
  peek(): UndoStep | null;
  clear(): void;
  readonly size: number;
}

export function createUndoStack(
  cap = 50,
  now: () => number = Date.now,
): UndoStack {
  let steps: (UndoStep & { field?: string; at: number })[] = [];
  return {
    push(prev, label, field) {
      const at = now();
      const top = steps.at(-1);
      if (field && top?.field === field && at - top.at < UNDO_PAUSE_MS) {
        top.at = at;
        return;
      }
      steps.push({ doc: prev, label, ...(field ? { field } : {}), at });
      if (steps.length > cap) steps = steps.slice(-cap);
    },
    pop() {
      const step = steps.pop();
      // The next edit is a new step, even to the field the one below was typing in.
      const below = steps.at(-1);
      if (below) delete below.field;
      return step ? { doc: step.doc, label: step.label } : null;
    },
    peek() {
      const top = steps.at(-1);
      return top ? { doc: top.doc, label: top.label } : null;
    },
    clear() {
      steps = [];
    },
    get size() {
      return steps.length;
    },
  };
}

/** The Undo button's accessible name: "Undo: style changed to Clear", or "Undo" with nothing. */
export const undoButtonName = (label: string | null) =>
  label ? `Undo: ${label}` : 'Undo';

/** What a block is called in a step's words. */
function blockNoun(block: StudioBlock): string {
  if (block.kind === 'text') return block.variant;
  return block.kind;
}

/** The first path inside `a` and `b` where they differ ("text", "items.0.name"), or null. */
function firstDifference(a: unknown, b: unknown, path = ''): string | null {
  if (a === b) return null;
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return path;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  // A list that grew or shrank is one field (an item added or removed).
  if (Array.isArray(a) && a.length !== (b as unknown[]).length) return path;
  for (const key of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    const at = firstDifference(ra[key], rb[key], path ? `${path}.${key}` : key);
    if (at !== null) return at;
  }
  return null;
}

/**
 * The step a change makes: its words, and for a block field edit the field it coalesces on. Null
 * when nothing changed. A change touching several parts (a style switch that moves the cover) is
 * named for the first of style, accent, mode, cover, blocks.
 */
export function describeChange(
  prev: StudioDocument,
  next: StudioDocument,
): { label: string; field?: string } | null {
  if (prev.style !== next.style)
    return { label: `style changed to ${STUDIO_STYLES[next.style].name}` };
  if (prev.accent !== next.accent)
    return { label: `accent changed to ${accentHeading(next)}` };
  if (prev.mode !== next.mode)
    return { label: `mode changed to ${MODE_LABEL[next.mode]}` };
  if (prev.cover !== next.cover)
    return { label: `cover changed to ${COVER_LABEL[next.cover]}` };
  const a = prev.blocks;
  const b = next.blocks;
  if (b.length > a.length) return { label: 'block added' };
  if (b.length < a.length) return { label: 'block removed' };
  const ids = (list: readonly StudioBlock[]) => list.map((x) => x.id);
  if (ids(a).join() !== ids(b).join())
    return [...ids(a)].sort().join() === [...ids(b)].sort().join()
      ? { label: 'block moved' }
      : { label: 'block changed' };
  for (let i = 0; i < a.length; i++) {
    const before = a[i]!;
    const after = b[i]!;
    const at = firstDifference(before, after);
    if (at === null) continue;
    return { label: `${blockNoun(after)} edited`, field: `${after.id}:${at}` };
  }
  return null;
}
