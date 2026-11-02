/** A failure worth trying again, as opposed to an answer: no response, rate limit or server error. */
export const isTemporaryFailure = (status: number): boolean =>
  status === 0 || status === 429 || status >= 500;

/** Only these steps can still use an emailed code; every other outcome drops it. */
export const keepsEnrolLink = (step: string): boolean =>
  step === 'needs_enrolment' || step === 'retry';
