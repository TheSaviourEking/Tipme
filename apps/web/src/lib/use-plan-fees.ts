'use client';
import { useEffect, useState } from 'react';
import { planFees } from './api-client';
import {
  DEFAULT_PLAN_FEE_PERCENTS,
  planFeePercentsOf,
  type PlanFeePercents,
} from './fee-share';

/**
 * TipMe's live fee per plan in the browser (owner, 18 Nov 2026). Starts at the coded defaults (the
 * rates TipMe started with) and takes the server's once read; a failed read keeps the defaults.
 */
export function usePlanFees(): PlanFeePercents {
  const [fees, setFees] = useState(DEFAULT_PLAN_FEE_PERCENTS);
  useEffect(() => {
    let live = true;
    void planFees().then((result) => {
      const read = result.ok ? planFeePercentsOf(result.data) : null;
      if (live && read) setFees(read);
    });
    return () => {
      live = false;
    };
  }, []);
  return fees;
}
