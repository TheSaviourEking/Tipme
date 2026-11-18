import type { Metadata } from 'next';
import { PreviewFrame } from './preview-frame';

export const metadata: Metadata = {
  title: 'Page Studio preview',
  robots: { index: false, follow: false },
};

/**
 * Page Studio's preview document (styles plan Task 12): only ever shown inside the editor's frame,
 * which posts it the draft. It reads nothing itself and shows nothing on its own. The site's
 * header, footer and notices are hidden: the preview is the person's page alone.
 */
export default function StudioPreviewPage() {
  return (
    <>
      <style>{`.site-header,.site-footer,.skip-link,.update-notice{display:none!important}`}</style>
      <PreviewFrame />
    </>
  );
}
