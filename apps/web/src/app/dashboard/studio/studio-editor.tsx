'use client';
import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  STUDIO_STYLES,
  accentValues,
  resolveStudio,
  type MyStudio,
  type StudioIssue,
} from '@tipme/contracts';
import { Button, EmptySlip, Skeleton, Slip } from '@tipme/ui';
import { useRecipient } from '@/components/account/recipient-context';
import { LoadFailed } from '@/components/dashboard/load-failed';
import { apiFetch } from '@/lib/session-client';
import { BlocksTab, type BlocksTarget } from './blocks-tab';
import { fixTarget } from './blocks-model';
import { CheckPanel } from './check-panel';
import { RadioGroup } from './segmented';
import { checkBadge, saveWords } from './studio-editor-model';
import { StudioPreview, type PreviewDevice } from './studio-preview';
import { StyleTab } from './style-tab';
import { accentHeading } from './style-tab-model';
import { useStudioDraft } from './use-studio-draft';
import { editorFontFaces } from './editor-fonts';
import './studio-editor.css';

const MY_PAGE = '/dashboard/settings#page';

/** The tabs, in the canvas's order. */
const TABS = [
  { key: 'style', label: 'Style' },
  { key: 'blocks', label: 'Blocks' },
  { key: 'check', label: 'Check' },
] as const;
type Tab = (typeof TABS)[number]['key'];

/** The editor's desktop layout (studio-editor.css): the preview area beside a 560 px panel. */
function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/**
 * Page Studio (styles spec §10; plan Task 12, PR 4a): the editor on v2, for every page (Free saves
 * and publishes the free styles, §11). Reached from My page while the `page_studio` switch is on;
 * the API answers 404 while it is off, and so does this page.
 */
export function StudioEditorRoute() {
  const [answer, setAnswer] = useState<
    | { state: 'loading' }
    | { state: 'off' }
    | { state: 'failed' }
    | { state: 'ready'; studio: MyStudio }
  >({ state: 'loading' });
  const read = useCallback(async () => {
    const result = await apiFetch<MyStudio>('/v1/me/studio');
    if (result.ok) setAnswer({ state: 'ready', studio: result.data });
    else if (result.status === 404) setAnswer({ state: 'off' });
    else setAnswer({ state: 'failed' });
  }, []);
  useEffect(() => {
    // The first read, once the page is in the browser (the dashboard renders there).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void read();
  }, [read]);
  if (answer.state === 'loading')
    return <Skeleton label="Loading Page Studio" />;
  if (answer.state === 'failed')
    return (
      <div className="pst-gate">
        <h1 className="pst-gate__title">Page Studio</h1>
        <LoadFailed title="Page Studio didn’t load" onRetry={read} />
      </div>
    );
  if (answer.state === 'off')
    return (
      <div className="pst-gate">
        <h1 className="pst-gate__title">Page Studio</h1>
        <EmptySlip
          title="Page Studio isn’t open yet"
          action={
            <Link className="tm-button tm-button--secondary" href={MY_PAGE}>
              Back to My page
            </Link>
          }
        >
          Your page stays as it is for now.
        </EmptySlip>
      </div>
    );
  return <StudioEditor initial={answer.studio} />;
}

/** Today in Lagos, as the server reads a draft's events. */
const lagosToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(
    new Date(),
  );

