'use client';
import { useId, useState, type ReactNode } from 'react';
import {
  STUDIO_BLOCK_VARIANTS,
  STUDIO_LIMITS as L,
  parseVideoLink,
  type StudioBlock,
  type StudioImage,
  type StudioImageRef,
} from '@tipme/contracts';
import { Button } from '@tipme/ui';
import {
  ImagePicker,
  type PickerOutcome,
} from '@/components/image-picker/image-picker';
import { apiUrl } from '@/lib/session-client';
import {
  VARIANT_LABEL,
  counter,
  fitText,
  koboToNaira,
  nairaToKobo,
  textVariant,
} from './blocks-model';
import { Choice } from './style-tab';

/*
 * The Blocks tab's forms (plan Task 9b): one per block kind. Each field writes a typed value the
 * schema accepts, and only then: words are cleaned and cut to their limit as they are typed (the
 * box keeps what was typed, so a trailing space survives until the next word); a service, an event
 * or a video link is written once it is complete, and says what is missing until then. Nothing
 * here takes a size, a position or CSS. Styling is deliberately plain (studio-editor.css, `pst-`
 * classes on existing tokens): the editor's visual pass comes later.
 */

type Block<K extends StudioBlock['kind']> = Extract<StudioBlock, { kind: K }>;

/** Uploads a chosen photo and hands its new id to `place`; the picker shows the outcome. */
export type SavePhoto = (
  picture: Blob,
  place: (imageId: string) => void,
) => Promise<PickerOutcome>;

export interface BlockFormProps<B extends StudioBlock> {
  block: B;
  onChange(next: StudioBlock): void;
  images: StudioImage[];
  savePhoto: SavePhoto;
  /** Room for more photos on the page (24), or why not. */
  photoReason: string | null;
  profile: { bio: boolean; links: number };
}

export const PHOTO_LIMITS =
  'JPEG, PNG or WebP, up to 5 MB, at least 600 pixels on its shortest side. TipMe removes hidden details such as where it was taken.';

/** A photo's small square, as the editor shows it. */
export function Thumb({
  imageId,
  images,
}: {
  imageId: string;
  images: StudioImage[];
}) {
  const image = images.find((i) => i.imageId === imageId);
  if (!image) return <span className="pst-thumb" />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- the owner's own crop, already sized
    <img
      className="pst-thumb"
      src={apiUrl(`${image.path}/square-480`)}
      alt=""
      width={64}
      height={64}
    />
  );
}

/**
 * One line or a paragraph of words. The box keeps what was typed; the document gets it cleaned
 * and cut to `max`. A change from elsewhere (a fix) replaces what the box shows.
 */
export function WordsField({
  label,
  value,
  max,
  paragraph = false,
  field,
  hint,
  onChange,
}: {
  label: string;
  value: string;
  max: number;
  paragraph?: boolean;
  /** The design check's fixes find a field by this (`data-field`). */
  field?: string;
  hint?: string;
  onChange(text: string): void;
}) {
  const id = useId();
  const [raw, setRaw] = useState(value);
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    setShown(value);
    if (fitText(raw, max, paragraph) !== value) setRaw(value);
  }
  const type = (next: string) => {
    setRaw(next);
    const text = fitText(next, max, paragraph);
    setShown(text);
    if (text !== value) onChange(text);
  };
  const props = {
    id,
    value: raw,
    maxLength: max,
    'aria-describedby': `${id}-count${hint ? ` ${id}-hint` : ''}`,
    'data-field': field,
    onChange: (e: { target: { value: string } }) => type(e.target.value),
  };
  return (
    <div className="pst-input">
      <label htmlFor={id}>{label}</label>
      {hint && (
        <p id={`${id}-hint`} className="pst-hint">
          {hint}
        </p>
      )}
      {paragraph ? <textarea rows={5} {...props} /> : <input {...props} />}
      <p id={`${id}-count`} className="pst-count">
        {counter(fitText(raw, max, paragraph), max)}
      </p>
    </div>
  );
}

function Variants<B extends StudioBlock>({
  block,
  onChange,
}: {
  block: B;
  onChange(next: StudioBlock): void;
}) {
  const options = STUDIO_BLOCK_VARIANTS[block.kind] as readonly string[];
  if (options.length < 2) return null;
  return (
    <Choice
      label="Style"
      options={options.map((v) => ({ value: v, label: VARIANT_LABEL[v] ?? v }))}
      value={block.variant as string}
      onChange={(variant) =>
        onChange(
          block.kind === 'text'
            ? textVariant(block, variant as Block<'text'>['variant'])
            : ({ ...block, variant } as StudioBlock),
        )
      }
    />
  );
}

