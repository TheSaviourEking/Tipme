/*
 * The audit log's reasons in plain words. The server appends what changed to the person's reason as
 * ` [change: {…}]` (withAuditChange in packages/database); this reads that record back and writes it
 * as a sentence per action, with a "name: value" list for any shape it doesn't know. Raw JSON never
 * reaches the screen. No React, so the rules can be tested alone.
 */
import { formatNaira } from './demo-amount.ts';
import { STALE_WORDS } from './ops-answers.ts';

export interface AuditWords {
  /** The reason the person (or the system) wrote, or null when there is none. */
  reason: string | null;
  /** What changed, in words; null when the entry carries no change record. */
  detail: string | null;
}

type Change = Record<string, unknown>;

// The person's reason can never hold this (checkedReason refuses it), so the first one starts the record.
const MARKER = /\s*\[change:\s*/i;

// Never shown, whatever an entry holds: a record should carry none of these, but if one ever did,
// the screen still would not.
const SECRET_KEY =
  /secret|token|password|passcode|otp|code|key|hash|cookie|session/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids end as "…a1b2c3", the same as the Who and Subject columns. */
const short = (id: unknown): string =>
  typeof id === 'string' && id.length > 6 ? `…${id.slice(-6)}` : String(id);
const staff = (id: unknown): string =>
  typeof id === 'string' && id ? `staff ${short(id)}` : 'the system';

/** "page_studio" → "page studio", "clearedAdditions" → "cleared additions". */
export const words = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.]+/g, ' ')
    .toLowerCase()
    .trim();

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => text(item)) : [];
const listOr = (value: unknown, none = 'none'): string =>
  list(value).join(', ') || none;
const onOff = (value: unknown): string =>
  value === true ? 'on' : value === false ? 'off' : 'not set';
const yesNo = (value: unknown): string => (value ? 'yes' : 'no');
const naira = (minor: unknown): string => {
  if (typeof minor !== 'string' && typeof minor !== 'number') return 'not set';
  try {
    return formatNaira(minor);
  } catch {
    return String(minor);
  }
};

/** One value, readable, for the fallback and the parts of each sentence. */
function text(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'boolean') return yesNo(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return UUID.test(value) ? short(value) : value;
  if (Array.isArray(value)) return listOr(value);
  if (typeof value === 'object') {
    const record = value as Change;
    if ('from' in record && 'to' in record && Object.keys(record).length === 2)
      return `${text(record.from)} → ${text(record.to)}`;
    if (typeof record.name === 'string') return record.name;
    return fallback(record) || 'none';
  }
  return String(value);
}

/** "name: value; name: value" for a shape with no sentence of its own. */
export function fallback(change: Change): string {
  return Object.entries(change)
    .filter(([key]) => !SECRET_KEY.test(key))
    .map(([key, value]) => `${words(key)}: ${text(value)}`)
    .join('; ');
}

/** Joins the parts that apply, skipping empty ones. */
const parts = (...items: (string | false | null | undefined)[]): string =>
  items.filter(Boolean).join('; ');

const cleared = (c: Change) =>
  parts(
    list(c.clearedAdditions).length > 0 &&
      `cleared additions: ${listOr(c.clearedAdditions)}`,
    list(c.clearedRemovals).length > 0 &&
      `cleared removals: ${listOr(c.clearedRemovals)}`,
  );

const approved = (c: Change) =>
  typeof c.approvedBy === 'string' && c.approvedBy
    ? `approved by ${staff(c.approvedBy)}`
    : null;

/** A plan fee pair as staff read it: "Free 5%, Pro 3%". */
const planFees = (value: unknown): string => {
  if (typeof value !== 'object' || value === null) return '—';
  const { freeBps, proBps } = value as Record<string, unknown>;
  const pct = (bps: unknown) => {
    const n = Number(bps);
    if (!Number.isInteger(n) || n < 0) return '?';
    const frac = String(n % 100)
      .padStart(2, '0')
      .replace(/0+$/, '');
    return `${Math.floor(n / 100)}${frac ? `.${frac}` : ''}%`;
  };
  return `Free ${pct(freeBps)}, Pro ${pct(proBps)}`;
};

