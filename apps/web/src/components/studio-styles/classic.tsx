import type { ReactNode } from 'react';
import type { PublicProfile, PublicStudio } from '@tipme/contracts';
import { StandardProfile } from '@/components/profile/standard-profile';
import { classicCss } from './classic-tokens';
import { StyleBlocks } from './parts';
import { StyleSheet } from './style-sheets';

/**
 * A Classic page with a choice (spec 2026-11-17-page-studio-styles §9.1, §13): today's standard
 * markup (StandardProfile) with Classic's root attributes, its tokens and its blocks after the tip
 * panel; never the new styles' frame. A Classic page with every default never gets here (studioFor
 * returns null, and page.tsx renders today's page). Its stylesheet (classic.css) loads through the
 * dynamic sheet, so a standard page links none of it. No new font: today's Manrope and DM Serif,
 * money in Inter. Server component.
 */
export function ClassicStudio({
  studio,
  profile,
  coverArt,
  identity,
  tipBlock,
  footer,
  lead,
}: {
  studio: PublicStudio;
  profile: PublicProfile;
  coverArt: ReactNode;
  identity: ReactNode;
  tipBlock: ReactNode;
  footer: ReactNode;
  /** Before the sheet: the public page's view tracker. */
  lead?: ReactNode;
}) {
  const { document: doc, images, palette } = studio;
  const firstName = profile.displayName.split(/\s+/)[0] ?? profile.displayName;
  // A plain function (no hooks): null when no block has anything to show.
  const blocks = StyleBlocks({ doc, images });
  return (
    <StandardProfile
      root={{
        className: 'profile-page profile-page--studio',
        'data-style': 'classic',
        'data-mode': doc.mode,
        'data-cover': doc.cover,
      }}
      firstName={firstName}
      lead={
        <>
          {lead}
          <style>{classicCss(palette, doc.mode, doc.accent === null)}</style>
          <StyleSheet styleId="classic" />
        </>
      }
      cover={
        doc.cover === 'yours' ? (
          coverArt
        ) : doc.cover === 'gradient' ? (
          <div className="profile-cover classic-cover" aria-hidden="true" />
        ) : null
      }
      identity={identity}
      tipBlock={tipBlock}
      after={blocks && <div className="classic-blocks">{blocks}</div>}
      footer={footer}
    />
  );
}
