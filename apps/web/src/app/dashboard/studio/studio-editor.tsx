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
import { ConfirmDialog } from '@/components/confirm-dialog';
import { LoadFailed } from '@/components/dashboard/load-failed';
import { apiFetch } from '@/lib/session-client';
import { BlocksTab, type BlocksTarget } from './blocks-tab';
import { fixTarget } from './blocks-model';
import { CheckPanel } from './check-panel';
import { RadioGroup } from './segmented';
import { PublishDialog } from './publish-dialog';
import {
  RELOAD_FAILED,
  checkBadge,
  hasChangesToDiscard,
  publishLabel,
  saveWords,
  staleBannerWords,
  type PublishFailure,
} from './studio-editor-model';
import { StudioPreview, type PreviewDevice } from './studio-preview';
import { StyleTab } from './style-tab';
import { accentHeading, styleSummary } from './style-tab-model';
import { useStudioDraft } from './use-studio-draft';
import { undoButtonName } from './undo-stack';
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

/**
 * Where Ctrl/Cmd+Z is the field's own undo, not the editor's (§12.2): text you type into. A
 * checkbox or a radio is an input but not a text field.
 */
function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement)
    return true;
  if (target instanceof HTMLSelectElement) return true;
  return (
    target instanceof HTMLInputElement &&
    ![
      'checkbox',
      'radio',
      'button',
      'submit',
      'reset',
      'range',
      'color',
      'file',
    ].includes(target.type)
  );
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
  // The publish gate (§12.1): the dialog, a publish on its way, and the last try's failure.
  const publishRef = useRef<HTMLButtonElement>(null);
  const [gate, setGate] = useState<{
    busy: boolean;
    failure: PublishFailure | null;
  } | null>(null);
  /** The read-only banner: where a press on Publish goes while nothing can be published. */
  const bannerRef = useRef<HTMLDivElement>(null);
  /** The banner's "Show the latest", where focus goes when the latest couldn't be loaded. */
  const showLatestRef = useRef<HTMLButtonElement>(null);
  const [reloadFailed, setReloadFailed] = useState(false);
  // Discard (§12.3): the question, a discard on its way, and whether the last one failed.
  const [discardAsk, setDiscardAsk] = useState<{
    busy: boolean;
    failed: boolean;
  } | null>(null);
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
  const canUndo = studio.canUndo && !readOnly;
  // Not while another tab's newer draft is unseen: a discard would throw that away too.
  const canDiscard = !studio.stale && hasChangesToDiscard(draft, published);

  /**
   * "Show the latest", from the banner or the dialog. If the latest can't be read, the banner
   * stays and says so, and focus goes to its button (the dialog, if open, closes first).
   */
  const showLatest = async (fromDialog: boolean) => {
    const loaded = await studio.reload();
    setReloadFailed(!loaded);
    if (loaded) {
      if (fromDialog) closeGate();
      return;
    }
    if (fromDialog) setGate(null);
    requestAnimationFrame(() =>
      showLatestRef.current?.focus({ preventScroll: true }),
    );
  };

  const discard = async () => {
    if (discardAsk?.busy) return;
    setDiscardAsk({ busy: true, failed: false });
    const done = await studio.discard();
    if (done) {
      setDiscardAsk(null);
      setCoverChoice(studio.published?.cover ?? 'yours');
    } else setDiscardAsk({ busy: false, failed: true });
  };

  // Ctrl/Cmd+Z outside a text field is the editor's Undo (§12.2). Not while a dialog is open.
  const undoKey = useRef(() => {});
  useEffect(() => {
    undoKey.current = () => {
      if (canUndo) studio.undo();
    };
  });
  useEffect(() => {
    const press = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'z' || event.shiftKey || event.altKey)
        return;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (inTextField(event.target)) return;
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault();
      undoKey.current();
    };
    window.addEventListener('keydown', press);
    return () => window.removeEventListener('keydown', press);
  }, []);

  /** Closes the gate; focus goes back to Publish unless a fix is taking it elsewhere. */
  const closeGate = (refocus = true) => {
    setGate(null);
    if (refocus)
      requestAnimationFrame(() =>
        publishRef.current?.focus({ preventScroll: true }),
      );
  };
  const publish = async () => {
    if (gate?.busy || readOnly) return;
    setGate({ busy: true, failure: null });
    const outcome = await studio.publish();
    // Published: the status line says so. Refused: the server's issues are now the check, and
    // the same dialog lists them. Failed: said in the dialog, which stays.
    if (outcome === 'published') closeGate();
    else
      setGate({
        busy: false,
        failure: 'failed' in outcome ? outcome.failed : null,
      });
  };

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
          {/* aria-disabled, never disabled: focus stays on it after the last undo. */}
          <Button
            variant="quiet"
            className="pst-bar__undo"
            aria-label={canUndo ? undoButtonName(studio.undoLabel) : undefined}
            aria-disabled={!canUndo || undefined}
            onClick={() => {
              if (canUndo) studio.undo();
            }}
          >
            Undo
          </Button>
          <Button
            variant="quiet"
            className="pst-bar__discard"
            aria-haspopup="dialog"
            aria-disabled={!canDiscard || undefined}
            onClick={() => {
              if (canDiscard) setDiscardAsk({ busy: false, failed: false });
            }}
          >
            Discard changes
          </Button>
          {/* aria-disabled, never disabled: while issues remain it stays focusable and opens the list. */}
          <button
            ref={publishRef}
            type="button"
            className="pst-publish-button"
            aria-disabled={count > 0 || readOnly || undefined}
            aria-haspopup="dialog"
            onClick={() => {
              // Read-only (another tab saved, or a save needed Pro): the banner says why.
              if (readOnly) bannerRef.current?.focus();
              else setGate({ busy: false, failure: null });
            }}
          >
            {publishLabel(count)}
          </button>
        </div>
      </header>
      {gate && (
        <PublishDialog
          check={studio.check}
          summary={styleSummary(draft, draft.blocks.length)}
          busy={gate.busy}
          failure={gate.failure}
          save={studio.save}
          unsaved={studio.unsaved}
          onShowLatest={() => void showLatest(true)}
          readOnly={readOnly}
          onPublish={() => void publish()}
          onFix={studio.fix}
          onInput={(issue, fixId) => {
            closeGate(false);
            input(issue, fixId);
          }}
          onClose={() => closeGate()}
        />
      )}
      {discardAsk && (
        <ConfirmDialog
          title="Discard your changes?"
          confirm="Discard changes"
          cancel="Keep editing"
          busy={discardAsk.busy}
          onConfirm={() => void discard()}
          onCancel={() => setDiscardAsk(null)}
        >
          <p>Your page stays as it is now.</p>
          {discardAsk.failed && (
            <p className="pst-publish__failed" role="alert">
              Your changes weren’t discarded. Try again in a moment.
            </p>
          )}
        </ConfirmDialog>
      )}
      {/* R4: an undo the server refused on Free. Always rendered, so the sentence is announced. */}
      <p
        className="pst-notice"
        role="status"
        data-shown={studio.notice ? true : undefined}
      >
        {studio.notice}
      </p>
      {readOnly && (
        <div ref={bannerRef} tabIndex={-1} className="pst-banner">
          {studio.stale ? (
            <Slip tone="neutral" title="This draft changed in another tab">
              {staleBannerWords(studio.unsaved)}{' '}
              <Button
                ref={showLatestRef}
                variant="secondary"
                onClick={() => void showLatest(false)}
              >
                Show the latest
              </Button>
            </Slip>
          ) : (
            <Slip tone="neutral" title="That change needs Pro">
              Your draft is kept as it was last saved.{' '}
              <Link href="/pro">See Pro</Link>{' '}
              <Button
                ref={showLatestRef}
                variant="secondary"
                onClick={() => void showLatest(false)}
              >
                Show the latest
              </Button>
            </Slip>
          )}
          {reloadFailed && (
            <p className="pst-banner__failed" role="alert">
              {RELOAD_FAILED}
            </p>
          )}
        </div>
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
