# Bank Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Get paid card's long native bank drop-down with a search-your-bank combobox (option A), and replace the "Check account" button with a name check that runs on its own, once per bank and number (option C).

**Architecture:** Web only, on branch `feat/bank-picker` (worktree `.worktrees/bank-picker`, from `origin/dev` at `d0325dd`). Four pure modules in `apps/web/src/lib`, each tested on its own with `node --test`: aliases, the directory (popular keys, A to Z, "More banks"), search, and the name-check memo. Also a small pure keyboard helper. One client component, `BankPicker`, draws them as a WAI-ARIA combobox and listbox on desktop and as a full-screen sheet on phones. `GetPaidCard` swaps its `<select>` and "Check account" button for the picker and the automatic check. The API, contracts, database, rate limits, email-code and bank-change pause rules are unchanged. The bank list still comes from `GET /v1/payout-banks` as `PayoutBank { code, name }` (`packages/contracts/src/payment-accounts.ts:60`).

**Tech Stack:** Next.js 16 App Router client island (`apps/web`), React 19, `@tipme/ui` (`InputField`, `Button`, `Notice`), plain CSS in `apps/web/src/app/globals.css`, Node test runner (`apps/web/test/*.test.mjs`, loads `.ts` directly), Playwright (`tests/e2e`, projects `desktop` and `mobile` (360px, `@mobile` tag)), axe through `expectAccessible`.

**Spec:** the design board `BankPicker.dc.html` (Task 1 commits it to `docs/design/redesign/boards/BankPicker.dc.html`). Only sections A and C are approved. Section B ("Account number first") is **deferred** until the payment partner confirms its bank codes are CBN codes. Nothing in this plan computes NUBAN check digits or orders banks by account number.

**Not in this plan:**

- Option B, the check-digit shortlist.
- Any server-side memo of name checks. The 10-a-day limit stays enforced by `RateLimitGuard` (`apps/api/src/checkout/rate-limit.guard.ts:40,104-113`). The browser only avoids spending it twice on the same pair.
- Fuzzy or typo matching. The board's phone mock lists Fidelity Bank under "fir". This plan does not, because "Forgiving aliases" is the approved rule and the board's "No bank matches 'gtbnk zz'" state shows that misspellings fall through.

## Decisions this plan implements (owner, recorded in Task 1)

1. Popular banks show as keys only when their code is in the partner's list.
2. Forgiving aliases. The alias list lives in code and is unit-tested.
3. Popular keys first, then A to Z. Microfinance and mortgage banks are grouped under "More banks", classified from their names.
4. Phones get a full-screen sheet with the search field focused.
5. The WAI-ARIA combobox and listbox pattern.
6. The name check fires once a bank is chosen and 10 digits are typed. It never fires again for the same bank-and-number pair. "Check again" shows only after an error.
7. All existing copy is kept, except `get-paid-card.tsx:240`: "The payment provider can’t pay to this account. Please add another." becomes "Our payment partner can’t pay to this account. Please add another."
8. Users never see the provider's name.

## Global Constraints

- **No API, contract, database, migration or provider change.** If a task seems to need one, stop and report back. `payoutBankResolveSchema`, `payoutDestinationUpdateSchema` and `PayoutBank` stay as they are.
- **Rules every option keeps** (board, "Today"): saving needs an emailed 6-digit code (`requestPayoutDestinationCode`, `spendPayoutDestinationCode`). Bank changes pause for 72 hours after a sign-in email change (`BANK_CHANGE_HOLD_MS`, `packages/database/src/operations/payout-destinations.ts:37`), and while that pause stands the card shows no form, so it shows no picker. Only the bank name and the last 4 digits are ever shown.
- **Name-check budget:** never call `POST /v1/me/payout-destination/resolve` with fewer than 10 digits or with no bank chosen. Never call it twice for the same `bankCode:accountNumber` while the card is mounted, including after switching away and back. "Check again" is the only way to repeat a pair, and it shows only after a failed check (anything other than found or not found).
- **Privacy:** the full account number stays in component memory only: never `localStorage`, analytics, logs, URLs or `data-` attributes. The memo's keys contain the number, so they live in a `useRef` and are never rendered.
- **Provider name:** no user-visible string may contain the partner's name. `apps/web/test/no-provider-names.test.mjs` already scans `apps/web/src` and must stay green. Alias targets are bank names, never the partner's.
- **Copy:** keep every existing string in `get-paid-card.tsx` byte for byte (curly apostrophes included), except decision 7. New strings come from the board and are listed in Task 7. Use sentence case and no em dashes.
- **Accessibility:** WCAG 2.2 AA. The combobox pattern follows the APG "editable combobox with list autocomplete". Targets are at least 44px, focus is visible outside the material, forced colours keep every edge and the active option visible, and reduced motion turns the sheet's entrance off (`docs/design/COMPONENT-STANDARDS.md`, `EXPERIENCE-AND-MOTION.md`).
- **No new packages.** The combobox is hand-written. Nothing is added to `docs/third-party-component-register.md`.
- **Brand:** `#7A32F9`, white and black. The board's bank badge tones apply to the nine popular keys only. Their initials must meet 4.5:1 contrast (tested in Task 3). Every other badge is neutral.
- Every web build deletes `apps/web/.next/cache` first (stale CSS on 3 Nov 2026).
- Follow `apps/web/AGENTS.md`: read `docs/design/DESIGN-CONSTITUTION.md`, `REFERENCE-ANATOMY.md`, `RESPONSIVE-COMPOSITION.md` and `VISUAL-QUALITY-GATE.md` before Task 7.

## Review Focus

1. **Name-check budget (decision 6):** count resolve calls in e2e. The count is exactly 1 per new pair, 0 for a repeated pair, 0 below 10 digits, and 0 with no bank. "Check again" appears only after a failure. Tests: Task 6 (unit) and Task 9 (`bank-picker.spec.ts`, "name check" tests).
2. **Stale answers:** the user changes the number while a check is in flight. The late answer is stored for its own pair and never shown against the new one. Tests: Task 6 `'a late answer is kept for its own pair only'`, and Task 9.
3. **Combobox keyboard and screen reader:** `aria-expanded`, `aria-controls`, `aria-activedescendant`, the live count ("4 banks match"), Esc closes without changing the choice, and the "More banks" row expands without becoming the value. Tests: Task 7.
4. **Phone sheet:** opens with the search focused, traps focus (native `<dialog>` `showModal`, as `ConfirmDialog` does), Esc and ✕ close without changing anything, focus goes back to the Bank field, and it fits 320px. Tests: Task 8.
5. **Popular keys by code only (decision 1):** a popular bank missing from the partner's list never shows a key, even if a similarly named bank is present. Tests: Task 3 and Task 7.
6. **Classification:** popular banks whose names say "Microfinance" or "MFB" (Moniepoint, Kuda) stay in A to Z and never move into "More banks". Test: Task 3.

