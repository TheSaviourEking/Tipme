'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyStudioFix,
  checkDesign,
  type MyStudio,
  type StudioCheckResult,
  type StudioDocument,
  type StudioIssue,
} from '@tipme/contracts';
import { apiFetch } from '@/lib/session-client';
import { checkShown, type SaveState } from './studio-editor-model';

/** Edits settle this long before the draft is saved (plan Task 9). */
const SAVE_AFTER_MS = 800;

export interface StudioDraft {
  draft: StudioDocument;
  rev: number;
  /** The published version, as the server last said. */
  published: StudioDocument | null;
  save: SaveState;
  /** Another tab or device saved first (STUDIO_DRAFT_STALE): nothing more is saved here. */
  stale: boolean;
  /** Pro ended while editing (STUDIO_PRO_REQUIRED): the draft is kept, and nothing more is saved. */
  proEnded: boolean;
  /** The editor's own check on every change; the server's once a save has checked this draft. */
  check: StudioCheckResult;
  change(next: StudioDocument): void;
  fix(issue: StudioIssue, fixId: string): void;
  /** Saves now (after a failure). */
  retry(): void;
  /** Drops this tab's edits for the latest saved draft. */
  reload(): Promise<void>;
}

/**
 * The draft being edited (plan Task 9's `useStudioDraft`, G1 part): the document, the design check
 * on every change, and a debounced save to `PUT /v1/me/studio/draft` naming the revision it was
 * based on. Saving never needs a passing check; only publishing will (G3). Undo, discard and
 * publish come with G3.
 */
export function useStudioDraft(initial: MyStudio): StudioDraft {
  const [draft, setDraft] = useState(initial.draft);
  const [published, setPublished] = useState(initial.published);
  const [context, setContext] = useState(initial.context);
  const [server, setServer] = useState<{
    doc: string;
    check: StudioCheckResult;
  } | null>(() => ({
    doc: JSON.stringify(initial.draft),
    check: initial.check,
  }));
  const [save, setSave] = useState<SaveState>('saved');
  const [stale, setStale] = useState(false);
  const [proEnded, setProEnded] = useState(false);
  const rev = useRef(initial.rev);
  const [shownRev, setShownRev] = useState(initial.rev);
  const latest = useRef(initial.draft);
  const saved = useRef(JSON.stringify(initial.draft));
  const inFlight = useRef(false);
  const blocked = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const adopt = useCallback((studio: MyStudio) => {
    rev.current = studio.rev;
    setShownRev(studio.rev);
    setPublished(studio.published);
    setContext(studio.context);
    setServer({ doc: JSON.stringify(studio.draft), check: studio.check });
  }, []);

  // One save at a time, each on the revision the last one returned. Edits made while a save was on
  // its way go in the next round, until the saved draft is the latest.
  const send = useCallback(async () => {
    if (inFlight.current || blocked.current) return;
    inFlight.current = true;
    try {
      for (;;) {
        const doc = latest.current;
        const body = JSON.stringify(doc);
        if (body === saved.current) {
          setSave('saved');
          return;
        }
        setSave('saving');
        const result = await apiFetch<MyStudio>('/v1/me/studio/draft', {
          method: 'PUT',
          body: { rev: rev.current, draft: doc },
        });
        if (!result.ok) {
          if (result.code === 'STUDIO_DRAFT_STALE') {
            blocked.current = true;
            setStale(true);
          } else if (result.code === 'STUDIO_PRO_REQUIRED') {
            blocked.current = true;
            setProEnded(true);
          }
          setSave('failed');
          return;
        }
        saved.current = body;
        adopt(result.data);
      }
    } finally {
      inFlight.current = false;
    }
  }, [adopt]);

  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    setSave('pending');
    timer.current = setTimeout(() => void send(), SAVE_AFTER_MS);
  }, [send]);

  const change = useCallback(
    (next: StudioDocument) => {
      if (blocked.current) return;
      latest.current = next;
      setDraft(next);
      schedule();
    },
    [schedule],
  );

  const fix = useCallback(
    (issue: StudioIssue, fixId: string) =>
      change(applyStudioFix(latest.current, issue, fixId)),
    [change],
  );

  const reload = useCallback(async () => {
    const result = await apiFetch<MyStudio>('/v1/me/studio');
    if (!result.ok) return;
    clearTimeout(timer.current);
    blocked.current = result.data.access !== 'edit';
    latest.current = result.data.draft;
    saved.current = JSON.stringify(result.data.draft);
    setDraft(result.data.draft);
    adopt(result.data);
    setStale(false);
    setProEnded(result.data.access !== 'edit');
    setSave('saved');
  }, [adopt]);

  // Leaving with an edit not yet saved: save it now (another dashboard page, or closing the tab,
  // when the browser also asks first).
  useEffect(() => {
    const unsaved = () => saved.current !== JSON.stringify(latest.current);
    const warn = (event: BeforeUnloadEvent) => {
      if (!unsaved()) return;
      void send();
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    const pending = timer;
    return () => {
      window.removeEventListener('beforeunload', warn);
      clearTimeout(pending.current);
      if (unsaved()) void send();
    };
  }, [send]);

  const local = useMemo(() => checkDesign(draft, context), [draft, context]);
  return {
    draft,
    rev: shownRev,
    published,
    save,
    stale,
    proEnded,
    check: checkShown(draft, local, server),
    change,
    fix,
    retry: () => void send(),
    reload,
  };
}
