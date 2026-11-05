'use client';
import Link from 'next/link';
import { useId, useRef, useState } from 'react';
import type { Dispatch, DragEvent, FormEvent, SetStateAction } from 'react';
import {
  SOCIAL_PLATFORMS,
  detectPlatform,
  isAdultPlatform,
  linkHandle,
  socialLinkProblem,
  type MyProfile,
  type SocialLink,
  type SocialPlatform,
} from '@tipme/contracts';
import { Button, Card, InputField, Notice } from '@tipme/ui';
import { useRecipient } from '@/components/account/recipient-context';
import { LinkBadge } from '@/components/profile/link-badge';
import { apiFetch } from '@/lib/session-client';
import {
  addRow,
  editorFrom,
  hiddenStatus,
  legacyPatch,
  moveRow,
  notShown,
  rowProblems,
  setRowUrl,
  toRequest,
  toggleFeatured,
  type LinkRow,
} from '@/lib/link-editor';

// Settings › My page › Your links (SocialLinks board). Free: up to 3 links from Free sites, shown in
// a fixed order. Pro: up to 8 from any listed site or their own website, their own order (arrows,
// or dragging ⋮⋮ with a mouse) and one featured link. The server checks all of it again.

export interface LinksDraft {
  rows: LinkRow[];
  show: boolean;
  /** Free: the links kept from Pro that the owner hasn't removed. */
  kept: SocialLink[];
}
export const linksDraftFrom = (profile: MyProfile): LinksDraft => {
  const editor = editorFrom(profile);
  return {
    rows: editor.rows,
    show: profile.socialsPublic,
    kept: editor.hidden,
  };
};

/** The most used sites first; the rest wait behind "+ more". */
const COMMON: SocialPlatform[] = [
  'tiktok',
  'facebook',
  'instagram',
  'youtube',
  'x',
  'whatsapp',
];

const PLACEHOLDERS: Partial<Record<SocialPlatform, string>> = {
  tiktok: 'https://tiktok.com/@you',
  youtube: 'https://youtube.com/@you',
  threads: 'https://threads.com/@you',
  whatsapp: 'https://whatsapp.com/channel/…',
  linkedin: 'https://linkedin.com/in/you',
  substack: 'https://you.substack.com',
  website: 'https://yourname.com',
  spotify: 'https://open.spotify.com/artist/…',
  applemusic: 'https://music.apple.com/…',
  boomplay: 'https://boomplay.com/artists/…',
};
const placeholder = (platform: SocialPlatform) =>
  PLACEHOLDERS[platform] ??
  `https://${SOCIAL_PLATFORMS[platform].hosts[0]}/you`;

/** Why a page holding more links than Pro shows (it was Free with links kept) can't save. */
function overflowText(overflow: LinkRow[], limit: number) {
  const names = overflow
    .map((row) => SOCIAL_PLATFORMS[row.platform].label)
    .join(', ');
  return `Your page shows up to ${limit} links, so it can’t save ${limit + overflow.length}. These don’t show on your page now: ${names}. Remove ${overflow.length} ${overflow.length === 1 ? 'link' : 'links'} to save.`;
}

const PRO_REQUIRED =
  'More than 3 links, Pro sites, a featured link and your own order are part of TipMe Pro.';

