'use client';
import { useEffect, useId, useRef, useState } from 'react';
import {
  COVER_COLOURS,
  COVER_DESIGNS,
  type MyProfile,
  type ResolvedCover,
} from '@tipme/contracts';
import { Button, Card } from '@tipme/ui';
import { useRecipient } from '@/components/account/recipient-context';
import { ProfileCover } from '@/components/profile/cover';
import {
  choiceBody,
  draftFromChoice,
  automaticLabel,
  draftPreview,
  sameDraft,
  takesColours,
  type CoverDraft,
} from '@/lib/cover-choice';
import { PHOTO_LIMIT_BYTES, photoErrors } from '@/lib/photo-errors';
import { apiFetch, apiUrl } from '@/lib/session-client';
import { COVER_SHRINK_MAX, shrinkPhoto } from '@/lib/shrink-photo';

// Choosing a cover (design spec §6, motion §7.6). Looking at a choice changes nothing; selecting
// one changes the preview at once, crossfading in 240ms (150ms for a colour). Nothing is saved
// until "Save cover". An uploaded photo beats any design, so while one exists the page says so.

/** What the preview shows: the stored or just-chosen photo, or a design drawn from the catalogue. */
export type Layer =
  | { key: string; kind: 'photo'; src: string | null }
  | { key: string; kind: 'design'; design: string; cover: ResolvedCover };

const reducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function LayerView({ layer }: { layer: Layer }) {
  if (layer.kind === 'design') return <ProfileCover cover={layer.cover} />;
  return (
    <div className="profile-cover" data-profile-cover="image">
      {layer.src && (
        // A private blob from the account's own route, so the image optimiser has no part in it.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={layer.src} alt="" className="cover-preview__photo" />
      )}
    </div>
  );
}

/** The live preview. A new look fades in over the last one, which is dropped once it has. */
function Preview({ next }: { next: Layer }) {
  const [current, setCurrent] = useState(next);
  const [under, setUnder] = useState<Layer | null>(null);
  const [ms, setMs] = useState(240);
  if (next.key !== current.key) {
    // Reduced motion: no crossfade, so the new look simply replaces the old.
    setUnder(reducedMotion() ? null : current);
    // The same design in another colour is the shorter fade.
    setMs(
      current.kind === 'design' &&
        next.kind === 'design' &&
        current.design === next.design
        ? 150
        : 240,
    );
    setCurrent(next);
  }
  useEffect(() => {
    if (!under) return;
    const timer = setTimeout(() => setUnder(null), ms + 60);
    return () => clearTimeout(timer);
  }, [under, ms]);
  return (
    <div className="cover-preview" data-testid="cover-preview">
      {under && (
        <div className="cover-preview__layer" aria-hidden="true">
          <LayerView layer={under} />
        </div>
      )}
      <div
        key={next.key}
        className="cover-preview__layer cover-preview__layer--in"
        style={{ animationDuration: `${ms}ms` }}
      >
        <LayerView layer={next} />
      </div>
    </div>
  );
}

