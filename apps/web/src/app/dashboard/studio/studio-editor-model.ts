/**
 * Page Studio editor on v2 (styles plan Task 12, PR 4a): the editor's pure parts. Plain TypeScript
 * with no `@/` imports, so its unit test runs in Node (test/studio-editor.test.mjs).
 */
import {
  STUDIO_ERROR_RULES_V3,
  STUDIO_FIX_LINKS_V3,
  STUDIO_FIX_NEEDS_INPUT_V3,
  STUDIO_WEIGHT,
  type StudioCheckResult,
  type StudioDocument,
  type StudioFix,
  type StudioIssue,
  type StudioRuleId,
} from '@tipme/contracts';

/**
 * The check the editor shows: the server's (the authority) while the draft is the one it checked,
 * the editor's own instant check as soon as anything changes.
 */
export function checkShown(
  doc: StudioDocument,
  local: StudioCheckResult,
  server: { doc: string; check: StudioCheckResult } | null,
): StudioCheckResult {
  return server && server.doc === JSON.stringify(doc) ? server.check : local;
}

/** The Check tab's badge (§10): "Pass", or "N to fix". */
export const checkBadge = (count: number) =>
  count === 0 ? 'Pass' : `${count} to fix`;

/** The fixes a button applies in one click. */
export function fixesNow(issue: StudioIssue): StudioFix[] {
  return issue.fixes.filter(
    (f) =>
      !STUDIO_FIX_NEEDS_INPUT_V3.includes(f.id) &&
      !STUDIO_FIX_LINKS_V3.includes(f.id),
  );
}

/** Fixes that need a choice, a photo, a link or words: they open the Style tab or a block's form. */
export function fixesInput(issue: StudioIssue): StudioFix[] {
  return issue.fixes.filter((f) => STUDIO_FIX_NEEDS_INPUT_V3.includes(f.id));
}

/** Fixes that are a link ("See Pro"). */
export function fixesLinks(issue: StudioIssue): StudioFix[] {
  return issue.fixes.filter((f) => STUDIO_FIX_LINKS_V3.includes(f.id));
}

/**
 * The tab that answers an issue: the page-level ones (`at.row` 'style' or 'accent', the check's
 * `pro-only` for a Pro style or the photo accent) are the Style tab's; a block's are the Blocks
 * tab's.
 */
export function issueTab(issue: Pick<StudioIssue, 'at'>): 'style' | 'blocks' {
  return issue.at.row === 'style' || issue.at.row === 'accent'
    ? 'style'
    : 'blocks';
}

const PASSING: Record<
  (typeof STUDIO_ERROR_RULES_V3)[number],
  (check: StudioCheckResult) => string
> = {
  'pro-only': () => 'Everything here comes with your plan',
  'photo-resolution': () => 'Photos are sharp',
  'photo-alt': () => 'Photos are described',
  'empty-block': () => 'No empty blocks',
  'broken-video': () => 'Videos and links work',
  'page-weight': (check) =>
    `Page weight: ${Math.round(check.weightBytes / 1000)} KB of ${STUDIO_WEIGHT.budget / 1_000_000} MB`,
  'long-word': () => 'Long words fit',
};

/** The passing list, in the check's order. */
export function passingWords(check: StudioCheckResult): string[] {
  return check.passing
    .filter((rule): rule is (typeof STUDIO_ERROR_RULES_V3)[number] =>
      (STUDIO_ERROR_RULES_V3 as readonly StudioRuleId[]).includes(rule),
    )
    .map((rule) => PASSING[rule](check));
}

export type SaveState = 'saved' | 'pending' | 'saving' | 'failed';

/**
 * The header's status line (§10: "Saved · not published"). `published`: false before the first
 * publish, true when the draft differs from the published page, 'same' when it doesn't.
 */
export function saveWords(state: SaveState, published: boolean | 'same') {
  if (state === 'failed') return 'Not saved';
  if (state !== 'saved') return 'Saving…';
  return published === 'same' ? 'Published' : 'Saved · not published';
}

/**
 * What the dashboard offers, from the answer to `GET /v1/me/studio`: nothing while Page Studio is
 * switched off (404) or the answer failed; otherwise the editor, for every page (§5.4).
 */
export function studioEntry(answer: {
  status: number;
  access?: 'edit';
}): 'edit' | null {
  return answer.status === 200 && answer.access === 'edit' ? 'edit' : null;
}
