'use client';
import { ActionLink, Card, ProBadge } from '@tipme/ui';
import { useRecipient } from '@/components/account/recipient-context';
import { ASK_FOR_PRO } from '@/components/marketing/plan-preview';
import { SettingsChapter } from './section';

// Plan (ScreenSettings).

/**
 * What Pro includes, for every plan. Nothing to buy here: staff arrange Pro for now, so a Free page
 * gets the same ask as /pro. No price is named (docs/00-DECISIONS.md).
 */
export function ProPlan() {
  const { profile } = useRecipient();
  const pro = profile.plan === 'pro';
  return (
    <Card id="pro" className="settings-section settings-plan">
      <div className="settings-plan__head">
        <h3>TipMe Pro</h3>
        {pro && <ProBadge />}
      </div>
      <p className="tm-hint">
        {pro ? 'Your page is on TipMe Pro.' : 'Your page is on the Free plan.'}{' '}
        Pro includes:
      </p>
      <ul className="settings-list">
        <li>
          Pro QR designs, and print formats such as a counter card, poster or
          sticker. Free pages keep the three standard QR looks.
        </li>
        <li>
          Three changes to your handle. Free pages keep the handle they claimed.
        </li>
        <li>Your own tip amounts</li>
        <li>No “Get your own TipMe page” link at the foot of your page</li>
      </ul>
      <p className="tm-hint">
        Photos and designs are free on every plan, and Free includes three
        animated covers that play once. Pro adds every animated cover in any
        colour, with a slow loop.
      </p>
      {!pro && (
        <>
          <p className="tm-hint">
            The TipMe team turns Pro on for your page, and this page will show
            it when they do.
          </p>
          <ActionLink
            variant="continue"
            href={ASK_FOR_PRO}
            className="settings-plan__ask"
          >
            Ask for Pro
          </ActionLink>
        </>
      )}
    </Card>
  );
}

export function PlanSection() {
  return (
    <SettingsChapter id="plan">
      <ProPlan />
    </SettingsChapter>
  );
}
