/**
 * Page Studio editor on v2 (styles plan Task 12, PR 4a): the editor's pure parts. Plain TypeScript
 * with no `@/` imports, so its unit test runs in Node (test/studio-editor.test.mjs).
 */
import {
  STUDIO_ERROR_RULES,
  STUDIO_FIX_LINKS,
  STUDIO_FIX_NEEDS_INPUT,
  STUDIO_STYLES,
  STUDIO_WEIGHT,
  defaultStudioDocument,
  studioKeepHeld,
  studioShown,
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
      !STUDIO_FIX_NEEDS_INPUT.includes(f.id) &&
      !STUDIO_FIX_LINKS.includes(f.id),
  );
}

/** Fixes that need a choice, a photo, a link or words: they open the Style tab or a block's form. */
export function fixesInput(issue: StudioIssue): StudioFix[] {
  return issue.fixes.filter((f) => STUDIO_FIX_NEEDS_INPUT.includes(f.id));
}

/** Fixes that are a link ("See Pro"). */
export function fixesLinks(issue: StudioIssue): StudioFix[] {
  return issue.fixes.filter((f) => STUDIO_FIX_LINKS.includes(f.id));
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
  (typeof STUDIO_ERROR_RULES)[number],
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
    .filter((rule): rule is (typeof STUDIO_ERROR_RULES)[number] =>
      (STUDIO_ERROR_RULES as readonly StudioRuleId[]).includes(rule),
    )
    .map((rule) => PASSING[rule](check));
}

/** The header's Publish button (§12.1): "Publish · N to fix" while issues remain. */
export const publishLabel = (issueCount: number) =>
  issueCount === 0 ? 'Publish' : `Publish · ${issueCount} to fix`;

/** "Design check: N of N pass" (§12.1): the rules that can block publishing, and how many pass. */
export function publishTally(check: StudioCheckResult): string {
  const rules = STUDIO_ERROR_RULES as readonly StudioRuleId[];
  const passing = check.passing.filter((rule) => rules.includes(rule)).length;
  return `Design check: ${passing} of ${rules.length} pass`;
}

/**
 * The check after a refused publish (422 STUDIO_DESIGN_CHECK_FAILED): the server's issues replace
 * the editor's while the draft is the one it refused; the next edit brings the editor's own back.
 */
export function withRefusal(
  doc: StudioDocument,
  shown: StudioCheckResult,
  refused: { doc: string; issues: StudioIssue[] } | null,
): StudioCheckResult {
  if (!refused || refused.doc !== JSON.stringify(doc)) return shown;
  const failing = new Set(refused.issues.map((i) => i.rule));
  return {
    ...shown,
    issues: refused.issues,
    passing: shown.passing.filter((rule) => !failing.has(rule)),
  };
}

/** Why a publish didn't go through (the dialog says which). */
export type PublishFailure = 'network' | 'stale' | 'unavailable' | 'other';
export type PublishOutcome =
  'published' | { issues: StudioIssue[] } | { failed: PublishFailure };

/**
 * The answer to `POST /v1/me/studio/publish`, as the editor acts on it. A 422 lists issues only
 * when it has some; one without is a failure like any other.
 */
export function publishOutcome(
  result:
    | { ok: true }
    | { ok: false; status: number; code: string; issues?: StudioIssue[] },
): PublishOutcome {
  if (result.ok) return 'published';
  if (result.code === 'STUDIO_DESIGN_CHECK_FAILED' && result.issues?.length)
    return { issues: result.issues };
  if (result.status === 0 || result.code === 'NETWORK')
    return { failed: 'network' };
  if (result.code === 'STUDIO_DRAFT_STALE') return { failed: 'stale' };
  if (result.status === 404) return { failed: 'unavailable' };
  return { failed: 'other' };
}

/** Said before "Show the latest" drops edits this tab couldn't save (another tab saved first). */
const UNSAVED_HERE = 'Showing the latest drops your last changes here.';

/**
 * The dialog's words for a failed publish. A network failure may have published, so it never
 * says it didn't; "Try again" only while Publish can be pressed. `unsaved`: this tab has edits
 * the stale draft kept it from saving, which "Show the latest" will drop.
 */
