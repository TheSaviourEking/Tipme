import { normaliseHandle } from '@tipme/domain';

export type LaunchDecision = 'pass' | 'rewrite' | 'redirect-home' | 'exempt';

const explicitInstantPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

export function parseProductionLaunchAt(
  value: string | undefined,
): number | null {
  if (value === undefined) return null;

  const match = explicitInstantPattern.exec(value);
  if (!match) throw invalidLaunchAt();

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const milliseconds = Number((match[7] ?? '').padEnd(3, '0'));
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  )
    throw invalidLaunchAt();

  const wallTime = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    milliseconds,
  );
  const wallDate = new Date(wallTime);
  if (
    wallDate.getUTCFullYear() !== year ||
    wallDate.getUTCMonth() !== month - 1 ||
    wallDate.getUTCDate() !== day ||
    wallDate.getUTCHours() !== hour ||
    wallDate.getUTCMinutes() !== minute ||
    wallDate.getUTCSeconds() !== second
  )
    throw invalidLaunchAt();

  const offsetMinutes =
    match[8] === 'Z'
      ? 0
      : (match[9] === '+' ? 1 : -1) * (offsetHour * 60 + offsetMinute);
  return wallTime - offsetMinutes * 60_000;
}

export function launchDecision({
  path,
  target,
  now,
}: {
  path: string;
  target: number | null;
  now: number;
}): LaunchDecision {
  const isPlainPath = !/(?:\/\/|%|\.\.|\\)/.test(path);
  const isHoldingPage = isPlainPath && path === '/coming-soon';

  if (target === null || now >= target)
    return isHoldingPage ? 'redirect-home' : 'pass';

  if (!isPlainPath) return 'rewrite';
  if (
    isHoldingPage ||
    path === '/api/revalidate' ||
    path === '/robots.txt' ||
    path === '/sitemap.xml' ||
    path === '/favicon.ico' ||
    path === '/icon.svg' ||
    path.startsWith('/coming-soon/opengraph-image')
  )
    return 'exempt';

  return 'rewrite';
}

export function legacyProfileTarget(
  path: string,
  searchParams: URLSearchParams,
): string | null {
  const match = /^\/people\/([^/]+)$/.exec(path);
  if (!match?.[1]) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const handle = normaliseHandle(decoded);
  if (!handle) return null;
  const preserveQrSource =
    searchParams.getAll('src').length === 1 && searchParams.get('src') === 'qr';
  return `/@${handle}${preserveQrSource ? '?src=qr' : ''}`;
}

function invalidLaunchAt(): Error {
  return new Error(
    'PRODUCTION_LAUNCH_AT must be a valid ISO 8601 instant with Z or an explicit numeric offset.',
  );
}
