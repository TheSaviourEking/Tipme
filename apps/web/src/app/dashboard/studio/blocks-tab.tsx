'use client';
import Link from 'next/link';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import {
  STUDIO_LIMITS as L,
  type StudioBlock,
  type StudioDocument,
  type StudioImage,
} from '@tipme/contracts';
import { Button } from '@tipme/ui';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  ImagePicker,
  pickerFailure,
  type PickerOutcome,
} from '@/components/image-picker/image-picker';
import { PHOTO_LIMIT_BYTES, photoErrors } from '@/lib/photo-errors';
import { shrinkPhoto } from '@/lib/shrink-photo';
import {
  BlockForm,
  PHOTO_LIMITS,
  VideoLinkField,
  type SavePhoto,
} from './block-forms';
import {
  KIND_LABEL,
  addBlock,
  addKinds,
  addReasons,
  blockCounts,
  blockSummary,
  freshId,
  hasContent,
  lockedRows,
  moveBlock,
  moveBlockTo,
  movedWords,
  newBlock,
  removeBlock,
  updateBlock,
  type FixField,
} from './blocks-model';
import { ICONS, ProPill } from './segmented';

/** Studio photos are kept whole, up to 2400 px (the API's master), so shrinking starts there. */
const STUDIO_SHRINK_MAX = 2400;

/** The API's photo refusals in plain words. */
const STUDIO_PHOTO_ERRORS: Record<string, string> = {
  IMAGE_TOO_SMALL:
    'This photo is too small. Choose one at least 600 pixels on its shortest side, so it looks sharp on every screen.',
  STUDIO_IMAGE_LIMIT:
    'Your page keeps up to 48 photos, draft and published together. Remove photos you no longer use, publish, then try again.',
};

/** Where the design check sent the person (a fix that needs their input), once per press. */
export interface BlocksTarget {
  block: string;
  field: FixField;
  /** Bumped on every press, so the same fix twice still moves focus. */
  n: number;
}

/**
 * The Blocks tab on v2 (styles spec §10, "The Blocks tab"): one ordered list. TipMe's own parts
 * are locked rows at the top ("Cover, name and bio", "Tip", and "Your links" when there are
 * links), which can't be moved or removed. Blocks move by drag, with Up and Down, or with the
 * arrow keys on the focused block, and the live region says where each went in G2's words. The
 * style decides how every block looks: no columns, spacing, backgrounds or variants. "Add a block"
 * has no Links (profile links are fixed) and marks Pro kinds PRO for Free, who can't add them.
 */
