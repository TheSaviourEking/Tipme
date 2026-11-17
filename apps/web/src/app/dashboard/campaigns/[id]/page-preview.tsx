'use client';
import type { ResolvedCover } from '@tipme/contracts';
import { AvatarImage } from '@/components/avatar';
import { CampaignTop } from '@/components/profile/campaign-top';
import { ProfileCover } from '@/components/profile/cover';
import { Money } from '@/components/money';

// The standard amounts, for a page whose answer predates `tipAmounts`.
const STANDARD = ['50000', '100000', '200000', '500000'];

/**
 * The live preview beside the Page tab (ProCampaignPages board, section 2): the campaign's top over
 * the person's own name, photo and amounts. A picture of the page, not the page: nothing in it can
 * be pressed, and no form is inside it.
 */
export function CampaignPagePreview({
  displayName,
  handle,
  avatarPath,
  cover,
  headline,
  description,
  amountsMinor,
}: {
  displayName: string;
  handle: string;
  avatarPath: string | null;
  cover: ResolvedCover | null;
  headline: string;
  description: string;
  amountsMinor: string[] | undefined;
}) {
  const firstName = displayName.split(/\s+/)[0] ?? displayName;
  const amounts = amountsMinor?.length ? amountsMinor : STANDARD;
  return (
    <div className="campaign-preview" aria-hidden="true" inert>
      {cover && (
        <div className="campaign-preview__cover">
          <ProfileCover cover={cover} sizes="360px" />
        </div>
      )}
      <div className="campaign-preview__body">
        <div className="campaign-preview__who">
          <AvatarImage
            className="campaign-preview__photo"
            src={avatarPath ?? ''}
            name={displayName}
            width={96}
            height={96}
            sizes="48px"
          />
          <div>
            <p className="campaign-preview__name">{displayName}</p>
            <p className="campaign-preview__handle">@{handle}</p>
          </div>
        </div>
        {headline ? (
          <CampaignTop
            page={{
              headline,
              ...(description ? { description } : {}),
            }}
          />
        ) : (
          <p className="tm-hint">
            Without a headline, the link opens your normal page.
          </p>
        )}
        <div className="campaign-preview__amounts">
          {amounts.map((minor) => (
            <span key={minor}>
              <Money minor={minor} />
            </span>
          ))}
        </div>
        <p className="campaign-preview__pay">Tip {firstName}</p>
      </div>
    </div>
  );
}
