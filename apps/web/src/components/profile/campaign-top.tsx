import type { ReactNode } from 'react';
import type { PublicCampaignPage } from '@tipme/contracts';

/**
 * The top of a campaign's own page (ProCampaignPages board, section 3): its headline and short
 * description under the person's name, in the identity column. Plain text only; the tip area
 * beside it is the main page's, unchanged. Tip goals (Phase B) go in `children`.
 */
export function CampaignTop({
  page,
  children,
}: {
  page: Pick<PublicCampaignPage, 'headline' | 'description'>;
  children?: ReactNode;
}) {
  return (
    <section className="campaign-top" aria-labelledby="campaign-headline">
      <h2 id="campaign-headline" className="campaign-top__headline">
        {page.headline}
      </h2>
      {page.description ? (
        <p className="campaign-top__description">{page.description}</p>
      ) : null}
      {children}
    </section>
  );
}
