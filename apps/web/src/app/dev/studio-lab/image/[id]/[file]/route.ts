import { notFound } from 'next/navigation';
import { STUDIO_IMAGE_ASPECT } from '@tipme/contracts';
import { studioLabOpen } from '../../../lab-gate';

/**
 * Generated test images for the Studio lab: an SVG of the rendition's exact size, coloured from
 * the image id. No photo, person or third-party picture is ever used in the lab.
 */
export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string; file: string }> },
) {
  if (!studioLabOpen()) notFound();
  const { id, file } = await params;
  const m = /^(square|wide|tall|strip)-(480|960|1440)$/.exec(file);
  if (!m || !/^[0-9a-f-]{36}$/.test(id)) notFound();
  const shape = m[1] as keyof typeof STUDIO_IMAGE_ASPECT;
  const width = Number(m[2]);
  const height = Math.round(width / STUDIO_IMAGE_ASPECT[shape]);
  const hue = (parseInt(id.slice(4, 8), 16) * 47) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 70%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 45% 35%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${width * 0.7}" cy="${height * 0.35}" r="${Math.min(width, height) * 0.18}" fill="hsl(${hue} 80% 92%)" opacity="0.7"/></svg>`;
  return new Response(svg, {
    headers: {
      'content-type': 'image/svg+xml',
      'cache-control': 'public, max-age=3600',
    },
  });
}