export function YourLinks({
  draft,
  setDraft,
}: {
  draft: LinksDraft;
  setDraft: Dispatch<SetStateAction<LinksDraft>>;
}) {
  const id = useId();
  const { profile, setProfile } = useRecipient();
  const { limit, legacy, sites, plan } = editorFrom(profile);
  const pro = plan === 'pro';
  const adultOff = profile.adultLinks === false;
  const { rows, kept } = draft;
  const keptStatus = pro ? [] : hiddenStatus(profile.links ?? [], rows, kept);
  const overflow = notShown(rows, plan);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, say] = useState('');
  const [more, setMore] = useState(false);
  const [paste, setPaste] = useState('');
  const [pasteError, setPasteError] = useState('');
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const pasteInput = useRef<HTMLInputElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const chipButtons = useRef(new Map<SocialPlatform, HTMLButtonElement>());
  const keptButtons = useRef(new Map<string, HTMLButtonElement>());
  const dragged = useRef<number | null>(null);

  const label = (platform: SocialPlatform) => SOCIAL_PLATFORMS[platform].label;
  const focusRow = (rowId: string | undefined) =>
    requestAnimationFrame(() =>
      (rowId ? inputs.current.get(rowId) : pasteInput.current)?.focus(),
    );
  const update = (next: LinkRow[]) => {
    setDraft((current) => ({ ...current, rows: next }));
    setSaved(false);
  };
  const clearError = (rowId: string) =>
    setErrors((current) => {
      const rest = { ...current };
      delete rest[rowId];
      return rest;
    });

  const full = rows.length >= limit;
  const allowed = sites.filter(
    (platform) => !rows.some((row) => row.platform === platform),
  );
  const chips = more
    ? allowed
    : allowed.filter((platform) => COMMON.includes(platform));

  const add = (platform: SocialPlatform, url = '') => {
    const next = addRow(rows, platform, plan, url);
    const added = next.find((row) => !rows.includes(row));
    update(next);
    say(`${label(platform)} link added.`);
    focusRow(added?.id);
  };

  const addPasted = () => {
    const url = paste.trim();
    const platform = detectPlatform(url);
    if (!platform) {
      setPasteError(
        socialLinkProblem('website', url) === 'link_page'
          ? 'Link pages and short links aren’t supported. Add each site on its own.'
          : 'We don’t recognise that link. Paste a full https:// link from the app or site.',
      );
      return;
    }
    if (!sites.includes(platform)) {
      setPasteError(
        legacy
          ? 'For a moment only Facebook, Instagram and X links can be saved. More sites are coming.'
          : adultOff && isAdultPlatform(platform)
            ? 'OnlyFans and Fansly links can’t be added right now.'
            : `${label(platform)} links are part of TipMe Pro.`,
      );
      return;
    }
    setPaste('');
    setPasteError('');
    add(platform, url);
  };

  const move = (index: number, delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= rows.length) return;
    update(moveRow(rows, index, delta));
    say(
      `${label(rows[index]!.platform)} link moved to ${to + 1} of ${rows.length}.`,
    );
  };

  const remove = (index: number) => {
    const row = rows[index]!;
    update(rows.filter((_, i) => i !== index));
    clearError(row.id);
    say(`${label(row.platform)} link removed.`);
    focusRow(rows[index + 1]?.id ?? rows[index - 1]?.id);
  };

  const showMore = () => {
    const first = allowed.find((platform) => !COMMON.includes(platform));
    setMore(true);
    // The button goes away: focus moves to the first site it revealed.
    requestAnimationFrame(() =>
      (first ? chipButtons.current.get(first) : pasteInput.current)?.focus(),
    );
  };

  const removeKept = (index: number) => {
    const link = kept[index]!;
    const next = kept[index + 1] ?? kept[index - 1];
    setDraft((current) => ({
      ...current,
      kept: current.kept.filter((other) => other !== link),
    }));
    setSaved(false);
    say(`${label(link.platform)} link will be removed when you save.`);
    requestAnimationFrame(() =>
      (next ? keptButtons.current.get(next.url) : saveButton.current)?.focus(),
    );
  };

  const feature = (index: number) => {
    const row = rows[index]!;
    update(toggleFeatured(rows, index));
    say(
      row.featured
        ? `${label(row.platform)} is no longer featured.`
        : `${label(row.platform)} is now the featured link.`,
    );
  };

  const onDrop = (index: number) => (event: DragEvent) => {
    event.preventDefault();
    const from = dragged.current;
    dragged.current = null;
    if (from === null || from === index) return;
    update(moveRow(rows, from, index - from));
    say(
      `${label(rows[from]!.platform)} link moved to ${index + 1} of ${rows.length}.`,
    );
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setFormError('');
    const problems = rowProblems(rows, plan);
    setErrors(problems);
    const first = rows.find((row) => problems[row.id]);
    if (first) {
      focusRow(first.id);
      return;
    }
    if (overflow.length > 0) {
      setFormError(overflowText(overflow, limit));
      return;
    }
    setBusy(true);
    // An API from before social links has no links route: the old profile route takes the three
    // fixed links and the show switch.
    const result = legacy
      ? await apiFetch<MyProfile>('/v1/me/profile', {
          method: 'PATCH',
          body: legacyPatch(rows, draft.show),
        })
      : await apiFetch<MyProfile>('/v1/me/links', {
          method: 'PUT',
          body: {
            links: toRequest(rows, plan),
            show: draft.show,
            ...(pro ? {} : { hidden: kept.map((link) => link.url) }),
          },
        });
    setBusy(false);
    if (result.ok) {
      setProfile(result.data);
      setDraft(linksDraftFrom(result.data));
      setSaved(true);
      return;
    }
    if (result.code === 'SOCIAL_LINKS_PRO_REQUIRED') {
      setFormError(PRO_REQUIRED);
      return;
    }
    if (result.code === 'SOCIAL_LINK_UNAVAILABLE') {
      setFormError('OnlyFans and Fansly links can’t be added right now.');
      return;
    }
    // The server names a link by its place in the saved list (links.N.url), or, on an older
    // API, by its site (socials.instagram).
    const sent = toRequest(rows, plan);
    const byField = Object.fromEntries(
      (result.fields ?? []).flatMap((field) => {
        const index = /^links\.(\d+)\./.exec(field)?.[1];
        const site = /^socials\.(\w+)$/.exec(field)?.[1];
        const row =
          index !== undefined
            ? rows.find((r) => r.url === sent[Number(index)]?.url)
            : rows.find((r) => r.platform === site);
        return row ? [[row.id, 'Check this link.']] : [];
      }),
    );
    setErrors(byField);
    const wrong = rows.find((row) => byField[row.id]);
    if (wrong) focusRow(wrong.id);
    else setFormError('We couldn’t save your links. Please try again.');
  };

  return (
    <Card className="settings-section">
      <h3>Your links</h3>
      <p className="tm-hint">
        Where else supporters can find you. Each link shows the handle we read
        from it, so they can check it’s really you.
      </p>
      <form className="settings-form" onSubmit={save} noValidate>
        {rows.length > 0 && (
          <ol
            className="link-rows"
            aria-label="Your links, in the order your page shows them"
          >
            {rows.map((row, index) => {
              const name = label(row.platform);
              const inputId = `${id}-${row.id}`;
              const error = errors[row.id];
              return (
                <li
                  key={row.id}
                  className="link-row"
                  data-featured={row.featured || undefined}
                  onDragOver={
                    pro ? (event) => event.preventDefault() : undefined
                  }
                  onDrop={pro ? onDrop(index) : undefined}
                >
                  <div className="link-row__head">
                    {pro && (
                      <span
                        className="link-row__grip"
                        draggable
                        onDragStart={() => (dragged.current = index)}
                        aria-hidden="true"
                        title="Drag to reorder"
                      >
                        ⋮⋮
                      </span>
                    )}
                    <label className="link-row__label" htmlFor={inputId}>
                      <LinkBadge platform={row.platform} />
                      <span>{name} link</span>
                    </label>
                    {row.featured && (
                      <span className="link-row__tag">Featured</span>
                    )}
                    <span className="link-row__tools">
                      {pro && (
                        <>
                          <button
                            type="button"
                            className="link-row__tool"
                            aria-pressed={row.featured}
                            aria-label={`Feature the ${name} link`}
                            onClick={() => feature(index)}
                          >
                            {row.featured ? '★' : '☆'}
                          </button>
                          <button
                            type="button"
                            className="link-row__tool"
                            aria-label={`Move the ${name} link up`}
                            aria-disabled={index === 0 || undefined}
                            onClick={() => move(index, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="link-row__tool"
                            aria-label={`Move the ${name} link down`}
                            aria-disabled={
                              index === rows.length - 1 || undefined
                            }
                            onClick={() => move(index, 1)}
                          >
                            ↓
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="link-row__tool"
                        aria-label={`Remove the ${name} link`}
                        onClick={() => remove(index)}
                      >
                        ×
                      </button>
                    </span>
                  </div>
                  <input
                    ref={(element) => {
                      if (element) inputs.current.set(row.id, element);
                      else inputs.current.delete(row.id);
                    }}
                    id={inputId}
                    className="tm-input"
                    type="url"
                    inputMode="url"
                    autoComplete="url"
                    maxLength={200}
                    placeholder={placeholder(row.platform)}
                    value={row.url}
                    onChange={(event) => {
                      update(setRowUrl(rows, index, event.target.value));
                      clearError(row.id);
                    }}
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? `${inputId}-error` : undefined}
                  />
                  {adultOff && isAdultPlatform(row.platform) && (
                    <p className="tm-hint">
                      Not showing on your page right now. It stays saved.
                    </p>
                  )}
                  {error && (
                    <p
                      className="tm-field-error"
                      id={`${inputId}-error`}
                      role="alert"
                    >
                      {error}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {keptStatus.length > 0 && (
          <div className="link-kept">
            <p className="link-kept__title" id={`${id}-kept`}>
              Kept from Pro
            </p>
            <p className="tm-hint">
              These stay saved for when you’re back on Pro. You can remove them;
              adding more is part of Pro.
            </p>
            <ul className="link-kept__list" aria-labelledby={`${id}-kept`}>
              {keptStatus.map(({ link, status }, index) => (
                <li key={link.url} data-status={status}>
                  <LinkBadge platform={link.platform} small />
                  <span className="link-kept__name">
                    {label(link.platform)}
                    {linkHandle(link) ? `: ${linkHandle(link)}` : ''}
                  </span>
                  <span className="link-kept__status">
                    {status === 'will_show'
                      ? 'Will show on your page when you save'
                      : status === 'pro'
                        ? 'Not shown: part of Pro'
                        : 'Not shown: Free shows 3 links'}
                  </span>
                  <button
                    ref={(element) => {
                      if (element) keptButtons.current.set(link.url, element);
                      else keptButtons.current.delete(link.url);
                    }}
                    type="button"
                    className="link-row__tool"
                    aria-label={`Remove the kept ${label(link.platform)} link`}
                    onClick={() => removeKept(index)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {full ? (
          !pro && (
            <Link className="link-add link-add--pro" href="/pro">
              Add more links with Pro (up to 8)
            </Link>
          )
        ) : (
          <>
            <div className="link-paste">
              <InputField
                ref={pasteInput}
                id={`${id}-paste`}
                label="Add a link"
                type="url"
                inputMode="url"
                placeholder="Paste a link from the app"
                value={paste}
                onChange={(event) => {
                  setPaste(event.target.value);
                  setPasteError('');
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addPasted();
                  }
                }}
                error={pasteError}
              />
              <Button
                type="button"
                variant="secondary"
                onClick={addPasted}
                disabled={!paste.trim()}
              >
                Add
              </Button>
            </div>
            {chips.length > 0 && (
              <div
                className="link-chips"
                role="group"
                aria-label="Or add a site"
              >
                {chips.map((platform) => (
                  <button
                    ref={(element) => {
                      if (element) chipButtons.current.set(platform, element);
                      else chipButtons.current.delete(platform);
                    }}
                    key={platform}
                    type="button"
                    className="link-chip"
                    onClick={() => add(platform)}
                  >
                    + {label(platform)}
                  </button>
                ))}
                {!more && allowed.length > chips.length && (
                  <button
                    type="button"
                    className="link-chip"
                    onClick={showMore}
                  >
                    + more
                  </button>
                )}
              </div>
            )}
            {legacy && (
              <p className="tm-hint">More sites are coming in a moment.</p>
            )}
          </>
        )}
        {overflow.length > 0 && (
          <p className="tm-hint link-overflow">
            {overflowText(overflow, limit)}
          </p>
        )}
        <p className="tm-hint">
          {pro
            ? `${rows.length} of ${limit}. Use the arrows (or drag ⋮⋮) to reorder; ★ makes one the big key on your page.`
            : `${rows.length} of ${limit} used. Paste a link from the app and we’ll spot which site it is.`}
        </p>
        <label className="tip-remember" htmlFor={`${id}-show`}>
          <input
            id={`${id}-show`}
            type="checkbox"
            checked={draft.show}
            onChange={(event) => {
              const show = event.target.checked;
              setDraft((current) => ({ ...current, show }));
              setSaved(false);
            }}
          />
          <span>Show my links on my page</span>
        </label>
        {formError && (
          <Notice tone="error" title="Not saved">
            {formError}
          </Notice>
        )}
        <Button ref={saveButton} type="submit" disabled={busy} aria-busy={busy}>
          Save links
        </Button>
        <p role="status" className="settings-saved">
          {saved ? 'Saved' : ''}
        </p>
        <p className="sr-only" aria-live="polite">
          {said}
        </p>
      </form>
    </Card>
  );
}
