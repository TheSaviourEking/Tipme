# Payment provider switching from the admin screen

**Status:** design, revised with the product owner's answers (30 October 2026), awaiting approval
**Builds on:** `2026-10-30-mail-platform-design.md` §5 and §7 (the shared `provider_settings`, `provider_tests`, provider overrides, `/ops/providers` page and `providers.manage` permission). Built after the mail platform.
**Decision record to write:** ADR-0018 (payment provider routing, overrides and staged switching).

**(owner)** marks what the product owner decided; **(design call)** marks what this document chose and the owner can overturn while reviewing.

## 1. Intent

The owner wants admin control over payment providers, like mail **(owner)**:

- **One system provider for everyone.** A switch moves every recipient to the new provider **(owner)**.
- **Per-account overrides.** Admins can set particular accounts to a different provider from the system one **(owner)**.
- **Proven before it counts.** A switch shows "switching in progress" for a period, until TipMe has confirmed the new provider works reliably. Only then does every payment go through it **(owner)**.

Payments carry stakes mail doesn't: money, per-recipient provider accounts, webhooks that must be verified, and a live gate that no screen may bypass.

## 2. Goals, non-goals, anti-goals

**Goals**

1. Providers are configured on the server (keys). The system payment provider is chosen in `/ops/providers` and audited.
2. A switch is a **staged process**:
   - a passing test payment;
   - "switching in progress", with the new provider taking a growing share of tips while TipMe measures it;
   - automatic completion once the reliability criteria are met;
   - automatic pause, with traffic back on the old provider, if they're broken.
