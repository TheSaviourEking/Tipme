import { previewServerKey } from '@tipme/domain';

const API_ORIGIN =
  process.env.API_INTERNAL_ORIGIN ??
  process.env.NEXT_PUBLIC_API_ORIGIN ??
  'http://localhost:4000';

/**
 * Profile photos from TipMe's own address, so pages need no third-party image source. The API
 * stores only validated WebP; this passes the bytes through with long-lived caching.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ file: string }> },
): Promise<Response> {
  const { file } = await params;
  if (!/^[0-9a-f-]{36}\.webp$/.test(file))
    return new Response('Not found', { status: 404 });
  const password = process.env.PREVIEW_PASSWORD;
  const upstream = await fetch(`${API_ORIGIN}/v1/avatars/${file}`, {
    ...(password
      ? { headers: { 'x-tipme-preview-key': previewServerKey(password) } }
      : {}),
  }).catch(() => null);
  if (!upstream?.ok) return new Response('Not found', { status: 404 });
  return new Response(await upstream.arrayBuffer(), {
    headers: {
      'Content-Type': 'image/webp',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