---

### Task 1: Commit the board and record the decisions

**Files:**

- Create: `docs/design/redesign/boards/BankPicker.dc.html` (copied unchanged from the scratchpad board the owner reviewed)
- Modify: `docs/design/DECISION-LOG.md` (new entry at the top), `docs/agent/ACTIVE_TASK.md` (new entry at the top)

- [ ] **Step 1:** Copy the board, then run `diff` against the source. Expected: no output.
- [ ] **Step 2:** Add `## 2026-11-05 — Bank picker: search your bank (A) and the name check on its own (C)` to `DECISION-LOG.md`, with the eight decisions above in the owner's words, and: "B (account number first) deferred until the payment partner confirms its codes are CBN codes. Presentation only: the bank list, codes, name-check limit, email code and bank-change pause are unchanged. No regulatory or partner approval is implied (`docs/00-DECISIONS.md`)."
- [ ] **Step 3:** Run `pnpm format:check`. Expected: PASS.
- [ ] **Step 4:** Commit: `docs(design): commit the bank picker board and record A + C`.

---

### Task 2: Forgiving aliases

**Files:**

- Create: `apps/web/src/lib/bank-aliases.ts`, `apps/web/test/bank-aliases.test.mjs`

**Interfaces (produces):**

```ts
/** Lowercase, diacritics stripped, "&" → "and", every other non-letter or digit a single space, trimmed. */
export function normalizeBankText(text: string): string;

/** Short names and nicknames people type, each pointing at words that appear in the bank's own name. */
export type BankAlias = {
  readonly aliases: readonly string[];
  readonly names: readonly string[];
};
export const BANK_ALIASES: readonly BankAlias[];

/** True when `query` (normalized) equals one of the bank's aliases, or is a prefix of one with at least 2 characters. */
export function aliasMatches(
  query: string,
  bankName: string,
): 'exact' | 'prefix' | null;
```

`names` are matched as whole words inside the normalized bank name: pad both with spaces and use `includes`. That way `fbn` never reaches "First City Monument Bank". The list, from the board plus obvious gaps:

| aliases                                   | names (any)              |
| ----------------------------------------- | ------------------------ |
| `gtb`, `gtco`, `gt`, `gtbank`, `guaranty` | `guaranty trust`         |
| `fbn`, `firstbank`                        | `first bank`             |
| `uba`                                     | `united bank for africa` |
| `fcmb`                                    | `first city monument`    |
| `stanbic`, `ibtc`                         | `stanbic ibtc`           |
| `opay`, `paycom`                          | `opay`, `paycom`         |
| `moniepoint`, `monie`                     | `moniepoint`             |
| `palmpay`, `palm`                         | `palmpay`, `palm pay`    |
| `kuda`                                    | `kuda`                   |
| `alat`                                    | `wema`                   |
| `eco`                                     | `ecobank`                |

- [ ] **Step 1: Write the failing tests** in `apps/web/test/bank-aliases.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BANK_ALIASES,
  aliasMatches,
  normalizeBankText,
} from '../src/lib/bank-aliases.ts';

test('bank text is compared without case, accents or punctuation', () => {
  assert.equal(normalizeBankText('  Paycom (OPay) Ltd. '), 'paycom opay ltd');
  assert.equal(normalizeBankText('A&B  Bank'), 'a and b bank');
  assert.equal(normalizeBankText('Société Générale'), 'societe generale');
});

test('gtb, gtco and guaranty all find Guaranty Trust Bank', () => {
  for (const q of ['gtb', 'gtco', 'guaranty', 'GTB', 'gt'])
    assert.ok(aliasMatches(normalizeBankText(q), 'Guaranty Trust Bank'), q);
  assert.equal(aliasMatches('gtb', 'Guaranty Trust Bank'), 'exact');
  assert.equal(aliasMatches('gtc', 'Guaranty Trust Bank'), 'prefix');
});

test('fbn finds First Bank and never First City Monument Bank', () => {
  assert.equal(aliasMatches('fbn', 'First Bank of Nigeria'), 'exact');
  assert.equal(aliasMatches('fbn', 'First City Monument Bank'), null);
  assert.equal(aliasMatches('fcmb', 'First City Monument Bank'), 'exact');
});

test('opay finds the bank whatever name the partner gives it', () => {
  assert.equal(aliasMatches('opay', 'Paycom (OPay)'), 'exact');
  assert.equal(aliasMatches('opay', 'OPay Digital Services Limited'), 'exact');
  assert.equal(aliasMatches('palmpay', 'Palm Pay'), 'exact');
  assert.equal(aliasMatches('alat', 'Wema Bank'), 'exact');
});

test('one letter is never an alias match, and unknown words never match', () => {
  assert.equal(aliasMatches('g', 'Guaranty Trust Bank'), null);
  assert.equal(aliasMatches('zz', 'Guaranty Trust Bank'), null);
});

test('the alias list is well formed: lowercase, normalized, no alias used twice', () => {
  const seen = new Set();
  for (const { aliases, names } of BANK_ALIASES) {
    assert.ok(aliases.length > 0 && names.length > 0);
    for (const word of [...aliases, ...names])
      assert.equal(normalizeBankText(word), word, word);
    for (const alias of aliases) {
      assert.ok(!seen.has(alias), `${alias} is listed twice`);
      seen.add(alias);
    }
  }
});
```