export function BlocksTab({
  draft,
  plan,
  update,
  readOnly,
  images,
  upload,
  links,
  target,
}: {
  draft: StudioDocument;
  plan: 'free' | 'pro';
  update(fn: (doc: StudioDocument) => StudioDocument): void;
  readOnly: boolean;
  images: StudioImage[];
  upload(file: Blob): Promise<{ imageId: string } | { code: string }>;
  /** The number of saved profile links (the "Your links" row shows only with some). */
  links: number;
  target: BlocksTarget | null;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [openBlock, setOpenBlock] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const [confirm, setConfirm] = useState<StudioBlock | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  /** A control to focus after the next render (blocks re-render in a new order). */
  const focusNext = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (!focusNext.current) return;
    const el = root.current?.querySelector<HTMLElement>(focusNext.current);
    focusNext.current = null;
    el?.focus();
  });

  // A design check fix that needs input: open its block, then focus the field.
  const [handled, setHandled] = useState(0);
  if (target && target.n !== handled) {
    setHandled(target.n);
    setOpenBlock(target.block);
  }
  useEffect(() => {
    if (!target) return;
    const el = root.current?.querySelector<HTMLElement>(
      `[data-block="${target.block}"] [data-field="${target.field}"]`,
    );
    const focusable = el?.matches('input, textarea, button, select')
      ? el
      : el?.querySelector<HTMLElement>('button, input, textarea');
    focusable?.focus();
    focusable?.scrollIntoView({ block: 'center' });
  }, [target]);

  const savePhoto: SavePhoto = async (picture, place) => {
    // Sent whole when it can be: the server cuts every shape around a focal point.
    const file =
      picture.size > PHOTO_LIMIT_BYTES
        ? await shrinkPhoto(picture, STUDIO_SHRINK_MAX)
        : picture;
    if (file.size > PHOTO_LIMIT_BYTES)
      return { ok: false, message: photoErrors['PAYLOAD_TOO_LARGE']! };
    const result = await upload(file);
    if ('code' in result) {
      const known = STUDIO_PHOTO_ERRORS[result.code];
      return known
        ? ({ ok: false, message: known } satisfies PickerOutcome)
        : pickerFailure(result.code);
    }
    place(result.imageId);
    return { ok: true };
  };

  const photoReason =
    blockCounts(draft).images >= L.pageImages
      ? `Your page has ${L.pageImages} photos, the most it can have.`
      : null;
  const total = draft.blocks.length;

  /** Moves the block at `from` to `to`, says where it went, and keeps focus on its handle. */
  const shift = (from: number, to: number) => {
    const block = draft.blocks[from];
    if (!block || to < 0 || to >= total || from === to || readOnly) return;
    update((doc) => moveBlockTo(doc, from, to));
    setSaid(movedWords(block.kind, to, total));
    focusNext.current = `[data-block="${block.id}"] [data-block-handle]`;
  };

  const step = (block: StudioBlock, index: number, to: 'up' | 'down') => {
    if (!moveBlock(draft, block.id, to)) {
      setSaid(`Already ${to === 'up' ? 'first' : 'last'}.`);
      return;
    }
    shift(index, index + (to === 'up' ? -1 : 1));
  };

  const keys = (event: KeyboardEvent, block: StudioBlock, index: number) => {
    const to =
      event.key === 'ArrowUp'
        ? 'up'
        : event.key === 'ArrowDown'
          ? 'down'
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? total - 1
              : null;
    if (to === null) return;
    event.preventDefault();
    if (typeof to === 'number') shift(index, to);
    else step(block, index, to);
  };

  const onDrop = (event: DragEvent, to: number) => {
    event.preventDefault();
    if (dragging !== null) shift(dragging, to);
    setDragging(null);
  };

  const remove = (block: StudioBlock) => {
    update((doc) => removeBlock(doc, block.id));
    setSaid(`${KIND_LABEL[block.kind]} removed`);
    focusNext.current = '[data-add-block]';
  };

  return (
    <div ref={root} className="pst-blocks">
      <div className="pst-section__head">
        <h2>Blocks</h2>
        <span>
          {total} of {L.blocks}
        </span>
      </div>
      <p className="pst-note">
        Your page shows them in this order. Your style decides how each one
        looks.
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {said}
      </p>
      <p id={`${id}-move-hint`} className="sr-only">
        Up and Down arrow keys move it. Home and End move it first or last.
      </p>
      <ul className="pst-locked-rows" aria-label="Always on your page">
        {lockedRows(links).map((row) => (
          <li key={row.key} className="pst-block pst-block--locked">
            <span className="pst-block__lock">{ICONS.lock}</span>
            <span className="pst-block__words">
              <b>{row.title}</b>
              <span>
                {row.detail.replace(' Change them in Settings.', '')}
                {row.key === 'links' && (
                  <>
                    {' '}
                    <Link href="/dashboard/settings#page">
                      Change them in Settings.
                    </Link>
                  </>
                )}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {total === 0 ? (
        <p className="pst-note">No blocks yet. Add one below.</p>
      ) : (
        <ol className="pst-block-list" aria-label="Your blocks">
          {draft.blocks.map((block, index) => (
            <li
              key={block.id}
              data-block={block.id}
              className="pst-block"
              data-open={openBlock === block.id || undefined}
              data-dragging={dragging === index || undefined}
              onDragOver={(e) => {
                if (dragging !== null) e.preventDefault();
              }}
              onDrop={(e) => onDrop(e, index)}
            >
              <div className="pst-block__head">
                <span
                  className="pst-block__grip"
                  draggable={!readOnly}
                  aria-hidden="true"
                  title="Drag to move"
                  data-block-grip
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', block.id);
                    setDragging(index);
                  }}
                  onDragEnd={() => setDragging(null)}
                >
                  {ICONS.grip}
                </span>
                <button
                  type="button"
                  className="pst-block__toggle"
                  aria-expanded={openBlock === block.id}
                  aria-describedby={`${id}-move-hint`}
                  data-block-handle
                  onClick={() =>
                    setOpenBlock(openBlock === block.id ? null : block.id)
                  }
                  onKeyDown={(e) => keys(e, block, index)}
                >
                  <b>{KIND_LABEL[block.kind]}</b>{' '}
                  <span>{blockSummary(block)}</span>
                </button>
                <div className="pst-actions">
                  <Button
                    variant="quiet"
                    aria-label={`Move ${KIND_LABEL[block.kind]} up`}
                    disabled={readOnly || index === 0}
                    onClick={() => step(block, index, 'up')}
                  >
                    Up
                  </Button>
                  <Button
                    variant="quiet"
                    aria-label={`Move ${KIND_LABEL[block.kind]} down`}
                    disabled={readOnly || index === total - 1}
                    onClick={() => step(block, index, 'down')}
                  >
                    Down
                  </Button>
                  <Button
                    variant="quiet"
                    aria-label={`Remove ${KIND_LABEL[block.kind]}`}
                    disabled={readOnly}
                    onClick={() =>
                      hasContent(block) ? setConfirm(block) : remove(block)
                    }
                  >
                    Remove
                  </Button>
                </div>
              </div>
              {openBlock === block.id && (
                <fieldset className="pst-block__form" disabled={readOnly}>
                  <legend className="sr-only">
                    {KIND_LABEL[block.kind]} block
                  </legend>
                  <BlockForm
                    block={block}
                    images={images}
                    savePhoto={savePhoto}
                    photoReason={photoReason}
                    onChange={(next) =>
                      update((doc) => updateBlock(doc, block.id, () => next))
                    }
                  />
                </fieldset>
              )}
            </li>
          ))}
        </ol>
      )}
      <AddBlock
        draft={draft}
        plan={plan}
        readOnly={readOnly}
        savePhoto={savePhoto}
        onAdd={(block) => {
          update((doc) => addBlock(doc, block));
          setOpenBlock(block.id);
          setSaid(`${KIND_LABEL[block.kind]} added`);
          focusNext.current = `[data-block="${block.id}"] [data-block-handle]`;
        }}
      />
      {confirm && (
        <ConfirmDialog
          title={`Remove this ${KIND_LABEL[confirm.kind].toLowerCase()} block?`}
          confirm="Remove"
          onConfirm={() => {
            remove(confirm);
            setConfirm(null);
          }}
          onCancel={() => setConfirm(null)}
        >
          What you wrote or chose in it goes too. Your published page doesn’t
          change until you publish.
        </ConfirmDialog>
      )}
    </div>
  );
}

