import type { ReactNode } from 'react';

// Print formats for a Pro design. Each is a layout in the browser around the picture the server
// drew: the code is never redrawn or recoloured here, only placed, and no font comes from the
// server. Nothing in a format moves.

export interface FormatInput {
  /** The server's picture of the code. */
  src: string;
  name: string;
  role: string | null;
  /** The page link without `https://`, as printed under the code. */
  label: string;
}

export const QR_FORMATS = [
  { id: 'counter', name: 'Counter card' },
  { id: 'poster', name: 'Poster' },
  { id: 'sticker', name: 'Round sticker' },
  { id: 'ticket', name: 'Ticket' },
  { id: 'receipt', name: 'Receipt slip' },
  { id: 'lock', name: 'Phone lock screen' },
  { id: 'business', name: 'Business card' },
  { id: 'hang', name: 'Hang tag' },
] as const;
export type QrFormatId = (typeof QR_FORMATS)[number]['id'];

const Code = ({ src, label }: { src: string; label: string }) => (
  // eslint-disable-next-line @next/next/no-img-element -- a private, session-only image
  <img className="qr-format__code" src={src} alt={`QR code for ${label}`} />
);

const LAYOUTS: Record<QrFormatId, (input: FormatInput) => ReactNode> = {
  counter: ({ src, name, label }) => (
    <>
      <p className="qr-format__title">Enjoyed the service?</p>
      <p className="qr-format__sub">Scan to tip {name}</p>
      <div className="qr-format__plate">
        <Code src={src} label={label} />
      </div>
      <p className="qr-format__link">{label}</p>
    </>
  ),
  poster: ({ src, name, role, label }) => (
    <>
      <p className="qr-format__big">{name}</p>
      <p className="qr-format__sub">
        {role ? `${role}. ` : ''}A thank you goes a long way.
      </p>
      <div className="qr-format__foot">
        <p>
          Scan to send a tip.
          <br />
          No account needed.
        </p>
        <Code src={src} label={label} />
      </div>
    </>
  ),
  sticker: ({ src, name, label }) => (
    <>
      <svg className="qr-format__ring" viewBox="0 0 390 390" aria-hidden="true">
        <defs>
          <path
            id="qr-ring"
            d="M195 195m-168 0a168 168 0 1 1 336 0a168 168 0 1 1 -336 0"
          />
        </defs>
        <text
          fill="currentColor"
          fontSize="20"
          fontWeight="700"
          letterSpacing="3"
        >
          <textPath href="#qr-ring">
            {`Scan to tip ${name} on TipMe. Scan to tip ${name} on TipMe.`}
          </textPath>
        </text>
      </svg>
      <div className="qr-format__plate">
        <Code src={src} label={label} />
      </div>
    </>
  ),
  ticket: ({ src, label }) => (
    <>
      <p className="qr-format__title">A ticket to say thanks</p>
      <div className="qr-format__perforated">
        <Code src={src} label={label} />
      </div>
      <p className="qr-format__link">{label}</p>
    </>
  ),
  receipt: ({ src, name, label }) => (
    <>
      <p className="qr-format__title">Thanks for visiting</p>
      <p className="qr-format__small">Service by {name}</p>
      <p className="qr-format__rule">Enjoyed it? Leave a tip.</p>
      <Code src={src} label={label} />
      <p className="qr-format__rule qr-format__small">{label}</p>
    </>
  ),
  lock: ({ src, name, label }) => (
    <>
      <p className="qr-format__big">{name}</p>
      <p className="qr-format__small">Show this to get tipped</p>
      <div className="qr-format__plate">
        <Code src={src} label={label} />
      </div>
    </>
  ),
  business: ({ src, name, role, label }) => (
    <>
      <div className="qr-format__text">
        <p className="qr-format__big">{name}</p>
        {role && <p className="qr-format__small">{role}</p>}
        <p className="qr-format__small">{label}</p>
      </div>
      <div className="qr-format__plate">
        <Code src={src} label={label} />
      </div>
    </>
  ),
  hang: ({ src, name, label }) => (
    <>
      <span className="qr-format__hole" aria-hidden="true" />
      <p className="qr-format__title">Scan to tip {name}</p>
      <div className="qr-format__plate">
        <Code src={src} label={label} />
      </div>
    </>
  ),
};

/** One format, ready to print. The sheet is what the print stylesheet keeps on the page. */
export function QrFormat({
  format,
  ...input
}: FormatInput & { format: QrFormatId }) {
  return (
    <div className="qr-sheet">
      <div className={`qr-format qr-format--${format}`}>
        {LAYOUTS[format](input)}
      </div>
    </div>
  );
}
