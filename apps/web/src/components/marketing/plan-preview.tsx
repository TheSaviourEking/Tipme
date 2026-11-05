'use client';
import Image from 'next/image';
import { useState } from 'react';
import { STANDARD_TIP_PRESETS_MINOR } from '@tipme/domain';
import { ActionLink, Lever, ProBadge, Surface } from '@tipme/ui';
import { formatNaira } from '@/lib/demo-amount';
import { TIPME_SHARE_PERCENT } from '@/lib/fee-share';

type Plan = 'free' | 'pro';

// Ada's handle on Free, then the three changes Pro allows. The sample never touches a real page.
const HANDLES = ['ada', 'adacuts', 'adaedits', 'adaokafor'] as const;
const MAX_CHANGES = HANDLES.length - 1;
const STANDARD_AMOUNTS = STANDARD_TIP_PRESETS_MINOR.map((minor) =>
  formatNaira(Number(minor)),
);
// "Try yours": amounts a Pro page might choose instead of the standard three.
const OWN_AMOUNTS = ['₦3,000', '₦6,000', '₦12,000'];
export const ASK_FOR_PRO = 'mailto:support@usetipme.xyz?subject=TipMe%20Pro';

const HEART =
  'M12 21s-7.5-4.6-9.6-9.3C1 8.4 3 5 6.4 5c2.2 0 4 1.2 5.6 3.4C13.6 6.2 15.4 5 17.6 5 21 5 23 8.4 21.6 11.7 19.5 16.4 12 21 12 21z';
const HEARTS = [
  { x: '8%', size: '34px', delay: '0s' },
  { x: '30%', size: '22px', delay: '0.5s' },
  { x: '52%', size: '44px', delay: '0.2s' },
  { x: '74%', size: '26px', delay: '0.9s' },
  { x: '88%', size: '36px', delay: '0.4s' },
];

/** Ada's sample page beside what each plan changes, built to the PagePro board. */
export function PlanPreview() {
  const [plan, setPlan] = useState<Plan>('free');
  const [changes, setChanges] = useState(0);
  const [own, setOwn] = useState(false);

  const pro = plan === 'pro';
  const used = pro ? changes : 0;
  const handle = HANDLES[used];
  const amounts = pro && own ? OWN_AMOUNTS : STANDARD_AMOUNTS;
  const handlesLeft = pro && used < MAX_CHANGES;

  return (
    <div className="pro-wrap">
      <section className="pro-head" aria-labelledby="pro-title">
        <h1 id="pro-title" className="pro-title">
          Make your page unmistakably yours.
        </h1>
        <Lever<Plan>
          label="Plan"
          options={[
            { value: 'free', label: 'Free' },
            { value: 'pro', label: 'Pro' },
          ]}
          value={plan}
          onChange={setPlan}
        />
      </section>
      <section className="pro-body">
        <Surface material="instrument" className="pro-sample">
          {/* A still picture of a cover. Animated covers are not built yet, so nothing here moves or is promised. */}
          <div className="pro-cover" aria-hidden="true">
            {HEARTS.map((heart) => (
              <span
                key={heart.x}
                className="pro-heart"
                style={
                  {
                    '--x': heart.x,
                    '--s': heart.size,
                    '--d': heart.delay,
                  } as React.CSSProperties
                }
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d={HEART} />
                </svg>
              </span>
            ))}
          </div>
          <div className="pro-sample__body">
            <Image
              className="pro-avatar"
              src="/portraits/ada.webp"
              alt="Ada Okafor"
              width={88}
              height={88}
            />
            <p className="pro-name">Ada Okafor {pro ? <ProBadge /> : null}</p>
            <p className="pro-link">usetipme.xyz/@{handle}</p>
            <div className="pro-keys" aria-hidden="true">
              {amounts.map((label, index) => (
                <span
                  key={label}
                  className={index === 1 ? 'pro-key pro-key--on' : 'pro-key'}
                >
                  {label}
                </span>
              ))}
            </div>
            <div className="pro-tip" aria-hidden="true">
              Tip {amounts[1]}
            </div>
          </div>
        </Surface>
        <div className="pro-plan">
          <p className="pro-plan__line">
            {pro
              ? 'For when your page and QR code are part of your brand.'
              : 'Everything you need to get tipped, at no cost.'}
          </p>
          <p className="pro-plan__price">
            {pro ? (
              <>
                <ProBadge /> Granted by TipMe staff
              </>
            ) : (
              'Free'
            )}
          </p>
          <div className="pro-row">
            <div>
              <strong>Handle</strong>
              <br />
              {pro
                ? `Changed ${used} of ${MAX_CHANGES} times.${handlesLeft ? '' : ' That is all of them.'}`
                : 'Stays as you claimed it.'}
            </div>
            <button
              type="button"
              className="pro-mini"
              aria-disabled={!handlesLeft}
              onClick={() => {
                if (handlesLeft) setChanges(used + 1);
              }}
            >
              Change it
            </button>
          </div>
          <div className="pro-row">
            <div>
              <strong>Tip amounts</strong>
              <br />
              {pro && own
                ? 'Your amounts, on your page.'
                : pro
                  ? 'Set your own.'
                  : 'The standard three.'}
            </div>
            <button
              type="button"
              className="pro-mini"
              aria-disabled={!pro}
              onClick={() => {
                if (pro) setOwn(!own);
              }}
            >
              Try yours
            </button>
          </div>
          <div className="pro-row pro-row--last">
            <div>
              <strong>QR code</strong>
              <br />
              {pro
                ? 'Pro designs and formats you can print.'
                : 'Your standard QR code.'}
            </div>
            <Image
              className="pro-qr"
              src={pro ? '/pro/qr-hearts.png' : '/pro/qr-standard.png'}
              alt={pro ? 'QR code made of small hearts' : 'Standard QR code'}
              width={72}
              height={72}
              unoptimized
            />
          </div>
          <div className="pro-cta">
            {pro ? (
              <ActionLink variant="continue" href={ASK_FOR_PRO}>
                Ask for Pro
              </ActionLink>
            ) : (
              <ActionLink variant="continue" href="/sign-up">
                Claim your username
              </ActionLink>
            )}
            <p>TipMe keeps {TIPME_SHARE_PERCENT}% of each tip on both plans.</p>
          </div>
        </div>
      </section>
    </div>
  );
}
