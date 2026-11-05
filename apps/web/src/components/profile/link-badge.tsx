import { SOCIAL_PLATFORMS, type SocialPlatform } from '@tipme/contracts';

/**
 * A site's letters in a small dark key (SocialLinks board). Letters stand in for brand logos, which
 * need each brand's own rules. Decorative: the link or label beside it names the site.
 */
export function LinkBadge({
  platform,
  small = false,
}: {
  platform: SocialPlatform;
  small?: boolean;
}) {
  const site = SOCIAL_PLATFORMS[platform];
  return (
    <span
      className="link-badge"
      data-light={'light' in site || undefined}
      data-small={small || undefined}
      aria-hidden="true"
    >
      {site.badge}
    </span>
  );
}
