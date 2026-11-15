'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  type DragEvent,
} from 'react';
import { Button, Lamp } from '@tipme/ui';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  cropRect,
  imagePlacement,
  initialView,
  outputSize,
  panBy,
  zoomTo,
  type CropView,
  type Size,
} from '@/lib/image-crop';
import { PHOTO_LIMIT_BYTES, photoErrors } from '@/lib/photo-errors';

// One picker for the page photo, a business logo and the cover (owner, 14 Nov 2026; board
// "One photo picker"). A real button opens the file chooser; on a desktop a file can be dropped on
// it too. The chosen picture opens in a position-and-zoom step at its final shape, and nothing is
// sent until Save. The crop is drawn in the browser and handed to the caller, which shrinks it,
// checks its size and calls the same API as before. The server still re-encodes whatever arrives.

export type PickerKind = 'photo' | 'logo' | 'cover';

/** What the caller's save came to; `retry` offers "Try again" with the same image and frame. */
export type PickerOutcome =
  { ok: true } | { ok: false; message: string; retry?: boolean };

/** A failed API answer in plain words: the photo errors, or "try again" for anything else. */
export function pickerFailure(code: string): PickerOutcome {
  const known = photoErrors[code];
  return known
    ? { ok: false, message: known }
    : {
        ok: false,
        message: 'We couldn’t save that. Please try again.',
        retry: true,
      };
}

const ACCEPT = 'image/jpeg,image/png,image/webp';

const WORDS = {
  photo: {
    choose: 'Choose a photo',
    change: 'Change photo',
    saving: 'Saving your photo…',
    frame: 'Photo position',
  },
  logo: {
    choose: 'Choose a logo',
    change: 'Change logo',
    saving: 'Saving your logo…',
    frame: 'Logo position',
  },
  cover: {
    choose: 'Upload a cover',
    change: 'Change cover',
    saving: 'Saving your cover…',
    frame: 'Cover position',
  },
} as const;

/** The stored shapes: photos and logos 512 square, covers 2240 x 600 (the API's re-encode sizes). */
const ASPECT: Record<PickerKind, number> = {
  photo: 1,
  logo: 1,
  cover: 2240 / 600,
};
/** The longest side sent: more than the server keeps, so its re-encode stays sharp. */
const OUTPUT_MAX: Record<PickerKind, number> = {
  photo: 1024,
  logo: 1024,
  cover: 2240,
};

const ZOOM_STEP = 0.1;
/** Arrow keys move the picture by this share of the frame; with Shift, by more. */
const NUDGE = 0.02;
const NUDGE_BIG = 0.1;

const FINE_POINTER = '(hover: hover) and (pointer: fine)';
const subscribeFine = (changed: () => void) => {
  const query = window.matchMedia(FINE_POINTER);
  query.addEventListener('change', changed);
  return () => query.removeEventListener('change', changed);
};
/** Drag and drop is offered only with a mouse or trackpad; on a phone the button does the job. */
const useFinePointer = () =>
  useSyncExternalStore(
    subscribeFine,
    () => window.matchMedia(FINE_POINTER).matches,
    () => false,
  );

type Editing = { url: string; size: Size; type: string };

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      img.naturalWidth > 0 && img.naturalHeight > 0
        ? resolve(img)
        : reject(new Error('empty'));
    img.onerror = () => reject(new Error('undecodable'));
    img.src = url;
  });
}

/** The chosen part of the picture at the size sent. The browser has already turned it upright. */
async function renderCrop(
  img: HTMLImageElement,
  kind: PickerKind,
  view: CropView,
  keepsAlpha: boolean,
): Promise<Blob | null> {
  const size = { width: img.naturalWidth, height: img.naturalHeight };
  const rect = cropRect(size, ASPECT[kind], view);
  const out = outputSize(rect, OUTPUT_MAX[kind]);
  const canvas = document.createElement('canvas');
  canvas.width = out.width;
  canvas.height = out.height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    img,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    out.width,
    out.height,
  );
  return new Promise((resolve) =>
    canvas.toBlob(
      resolve,
      keepsAlpha ? 'image/png' : 'image/jpeg',
      keepsAlpha ? undefined : 0.92,
    ),
  );
}

