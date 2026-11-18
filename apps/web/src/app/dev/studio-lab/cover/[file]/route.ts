import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { notFound } from 'next/navigation';
import { studioLabOpen } from '../../lab-gate';

/**
 * The lab's "uploaded" cover photo (`?yours=upload`): one 2240 × 600 WebP, the size and shape of a
 * cover the API stores, so Stage and Horizon can be measured with a photo as their LCP (the
 * generated SVG covers are too flat to be a candidate). It is generated, not a photograph: soft
 * stage lights with grain, drawn from a seeded random source and encoded with sharp at quality 70
 * (132 KB). No person or third-party picture.
 */
export async function GET(
  _: Request,
  { params }: { params: Promise<{ file: string }> },
) {
  if (!studioLabOpen()) notFound();
  const { file } = await params;
  if (file !== '1.webp') notFound();
  const bytes = await readFile(
    join(process.cwd(), 'src/app/dev/studio-lab/cover/upload.webp'),
  );
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': 'image/webp',
      'cache-control': 'public, max-age=3600',
    },
  });
}