export function publishFailureWords(
  reason: PublishFailure,
  canPublish: boolean,
  unsaved = false,
): string {
  switch (reason) {
    case 'network':
      return 'We couldn’t confirm it was published. Check your connection, then reload to see.';
    case 'stale':
      return unsaved
        ? `This draft changed in another tab. ${UNSAVED_HERE}`
        : 'This draft changed in another tab. Show the latest to keep editing.';
    case 'unavailable':
      return 'Page Studio isn’t available right now.';
    default:
      return canPublish
        ? 'Your page wasn’t published. Try again in a moment.'
        : 'Your page wasn’t published.';
  }
}

/**
 * Whether "Discard changes" has anything to throw away (§12.3): the draft differs from the
 * published page, or, before any publish, from Classic with no blocks (what a discard leaves).
 * `published` as `saveWords` takes it.
 */
export function hasChangesToDiscard(
  draft: StudioDocument,
  published: boolean | 'same',
): boolean {
  if (published === 'same') return false;
  if (published) return true;
  return JSON.stringify(draft) !== JSON.stringify(defaultStudioDocument());
}

/** The stale banner's words, saying so when this tab has edits "Show the latest" will drop. */
export function staleBannerWords(unsaved: boolean): string {
  const said =
    'Your design was saved somewhere else after this page opened, so we stopped saving here to keep that version.';
  return unsaved ? `${said} ${UNSAVED_HERE}` : said;
}

/** "Show the latest" couldn't read the latest draft; the banner stays. */
export const RELOAD_FAILED =
  'We couldn’t load the latest. Check your connection, then try again.';

/** The list's intro: "Your draft is saved." only when it is. */
export function blockedIntro(count: number, save: SaveState): string {
  const things = count === 1 ? '1 thing' : `${count} things`;
  return save === 'saved'
    ? `${things} to fix first. Your draft is saved.`
    : `${things} to fix first.`;
}

export type SaveState = 'saved' | 'pending' | 'saving' | 'failed';

/** The status line while a Free page previews a Pro style (§12.4): nothing is saved. */
export const PREVIEWING = 'Previewing a Pro style: not saved';

/**
 * The header's status line (§10: "Saved · not published"). `published`: false before the first
 * publish, true when the draft differs from the published page, 'same' when it doesn't.
 * `previewing` (§12.4) says so above anything else: no save is sent while it lasts.
 */
export function saveWords(
  state: SaveState,
  published: boolean | 'same',
  previewing = false,
) {
  if (previewing) return PREVIEWING;
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

/**
 * Whether this draft is a Free preview of a Pro style (§12.4): on Free, a Pro style that neither
 * the stored draft nor the published version holds. The server would refuse to save it (§11), so
 * the editor keeps it in memory and sends nothing. "Held" is the server's own definition
 * (contracts `studioKeepHeld`), so a lapsed draft that holds Stage saves its edits as usual.
 */
export function previewsPro(
  doc: StudioDocument,
  held: { draft: StudioDocument | null; published: StudioDocument | null },
  plan: 'free' | 'pro',
): boolean {
  return studioKeepHeld(doc, held, plan).style !== doc.style;
}

/**
 * The editor's banner when Pro has ended (§12.5), or null: on Free, when the published version uses
 * anything Pro. It names what visitors see (contracts `studioShown`): Classic in place of a Pro
 * style, or the free style without its Pro extras. Grace counts as Pro, so no banner then.
 */
export function lapseBanner(
  plan: 'free' | 'pro',
  published: StudioDocument | null,
): string | null {
  if (plan === 'pro' || !published) return null;
  if (
    studioKeepHeld(published, { draft: null, published: null }, 'free') ===
    published
  )
    return null;
  // A Pro style at every default shows the standard page, which is Classic.
  const shown = studioShown(published, 'free')?.style ?? 'classic';
  const what =
    shown === published.style
      ? `${STUDIO_STYLES[shown].name} without Pro extras`
      : STUDIO_STYLES[shown].name;
  return `Your Pro has ended. Your page shows ${what} until Pro is back. Your design is kept.`;
}
