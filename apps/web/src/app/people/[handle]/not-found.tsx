import { PageUnavailable } from '@/components/page-unavailable';
import { PaymentModeSlot } from '@/components/payment-mode-slot';

export default function ProfileUnavailable() {
  return (
    <PaymentModeSlot fallback={<PageUnavailable showDemo={false} />}>
      {(_mode, copy) => <PageUnavailable showDemo={copy.previewPages} />}
    </PaymentModeSlot>
  );
}
