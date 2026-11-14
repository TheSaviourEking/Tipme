/**
 * GET /v1/me/account (business sign-up, Task D1): the login's own facts, read with a session
 * only. Unlike /v1/me/profile it never needs a page, so a business-only login can read it.
 */
export interface MyAccount {
  userId: string;
  /** The sign-in email, shown only to the login itself. */
  email: string | null;
  emailVerified: boolean;
  hasProfile: boolean;
  handle: string | null;
}
