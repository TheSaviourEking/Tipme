import type { WeeklyReportData } from '@tipme/contracts';

/**
 * What may appear on a shared "my week on TipMe" image: the recipient's own numbers and
 * milestones only. Built field by field, so a supporter's name can never slip in.
 */
export interface ShareableWeek {
  displayName: string;
  handle: string;
  week: string;
  total: string;
  tipCount: number;
  changeText: string | null;
  moments: string[];
}

// The web app targets ES2017 (no BigInt literals), hence BigInt(100).
const HUNDRED = BigInt(100);
const ngn = (minor: string) => {
  const value = BigInt(minor);
  return `NGN ${new Intl.NumberFormat('en').format(Number(value / HUNDRED))}.${String(value % HUNDRED).padStart(2, '0')}`;
};

export function shareableWeek(
  report: WeeklyReportData,
  owner: { displayName: string; handle: string },
): ShareableWeek {
  return {
    displayName: owner.displayName,
    handle: owner.handle,
    week: report.week,
    total: ngn(report.totalNetMinor),
    tipCount: report.tipCount,
    changeText:
      report.changePct === null
        ? null
        : `${report.changePct >= 0 ? '▲' : '▼'} ${Math.abs(report.changePct)}% on the week before`,
    moments: report.moments.map((moment) => moment.title).slice(0, 3),
  };
}
