import { ImageResponse } from 'next/og';
import { connection } from 'next/server';
import { LAGOS_LAUNCH_TARGET, launchShortLabel } from '@/lib/countdown';
import { launchTargetFrom } from '@/lib/display-settings';
import { getDisplaySettings } from '@/lib/display-settings-api';
import { shareArt } from '@/lib/share-card';
import { WORDMARK } from '@/lib/wordmark';

export const alt = 'TipMe opens at midnight in Lagos';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function ComingSoonOpenGraphImage() {
  // The launch time is request-time state, as on the page itself.
  await connection();
  const target =
    launchTargetFrom(await getDisplaySettings(), process.env) ??
    Date.parse(LAGOS_LAUNCH_TARGET);
  const { wordmark } = await shareArt();
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
        <img
          src={wordmark}
          width={218}
          height={Math.round((218 * WORDMARK.height) / WORDMARK.width)}
          alt="TipMe"
        />
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
          {launchShortLabel(target)}
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
          <span>A little tip</span>
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
