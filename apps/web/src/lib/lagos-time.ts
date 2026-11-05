/** Dates and times as Lagos shows them: the one place the zone is named. */
const ZONE = 'Africa/Lagos';

/** 2026-11-05, the Lagos calendar day of an instant. */
export const dayKey = (iso: string) =>
  new Date(iso).toLocaleDateString('en-CA', { timeZone: ZONE });

/** 14:05, the Lagos time of an instant. */
export const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: ZONE,
  });

/** 5 Nov, the Lagos date of an instant. */
export const dateOf = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: ZONE,
  });
