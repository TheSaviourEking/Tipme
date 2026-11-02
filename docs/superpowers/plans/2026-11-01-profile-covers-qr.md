# Public page, covers, Pro QR and handle rule: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the redesigned public page, cover choices and uploads, server-drawn Pro QR designs with a Free preview, and the Pro handle rule.

**Architecture:** Cover and handle facts live on `profiles`, with uploads mirroring profile photos. Public pages receive a resolved `cover`. Pro QR art is drawn in the API by pure functions and only served as real to Pro pages; the web composes print formats around that image.

**Tech Stack:** NestJS, Drizzle/Postgres, Next, `sharp` (already in the API), `qrcode` 1.5.4 (add to the API at the web's pin), `jsqr` for tests.

**Spec:** `docs/superpowers/specs/2026-11-01-profile-covers-qr-design.md`. Visual reference: the mockup linked in the spec, plus generators in the design scratchpad, copied in Task 3.

## Global Constraints

- Branch `feat/profile-covers-qr`, off `dev`. Never push or merge without the owner.
- Read `AGENTS.md`, the nearest scoped `AGENTS.md`, and for UI `docs/design/DESIGN-CONSTITUTION.md` and its required documents.
- Migrations: next free number with a journal `when` later than all others. The payouts and admin branches also add migrations, so expect renumbering at merge; don't hard-code numbers outside the migration files.
- Users never see a payment provider's name. Staff screens may.
- Controls at least 44px; keyboard, reduced motion and 320px reflow work.
- Test containers: throwaway Postgres and Redis on their own ports, not 5434/5435/6380/6381. Report every failing test by name with its error. Backup tests need `tipme-postgres-1`; don't call their failure a macOS issue.
- New visual decisions go in `docs/design/DECISION-LOG.md`.
- Motion, transitions and scrolling follow `docs/design/EXPERIENCE-AND-MOTION.md`, built with the screen and tested as it says.

## Review Focus

1. A 30-character handle makes a denser code: every design must still scan. Task 5 tests the longest handle.
2. A Free page requesting a Pro design by guessing its URL, or one that dropped from Pro with a cached image: never a real code. Tasks 5 and 6.
3. Two simultaneous handle changes on the third allowance: only one succeeds. Task 1.
4. A very long name, long bio, or no photo, role or links must not break the page. Task 4.
5. A deleted account or hidden page: its cover URL stops working and its stored file goes. Task 2.

---

### Task 1: Handle rule

**Files:**

- Modify: `packages/database/src/schema.ts` (`profiles.handle_changes_used integer not null default 0`, `profiles.handle_changes_extra integer not null default 0`), a new migration, `packages/database/src/operations/profiles.ts:446` (`renameHandle`), `packages/contracts/src/errors.ts`, `packages/contracts/src/profiles.ts` (`MyProfile.handleChanges?: { used: number; allowed: number }`), `packages/database/src/operations/errors.ts`, `apps/api/src/http/api-exception.filter.ts`, `apps/api/src/ops/pages.controller.ts`, `apps/web/src/app/dashboard/settings/settings-view.tsx:252-335`, `apps/web/src/app/ops/pages/page.tsx`
- Test: `tests/integration/handle-rule.test.mjs`, `tests/e2e/pro.spec.ts`; fix existing rename tests that assume Free can rename; `packages/database/test/integration/migration-journal.test.mjs`

**Interfaces:**

- Produces: `PRO_HANDLE_CHANGES = 3`; `grantHandleChanges(db, { staffId, handle, extra: number, reason }): Promise<{ allowed: number }>`, audited as `page.handle_changes_granted`. New error codes `HANDLE_CHANGE_PRO_REQUIRED` (403) and `HANDLE_CHANGE_LIMIT` (409), replacing `HANDLE_RENAME_LIMIT`. Removes `MAX_HANDLE_ALIASES`.

- [ ] **Step 1: Write the failing tests**

```js
test('a Free page cannot change its handle', ...); // 403 HANDLE_CHANGE_PRO_REQUIRED, handle unchanged
test('a Pro page changes three times, then is refused', ...); // 4th: 409 HANDLE_CHANGE_LIMIT
test('switching back to an old handle counts', ...);
test('a change of case alone changes and counts nothing', ...);
test('old handles keep leading to the page and stay unclaimable', ...);
test('two changes at once on the last allowance: one wins', ...);
test('leaving Pro keeps the handle and refuses more changes; returning does not reset the count', ...);
test('staff can allow more, with a reason, and it is audited', ...);
test('migration journal timestamps strictly increase', ...);
```

e2e: Pro sees "3 changes left", changes it, sees a confirmation with the new handle and remaining count, cancels (nothing changes), confirms (changes). Free sees no form, and "Handle changes are part of TipMe Pro". At the limit: "You've used all your handle changes. Contact the TipMe team to change it again."

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Count and check inside the existing row-locked transaction. The confirmation is a real dialog with focus handling.
- [ ] **Step 4: Run** the files above and the existing rename tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(handles): Pro pages get three handle changes, with a confirmation`

---

### Task 2: Cover data and uploads

**Files:**

- Create: `packages/contracts/src/covers.ts`, `packages/database/src/operations/covers.ts`, `apps/api/src/profiles/cover.controller.ts`, `apps/api/src/profiles/image-upload.ts` (shared `readUpload`, `withSlot`, and `reencodeTo(width, height)`, moved out of `avatar.controller.ts`)
- Modify: schema (`profiles.cover_design text`, `profiles.cover_colour text`, `profiles.cover_path text`, `profiles.cover_version integer not null default 0`, table `profile_covers` shaped like `profile_avatars`), migration, `packages/database/src/operations/profiles.ts` (public and my-profile shapes), `apps/api/src/profiles/profiles.module.ts`, `apps/api/src/checkout/rate-limit.guard.ts` (`avatars` bucket covers these), `packages/contracts/src/profiles.ts`, wherever account deletion and `movePhotosToStore` handle `profile_avatars`
- Test: `tests/integration/cover-api.test.mjs`, `packages/contracts/test/covers.test.mjs`

**Interfaces:**

- Produces in `@tipme/contracts`:

```ts
export const COVER_DESIGNS: readonly CoverDesign[]; // ids from spec §6, each { id, name, colours: boolean }
export const COVER_COLOURS: readonly CoverColour[]; // ids from spec §6, each { id, name, base, tone }
export function automaticCover(handle: string): 'scattered' | 'large' | 'dark'; // stable hash of the lower-case handle
export type ResolvedCover =
  | { kind: 'photo'; path: string }
  | { kind: 'design'; design: string; colour?: string };
export function resolveCover(p: {
  handle: string;
  coverPath: string | null;
  coverDesign: string | null;
  coverColour: string | null;
}): ResolvedCover;
```

- `PublicProfile.cover?: ResolvedCover`; `MyProfile.cover?: ResolvedCover`, `MyProfile.coverChoice?: { design: string | null; colour: string | null; hasPhoto: boolean }`.
- Routes: `PUT /v1/me/cover` (image body), `DELETE /v1/me/cover`, `PUT /v1/me/cover-design` (`{ design: string | null, colour?: string | null }`), `GET /v1/covers/:profileId/:n.webp` (same headers and live-page rule as avatars). Each change revalidates the page.
- `setCover`, `removeCover`, `setCoverDesign`, `coverFor`, mirroring `setAvatar`, `removeAvatar`, `avatarFor`, including object-store handling.

- [ ] **Step 1: Write the failing tests**

```js
test('automatic cover is stable and one of the three, and changes nothing in the database', ...);
test('photo beats design beats automatic', ...);
test('an upload is re-encoded to 2240x600 WebP with no metadata', ...); // GPS EXIF in, none out; sharp reads the result
test('SVG, oversize and pixel-bomb uploads are refused', ...);
test('an unknown design or a colour on a design without colours is refused', ...);
test('a replaced cover URL stops working, and a hidden or deleted page serves none', ...);
test('deleting an account removes its stored cover, including from the object store', ...);
test('moving photos to the object store also moves covers', ...);
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Refactor the upload helpers without changing avatar behaviour.
- [ ] **Step 4: Run** the above, `photo-storage.test.mjs` and the avatar tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(covers): choose a design or upload a cover`

---

### Task 3: Cover artwork

**Files:**

- Create: `scripts/design/covers.mjs` (from the scratchpad `qrgen/covers.cjs`, the `covers` generator, as an ES module writing to `apps/web/public/covers/`), `apps/web/public/covers/*.webp`, `apps/web/src/components/profile/cover.tsx`
- Test: `apps/web/test/covers.test.mjs`, `tests/e2e/profile-cover.spec.ts`

**Interfaces:**

- Consumes: Task 2's catalogue and `ResolvedCover`.
- Produces: `<ProfileCover cover={ResolvedCover} priority?: boolean />`. Pattern designs are 2240×600 WebP. Heart designs are inline SVG using the catalogue's `base` and `tone`, with no fetch.

- [ ] **Step 1: Write the failing tests**

```js
test('every pattern design in the catalogue has a file, and no file lacks a design', ...);
test('every cover image is at most 120 KB and 2240x600', ...);
test('every heart design renders for every colour it allows', ...);
```

e2e: a page with each kind of cover renders it; the cover has an empty `alt` and doesn't delay the largest paint beyond the existing budget.

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** The source generator is at `/private/tmp/claude-502/-Users-dev-Workspace-SynqHQ-Tipme/579273e2-08df-4bbd-a0e2-911e1324953c/scratchpad/design/qrgen/covers.cjs`, with heart designs in the mockup's `DefaultScattered`, `DefaultLarge`, `DefaultDark` and `MoreCovers` boards. Copy the scratchpad generators into this task's first commit, because the scratchpad is temporary. Render SVG to WebP with `sharp`; heavy vector covers such as `engraved` and `overprint` must meet the size budget.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(covers): the cover artwork`

---

### Task 4: Public page redesign

**Files:**

- Modify: `apps/web/src/app/people/[handle]/page.tsx`, `apps/web/src/app/people/[handle]/loading.tsx`, `apps/web/src/components/profile/recipient-card.tsx`, `apps/web/src/components/share-profile.tsx`, `apps/web/src/components/navigation.tsx`, `apps/web/src/components/tipping-opens-soon.tsx`, `apps/web/src/lib/payment-mode-copy.ts`, `apps/web/src/app/globals.css`, `docs/design/DECISION-LOG.md`
- Test: replace `tests/e2e/profile-portrait.spec.ts` with `tests/e2e/profile-page.spec.ts`; update `tests/e2e/profile.visual.spec.ts` baselines following the rule in `docs/design/VISUAL-QUALITY-GATE.md`

**Interfaces:**

- Consumes: `<ProfileCover>`; `PublicProfile.cover`; `PublicProfile.plan?: PagePlan` (add to the public shape here, for the footer).
- Produces: `RecipientPortrait` removed. `RecipientIdentity` carries links and share.

- [ ] **Step 1: Write the failing tests**

```js
test('the page shows only the logo above the cover, with no nav, sign-in or breadcrumb', ...);
test('the name is the h1 and "Support Great People" is gone', ...);
test('the profile photo appears once, with links inside the identity block', ...);
test('no text on the page says demo', ...); // grep the rendered page, closed and open payment modes
test('Copy page link copies the page link and says Link copied.', ...);
test('on a phone the Tip button stays in view and the form still works', ...);
test('closed checkout shows no Tip button, and offers Copy page link', ...);
test('Pro pages hide "Get your own TipMe page"', ...);
test('a 60-character name, 280-character bio, and no photo, role or links all hold at 320px', ...);
test('axe finds nothing on phone and desktop, in every payment state', ...);
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement** to the mockup's `Main`, `Phone` and `PhoneClosed` boards and spec §5. Log the replacement of the portrait-led layout, the owner's approval, and the cover colour exception. Check other surfaces that share `.profile-*` classes or `.tip-instrument`, including home, and keep them unchanged.
- [ ] **Step 4: Run** the page, checkout, quality and visual specs. Expected: PASS.
- [ ] **Step 5: Commit** `feat(profile): lead the public page with the person and the tip`

---

### Task 5: QR art renderer

**Files:**

- Create: `apps/api/src/qr/catalogue.ts`, `apps/api/src/qr/render.ts`, `apps/api/src/qr/mosaic.ts`, `apps/api/src/qr/covers-for-cards.ts`
- Modify: `apps/api/package.json` (`qrcode` 1.5.4, dev `jsqr` 1.4.0 at the web's pins; update the lockfile)
- Test: `apps/api/test/qr-art.test.mjs`

**Interfaces:**

- Consumes: scratchpad generators `qrgen/gen.cjs`, `gen2.cjs`, `art.cjs`, `mosaic.cjs` (same directory as Task 3's), to be turned into typed pure functions.
- Produces:

```ts
export const QR_ART: readonly {
  id: string;
  name: string;
  kind: 'style' | 'card' | 'photo';
}[]; // spec §7
export function renderQrArt(input: {
  id: string;
  url: string;
  photo?: Buffer;
  preview: boolean;
  size: number;
}): Promise<Buffer>; // PNG
```

Rules from the generators that must survive: finder, separator, timing, format strips and alignment patterns stay solid; decoration keeps a clear gap around the code; mosaic forces each module's centre 3 of 7 sub-cells. Error correction: H for art with holes or fine shapes; otherwise Q. Preview burns in the "Preview" mark. Text marks use outlined paths, not server fonts.

- [ ] **Step 1: Write the failing tests**

```js
for (const art of QR_ART) for (const handle of ['dr7', 'a_thirty_character_handle_abcde'])
  test(`${art.id} scans at 1000 and 300 pixels for ${handle}`, ...); // jsQR reads exactly the url
test('a preview is marked and never encodes the given url when told not to', ...);
test('all module colours contrast at least 4.5:1 with the light behind them', ...);
test('mosaic refuses without a photo, and scans with a dark, a light and a busy photo', ...);
test('a Pro render does not embed the photo metadata', ...);
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** A design that can't pass at both sizes is dropped from the catalogue and listed in the report, not weakened in the test.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(qr): server-drawn Pro QR designs`

---

### Task 6: QR studio and the Free lock

**Files:**

- Create: `apps/api/src/qr/qr-art.controller.ts`, `apps/web/src/app/dashboard/qr/formats/*`, `tests/integration/qr-art-api.test.mjs`
- Modify: `apps/web/src/app/dashboard/qr/qr-studio.tsx`, `apps/web/src/app/dashboard/qr/print/*`, `apps/web/src/lib/qr-render.ts` (remove premium styles and the `premium` field), `packages/contracts/src/profiles.ts` (`qrStyle` validated against the free styles plus `QR_ART` ids), `packages/database/src/operations/profiles.ts`, `apps/api/src/checkout/rate-limit.guard.ts` (`qr_art`), `apps/web/src/app/globals.css`
- Test: `tests/e2e/qr.spec.ts`, `tests/integration/qr-art-api.test.mjs`

**Interfaces:**

- Consumes: `renderQrArt`, `QR_ART`.
- Produces: `GET /v1/me/qr-art` (catalogue with `locked` per item) and `GET /v1/me/qr-art/:id.png?size=` (session required; size limited to a fixed list; `Cache-Control: private, no-store`). A Pro page gets its real link plus `?src=qr`; a Free page gets a preview encoding `<web origin>/?src=qr-preview`.

- [ ] **Step 1: Write the failing tests**

```js
test('a Free page gets a marked preview that encodes the home page, never its own link', ...); // jsQR
test('a Pro page gets its real link', ...);
test('a page that loses Pro gets a preview on its next request', ...);
test('a Free page cannot save a Pro design as its style; a Pro page can; leaving Pro falls back to purple on screen', ...);
test('old sunset, glow and stripe values show purple', ...);
test('another person cannot fetch your art; no session is 401', ...);
test('unknown ids and sizes are refused, and renders are rate limited', ...);
test('Pro art is not in any web bundle', ...); // grep the built client chunks for art ids' drawing code
```

e2e: Free opens a Pro design, sees the mark and "Upgrade to use this design", and print, share and full screen are absent; a scan of its downloaded screenshot image reaches home. Free styles still print and share. Pro uses a design, prints each format, and the print view's code scans.

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement** to the mockup's `QrDesigns`, `QrStyles`, `QrFormats`, `QrArt`, `Collections` and `QrLocked` boards. Formats are browser layouts around the server image, with no server fonts. "Upgrade" leads to the existing Pro explanation, since no billing exists.
- [ ] **Step 4: Run** the files above and `pro.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(qr): Pro designs and formats, with a Free preview`

---

### Task 7: Cover chooser, Pro page copy, and documents

**Files:**

- Create: `apps/web/src/components/account/cover-settings.tsx`
- Modify: `apps/web/src/app/dashboard/settings/settings-view.tsx`, wherever Free and Pro are explained to users (`pricing.spec.ts` names the page), `docs/00-DECISIONS.md`, `docs/runbooks/issues-inbox.md` or the page-admin runbook (staff handle allowance), `docs/design/DECISION-LOG.md`
- Test: `tests/e2e/cover-settings.spec.ts`, `tests/e2e/pricing.spec.ts`

**Interfaces:**

- Consumes: Task 2's routes and catalogue; `<ProfileCover>`.

- [ ] **Step 1: Write the failing tests**

```js
test('choosing a design and colour previews at once and shows on the public page after saving', ...);
test('colour choices appear only for designs that take them, with visible names', ...);
test('uploading a cover wins over a design; removing it returns to the chosen design', ...);
test('a bad file shows the same plain errors as photos', ...);
test('"If you don\'t choose, we\'ll pick one for your page." appears until a choice is made', ...);
test('the Pro explanation lists QR designs, three handle changes and no footer link, with no price', ...);
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement** to the mockup's `CoverPicker`. Update the decisions record with the handle rule, what Pro includes and what stays open (pricing).
- [ ] **Step 4: Run** those, then the full serial integration suite, `pnpm test`, lint, and the whole e2e suite on desktop and mobile. Expected: PASS, every failure named.
- [ ] **Step 5: Commit** `feat(covers): choose a cover in Settings, and document Pro`