function Check({
  label,
  checked,
  onChange,
  field,
}: {
  label: string;
  checked: boolean;
  onChange(on: boolean): void;
  field?: string;
}) {
  return (
    <label className="pst-check-box">
      <input
        type="checkbox"
        checked={checked}
        data-field={field}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

const without = <T extends object>(o: T, key: keyof T): T => {
  const copy = { ...o };
  delete copy[key];
  return copy;
};

function TextForm({ block, onChange }: BlockFormProps<Block<'text'>>) {
  const max =
    block.variant === 'heading'
      ? L.headingText
      : block.variant === 'lead'
        ? L.leadText
        : L.paragraphText;
  return (
    <>
      <Variants block={block} onChange={onChange} />
      {block.variant === 'heading' && (
        <Choice
          label="Heading size"
          options={[
            { value: '2', label: 'Main heading' },
            { value: '3', label: 'Smaller heading' },
          ]}
          value={String(block.level ?? 2)}
          onChange={(v) => onChange({ ...block, level: v === '3' ? 3 : 2 })}
        />
      )}
      <WordsField
        label={VARIANT_LABEL[block.variant] ?? 'Words'}
        value={block.text}
        max={max}
        paragraph={block.variant === 'paragraph'}
        field="text"
        hint={
          block.variant === 'paragraph'
            ? 'Leave a blank line between paragraphs (up to 4).'
            : undefined
        }
        onChange={(text) => onChange({ ...block, text })}
      />
    </>
  );
}

function QuoteForm({ block, onChange }: BlockFormProps<Block<'quote'>>) {
  return (
    <>
      <Variants block={block} onChange={onChange} />
      <WordsField
        label="Quote"
        value={block.text}
        max={L.quoteText}
        field="text"
        onChange={(text) => onChange({ ...block, text })}
      />
    </>
  );
}

/** Description, decorative and (for a photo block) caption: the parts every photo has. */
function Describe({
  image,
  onChange,
  index,
}: {
  image: StudioImageRef;
  onChange(next: StudioImageRef): void;
  index?: number;
}) {
  const n = index === undefined ? '' : ` of photo ${index + 1}`;
  return (
    <>
      {!image.decorative && (
        <WordsField
          label={`Description${n}`}
          value={image.alt}
          max={L.alt}
          field="alt"
          hint="Say what the photo shows, for people who can’t see it."
          onChange={(alt) => onChange({ ...image, alt })}
        />
      )}
      <Check
        label={`Decorative${index === undefined ? '' : ` (photo ${index + 1})`}: it adds nothing a visitor needs to know`}
        checked={image.decorative === true}
        onChange={(on) =>
          onChange(
            on ? { ...image, decorative: true } : without(image, 'decorative'),
          )
        }
      />
    </>
  );
}

function PhotoForm({
  block,
  onChange,
  images,
  savePhoto,
}: BlockFormProps<Block<'photo'>>) {
  return (
    <>
      <Variants block={block} onChange={onChange} />
      <div data-field="photo" className="pst-picker">
        <ImagePicker
          kind="photo"
          frame={false}
          hasImage
          tile={<Thumb imageId={block.imageId} images={images} />}
          limits={PHOTO_LIMITS}
          onSave={(picture) =>
            savePhoto(picture, (imageId) => onChange({ ...block, imageId }))
          }
        />
      </div>
      <Describe
        image={block}
        onChange={({ alt, decorative }) =>
          onChange(
            decorative
              ? { ...block, alt, decorative }
              : { ...without(block, 'decorative'), alt },
          )
        }
      />
      <WordsField
        label="Caption (optional)"
        value={block.caption ?? ''}
        max={L.caption}
        hint="Shown on the photo, with a shade behind it so it stays readable."
        onChange={(caption) =>
          onChange(caption ? { ...block, caption } : without(block, 'caption'))
        }
      />
    </>
  );
}

function GalleryForm({
  block,
  onChange,
  images,
  savePhoto,
  photoReason,
}: BlockFormProps<Block<'gallery'>>) {
  const full = block.images.length >= L.galleryImages;
  const reason = full
    ? `A gallery holds ${L.galleryImages} photos.`
    : photoReason;
  const set = (i: number, next: StudioImageRef | null) =>
    onChange({
      ...block,
      images: next
        ? block.images.map((img, k) => (k === i ? next : img))
        : block.images.filter((_, k) => k !== i),
    });
  return (
    <>
      <Variants block={block} onChange={onChange} />
      <ol className="pst-gallery">
        {block.images.map((image, i) => (
          <li key={`${image.imageId}-${i}`}>
            <div
              data-field={i === 0 ? 'photo' : undefined}
              className="pst-picker"
            >
              <ImagePicker
                kind="photo"
                frame={false}
                hasImage
                tile={<Thumb imageId={image.imageId} images={images} />}
                limits={`Photo ${i + 1} of ${block.images.length}.`}
                onSave={(picture) =>
                  savePhoto(picture, (imageId) => set(i, { ...image, imageId }))
                }
                remove={{
                  label: `Remove photo ${i + 1}`,
                  onRemove: () => set(i, null),
                }}
              />
            </div>
            <Describe
              image={image}
              index={i}
              onChange={(next) => set(i, next)}
            />
          </li>
        ))}
      </ol>
      {reason ? (
        <p className="pst-hint">{reason}</p>
      ) : (
        <div className="pst-picker">
          <ImagePicker
            kind="photo"
            frame={false}
            hasImage={false}
            tile={<span className="pst-thumb" />}
            limits={PHOTO_LIMITS}
            onSave={(picture) =>
              savePhoto(picture, (imageId) =>
                onChange({
                  ...block,
                  images: [...block.images, { imageId, alt: '' }],
                }),
              )
            }
          />
        </div>
      )}
    </>
  );
}

/** A video link: written once it is one the page can show (YouTube, TikTok or Audiomack). */
export function VideoLinkField({
  value,
  onValid,
  action,
}: {
  value: string;
  onValid(url: string): void;
  /** A button that writes the link (a new block), instead of writing as it is typed. */
  action?: string;
}) {
  const id = useId();
  const [raw, setRaw] = useState(value);
  const [touched, setTouched] = useState(false);
  const url = raw.trim();
  const ok = url.length <= L.videoUrl && parseVideoLink(url) !== null;
  const error =
    !touched || ok
      ? ''
      : url === ''
        ? 'Paste a link to a video.'
        : /youtu|tiktok|audiomack/i.test(url)
          ? 'That link isn’t one video. Copy the link from the video’s Share button.'
          : 'We can’t show videos from that site yet. Use a YouTube, TikTok or Audiomack link.';
  return (
    <div className="pst-input">
      <label htmlFor={id}>Video link</label>
      <p id={`${id}-hint`} className="pst-hint">
        YouTube, TikTok or Audiomack. Visitors see a still from TipMe; the video
        loads only when they tap play.
      </p>
      <input
        id={id}
        type="url"
        inputMode="url"
        value={raw}
        maxLength={L.videoUrl}
        data-field="link"
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
        onChange={(e) => {
          setRaw(e.target.value);
          const next = e.target.value.trim();
          if (!action && parseVideoLink(next) && next !== value) onValid(next);
        }}
        onBlur={() => setTouched(true)}
      />
      {error && (
        <p id={`${id}-error`} className="pst-error">
          {error}
        </p>
      )}
      {action && (
        <Button
          variant="secondary"
          onClick={() => {
            setTouched(true);
            if (ok) onValid(url);
          }}
        >
          {action}
        </Button>
      )}
    </div>
  );
}

function VideoForm({ block, onChange }: BlockFormProps<Block<'video'>>) {
  return (
    <>
      <VideoLinkField
        value={block.url}
        onValid={(url) => onChange({ ...block, url })}
      />
      <WordsField
        label="Caption (optional)"
        value={block.caption ?? ''}
        max={L.caption}
        onChange={(caption) =>
          onChange(caption ? { ...block, caption } : without(block, 'caption'))
        }
      />
    </>
  );
}

type Service = Block<'services'>['items'][number];
type Event = Block<'events'>['items'][number];

/** What an item form holds while typing: every field as typed. */
type Draft = Record<string, string | boolean>;

/**
 * One item of a list (a service or an event), edited in local fields and written only when it
 * is complete. `read` turns the fields into an item, or the words for what's missing.
 */
function ItemForm({
  title,
  initial,
  fields,
  read,
  onSave,
  onRemove,
  action,
}: {
  title: string;
  initial: Draft;
  fields: (f: {
    value: (key: string) => string;
    checked: (key: string) => boolean;
    set: (key: string, v: string | boolean) => void;
    id: string;
  }) => ReactNode;
  read(d: Draft): { ok: true; item: object } | { ok: false; missing: string };
  onSave(item: object): void;
  onRemove?: () => void;
  /** A button that adds the item; without one, a complete item is written as it is typed. */
  action?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState<Draft>(initial);
  const [tried, setTried] = useState(false);
  const result = read(draft);
  const set = (key: string, v: string | boolean) => {
    const next = { ...draft, [key]: v };
    setDraft(next);
    if (!action) {
      const r = read(next);
      if (r.ok) onSave(r.item);
    }
  };
  const showMissing = !result.ok && (tried || !action);
  return (
    <fieldset className="pst-item">
      <legend>{title}</legend>
      {fields({
        value: (k) => String(draft[k] ?? ''),
        checked: (k) => draft[k] === true,
        set,
        id,
      })}
      {showMissing && !result.ok && (
        <p className="pst-error">
          {action
            ? result.missing
            : `Not saved yet: ${result.missing.toLowerCase()}`}
        </p>
      )}
      <div className="pst-actions">
        {action && (
          <Button
            variant="secondary"
            onClick={() => {
              setTried(true);
              if (!result.ok) return;
              onSave(result.item);
              setDraft(initial);
              setTried(false);
            }}
          >
            {action}
          </Button>
        )}
        {onRemove && (
          <Button variant="quiet" onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>
    </fieldset>
  );
}

function Line({
  label,
  name,
  max,
  f,
  type = 'text',
  required = false,
}: {
  label: string;
  name: string;
  max?: number;
  f: Parameters<Parameters<typeof ItemForm>[0]['fields']>[0];
  type?: string;
  required?: boolean;
}) {
  const value = f.value(name);
  return (
    <div className="pst-input">
      <label htmlFor={`${f.id}-${name}`}>{label}</label>
      <input
        id={`${f.id}-${name}`}
        type={type}
        value={value}
        maxLength={max}
        required={required}
        inputMode={name === 'price' ? 'numeric' : undefined}
        aria-describedby={max ? `${f.id}-${name}-count` : undefined}
        onChange={(e) => f.set(name, e.target.value)}
      />
      {max && (
        <p id={`${f.id}-${name}-count`} className="pst-count">
          {counter(fitText(value, max), max)}
        </p>
      )}
    </div>
  );
}

const serviceDraft = (s?: Service): Draft => ({
  name: s?.name ?? '',
  detail: s?.detail ?? '',
  price: s ? koboToNaira(s.priceMinor) : '',
  from: s?.from === true,
});

function readService(d: Draft) {
  const name = fitText(String(d['name']), L.serviceName);
  const detail = fitText(String(d['detail']), L.serviceDetail);
  const priceMinor = nairaToKobo(String(d['price']));
  if (!name) return { ok: false as const, missing: 'Add the service’s name.' };
  if (!priceMinor)
    return {
      ok: false as const,
      missing: 'Add a price in whole naira, from ₦1 to ₦10,000,000.',
    };
  const item: Service = {
    name,
    ...(detail ? { detail } : {}),
    priceMinor,
    ...(d['from'] === true ? { from: true as const } : {}),
  };
  return { ok: true as const, item };
}

function serviceFields(
  f: Parameters<Parameters<typeof ItemForm>[0]['fields']>[0],
) {
  return (
    <>
      <Line label="Name" name="name" max={L.serviceName} f={f} required />
      <Line
        label="Detail (optional)"
        name="detail"
        max={L.serviceDetail}
        f={f}
      />
      <Line label="Price in naira" name="price" f={f} required />
      <label className="pst-check-box">
        <input
          type="checkbox"
          checked={f.checked('from')}
          onChange={(e) => f.set('from', e.target.checked)}
        />
        Show “from” before the price
      </label>
    </>
  );
}

function ServicesForm({ block, onChange }: BlockFormProps<Block<'services'>>) {
  const items = block.items;
  return (
    <>
      <Variants block={block} onChange={onChange} />
      <p className="pst-hint">
        Prices are for information. Tips here are a gift, not a payment for a
        service. Your page always says so under the list.
      </p>
      {items.map((item, i) => (
        <ItemForm
          key={`${block.id}-${i}-${items.length}`}
          title={`Service ${i + 1}`}
          initial={serviceDraft(item)}
          fields={serviceFields}
          read={readService}
          onSave={(next) =>
            onChange({
              ...block,
              items: items.map((x, k) => (k === i ? (next as Service) : x)),
            })
          }
          onRemove={() =>
            onChange({ ...block, items: items.filter((_, k) => k !== i) })
          }
        />
      ))}
      {items.length < L.services ? (
        <ItemForm
          key={`${block.id}-new-${items.length}`}
          title="New service"
          initial={serviceDraft()}
          fields={serviceFields}
          read={readService}
          action="Add the service"
          onSave={(next) =>
            onChange({ ...block, items: [...items, next as Service] })
          }
        />
      ) : (
        <p className="pst-hint">A page shows up to {L.services} services.</p>
      )}
    </>
  );
}

const eventDraft = (e?: Event): Draft => ({
  date: e?.date ?? '',
  time: e?.time ?? '',
  title: e?.title ?? '',
  place: e?.place ?? '',
  note: e?.note ?? '',
});

function readEvent(d: Draft) {
  const date = String(d['date']);
  const time = String(d['time']);
  const title = fitText(String(d['title']), L.eventTitle);
  const place = fitText(String(d['place']), L.eventPlace);
  const note = fitText(String(d['note']), L.eventNote);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return { ok: false as const, missing: 'Add the date.' };
  if (!title) return { ok: false as const, missing: 'Add what the event is.' };
  const item: Event = {
    date,
    ...(/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? { time } : {}),
    title,
    ...(place ? { place } : {}),
    ...(note ? { note } : {}),
  };
  return { ok: true as const, item };
}

function eventFields(
  f: Parameters<Parameters<typeof ItemForm>[0]['fields']>[0],
) {
  return (
    <>
      <Line label="Date" name="date" type="date" f={f} required />
      <Line label="Time (optional)" name="time" type="time" f={f} />
      <Line label="What it is" name="title" max={L.eventTitle} f={f} required />
      <Line label="Place (optional)" name="place" max={L.eventPlace} f={f} />
      <Line label="Note (optional)" name="note" max={L.eventNote} f={f} />
    </>
  );
}

function EventsForm({ block, onChange }: BlockFormProps<Block<'events'>>) {
  const items = block.items;
  return (
    <>
      <Variants block={block} onChange={onChange} />
      <p className="pst-hint">
        Events hide by themselves once their date has passed.
      </p>
      {items.map((item, i) => (
        <ItemForm
          key={`${block.id}-${i}-${items.length}`}
          title={`Event ${i + 1}`}
          initial={eventDraft(item)}
          fields={eventFields}
          read={readEvent}
          onSave={(next) =>
            onChange({
              ...block,
              items: items.map((x, k) => (k === i ? (next as Event) : x)),
            })
          }
          onRemove={() =>
            onChange({ ...block, items: items.filter((_, k) => k !== i) })
          }
        />
      ))}
      {items.length < L.events ? (
        <ItemForm
          key={`${block.id}-new-${items.length}`}
          title="New event"
          initial={eventDraft()}
          fields={eventFields}
          read={readEvent}
          action="Add the event"
          onSave={(next) =>
            onChange({ ...block, items: [...items, next as Event] })
          }
        />
      ) : (
        <p className="pst-hint">A page shows up to {L.events} events.</p>
      )}
    </>
  );
}

function LinksForm({
  block,
  onChange,
  profile,
}: BlockFormProps<Block<'links'>>) {
  return (
    <>
      <Variants block={block} onChange={onChange} />
      <p className="pst-hint">
        {profile.links > 0
          ? 'Shows the links you added in My page. Change them there.'
          : 'You have no links yet. Add them in My page, and they show here.'}
      </p>
    </>
  );
}

function AboutForm({ profile }: BlockFormProps<Block<'about'>>) {
  return (
    <p className="pst-hint">
      {profile.bio
        ? 'Shows your bio from My page. Change the words there.'
        : 'You have no bio yet. Add one in My page, and it shows here.'}
    </p>
  );
}

/** The form for one block, by kind. */
export function BlockForm(props: BlockFormProps<StudioBlock>) {
  const { block } = props;
  switch (block.kind) {
    case 'text':
      return <TextForm {...props} block={block} />;
    case 'quote':
      return <QuoteForm {...props} block={block} />;
    case 'photo':
      return <PhotoForm {...props} block={block} />;
    case 'gallery':
      return <GalleryForm {...props} block={block} />;
    case 'video':
      return <VideoForm {...props} block={block} />;
    case 'services':
      return <ServicesForm {...props} block={block} />;
    case 'events':
      return <EventsForm {...props} block={block} />;
    case 'links':
      return <LinksForm {...props} block={block} />;
    case 'about':
      return <AboutForm {...props} block={block} />;
    case 'supporters':
      return null;
  }
}
