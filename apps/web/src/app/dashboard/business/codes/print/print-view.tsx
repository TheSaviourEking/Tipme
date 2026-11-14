'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Button, Skeleton, StateLine } from '@tipme/ui';
import { track } from '@/lib/analytics';
import {
  loadBusinessCodes,
  useSignLogo,
  useWebOrigin,
  type CodesAnswer,
} from '@/lib/business/codes-api';
import {
  SIGN_FORMATS,
  SIGN_STYLES,
  codeUrl,
  drawLocationSign,
  drawStaffBadge,
  printedLink,
  type SignFormatId,
  type SignLogo,
} from '@/lib/business-sign';
import type { QrStyle } from '@/lib/qr-render';

type Sheet =
  | {
      kind: 'sign';
      key: string;
      url: string;
      business: string;
      location: string;
      /** `undefined` while it loads: nothing is drawn until then. */
      logo: SignLogo | null | undefined;
    }
  | {
      kind: 'badge';
      key: string;
      url: string;
      business: string;
      name: string;
      location: string;
    };

function SheetCanvas({
  sheet,
  format,
  style,
}: {
  sheet: Sheet;
  format: SignFormatId;
  style: QrStyle;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current) return;
    if (sheet.kind === 'sign') {
      if (sheet.logo === undefined) return;
      drawLocationSign(canvas.current, {
        url: sheet.url,
        business: sheet.business,
        location: sheet.location,
        logo: sheet.logo,
        style,
        // About 200 dpi on A5, more on A6: crisp on paper.
        width: 1240,
      });
    } else
      drawStaffBadge(canvas.current, {
        url: sheet.url,
        name: sheet.name,
        business: sheet.business,
        style,
        width: 1020,
      });
  }, [sheet, style]);
  const caption =
    sheet.kind === 'sign'
      ? `${sheet.business} · ${sheet.location}`
      : `${sheet.name} at ${sheet.business} · ${sheet.location}`;
  return (
    <figure
      className={`business-print__sheet business-print__sheet--${format}`}
    >
      <canvas
        ref={canvas}
        className="business-print__canvas"
        role="img"
        aria-label={`${sheet.kind === 'sign' ? 'Sign' : 'Badge'} for ${caption}: QR code for ${printedLink(sheet.url)}`}
      />
      <figcaption className="print-hide">{caption}</figcaption>
    </figure>
  );
}

/**
 * The print view for a business's codes (PR B8, modelled on `/dashboard/qr/print`): an A5 sign or
 * an A6 table tent per location, or an 85 × 55 mm badge per person, one per printed page.
 */
export default function BusinessCodesPrintView() {
  const params = useSearchParams();
  const businessId = params.get('business') ?? '';
  const onlyLocation = params.get('location');
  const onlyMember = params.get('member');
  const id = useId();
  const origin = useWebOrigin();
  const [answer, setAnswer] = useState<CodesAnswer | null>(null);
  const [format, setFormat] = useState<SignFormatId>(
    params.get('format') === 'badge' || onlyMember
      ? 'badge'
      : params.get('format') === 'tent'
        ? 'tent'
        : 'sign',
  );
  const [styleId, setStyleId] = useState(SIGN_STYLES[0]!.id);
  const style =
    SIGN_STYLES.find((entry) => entry.id === styleId) ?? SIGN_STYLES[0]!;

  useEffect(() => {
    void (
      businessId
        ? loadBusinessCodes(businessId)
        : Promise.resolve<CodesAnswer>({ state: 'failed' })
    ).then(setAnswer);
  }, [businessId]);
  const logo = useSignLogo(
    answer?.state === 'ready' ? answer.codes.business.logoPath : undefined,
  );

  const back = (
    <Link
      className="tm-button tm-button--secondary"
      href="/dashboard/business#codes"
    >
      Back
    </Link>
  );
  if (!answer || !origin)
    return (
      <div className="print-card business-print">
        <Skeleton label="Loading your codes" />
      </div>
    );
  if (answer.state !== 'ready')
    return (
      <div className="print-card business-print">
        <h1>Print your codes</h1>
        <StateLine tone="error">
          {answer.state === 'not-verified'
            ? 'Codes can be printed once TipMe verifies this business.'
            : 'Your codes didn’t load.'}
        </StateLine>
        <div className="qr-actions">{back}</div>
      </div>
    );

  const { codes } = answer;
  const locationName = (locationId: string) =>
    codes.location.find((entry) => entry.locationId === locationId)?.name ?? '';
  const sheets: Sheet[] =
    format === 'badge'
      ? codes.staff
          .filter(
            (entry) =>
              (!onlyMember || entry.memberId === onlyMember) &&
              (!onlyLocation || entry.locationId === onlyLocation),
          )
          .map((entry) => ({
            kind: 'badge',
            key: entry.memberId,
            url: codeUrl(origin, entry.path),
            business: codes.business.name,
            name: entry.shownName,
            location: locationName(entry.locationId),
          }))
      : codes.location
          .filter((entry) => !onlyLocation || entry.locationId === onlyLocation)
          .map((entry) => ({
            kind: 'sign',
            key: entry.locationId,
            url: codeUrl(origin, entry.path),
            business: codes.business.name,
            location: entry.name,
            logo,
          }));
  const print = () => {
    track('qr_printed', { surface: 'qr' });
    window.print();
  };
  return (
    <div className="print-card business-print">
      <h1 className="print-hide">Print your codes</h1>
      <p className="print-hide tm-hint">
        One code per printed page. Each one leads to {codes.business.name} on
        TipMe.
      </p>
      <fieldset className="print-hide qr-formats">
        <legend>Format</legend>
        {SIGN_FORMATS.map((option) => (
          <label key={option.id} className="qr-style">
            <input
              type="radio"
              name={`${id}-format`}
              value={option.id}
              checked={format === option.id}
              onChange={() => setFormat(option.id)}
            />
            <span>
              {option.name}
              <small className="qr-style__premium">{option.size}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="print-hide qr-formats">
        <legend>Colour</legend>
        {SIGN_STYLES.map((option) => (
          <label key={option.id} className="qr-style">
            <input
              type="radio"
              name={`${id}-style`}
              value={option.id}
              checked={styleId === option.id}
              onChange={() => setStyleId(option.id)}
            />
            <span>{option.id === 'night' ? 'Black' : option.name}</span>
          </label>
        ))}
      </fieldset>
      {sheets.length === 0 ? (
        <p>
          {format === 'badge'
            ? 'Nobody works here on TipMe yet, so there are no badges to print.'
            : 'No open locations to print a sign for.'}
        </p>
      ) : (
        <div className="business-print__sheets">
          {sheets.map((sheet) => (
            <SheetCanvas
              key={sheet.key}
              sheet={sheet}
              format={format}
              style={style}
            />
          ))}
        </div>
      )}
      <div className="print-hide qr-actions">
        <Button onClick={print} disabled={sheets.length === 0}>
          Print
        </Button>
        {back}
      </div>
    </div>
  );
}
