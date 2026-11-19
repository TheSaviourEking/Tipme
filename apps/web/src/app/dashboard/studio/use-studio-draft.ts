'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyStudioFix,
  checkDesign,
  type MyStudio,
  type StudioCheckResult,
  type StudioDocument,
  type StudioImage,
  type StudioIssue,
} from '@tipme/contracts';
import { apiFetch } from '@/lib/session-client';
import {
  checkShown,
  publishOutcome,
  withRefusal,
  type PublishOutcome,
  type SaveState,
} from './studio-editor-model';
import {
  PRO_UNDO_REFUSED,
  afterRefusedUndo,
  createUndoStack,
  describeChange,
} from './undo-stack';

/** Edits settle this long before the draft is saved (plan Task 9). */
const SAVE_AFTER_MS = 800;

export interface StudioDraft {
  draft: StudioDocument;
  rev: number;
  /** The published version, as the server last said (always v2 now). */
  published: StudioDocument | null;
  save: SaveState;
  /** Another tab or device saved first (STUDIO_DRAFT_STALE): nothing more is saved here. */
  stale: boolean;
  /**
   * A save needed Pro (STUDIO_PRO_REQUIRED: the plan changed, or a change the server refuses on
   * Free). The screen goes back to the draft as last saved, and nothing more is saved until a
   * reload.
   */
  proRequired: boolean;
  /** This tab has edits the server doesn't have yet (or never will, once the draft is stale). */
  unsaved: boolean;
  /** Something to undo (§12.2), and what: "style changed to Clear". */
  canUndo: boolean;
  undoLabel: string | null;
  /**
   * A sentence about the last undo, when the server refused it: re-adding a Pro item on Free that
   * this session saved away (R4). Gone with the next change.
   */
  notice: string | null;
  /** The server's facts: the plan, the cover set in Settings, whether there is a profile photo. */
  context: MyStudio['context'];
  plan: MyStudio['plan'];
  photoAccent: MyStudio['photoAccent'];
  /** The editor's own check on every change; the server's once a save has checked this draft. */
  check: StudioCheckResult;
  /** The page's Studio photos, including ones uploaded in this editor (the preview draws these). */
  images: StudioImage[];
  change(next: StudioDocument): void;
  /** A change made from the latest draft (an edit that lands after an upload or a moment's wait). */
  update(fn: (doc: StudioDocument) => StudioDocument): void;
  fix(issue: StudioIssue, fixId: string): void;
  /**
   * Uploads a photo (`POST /v1/me/studio/images`): the id of the new image, or the API's error
   * code. It isn't on the page until a block or row uses it.
   */
  upload(file: Blob): Promise<{ imageId: string } | { code: string }>;
  /** Saves now (after a failure). */
  retry(): void;
  /** Drops this tab's edits for the latest saved draft: false when the latest couldn't be read. */
  reload(): Promise<boolean>;
  /**
   * Goes back one step (§12.2) and saves it at once, like any change. On Free, the server refuses a
   * step that re-adds a Pro item saved away this session (403): the draft stays as last saved, the
   * step stays undone, `notice` says why, and editing carries on.
   */
  undo(): void;
  /**
   * Throws the draft away (`DELETE /v1/me/studio/draft`, §12.3): it becomes the published version,
   * or Classic with no blocks. Undo is cleared. False when the server didn't do it.
   */
  discard(): Promise<boolean>;
  /**
   * Saves what is left, then publishes (`POST /v1/me/studio/publish`, §12.1): 'published', the
   * server's issues when its check refuses (422 STUDIO_DESIGN_CHECK_FAILED; they replace the
   * editor's until the next edit), or why it failed: the network (it may have gone through),
   * another tab saved first, Studio switched off (404), or anything else (not saved included).
   */
  publish(): Promise<PublishOutcome>;
}

/**
 * The draft being edited (plan Task 9's `useStudioDraft`, G1 part): the document, the design check
 * on every change, and a debounced save to `PUT /v1/me/studio/draft` naming the revision it was
 * based on. Saving never needs a passing check; publishing does (§12.1). Undo (§12.2) is an
 * in-memory stack of earlier drafts; discard (§12.3) goes back to the published version.
 */
