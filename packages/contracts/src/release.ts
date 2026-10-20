// Release rehearsal (PR-010).

/** `test` copies may run the full release check; `live` copies (real people) only read-only. */
export type ReleaseKind = 'test' | 'live';

export interface ReleaseInfo {
  kind: ReleaseKind;
  version: string;
  deploymentMode: 'production' | 'preview';
  paymentsLive: boolean;
  analytics: boolean;
}
