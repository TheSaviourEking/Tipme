import { parseVideoLink, type StudioVideoSite } from '@tipme/contracts';

// Page Studio's broken-video check (owner ruling 5, server-side only): asks the video site's
// public oEmbed endpoint whether a video still exists, at save and at publish. The visitor's
// browser never does. No cookie, no user data: only the video link the person pasted.

export type VideoStatus = 'ok' | 'gone' | 'unknown';

export const OEMBED_ENDPOINTS: Record<StudioVideoSite, string> = {
  youtube: 'https://www.youtube.com/oembed',
  tiktok: 'https://www.tiktok.com/oembed',
  audiomack: 'https://audiomack.com/oembed',
};

/** Statuses that mean the video is private, removed or never existed. */
const GONE = new Set([401, 403, 404, 410]);

/**
 * `gone` only on an answer that says so. A timeout (3 s), an error, a rate limit or a 5xx is
 * `unknown`, which never fails the design check: the check is best effort.
 */
export async function verifyVideo(
  url: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<VideoStatus> {
  const video = parseVideoLink(url);
  if (!video) return 'unknown';
  const endpoint = `${OEMBED_ENDPOINTS[video.site]}?format=json&url=${encodeURIComponent(url)}`;
  try {
    const response = await (options.fetch ?? fetch)(endpoint, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'omit',
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) return 'ok';
    return GONE.has(response.status) ? 'gone' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Outside production no request leaves the machine: a video id starting `gone` is gone, one
 * starting `slow` is unknown, any other is fine. Tests and local stacks use this.
 */
export async function pretendVerifyVideo(url: string): Promise<VideoStatus> {
  const id = parseVideoLink(url)?.id ?? '';
  if (/^gone/i.test(id)) return 'gone';
  if (/^slow/i.test(id)) return 'unknown';
  return parseVideoLink(url) ? 'ok' : 'unknown';
}
