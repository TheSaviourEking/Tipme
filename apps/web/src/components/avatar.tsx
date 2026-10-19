import Image from 'next/image';
export function Avatar({
  src,
  name,
  size = 64,
}: {
  src: string;
  name: string;
  size?: number;
}) {
  return (
    <Image
      className="avatar"
      src={src}
      alt={`Illustrated avatar of ${name}, a fictional demo recipient`}
      width={size}
      height={size}
      unoptimized
    />
  );
}
