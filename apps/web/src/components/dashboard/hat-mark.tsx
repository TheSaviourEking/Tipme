'use client';
import { useState } from 'react';
import { AvatarImage } from '@/components/avatar';

const initial = (name: string) =>
  (Array.from(name.replace(/^@/, '').trim())[0] ?? '·').toUpperCase();

/**
 * The round mark beside a hat's name in the account button and menu: the person's photo for their
 * page, the business's logo for a business or a workplace (owner, 16 Nov 2026), and the initial
 * only when there is neither or the picture fails to load. The box is fixed and never shrinks, so
 * a picture loading or a long name moves nothing. Decorative: the name always sits next to it.
 */
export function HatMark({
  initialOf,
  photo = null,
  logo = null,
  name,
}: {
  initialOf: string;
  /** The person's photo path (the page card's source); only for the page hat. */
  photo?: string | null;
  /** A ready logo URL (the API's public address); only for a business hat. */
  logo?: string | null;
  name: string;
}) {
  // Remembering which logo failed resets the fallback when it changes, without an effect.
  const [failedLogo, setFailedLogo] = useState<string | null>(null);
  const showLogo = !photo && logo !== null && failedLogo !== logo;
  return (
    <span
      className="hat-menu__initial"
      aria-hidden="true"
      data-mark={photo ? 'photo' : showLogo ? 'logo' : 'initial'}
    >
      {photo ? (
        <AvatarImage
          className="hat-menu__photo"
          src={photo}
          name={name}
          width={32}
          height={32}
          sizes="32px"
        />
      ) : showLogo ? (
        // Served at its final size by the API, like the business header's tile: no optimiser.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="hat-menu__photo"
          src={logo}
          alt=""
          width={32}
          height={32}
          onError={() => setFailedLogo(logo)}
        />
      ) : (
        initial(initialOf)
      )}
    </span>
  );
}
