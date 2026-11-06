import { ImageResponse } from 'next/og';
import { shareCard, siteOrigin } from '@/lib/metadata';
import { getPublicProfile } from '@/lib/profiles-api';
import {
  GeneralCard,
  ogFonts,
  PersonCard,
  personCardInput,
  serifCharacters,
  type PersonCardInput,
} from '@/lib/share-card';

// A person's link preview, at a fixed URL that only their live page's metadata names. It draws
// `personCardInput` and nothing else. Anything that is not a live, unmoved page (unknown, not live
// yet, offline, paused, moved, an invalid handle, or a failed lookup) answers the general card
// with 200, so this route says nothing the page itself does not.

const size = { width: shareCard.width, height: shareCard.height };
// Never the image default (a year, immutable): a changed name or role shows on the next fetch.
const headers = {
  'cache-control': 'public, max-age=0, must-revalidate',
};

let general: Promise<ArrayBuffer> | undefined;
/** The general card's bytes, drawn once per process. */
function generalCard(): Promise<ArrayBuffer> {
  general ??= ogFonts().then((fonts) =>
    new ImageResponse(<GeneralCard />, { ...size, fonts }).arrayBuffer(),
  );
  general.catch(() => {
    general = undefined;
  });
  return general;
}

async function lookup(handle: string): Promise<PersonCardInput | null> {
  try {
    const profile = await getPublicProfile(handle);
    return profile && !('movedTo' in profile) ? personCardInput(profile) : null;
  } catch {
    // Nothing personal is logged: the page itself reports a failed lookup.
    return null;
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  const person = await lookup((await params).handle);
  if (!person)
    return new Response(await generalCard(), {
      headers: { ...headers, 'content-type': 'image/png' },
    });
  return new ImageResponse(
    <PersonCard
      {...person}
      host={siteOrigin.host}
      serif={await serifCharacters()}
    />,
    {
      ...size,
      fonts: await ogFonts(),
      headers,
    },
  );
}