function StudioEditor({ initial }: { initial: MyStudio }) {
  const id = useId();
  const { profile } = useRecipient();
  const studio = useStudioDraft(initial);
  const wide = useMedia('(min-width: 1024px)');
  const [tab, setTab] = useState<Tab>('style');
  const [device, setDevice] = useState<PreviewDevice>('phone');
  const [target, setTarget] = useState<BlocksTarget | null>(null);
  // The last cover type the person chose, outside the document: browsing styles that lack it
  // (Signboard, Sprint) shows Your cover, and the next style that offers it gets it back.
  const [coverChoice, setCoverChoice] = useState(initial.draft.cover);
  const refs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const cardsId = `${id}-cards`;
  const readOnly = studio.stale || studio.proRequired;
  const count = studio.check.issues.length;
  const { draft, plan, photoAccent } = studio;
  const published =
    studio.published === null
      ? false
      : JSON.stringify(studio.published) ===
          JSON.stringify(resolveStudio(draft, lagosToday()))
        ? 'same'
        : true;

  const open = (key: Tab) => {
    setTab(key);
    refs.current[key]?.focus();
  };
  // A fix that needs the person: the style cards ("Choose a free style"), or a block's form.
  const input = (issue: StudioIssue, fixId: string) => {
    if (fixId === 'choose-free-style') {
      setTab('style');
      // After the Style tab renders: its cards' one Tab stop (the chosen card).
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>(
            `[aria-labelledby="${cardsId}"] [role="radio"][tabindex="0"]`,
          )
          ?.focus(),
      );
      return;
    }
    const to = fixTarget(issue, fixId);
    if (!to) return;
    setTab('blocks');
    setTarget({ ...to, n: (target?.n ?? 0) + 1 });
  };
  const move = (event: KeyboardEvent, index: number) => {
    const last = TABS.length - 1;
    const to =
      event.key === 'ArrowRight'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (to === null) return;
    event.preventDefault();
    open(TABS[to]!.key);
  };

  const style = STUDIO_STYLES[draft.style];
  const preview = (frame: 'small' | 'phone' | 'desktop') => (
    <StudioPreview
      draft={draft}
      images={studio.images}
      profile={profile}
      photoAccent={photoAccent}
      frame={frame}
    />
  );
  const accentName = accentHeading(draft);
  const accentHex = accentValues(
    draft.style,
    draft.accent,
    'light',
    photoAccent,
  ).fill.toUpperCase();

  return (
    <div className="pst">
      <style>{editorFontFaces()}</style>
      <header className="pst-bar">
        <div className="pst-bar__name">
          <h1 className="pst-bar__title">Page Studio</h1>
          <p className="pst-bar__status" role="status">
            {saveWords(studio.save, published)}
          </p>
        </div>
        <div className="pst-bar__actions">
          {studio.save === 'failed' && !readOnly && (
            <Button variant="secondary" onClick={studio.retry}>
              Try saving again
            </Button>
          )}
          {wide && (
            <RadioGroup
              label="Preview size"
              items={(['phone', 'desktop'] as const).map((d) => ({
                value: d,
                key: d,
              }))}
              value={device}
              onChange={setDevice}
              className="pst-device"
              itemClassName="pst-device__choice"
              render={(item) => (item.value === 'phone' ? 'Phone' : 'Desktop')}
            />
          )}
          <Link className="tm-button tm-button--quiet" href={MY_PAGE}>
            Back to My page
          </Link>
        </div>
      </header>
      {studio.stale && (
        <Slip tone="neutral" title="This draft changed in another tab">
          Your design was saved somewhere else after this page opened, so we
          stopped saving here to keep that version.{' '}
          <Button variant="secondary" onClick={() => void studio.reload()}>
            Show the latest
          </Button>
        </Slip>
      )}
      {studio.proRequired && (
        <Slip tone="neutral" title="That change needs Pro">
          Your draft is kept as it was last saved.{' '}
          <Link href="/pro">See Pro</Link>{' '}
          <Button variant="secondary" onClick={() => void studio.reload()}>
            Show the latest
          </Button>
        </Slip>
      )}
      <div className="pst-body">
        {wide && (
          <section className="pst-stage" aria-labelledby={`${id}-preview`}>
            {device === 'desktop' ? preview('desktop') : preview('phone')}
            <div className="pst-stage__words">
              <p id={`${id}-preview`} className="pst-stage__kicker">
                Live preview
              </p>
              <p className="pst-stage__name">{style.name}</p>
              <p className="pst-stage__mood">
                {style.mood}.{' '}
                {draft.accent === 'photo'
                  ? 'Your accent comes from your photo, checked for contrast.'
                  : draft.accent === null
                    ? `Its own accent is ${accentName}.`
                    : `Your accent is ${accentName}.`}
              </p>
              <p className="pst-stage__chip">
                <span style={{ background: accentHex }} aria-hidden="true" />
                {accentName} · {accentHex}
              </p>
            </div>
          </section>
        )}
        <div className="pst-side">
          <div role="tablist" aria-label="Page Studio" className="pst-tabs">
            {TABS.map((t, index) => (
              <button
                key={t.key}
                ref={(node) => {
                  refs.current[t.key] = node;
                }}
                type="button"
                role="tab"
                id={`${id}-${t.key}-tab`}
                aria-controls={`${id}-${t.key}-panel`}
                aria-selected={tab === t.key}
                tabIndex={tab === t.key ? 0 : -1}
                className="pst-tabs__tab"
                onClick={() => setTab(t.key)}
                onKeyDown={(event) => move(event, index)}
              >
                {t.label}
                {t.key === 'check' && (
                  <span
                    className="pst-tabs__badge"
                    data-pass={count === 0 || undefined}
                  >
                    {checkBadge(count)}
                  </span>
                )}
              </button>
            ))}
          </div>
          {TABS.map((t) => (
            <div
              key={t.key}
              role="tabpanel"
              id={`${id}-${t.key}-panel`}
              aria-labelledby={`${id}-${t.key}-tab`}
              hidden={tab !== t.key}
              className="pst-panel"
            >
              {tab === t.key &&
                (t.key === 'style' ? (
                  <StyleTab
                    draft={draft}
                    plan={plan}
                    name={profile.displayName}
                    hasAvatar={studio.context.hasAvatar}
                    photoAccent={photoAccent}
                    check={studio.check}
                    cardsId={cardsId}
                    coverChoice={coverChoice}
                    onCoverChoice={setCoverChoice}
                    {...(wide
                      ? {}
                      : {
                          preview: (
                            <div className="pst-phone-preview">
                              {preview('small')}
                            </div>
                          ),
                        })}
                    onChange={studio.change}
                    onBlocks={() => open('blocks')}
                    readOnly={readOnly}
                  />
                ) : t.key === 'blocks' ? (
                  <BlocksTab
                    draft={draft}
                    plan={plan}
                    update={studio.update}
                    readOnly={readOnly}
                    images={studio.images}
                    upload={studio.upload}
                    links={studio.context.profile.links}
                    target={target}
                  />
                ) : (
                  <CheckPanel
                    id={`${id}-tab-check`}
                    check={studio.check}
                    onFix={studio.fix}
                    onInput={input}
                    readOnly={readOnly}
                  />
                ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
