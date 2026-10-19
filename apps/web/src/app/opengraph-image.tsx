import { ImageResponse } from 'next/og';
import { shareCard } from '@/lib/metadata';

// Shared, request-independent card: prerendered at build. Never include per-visitor or draft data here.
export const alt = shareCard.alt;
export const size = { width: shareCard.width, height: shareCard.height };
export const contentType = 'image/png';

function Flower({ size: px }: { size: number }) {
  return (
    <svg width={px} height={px} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 2v20M2 12h20M4.9 4.9l14.2 14.2M19.1 4.9 4.9 19.1"
        stroke="#7A32F9"
        strokeWidth="2.4"
        strokeLinecap="round"
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
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            fontSize: 44,
            letterSpacing: -1.5,
          }}
        >
          tipme
          <Flower size={34} />
        </div>
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
