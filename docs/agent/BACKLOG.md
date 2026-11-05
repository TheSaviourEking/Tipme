# Backlog

Owner-approved work that has not started. Design comes first, on the design canvas; then a plan; then a build. Newest first.

## Changelog, what's new, and role-based data (owner, 5 November 2026)

One system, three faces:

1. **Changelog in the admin dashboard.** The full list of changes is visible in /ops: what shipped, when, and which PR.
2. **What's new for users.** When an update ships, users see what it brings, written for them. Use the same entries, filtered to the ones marked user-facing.
3. **Roles and data.** Some staff should see certain data only in part, masked rather than in full, depending on their role. Staff with the right permission can reward users; the domain already has cash bonuses and fee-free credits. Permissions live in `packages/contracts/src/ops-catalogue.ts`.

Open questions for the design:

- who writes user-facing entries;
- which fields each role sees masked;
- the reward limits and whether a second person must approve them.

## Approved, still to build

- **States:** batches B to I of `docs/superpowers/plans/2026-11-05-states.md`. PR A is waiting to be pushed.
- **Make it yours:** PR B (the Pro starting amount) and PR D (pinned note and accent colour), from `docs/superpowers/plans/2026-11-05-make-it-yours.md`.
- **Username reservation:** PR 2 (take-backs and their emails) and PR 3.
- **Live updates:** PR 2 (plan, withdrawals, banners) and PR 3 (admin).
- **Animated covers:** finish and merge.
- **Pro billing:** blocked until there is sandbox evidence and the owner signs off the ledger accounts.
- **Bank picker, option B (account number first):** waits until the payment partner confirms its codes are CBN codes.

## Waiting on owner decisions (boards on the design canvas)

- Withdraw redesign, plus the rest of the screen audit.
- Sign-up celebration.
- Emails.
- Tip form.
- Link previews and icons.
- Coming-soon page and its fixed launch date.
- QR studio and printing.
- Admin area restyle.
- Pro additions: repeat supporters, priority support, attribution (D-07), the recap, and profile sections.
- Dashboard: left menu or top tabs.
- Connection-failure wording.
- Sign-in "couldn't reach" fix: the edge proxy's logs, HTTP/3, and a retry.
- A staff refund action for short bank transfers.

## Later review

- Tip goals and campaigns: check the payment partner and the rules first.