- [ ] **Step 2: Run** `pnpm --filter @tipme/web test`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `bank-aliases.ts`. Normalization: `text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()`.
- [ ] **Step 4: Run** the tests again. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(web): bank aliases for the bank search`.

---

### Task 3: The bank directory (popular keys, A to Z, "More banks", badges)

**Files:**

- Create: `apps/web/src/lib/bank-directory.ts`, `apps/web/test/bank-directory.test.mjs`

**Interfaces (consumes):** `PayoutBank` from `@tipme/contracts`, `normalizeBankText` from Task 2.

**Interfaces (produces):**

```ts
export type BankBadge = {
  initials: string;
  tone: string | null;
  ink: '#000000' | '#FFFFFF' | null;
};
export type DirectoryBank = PayoutBank & {
  badge: BankBadge;
  popularLabel: string | null;
};
export type BankDirectory = {
  popular: DirectoryBank[]; // board order, only those whose code is in the list
  all: DirectoryBank[]; // A to Z: commercial banks, wallets, and every popular bank
  more: DirectoryBank[]; // A to Z: microfinance and mortgage banks that are not popular
};
export type PopularBank = {
  label: string;
  initials: string;
  tone: string;
  codes: readonly string[];
};
export const POPULAR_BANKS: readonly PopularBank[];
export function bankKind(name: string): 'bank' | 'microfinance' | 'mortgage';
export function initialsFor(name: string): string;
export function arrangeBanks(banks: readonly PayoutBank[]): BankDirectory;
/** WCAG relative-luminance contrast of two #RRGGBB colours. */
export function contrastRatio(a: string, b: string): number;
```

`POPULAR_BANKS`, in the board's order. Tones are from the board. `codes` lists every code that bank is known by: the CBN 3-digit code, plus the institution codes in common use for the fintechs. **Owner question 1** asks for confirmation against the partner's live list.

| label      | initials | tone      | codes              |
| ---------- | -------- | --------- | ------------------ |
| GTBank     | GT       | `#dd4f05` | `058`              |
| Access     | AC       | `#e0761c` | `044`              |
| Zenith     | ZB       | `#d1122a` | `057`              |
| UBA        | UB       | `#c8102e` | `033`              |
| First Bank | FB       | `#003b65` | `011`              |
| OPay       | OP       | `#1dcf9f` | `999992`, `100004` |
| Moniepoint | MP       | `#0357ee` | `50515`, `090405`  |
| PalmPay    | PP       | `#6b2ff5` | `999991`, `100033` |
| Kuda       | KU       | `#40196d` | `50211`, `090267`  |

Rules:

- `bankKind`: `microfinance` if the normalized name contains the word `microfinance`, `micro finance` or `mfb`. Otherwise `mortgage` if it contains the word `mortgage`. Otherwise `bank`. Whole words only, so "Finance House" is `bank`.
- A bank is popular when its `code` is in some `POPULAR_BANKS[i].codes`. Popular banks appear in `popular` and also in `all` (the board shows Access in both), and **never** in `more`, whatever `bankKind` says.
- A to Z: `Intl.Collator('en', { sensitivity: 'base', numeric: true })` on `name`, ties broken by `code`. A duplicate `code` keeps its first entry.
- `initialsFor`: drop the generic words `bank, nigeria, plc, limited, ltd, of, the, and, microfinance, mfb, mortgage`. Two or more words left: the first letter of the first two. One word left: its first two letters. None left: the first two letters of the name. The result is uppercase.
- Badge: a popular bank uses its `tone` and whichever of black or white `ink` gives the higher contrast. Every other bank gets `tone: null, ink: null` and is drawn with neutral tokens in CSS.

- [ ] **Step 1: Write the failing tests** in `apps/web/test/bank-directory.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  POPULAR_BANKS,
  arrangeBanks,
  bankKind,
  contrastRatio,
  initialsFor,
} from '../src/lib/bank-directory.ts';

const LIST = [
  { code: '057', name: 'Zenith Bank' },
  { code: '090001', name: 'LAPO Microfinance Bank' },
  { code: '044', name: 'Access Bank' },
  { code: '070001', name: 'Abbey Mortgage Bank' },
  { code: '50515', name: 'Moniepoint MFB' },
  { code: '023', name: 'Citibank Nigeria' },
  { code: '214', name: 'First City Monument Bank' },
  { code: '100002', name: 'Paga' },
];

test('microfinance and mortgage banks are told apart by their names', () => {
  assert.equal(bankKind('LAPO Microfinance Bank'), 'microfinance');
  assert.equal(bankKind('Fina Trust Micro Finance Bank'), 'microfinance');
  assert.equal(bankKind('Moniepoint MFB'), 'microfinance');
  assert.equal(bankKind('Abbey Mortgage Bank'), 'mortgage');
  assert.equal(bankKind('FSDH Merchant Bank'), 'bank');
  assert.equal(bankKind('Paga'), 'bank');
  assert.equal(bankKind('Finance House'), 'bank');
});

test('a popular key shows only when its code is in the partner list', () => {
  const { popular } = arrangeBanks(LIST);
  assert.deepEqual(
    popular.map((bank) => bank.popularLabel),
    ['Access', 'Zenith', 'Moniepoint'],
  );
  // A bank named like GTBank but under another code is not GTBank's key.
  const lookalike = arrangeBanks([
    { code: '999', name: 'Guaranty Trust Bank' },
  ]);
  assert.deepEqual(lookalike.popular, []);
});

test('A to Z after the popular keys, with microfinance and mortgage under More banks', () => {
  const { all, more } = arrangeBanks(LIST);
  assert.deepEqual(
    all.map((bank) => bank.name),
    [
      'Access Bank',
      'Citibank Nigeria',
      'First City Monument Bank',
      'Moniepoint MFB',
      'Paga',
      'Zenith Bank',
    ],
  );
  assert.deepEqual(
    more.map((bank) => bank.name),
    ['Abbey Mortgage Bank', 'LAPO Microfinance Bank'],
  );
});

test('a popular microfinance bank stays in A to Z, never under More banks', () => {
  const { all, more } = arrangeBanks(LIST);
  assert.ok(all.some((bank) => bank.code === '50515'));
  assert.ok(!more.some((bank) => bank.code === '50515'));
});

test('a code listed twice keeps its first name', () => {
  const { all } = arrangeBanks([
    { code: '044', name: 'Access Bank' },
    { code: '044', name: 'Access Bank (Diamond)' },
  ]);
  assert.deepEqual(
    all.map((bank) => bank.name),
    ['Access Bank'],
  );
});

test('badge initials follow the board', () => {
  assert.equal(initialsFor('Citibank Nigeria'), 'CI');
  assert.equal(initialsFor('Ecobank Nigeria'), 'EC');
  assert.equal(initialsFor('Fidelity Bank'), 'FI');
  assert.equal(initialsFor('First City Monument Bank'), 'FC');
  assert.equal(initialsFor('LAPO Microfinance Bank'), 'LA');
  assert.equal(initialsFor('Bank'), 'BA');
});

test('every popular badge reads at 4.5:1 or better', () => {
  const { popular } = arrangeBanks(
    POPULAR_BANKS.map(({ label, codes }) => ({ code: codes[0], name: label })),
  );
  assert.equal(popular.length, POPULAR_BANKS.length);
  for (const { badge, popularLabel } of popular)
    assert.ok(
      contrastRatio(badge.tone, badge.ink) >= 4.5,
      `${popularLabel}: ${badge.ink} on ${badge.tone}`,
    );
});

test('no code belongs to two popular banks', () => {
  const codes = POPULAR_BANKS.flatMap((bank) => bank.codes);
  assert.equal(new Set(codes).size, codes.length);
});
```

