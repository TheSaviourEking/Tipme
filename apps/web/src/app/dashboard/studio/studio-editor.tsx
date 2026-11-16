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
import type { MyStudio } from '@tipme/contracts';
import { Button, EmptySlip, Notice, Skeleton, Slip } from '@tipme/ui';
import { useRecipient } from '@/components/account/recipient-context';
import { LoadFailed } from '@/components/dashboard/load-failed';
import { apiFetch } from '@/lib/session-client';
import { CheckPanel } from './check-panel';
import { saveWords } from './studio-editor-model';
import { StudioPreview, type PreviewDevice } from './studio-preview';
import { StyleTab } from './style-tab';
import { useStudioDraft } from './use-studio-draft';
import './studio-editor.css';

const MY_PAGE = '/dashboard/settings#page';

/*
 * The tabs, in the board's order. G2 adds { key: 'blocks', label: 'Blocks' } between Style and
 * Check (the rows list, row toolbar and block forms).
 */
const TABS = [
  { key: 'style', label: 'Style' },
  { key: 'check', label: 'Check' },
] as const;
type Tab = (typeof TABS)[number]['key'];

/**
 * The editor's own breakpoints (studio-editor.css): from 1024px the desktop preview and its
 * Phone/Desktop switch; from 1280px the design check beside the preview.
 */
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
 * Page Studio (plan Task 9, PR G1: shell, Style tab, design check). Reached from My page while the
 * `page_studio` switch is on; the API answers 404 while it is off, and so does this page.
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
  const { studio } = answer;
  // Free: the honest Pro message for now; G3 opens the whole editor on a preview that is never
  // saved ("Preview only: not published"). Lapsed: G3 shows the kept design read-only.
  if (studio.access !== 'edit')
    return (
      <div className="pst-gate">
        <h1 className="pst-gate__title">Page Studio</h1>
        <Slip
          title={
            studio.access === 'lapsed'
              ? 'Your design is kept'
              : 'Page Studio comes with Pro'
          }
          actions={
            <>
              <Link className="tm-button tm-button--primary" href="/pro">
                See Pro
              </Link>
              <Link className="tm-button tm-button--quiet" href={MY_PAGE}>
                Back to My page
              </Link>
            </>
          }
        >
          {studio.access === 'lapsed'
            ? 'Your page shows the standard TipMe design while you’re on Free. Your Page Studio design, draft and photos are kept, and come back when Pro does.'
            : 'Design your own page: any colour, fonts from our library, and your own rows of words and photos. TipMe keeps it readable on every phone.'}
        </Slip>
      </div>
    );
  return <StudioEditor initial={studio} />;
}

function StudioEditor({ initial }: { initial: MyStudio }) {
  const id = useId();
  const { profile } = useRecipient();
  const studio = useStudioDraft(initial);
  const wide = useMedia('(min-width: 1024px)');
  const roomy = useMedia('(min-width: 1280px)');
  const [tab, setTab] = useState<Tab>('style');
  const [device, setDevice] = useState<PreviewDevice>('desktop');
  const refs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const readOnly = studio.stale || studio.proEnded;
  const count = studio.check.issues.length;
  const published =
    studio.published === null
      ? false
      : JSON.stringify(studio.published) === JSON.stringify(studio.draft)
        ? 'same'
        : true;
  const shownDevice: PreviewDevice = wide ? device : 'phone';

  const open = (key: Tab) => {
    setTab(key);
    refs.current[key]?.focus();
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

  return (
    <div className="pst">
      <header className="pst-bar">
        <div className="pst-bar__name">
          <h1>Page Studio</h1>
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
            <div
              className="filter-row pst-device"
              role="group"
              aria-label="Preview size"
            >
              {(['phone', 'desktop'] as const).map((d) => (
                <Button
                  key={d}
                  variant="secondary"
                  aria-pressed={device === d}
                  onClick={() => setDevice(d)}
                >
                  {d === 'phone' ? 'Phone' : 'Desktop'}
                </Button>
              ))}
            </div>
          )}
          <Link className="tm-button tm-button--quiet" href={MY_PAGE}>
            Back to My page
          </Link>
        </div>
      </header>
      {studio.stale && (
        <Notice tone="neutral" title="This draft changed in another tab">
          Your design was saved somewhere else after this page opened, so we
          stopped saving here to keep that version.{' '}
          <Button variant="secondary" onClick={() => void studio.reload()}>
            Show the latest
          </Button>
        </Notice>
      )}
      {studio.proEnded && (
        <Notice tone="neutral" title="Your Pro has ended">
          Your design and draft are kept, and you can look at them. Editing
          comes back with Pro. <Link href="/pro">See Pro</Link>
        </Notice>
      )}
      <div className="pst-body">
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
                {t.key === 'check' && count > 0 && (
                  <span className="pst-tabs__badge">
                    {count}
                    <span className="sr-only"> to fix</span>
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
                    draft={studio.draft}
                    check={studio.check}
                    onChange={studio.change}
                    readOnly={readOnly}
                  />
                ) : (
                  <CheckPanel
                    id={`${id}-tab-check`}
                    check={studio.check}
                    draft={studio.draft}
                    onFix={studio.fix}
                    readOnly={readOnly}
                  />
                ))}
            </div>
          ))}
        </div>
        <section className="pst-preview" aria-labelledby={`${id}-preview`}>
          <div className="pst-preview__head">
            <h2 id={`${id}-preview`}>Preview</h2>
            <p>
              {shownDevice === 'phone' ? 'Phone, 390 px' : 'Desktop, 1280 px'}
            </p>
          </div>
          <p className="sr-only">
            A picture of your page as supporters will see it. It follows every
            change you make.
          </p>
          <StudioPreview
            draft={studio.draft}
            images={initial.images}
            profile={profile}
            device={shownDevice}
          />
        </section>
        {/* Wide screens: the check stays beside the preview (the board's right panel). */}
        {roomy && tab !== 'check' && (
          <aside className="pst-aside" aria-label="Design check">
            <CheckPanel
              id={`${id}-side-check`}
              check={studio.check}
              draft={studio.draft}
              onFix={studio.fix}
              readOnly={readOnly}
            />
          </aside>
        )}
      </div>
      {/* Phones: the count stays in reach, and opens the Check tab. */}
      {!wide && tab !== 'check' && (
        <div className="pst-sheet">
          <span>
            Design check:{' '}
            {count === 0 ? 'every check passes' : `${count} to fix`}
          </span>
          <Button variant="secondary" onClick={() => open('check')}>
            Show the check
          </Button>
        </div>
      )}
    </div>
  );
}
