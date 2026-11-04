// The domain's handle rule (packages/domain/src/handles.ts), repeated here because that package
// also holds server-only code the browser bundle must not pull in.
const HANDLE = /^[a-z0-9_]{3,30}$/;

/**
 * The handle a sign-up link carries (`/sign-up?handle=Kemi_Cuts`), lowercased, or '' when the
 * link has none or it breaks the rule. A hint to prefill the handle step, never a claim.
 */
export function handleFromSearch(search: string): string {
  const value = new URLSearchParams(search).get('handle')?.trim().toLowerCase();
  return value && HANDLE.test(value) ? value : '';
}
