import { API_ORIGIN, businessLogoSource } from '@/lib/avatar-source';
import { BusinessLogoTile } from './business-logo-tile';

/**
 * The top of every business page a code opens (PR B4, board section 2): who this is, where, and
 * that TipMe checked them, always before any person (QR-sticker fraud: the badge, the business
 * name and the location are never scrolled away on the list). The wording never says approved,
 * licensed or regulated (M10).
 */
export function BusinessHeader({
  name,
  location,
  where,
  titleLevel,
  onToday = false,
  logoPath,
}: {
  name: string;
  location?: string;
  /** The business page's own line ("3 places"), in place of "{location} · on today". */
  where?: string;
  /** The location page's title is the business; the staff page's is the person. */
  titleLevel: 'h1' | 'p';
  /**
   * Whether someone is on shift here now (the staff page: whether that person is). Only then does
   * the location line say "on today"; it never gives a number of people (owner's design note).
   */
  onToday?: boolean;
  /** The owner's uploaded logo; without one the tile shows the initial. */
  logoPath?: string;
}) {
  const Title = titleLevel;
  return (
    <header className="business-header" data-testid="business-header">
      <div className="business-header__who">
        <BusinessLogoTile
          name={name}
          src={businessLogoSource(logoPath, API_ORIGIN)}
        />
        <div className="business-header__names">
          <Title className="business-header__name">{name}</Title>
          <p className="business-header__where">
            {where ?? (onToday ? `${location} · on today` : location)}
          </p>
        </div>
      </div>
      <p className="business-header__verified">
        <span className="business-header__badge">
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d="M3.5 8.5l3 3 6-7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Verified business
        </span>
        <span className="business-header__checked">
          TipMe checked this business’s name, address and contact.
        </span>
      </p>
    </header>
  );
}
