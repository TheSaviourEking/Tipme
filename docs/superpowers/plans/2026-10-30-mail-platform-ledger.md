# Mail platform execution ledger (copied from .superpowers/sdd/2026-10-30-mail-platform/progress.md, 31 Oct 2026)

Every ruling, disclosure and deferred minor from executing `2026-10-30-mail-platform.md` (Tasks 1–24, PRs #45–#52 and #59). Kept in the repository so a new agent can read it; the working copy lives in the gitignored `.superpowers/` folder.

Spec: docs/superpowers/specs/2026-10-30-mail-platform-design.md (approved 30 Oct 2026)

## Pre-flight (shared interfaces)

- T1→T7 MailProvider: T7 adds optional prepareWebhook. Ruling: declare `prepareWebhook?(rawBody: Buffer): Promise<void>` in T1 already — avoids reopening T1's interface and conformance kit — cost if wrong: one unused optional method.
- T2→T3 MAIL_TYPES/schema consumed by enqueueMail: consistent.
- T3→T4/T5/T8/T10+ MailSealing {key, hmacKey}: consistent.
- T3 recordMailEvent(type, category) → T8 applyMailProviderEvent, T13 analytics (MailKind subset of event kinds): consistent; daily stats keyed by event kind.
- T5 resolveMailProvider/activeProvider/overrideFor → T10 activeMailProvider/mailOverrideFor: consistent.
- T2 MailContext.unsubscribeUrl null → T24 sets it: consistent.
- T8 adds mail_message_events.address_hmac (migration in T8): consumed only by T8.
- T16 CodePurpose extends T20 ('recovery_email','recovery'): consistent.
  Task 1: Ruling: conformance factory builds its own fake transport (harness.respond) instead of receiving one; each adapter states staleAfterMs (SES 1h, ZeptoMail 5m) — same coverage, simpler adapters — cost if wrong: harness reshape in T6/T7.
  Task 1: Ruling: conformance kit exported as @tipme/mail/conformance, not from the main entry — keeps node:assert out of app imports — cost if wrong: none.
  Task 1: complete (commits 35f8e62..d8e9164, tests: node --test packages/mail/test/mock.test.mjs → ℹ duration_ms 67.034416)
  Task 2: Ruling: MailType carries `sample` and `tracking` fields (plan had module-level samples and category-only tracking) — provider_test needs tracking off while being 'account'; samples on the type let the registry test loop them — cost if wrong: none.
  Task 2: complete (commits d8e9164..071576a, tests: node --test packages/mail/test/templates.test.mjs packages/mail/test/mock.test.mjs → ℹ duration_ms 136.275958)
  Task 3: Ruling: normaliseEmail/maskEmail moved to operations/email-address.ts (re-exported from email.ts) — mail-queue and email.ts would otherwise import each other — cost if wrong: none.
  Task 3: Ruling: mailSealing(key) derives hmacKey with HKDF('mail-address') from MAIL_SEAL_KEY — one secret, as the plan's MailSealing comment says — cost if wrong: rotating the seal key also rotates suppression hashes.
  Task 3: complete (commits 071576a..f46e709, tests: node --test packages/database/test/integration/mail-queue.test.mjs → ℹ duration_ms 5285.106834)
  Task 4: Ruling: sealing is passed inside each operation's input object ({ sealing, ... }), not as a positional arg — fewer call-site changes, same contract — cost if wrong: none.
  Task 4: Ruling: MAIL_SEAL_KEY config (API+worker, required, 32 bytes) and its wiring (CI compose check, e2e, integration stack, staging compose/env example, staging-local) moved from Task 5 into Task 4 — Task 4 can't compile without it — cost if wrong: none. NOTE for PR 1: staging needs MAIL_SEAL_KEY in /srv/tipme/staging.env before the deploy, or compose refuses to start.
  Task 4: Ruling: tip email's '(Pretend payment…)' line now depends on PAYMENT_PROVIDER === 'mock' (was unconditional) — on Bachs sandbox the payment is a real sandbox charge — cost if wrong: copy only.
  Task 4: Known: integration test 'email is verified by a link, then phone recovery works through it' reads the pretend inbox over HTTP; it passes only once Task 5 delivers mail. Re-check in Task 5.
  Task 4: complete (commits f46e709..5773c5e, tests: node --test --test-concurrency=1 packages/database/test/integration/notifications.test.mjs packages/database/test/integration/reports.test.mjs packages/database/test/integration/staff.test.mjs tests/integration/notification-prefs.test.mjs tests/integration/worker-lifecycle.test.mjs apps/worker/test/config.test.mjs apps/api/test/config.test.mjs → ℹ duration_ms 22654.296166)
  Task 5: Ruling: claimDueMail takes the sealing key (claimDueMail(db, sealing, input)) — the plan's signature could not open the address — cost if wrong: none.
  Task 5: Ruling: the delivery pass deliverDueMail lives in @tipme/database (with pretendMailSink); the worker loop only schedules it — testable against Postgres without the worker, and the worker needs no Drizzle — cost if wrong: none.
  Task 5: Ruling: the API reads only MAIL_DEFAULT_PROVIDER (pretend inbox + production rule); sender settings are worker-only — the staging 'no silent defaults' test requires compose to pass every setting a service reads — cost if wrong: re-add when the API sends.
  Task 5: Ruling: non-mock MAIL_DEFAULT_PROVIDER is refused ('provider not configured') until Task 9 configures real providers — cost if wrong: none.
  Task 5: Ruling: e2e not run locally — port 4100 is held by another session's stack (pid 66760, not ours to stop); CI runs e2e on the PR — cost if wrong: an e2e regression found in CI instead of locally.
  Task 5: complete (commits 5773c5e..6fcd088, tests: node --test --test-concurrency=1 packages/database/test/integration/mail-delivery.test.mjs packages/database/test/integration/mail-queue.test.mjs tests/integration/notifications-api.test.mjs apps/worker/test/config.test.mjs apps/api/test/config.test.mjs apps/api/test/webhook-config.test.mjs → ℹ duration_ms 13318.486833)
  Task 6: Ruling: ZeptoMail webhook JSON nesting (event_message[].email_info / event_data[].details[], webhook_request_id) and the click URL field (clicked_link|link|url) are inferred from the field list in ZeptoMail's docs (no full sample published); parsing is defensive and unknown shapes yield no events — must be confirmed against a real staging webhook in Part 8's smoke test — cost if wrong: bounces/opens from ZeptoMail not recorded until the parser is adjusted.
  Task 6: Ruling: ZeptoMail status() returns {sandbox:null} — it has no account-status API; a confirmed test is the evidence — cost if wrong: none.
  Task 6: complete (commits 6fcd088..b9a2ba0, tests: node --test packages/mail/test/zeptomail.test.mjs → ℹ duration_ms 203.392958)
  Task 7: Ruling: SES Send/Reject/DeliveryDelay/RenderingFailure notifications are accepted and ignored (TipMe records sends itself) — cost if wrong: a rendering failure at SES shows only as no delivery.
  Task 7: complete (commits b9a2ba0..669e0f1, tests: node --test packages/mail/test/ses.test.mjs packages/mail/test/zeptomail.test.mjs packages/mail/test/templates.test.mjs packages/mail/test/mock.test.mjs → ℹ duration_ms 258.980834)
  PR1 review (fresh reviewer, opus): Important 1 resend when recording fails after send; Important 2 stale-worker writes unguarded (double send); Important 3 real callers don't pass expiresAt; Minor 1 re-graded Important (one unreadable row poisons every pass, codes included).
  PR1: minor (deferred): expiry checked against batch start time, not per-mail time.
  PR1: minor (deferred): worker WEB_ORIGIN accepts http/localhost in production (compose guards with :?).
  PR1: minor (deferred): wipeExpiredMailContent has no partial index on final_at WHERE to_sealed IS NOT NULL.
  PR1: minor (deferred): requeueStuckMail never counts an attempt (a mail that kills the worker retries forever).
  PR1: minor (deferred): notifications test no longer asserts the rendered link contains /verify-email#v= from WEB_ORIGIN.
  PR1: Final: fixed resend after a successful send — 'a mail the provider accepted is never sent again when what follows the send fails' RED→GREEN, integration 416/428 (12 macOS backup).
  PR1: Final: fixed stale-worker writes — 'a worker whose claim was taken over cannot overwrite the new outcome' RED→GREEN.
  PR1: Final: fixed unreadable row poisoning the pass — 'one unreadable mail fails on its own…' RED→GREEN.
  PR1: Final: fixed links outliving their email — notifications.test expires_at assertions RED→GREEN.
  Task 8: complete (commits 669e0f1..303226a, tests: node --test --test-concurrency=1 packages/database/test/integration/mail-events.test.mjs tests/integration/mail-webhook-api.test.mjs scripts/generate-docs.test.mjs → ℹ duration_ms 7101.909625)
  Task 9: Ruling: settings shape and rules live once in @tipme/mail (mailSettingsShape, checkMailSettings), used by both configs — avoids two copies drifting — cost if wrong: none.
  Task 9: complete (commits 303226a..5c4088b, tests: node --test packages/mail/test/settings.test.mjs apps/worker/test/config.test.mjs apps/api/test/config.test.mjs apps/api/test/webhook-config.test.mjs scripts/deploy-scripts.test.mjs → ℹ duration_ms 16014.390292)
  Task 10: Ruling: migration 0046 also grants the new permissions to an existing owner role (ensureOwnerRole only runs on grant) — otherwise staging's owner couldn't use the page — cost if wrong: none.
  Task 10: Ruling: worker falls back to MAIL_DEFAULT_PROVIDER if the chosen provider's keys were removed — no total mail outage from a config change — cost if wrong: mail silently goes via the default; visible on the provider counts.
  Task 10: Note: mail_provider.test_confirmed audit has no permission (any ops session with the link).
  Task 10: complete (commits 5c4088b..5ba6b9b, tests: /private/tmp/claude-502/-Users-dev-Workspace-SynqHQ-Tipme/579273e2-08df-4bbd-a0e2-911e1324953c/scratchpad/itest.sh packages/database/test/integration/provider-admin.test.mjs packages/mail/test/settings.test.mjs → ℹ duration_ms 6149.159291)
  PR2 review: Critical: raw body not captured for text/plain and form webhooks; Critical: Zepto + decoding. Important: missing webhook id collapses events; bounce during sending breaks send record & retention; transient cert failure loses event; unbounded cert fetch/cache; conformance kit self-consistent only.
  PR2: minor (deferred): valid-UUID reference matching nothing doesn't fall back to provider id; reference match ignores provider.
  PR2: minor (deferred): concurrent soft bounces can undercount until the next bounce.
  PR2: minor (deferred): future occurredAt not clamped (soft-bounce window, daily stats date).
  PR2: minor (deferred): optional SES keys / bounce address without their provider are ignored silently.
  PR2: Ruling: API holds send credentials (needed for provider status in ops) although spec §4.5 says worker — status needs the same keys, and splitting them adds config — cost if wrong: a compromised API can send mail; revisit with a read-only status key.
  PR2: Final: fixed all Critical/Important — mail-webhook-http tests, zeptomail form-encoding & webhook-id tests, mail-events race tests, ses cert-path test, 503 test all RED→GREEN; integration 437/449 (12 macOS backup).
  PR2: Ruling: ZeptoMail signature accepts either reading of '+' (form or literal) because its docs conflict — a match still proves the key — cost if wrong: none; narrow after a real capture.
  Task 11: Ruling: suppression lookup/removal and override removal are POST with a body, overrides accept handle-or-id — addresses stay out of access logs; staff know handles — cost if wrong: none.
  Task 11: complete (commits 5ba6b9b..20ca1ea, tests: /private/tmp/claude-502/-Users-dev-Workspace-SynqHQ-Tipme/579273e2-08df-4bbd-a0e2-911e1324953c/scratchpad/itest.sh tests/integration/ops-providers-api.test.mjs → ℹ duration_ms 4277.328041)
  Task 12: Ruling: e2e spec written but not run locally — port 4100 still held by another session; CI runs it on PR 3 — cost if wrong: found in CI.
  Task 12: Note: tests/integration/handle-renames 'a renamed page…' failed once under parallel load (51 s), passed alone and on the next full run — likely pre-existing timing flake; watch in CI.
  Task 12: complete (commits 20ca1ea..7a0f169, tests: /private/tmp/claude-502/-Users-dev-Workspace-SynqHQ-Tipme/579273e2-08df-4bbd-a0e2-911e1324953c/scratchpad/itest.sh tests/integration/ops-access.test.mjs tests/integration/ops-providers-api.test.mjs → ℹ duration_ms 5457.336792)
  Task 13: complete (commits 7a0f169..9611b25, tests: /private/tmp/claude-502/-Users-dev-Workspace-SynqHQ-Tipme/579273e2-08df-4bbd-a0e2-911e1324953c/scratchpad/itest.sh packages/database/test/integration/mail-analytics.test.mjs → ℹ duration_ms 4759.309334)
  Task 14: complete (commits 9611b25..4d7e856, tests: /private/tmp/claude-502/-Users-dev-Workspace-SynqHQ-Tipme/579273e2-08df-4bbd-a0e2-911e1324953c/scratchpad/itest.sh tests/integration/ops-email-console-api.test.mjs → ℹ duration_ms 2954.323875)
  PR3 review: 7 Important: fragment lost on sign-in; e2e can't pass; provider test suppression-gated & outcomes invisible; audit gaps; suppression lookup unaudited; overrides bypass safeguards; status() unbounded.
  PR3: minor (deferred): confirm page shows same message for network/403/empty token.
  PR3: minor (deferred): Unblock uses the live input, not the looked-up address.
  PR3: minor (deferred): unblock not_found/complaint outcomes treated as success; failed lookup shows nothing.
  PR3: minor (deferred): no busy state on Send test (double submit); startTest not rate limited.
  PR3: minor (deferred): page's failed flag never resets.
  PR3: minor (deferred): chosen provider with removed keys: no card shows Active.
  PR3: minor (deferred): findAccountByHandleOrId handle path doesn't check deletedAt.
  PR3: minor (deferred): ops providers tests call controller directly; add one real-HTTP path.
  PR3: Final: fixed all 7 Important (tests RED→GREEN: provider-admin 16, ops-providers-api 13; e2e rewritten, CI is the evidence).
  PR3: Ruling: pinning requires a confirmed test (same as switching) — a pinned account's security mail goes through it — cost if wrong: one extra test before pinning.
  PR3: Ruling: audit detail goes in the reason text (no structured column) — smallest change; audit readable as-is — cost if wrong: harder to query from/to later.
  Task 15: Ruling: e2e spec not run locally (port 4100 held by another session); CI on PR 4 is the evidence — cost if wrong: found in CI.
  Task 15: Ruling: custom date range and §5 'recent failures' panel: status filter 'failed' in the list serves as recent failures; the API supports range but the page has presets only — cost if wrong: small UI addition.
  Task 15: complete (commits fd8522d..a1a13bf, tests: /private/tmp/claude-502/-Users-dev-Workspace-SynqHQ-Tipme/579273e2-08df-4bbd-a0e2-911e1324953c/scratchpad/itest.sh tests/integration/ops-email-console-api.test.mjs packages/database/test/integration/mail-analytics.test.mjs → ℹ duration_ms 8530.585959)
  Task 16: Ruling: email codes use new tables email_codes / email_code_lockouts; phone tables untouched (plan said generalise to identifier) — no migration risk to the working phone path, phone returns unchanged later — cost if wrong: two parallel code tables.
  Task 16: Ruling: phone sign-in API stays, accepted only while MAIL_DEFAULT_PROVIDER is mock (local, CI, staging until real mail) — hundreds of tests and staging accounts use it; real mail means email only — cost if wrong: phone path must be removed or gated differently before go-live; verify it is off in production.
  Task 16: complete (commits a1a13bf..d02c806, tests: /private/tmp/claude-502/-Users-dev-Workspace-SynqHQ-Tipme/579273e2-08df-4bbd-a0e2-911e1324953c/scratchpad/itest.sh packages/database/test/integration/sign-in-email.test.mjs → ℹ duration_ms 5375.59)
  Task 17: complete (commits d02c806..5ef7d46, tests: /private/tmp/claude-502/-Users-dev-Workspace-SynqHQ-Tipme/579273e2-08df-4bbd-a0e2-911e1324953c/scratchpad/itest.sh tests/integration/auth-email-api.test.mjs → ℹ duration_ms 8061.885167)
  Task 17: Ruling: routes are /v1/me/email/code + /confirm; old link and phone routes return 404 unless MAIL_DEFAULT_PROVIDER is mock (plan said 410) — existing tests and staging accounts keep working until real mail — cost if wrong: small cleanup later.
  PR4 review: Critical: e2e fails (no yesterday mail). Important: export truncates silently; stale responses; export ignores filters; bad range/cursor 500; range uncapped; rates over 100%; partial vs whole period; type filter hides failure-only types; spec items missing; drawer out of view; failed flag races.
  PR4: minor (deferred): cell() neutralises negative numbers; unquoted CR; no CSV BOM; e2e seed race (fixed with the seed rewrite); email.viewed recorded for withheld; export audit omits period; reveal on unknown id audits; snapshot fetch failure says 'contains a code'; series raw vs tile unique; Today chart title promises a line; month-length alignment; list keyed by created_at vs stats by occurred_at; uniqueMessages index (kind, occurred_at, message_id); status filter unindexed.
  PR4: Ruling: partial periods compare like-for-like (this week/month so far vs same number of days before) — a whole-period compare reads -90% on the 3rd — cost if wrong: owner wanted whole-period; one line to change.
  PR4: Ruling: rates are clamped to 100% rather than computed by cohort — deliveries of yesterday's mail can land today; a cohort query costs more — cost if wrong: rates approximate near period edges.
  PR4: Final: fixed Critical and Important; tests written with the fixes in one step, so RED not observed for these (disclosed in PR); analytics+console 27/27; full integration only macOS backup failures.
  Task 18: Ruling: e2e not run locally (port 4100); CI on PR 5 is the evidence — cost if wrong: found in CI.
  Task 18: Ruling: settings phone-change form removed, phone shown read-only until phone codes exist; /recover link removed until Task 22 — cost if wrong: none (API stays for pretend mode).
  Task 18: Note: scripts/release-enrol.mjs still signs in by phone; works only in pretend mode. Must move to email before a real provider is the default on staging — check in Task 26.
  Task 18: complete (commits 7493dd9..4b87511, tests: /private/tmp/claude-502/-Users-dev-Workspace-SynqHQ-Tipme/579273e2-08df-4bbd-a0e2-911e1324953c/scratchpad/itest.sh packages/database/test/integration/sign-in-email.test.mjs tests/integration/auth-email-api.test.mjs → ℹ duration_ms 13694.054583)
  Task 19: complete (commits 4b87511..fcee710, tests: /private/tmp/claude-502/-Users-dev-Workspace-SynqHQ-Tipme/579273e2-08df-4bbd-a0e2-911e1324953c/scratchpad/itest.sh packages/database/test/integration/set-email-script.test.mjs → ℹ duration_ms 1524.173459)
  Task 20: Ruling: 'taken' is reported at confirm, after the code proves the address, not at request (plan's signature returned it at request) — prevents discovering accounts — cost if wrong: one extra step before the refusal.
  Task 20: Ruling: recoveries complete in the worker mail loop's one-minute housekeeping, not a separate BullMQ schedule — simpler, same cadence — cost if wrong: none.
  Task 20: Ruling: new mail types recovery_change_code and recovery_new_email_code added for accurate copy — cost if wrong: none.
  Task 20: complete (commits 7026d4b..8ae3660, tests: /private/tmp/claude-502/-Users-dev-Workspace-SynqHQ-Tipme/579273e2-08df-4bbd-a0e2-911e1324953c/scratchpad/itest.sh packages/database/test/integration/recovery-email.test.mjs → ℹ duration_ms 8083.866459)
  Task 21: Ruling: tests written first but not run before implementing (RED unobserved); staff route in a new OpsAccountRecoveryController rather than OpsActionsController (constructor change would break its tests); routes under /v1/auth/email-recovery/* because /v1/auth/recover/* is the pretend phone flow — cost if wrong: none.
  Task 21: complete (commits 8ae3660..56a1cec, tests: /private/tmp/claude-502/-Users-dev-Workspace-SynqHQ-Tipme/579273e2-08df-4bbd-a0e2-911e1324953c/scratchpad/itest.sh tests/integration/recovery-api.test.mjs → ℹ duration_ms 5111.978209)
  PR5 review: 6 Important: link confirm & phone PUT ungated, link bypasses §8.3; default-provider is wrong switch; anyone can block sign-in (shared quota, failures with no code); stored addresses never purged; settings change traps user; release-enrol breaks at flip.
  PR5: minor (deferred): lockout check before row lock; good code resets attacker failures; double-submit counts a failure; setAccountEmail no notice/sessions/deletedAt; same-address change ends sessions; 23505 race gives 500; email-change code not bound to user; client deviceLabel in notice; emailPublic publishes new address; /verify-email copy; ADR-0017 reference until Part 8; no concurrency tests.
  PR5: Ruling: legacy phone/link routes open only while the ACTIVE mail provider is mock (read from provider_settings), not just the default — one switch, no new flag — cost if wrong: a DB read per legacy request.
  PR5: Ruling: per-address lockout and 3-codes-an-hour stay as spec §8.1, narrowed (per purpose; no failure without a live code). Anonymous requests can still delay someone's sign-in code for up to an hour — OWNER DECISION — cost if wrong: targeted nuisance.
  PR5: Final: fixed 5 of 6 Important, tests RED→GREEN (4 in sign-in-email, legacy-routes in auth-email-api); integration 519/531. #6 release-enrol: deferred to Task 26 with owner decision.
  Task 22: complete (commits 0ba8484..18e4981, tests: pnpm -s --filter @tipme/web test → ℹ duration_ms 438.787334)
  Task 22: Ruling: staff-started moves are finished by the person at /recover via "Enter the code we sent to your new email", which asks for both addresses — the staff endpoint only sends a code and the confirm route needs all three — cost if wrong: one extra form step for a person being helped.
  Task 22: Ruling: e2e recovery.spec.ts not run locally (port 4100 held by another session); CI is the evidence — cost if wrong: a CI fix round.
  PR6 review: fixed C2, I1-I5 (recovery-email.test.mjs, recovery-api.test.mjs, owner-attention.test.mjs RED→GREEN), suite 543/555 (12 macOS backup). C1 fixed by merging the form steps; e2e not run locally.
  PR6: minor (deferred): phone and email notices share one cancel route, so each cancels both.
  PR6: minor (deferred): 403 and staff-account 409 both read "Staff accounts can't be moved this way" on Ops > Pages.
  PR6: minor (deferred): recoveries.manage is only reachable through a role with pages.plan; ops/staff page lacks descriptions for recoveries.manage and providers.manage.
  PR6: minor (deferred): an account granted staff after a recovery code was issued can still continue; completion drops access.
  PR6: minor (deferred): needsRecoveryEmail in the database package is used only by its test; item id and inline form differ from the plan's wording.
  PR6: Ruling: /start stays 202 when rate limited, so copy says "if nothing arrives, try again in an hour" — never revealing which addresses exist outweighs a precise message — cost if wrong: a confused person waits an hour.
  Task 23: Ruling: withdrawal and reversal emails are queued from the outbox event in the worker, not inside recordPayoutOutcome — the outbox row commits with the operation, so a rollback still queues nothing — cost if wrong: the email lags the event by one worker pass.
  Task 23: Ruling: confirmEnrolmentAndOpenGrant sends no staff_access_notice — grantOwner already told them — cost if wrong: one fewer notice.
  Task 23: Ruling: "removed" staff notice is sent only when an email move or recovery drops access, not from dropOpsAccess (runs on every grant, has no address) nor the legacy phone paths — cost if wrong: phone-mode staff (mock provider only) get no removal email.
  Task 23: Ruling: grantOwner's sealing is optional, read from MAIL_SEAL_KEY by the operator command — cost if wrong: a grant from a shell without the key sends no notice.
  Task 23: Ruling: payment_account_action_needed fires on a move to RESTRICTED or a ready account gaining requirements, not during setup — cost if wrong: someone stuck mid-setup gets no email (Task 25's reminder covers them).
  Task 23: Ruling: templates grouped in account-events.ts rather than one file per type, matching account-notices.ts — cost if wrong: one split.
  Task 23: Ruling: notification-prefs test now expects 3 emails for the "loud" account (tip, milestone, weekly) — milestone emails are new behaviour — cost if wrong: none.
  Task 23: disclosure: trigger tests were written before the code but not run before it; RED was not watched. A staff grant's rollback is not tested.
  Task 23: complete (commits 372d434..926c84a, tests: bash /private/tmp/claude-502/-Users-dev-Workspace-SynqHQ-Tipme/579273e2-08df-4bbd-a0e2-911e1324953c/scratchpad/itest.sh packages/database/test/integration/mail-triggers.test.mjs → ℹ duration_ms 5709.74125)
  Task 24: Ruling: the guides (engagement) switch covers engagement mail without a switch of its own; weekly reports and milestones follow their own toggles — two switches for one email would confuse — cost if wrong: someone turning off guides still gets weekly reports until they turn that off too.
  Task 24: Ruling: unsubscribe tokens never expire and name one type — RFC 8058 links must keep working in old emails — cost if wrong: a leaked link can turn off one optional email for one person.
  Task 24: Ruling: GET redirects to a confirm page and only POST changes anything — link scanners — cost if wrong: one extra click.
  Task 24: Ruling: kept the "Notifications" heading and added id="emails" rather than a separate "Emails" card — one place for every switch — cost if wrong: a rename.
  Task 24: complete (commits 926c84a..a7504fe, tests: bash /private/tmp/claude-502/-Users-dev-Workspace-SynqHQ-Tipme/579273e2-08df-4bbd-a0e2-911e1324953c/scratchpad/itest.sh packages/database/test/integration/mail-preferences.test.mjs tests/integration/unsubscribe-api.test.mjs → ℹ duration_ms 3950.880333)
  Owner decision (31 Oct): one sender per kind of email (security, notifications, payments, reports, hello, legal, system; receipts, business, news reserved), names approved; "notifications" means any email notification such as a tip.
  Ruling: the sender isn't stored per message — it follows from the type — cost if wrong: renaming a type's sender later relabels its past mail.
  PR7 review: fixed I1 (payment.reversed routed; domain-events.test.mjs RED→GREEN), I2 (issue before email; worker-domain-events.test.mjs RED→GREEN). Re-graded M1 (false "page is back" email) and M5 (mail after "last email") to Important by effect; fixed with mail-triggers and mail-preferences tests RED→GREEN.
  PR7: minor (deferred): mailForDomainEvent enqueue isn't in one transaction with its queued event (M2).
  PR7: minor (deferred): payment-account dedupe key includes the UTC day, so a second restriction the same day sends nothing (M3).
  PR7: minor (deferred): an over-long milestone title would roll back the moment (M4).
  PR7: minor (deferred): staging preview gate blocks one-click POST from mail apps; .env.example and spec §4.5 still name MAIL_FROM_ADDRESS; API_ORIGIN has no production check or trailing-slash guard (M6).
  PR7: minor (deferred): token signs user and type, not category; footer label "Email settings" opens the turn-off page; guides switch controls nothing until Task 25; setNotificationPrefs writes two tables outside one transaction; key rotation voids old links; token in query string (M7).
  PR7: minor (deferred): repeated "staff access removed" notices after each later email change, since the staff row stays (M8).
