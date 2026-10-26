# PR-013 verification — 24 October 2026

## Scope delivered

The PRD v1.1 gaps that needed no outside decision. Pretend money only.

- **Reporting a page** (FR-01, impersonation):
  - "Report this page" on every public page, with a reason from a fixed list: impersonation, scam, abusive or other.
  - Nothing else is kept: no IP, user agent or free text. The answer is the same whether or not the page exists, and it is rate-limited per address.
  - Each page gets one open `profile_reported` issue. The evidence shows counts by reason. After a review, the next report opens a new issue.
- **Profile photos** (FR-01):
  - **Upload:** in Settings, with preview and remove.
  - **Processing:** every upload is decoded and re-encoded on the server to a 512×512 WebP with no metadata, so location and camera details are gone.
  - **Limits:** JPEG, PNG and WebP only; never SVG. Up to 5 MB and 40 megapixels, which refuses "pixel bombs".
  - **Storage:** in Postgres, so photos are covered by the backups and point-in-time recovery.
  - **Serving:** only while the page is live. Deleting the account erases the photo.
- **Tip search** (FR-05): by supporter name, an amount ("5,000") or the end of the payment reference, only within the recipient's own tips. The search text is never treated as a pattern.
- **Notification preferences** (FR-05):
  - Each of these can be turned off: tip emails, weekly-report notices, milestone notices.
  - In-app tip notices, sign-in codes and security warnings always go.
  - The report, the moment and the reward still happen when their notice is off.
- **Admin search** (FR-09):
  - New permission `search.view` (Owners have it). Finds pages by handle, name or old handle, and tips, withdrawals and ledger entries by id or the end of a reference.
  - Results carry ids and labels only, never phone numbers, emails, supporter names or messages.
  - Each search is audited by its length, never its text.
- **Analytics** (§11):
  - Added: `landing_viewed`, `checkout_opened`, `profile_created`, `profile_published`, `payout_requested`, `payout_paid_verified`.
  - The other v1.1 names map to existing events.
  - Same rules as every event: anonymous, and off in production until D-07.

Plan: `docs/superpowers/plans/2026-10-24-pr013-product-gaps.md`. Migrations 0032–0037, all additive (0037 adds search indexes; on a large table they briefly block writes while building). The new contract fields are optional, so the web keeps working while it talks to an older API.

## Evidence

| Check                                  | Result                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Format, lint, typecheck                | `pnpm format:check`, `pnpm lint`, `pnpm typecheck`: all exit 0                                            |
| Unit tests                             | 188/188                                                                                                   |
| Integration                            | 343/343                                                                                                   |
| End-to-end                             | 67/67 (includes the new `gaps.spec`)                                                                      |
| `pnpm audit --prod --audit-level=high` | No known vulnerabilities                                                                                  |
| API image (`deploy/Dockerfile`)        | Builds. Inside it, the API's own `import sharp` loads, and a photo re-encodes to a 512×512 WebP on Alpine |

New tests:

- integration: `profile-reports` (3), `avatars` (4), `avatars-limit` (1), `tip-search` (3), `notification-prefs` (2), `ops-search` (3), `analytics-v11` (3);
- web unit: `avatar-source`, `shrink-photo`;
- `gaps.spec` end-to-end (2 flows, with axe checks).

## Final review

A fresh reviewer read the branch. It found 5 Important and 13 Minor findings; all were fixed or answered, with a test that failed first where one is possible.

**Important:**

1. A photo URL was reused after removing a photo, so a cached copy of the removed photo could come back. Fixed: a per-page version that only goes up.
2. Uploads had no rate or concurrency limit, and the image library had no timeout. Fixed: 20 an hour, two at a time per process, 5 seconds each, 25 MP.
3. Large phone photos timed out on slow mobile uploads. Fixed: the browser shrinks photos to 1,024 px first.
4. Tip search could rebuild the whole provider reference one guess at a time. Fixed: recipients match only within the 6 characters they are shown; staff match a whole reference or that exact ending.
5. Admin search scanned whole tables. Fixed: indexed lookups per kind (checked with `EXPLAIN`), and a 3-second limit.

**Minor:**

- A publish can't fail on the analytics step.
- The worker's analytics write is guarded.
- First publish is remembered on the page, so the analytics purge can't reset it.
- Page reports take an advisory lock instead of locking the page row (eight simultaneous reports still open one issue), and are kept 180 days.
- Photos are cached an hour at most.
- Tests added for paused pages and for deleting the account.
- Status messages are announced reliably; focus moves to the report confirmation; admin search announces only its count.
- Search results open the admin Pages lookup.
- The photo section and the search box are hidden from an older API.
- A misplaced comment fixed.
- The lockfile change reduced to `sharp`.
- `failOn` is explained in a comment.

**Not done:** linking an admin search result to its open issue (the issues inbox already lists them).

## Not done here

- **Documents (PR-014):** access-control matrix, threat model, state flows, test plan.
- **Waiting on decisions:** real provider, refunds and disputes, payout accounts, KYC (D-03 to D-06); real email and SMS (D-11); bot protection (a captcha service).
