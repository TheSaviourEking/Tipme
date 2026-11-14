import { ImageResponse } from 'next/og';
import { shareCard, siteOrigin } from '@/lib/metadata';
import { previewServerKey } from '@tipme/domain';
import { API_ORIGIN, getPublicProfile } from '@/lib/profiles-api';
import { shareCardPhoto } from '@/lib/share-card-photo';
import {
  GeneralCard,
  ogFonts,
  PersonCard,
  personCardInput,
  serifCharacters,
  type PersonCardInput,
} from '@/lib/share-card';

// A person's link preview, at a fixed URL that only their live page's metadata names. It draws
// `personCardInput` and nothing else, with the photo that names fetched here (initials when there
// is none or it does not arrive in time). Anything that is not a live, unmoved page (unknown, not live
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

/** The page's photo as data for next/og, or null (the card then shows the initials). */
function photoOf(person: PersonCardInput, request: Request) {
  const password = process.env.PREVIEW_PASSWORD;
  return shareCardPhoto(person.avatarPath, {
    apiOrigin: API_ORIGIN,
    siteOrigin: new URL(request.url).origin,
    // Staging/preview: the web server proves itself to the API's gate, as the profile lookup does.
    ...(password
      ? { headers: { 'x-tipme-preview-key': previewServerKey(password) } }
      : {}),
  });
}

export async function GET(
  request: Request,
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
      photo={await photoOf(person, request)}
    />,
    {
      ...size,
      fonts: await ogFonts(),
      headers,
    },
  );
}
