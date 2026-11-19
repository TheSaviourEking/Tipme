'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  DESIGN_CHECK_VERSION,
  resolveCover,
  resolveStudio,
  studioTokens,
} from '@tipme/contracts';
import { AppreciationForm } from '@/components/appreciation-form';
import { ProfileCover } from '@/components/profile/cover';
import { RecipientIdentity } from '@/components/profile/recipient-card';
import { ReportPage } from '@/components/report-page';
import { renderStyled } from '@/components/studio-styles/style-page';
import {
  PREVIEW_READY,
  PREVIEW_SHOW,
  isPreviewMessage,
  type PreviewPayload,
} from './preview-message';

/** The Lagos date, as the server reads a draft's events. */
const lagosToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(
    new Date(),
  );

/**
 * The editor's live preview (styles spec §10.1): the person's page drawn by the real renderer
 * (`renderStyled`, the dispatcher the public page uses) from the draft the editor posts here. It
 * is its own document in a frame, so each style's layout follows the preview's width (phone or
 * desktop), not the editor's, and only the chosen style's sheet and fonts load in it. It is a
 * picture: inert, with nothing to focus or press, and it takes messages only from its own
 * origin's parent window.
 */
export function PreviewFrame() {
  const [payload, setPayload] = useState<PreviewPayload | null>(null);
  useEffect(() => {
    const origin = window.location.origin;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== window.parent) return;
      if (!isPreviewMessage(event.data) || event.data.type !== PREVIEW_SHOW)
        return;
      setPayload(event.data.payload);
    };
    window.addEventListener('message', onMessage);
    // Opened on its own (no editor around it), it posts to itself and shows nothing.
    window.parent.postMessage({ type: PREVIEW_READY }, origin);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  if (!payload) return null;

  const { profile, images, photoAccent, paymentMode } = payload;
  const document = resolveStudio(payload.document, lagosToday());
  const style = document.style;
  const firstName = profile.displayName.split(/\s+/)[0] ?? profile.displayName;
  const cover =
    profile.cover ??
    resolveCover({
      handle: profile.handle,
      coverPath: null,
      coverDesign: null,
      coverColour: null,
    });
  const styled = renderStyled({
    studio: {
      document,
      images,
      palette: studioTokens(style, document.accent, photoAccent),
      checkVersion: DESIGN_CHECK_VERSION,
    },
    profile,
    coverArt: <ProfileCover cover={cover} priority />,
    // Classic keeps TipMe's identity block (the new styles draw their own).
    identity: <RecipientIdentity profile={profile} firstName={firstName} />,
    tipBlock: (
      <AppreciationForm
        surface="profile"
        paymentMode={paymentMode}
        recipient={firstName}
        handle={profile.handle}
        {...(profile.tipAmounts ? { tipAmounts: profile.tipAmounts } : {})}
        // Classic's tip form is today's: no skin.
        {...(style === 'classic' ? {} : { skin: style })}
      />
    ),
    footer: (
      <footer className="profile-foot">
        <div className="profile-foot__quiet">
          <ReportPage handle={profile.handle} />
          <Link href="/legal/privacy">Privacy</Link>
          <Link href="/legal/terms">Terms</Link>
        </div>
      </footer>
    ),
  });
  return (
    <div className="studio-preview-doc" inert data-style={style}>
      {style === 'classic' ? (
        styled
      ) : (
        <main id="main" tabIndex={-1} className="studio-main">
          {styled}
        </main>
      )}
    </div>
  );
}
