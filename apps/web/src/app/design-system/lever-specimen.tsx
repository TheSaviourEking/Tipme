'use client';
import { useState } from 'react';
import { Lever } from '@tipme/ui';

const plans = [
  { value: 'free', label: 'Free' },
  { value: 'pro', label: 'Pro' },
];

/** The lever needs state, so its specimen is the one interactive island on the page. */
export function LeverSpecimen() {
  const [plan, setPlan] = useState('free');
  return <Lever label="Plan" options={plans} value={plan} onChange={setPlan} />;
}