/** The page's initials, as the page shows them until a photo is added. */
export function PickerInitials({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .map((part) => Array.from(part)[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <span
      className="image-picker__initials"
      role="img"
      aria-label={`Your initials, ${initials}`}
    >
      {initials}
    </span>
  );
}

export function ImagePicker({
  kind,
  hasImage,
  tile,
  limits,
  onSave,
  remove,
  status = '',
  error: outsideError = '',
  disabled = false,
  keepAlpha = false,
  buttonRef,
}: {
  kind: PickerKind;
  /** Whether there is a saved image now: the button then reads "Change …". */
  hasImage: boolean;
  /** What the page shows now: the image, the initials, the letter or the cover. */
  tile: ReactNode;
  /** One line: the formats, the 5 MB limit and what TipMe does to the picture. */
  limits: string;
  /** Shrinks, checks and sends the cropped picture; the caller shows its own success line. */
  onSave: (picture: Blob) => Promise<PickerOutcome>;
  /** The quiet Remove button, as today. */
  remove?: { label: string; onRemove: () => void };
  /** The caller's saved or removed line, announced politely. */
  status?: string;
  /** An error from the caller's own action (a failed Remove), shown on the same line. */
  error?: string;
  disabled?: boolean;
  /** A logo that may be see-through is sent as PNG, so its transparency survives. */
  keepAlpha?: boolean;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const id = useId();
  const words = WORDS[kind];
  const aspect = ASPECT[kind];
  const fine = useFinePointer();
  const ownButton = useRef<HTMLButtonElement>(null);
  const button = buttonRef ?? ownButton;
  const input = useRef<HTMLInputElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [view, setView] = useState<CropView>(initialView);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState<Blob | null>(null);
  const [dropping, setDropping] = useState(false);
  const refocus = useRef<'button' | 'frame' | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const busy = disabled || saving;
  const shownError = error || outsideError;

  // Focus follows the step: into the frame when it opens, back to the button when it closes.
  useEffect(() => {
    if (refocus.current === 'frame' && editing) frame.current?.focus();
    else if (refocus.current === 'button' && !editing && !busy)
      button.current?.focus();
    else return;
    refocus.current = null;
  }, [editing, busy, button]);
  useEffect(
    () => () => {
      if (editing) URL.revokeObjectURL(editing.url);
    },
    [editing],
  );
  useEffect(
    () => () => {
      if (pending) URL.revokeObjectURL(pending);
    },
    [pending],
  );

  const open = async (file: File) => {
    setError('');
    setRetry(null);
    const url = URL.createObjectURL(file);
    try {
      if (!ACCEPT.split(',').includes(file.type)) throw new Error('type');
      const img = await loadImage(url);
      picture.current = img;
      setView(initialView());
      refocus.current = 'frame';
      setEditing({
        url,
        size: { width: img.naturalWidth, height: img.naturalHeight },
        type: file.type,
      });
    } catch {
      URL.revokeObjectURL(url);
      // Checked here, before the position step: a file that can't be shown can't be sent.
      setError(
        file.type.startsWith('image/') && file.size > PHOTO_LIMIT_BYTES
          ? photoErrors['PAYLOAD_TOO_LARGE']!
          : photoErrors['INVALID_IMAGE']!,
      );
    }
  };

  const send = async (blob: Blob) => {
    setSaving(true);
    setError('');
    setRetry(null);
    setPending(URL.createObjectURL(blob));
    const outcome = await onSave(blob);
    setSaving(false);
    setPending(null);
    refocus.current = 'button';
    if (!outcome.ok) {
      setError(outcome.message);
      if (outcome.retry) setRetry(blob);
    }
  };

  const cancel = () => {
    refocus.current = 'button';
    setEditing(null);
  };

  const save = async () => {
    const img = picture.current;
    if (!editing || !img) return;
    const blob = await renderCrop(
      img,
      kind,
      view,
      keepAlpha && editing.type !== 'image/jpeg',
    );
    setEditing(null);
    if (!blob) {
      refocus.current = 'button';
      setError('We couldn’t prepare that picture. Please try another.');
      return;
    }
    await send(blob);
  };

  const move = (dx: number, dy: number) =>
    editing && setView((v) => panBy(editing.size, aspect, v, dx, dy));
  const zoom = (next: number) =>
    editing && setView((v) => zoomTo(editing.size, aspect, v, next));

  const onFrameKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? NUDGE_BIG : NUDGE;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const by = moves[event.key];
    if (by) {
      event.preventDefault();
      move(by[0], by[1]);
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoom(view.zoom + ZOOM_STEP);
    } else if (event.key === '-') {
      event.preventDefault();
      zoom(view.zoom - ZOOM_STEP);
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser no longer tracks: the move still arrives here.
    }
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        distance: Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1,
        zoom: view.zoom,
      };
    }
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const last = pointers.current.get(event.pointerId);
    const box = frame.current?.getBoundingClientRect();
    if (!last || !box || box.width === 0) return;
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      zoom(pinch.current.zoom * (distance / pinch.current.distance));
      return;
    }
    move(
      (event.clientX - last.x) / box.width,
      (event.clientY - last.y) / box.height,
    );
  };
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  const canDrop = (event: DragEvent) =>
    fine && !busy && !editing && event.dataTransfer.types.includes('Files');
  const dropProps = {
    onDragEnter: (event: DragEvent<HTMLDivElement>) => {
      if (!canDrop(event)) return;
      event.preventDefault();
      setDropping(true);
    },
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (!canDrop(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => {
      // Only when leaving the box itself, not moving between its children.
      if (!event.currentTarget.contains(event.relatedTarget as Node | null))
        setDropping(false);
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      setDropping(false);
      if (!canDrop(event)) return;
      event.preventDefault();
      const file = event.dataTransfer.files[0];
      if (file) void open(file);
    },
  };

  const describedBy = [`${id}-limits`, shownError ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');

  // Visually hidden, never display:none, and in the page in every state; the button opens it.
  const fileInput = (
    <input
      ref={input}
      type="file"
      className="sr-only"
      accept={ACCEPT}
      tabIndex={-1}
      aria-hidden="true"
      disabled={busy}
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) void open(file);
      }}
    />
  );

  if (editing) {
    const place = imagePlacement(editing.size, aspect, view);
    const placed = {
      left: `${place.left}%`,
      top: `${place.top}%`,
      width: `${place.width}%`,
      height: `${place.height}%`,
    };
    return (
      <>
        <div
          className={`image-picker-crop image-picker-crop--${kind}`}
          role="group"
          aria-labelledby={`${id}-crop-title`}
        >
          <p className="image-picker-crop__title" id={`${id}-crop-title`}>
            Position your {kind}
          </p>
          <div
            className="image-picker-crop__stage"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
          >
            <div
              ref={frame}
              className="image-picker-crop__frame"
              style={{ aspectRatio: String(aspect) }}
              role="application"
              aria-label={words.frame}
              aria-describedby={`${id}-crop-hint`}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Escape') cancel();
                else onFrameKey(event);
              }}
            >
              {/* A private blob of the chosen file: the image optimiser has no part in it. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={editing.url}
                alt=""
                draggable={false}
                className="image-picker-crop__image"
                data-testid="image-picker-crop-image"
                style={placed}
              />
              <span className="image-picker-crop__window" aria-hidden="true" />
            </div>
            <span className="image-picker-crop__tip" aria-hidden="true">
              {fine ? 'Drag to move' : 'Drag to move · pinch to zoom'}
            </span>
          </div>
          <p className="sr-only" id={`${id}-crop-hint`}>
            Drag the picture, or use the arrow keys, to choose what shows. Hold
            Shift to move further.
          </p>
          <div className="image-picker-crop__zoom">
            <label htmlFor={`${id}-zoom`}>Zoom</label>
            <button
              type="button"
              className="image-picker-crop__zoom-key"
              aria-label="Zoom out"
              disabled={view.zoom <= MIN_ZOOM}
              onClick={() => zoom(view.zoom - ZOOM_STEP * 2)}
            >
              −
            </button>
            <input
              id={`${id}-zoom`}
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={ZOOM_STEP}
              value={Math.round(view.zoom * 10) / 10}
              aria-valuetext={`${Math.round(view.zoom * 100)}%`}
              onChange={(event) => zoom(Number(event.target.value))}
            />
            <button
              type="button"
              className="image-picker-crop__zoom-key"
              aria-label="Zoom in"
              disabled={view.zoom >= MAX_ZOOM}
              onClick={() => zoom(view.zoom + ZOOM_STEP * 2)}
            >
              +
            </button>
          </div>
          {kind !== 'cover' && (
            <div className="image-picker-crop__looks" aria-hidden="true">
              {kind === 'photo' && (
                <figure>
                  <span className="image-picker-crop__look image-picker-crop__look--round">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={editing.url} alt="" style={placed} />
                  </span>
                  <figcaption>Your page</figcaption>
                </figure>
              )}
              <figure>
                <span className="image-picker-crop__look">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={editing.url} alt="" style={placed} />
                </span>
                <figcaption>The saved square</figcaption>
              </figure>
            </div>
          )}
          <p className="tm-hint image-picker-crop__note">
            Nothing changes on your page until you save.
          </p>
          <div className="image-picker-crop__actions">
            <Button onClick={() => void save()}>Save</Button>
            <Button variant="secondary" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </div>
        {fileInput}
      </>
    );
  }

  return (
    <div className="image-picker-wrap">
      <div
        className={`image-picker image-picker--${kind}`}
        data-testid="image-picker"
        data-fine={fine ? 'true' : undefined}
        data-dropping={dropping ? 'true' : undefined}
        {...dropProps}
      >
        <div
          className={`image-picker__tile image-picker__tile--${kind}`}
          aria-busy={saving || undefined}
        >
          {tile}
          {pending && (
            // The cropped picture being saved, shown at once; if saving fails the old one returns.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={pending} alt="" className="image-picker__pending" />
          )}
          {saving && (
            <span className="image-picker__busy" aria-hidden="true">
              <span className="image-picker__ring" />
            </span>
          )}
        </div>
        {dropping ? (
          <div className="image-picker__controls image-picker__controls--drop">
            <p className="image-picker__drop-title">
              Drop it to use this {kind}
            </p>
            <p className="image-picker__limits">
              You’ll see it before it goes live.
            </p>
          </div>
        ) : (
          <div className="image-picker__controls">
            <Button
              ref={button}
              className="image-picker__button"
              disabled={busy}
              aria-busy={saving || undefined}
              aria-describedby={describedBy}
              onClick={() => input.current?.click()}
            >
              {!hasImage && (
                <svg
                  viewBox="0 0 16 16"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M8 11V3M4.5 6.5 8 3l3.5 3.5M3 13h10" />
                </svg>
              )}
              {hasImage ? words.change : words.choose}
            </Button>
            {fine && <span className="image-picker__or">or drag one here</span>}
            {remove && hasImage && (
              <Button
                variant="quiet"
                className="image-picker__remove"
                disabled={busy}
                onClick={() => {
                  refocus.current = 'button';
                  setError('');
                  setRetry(null);
                  remove.onRemove();
                }}
              >
                {remove.label}
              </Button>
            )}
          </div>
        )}
        {fileInput}
      </div>
      <p className="image-picker__limits" id={`${id}-limits`}>
        {limits}
      </p>
      {shownError && (
        <div className="image-picker__error">
          <p className="tm-field-error" role="alert" id={`${id}-error`}>
            <Lamp tone="red" />
            {shownError}
          </p>
          {retry && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void send(retry)}
            >
              Try again
            </Button>
          )}
        </div>
      )}
      {/* Always present, so screen readers announce what is written into it. */}
      <p role="status" className="tm-hint image-picker__status">
        {saving ? words.saving : status}
      </p>
    </div>
  );
}