- [ ] **Step 2: Run** `pnpm --filter @tipme/web test`. Expected: FAIL.
- [ ] **Step 3: Implement** `bank-directory.ts`.
- [ ] **Step 4: Run** the tests again. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(web): arrange the partner's bank list for the picker`.

---

### Task 4: Search with ranking and highlights

**Files:**

- Create: `apps/web/src/lib/bank-search.ts`, `apps/web/test/bank-search.test.mjs`

**Interfaces (consumes):** `DirectoryBank`, `BankDirectory` (Task 3), `aliasMatches` and `normalizeBankText` (Task 2).

**Interfaces (produces):**

```ts
/** Character ranges of `bank.name` to underline, as [start, end) pairs, ascending, not overlapping. */
export type BankMatch = { bank: DirectoryBank; marks: [number, number][] };
/** null when the query is empty after normalizing: the picker shows the grouped view instead. */
export function searchBanks(
  directory: BankDirectory,
  query: string,
): BankMatch[] | null;
/** The live count: "1 bank matches", "4 banks match", or the no-match sentence. */
export function matchCountText(count: number, query: string): string;
```

The search covers `all` and `more` (popular banks are already in `all`). Each bank gets its best score, and banks with no score are dropped:

| score | rule                                                                     | marks                                 |
| ----- | ------------------------------------------------------------------------ | ------------------------------------- |
| 100   | `aliasMatches` is `exact`                                                | initials, if they spell it; else none |
| 90    | `aliasMatches` is `prefix`                                               | none                                  |
| 80    | normalized name starts with the query                                    | the prefix                            |
| 70    | some word starts with the query                                          | that word's prefix                    |
| 60    | query (2+ chars, no spaces) is a prefix of the significant-word initials | each initial letter                   |
| 50    | name contains the query                                                  | the substring                         |
| 40    | every query word is a prefix of some name word, in order                 | each prefix                           |

Sorting: score descending, then popular before others, then A to Z. Marks are computed on the original `name`. Words are found with `/[\p{L}\p{N}]+/gu` and their indices, so normalizing never shifts positions. Initials for scoring skip the same generic words as `initialsFor`, except `bank`. That way "gtb" spells Guaranty Trust Bank, as the board underlines G, T and B.

No-match text, from the board (proposed copy, approved with the board): `No bank matches "${query}". Check the spelling, or try the bank's full name.` The query is shown trimmed, as typed.

- [ ] **Step 1: Write the failing tests** in `apps/web/test/bank-search.test.mjs`, with a fixture of 12 real-style names: Access Bank, Citibank Nigeria, Ecobank Nigeria, Fidelity Bank, First Bank of Nigeria, First City Monument Bank, Guaranty Trust Bank, Paycom (OPay), Stanbic IBTC Bank, United Bank for Africa, LAPO Microfinance Bank and Abbey Mortgage Bank, with the codes from Task 3's table where one exists.

```js
test('an empty or blank query shows the grouped view, not a search', () => {
  assert.equal(searchBanks(dir, ''), null);
  assert.equal(searchBanks(dir, '   '), null);
});

test('typing gtb finds Guaranty Trust Bank and underlines G, T and B', () => {
  const [first, ...rest] = searchBanks(dir, 'gtb');
  assert.equal(first.bank.name, 'Guaranty Trust Bank');
  assert.deepEqual(first.marks, [
    [0, 1],
    [9, 10],
    [15, 16],
  ]);
  assert.equal(rest.length, 0);
});

test('fir finds both First banks, with the typed letters underlined, and not Fidelity', () => {
  const names = searchBanks(dir, 'fir').map((m) => m.bank.name);
  assert.deepEqual(names, [
    'First Bank of Nigeria',
    'First City Monument Bank',
  ]);
  assert.deepEqual(searchBanks(dir, 'fir')[0].marks, [[0, 3]]);
});

test('fbn puts First Bank first; first city finds FCMB by its words', () => {
  assert.equal(searchBanks(dir, 'fbn')[0].bank.name, 'First Bank of Nigeria');
  assert.equal(
    searchBanks(dir, 'first city')[0].bank.name,
    'First City Monument Bank',
  );
});

test('search reaches the banks under More banks', () => {
  assert.equal(searchBanks(dir, 'lapo')[0].bank.name, 'LAPO Microfinance Bank');
  assert.equal(
    searchBanks(dir, 'mortgage')[0].bank.name,
    'Abbey Mortgage Bank',
  );
});

test('opay finds Paycom (OPay) through its alias', () => {
  assert.equal(searchBanks(dir, 'opay')[0].bank.name, 'Paycom (OPay)');
});

test('case, accents and punctuation do not matter', () => {
  assert.equal(searchBanks(dir, 'STANBIC')[0].bank.name, 'Stanbic IBTC Bank');
  assert.equal(
    searchBanks(dir, 'u.b.a')[0].bank.name,
    'United Bank for Africa',
  );
});

test('a misspelling matches nothing', () => {
  assert.deepEqual(searchBanks(dir, 'gtbnk zz'), []);
});

test('the live count reads naturally', () => {
  assert.equal(matchCountText(1, 'gtb'), '1 bank matches');
  assert.equal(matchCountText(4, 'b'), '4 banks match');
  assert.equal(
    matchCountText(0, ' gtbnk zz '),
    'No bank matches "gtbnk zz". Check the spelling, or try the bank’s full name.',
  );
});
```

