'use client';
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
  STUDIO_COLUMNS,
  STUDIO_SPACINGS,
  studioCounts,
  STUDIO_LIMITS as L,
  type StudioBlockV1,
  type StudioColumns,
  type StudioDocumentV1,
  type StudioImage,
  type StudioRowV1,
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
  Thumb,
  VideoLinkField,
  type SavePhoto,
} from './block-forms';
import {
  ADD_KINDS,
  COLUMN_LABEL,
  KIND_LABEL,
  addBlock,
  addReasons,
  addRow,
  blockSummary,
  findBlock,
  freshId,
  hasContent,
  moveBlock,
  moveRow,
  movedWords,
  newBlock,
  removeBlock,
  removeRow,
  rowReason,
  rowSummary,
  updateBlock,
  withBackground,
  withColumns,
  withSpacing,
  type BlockMove,
  type FixField,
} from './blocks-model';
import { Choice } from './style-tab';

/** Studio photos are kept whole, up to 2400 px (the API's master), so shrinking starts there. */
const STUDIO_SHRINK_MAX = 2400;

/** The API's photo refusals in plain words (Task 10 moves IMAGE_TOO_SMALL into photo-errors). */
const STUDIO_PHOTO_ERRORS: Record<string, string> = {
  IMAGE_TOO_SMALL:
    'This photo is too small. Choose one at least 600 pixels on its shortest side, so it looks sharp on every screen.',
  STUDIO_IMAGE_LIMIT:
    'Your page keeps up to 48 photos, draft and published together. Remove photos you no longer use, publish, then try again.',
};

/** Where the design check sent the person (a fix that needs their input), once per press. */
export interface BlocksTarget {
  row: string;
  block?: string;
  field: FixField;
  /** Bumped on every press, so the same fix twice still moves focus. */
  n: number;
}

type Confirm =
  | { kind: 'row'; row: StudioRowV1; index: number }
  | { kind: 'block'; block: StudioBlockV1 };

const BACKGROUND_LABEL = {
  page: 'Page',
  card: 'Card',
  colour: 'Colour',
  second: 'Second colour',
  photo: 'Photo',
} as const;

/**
 * The Blocks tab (plan Task 9b; StudioEditor board, "Blocks tab: rows and blocks"). A page is
 * rows; each row picks its columns, spacing and background from fixed choices, then holds blocks.
 * Rows move with Up and Down, by drag, or with the arrow keys on the focused row; blocks with Up
 * and Down (and Left and Right between columns), or the arrow keys on the focused block. TipMe's
 * own parts show as locked lines that can't be moved, styled or removed. Every limit is checked
 * here, with the reason, and again by the API.
 */
