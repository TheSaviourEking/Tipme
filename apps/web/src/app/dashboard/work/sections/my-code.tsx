'use client';
import { useEffect, useRef } from 'react';
import type { MyMembership } from '@tipme/contracts';
import { Button } from '@tipme/ui';
import { downloadCanvas, useWebOrigin } from '@/lib/business/codes-api';
import {
  SIGN_STYLES,
  codeUrl,
  drawStaffBadge,
  printedLink,
} from '@/lib/business-sign';

const NIGHT = SIGN_STYLES[0]!;
const drawBadge = (
  target: HTMLCanvasElement,
  input: { url: string; name: string; business: string; width: number },
) => drawStaffBadge(target, { ...input, style: NIGHT });

/** The badge's address: the membership's staff path (M2), tagged as a scan like every QR. */
const badgePath = ({ staffCodePath: path }: MyMembership): string =>
  path.includes('?') ? path : `${path}?src=qr`;

/**
 * Work → My code (PR B8): this person's badge at this business, opening their tip page there.
 * Only once the business is verified (M12); before that nothing is drawn.
 */
export function MyCodeSection({ membership }: { membership: MyMembership }) {
  const origin = useWebOrigin();
  const canvas = useRef<HTMLCanvasElement>(null);
  const verified = membership.business.status === 'verified';
  const url = origin ? codeUrl(origin, badgePath(membership)) : '';
  const name = membership.shownName;
  const business = membership.business.name;
  useEffect(() => {
    if (verified && url && canvas.current)
      drawBadge(canvas.current, { url, name, business, width: 680 });
  }, [verified, url, name, business]);

  if (!verified)
    return (
      <p className="tm-hint">
        Your badge can be downloaded once TipMe verifies{' '}
        {membership.business.name}.
      </p>
    );
  if (!url) return <></>;
  const download = () => {
    const big = document.createElement('canvas');
    drawBadge(big, { url, name, business, width: 1020 });
    void downloadCanvas(
      big,
      `tipme-${membership.business.slug}-${membership.location.slug}-badge.png`,
    );
  };
  return (
    <div className="business-codes business-codes--mine">
      <canvas
        ref={canvas}
        className="business-codes__badge"
        role="img"
        aria-label={`Your badge at ${membership.business.name}: QR code for ${printedLink(url)}`}
      />
      <p className="tm-hint">
        It opens your tip page at {membership.business.name}. If you leave, it
        opens your own page instead.
      </p>
      <Button variant="secondary" onClick={download}>
        Download your badge
      </Button>
    </div>
  );
}