export function useStudioDraft(initial: MyStudio): StudioDraft {
  const [draft, setDraft] = useState(initial.draft);
  const [published, setPublished] = useState(initial.published);
  /** `published`, for the save loop (what a refused undo may restore from, §11). */
  const publishedNow = useRef(initial.published);
  const [context, setContext] = useState(initial.context);
  const [plan, setPlan] = useState(initial.plan);
  const [photoAccent, setPhotoAccent] = useState(initial.photoAccent);
  const [images, setImages] = useState(initial.images);
  const imagesNow = useRef(initial.images);
  const [server, setServer] = useState<{
    doc: string;
    check: StudioCheckResult;
  } | null>(() => ({
    doc: JSON.stringify(initial.draft),
    check: initial.check,
  }));
  const [save, setSave] = useState<SaveState>('saved');
  const [stale, setStale] = useState(false);
  const [proRequired, setProRequired] = useState(false);
  /** The server's issues for the draft it refused to publish, until the next edit. */
  const [refused, setRefused] = useState<{
    doc: string;
    issues: StudioIssue[];
  } | null>(null);
  const rev = useRef(initial.rev);
  const [shownRev, setShownRev] = useState(initial.rev);
  const latest = useRef(initial.draft);
  const saved = useRef(JSON.stringify(initial.draft));
  /** `saved`, for rendering (whether this tab has unsaved edits). */
  const [savedBody, setSavedBody] = useState(saved.current);
  const markSaved = useCallback((body: string) => {
    saved.current = body;
    setSavedBody(body);
  }, []);
  const stack = useRef(createUndoStack());
  const [undoLabel, setUndoLabel] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Set by an undo until a save that includes it is answered: a 403 STUDIO_PRO_REQUIRED for that
   * save is the undo refused (R4), not the read-only kind. A fresh object per undo.
   */
  const undoing = useRef<object | null>(null);
  /** A discard is on its way: edits and saves wait for it. */
  const discarding = useRef(false);
  const sending = useRef<Promise<void> | null>(null);
  const blocked = useRef(false);
  /** Blocked because another tab saved first (as opposed to a save that needed Pro). */
  const staleNow = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const adopt = useCallback((studio: MyStudio) => {
    rev.current = studio.rev;
    setShownRev(studio.rev);
    setPublished(studio.published);
    publishedNow.current = studio.published;
    setContext(studio.context);
    setPlan(studio.plan);
    setPhotoAccent(studio.photoAccent);
    imagesNow.current = studio.images;
    setImages(studio.images);
    setServer({ doc: JSON.stringify(studio.draft), check: studio.check });
  }, []);

  // One save at a time, each on the revision the last one returned. Edits made while a save was on
  // its way go in the next round, until the saved draft is the latest. A second caller waits for
  // the save already on its way (publishing does).
  const send = useCallback((): Promise<void> => {
    if (sending.current) return sending.current;
    if (blocked.current) return Promise.resolve();
    const round = (async () => {
      for (;;) {
        const doc = latest.current;
        const body = JSON.stringify(doc);
        // Whether this round carries an undo (it read the draft after one).
        const undo = undoing.current;
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
            staleNow.current = true;
            setStale(true);
          } else if (result.code === 'STUDIO_PRO_REQUIRED' && undo) {
            // An undo that re-adds a Pro item this session saved away (R4). Put back only what
            // the server wouldn't take, judged as the server judges it (held by the stored draft
            // or the published version), in the draft now (edits typed while this save was on its
            // way stay) and in every step left. Then save what is left, and keep editing.
            undoing.current = null;
            const kept = afterRefusedUndo(stack.current, latest.current, {
              draft: JSON.parse(saved.current) as StudioDocument,
              published: publishedNow.current,
            });
            latest.current = kept;
            setDraft(kept);
            setUndoLabel(stack.current.peek()?.label ?? null);
            setNotice(PRO_UNDO_REFUSED);
            continue;
          } else if (result.code === 'STUDIO_PRO_REQUIRED') {
            blocked.current = true;
            setProRequired(true);
            // The refused change never reached the server: show the draft as it was last saved,
            // so the screen and the preview say what "kept as it was last saved" says.
            const kept = JSON.parse(saved.current) as StudioDocument;
            latest.current = kept;
            setDraft(kept);
            setSave('saved');
            return;
          }
          setSave('failed');
          return;
        }
        markSaved(body);
        if (undo && undoing.current === undo) undoing.current = null;
        adopt(result.data);
      }
    })().finally(() => {
      sending.current = null;
    });
    sending.current = round;
    return round;
  }, [adopt, markSaved]);

  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    setSave('pending');
    timer.current = setTimeout(() => void send(), SAVE_AFTER_MS);
  }, [send]);

  const change = useCallback(
    (next: StudioDocument) => {
      if (blocked.current || discarding.current) return;
      const step = describeChange(latest.current, next);
      if (step) {
        stack.current.push(latest.current, step.label, step.field);
        setUndoLabel(stack.current.peek()?.label ?? null);
      }
      setNotice(null);
      latest.current = next;
      setDraft(next);
      schedule();
    },
    [schedule],
  );

  const update = useCallback(
    (fn: (doc: StudioDocument) => StudioDocument) => {
      const next = fn(latest.current);
      if (next !== latest.current) change(next);
    },
    [change],
  );

  const fix = useCallback(
    (issue: StudioIssue, fixId: string) =>
      change(applyStudioFix(latest.current, issue, fixId)),
    [change],
  );

  // A new photo changes the server's facts (its size, for the check) but not the draft or its rev.
  const upload = useCallback(async (file: Blob) => {
    const result = await apiFetch<MyStudio>('/v1/me/studio/images', {
      method: 'POST',
      file,
    });
    if (!result.ok) return { code: result.code };
    // The answer is the whole studio (`meta.imageId` names the new one, but the session client
    // reads only `data`): the new photo is the one this editor didn't have.
    const known = new Set(imagesNow.current.map((i) => i.imageId));
    const added = result.data.images.find((i) => !known.has(i.imageId));
    if (!added) return { code: 'UNKNOWN' };
    const imageId = added.imageId;
    imagesNow.current = result.data.images;
    setImages(result.data.images);
    setContext(result.data.context);
    return { imageId };
  }, []);

  /** Shows a draft the server just gave (the latest, or the one a discard left): nothing to undo. */
  const restart = useCallback(
    (studio: MyStudio) => {
      clearTimeout(timer.current);
      blocked.current = false;
      staleNow.current = false;
      undoing.current = null;
      latest.current = studio.draft;
      markSaved(JSON.stringify(studio.draft));
      setDraft(studio.draft);
      adopt(studio);
      stack.current.clear();
      setUndoLabel(null);
      setNotice(null);
      setRefused(null);
      setStale(false);
      setProRequired(false);
      setSave('saved');
    },
    [adopt, markSaved],
  );

  const reload = useCallback(async () => {
    const result = await apiFetch<MyStudio>('/v1/me/studio');
    if (!result.ok) return false;
    restart(result.data);
    return true;
  }, [restart]);

  const undo = useCallback(() => {
    if (blocked.current || discarding.current) return;
    const step = stack.current.pop();
    setUndoLabel(stack.current.peek()?.label ?? null);
    if (!step) return;
    setNotice(null);
    undoing.current = {};
    latest.current = step.doc;
    setDraft(step.doc);
    // Saved at once rather than after the pause, so a refusal (R4) can't take later edits with it.
    clearTimeout(timer.current);
    setSave('saving');
    void send();
  }, [send]);

  const discard = useCallback(async () => {
    if (discarding.current) return false;
    discarding.current = true;
    clearTimeout(timer.current);
    try {
      // A save on its way lands first, so it can't bring the draft back after the discard.
      if (sending.current) await sending.current;
      const result = await apiFetch<MyStudio>('/v1/me/studio/draft', {
        method: 'DELETE',
      });
      if (!result.ok) {
        // Nothing was thrown away: edits not yet saved go on saving.
        if (
          !blocked.current &&
          saved.current !== JSON.stringify(latest.current)
        )
          timer.current = setTimeout(() => void send(), SAVE_AFTER_MS);
        return false;
      }
      restart(result.data);
      return true;
    } finally {
      discarding.current = false;
    }
  }, [restart, send]);

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

  const publish = useCallback(async (): Promise<PublishOutcome> => {
    clearTimeout(timer.current);
    const unsaved = () =>
      blocked.current || saved.current !== JSON.stringify(latest.current);
    // A save on its way may end before an edit made meanwhile: one more round catches it.
    await send();
    if (unsaved()) await send();
    if (unsaved())
      return {
        failed: blocked.current && staleNow.current ? 'stale' : 'other',
      };
    const doc = saved.current;
    const result = await apiFetch<MyStudio>('/v1/me/studio/publish', {
      method: 'POST',
      body: { rev: rev.current },
    });
    const outcome = publishOutcome(result);
    if (result.ok) {
      setRefused(null);
      adopt(result.data);
    } else if (outcome !== 'published' && 'issues' in outcome) {
      setRefused({ doc, issues: outcome.issues });
    } else if (outcome !== 'published' && outcome.failed === 'stale') {
      blocked.current = true;
      staleNow.current = true;
      setStale(true);
    }
    return outcome;
  }, [adopt, send]);

  const local = useMemo(() => checkDesign(draft, context), [draft, context]);
  return {
    draft,
    rev: shownRev,
    published,
    save,
    stale,
    proRequired,
    unsaved: JSON.stringify(draft) !== savedBody,
    canUndo: undoLabel !== null,
    undoLabel,
    notice,
    context,
    plan,
    photoAccent,
    check: withRefusal(draft, checkShown(draft, local, server), refused),
    images,
    upload,
    change,
    update,
    fix,
    retry: () => void send(),
    reload,
    undo,
    discard,
    publish,
  };
}