3. Admins can override the provider per account, and overrides are respected throughout.
4. Staff see the impact before and during a switch: recipients ready on the new provider, recipients still to set up, and live reliability numbers.
5. Recipients who need to set up an account with the new provider are told clearly, both in the app (the attention notice and checklist from PR #29) and by email (`payment_provider_setup_needed`, an `account` email).
6. Checkout, onboarding, the public page's "accepting tips", reconciliation and the worker all route through a provider registry instead of `if (provider === 'bachs')` branches.

**Non-goals**

- Live (real-money) providers. Nothing here can select a live provider until `docs/00-DECISIONS.md` D-01–D-07 are approved and ADR-0004's live gate is recorded. Only `mock` (never in production) and `bachs-sandbox` exist today.
- Moving existing payments, payouts, refunds or provider accounts between providers. They keep the provider that created them (ADR-0004 §6).
- Adding a second real payment provider. This builds the switch, not a new adapter.

**Anti-goals**

- Every payment moved to a provider that hasn't proven it works.
- A switch that silently leaves pages unable to take tips. Every page that would stop is counted, shown and warned about first.
- A switch that reroutes reconciliation, webhooks or payouts of existing payments.
- Any path where a client or staff member asserts a payment outcome. Tests and reliability counts use only the provider's signed webhooks plus server-to-server verification, the same rules as real tips.

## 3. Routing model

**The system provider** (`provider_settings`, `kind = 'payment'`) is one provider, `stable`, or a switch in progress from A to B (`switching`).

**Account overrides** (`provider_overrides`, shared with mail: `kind`, `user_id`, `provider`, `set_by`, `reason`, `created_at`):

- An admin pins a recipient to a provider, e.g. a recipient Bachs can't onboard, or an early tester of the new provider.
- An override always wins, including during a switch.
- Overrides are listed on the Providers page and on the account's ops view, and can be removed.
- Every change is audited (`payment_provider.override_set` and `payment_provider.override_removed`).

**Route for a new tip:**

1. **Override.** If the recipient has an override, use that provider. If the account isn't ready there, the page isn't accepting tips (the override is deliberate).
2. **Stable.** Use the system provider if the recipient is ready on it; otherwise not accepting tips (`PAYMENT_ACCOUNT_REQUIRED`, as today).
3. **Switching from A to B.**
   - If the recipient is ready on B **and** the tip falls inside the current ramp share (§5), use B.
   - Otherwise, if ready on A, use A.
   - Otherwise, if ready on B, use B (the only way to take the tip).
   - Otherwise, not accepting tips.
     The share is decided by a stable hash of the tip intent id, so retrying the same intent never changes provider.

**Pinned to its provider for life:** an attempt, its reconciliation, refunds, disputes and payouts of money it collected (the existing `collectedElsewhere` rule).

**Onboarding** ("Set up payments") always uses the recipient's override, or else the system provider. During a switch, that means B.

**Public page:** says "accepting tips" when any route above exists. **Dashboard:** shows the account per provider, and flags "set up with <B>" during a switch.

`mock` needs no recipient account, so it's always ready.

## 4. The test payment (before a switch can start)

**Purpose:** prove keys, checkout, webhook signing, server verification and fee handling together for the candidate provider.

1. Staff click **Test payment** for a provider and give a reason. TipMe creates a test tip of ₦100 to the standing test page (`@release_bachs` today, set with `PAYMENT_TEST_HANDLE`) **(design call; amount and page not yet confirmed by the owner)**.
   - It's routed to that provider regardless of the system provider.
   - It's marked as a test: excluded from analytics, reports, moments, rewards and recipient notifications, like rehearsal tips.
   - It's recorded in `provider_tests`.
2. The page shows the provider's checkout link. Staff complete it with the provider's sandbox test card.
3. **The test passes only when all of these hold:**
   - the provider's **signed webhook** arrived and was verified;
   - the server-to-server verification agrees (amount, currency, fee bearer, platform fee equal to the quote);
   - the tip reached `SUCCEEDED`.
     A pass seen only through the reconcile fallback is "passed without webhook", and it doesn't allow a switch **(design call)**.
4. **Failure** is shown with its reason: checkout refused, no webhook within 15 minutes, signature failed, or amount or fee mismatch. Nothing is faked; the test tip follows normal state rules.
5. **The mock provider's test** is its pretend checkout, allowed outside production only.

## 5. Staged switching ("switching in progress")

**Starting.** A switch from A to B needs:

- the `providers.manage` permission and a reason;
- a passing test on B within 24 hours;
- an impact preview acknowledged by staff:
  - recipients ready on B;
  - recipients ready only on A, who must set up on B before the switch completes;
  - recipients with overrides;
  - open unresolved attempts on A.

Starting is audited (`payment_provider.switch_started`).

**While switching, these happen together:**

- **Ramp.** B's share of eligible tips (recipients ready on both) goes **10% → 50% → 100%**. Each step needs its stage criteria met, and the share never moves without them.
- **Recipient setup.** Recipients ready only on A get an attention notice in the app (the PR #29 pattern: badge, dashboard notice and checklist item) and the `payment_provider_setup_needed` email, with a reminder after 3 days. Their tips keep going through A until they're ready on B or the switch completes.
- **Live measurement of B, from verified data only:**
  - payments started on B;
  - start rejections and unknown outcomes;
  - verified successes, and how many arrived by signed webhook versus reconcile;
  - median time from checkout to verified;
  - amount and fee mismatches;
  - webhook signature failures;
  - stuck attempts.

**Reliability criteria** (defaults, editable on the Providers page with a reason, and audited) **(design call)**:

| Gate                                                         | Default                  |
| ------------------------------------------------------------ | ------------------------ |
| Minimum time in each ramp stage                              | 24 hours                 |
| Verified successful payments on B per stage                  | at least 20 (staging: 3) |
| Of B's verified successes, share confirmed by signed webhook | ≥ 95%                    |
| Amount or fee mismatches on B                                | 0                        |
| Start rejections plus unknown outcomes on B                  | ≤ 2% of B's attempts     |
| Webhook signature failures for B                             | 0 (any is investigated)  |
| B attempts stuck past 30 minutes                             | 0                        |

**Completion.** When the 100% stage passes its criteria, and either every recipient is ready on B or staff confirm the remaining count (those pages will stop accepting tips unless they get an override), the switch **completes automatically**:

- B becomes the stable system provider;
- every new tip without an override goes through B;
- A takes no new tips, though its existing payments still reconcile and its webhooks are still accepted.

Completion is audited (`payment_provider.switch_completed`), and staff get a notice.

**Automatic pause.** If any gate is broken at any stage (a mismatch, signature failures, a rejection rate above the limit, or stuck attempts):

- the switch **pauses**: new tips route as if A were stable, except for recipients only ready on B;
- a `payment_provider_switch_paused` money issue opens in the ops inbox, giving the failing gate;
- staff can resume, which restarts the current stage's clock, or abort.

**Abort.** Staff can abort at any point. Traffic goes back to A, and nothing already collected through B moves. Audited.

**What staff see:** a "Switching to B — stage 2 of 3 (50%)" banner across the ops area, each gate with its current value and pass or fail, time left in the stage, recipients still to set up, and a button to pause or abort.

## 6. Server changes

- **Configuration.**
  - `PAYMENT_PROVIDER` becomes `PAYMENT_PROVIDERS` (a comma list of configured providers, e.g. `mock,bachs-sandbox`) plus `PAYMENT_DEFAULT_PROVIDER` (the system provider until staff choose one).
  - The old variable stays accepted for one release, with a deprecation log **(design call)**.
  - Production refuses `mock`. API and worker validate the same way.
- **Provider registry:** `registry.get(name)` and `registry.configured()`. Checkout, onboarding, ops actions, webhooks and the worker's reconcile all use it. The Bachs-specific checkout branch becomes the adapter path.
- **Routing:** `routeTip(db, { profileId, intentId, now })` returns `{ provider, accountReference? } | null` (§3).
- **Data:**
  - `provider_settings` (payment row): `state` (`stable | switching | paused`), `from_provider`, `to_provider`, `stage`, `stage_started_at`, `criteria` (jsonb, the gate values).
  - `provider_overrides`.
  - `provider_tests` with `kind = 'payment'` and `tip_id`.
  - `provider_switch_events`: an append-only stage, pause, resume, complete and abort history.
  - The test tip reuses the rehearsal exclusion, or gets an `is_provider_test` flag **(design call; the builder picks after reading how rehearsal tips are excluded)**.
- **Worker:** a `provider-switch` job every minute evaluates the gates from verified attempt data, then advances, pauses or completes the switch transactionally (audited, idempotent). Reconcile and expiry already route by each attempt's stored provider; the worker starts every configured provider's verifier.
- **Issues:** a new kind, `payment_provider_switch_paused` (money severity).

## 7. Ops page — payment section

`/ops/providers` gets a "Payments" section:

- configured providers, each with live or sandbox status, readiness counts and last test;
- the system provider and its state;
- the switch panel (§5);
- overrides, with add and remove;
- webhook failures in the last 24 hours.

The actions are: Test payment, Start switch, Pause, Resume, Abort, Add override and Remove override. Each one is confirmed in a dialog showing its impact.

## 8. Testing

- **Routing:**
  - an override wins (including during a switch);
  - stable, ready and not ready;
  - switching: in share and ready on B, out of share, ready only on A, ready only on B, ready on neither;
  - the same intent always takes the same route;
  - mock is always ready;
  - existing attempts stay pinned.
- **Switch state machine:**
  - can't start without a passing test, and an expired test or "passed without webhook" is refused;
  - each gate holds a stage back;
  - stages advance only when the criteria are met;
  - a broken gate pauses the switch and opens an issue;
  - resume restarts the clock;
  - abort restores A;
  - completion requires the remaining-recipients confirmation;
  - every transition is audited and idempotent (the job run twice changes nothing).
- **Gates use verified data only:** a reconcile-only success counts toward successes but not toward the webhook share; a client redirect never counts.
- **Recipient setup notices:** shown during a switch to recipients ready only on A, cleared once they're ready on B; the email is sent once, with one reminder.
- **Live gate:** a live provider can't be tested, switched to or overridden to. Mock is refused in production.
- **Config:** the old `PAYMENT_PROVIDER` is accepted with a warning; incomplete provider config fails startup.
- **E2E:** on a local stack, a mock test payment, then a switch where gates are met with short test criteria, then completion. A Bachs sandbox test payment is a manual staging check with the sandbox test card, recorded in the PR.

## 9. Delivery order

1. Registry plus routing (§3, §6) and overrides, with no behaviour change while one provider is configured.
2. The test payment flow.
3. The switch state machine, gates job, pause issue and audit.
4. Recipient setup notices and email.
5. The ops page section, ADR-0018, a runbook (`docs/runbooks/payment-provider-switching.md`) and the decision-log note.

## 10. Open question for the owner

1. **P2 — test amount:** ₦100 to `@release_bachs`, completed by staff with the sandbox test card? (Current design call.)