/** Each known action's record, as a sentence. */
const SENTENCES: Record<string, (c: Change, subject: string) => string> = {
  'feature_switch.set': (c, s) =>
    parts(`Switch ${s}: ${onOff(c.from)} → ${onOff(c.to)}`, approved(c)),
  'display_setting.set': (c, s) =>
    `Setting ${s}: ${text(c.from)} → ${text(c.to)}`,
  'pro.price_changed': (c) =>
    parts(`Pro price: ${naira(c.from)} → ${naira(c.to)} a month`, approved(c)),
  'plan_fees.changed': (c) =>
    parts(
      `TipMe’s fee per plan: ${planFees(c.from)} → ${planFees(c.to)}`,
      approved(c),
    ),
  'business_pro.price_changed': (c) =>
    parts(
      `Business Pro price: ${naira(c.from)} → ${naira(c.to)} a month`,
      approved(c),
    ),

  'username.released': (c) => `Was held for take-back ${short(c.takeBackId)}`,
  'username.free_change_used': (c) =>
    `Free change @${text(c.from)} → @${text(c.to)} (take-back ${short(c.takeBackId)})`,
  'username.take_back_started': (c) =>
    parts(
      `Take-back ${short(c.takeBackId)} of a ${words(text(c.kind))} name`,
      `category: ${words(text(c.category))}`,
      `${text(c.noticeDays)} days’ notice`,
      c.profileId ? `page ${short(c.profileId)}` : null,
      `asked by ${staff(c.requestedBy)}`,
      approved(c),
    ),
  'username.take_back_cancelled': (c) =>
    `Take-back ${short(c.takeBackId)}, which was ${words(text(c.stateBefore))}`,
  'username.take_back_done': (c) =>
    parts(
      `Take-back ${short(c.takeBackId)}: ${words(text(c.outcome))}`,
      c.newHandle ? `new name @${text(c.newHandle)}` : null,
      c.noticedVia ? `notice seen by ${words(text(c.noticedVia))}` : null,
    ),
  'username.take_back_noticed': (c) =>
    `Take-back ${short(c.takeBackId)}: notice seen by ${words(text(c.via))}`,

  'announcement.created': (c) =>
    `Revision ${text(c.revision)}, for ${words(text(c.audience))}`,
  'announcement.edited': (c) =>
    `Revision ${text(c.revision)}; changed ${list(c.fields).map(words).join(', ') || 'nothing'}`,
  'announcement.test_sent': (c) => `Test of revision ${text(c.revision)}`,
  'announcement.cancelled': (c) =>
    `Was ${words(text(c.was))}; ${text(c.queued)} of ${text(c.recipients)} emails queued`,
  'announcement.send_started': (c) =>
    parts(
      `Revision ${text(c.revision)} to ${words(text(c.audience))}, ${text(c.recipients)} people`,
      `asked by ${staff(c.askedBy)}`,
      approved(c),
    ),
  'announcement.sent': (c) =>
    `${text(c.queued)} of ${text(c.recipients)} emails queued`,

  'role.created': (c) =>
    `Role “${text(c.name)}” with ${listOr(c.permissions, 'no permissions')}`,
  'role.updated': (c) => {
    const name = c.name as Change | undefined;
    return (
      parts(
        list(c.added).length > 0 && `added: ${listOr(c.added)}`,
        list(c.removed).length > 0 && `removed: ${listOr(c.removed)}`,
        name && `name: “${text(name.from)}” → “${text(name.to)}”`,
        c.description !== undefined && 'description changed',
      ) || 'No change to permissions'
    );
  },
  'role.deleted': (c) =>
    `Role “${text(c.name)}”, which had ${listOr(c.permissions, 'no permissions')}`,

  'staff.access_changed': (c) =>
    parts(
      list(c.added).length > 0 && `added: ${listOr(c.added)}`,
      list(c.removed).length > 0 && `removed: ${listOr(c.removed)}`,
      cleared(c),
    ) || 'No change',
  'staff.role_changed': (c) =>
    parts(
      `Role: ${text(c.from)} → ${text(c.to)}`,
      list(c.gains).length > 0 && `gains: ${listOr(c.gains)}`,
      list(c.losses).length > 0 && `loses: ${listOr(c.losses)}`,
      cleared(c),
    ),
  'staff.added': (c) =>
    parts(
      `Role ${text(c.role)}`,
      `${c.account === 'existing' ? 'existing' : 'new'} account ${text(c.email)}`,
      c.restored ? 'restored after removal' : null,
      Number(c.recoveriesCancelled) > 0 &&
        `${text(c.recoveriesCancelled)} account recoveries cancelled`,
      `invitation ${words(text(c.delivery))}`,
      cleared(c),
    ),
  'staff.invitation_resent': (c) =>
    `Link sent to ${text(c.linkSentTo)} (${words(text(c.delivery))})`,
  'staff.removed': (c) =>
    parts(`Role ${text(c.role)}`, `loses: ${listOr(c.losses)}`, cleared(c)),
  'staff.authenticator_reset': (c) =>
    parts(
      c.authenticatorRemoved
        ? 'Authenticator removed'
        : 'No authenticator was set',
      `link sent to ${text(c.linkSentTo)} (${words(text(c.delivery))})`,
    ),
  'staff.invitation_declined': (c) =>
    parts(
      c.via === 'account_deleted'
        ? 'Their account was deleted'
        : 'They declined',
      c.role ? `role ${text(c.role)}` : null,
      cleared(c),
    ),
  'staff.owner_granted': (c) => granted(c),
  'staff.release_check_granted': (c) => granted(c),

  'account.recovery_refused_staff': (c) =>
    `Recovery to ${text(c.newEmail)} refused`,
  'account.email_set_by_script': (c) =>
    parts(
      `Email ${text(c.from)} → ${text(c.to)}`,
      `staff account: ${yesNo(c.staff)}`,
      `old address told: ${yesNo(c.oldAddressNotified)}`,
    ),

  'changelog.edited': (c) =>
    `#${text(c.number)} revision ${text(c.revision)}; changed ${list(c.fields).map(words).join(', ') || 'nothing'}`,
  'changelog.approved': (c) =>
    parts(
      `#${text(c.number)} revision ${text(c.revision)} for ${words(text(c.audience))}`,
      c.restored ? 'shown again' : null,
      c.askedBy ? `asked by ${staff(c.askedBy)}` : null,
    ),
  'changelog.withdrawn': (c) =>
    `#${text(c.number)} revision ${text(c.revision)}`,

  'serious_action.requested': (c) => `Asked for approval: ${summary(c)}`,
  'serious_action.repeated': (c) =>
    parts(
      `Asked again: ${summary(c)}`,
      `first asked by ${staff(c.requestedBy)}`,
    ),
  'serious_action.ran_alone': (c) =>
    `Ran without a second person (none was available): ${summary(c)}`,
  'serious_action.approved': (c) =>
    parts(
      `Approved: ${summary(c)}`,
      `asked by ${staff(c.requestedBy)}`,
      approved(c),
    ),
  'serious_action.ran': (c) =>
    parts(
      `Ran: ${summary(c)}`,
      `asked by ${staff(c.requestedBy)}`,
      approved(c),
    ),
  'serious_action.rejected': (c) =>
    parts(
      `Rejected: ${summary(c)}`,
      `asked by ${staff(c.requestedBy)}`,
      `rejected by ${staff(c.rejectedBy)}`,
    ),
  'serious_action.cancelled': (c) =>
    parts(`Cancelled: ${summary(c)}`, `asked by ${staff(c.requestedBy)}`),
  'serious_action.expired': (c) =>
    parts(`Expired: ${summary(c)}`, `asked by ${staff(c.requestedBy)}`),
  'serious_action.stale': (c) =>
    parts(
      `${(typeof c.why === 'string' && STALE_WORDS[c.why]) || 'It did not run.'} ${summary(c)}`,
      typeof c.detail === 'string' ? c.detail : null,
      `asked by ${staff(c.requestedBy)}`,
    ),
};

