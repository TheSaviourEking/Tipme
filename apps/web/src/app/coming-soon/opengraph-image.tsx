import { ImageResponse } from 'next/og';
import { WORDMARK_PATHS, WORDMARK_VIEWBOX } from '@/components/brand';

export const alt = 'TipMe opens at midnight in Lagos';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function ComingSoonOpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '58px 64px',
        background: '#f8f5ef',
        color: '#0b0b0c',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <svg width={158} height={60} viewBox={WORDMARK_VIEWBOX}>
          {WORDMARK_PATHS.map((path) => (
            <path key={path.d.slice(0, 24)} d={path.d} fill={path.fill} />
          ))}
        </svg>
        <div
          style={{
            display: 'flex',
            padding: '10px 18px',
            border: '2px solid #d9d0c6',
            borderRadius: 999,
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: 1,
            textTransform: 'uppercase',
          }}
        >
          27 October · 00:00 WAT
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 42 }}>
        <div
          style={{
            display: 'flex',
            flex: 1,
            flexDirection: 'column',
            fontSize: 88,
            lineHeight: 0.98,
            letterSpacing: -4,
          }}
        >
          <span>A little thanks</span>
          <span>is almost here.</span>
        </div>
        <div
          style={{
            display: 'flex',
            width: 124,
            height: 124,
            alignItems: 'center',
            justifyContent: 'center',
            border: '2px solid #6120d6',
            borderRadius: 30,
            background: '#7a32f9',
            boxShadow: '0 12px 0 #4f16af',
            color: '#ffffff',
            fontSize: 54,
          }}
        >
          00
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          color: '#66615c',
          fontSize: 23,
        }}
      >
        <span>TipMe opens at midnight in Lagos.</span>
        <span>For the people who make a difference.</span>
      </div>
    </div>,
    size,
  );
}
