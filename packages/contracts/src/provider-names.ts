/** Which Bachs a provider name talks to; null for the pretend provider. */
export function bachsEnvironment(name: string): 'sandbox' | 'live' | null {
  if (name === 'bachs-live') return 'live';
  if (name === 'bachs-sandbox') return 'sandbox';
  return null;
}

/**
 * The provider name recorded on payment attempts, accounts and payouts. Both Bachs environments
 * record 'bachs', as rows did before live payments (ADR-0004); payment_accounts.environment and
 * each copy's own database keep sandbox and live apart.
 */
export function recordedProviderName(name: string): string {
  return bachsEnvironment(name) ? 'bachs' : name;
}

/**
 * You collect (Task 15 fix round 1, C1): the most dispute evidence files a provider takes. Bachs's
 * evidence has one general attachment slot (Task 5's adapter), so one; five elsewhere
 * (OPS_COLLECT_EVIDENCE_MAX_FILES).
 */
export function opsCollectEvidenceMaxFiles(provider: string): number {
  return recordedProviderName(provider) === 'bachs' ? 1 : 5;
}
