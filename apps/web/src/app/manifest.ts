import type { MetadataRoute } from 'next';

// Home-screen name and icons only: no offline or app features. `browser` keeps the address bar,
// including on the payment partner's page (DECISION-LOG 2026-11-06).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'TipMe',
    short_name: 'TipMe',
    start_url: '/',
    display: 'browser',
    theme_color: '#7A32F9',
    background_color: '#FFFFFF',
    icons: [
      {
        src: '/icons/192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/512-maskable.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
