import { getPlanFees } from '@/lib/plan-fees-api';

/** TipMe's live share on a plan, as a number ("5"), for server copy that writes "{…}%". */
export async function PlanFeePercent({ plan }: { plan: 'free' | 'pro' }) {
  const fees = await getPlanFees();
  return <>{plan === 'pro' ? fees.proPercent : fees.freePercent}</>;
}
