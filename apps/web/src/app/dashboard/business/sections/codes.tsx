'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { BusinessCodes, BusinessDetail } from '@tipme/contracts';
import { Button, Skeleton, StateLine } from '@tipme/ui';
import {
  downloadCanvas,
  loadBusinessCodes,
  signLogo,
  useSignLogo,
  useWebOrigin,
  type CodesAnswer,
} from '@/lib/business/codes-api';
import {
  type SignLogo,
  SIGN_STYLES,
  codeUrl,
  drawLocationSign,
  drawStaffBadge,
  printedLink,
} from '@/lib/business-sign';

const NIGHT = SIGN_STYLES[0]!;
const printHref = (businessId: string, query: Record<string, string>) =>
  `/dashboard/business/codes/print?${new URLSearchParams({ business: businessId, ...query })}`;

/** A small picture of one location's sign: the same drawing that prints. */
function SignPreview({
  url,
  business,
  location,
  logo,
}: {
  url: string;
  business: string;
  location: string;
  /** `undefined` while it loads: nothing is drawn until then. */
  logo: SignLogo | null | undefined;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (canvas.current && logo !== undefined)
      drawLocationSign(canvas.current, {
        url,
        business,
        location,
        style: NIGHT,
        width: 480,
        logo,
      });
  }, [url, business, location, logo]);
  return (
    <canvas
      ref={canvas}
      className="business-codes__preview"
      role="img"
      aria-label={`Sign for ${location}: QR code for ${printedLink(url)}`}
    />
  );
}

/**
 * Business → Codes (PR B8): one sign per location and an optional badge per person. Nothing is
 * drawn before TipMe verifies the business (M12), so no code goes up that leads nowhere.
 */
export function CodesSection({ business }: { business: BusinessDetail }) {
  const origin = useWebOrigin();
  // Kept with the business it belongs to, so switching never shows the last one's codes.
  const [loaded, setLoaded] = useState<{
    id: string;
    attempt: number;
    answer: CodesAnswer;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const verified = business.status === 'verified';
  useEffect(() => {
    if (!verified) return;
    void loadBusinessCodes(business.id).then((answer) =>
      setLoaded({ id: business.id, attempt, answer }),
    );
  }, [verified, business.id, attempt]);
  const answer =
    loaded?.id === business.id && loaded.attempt === attempt
      ? loaded.answer
      : null;

  // The server has the last word: a business paused after this page loaded prints nothing.
  if (
    business.status === 'suspended' ||
    (verified && answer?.state === 'not-verified')
  )
    return (
      <p className="tm-hint">
        TipMe has paused {business.name}, so its codes can’t be printed right
        now.
      </p>
    );
  if (!verified)
    return (
      <p className="tm-hint">
        Your codes can be printed once TipMe verifies {business.name}, so no
        sign goes up that leads nowhere.
      </p>
    );
  if (!answer || !origin) return <Skeleton label="Loading your codes" />;
  if (answer.state !== 'ready')
    return (
      <div className="business-codes">
        <StateLine tone="error">Your codes didn’t load.</StateLine>
        <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      </div>
    );
  return (
    <CodesList codes={answer.codes} businessId={business.id} origin={origin} />
  );
}

function CodesList({
  codes,
  businessId,
  origin,
}: {
  codes: BusinessCodes;
  businessId: string;
  origin: string;
}) {
  const logo = useSignLogo(codes.business.logoPath);
  const locationName = (id: string) =>
    codes.location.find((entry) => entry.locationId === id)?.name ?? '';
  const downloadSign = async (entry: BusinessCodes['location'][number]) => {
    const canvas = document.createElement('canvas');
    drawLocationSign(canvas, {
      url: codeUrl(origin, entry.path),
      business: codes.business.name,
      location: entry.name,
      style: NIGHT,
      width: 1240,
      // Waits for the logo if the preview has not loaded it yet; null draws the initial.
      logo: await signLogo(codes.business.logoPath),
    });
    void downloadCanvas(
      canvas,
      `tipme-${codes.business.slug}-${entry.slug}-sign.png`,
    );
  };
  const downloadBadge = (entry: BusinessCodes['staff'][number]) => {
    const canvas = document.createElement('canvas');
    drawStaffBadge(canvas, {
      url: codeUrl(origin, entry.path),
      name: entry.shownName,
      business: codes.business.name,
      style: NIGHT,
      width: 1020,
    });
    void downloadCanvas(
      canvas,
      `tipme-${codes.business.slug}-${entry.shownName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-badge.png`,
    );
  };
  return (
    <div className="business-codes">
      <p className="tm-hint">
        One sign per location. It shows whoever works there that day, so it
        never needs reprinting when your team changes.
      </p>
      <h3>Location signs</h3>
      {codes.location.length === 0 ? (
        <p>No open locations to print a sign for.</p>
      ) : (
        <ul className="business-codes__signs">
          {codes.location.map((entry) => (
            <li key={entry.locationId} className="business-codes__sign">
              <SignPreview
                url={codeUrl(origin, entry.path)}
                business={codes.business.name}
                location={entry.name}
                logo={logo}
              />
              <p className="business-codes__name">{entry.name}</p>
              <div className="business-codes__actions">
                <Button
                  variant="secondary"
                  onClick={() => void downloadSign(entry)}
                >
                  Download {entry.name} sign
                </Button>
                <Link
                  className="tm-button tm-button--secondary"
                  href={printHref(businessId, { location: entry.locationId })}
                >
                  Print {entry.name} sign
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
      <h3>Staff badges</h3>
      <p className="tm-hint">
        Optional. A badge opens that person’s tip page here, skipping the list.
      </p>
      {codes.staff.length === 0 ? (
        <p>
          Nobody works here on TipMe yet. Their badges show here once they join.
        </p>
      ) : (
        <>
          <ul className="business-codes__staff">
            {codes.staff.map((entry) => (
              <li key={entry.memberId}>
                <span>
                  {entry.shownName}
                  {codes.location.length > 1 && (
                    <span className="tm-hint">
                      {' '}
                      · {locationName(entry.locationId)}
                    </span>
                  )}
                </span>
                <Button
                  variant="secondary"
                  onClick={() => downloadBadge(entry)}
                >
                  Download {entry.shownName}’s badge
                </Button>
              </li>
            ))}
          </ul>
          <Link
            className="tm-button tm-button--secondary"
            href={printHref(businessId, { format: 'badge' })}
          >
            Print every badge
          </Link>
        </>
      )}
    </div>
  );
}