/** The server-written description of a serious action ("Refund ₦5,000 on Pro payment …"). */
function summary(c: Change): string {
  if (typeof c.summary === 'string' && c.summary) return c.summary;
  return typeof c.action === 'string' ? words(c.action) : 'an action';
}

function granted(c: Change): string {
  return parts(
    `Role: ${c.from ? words(text(c.from)) : 'none'} → ${words(text(c.to))}`,
    c.restored ? 'restored after removal' : null,
    cleared(c),
  );
}

/** Splits a stored reason into the written reason and the change record, if it holds one. */
function split(reason: string): {
  reason: string | null;
  change: string | null;
} {
  const found = MARKER.exec(reason);
  if (!found) return { reason, change: null };
  const rest = reason.slice(found.index + found[0].length);
  return {
    reason: reason.slice(0, found.index).trim() || null,
    // A record cut short has no closing bracket: JSON.parse refuses it, and it reads as unreadable.
    change: rest.endsWith(']') ? rest.slice(0, -1) : rest,
  };
}

/** An audit entry's reason and its change record, both in words for staff. */
export function auditWords(entry: {
  action: string;
  subjectId: string | null;
  reason: string | null;
}): AuditWords {
  if (!entry.reason) return { reason: null, detail: null };
  const { reason, change } = split(entry.reason);
  if (change === null) return { reason, detail: null };
  let record: unknown;
  try {
    record = JSON.parse(change);
  } catch {
    return { reason, detail: 'Details could not be read' };
  }
  if (!record || typeof record !== 'object' || Array.isArray(record))
    return { reason, detail: null };
  const sentence = SENTENCES[entry.action];
  const subject = entry.subjectId ?? 'unknown';
  let detail: string;
  try {
    detail = sentence
      ? sentence(record as Change, subject)
      : fallback(record as Change);
  } catch {
    detail = fallback(record as Change);
  }
  return { reason, detail: detail || null };
}
