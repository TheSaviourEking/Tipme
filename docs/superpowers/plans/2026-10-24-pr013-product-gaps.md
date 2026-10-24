# PR-013 Product gaps — implementation plan

**Goal:** close the PRD v1.1 gaps that need no outside decision:
- reporting impersonation;
- profile photos;
- tip search;
- notification preferences;
- admin search;
- the missing analytics events.

Pretend money only.

**Source:** PRD v1.1:
- FR-01 ("prevent impersonation with reporting and review");
- FR-05 ("searchable transaction history", "basic notification preferences");
- FR-09 ("role-controlled search across accounts, payment intents, ledger entries, payout attempts");
- §11 event taxonomy;
- §9 ("object storage for media"; here, Postgres; see T2).

The user's instruction (24 Oct 2026): "fix what's missing".

## Global constraints

- **Personal data:** none of the new features stores IP addresses, user agents or free text from strangers. Reports carry a reason from a fixed list only.
- **Admin access:** every admin read of personal data goes through a named permission and is audited.
- **Photos:** stored only after they are decoded and re-encoded on the server. EXIF and all other metadata are removed (location privacy).
- **Contracts:** the web deploys before the API, so new contract fields are optional.
- **Migrations:** they only add things (expand/contract).

## Tasks

- **T1 Reporting a page (impersonation, scam, abuse).**
  - `POST /v1/profiles/:handle/report` with `{ reason: 'impersonation' | 'scam' | 'abusive' | 'other' }`.
    - Public, rate-limited (bucket `reports`), strict schema.
    - It always answers 202 and reveals nothing.
  - Stored in `profile_reports` (profile, reason, minute bucket).
    - The first report opens the issue `profile_reported` (severity account, deduplication key per page).
    - Later reports add to its count.
    - Staff review it in the issues inbox and can pause the page (existing action).
  - Web: "Report this page" on the public page, with a reason form and a confirmation.
- **T2 Profile photos.**
  - `PUT /v1/me/avatar`: raw `image/jpeg | image/png | image/webp` body, at most 5 MB.
    - It is decoded and re-encoded with `sharp` to a 512×512 WebP at quality 80, with no metadata.
    - Anything that isn't a decodable image is refused with `INVALID_IMAGE`.
  - `DELETE /v1/me/avatar` removes it.
  - Storage: `profile_avatars` (profile, version, bytes). Postgres was chosen over object storage because photos are small (about 30 KB), are then covered by the backups and point-in-time recovery, and need no new service. Moving to object storage later is a migration, recorded as a ruling.
  - Served at `GET /v1/avatars/:profileId/:version.webp`, with immutable caching and `nosniff`. Only for pages that are live and not suspended; anything else is 404.
  - `avatarPath` points at it. The web prefixes API paths with the API origin.
  - Settings: upload, preview and remove. The alt text names the person.
- **T3 Tip search.**
  - `GET /v1/me/tips?q=` matches the supporter's name (case-insensitive), the end of the reference, or an exact amount ("2000" or "2,000").
  - Only within the recipient's own tips, combined with the status filter.
  - Web: a search box with a debounce, and empty states.
- **T4 Notification preferences.**
  - `GET` and `PUT /v1/me/notification-preferences` with `{ tipEmails, weeklyReports, milestones }`, all `true` by default.
  - Stored as profile columns.
  - Effects:
    - `tipEmails: false` skips the email; the in-app notice stays.
    - `weeklyReports: false` skips the "your weekly report is ready" notice (the report itself is still made).
    - `milestones: false` skips milestone notices. The reward itself still applies.
  - Web: a Settings section with three checkboxes.
- **T5 Admin search.**
  - `GET /v1/ops/search?q=` with the new permission `search.view` (Owners have it).
  - It finds:
    - pages by handle or name (old handles too);
    - tips, payouts and ledger transactions by their id or the end of a provider reference.
  - Results carry ids and short labels only, never phone numbers, emails or messages.
  - Every search is audited, with the length of the query rather than the query itself.
  - Web: `/ops/search`, linking to the page lookup, and to the issue when one exists.
- **T6 Analytics (PRD v1.1 §11).** The v1.1 names that are missing, under the same rules (anonymous, GPC/DNT honoured, off in production until D-07):
  - **Browser events:** `landing_viewed`, `checkout_opened` (the mock checkout page).
  - **Server events:**
    - `profile_created` (handle claimed);
    - `profile_published` (first time live);
    - `payout_requested`;
    - `payout_paid_verified` (from reconciliation).
  - **Already covered under existing names:** `tip_page_viewed` = `profile_viewed`, `tip_started` = `payment_started`, `tip_paid_verified` = `tip_completed`, `tip_failed` = `payment_failed`. The mapping is documented, and nothing is renamed, so that history is kept.
- **T7 Docs and verification.**
  - Decision-register notes, register entry for `sharp`, runbook (reported pages), `PR-013-VERIFICATION`.
  - Full gate, a fresh review and one fix pass.

## Review focus

1. A report or search endpoint used to learn private data, or to spam the inbox.
2. An uploaded file that isn't an image: a script, an SVG, a polyglot, or an oversized or decompression-bomb image.
3. A photo of a hidden, suspended or deleted page still being served.
4. Turning preferences off stopping anything money- or security-related (sign-in codes, recovery warnings).
5. Admin search returning personal data, or working without the permission or the audit entry.
