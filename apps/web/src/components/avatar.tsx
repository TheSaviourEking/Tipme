import Image from 'next/image';
import { avatarSource } from '@/lib/avatar-source';

const API_ORIGIN =
  process.env.NEXT_PUBLIC_API_ORIGIN ?? 'http://localhost:4000';

/** A page's picture: an uploaded photo (served by the API) or a demo illustration. */
export function Avatar({
  src,
  name,
  size = 64,
}: {
  src: string;
  name: string;
  size?: number;
}) {
  const picture = avatarSource(src, name, API_ORIGIN);
  if (!picture) return null;
  return (
    <Image
      className="avatar"
      src={picture.src}
      alt={picture.alt}
      width={size}
      height={size}
      unoptimized
    />
  );
}

/** Whether `Avatar` can show this path (otherwise show initials instead). */
export const hasAvatar = (path: string | null | undefined): path is string =>
  Boolean(path && avatarSource(path, '', API_ORIGIN));