/** The stored cover photo, read from the account's own route, which works while the page isn't live. */
function useStoredPhoto(key: string | null) {
  const [loaded, setLoaded] = useState<{
    key: string;
    url: string | null;
  } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    let url: string | null = null;
    void (async () => {
      try {
        const response = await fetch(apiUrl('/v1/me/cover'), {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('no cover');
        url = URL.createObjectURL(await response.blob());
        if (cancelled) URL.revokeObjectURL(url);
        else setLoaded({ key, url });
      } catch {
        if (!cancelled) setLoaded({ key, url: null });
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [key]);
  if (!key || loaded?.key !== key) return { state: 'loading' as const };
  return loaded.url
    ? { state: 'ready' as const, url: loaded.url }
    : { state: 'failed' as const };
}

function designName(id: string | null) {
  return COVER_DESIGNS.find((d) => d.id === id)?.name ?? '';
}

/**
 * `onPreview` hears the look being shown, saved or not, so the page preview beside Settings can
 * show the same cover. It saves nothing.
 */
export function CoverSettings({
  onPreview,
}: {
  onPreview?: (layer: Layer) => void;
} = {}) {
  const id = useId();
  const { profile, setProfile } = useRecipient();
  const choice = profile.coverChoice;
  const saved = draftFromChoice(choice);
  const hasPhoto = Boolean(choice?.hasPhoto);
  const [draft, setDraft] = useState<CoverDraft>(() => draftFromChoice(choice));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  // The photo being uploaded, shown at once while it is stored.
  const [pending, setPending] = useState<string | null>(null);
  const clear = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const refocusUpload = useRef(false);
  useEffect(
    () => () => {
      if (clear.current) clearTimeout(clear.current);
    },
    [],
  );
  useEffect(
    () => () => {
      if (pending) URL.revokeObjectURL(pending);
    },
    [pending],
  );

  useEffect(() => {
    if (busy || !refocusUpload.current) return;
    refocusUpload.current = false;
    uploadInput.current?.focus();
  }, [busy]);

  // A new photo changes the route's answer, and the path carries its version.
  const photoKey = hasPhoto
    ? profile.cover?.kind === 'photo'
      ? profile.cover.path
      : 'photo'
    : null;
  const stored = useStoredPhoto(photoKey);
  const storedUrl = stored.state === 'ready' ? stored.url : null;

  // What the page shows: the photo if there is one, otherwise the design being looked at.
  // The stored photo once it has been read; until then the one just chosen, so nothing blanks.
  const photoSrc = storedUrl ?? pending;
  const cover = draftPreview(draft, profile.handle);
  const layer: Layer = hasPhoto
    ? { key: 'photo', kind: 'photo', src: photoSrc }
    : {
        key: `design:${JSON.stringify(cover)}`,
        kind: 'design',
        design: cover.kind === 'design' ? cover.design : '',
        cover,
      };
  // The layer is rebuilt each render; its key and photo say when the look really changed.
  const latest = useRef(layer);
  useEffect(() => {
    latest.current = layer;
  });
  useEffect(() => {
    onPreview?.(latest.current);
  }, [layer.key, photoSrc, onPreview]);
  if (!choice) return null;

  const say = (text: string) => {
    setDone(text);
    if (clear.current) clearTimeout(clear.current);
    clear.current = setTimeout(() => setDone(''), 2000);
  };
  const apply = (next: CoverDraft) => {
    setDone('');
    setError('');
    setDraft(next);
  };

  const dirty = !sameDraft(draft, saved);

  const save = async () => {
    setBusy(true);
    setError('');
    const result = await apiFetch<MyProfile>('/v1/me/cover-design', {
      method: 'PUT',
      body: choiceBody(draft),
    });
    setBusy(false);
    if (result.ok) {
      setProfile(result.data);
      say('Saved');
    } else setError('We couldn’t save that. Please try again.');
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError('');
    setDone('');
    // Shrunk here first, as photos are: a phone photo uploads in seconds. Covers keep more pixels.
    const photo = await shrinkPhoto(file, COVER_SHRINK_MAX);
    if (photo.size > PHOTO_LIMIT_BYTES) {
      setBusy(false);
      setError(photoErrors['PAYLOAD_TOO_LARGE']!);
      return;
    }
    // The real picture shows at once; if the upload fails it goes back to the cover it was.
    setPending(URL.createObjectURL(photo));
    const result = await apiFetch<MyProfile>('/v1/me/cover', {
      method: 'PUT',
      file: photo,
    });
    setBusy(false);
    if (result.ok) {
      setProfile(result.data);
      say('Cover saved.');
    } else {
      setPending(null);
      setError(
        photoErrors[result.code] ?? 'We couldn’t save that. Please try again.',
      );
    }
  };

  const removePhoto = async () => {
    setBusy(true);
    setError('');
    setDone('');
    const result = await apiFetch<MyProfile>('/v1/me/cover', {
      method: 'DELETE',
    });
    setBusy(false);
    if (result.ok) {
      setPending(null);
      setProfile(result.data);
      say('Cover removed.');
      // The button is about to unmount; focus would fall to the page body. It moves to the upload
      // control once that is enabled again (below).
      refocusUpload.current = true;
    } else setError('We couldn’t remove that. Please try again.');
  };

  const colours = takesColours(draft.design);
  const name = designName(draft.design);
  const unsaved = dirty;

  return (
    <Card id="cover" className="settings-section">
      <h3>Cover</h3>
      <p className="tm-hint">
        The wide image at the top of your page. Your own photo works best.
      </p>
      <Preview next={layer} />
      {hasPhoto && stored.state === 'failed' && !pending && (
        <p className="tm-hint">
          Your cover is saved, but we couldn’t show a preview just now.
        </p>
      )}

      <label className="cover-upload tm-button tm-button--secondary">
        <input
          ref={uploadInput}
          type="file"
          className="cover-upload__input"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          aria-describedby={error ? `${id}-error` : `${id}-limits`}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
            event.target.value = '';
          }}
        />
        Upload your own photo
      </label>
      <p className="tm-hint" id={`${id}-limits`}>
        JPEG, PNG or WebP, up to 5 MB. TipMe removes hidden details such as
        where it was taken.
      </p>
      {error && (
        <p className="tm-field-error" role="alert" id={`${id}-error`}>
          {error}
        </p>
      )}

      {hasPhoto && (
        <div className="cover-photo-note" data-testid="cover-photo-note">
          <p>
            Your photo is showing on your page.{' '}
            {draft.design
              ? unsaved
                ? `${name} won’t show unless you remove the photo.`
                : `${name} is saved. Remove the photo to show it.`
              : 'A design shows only when there is no photo.'}
          </p>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void removePhoto()}
          >
            Remove photo
          </Button>
        </div>
      )}

      <fieldset className="cover-choices" role="radiogroup">
        <legend>Or choose a design</legend>
        <div className="cover-choices__grid">
          <label className="cover-choice">
            <input
              type="radio"
              name={`${id}-design`}
              checked={draft.design === null}
              aria-label="Let TipMe pick"
              aria-describedby={`${id}-automatic`}
              onChange={() => apply({ ...draft, design: null })}
            />
            <span className="cover-choice__thumb" aria-hidden="true">
              <ProfileCover
                cover={draftPreview(
                  { design: null, colour: draft.colour },
                  profile.handle,
                )}
                sizes="(max-width: 520px) 45vw, 160px"
              />
            </span>
            <span className="cover-choice__name">Let TipMe pick</span>
            <span
              className="cover-choice__note"
              id={`${id}-automatic`}
              data-testid="cover-automatic-note"
            >
              Now: {automaticLabel(profile.handle)}
            </span>
          </label>
          {COVER_DESIGNS.map((design) => (
            <label key={design.id} className="cover-choice">
              <input
                type="radio"
                name={`${id}-design`}
                checked={draft.design === design.id}
                onChange={() => apply({ ...draft, design: design.id })}
              />
              <span className="cover-choice__thumb" aria-hidden="true">
                <ProfileCover
                  cover={draftPreview(
                    { design: design.id, colour: draft.colour },
                    profile.handle,
                  )}
                  sizes="(max-width: 520px) 45vw, 160px"
                />
              </span>
              <span className="cover-choice__name">{design.name}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {colours && (
        <fieldset className="cover-colours" role="radiogroup">
          <legend>Colour</legend>
          <div className="cover-colours__list">
            {COVER_COLOURS.map((colour) => (
              <label key={colour.id} className="cover-colour">
                <input
                  type="radio"
                  name={`${id}-colour`}
                  checked={draft.colour === colour.id}
                  onChange={() => apply({ ...draft, colour: colour.id })}
                />
                <span
                  className="cover-colour__swatch"
                  style={{ background: colour.base }}
                  aria-hidden="true"
                />
                <span>{colour.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {!saved.design && (
        <p className="tm-hint">
          If you don’t choose, we’ll pick one for your page.
        </p>
      )}
      <div className="cover-save">
        <Button
          disabled={busy || !dirty}
          aria-busy={busy || undefined}
          onClick={() => void save()}
        >
          Save cover
        </Button>
        {/* Always present, so screen readers announce what is written into it. */}
        <p role="status" className="tm-hint cover-save__status">
          {done}
        </p>
      </div>
    </Card>
  );
}
