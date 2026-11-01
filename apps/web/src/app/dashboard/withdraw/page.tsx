import { PilotNotice } from '@/components/pilot-notice';
import WithdrawPage from './withdraw-view';

// The dashboard renders only after the signed-in profile loads in the browser (dashboard-shell),
// so this segment has nothing to prerender for instant navigation.
export const instant = false;

export default function Page() {
  return <WithdrawPage pilotNotice={<PilotNotice />} />;
}
