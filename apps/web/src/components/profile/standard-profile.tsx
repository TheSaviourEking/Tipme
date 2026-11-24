import type { ReactNode } from 'react';

/**
 * The standard /@username page (spec 2026-11-17-page-studio-styles §9.1, §13): the cover, the
 * person beside the tip panel (the right rail on desktop, after the person on a phone), then the
 * footer. page.tsx renders it for every page without a style, and Classic's choices render it with
 * `root` (its data attributes) and `after` (its blocks). Without those two the markup is today's,
 * byte for byte (test/standard-profile.test.mjs). Server component; every part is passed in.
 */
export function StandardProfile({
  firstName,
  lead,
  cover,
  identity,
  tipBlock,
  after,
  footer,
  root,
}: {
  firstName: string;
  /** Before the sheet: the view tracker, and on a Classic page its tokens and stylesheet. */
  lead?: ReactNode;
  cover: ReactNode;
  identity: ReactNode;
  tipBlock: ReactNode;
  /** After the tip panel, in the columns: Classic's blocks. */
  after?: ReactNode;
  footer: ReactNode;
  /** A Classic page's root class and data attributes; today's root without. */
  root?: {
    className: string;
    'data-style': string;
    'data-mode': string;
    'data-cover': string;
  };
}) {
  return (
    <main id="main" tabIndex={-1} className="profile-page" {...root}>
      {lead}
      <div className="profile-sheet">
        {cover}
        <div className="profile-columns">
          {identity}
          <aside
            className="profile-composer tip-instrument"
            aria-label={`Tip ${firstName}`}
            data-tip-panel
          >
            {tipBlock}
          </aside>
          {after}
        </div>
        {footer}
      </div>
    </main>
  );
}
