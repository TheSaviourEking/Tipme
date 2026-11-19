/**
 * What the editor sends its preview (styles plan Task 12): the draft, the person's page as
 * visitors get it, the draft's photos and the photo accent. Plain TypeScript, shared by the editor
 * (studio-preview.tsx) and the preview document (preview-frame.tsx). Messages go only between
 * this origin's editor and its own preview frame; each side checks the origin and the sender.
 */
import type {
  PhotoAccentFailed,
  PhotoAccentValues,
  PublicProfile,
  PublicStudio,
} from '@tipme/contracts';
import type { PaymentMode } from '@/lib/payment-mode';

export const PREVIEW_READY = 'tipme:studio-preview:ready';
export const PREVIEW_SHOW = 'tipme:studio-preview:show';

export interface PreviewPayload {
  /** The draft, as the editor holds it; the frame resolves it again before drawing. */
  document: unknown;
  profile: PublicProfile;
  images: PublicStudio['images'];
  photoAccent: PhotoAccentValues | PhotoAccentFailed | null;
  paymentMode: PaymentMode;
}

export type PreviewMessage =
  | { type: typeof PREVIEW_READY }
  | { type: typeof PREVIEW_SHOW; payload: PreviewPayload };

export const isPreviewMessage = (data: unknown): data is PreviewMessage =>
  typeof data === 'object' &&
  data !== null &&
  ((data as { type?: unknown }).type === PREVIEW_READY ||
    ((data as { type?: unknown }).type === PREVIEW_SHOW &&
      typeof (data as { payload?: unknown }).payload === 'object'));
