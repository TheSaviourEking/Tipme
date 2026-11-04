'use client';
import { useState, type ReactNode } from 'react';
import { Lever } from '@tipme/ui';

type View = 'tipped' | 'tipping';

const options: { value: View; label: string }[] = [
  { value: 'tipped', label: 'If you get tipped' },
  { value: 'tipping', label: "If you're tipping" },
];

/**
 * Home's steps, one set at a time. Both sets arrive already rendered by the server and the
 * lever only hides one, so nothing here fetches and the first set is in the HTML.
 */
export function HowLever({
  tipped,
  tipping,
}: {
  tipped: ReactNode;
  tipping: ReactNode;
}) {
  const [view, setView] = useState<View>('tipped');
  return (
    <>
      <div className="home-how__head">
        <h2 id="how-title">
          {view === 'tipping'
            ? 'Tip in three steps.'
            : 'Tipped in three steps.'}
        </h2>
        <Lever<View>
          label="Show the steps for"
          options={options}
          value={view}
          onChange={setView}
        />
      </div>
      <div hidden={view !== 'tipped'}>{tipped}</div>
      <div hidden={view !== 'tipping'}>{tipping}</div>
    </>
  );
}