export function BlocksTab({
  draft,
  update,
  readOnly,
  images,
  upload,
  profile,
  target,
  onOpenRow,
}: {
  draft: StudioDocumentV1;
  update(fn: (doc: StudioDocumentV1) => StudioDocumentV1): void;
  readOnly: boolean;
  images: StudioImage[];
  upload(file: Blob): Promise<{ imageId: string } | { code: string }>;
  profile: { bio: boolean; links: number };
  target: BlocksTarget | null;
  /** The open row, for the preview's outline. */
  onOpenRow(rowId: string | null): void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [openRow, setOpenRow] = useState<string | null>(
    draft.rows[0]?.id ?? null,
  );
  const [openBlock, setOpenBlock] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  /** A control to focus after the next render (rows and blocks re-render in a new order). */
  const focusNext = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (!focusNext.current) return;
    const el = root.current?.querySelector<HTMLElement>(focusNext.current);
    focusNext.current = null;
    el?.focus();
  });

  useEffect(() => onOpenRow(openRow), [openRow, onOpenRow]);

  // A design check fix that needs input: open its row and block, then focus the field.
  const [handled, setHandled] = useState(0);
  if (target && target.n !== handled) {
    setHandled(target.n);
    setOpenRow(target.row);
    if (target.block) setOpenBlock(target.block);
  }
  useEffect(() => {
    if (!target) return;
    const scope = target.block
      ? `[data-block="${target.block}"]`
      : `[data-row="${target.row}"]`;
    const el = root.current?.querySelector<HTMLElement>(
      `${scope} [data-field="${target.field}"]`,
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

  const counts = studioCounts(draft);
  const photoReason =
    counts.images >= L.pageImages
      ? `Your page has ${L.pageImages} photos, the most it can have.`
      : null;
  const total = draft.rows.length;
  const tooMany = rowReason(draft);

  const shiftRow = (from: number, to: number) => {
    if (to < 0 || to >= total || from === to) return;
    const rowId = draft.rows[from]!.id;
    update((doc) => moveRow(doc, from, to));
    setSaid(movedWords(from, to, total));
    focusNext.current = `[data-row="${rowId}"] [data-row-handle]`;
  };

  const rowKeys = (event: KeyboardEvent, index: number) => {
    const to =
      event.key === 'ArrowUp'
        ? index - 1
        : event.key === 'ArrowDown'
          ? index + 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? total - 1
              : null;
    if (to === null) return;
    event.preventDefault();
    if (readOnly) return;
    shiftRow(index, to);
  };

  const shiftBlock = (block: StudioBlockV1, to: BlockMove, focus: string) => {
    const next = moveBlock(draft, block.id, to);
    if (!next) {
      setSaid(
        to === 'left' || to === 'right'
          ? `Can’t move it ${to}: there is no column there, or it’s full.`
          : `Already ${to === 'up' ? 'first' : 'last'} in its column.`,
      );
      return;
    }
    update((doc) => moveBlock(doc, block.id, to) ?? doc);
    const at = findBlock(next, block.id)!;
    const cols = at.row.cells.length;
    setSaid(
      `${KIND_LABEL[block.kind]}, moved to place ${at.k + 1} of ${at.row.cells[at.c]!.length}${cols > 1 ? ` in column ${at.c + 1}` : ''}`,
    );
    focusNext.current = `[data-block="${block.id}"] ${focus}`;
  };

  const blockKeys = (event: KeyboardEvent, block: StudioBlockV1) => {
    const to = (
      {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowLeft: 'left',
        ArrowRight: 'right',
      } as const
    )[event.key as 'ArrowUp'];
    if (!to) return;
    event.preventDefault();
    if (!readOnly) shiftBlock(block, to, '[data-block-handle]');
  };

  const onDrop = (event: DragEvent, to: number) => {
    event.preventDefault();
    if (dragging !== null) shiftRow(dragging, to);
    setDragging(null);
  };

  const removeConfirmed = () => {
    if (!confirm) return;
    if (confirm.kind === 'row') {
      update((doc) => removeRow(doc, confirm.row.id));
      setSaid(`Row ${confirm.index + 1} removed`);
      focusNext.current = '[data-add-row]';
    } else {
      update((doc) => removeBlock(doc, confirm.block.id));
      setSaid(`${KIND_LABEL[confirm.block.kind]} removed`);
    }
    setConfirm(null);
  };

  return (
    <div ref={root} className="pst-blocks">
      <h2 className="pst-label">Rows and blocks</h2>
      <p className="pst-hint">
        A page is rows. Each row picks its columns, then holds blocks. Spacing
        and backgrounds come from fixed choices.
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {said}
      </p>
      <p id={`${id}-move-hint`} className="sr-only">
        Up and Down arrow keys move it.
      </p>
      <Locked
        title="Name, photo, @username and badge"
        detail="Always TipMe. Can’t be moved, styled or removed."
      />
      <Locked
        title="Tip block and fee line"
        detail="Always TipMe. Can’t be moved, styled or removed. It sits beside your rows on wide screens and straight after your name on phones."
      />
      {total === 0 ? (
        <p className="pst-hint">No rows yet. Add one, then add blocks to it.</p>
      ) : (
        <ol className="pst-rows" aria-label="Your rows">
          {draft.rows.map((row, index) => (
            <li
              key={row.id}
              data-row={row.id}
              className="pst-row"
              data-open={openRow === row.id || undefined}
              data-dragging={dragging === index || undefined}
              onDragOver={(e) => {
                if (dragging !== null) e.preventDefault();
              }}
              onDrop={(e) => onDrop(e, index)}
            >
              <div className="pst-row__head">
                <span
                  className="pst-row__grip"
                  draggable={!readOnly}
                  aria-hidden="true"
                  title="Drag to move"
                  data-row-grip
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', row.id);
                    setDragging(index);
                  }}
                  onDragEnd={() => setDragging(null)}
                >
                  ⋮⋮
                </span>
                <button
                  type="button"
                  className="pst-row__toggle"
                  aria-expanded={openRow === row.id}
                  aria-describedby={`${id}-move-hint`}
                  data-row-handle
                  onClick={() => setOpenRow(openRow === row.id ? null : row.id)}
                  onKeyDown={(e) => rowKeys(e, index)}
                >
                  <b>Row {index + 1}</b> <span>{rowSummary(row)}</span>
                </button>
                <div className="pst-actions">
                  <Button
                    variant="quiet"
                    aria-label={`Move row ${index + 1} up`}
                    disabled={readOnly || index === 0}
                    onClick={() => shiftRow(index, index - 1)}
                  >
                    Up
                  </Button>
                  <Button
                    variant="quiet"
                    aria-label={`Move row ${index + 1} down`}
                    disabled={readOnly || index === total - 1}
                    onClick={() => shiftRow(index, index + 1)}
                  >
                    Down
                  </Button>
                </div>
              </div>
              {openRow === row.id && (
                <fieldset className="pst-row__body" disabled={readOnly}>
                  <legend className="sr-only">Row {index + 1}</legend>
                  <RowToolbar
                    row={row}
                    index={index}
                    draft={draft}
                    update={update}
                    images={images}
                    savePhoto={savePhoto}
                    photoReason={photoReason}
                  />
                  {row.cells.map((cell, c) => (
                    <section
                      key={c}
                      className="pst-cell"
                      aria-label={
                        row.cells.length > 1
                          ? `Row ${index + 1}, column ${c + 1}`
                          : `Row ${index + 1} blocks`
                      }
                    >
                      {row.cells.length > 1 && (
                        <h3 className="pst-label">Column {c + 1}</h3>
                      )}
                      {cell.length > 0 && (
                        <ul className="pst-block-list">
                          {cell.map((block, k) => (
                            <li
                              key={block.id}
                              data-block={block.id}
                              className="pst-block"
                            >
                              <div className="pst-block__head">
                                <button
                                  type="button"
                                  className="pst-block__toggle"
                                  aria-expanded={openBlock === block.id}
                                  aria-describedby={`${id}-block-hint`}
                                  data-block-handle
                                  onClick={() =>
                                    setOpenBlock(
                                      openBlock === block.id ? null : block.id,
                                    )
                                  }
                                  onKeyDown={(e) => blockKeys(e, block)}
                                >
                                  <b>{KIND_LABEL[block.kind]}</b>{' '}
                                  <span>{blockSummary(block)}</span>
                                </button>
                                <div className="pst-actions">
                                  <Button
                                    variant="quiet"
                                    aria-label={`Move ${KIND_LABEL[block.kind]} up`}
                                    disabled={k === 0}
                                    onClick={() =>
                                      shiftBlock(
                                        block,
                                        'up',
                                        '[data-block-handle]',
                                      )
                                    }
                                  >
                                    Up
                                  </Button>
                                  <Button
                                    variant="quiet"
                                    aria-label={`Move ${KIND_LABEL[block.kind]} down`}
                                    disabled={k === cell.length - 1}
                                    onClick={() =>
                                      shiftBlock(
                                        block,
                                        'down',
                                        '[data-block-handle]',
                                      )
                                    }
                                  >
                                    Down
                                  </Button>
                                  {row.cells.length > 1 && (
                                    <>
                                      <Button
                                        variant="quiet"
                                        aria-label={`Move ${KIND_LABEL[block.kind]} to the column on the left`}
                                        disabled={
                                          c === 0 ||
                                          row.cells[c - 1]!.length >=
                                            L.blocksPerCell
                                        }
                                        onClick={() =>
                                          shiftBlock(
                                            block,
                                            'left',
                                            '[data-block-handle]',
                                          )
                                        }
                                      >
                                        Left
                                      </Button>
                                      <Button
                                        variant="quiet"
                                        aria-label={`Move ${KIND_LABEL[block.kind]} to the column on the right`}
                                        disabled={
                                          c === row.cells.length - 1 ||
                                          row.cells[c + 1]!.length >=
                                            L.blocksPerCell
                                        }
                                        onClick={() =>
                                          shiftBlock(
                                            block,
                                            'right',
                                            '[data-block-handle]',
                                          )
                                        }
                                      >
                                        Right
                                      </Button>
                                    </>
                                  )}
                                  <Button
                                    variant="quiet"
                                    aria-label={`Remove ${KIND_LABEL[block.kind]}`}
                                    onClick={() => {
                                      if (hasContent(block))
                                        setConfirm({ kind: 'block', block });
                                      else {
                                        update((doc) =>
                                          removeBlock(doc, block.id),
                                        );
                                        setSaid(
                                          `${KIND_LABEL[block.kind]} removed`,
                                        );
                                      }
                                    }}
                                  >
                                    Remove
                                  </Button>
                                </div>
                              </div>
                              {openBlock === block.id && (
                                <div className="pst-block__form">
                                  <BlockForm
                                    block={block}
                                    images={images}
                                    savePhoto={savePhoto}
                                    photoReason={photoReason}
                                    profile={profile}
                                    onChange={(next) =>
                                      update((doc) =>
                                        updateBlock(doc, block.id, () => next),
                                      )
                                    }
                                  />
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      <AddBlock
                        draft={draft}
                        row={row}
                        cell={c}
                        profile={profile}
                        savePhoto={savePhoto}
                        onAdd={(block) => {
                          update((doc) => addBlock(doc, row.id, c, block));
                          setOpenBlock(block.id);
                          setSaid(`${KIND_LABEL[block.kind]} added`);
                          focusNext.current = `[data-block="${block.id}"] [data-block-handle]`;
                        }}
                      />
                    </section>
                  ))}
                  <div className="pst-actions">
                    <Button
                      variant="quiet"
                      onClick={() => {
                        if (row.cells.flat().length > 0)
                          setConfirm({ kind: 'row', row, index });
                        else {
                          update((doc) => removeRow(doc, row.id));
                          setSaid(`Row ${index + 1} removed`);
                          focusNext.current = '[data-add-row]';
                        }
                      }}
                    >
                      Remove row {index + 1}
                    </Button>
                  </div>
                </fieldset>
              )}
            </li>
          ))}
        </ol>
      )}
      <p id={`${id}-block-hint`} className="sr-only">
        Arrow keys move it: up and down in its column, left and right between
        columns.
      </p>
      <div className="pst-actions">
        <Button
          variant="secondary"
          data-add-row
          aria-disabled={readOnly || tooMany !== null || undefined}
          aria-describedby={tooMany ? `${id}-rows-full` : undefined}
          onClick={() => {
            if (readOnly || tooMany) return;
            const before = new Set(draft.rows.map((r) => r.id));
            const next = addRow(draft);
            const added = next.rows.find((r) => !before.has(r.id));
            update(() => next);
            if (added) {
              setOpenRow(added.id);
              setSaid(`Row ${next.rows.length} added`);
              focusNext.current = `[data-row="${added.id}"] [data-row-handle]`;
            }
          }}
        >
          Add a row
        </Button>
      </div>
      {tooMany && (
        <p id={`${id}-rows-full`} className="pst-hint">
          {tooMany}
        </p>
      )}
      <Locked
        title="Footer: Report this page, Privacy, Terms"
        detail="Always TipMe. Can’t be moved, styled or removed."
      />
      <p className="pst-hint">
        No dragging to a pixel position, no resizing by hand, nothing on top of
        anything else. Every row becomes one column on phones, left column
        first.
      </p>
      {confirm && (
        <ConfirmDialog
          title={
            confirm.kind === 'row'
              ? `Remove row ${confirm.index + 1}?`
              : `Remove this ${KIND_LABEL[confirm.block.kind].toLowerCase()} block?`
          }
          confirm="Remove"
          onConfirm={removeConfirmed}
          onCancel={() => setConfirm(null)}
        >
          {confirm.kind === 'row'
            ? `Its ${confirm.row.cells.flat().length === 1 ? 'block goes' : `${confirm.row.cells.flat().length} blocks go`} too. Your published page doesn’t change until you publish.`
            : 'What you wrote or chose in it goes too. Your published page doesn’t change until you publish.'}
        </ConfirmDialog>
      )}
    </div>
  );
}

function Locked({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="pst-row pst-row--locked">
      <b>{title}</b>
      <p className="pst-hint">{detail}</p>
    </div>
  );
}

function RowToolbar({
  row,
  index,
  draft,
  update,
  images,
  savePhoto,
  photoReason,
}: {
  row: StudioRowV1;
  index: number;
  draft: StudioDocumentV1;
  update(fn: (doc: StudioDocumentV1) => StudioDocumentV1): void;
  images: StudioImage[];
  savePhoto: SavePhoto;
  photoReason: string | null;
}) {
  const [refused, setRefused] = useState('');
  const isPhoto = typeof row.background === 'object';
  const [choosingPhoto, setChoosingPhoto] = useState(false);
  const bg = isPhoto
    ? 'photo'
    : (row.background as keyof typeof BACKGROUND_LABEL);
  const backgrounds = (
    [
      'page',
      'card',
      'colour',
      ...(draft.brand.length === 2 ? ['second'] : []),
      'photo',
    ] as const
  ).map((value) => ({
    value: value as keyof typeof BACKGROUND_LABEL,
    label: BACKGROUND_LABEL[value as keyof typeof BACKGROUND_LABEL],
  }));
  return (
    <div className="pst-toolbar">
      <Choice
        label={`Row ${index + 1} · columns`}
        options={STUDIO_COLUMNS.map((c) => ({
          value: c,
          label: COLUMN_LABEL[c],
        }))}
        value={row.columns}
        onChange={(columns: StudioColumns) => {
          const next = withColumns(draft, row.id, columns);
          if (typeof next === 'string') setRefused(next);
          else {
            setRefused('');
            update((doc) => {
              const again = withColumns(doc, row.id, columns);
              return typeof again === 'string' ? doc : again;
            });
          }
        }}
      />
      {refused && (
        <p className="pst-error" role="alert">
          {refused}
        </p>
      )}
      <Choice
        label="Spacing"
        options={STUDIO_SPACINGS.map((s) => ({
          value: s,
          label: s.toUpperCase(),
        })).sort((a, b) => 'SML'.indexOf(a.label) - 'SML'.indexOf(b.label))}
        value={row.spacing}
        onChange={(spacing) =>
          update((doc) => withSpacing(doc, row.id, spacing))
        }
      />
      <Choice
        label="Background"
        options={backgrounds}
        value={choosingPhoto ? 'photo' : bg}
        onChange={(value) => {
          if (value === 'photo') {
            setChoosingPhoto(true);
            return;
          }
          setChoosingPhoto(false);
          update((doc) =>
            withBackground(
              doc,
              row.id,
              value as 'page' | 'card' | 'colour' | 'second',
            ),
          );
        }}
      />
      {(isPhoto || choosingPhoto) && (
        <div className="pst-picker" data-field="background">
          {!isPhoto && photoReason ? (
            <p className="pst-hint">{photoReason}</p>
          ) : (
            <ImagePicker
              kind="photo"
              frame={false}
              hasImage={isPhoto}
              tile={
                typeof row.background === 'object' ? (
                  <Thumb imageId={row.background.photo} images={images} />
                ) : (
                  <span className="pst-thumb" />
                )
              }
              limits={`${PHOTO_LIMITS} Words on it get a shade behind them, so they stay readable.`}
              onSave={(picture) =>
                savePhoto(picture, (imageId) => {
                  setChoosingPhoto(false);
                  update((doc) =>
                    withBackground(doc, row.id, { photo: imageId }),
                  );
                })
              }
            />
          )}
        </div>
      )}
    </div>
  );
}

function AddBlock({
  draft,
  row,
  cell,
  profile,
  savePhoto,
  onAdd,
}: {
  draft: StudioDocumentV1;
  row: StudioRowV1;
  cell: number;
  profile: { bio: boolean; links: number };
  savePhoto: SavePhoto;
  onAdd(block: StudioBlockV1): void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<'photo' | 'video' | null>(null);
  const reasons = addReasons(draft, row.id, cell, profile);
  const close = () => {
    setOpen(false);
    setPending(null);
  };
  if (reasons.all)
    return (
      <p className="pst-hint" data-add-full>
        {reasons.all}
      </p>
    );
  return (
    <div className="pst-add">
      <Button
        variant="secondary"
        aria-expanded={open}
        aria-controls={`${id}-kinds`}
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
          ) : (
            <ul className="pst-kinds" aria-label="Kinds of block">
              {ADD_KINDS.map(({ kind, label, hint }) => {
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
                        if (kind === 'photo' || kind === 'video') {
                          setPending(kind);
                          return;
                        }
                        close();
                        onAdd(newBlock(kind, freshId(draft)));
                      }}
                    >
                      <b>{label}</b>
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
