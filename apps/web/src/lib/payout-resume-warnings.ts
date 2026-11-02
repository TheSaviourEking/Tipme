import type { OpsPayoutIssueView } from '@tipme/contracts';

/** What a person should weigh before sending this withdrawal, most serious first. */
export function resumeWarnings(
  view: Pick<
    OpsPayoutIssueView,
    'takeoverReported' | 'destinationReplaced' | 'holdTouched'
  >,
): string[] {
  return [
    ...(view.takeoverReported
      ? [
          'This account had a reported takeover. This withdrawal may be the thief’s, going to the thief’s bank. Check the bank recorded with it first; if in doubt, don’t resume it.',
        ]
      : []),
    ...(view.destinationReplaced
      ? [
          'The recipient has changed their bank since asking; it still goes to the bank recorded with the withdrawal.',
        ]
      : []),
    ...(view.holdTouched && !view.takeoverReported
      ? [
          'A hold on this recipient’s withdrawals has been in force since this was requested. Check why before sending it.',
        ]
      : []),
  ];
}
