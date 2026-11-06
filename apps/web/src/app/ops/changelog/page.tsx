'use client';
import { useCallback, useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { OpsChangelogList, OpsChangelogView } from '@tipme/contracts';
import { Button, EmptyWell, Skeleton, Slip } from '@tipme/ui';
import {
  CHANGELOG_VIEW_CHOICES,
  changelogNotes,
  changelogStamp,
  changelogView,
  firstLine,
} from '@/lib/changelog-words';
import { can, useOpsAccess, when } from '@/lib/ops-client';
import { refusalWords } from '@/lib/ops-answers';
import { opsFetch } from '@/lib/ops-staff-api';

const EMPTY: Record<OpsChangelogView, { title: string; text: string }> = {
  all: {
    title: 'No merged pull requests yet.',
    text: 'Each pull request merged into dev appears here as a draft.',
  },
  drafts: {
    title: 'No drafts.',
    text: 'Nothing is waiting to be written or approved for users.',
  },
  users: {
    title: 'Nothing approved for users yet.',
    text: 'Approved entries show here, and in What’s new once they are live.',
  },
  staff: {
    title: 'No staff-only entries.',
    text: 'Entries with no text for users are recorded here.',
  },
};

/**
 * Every merged pull request, newest merged first, 50 at a time (changelog plan, Design §5). Open to
 * changelog.edit or changelog.publish; the server checks every call.
 */
export default function ChangelogPage() {
  const id = useId();
  const access = useOpsAccess();
  const allowed =
    can(access, 'changelog.edit') || can(access, 'changelog.publish');
  const router = useRouter();
  const pathname = usePathname();
  const view = changelogView(useSearchParams().get('view'));
  const [list, setList] = useState<OpsChangelogList | null>(null);
  const [failed, setFailed] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchPage = useCallback(
    (before?: number) =>
      opsFetch<OpsChangelogList>(
        `/v1/ops/changelog?view=${view}${before ? `&before=${before}` : ''}`,
      ),
    [view],
  );

  useEffect(() => {
    if (!allowed) return;
    let current = true;
    void fetchPage().then((result) => {
      if (!current) return;
      if (result.ok) {
        setList(result.data);
        setFailed('');
      } else setFailed(refusalWords(result));
    });
    return () => {
      current = false;
    };
  }, [allowed, fetchPage]);

  if (!allowed)
    return (
      <Slip tone="neutral" title="Not part of your role" dense>
        The changelog needs changelog.edit or changelog.publish.
      </Slip>
    );

  const choose = (next: OpsChangelogView) => {
    if (next === view) return;
    setList(null);
    setFailed('');
    router.replace(next === 'all' ? pathname : `${pathname}?view=${next}`, {
      scroll: false,
    });
  };

  const loadMore = async () => {
    if (!list?.nextBefore) return;
    setLoadingMore(true);
    const result = await fetchPage(list.nextBefore);
    setLoadingMore(false);
    if (result.ok)
      setList({
        rows: [...list.rows, ...result.data.rows],
        nextBefore: result.data.nextBefore,
      });
    else setFailed(refusalWords(result));
  };

  return (
    <section className="dashboard-section">
      <h1>Changelog</h1>
      <p className="tm-hint">
        Every pull request merged into dev, newest first. Staff text stays in
        admin. Users read an entry in What’s new only after a publisher approves
        it and the change is live in production.
      </p>
      <div
        className="filter-row"
        role="group"
        aria-label="Show"
        aria-controls={`${id}-list`}
      >
        {CHANGELOG_VIEW_CHOICES.map((choice) => (
          <Button
            key={choice.view}
            variant={view === choice.view ? 'primary' : 'secondary'}
            aria-pressed={view === choice.view}
            onClick={() => choose(choice.view)}
          >
            {choice.label}
          </Button>
        ))}
      </div>
      {failed && (
        <Slip tone="error" title="Couldn’t load the changelog" dense>
          {failed}
        </Slip>
      )}
      {!list && !failed && <Skeleton label="Loading the changelog" />}
      {list?.rows.length === 0 && (
        <EmptyWell title={EMPTY[view].title}>{EMPTY[view].text}</EmptyWell>
      )}
      {list && list.rows.length > 0 && (
        <ul className="ops-list" id={`${id}-list`} aria-label="Entries">
          {list.rows.map((row) => {
            const notes = changelogNotes(row);
            return (
              <li key={row.number}>
                <article
                  className="ops-row"
                  aria-labelledby={`${id}-${row.number}`}
                >
                  <div className="ops-row__head">
                    <h2
                      className="ops-changelog__number"
                      id={`${id}-${row.number}`}
                    >
                      <Link href={`/ops/changelog/${row.number}`}>
                        #{row.number}
                      </Link>
                    </h2>
                    <strong>{changelogStamp(row)}</strong>
                    {notes.map((note) => (
                      <span key={note} className="tm-hint">
                        · {note}
                      </span>
                    ))}
                  </div>
                  <p>{firstLine(row.staffText)}</p>
                  <p className="tm-hint">Merged {when(row.mergedAt)}</p>
                </article>
              </li>
            );
          })}
        </ul>
      )}
      {list?.nextBefore && (
        <Button
          variant="secondary"
          disabled={loadingMore}
          aria-busy={loadingMore}
          onClick={() => void loadMore()}
        >
          Show older entries
        </Button>
      )}
    </section>
  );
}