(The board writes "bank's" with a straight apostrophe. The app uses a curly one, `’`, to match the card's existing copy, and the test pins it.)

- [ ] **Step 2: Run** `pnpm --filter @tipme/web test`. Expected: FAIL.
- [ ] **Step 3: Implement** `bank-search.ts`.
- [ ] **Step 4: Run** the tests again. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(web): bank search with aliases and highlights`.

---

### Task 5: Listbox keyboard movement

**Files:**

- Create: `apps/web/src/lib/listbox-navigation.ts`, `apps/web/test/listbox-navigation.test.mjs`

**Interfaces (produces):**

```ts
/** The next active option index, or -1 for none. `count` options, `current` -1 when none is active. */
export function nextActive(
  current: number,
  key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End',
  count: number,
): number;
```

ArrowDown from -1 goes to 0. ArrowDown on the last option stays there (no wrap, so a screen reader never jumps from the end back to the top). ArrowUp from 0 stays at 0. Home goes to 0 and End to `count - 1`. With `count` 0, every key gives -1.

- [ ] **Step 1: Write the failing tests:** `'arrow keys move one option and stop at the ends'`, `'Home and End jump to the first and last'`, `'an empty list never has an active option'`, each with `assert.equal` on the cases above.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit:** `feat(web): listbox keyboard movement`.

---

### Task 6: The name-check memo

**Files:**

- Create: `apps/web/src/lib/name-check.ts`, `apps/web/test/name-check.test.mjs`

**Interfaces (produces):**

```ts
export type NameCheckOutcome =
  | { kind: 'found'; accountName: string }
  | { kind: 'not_found' }
  | { kind: 'failed'; code: string }; // the API's error code, shown through messageFor
export type NameCheckView =
  | { kind: 'waiting' } // no bank, or fewer than 10 digits
  | { kind: 'checking' }
  | NameCheckOutcome;

/** `${bankCode}:${accountNumber}` once both are complete, else null. */
export function nameCheckKey(
  bankCode: string,
  accountNumber: string,
): string | null;

/** Mutable on purpose: it lives in a ref, so the check-or-not decision is synchronous. */
export class NameChecks {
  /** True, and marks it in flight, only for a complete key with no outcome and no call in flight. */
  claim(key: string | null): key is string;
  finish(key: string, outcome: NameCheckOutcome): void;
  /** Only a failed outcome can be retried: it clears that outcome and claims the key again. */
  retry(key: string | null): key is string;
  view(key: string | null): NameCheckView;
}
```

- [ ] **Step 1: Write the failing tests** in `apps/web/test/name-check.test.mjs`:

```js
test('nothing is checked before a bank is chosen and all 10 digits are in', () => {
  assert.equal(nameCheckKey('', '0123456789'), null);
  assert.equal(nameCheckKey('058', '012345678'), null);
  assert.equal(nameCheckKey('058', '01234567890'), null);
  assert.equal(nameCheckKey('058', '0123456789'), '058:0123456789');
  const checks = new NameChecks();
  assert.equal(checks.claim(null), false);
  assert.deepEqual(checks.view(null), { kind: 'waiting' });
});

test('a pair is checked once, and never again once answered', () => {
  const checks = new NameChecks();
  const key = nameCheckKey('058', '0123456789');
  assert.equal(checks.claim(key), true);
  assert.equal(checks.claim(key), false); // in flight
  assert.deepEqual(checks.view(key), { kind: 'checking' });
  checks.finish(key, { kind: 'found', accountName: 'ADA OKAFOR' });
  assert.equal(checks.claim(key), false);
  assert.deepEqual(checks.view(key), {
    kind: 'found',
    accountName: 'ADA OKAFOR',
  });
});

test('switching to another bank and back reuses the first answer', () => {
  const checks = new NameChecks();
  const gt = nameCheckKey('058', '0123456789');
  const ac = nameCheckKey('044', '0123456789');
  checks.claim(gt);
  checks.finish(gt, { kind: 'not_found' });
  assert.equal(checks.claim(ac), true);
  assert.equal(checks.claim(gt), false);
  assert.deepEqual(checks.view(gt), { kind: 'not_found' });
});

test('only a failure can be checked again', () => {
  const checks = new NameChecks();
  const key = nameCheckKey('058', '0123456789');
  checks.claim(key);
  checks.finish(key, { kind: 'not_found' });
  assert.equal(checks.retry(key), false);
  const other = nameCheckKey('058', '1111111111');
  checks.claim(other);
  assert.equal(checks.retry(other), false); // still in flight
  checks.finish(other, { kind: 'failed', code: 'PAYOUT_PROVIDER_UNAVAILABLE' });
  assert.equal(checks.claim(other), false); // a failure never re-fires by itself
  assert.equal(checks.retry(other), true);
  assert.deepEqual(checks.view(other), { kind: 'checking' });
});

test('a late answer is kept for its own pair only', () => {
  const checks = new NameChecks();
  const first = nameCheckKey('058', '0123456789');
  const second = nameCheckKey('058', '0123456788');
  checks.claim(first);
  checks.claim(second);
  checks.finish(first, { kind: 'found', accountName: 'ADA OKAFOR' });
  assert.deepEqual(checks.view(second), { kind: 'checking' });
  assert.deepEqual(checks.view(first), {
    kind: 'found',
    accountName: 'ADA OKAFOR',
  });
});
```

- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement** (`Map<string, NameCheckOutcome>` plus `Set<string>` in flight). **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit:** `feat(web): remember name checks per bank and number`.

---

### Task 7: `BankPicker` on desktop (combobox and listbox)

**Files:**

- Create: `apps/web/src/components/account/bank-picker.tsx`, `tests/e2e/bank-fixtures.ts`, `tests/e2e/bank-picker.spec.ts`
- Modify: `apps/web/src/app/globals.css` (a `.bank-picker` block next to `.settings-form`, with `@media (forced-colors: active)` and `(prefers-reduced-motion: reduce)` rules); `apps/web/src/components/account/get-paid-card.tsx` (only the `<select>` at lines 265-284 becomes `<BankPicker id={id} banks={banks} value={bankCode} disabled={busy} onChange={(code) => { setBankCode(code); setResolved(null); }} />`; "Check account" stays until Task 9); `tests/e2e/get-paid.spec.ts` (the three `selectOption({ index: 1 })` calls become `chooseBank(card, 'guaranty', 'Pretend Guaranty Bank')`, a helper in `bank-fixtures.ts` that fills the combobox and presses Enter on that option; the mock list is 058 Pretend Guaranty Bank and 101 Pretend Providus Bank, `packages/payments/src/mock/mock-provider.ts:274`)

**Interfaces (produces):**

```tsx
export function BankPicker(props: {
  id: string; // from the card's useId, so the label stays `${id}-bank`
  banks: readonly PayoutBank[];
  value: string; // the chosen bank code, '' for none
  onChange(code: string): void; // only on choosing an option, never while typing
  disabled?: boolean;
}): JSX.Element;
```

`arrangeBanks(banks)` runs once per list (`useMemo`).

**Markup (desktop, wider than 40rem):**

- `<label for="${id}-bank">Bank</label>`, then `<input id="${id}-bank" role="combobox" aria-autocomplete="list" aria-expanded aria-controls="${id}-banks" aria-activedescendant={active option id or undefined} placeholder="Search your bank" autoComplete="off" spellCheck={false}>`. A decorative `⌄` follows (`aria-hidden`).
- Popup: `<div class="bank-picker__popup">`. Inside it, `<ul role="listbox" id="${id}-banks" aria-label="Banks">`. With no query, it holds three `role="group"` children, each labelled by a heading `<li role="presentation">`:
  - "Popular": the keys, `role="option"`, each showing its badge and `popularLabel`. Laid out as wrapping keys, but still one linear arrow order.
  - "All banks, A to Z": options showing the badge and `name`.
  - "More banks: microfinance and mortgage": shown only if `more` is not empty. While collapsed, the group holds one `role="option"` row, `aria-selected="false"`, with the label text and `⌄`. Choosing it (Enter or click) expands the group, makes its first bank active, and never calls `onChange`.
- With a query, there are no groups: just the `searchBanks` results, each name drawn with `<mark>` over `marks`. With no results, the popup shows the no-match sentence instead of the listbox. The keyboard hint `<p class="tm-hint">↑ ↓ to move, Enter to choose, Esc to close.</p>` sits under the results.
- A visually hidden `<p role="status" aria-live="polite">` holds `matchCountText`, updated 300 ms after typing stops. It is empty with no query.
- Option ids: `${id}-bank-${code}` (the popular copy gets `${id}-bank-popular-${code}`). `aria-selected="true"` on the active option. The chosen bank carries a non-colour tick.

**Behaviour:**

- Focus or click opens the popup and selects the input's text. ArrowDown opens it too. With the popup closed, typing opens it.
- Typing filters and makes the first result active. ArrowUp, ArrowDown, Home and End use `nextActive` and scroll the active option into view (`block: 'nearest'`).
- Enter on an active bank option calls `onChange(code)`, sets the input to the bank's `name` and closes the popup. Enter with no active option does nothing and never submits the form (`preventDefault`).
- Esc, Tab and blur close the popup without calling `onChange`, and put the text back to the chosen bank's `name` (or '' if none). Typing never clears the chosen bank. Only choosing changes it.
- Options choose on `pointerdown` with `preventDefault`, so focus stays in the input. Rows are at least 44px tall, and keys 44px tall.
- With a bank chosen, the input shows the bank's `name`, and opening the popup shows the grouped view (the query counts as empty while the text equals the chosen name).

**Copy added (board):** "Search your bank", "Popular", "All banks, A to Z", "More banks: microfinance and mortgage", "↑ ↓ to move, Enter to choose, Esc to close.", the no-match sentence, "1 bank matches" and "N banks match".

**Fixture** (`tests/e2e/bank-fixtures.ts`): `export const BANKS: PayoutBank[]` holds the 12 names from Task 4 plus Zenith Bank (057), Moniepoint MFB (50515) and Kuda Microfinance Bank (50211). PalmPay is left out on purpose. Also `export async function standInBanks(page: Page, banks = BANKS)` routes `**/v1/payout-banks` to `{ data: banks }`, the way `get-paid.spec.ts:117` stubs the destination.

- [ ] **Step 1: Write the failing e2e tests** in `tests/e2e/bank-picker.spec.ts`. Each one signs up with `signUpRecipient(page, testInfo, { live: false })`, calls `standInBanks(page)`, goes to `/dashboard/settings#get-paid`, and sets `const bank = card.getByRole('combobox', { name: 'Bank' })`.
  - `'the bank field is a combobox that opens on popular banks, then A to Z'`: `bank` has `aria-expanded="false"`. After `bank.focus()`, it is `"true"`, and `aria-controls` points at a visible `role=listbox`. The group "Popular" has options named exactly `['GTBank', 'Access', 'Zenith', 'UBA', 'First Bank', 'OPay', 'Moniepoint', 'Kuda']`, with no PalmPay. The group "All banks, A to Z" starts `Access Bank, Citibank Nigeria, Ecobank Nigeria`. LAPO Microfinance Bank is not visible until the "More banks: microfinance and mortgage" option is clicked. `bank` keeps focus throughout. Then `expectAccessible(page)`.
  - `'typing gtb finds Guaranty Trust Bank, and Enter chooses it'`: fill `gtb`. Exactly one option, "Guaranty Trust Bank", is active (`aria-activedescendant` equals its id), and its `mark` elements read `['G', 'T', 'B']`. The status reads "1 bank matches". Press Enter: `bank` has the value "Guaranty Trust Bank" and `aria-expanded="false"`, and the form was not submitted (no "Not saved" notice).
  - `'arrow keys move through the banks and Esc changes nothing'`: choose Access Bank, focus, ArrowDown twice. The active option changes, and `aria-activedescendant` follows. Press Esc: the popup closes and the value is still "Access Bank".
  - `'a misspelling says so, and suggests the full name'`: fill `gtbnk zz`. The text `No bank matches "gtbnk zz". Check the spelling, or try the bank’s full name.` is visible, and there is no `role=option`.
  - `'microfinance banks are found by search even while folded away'`: fill `lapo`. "LAPO Microfinance Bank" is the first option.
  - `'forced colours keep the active option and the keys visible'`: `page.emulateMedia({ forcedColors: 'active' })`. The active option's computed `outline-style` is not `none`, and each popular key's `border-style` is not `none`.
- [ ] **Step 2: Run** `pnpm test:e2e -- tests/e2e/bank-picker.spec.ts --project=desktop`. Expected: FAIL (there is no combobox yet).
- [ ] **Step 3: Implement** `bank-picker.tsx` and the CSS. Materials: the input is the existing recessed `.tm-input` well, and the popup is a floating card (`--surface-raised`, `--shadow-float`, `--radius-card`). The active option is `--brand-soft` with `--brand-ink` text, plus an outline in forced colours. Keys use `--shadow-raised-1` and lose elevation when pressed. Neutral badges are `--surface-recessed` with `--text-primary`. Popular badges use their `tone` and `ink` as inline styles. Badges are `aria-hidden`.
- [ ] **Step 4: Run** `pnpm test:e2e -- tests/e2e/bank-picker.spec.ts tests/e2e/get-paid.spec.ts --project=desktop`. Expected: PASS (get-paid still clicks "Check account" here).
- [ ] **Step 5: Commit:** `feat(web): search your bank (combobox and listbox)`.

---

### Task 8: The phone sheet

**Files:**

- Modify: `apps/web/src/components/account/bank-picker.tsx`, `apps/web/src/app/globals.css`, `tests/e2e/bank-picker.spec.ts`

**Behaviour:**

- At `(max-width: 40rem)`, the same breakpoint as `globals.css:8337`, read with `useSyncExternalStore` over `matchMedia`, the field in the form is a `<button type="button" id="${id}-bank" aria-haspopup="dialog">`, labelled by the same `<label>`. It shows the chosen bank's badge and name, or "Search your bank" as placeholder styling. Tapping it opens a native `<dialog class="bank-sheet">` with `showModal()` inside the same tap. Then it focuses the search input synchronously, so phones raise the keyboard.
- The sheet covers the viewport (`inset: 0`, `100dvh`, no margin). At the top: the heading "Choose your bank" (`aria-labelledby` on the dialog) and a ✕ button, `aria-label="Close"`, 44px. Below that, `<input role="combobox" aria-label="Search your bank" ...>` and the same listbox as Task 7, filling the rest of the height and scrolling.
- Choosing a bank calls `onChange`, closes the sheet and returns focus to the trigger. Esc (the dialog's `cancel`) and ✕ close it without change, and focus returns to the trigger.
- Reduced motion: no entrance animation. Otherwise the sheet rises in `--duration-spatial` with `--ease-physical`.

**Copy added (board):** "Choose your bank" (the existing `<option>` placeholder text becomes the sheet's heading), "Close".

- [ ] **Step 1: Write the failing tests** (tag `@mobile`):
  - `'on a phone, Bank opens a full-screen sheet with the search ready @mobile'`: click `card.getByRole('button', { name: 'Bank' })`. `page.getByRole('dialog', { name: 'Choose your bank' })` is visible, and its bounding box equals the viewport (360×800). The combobox "Search your bank" is focused. Type `fir`: the options are "First Bank of Nigeria" and "First City Monument Bank", in that order. Tap the first: the dialog is hidden, focus is on the Bank button, and the button reads "First Bank of Nigeria". Then `expectAccessible(page)` and `fitsViewport(page)` at 320px (`page.setViewportSize({ width: 320, height: 700 })`).
  - `'the sheet closes with Esc or ✕ and changes nothing @mobile'`: choose Access Bank, reopen, type `zen`, press Escape. The dialog is hidden and the button still reads "Access Bank". Reopen, click "Close": same result.
  - `'the sheet does not move when motion is reduced @mobile'`: the config already sets `reducedMotion: 'reduce'`. The dialog's computed `animation-name` is `none`.
- [ ] **Step 2: Run** `pnpm test:e2e -- tests/e2e/bank-picker.spec.ts --project=mobile`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both projects. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(web): bank sheet on phones`.

---

### Task 9: The name check on its own, in `GetPaidCard`

**Files:**

- Modify: `apps/web/src/components/account/get-paid-card.tsx`, `tests/e2e/get-paid.spec.ts`, `tests/e2e/bank-picker.spec.ts`

**Changes to `get-paid-card.tsx`:**

- `BankPicker`'s `onChange` becomes `setBankCode` (no `setResolved`). `busy` now means only "sending a code" or "saving", never "checking".
- Remove `lookUp` and the "Check account" button (lines 115-136 and 317-324). Add `const checks = useRef(new NameChecks())` and a `[, redraw] = useReducer((n: number) => n + 1, 0)`. Then:

  ```ts
  const key = nameCheckKey(bankCode, accountNumber);
  const run = useCallback(
    async (claimed: string, bank: string, number: string) => {
      redraw();
      const result = await apiFetch<PayoutBankResolveResponse>(
        '/v1/me/payout-destination/resolve',
        { method: 'POST', body: { bankCode: bank, accountNumber: number } },
      );
      checks.current.finish(
        claimed,
        !result.ok
          ? { kind: 'failed', code: result.code }
          : result.data.resolved
            ? { kind: 'found', accountName: result.data.accountName }
            : { kind: 'not_found' },
      );
      redraw();
    },
    [],
  );
  useEffect(() => {
    if (checks.current.claim(key)) void run(key, bankCode, accountNumber);
  }, [key, bankCode, accountNumber, run]);
  const nameCheck = checks.current.view(key);
  ```

  `resolved` state is gone. `accountName` comes from `nameCheck` (`found` → `accountName`, `not_found` → `typedName.trim()`, else `''`). `checks` is never reset by `resetForm`: it lives as long as the card.

- The account number field is no longer disabled while checking (it would lose focus on the 10th digit). Its hint is `${accountNumber.length} of 10` while there are 1 to 9 digits, and nothing otherwise, linked through `InputField`'s `hint`.
- The existing messages stay reachable without a button: "Enter your 10-digit account number." shows as the field's `error` when it loses focus with 1 to 9 digits. "Choose your bank." shows when 10 digits are in and no bank is chosen. Both clear on the next change.
- `nameCheck.kind === 'checking'`: `<p role="status" className="bank-check"><span className="bank-check__spin" aria-hidden="true" />Checking the name at your bank…</p>`. The spinner is static under reduced motion.
- `found`: the read-only "Name on the account" field, as today, with a non-colour tick (`aria-hidden`) before it. `not_found`: today's editable field and hint, unchanged.
- `failed`: the existing `<Notice tone="error" title="Not saved">{messageFor(code)}</Notice>`, plus `<Button type="button" variant="secondary" onClick={() => { if (checks.current.retry(key)) void run(key, bankCode, accountNumber); }}>Check again</Button>`. This is the only place the button exists.
- "Email me a code" shows only for `found` or `not_found`. The code step, "Send a new code", "Cancel", "Save bank account" and "Keep my current account" are unchanged.
- Line 240: "The payment provider can’t pay to this account. Please add another." becomes "Our payment partner can’t pay to this account. Please add another."

**Copy added (board):** "Checking the name at your bank…", "Check again", "N of 10".

- [ ] **Step 1: Write the failing tests.**

  In `tests/e2e/get-paid.spec.ts`, keep every test name and assertion. Remove each "Check account" click: after `chooseBank` and the number, the name appears with no click. Add:
  - `'a rejected bank account says our payment partner can’t pay to it'`: stub `**/v1/me/payout-destination` with `{ destination: { status: 'rejected', bankName: 'Pretend Bank', last4: '6789' }, bankChangesFrom: null }`. The card shows "Our payment partner can’t pay to this account. Please add another." and does not contain "payment provider can’t pay".
  - Extend `'after an email change the card says when, and offers no form'`: `card.getByRole('combobox', { name: 'Bank' })` and `card.getByRole('button', { name: 'Bank' })` both have count 0.
  - Extend the first test: GTBank's key shows (code 058 is in the mock list), and no other popular key shows.

  In `tests/e2e/bank-picker.spec.ts`, count calls with `page.route('**/v1/me/payout-destination/resolve', ...)`. Count them, then `route.continue()`, or `fulfill` for the error cases:
  - `'the name is checked once, on the 10th digit, with no button'`: choose GTBank by its key and type `012345678`. The resolve count is 0, the hint "9 of 10" is visible, and there is no "Check account" or "Check again" button. Type `9`: "Checking the name at your bank…" is visible (hold the route with a promise you release). Release: "Name on the account" has the value "PRETEND ACCOUNT HOLDER", is readonly, and the count is 1.
  - `'the same bank and number are never checked twice'`: after the test above's pair, choose Pretend Providus Bank (count 2), then GTBank again. The count stays 2 and the name is shown at once. Delete the last digit and retype it: still 2.
  - `'no bank chosen: nothing is checked, and it says so'`: type 10 digits with no bank. The count is 0 and "Choose your bank." is visible.
  - `'a short number says how many digits, and nothing is checked'`: type 9 digits and Tab away. "Enter your 10-digit account number." is visible and the count is 0.
  - `'a failed check shows today's message and Check again, which checks once more'`: fulfill the first call with `status: 503, json: { error: { code: 'PAYOUT_PROVIDER_UNAVAILABLE' } }`. The notice "We couldn’t reach the payment provider. Please try again in a moment." and a "Check again" button are visible, and there is no "Email me a code". Click "Check again" (continue to the real API this time): the name is found, "Check again" is hidden, and the count is 2.
  - `'today's 10 checks used up: the same message as today'`: fulfill with 429 `{ error: { code: 'RATE_LIMITED' } }`. "Too many tries. Please wait a while and try again." and "Check again" are visible.
  - `'a late answer never shows against a newer number'`: choose GTBank, type `1234560001` and hold that call (the mock would answer found). Change the last digit to make `1234560000`, which fires a second call that the mock answers `not_found` at once. Release the first. The name field is editable (the not_found state) with an empty value.
  - `'no user-visible text names the partner'`: across the flows above, `page.locator('body')` never contains `/bachs/i`.

- [ ] **Step 2: Run** `pnpm test:e2e -- tests/e2e/get-paid.spec.ts tests/e2e/bank-picker.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the card changes.
- [ ] **Step 4: Run** the two specs, plus `tests/e2e/withdraw.spec.ts` and `tests/e2e/cover-settings.spec.ts`, which visit the same settings page. Expected: PASS. Then run `pnpm --filter @tipme/web test`: `no-provider-names.test.mjs` passes.
- [ ] **Step 5: Commit:** `feat(web): check the account name on its own, once per bank and number`.

---

### Task 10: Review gallery, whole-branch check, handoff

**Files:**

- Modify: `tests/review/screens.ts` (add screens), `docs/agent/ACTIVE_TASK.md`, `docs/agent/HANDOFF.md`

- [ ] **Step 1:** Add review screens to `SCREENS` under the group `'Get paid'`, board `'BankPicker'`, all using `standInBanks`: "Bank picker, open" (focused, nothing typed), "Bank picker, typed gtb", "Bank picker, no match", "Name check, checking" (route held), "Name check, found", "Name check, not found", "Name check, failed" (503 stub). Add "Bank sheet, typed fir" with `viewport: true`.
- [ ] **Step 2: Run everything**, with no other test run on the machine: `rm -rf apps/web/.next/cache && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, then `pnpm test:e2e`. Expected: all pass. Record each command and its pass, fail or skip count. If port 4100 is held by another stack, say so and leave e2e to CI. Don't claim a pass you didn't see.
- [ ] **Step 3:** `pnpm review:screens`. Hand the owner `review-screens/index.html`, listing every difference from the board, one line each. Known differences: "fir" doesn't list Fidelity Bank (no fuzzy matching); the no-match sentence uses a curly apostrophe.
- [ ] **Step 4:** Update `ACTIVE_TASK.md` and `HANDOFF.md` with the verified state, the files changed and the next step (owner review, then push and open the PR to `dev`). Commit: `chore(web): bank picker review screens and handoff`.
- [ ] **Step 5:** Do not push until the owner approves the gallery.

---

## Self-review

- Spec coverage: A (search, aliases, popular keys by code, A to Z, More banks, phone sheet, ARIA) is Tasks 2-8. C (automatic, single-fire check and "Check again" only on error) is Tasks 6 and 9. The line 240 copy change is Task 9. B is absent by design.
- Rules kept: the email code, the bank-change pause (no form, so no picker: tested in Task 9), last 4 digits only, and the 10-a-day limit (unchanged server side, never wasted client side).
- No API or contract change, no new package, and no partner name in any user-visible string.
