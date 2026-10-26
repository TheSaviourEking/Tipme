import { ImageResponse } from 'next/og';
import { WORDMARK_PATHS, WORDMARK_VIEWBOX } from '@/components/brand';
import { shareCard } from '@/lib/metadata';

// Shared, request-independent card: prerendered at build. Never include per-visitor or draft data here.
export const alt = shareCard.alt;
export const size = { width: shareCard.width, height: shareCard.height };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 72,
        background: '#FFFFFF',
        color: '#000000',
      }}
    >
      {/* Logo wordmark row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        {/* The wordmark from the master file, as in the site header. */}
        <svg width={170} height={64} viewBox={WORDMARK_VIEWBOX}>
          {WORDMARK_PATHS.map((path) => (
            <path key={path.d.slice(0, 24)} d={path.d} fill={path.fill} />
          ))}
        </svg>
        {/* Preview pill */}
        <div
          style={{
            display: 'flex',
            fontSize: 22,
            padding: '10px 20px',
            borderRadius: 999,
            border: '2px solid #DCC5FF',
            color: '#511CB0',
          }}
        >
          Development preview · No real payments
        </div>
      </div>

      {/* Headline */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          fontSize: 104,
          lineHeight: 1.02,
          letterSpacing: -5,
        }}
      >
        <span>A little thanks</span>
        <span style={{ color: '#7A32F9' }}>goes a long way.</span>
      </div>

      {/* Tagline */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <div
          style={{
            display: 'flex',
            width: 120,
            height: 12,
            borderRadius: 999,
            background: '#7A32F9',
          }}
        />
        <span style={{ fontSize: 26, color: '#555555' }}>
          For the people who make a difference.
        </span>
      </div>
    </div>,
    size,
  );
}
