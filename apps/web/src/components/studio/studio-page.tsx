import type { ReactNode } from 'react';
import { preload } from 'react-dom';
import {
  studioEagerImages,
  type PublicProfile,
  type PublicStudio,
} from '@tipme/contracts';
import { needsTextFont, type StudioRenderContext } from './studio-blocks';
import { StudioRowView } from './studio-row';
import { studioFont, studioFontFaces, studioStyle } from './studio-theme';
import './studio.css';

/**
 * A published Page Studio page (plan Task 5). The person's design styles the rows and the colours
 * around TipMe's parts; the cover, name, photo, handle and badge (identity), the tip block and the
 * footer are TipMe's own components, passed in unchanged. The tip block and footer sit inside
 * `.studio-fixed`, which resets every Studio token, so none of the person's colours or fonts reach
 * them. Server component; no client code but the video island.
 */
export function StudioPage({
  studio,
  profile,
  identity,
  cover,
  tipBlock,
  footer,
}: {
  studio: PublicStudio;
  profile: PublicProfile;
  identity: ReactNode;
  cover: ReactNode;
  tipBlock: ReactNode;
  footer: ReactNode;
}) {
  const { document: doc, palette, images } = studio;
  const firstName = profile.displayName.split(/\s+/)[0] ?? profile.displayName;
  const links = profile.links ?? [];
  const heading = studioFont(doc.fonts.heading);
  for (const file of heading.files)
    preload(file.path, {
      as: 'font',
      type: 'font/woff2',
      crossOrigin: 'anonymous',
    });
  const ctx: StudioRenderContext = {
    doc,
    images,
    profile: { ...(profile.bio ? { bio: profile.bio } : {}), links, firstName },
    eager: studioEagerImages(doc, {
      images: {},
      videos: {},
      profile: { bio: Boolean(profile.bio), links: links.length },
    }),
  };
  return (
    <div
      className="studio"
      data-mode={doc.mode}
      data-corners={doc.corners}
      style={studioStyle(doc, palette)}
    >
      <style>{studioFontFaces(doc.fonts)}</style>
      <div className="studio-frame">
        <div className="studio-cover">{cover}</div>
        <div
          className={`studio-identity${needsTextFont(doc.fonts.heading, profile.displayName) ? ' studio-identity--text-font' : ''}`}
        >
          {identity}
        </div>
        <aside
          className="studio-rail studio-fixed tip-instrument"
          aria-label={`Tip ${firstName}`}
          data-tip-panel
        >
          {tipBlock}
        </aside>
        <div className="studio-rows">
          {doc.rows.map((row) => (
            <StudioRowView key={row.id} row={row} ctx={ctx} />
          ))}
        </div>
        <div className="studio-foot studio-fixed">{footer}</div>
      </div>
    </div>
  );
}
