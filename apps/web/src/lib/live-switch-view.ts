import type { OpsLiveNow, OpsLiveSwitch } from '@tipme/contracts';

const WHEN = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Lagos',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const CHECKOUT: Record<OpsLiveNow['checkout'], (handles: string[]) => string> =
  {
    test: () => 'Live payments: off. Test money only.',
    closed: () => 'Live payments: off. Checkout closed.',
    nobody: () => 'Live payments: on. Checkout open to nobody yet.',
    named: (handles) =>
      `Live payments: on. Checkout open to ${handles.map((h) => `@${h}`).join(', ')} only.`,
    everyone: () => 'Live payments: on. Checkout open to everyone.',
  };

export interface LiveSwitchView {
  /** From the API serving now. Null from an older API that doesn't say. */
  current: string | null;
  /** The last recorded change: history, which a failed deploy or write can leave behind. */
  history: string | null;
  disagrees: boolean;
  testMoney: boolean;
}

/** The Overview's lines on whether this copy takes real money, in Lagos time. */
export function liveSwitchView(
  now: OpsLiveNow | null | undefined,
  latest: OpsLiveSwitch | null | undefined,
): LiveSwitchView {
  return {
    current: now ? CHECKOUT[now.checkout](now.handles) : null,
    history: latest
      ? `Last recorded change: ${latest.live ? 'on' : 'off'}, ${WHEN.format(new Date(latest.switchedAt))}, by ${latest.version.slice(0, 7)}`
      : null,
    disagrees: now ? now.live !== (latest?.live ?? false) : false,
    testMoney: now?.checkout === 'test',
  };
}
