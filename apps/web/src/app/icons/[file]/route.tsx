import { ImageResponse } from 'next/og';
import { APP_ICON_FILES, IconTile, isAppIconFile } from '@/lib/app-icons';

// The manifest's two icons, prerendered at build. `dynamicParams` is not allowed with
// cacheComponents, so any other name answers 404 here.
export function generateStaticParams() {
  return Object.keys(APP_ICON_FILES).map((file) => ({ file }));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ file: string }> },
) {
  const { file } = await params;
  if (!isAppIconFile(file)) return new Response('Not found', { status: 404 });
  const { size, maskable, rounded } = APP_ICON_FILES[file];
  return new ImageResponse(
    <IconTile size={size} maskable={maskable} rounded={rounded} />,
    { width: size, height: size },
  );
}