function AddBlock({
  draft,
  plan,
  readOnly,
  savePhoto,
  onAdd,
}: {
  draft: StudioDocument;
  plan: 'free' | 'pro';
  readOnly: boolean;
  savePhoto: SavePhoto;
  onAdd(block: StudioBlock): void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<
    'photo' | 'video' | { pro: string } | null
  >(null);
  const reasons = addReasons(draft);
  const close = () => {
    setOpen(false);
    setPending(null);
  };
  if (reasons.all)
    return (
      <p className="pst-note" data-add-full>
        {reasons.all}
      </p>
    );
  return (
    <div className="pst-add">
      <Button
        variant="secondary"
        data-add-block
        aria-expanded={open}
        aria-controls={`${id}-kinds`}
        disabled={readOnly}
        onClick={() => (open ? close() : setOpen(true))}
      >
        Add a block
      </Button>
      {open && (
        <div id={`${id}-kinds`} className="pst-add__panel">
          {pending === 'photo' ? (
            <div className="pst-picker">
              <ImagePicker
                kind="photo"
                frame={false}
                hasImage={false}
                tile={<span className="pst-thumb" />}
                limits={PHOTO_LIMITS}
                onSave={(picture) =>
                  savePhoto(picture, (imageId) => {
                    close();
                    onAdd(newBlock('photo', freshId(draft), { imageId }));
                  })
                }
              />
              <Button variant="quiet" onClick={() => setPending(null)}>
                Back to the list
              </Button>
            </div>
          ) : pending === 'video' ? (
            <>
              <VideoLinkField
                value=""
                action="Add the video"
                onValid={(url) => {
                  close();
                  onAdd(newBlock('video', freshId(draft), { url }));
                }}
              />
              <Button variant="quiet" onClick={() => setPending(null)}>
                Back to the list
              </Button>
            </>
          ) : pending ? (
            // A Pro kind on Free: what it needs, and the way to Pro. Nothing is added.
            <div
              className="pst-pro-sheet"
              role="group"
              aria-labelledby={`${id}-pro`}
            >
              <ProPill />
              <p id={`${id}-pro`}>{pending.pro} blocks come with Pro.</p>
              <div className="pst-actions">
                <Link className="tm-button tm-button--primary" href="/pro">
                  See Pro
                </Link>
                <Button variant="quiet" onClick={() => setPending(null)}>
                  Back to the list
                </Button>
              </div>
            </div>
          ) : (
            <ul className="pst-kinds" aria-label="Kinds of block">
              {addKinds(plan).map(({ kind, label, hint, pro }) => {
                const reason = reasons[kind];
                return (
                  <li key={kind}>
                    <button
                      type="button"
                      className="pst-kind"
                      aria-disabled={reason ? true : undefined}
                      aria-describedby={`${id}-${kind}`}
                      onClick={() => {
                        if (reason) return;
                        if (pro) {
                          setPending({ pro: label });
                          return;
                        }
                        if (kind === 'photo' || kind === 'video') {
                          setPending(kind);
                          return;
                        }
                        close();
                        onAdd(newBlock(kind, freshId(draft)));
                      }}
                    >
                      <b>{label}</b>
                      {pro && <ProPill />}
                    </button>
                    <small id={`${id}-${kind}`}>{reason ?? hint}</small>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
