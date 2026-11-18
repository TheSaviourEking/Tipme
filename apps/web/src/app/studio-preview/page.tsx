import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getPageStudioOn } from '@/lib/page-studio-switch-api';
import { PreviewFrame } from './preview-frame';

// It asks the API whether Page Studio is on, per request: nothing to prerender.
export const instant = false;

export const metadata: Metadata = {
  title: 'Page Studio preview',
  robots: { index: false, follow: false },
};

/**
 * Page Studio's preview document (styles plan Task 12): only ever shown inside the editor's frame,
 * which posts it the draft. A Studio route, so it answers 404 while the `page_studio` switch is off
 * (controller ruling AJ). It reads nothing about anyone and shows nothing on its own: an empty shell
 * until its own origin's editor posts a draft. It can't check the session itself (the session
 * cookie belongs to the API's origin), and needs none: the editor that frames it is signed in,
 * and the frame holds only what that editor sends. The site's header, footer and notices are
 * hidden: the preview is the person's page alone.
 */
export default async function StudioPreviewPage() {
  if (!(await getPageStudioOn())) notFound();
  return (
    <>
      <style>{`.site-header,.site-footer,.skip-link,.update-notice{display:none!important}`}</style>
      <PreviewFrame />
    </>
  );
}
