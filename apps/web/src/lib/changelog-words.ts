/*
 * How the admin changelog screens put an entry into words (changelog plan, Design §5). Type-only
 * imports, so the rules can be tested alone, and no provider's name: the hint and problem words
 * are read by staff who then write what users read.
 */
import type {
  ChangelogTextProblem,
  OpsChangelogRow,
  OpsChangelogView,
} from '@tipme/contracts';

export const CHANGELOG_VIEW_CHOICES: {
  view: OpsChangelogView;
  label: string;
}[] = [
  { view: 'all', label: 'All' },
  { view: 'drafts', label: 'Drafts' },
  { view: 'users', label: 'For users' },
  { view: 'staff', label: 'Staff only' },
];

/** The filter a `?view=` names; anything else is All. */
export function changelogView(
  raw: string | null | undefined,
): OpsChangelogView {
  return (
    CHANGELOG_VIEW_CHOICES.find((choice) => choice.view === raw)?.view ?? 'all'
  );
}

// "6 Nov": the day it went live, in Lagos time.
const shortDay = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'Africa/Lagos',
});

/** The state stamp on a row and on the entry page. */
export function changelogStamp(
  row: Pick<OpsChangelogRow, 'state' | 'stagingAt' | 'liveAt'>,
): string {
  switch (row.state) {
    case 'draft':
      return 'Draft';
    case 'recorded':
      return 'Recorded';
    case 'withdrawn':
      return 'Withdrawn';
    case 'approved':
      return row.stagingAt
        ? 'Approved · on staging'
        : 'Approved · not on staging yet';
    case 'live':
      return row.liveAt
        ? `Live ${shortDay.format(new Date(row.liveAt))}`
        : 'Live';
  }
}

/** What else staff should know at a glance: an edit users don't read yet, a request waiting. */
export function changelogNotes(
  row: Pick<
    OpsChangelogRow,
    'unapprovedEdit' | 'waitingRequestId' | 'editedSinceAsking'
  >,
): string[] {
  const notes: string[] = [];
  if (row.unapprovedEdit) notes.push('Edited, waiting for approval');
  if (row.waitingRequestId) {
    notes.push('Waiting in Approvals');
    // Approving that request now would stop without running: it asked about an older text.
    if (row.editedSinceAsking === true) notes.push('Edited since asking');
  }
  return notes;
}

const PROBLEM_WORDS: Record<ChangelogTextProblem, string> = {
  provider_name:
    'It names our payment partner. Users never see their name: say “our payment partner”, or leave it out.',
  regulatory_claim:
    'It sounds like TipMe is licensed, regulated, approved or guaranteed by someone. Say what changed, without that.',
  too_long: 'It is longer than 280 characters.',
};

/** Why a user text can't be shown, in words; names the server doesn't send are skipped. */
export function problemWords(problems: readonly string[]): string[] {
  return problems.flatMap((problem) =>
    problem in PROBLEM_WORDS
      ? [PROBLEM_WORDS[problem as ChangelogTextProblem]]
      : [],
  );
}

/** Characters as the server counts them (code points), so the live count matches its limit. */
export const codePointCount = (text: string) => Array.from(text).length;

/** The staff text's first line, for the list. */
export const firstLine = (text: string) => (text.split('\n')[0] ?? '').trim();
