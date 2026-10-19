import { ImageResponse } from 'next/og';
import { shareCard } from '@/lib/metadata';

// Shared, request-independent card: prerendered at build. Never include per-visitor or draft data here.
export const alt = shareCard.alt;
export const size = { width: shareCard.width, height: shareCard.height };
export const contentType = 'image/png';

/** Inline heart SVG — avoids font dependency for the mark in next/og context. */
function Heart({ size: px }: { size: number }) {
  return (
    <svg width={px} height={px} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
        fill="#7A32F9"
      />
    </svg>
  );
}

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
        {/* "tipme♥" wordmark */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            fontSize: 56,
            fontWeight: 900,
            letterSpacing: '-2px',
            lineHeight: 1,
          }}
        >
          <span style={{ color: '#000000' }}>tip</span>
          <span style={{ color: '#7A32F9' }}>me</span>
          <span
            style={{
              color: '#7A32F9',
              fontSize: 32,
              marginBottom: 14,
              marginLeft: 3,
            }}
          >
            ♥
          </span>
        </div>
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
          Development preview · No payments
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
