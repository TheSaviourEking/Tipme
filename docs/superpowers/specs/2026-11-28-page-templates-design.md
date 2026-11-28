# Page Studio: page templates (design)

**Date:** 28 Nov 2026 · **Status:** design draft for review · **Base:** `origin/dev` at `25c862c9`

**What this is.** The design for **page templates**: ready-made starting points a person switches to, built as presets on the two Pro styles **Creator** and **Professional**. It sits on two earlier designs, which still apply unless this document names a change (section 15):

- `docs/superpowers/specs/2026-11-17-page-studio-styles-design.md`, "the styles spec" (curated styles, no free controls). "§n" points into it.
- `docs/superpowers/specs/2026-11-27-studio-creator-professional-design.md`, "the C/P spec". "C/P §n" points into it.

Templates come **after** the Creator and Professional build (`docs/superpowers/plans/2026-11-27-studio-creator-professional.md`, "the C/P plan"). Nothing here starts before PR B of that plan is merged to `dev`.

**Sources.**

- The canvas "Studio Page Styles", https://claude.ai/artifact/CFaqbtC1zkoyvVqNVhFz4q, rows "New Pro styles" and "Templates · draft". The draft row has six template boards: Personal / Lifestyle (Creator, light), Musician (Creator), Restaurant (Creator), Consultant (Professional), Seller (Professional), Church / Ministry (Professional, TipMe Giving). They are the visual reference for templates. They stay drafts until the owner approves them, and a board then wins on any look (§0), except where section 15 names a difference.
- The owner's mockups. The image read for this design (`creator-professional-mockup.png` in the session scratchpad) is the two-phone Creator/Professional mockup, **not** the three sheets of ten phones (personal, business, giving). The phase 1 catalogue was therefore picked from the six canvas drafts and the template names the owner gave. The owner approved that catalogue on 28 Nov (6.1).
- **Design reference (owner rule: one design artifact).** The canvas boards in the existing "Studio Page Styles" artifact are the design reference for templates. No new artifact is made. The repo's visual snapshots (section 14) hold each template at phone 390 **and** desktop 1440.
- **`docs/design/reference/tipme-interface-directions.png` is still missing** (`VISUAL-QUALITY-GATE.md`, `docs/design/reference/README.md`). It does **not** block these PRs. The nine styles shipped the same way: they were checked against their canvas boards and the visual-quality gate, and no board-parity claim was made against that file.
- The built code on `dev`: `packages/contracts/src/studio-styles.ts`, `studio-document.ts`, `studio-check.ts`, `social-links.ts`, `copy.ts`; `apps/web/src/components/studio-styles/`; `apps/web/src/components/appreciation-form.tsx` (`TipSkin`); `apps/web/src/app/dashboard/studio/` (the editor); `apps/web/src/app/dashboard/welcome/welcome-view.tsx` (setup); `apps/web/src/app/b/[business]/…` (business pages).

**Not an approval.** This is a product and design decision only. It is not legal, data-protection, regulatory or payment-partner approval. D-07 stays OPEN (`docs/00-DECISIONS.md`). Nothing here changes a fee, a minimum, a checkout amount, a ledger posting or a payout. The `page_studio` switch stays off in production; templates add nothing to its preconditions beyond what the C/P spec already lists, apart from the template fixtures joining the `perf:lab` re-run (section 13).

**How decisions are marked** (as in the styles spec):

- **(owner decided)**: the owner's words or ruling, 27–28 Nov 2026. Binding.
- **(my call)**: decided by the coordinator who wrote this document, with a one-line reason. Change one only through the coordinator.
- **(builder's call)**: the builder decides, within the rules given, and says what they chose in the PR.

---

## 1. Intent

A person picks "Musician" or "Consultant" and gets a finished page in one tap: the right style, accent and mode, a few empty starter blocks, suggested link rows and tip wording that fits what they do. Then they fill it with their own photos, name, bio and links. They never type the page's chrome words; they choose them from short lists.

## 2. Owner decisions this design carries

1. **Templates are themes a person switches to, built as presets on Creator and Professional, not 20 new styles (owner decided).** Both styles are Pro, so **templates are Pro**. Free users can preview them, as with other Pro styles (§12.4); on lapse they behave as Pro styles do (§12.5, C/P §7.7).
2. **Wording comes from lists (owner decided):** "the wording should be from a list of options. The idea is we give the templates and they edit it with their data."
   - The **tip button wording** and **each link row's label** are chosen from per-template option lists. There is no free text.
   - The template pre-fills structure: style, accent, starter blocks, suggested link rows, tip wording.
   - The person enters their own URLs, photos, name and bio. They can swap a row's label for another from the list, remove or add rows (labels from the list) and reorder.
3. **Standing rules (owner decided):**
   - the header shows **only the TipMe logo**, with no menu button (19 Nov);
   - **no verified tick**; **"Powered by tipme" stays** (27 Nov);
   - **featured products link out.** TipMe takes no product payments, so nothing may look like a checkout;
   - **church and nonprofit templates start a TipMe Giving organisation**, not a personal page;
   - **business templates** (hotel, lounge, restaurant, club, gym, spa, retail, real estate, events, travel) **apply to the TipMe for businesses page**;
   - users never see the payment provider's name ("our payment partner");
   - no copy implies regulatory approval.
4. **Switching changes only the look (owner decided).** Nobody's existing content is moved without them asking, the same rule as Creator/Professional's "Start with this layout" (C/P §7.6).

## 3. Approaches

- **A. Presets on the two styles (chosen).** A template is data: a style id, an accent, a mode, starter blocks and two option lists. Every guarantee of the style system (exhaustive contrast, render matrix, CSS and font budgets, Free and Pro on the server, lapse) already covers it, because a template can only produce a combination the C/P build has proven. New work is the option lists, three optional document fields and the picker.
- **B. Twenty separate styles (rejected).** Each would need its own neutrals, sheet, contrast proof, snapshots, board and miniature, and the CSS budget would grow per style. The looks would drift apart over time, and the owner ruled it out.
- **C. A free-form builder (rejected).** Free colour, layout or text controls break the owner's 16–17 Nov rule of curated styles with no free controls, and free text on public pages needs moderation TipMe doesn't run.

## 4. Goals and non-goals

**Goals**

- A person goes from "What best describes you?" to a finished-looking draft in one choice, then fills it in.
- Every word on the page that the person didn't type comes from a fixed list in contracts, one translatable source.
- Applying, changing or removing a template never moves, deletes or rewrites the person's content.
- No visible change for any page that doesn't use a template. Classic stays byte-identical, and the C/P snapshots don't move.

**Non-goals (phase 1)**

- New block kinds (the product card and the two-tile grid are phase 2, section 11).
- Business and giving templates (phases 2 and 3, section 12).
- Free text anywhere, brand-logo icons, a verified mark, analytics.
- `mailto:` or `tel:` link rows. The links model is https only (`social-links.ts`); changing that is a separate links decision **(my call:** it would widen what a public page can link to, and the link-page and redirect rules don't cover it**)**.

---

## 5. What exists today

- **Styles:** nine on `dev`; Creator and Professional are being built (C/P plan). The C/P spec fixes each style's tip label per skin (C/P §6.5: Creator "Support my work" / "Give, tip or appreciate"; Professional "Send a ₦2,000 tip") and lists **"no custom link titles"** as a non-goal (C/P §4). Templates replace both rules, with labels from option lists (section 15).
- **Links:** stored on the profile, `profiles.links` (jsonb `SocialLink[]`: `platform`, `url`, `featured?`), edited outside Studio and live as soon as saved. `SOCIAL_PLATFORMS` gives each site fixed `featured` words ("Watch me on YouTube"). The C/P build adds `place: 'icon' | 'row'` per site and uses `featured` as each row's label (C/P §5.4).
- **Studio document:** v2 (`style`, `accent`, `mode`, `cover`, `blocks`), strict for writes, `resolveStudio` for reads, draft and published in `page_studios`.
- **Starter blocks:** C/P §7.6 adds "Start with this layout" for an empty draft. Kinds that can be empty and that `isEmpty` catches: text, quote, gallery, services, events.
- **Setup:** `welcome-view.tsx` has hello, three steps (about, bio, live) and done.
- **Business pages** (`/b/<business>`, `/b/<business>/<location>`, `/b/…/<handle>`) **cannot render Studio styles.** They use their own components (`BusinessHeader`, location cards). A business has no Studio document, no links list and no blocks. The planned Business Pro "branded page" (`docs/superpowers/plans/2026-11-14-business-pro-and-signup.md`, Tasks C6–C7) is a cover, a free `brand_color` and a welcome line, which is not a Studio style and is not built (no `business_brands` table on `dev`). Team tips at a location exist (business release 2).
- **Giving pages cannot render Studio styles either.** Giving is not built on `dev`. Its phase 1 plan (`docs/superpowers/plans/2026-11-26-tipme-giving-phase1.md`) stores `studioStyle` and `studioAccent` on the organisation and applies `studioTokens` colours to its own `.giving-public` page: colours only, with no Studio renderer, blocks, link rows or tip skin.

---

## 6. The catalogue

### 6.1 Phase 1: personal templates on Studio (owner decided, 28 Nov: "go with your picks")

The owner approved this catalogue as proposed. Other personal templates are added later as data; business and giving follow in later phases (6.2).

**(my call:** personal pages already render Studio styles, so these need no new page type; business and giving need the work in section 12 first**)**

| id           | Name                   | Style        | Accent              | Mode  | Starter blocks (empty)                          | Board                                          |
| ------------ | ---------------------- | ------------ | ------------------- | ----- | ----------------------------------------------- | ---------------------------------------------- |
| `personal`   | Personal and lifestyle | Creator      | Green               | light | heading · gallery · paragraph                   | drawn                                          |
| `musician`   | Musician               | Creator      | Rose                | dark  | heading · gallery · heading · events · quote    | drawn                                          |
| `creator`    | Content creator        | Creator      | TipMe purple (null) | dark  | heading · gallery · heading · paragraph · quote | the C/P Creator board                          |
| `consultant` | Consultant             | Professional | Ink                 | light | heading · paragraph · heading · services        | drawn                                          |
| `seller`     | Seller                 | Professional | Blue                | light | heading · gallery · heading · paragraph         | drawn (without the product card, section 11.1) |
| `creative`   | Artist or designer     | Professional | Violet              | light | heading · gallery · heading · services · quote  | to draw (section 16)                           |

- The four drawn personal boards are taken as drawn: style, accent and mode read off them.
- `creator` is the C/P Creator mockup as a template, so a person who picks "Content creator" gets exactly the look the owner first asked for. **(my call)**
- `creative` covers photographers, illustrators and designers, the largest personal group the drawn set misses. **(my call)** Its board is drawn before its PR (section 16).
- Starter blocks follow C/P §7.6: empty, appended in order, only kinds that can be empty, at most 6, no photo or video blocks. Placeholder hints are per template (section 7.3) and never stored.
- Each template also lists its link-label options and tip-label options (section 7.2).

### 6.2 Later phases

- **Phase 2, business** (owner decided list): hotel, lounge, restaurant, club, gym, spa, retail, real estate, events, travel. They apply to the TipMe for businesses page (section 12.1). The drawn Restaurant board is the reference for the set.
- **Phase 3, giving:** church / ministry (drawn) and nonprofit at least. They start a TipMe Giving organisation (section 12.2).
- The remaining personal entries on the owner's sheet are **data-only additions** in the same shape once phase 1 has shipped (owner decided, 28 Nov).

---

## 7. Data

### 7.1 The template (contracts: `packages/contracts/src/studio-templates.ts`)

```ts
export type StudioTemplateId =
  'personal' | 'musician' | 'creator' | 'consultant' | 'seller' | 'creative';

export interface StudioTemplate {
  id: StudioTemplateId;
  audience: 'personal'; // 'business' | 'giving' join in phases 2 and 3
  style: 'creator' | 'professional';
  accent: StudioCuratedAccentId | null; // null = the style's own default
  mode: StudioMode; // applied with the template (section 9.1)
  starter: readonly {
    kind: 'text' | 'quote' | 'gallery' | 'services' | 'events';
    variant?: 'heading' | 'paragraph';
    hint?: TemplateHintId;
  }[];
  /** Suggested rows, in order, shown in the editor only until the person adds the link. */
  suggestedRows: readonly LinkLabelId[];
  /** Every label a row on this template may use. Includes every suggested row's label. */
  linkLabels: readonly LinkLabelId[];
  /** Tip wording choices. The first is the default. */
  tipLabels: readonly TipLabelId[];
}
export const STUDIO_TEMPLATE_IDS: readonly StudioTemplateId[];
export const STUDIO_TEMPLATES: Record<StudioTemplateId, StudioTemplate>;
```

- A template holds **ids only**. Its name, its one-line description, every label and every hint are words in the copy file (7.3).
- `accent` is always a curated accent or null, never `'photo'`. "From your photo" stays the person's own later choice. **(my call:** a template can't know the photo**)**
- Every combination a template can produce is one the C/P exhaustive tests already prove (style × curated accent × mode), so templates add **no contrast pair**.

### 7.2 Label lists

**Link labels** (`LINK_LABELS: Record<LinkLabelId, { sites: readonly SocialPlatform[]; glyph?: RowGlyphId }>`):

- Each label names the **sites it may sit on**, so a label never promises a different destination ("Listen on Spotify" can't sit on a YouTube link). **(my call:** a mislabelled link misleads supporters**)**
- `glyph` is an optional generic icon (section 8.3). With no glyph, the row shows the site's badge.
- Phase 1 list (text · sites · glyph). "web" means `website`:

| id                  | Text                  | Sites                                                         | Glyph    |
| ------------------- | --------------------- | ------------------------------------------------------------- | -------- |
| `listen-spotify`    | Listen on Spotify     | spotify                                                       | (badge)  |
| `listen-applemusic` | Listen on Apple Music | applemusic                                                    | (badge)  |
| `listen-audiomack`  | Listen on Audiomack   | audiomack                                                     | (badge)  |
| `listen-boomplay`   | Listen on Boomplay    | boomplay                                                      | (badge)  |
| `listen-soundcloud` | Listen on SoundCloud  | soundcloud                                                    | (badge)  |
| `stream-new-song`   | Stream my new song    | spotify, applemusic, audiomack, boomplay, soundcloud, youtube | (badge)  |
| `watch-youtube`     | Watch on YouTube      | youtube                                                       | (badge)  |
| `watch-videos`      | Watch my videos       | youtube, tiktok, instagram, facebook                          | (badge)  |
| `watch-live`        | Watch me live         | twitch, kick, youtube, tiktok                                 | (badge)  |
| `follow-instagram`  | Follow on Instagram   | instagram                                                     | (badge)  |
| `follow-tiktok`     | Follow on TikTok      | tiktok                                                        | (badge)  |
| `connect-linkedin`  | Connect on LinkedIn   | linkedin                                                      | (badge)  |
| `join-community`    | Join my community     | whatsapp, telegram                                            | people   |
| `join-channel`      | Join our channel      | whatsapp, telegram                                            | people   |
| `support-patreon`   | Support me on Patreon | patreon                                                       | (badge)  |
| `read-newsletter`   | Read my newsletter    | substack                                                      | pen      |
| `read-articles`     | Read my articles      | substack, linkedin, web                                       | pen      |
| `my-blog`           | My blog               | web, substack                                                 | pen      |
| `my-portfolio`      | My portfolio          | web                                                           | grid     |
| `my-photos`         | My photos             | instagram, web                                                | image    |
| `travel-diaries`    | Travel diaries        | web, youtube, instagram, tiktok                               | plane    |
| `behind-the-scenes` | Behind the scenes     | youtube, tiktok, instagram                                    | (badge)  |
| `book-a-call`       | Book a call           | web                                                           | calendar |
| `book-me`           | Book me               | web, whatsapp, telegram                                       | calendar |
| `book-a-session`    | Book a session        | web, whatsapp, telegram                                       | calendar |
| `view-services`     | View services         | web                                                           | grid     |
| `get-in-touch`      | Get in touch          | web, whatsapp, telegram                                       | chat     |
| `say-hello`         | Say hello             | web, whatsapp, telegram                                       | chat     |
| `shop-all`          | Shop all products     | web, selar, instagram                                         | bag      |
| `visit-store`       | Visit our store       | web, selar                                                    | bag      |
| `shop-prints`       | Shop my prints        | web, selar                                                    | bag      |
| `track-order`       | Track your order      | web                                                           | truck    |
| `contact-support`   | Contact support       | web, whatsapp, telegram                                       | headset  |

- The board's "Book a strategy call" becomes **"Book a call"** and "Track order" becomes **"Track your order"**, to fit the length cap and read as an invitation. **(my call)**
- Every label above was measured on 28 Nov in Studio Inter (`apps/web/public/fonts/studio/inter-400-800.woff2`, 15 px, weight 600, in Chromium). The widest is "Support me on Patreon" at 149.3 px, so all fit the 152 px cap (7.3).
- **Short row words for four sites (my call:** the owner's one-line rule, 7.3**).** Four sites' fixed `featured` words are over the cap: "Join my WhatsApp channel" 177.7 px, "Watch me live on Twitch" 157.8, "Follow me on Instagram" 156.3, and "Follow me on Facebook" 151.3 (inside the cap by under 1 px, so too close). Wherever "the site's own words" show on a Creator or Professional row, these four use a row form from the copy file instead: "My WhatsApp channel" (148.1), "Watch live on Twitch" (134.9), "Follow on Instagram" (133.3) and "Follow on Facebook". The featured key's words elsewhere don't change. The cap test (14.2) covers every string a row can show, so a site added later needs a row form if its words don't fit.
- **"The site's own words"** is always an option on every row: it is the site's `featured` words, exactly as the C/P build renders (stored as no label, 7.4).
- Adult sites (OnlyFans, Fansly) appear in **no** label's `sites`, so they always keep their fixed words. **(my call:** no template should suggest or dress up an adult link; the owner's adult-links rules stay as they are**)**

**Tip labels** (`TIP_LABELS: Record<TipLabelId, …>`), per template, the first is the default:

| Template     | Options (default first)                                                   |
| ------------ | ------------------------------------------------------------------------- |
| `personal`   | Appreciate me · Support my work · Send some love · Say thank you          |
| `musician`   | Tip the artist · Support my music · Support my work · Show some love      |
| `creator`    | Support my work · Support my content · Fuel my next video · Appreciate me |
| `consultant` | Send a tip · Say thank you · Appreciate my work                           |
| `seller`     | Support our brand · Send a tip · Say thank you                            |
| `creative`   | Support my art · Send a tip · Appreciate my work                          |

- Each tip label has two renderings, both in the copy file:
  - `line`: the words alone ("Tip the artist"), Creator's line 1. Creator's line 2, "Give, tip or appreciate", stays fixed (C/P §6.5).
  - `withAmount(amount)`: Professional's pill, "Tip the artist · ₦2,000". The one exception keeps the C/P wording: "Send a tip" renders "Send a ₦2,000 tip". With no valid amount, or when the amount doesn't fit (8.1), the pill shows `line`.
- **Banned in any tip label (my call):** "donate", "donation" (it implies a charity on a personal page), "buy", "pay", "order", "checkout", "price" (a tip must never look like a purchase), and any word implying verification, licensing or approval. Link labels may say "Shop" or "Order", because they visibly link out (section 8.2), but never "Pay" or "Checkout".

### 7.3 One translatable source (my call)

- Every word lives in **one client-safe file**, `packages/contracts/src/template-copy.ts`, with no imports, exported as `@tipme/contracts/template-copy` and re-exported by the barrel, exactly as `copy.ts` is. **(my call:** a public page can then read labels without shipping zod, and a future translation has one file to translate**)**
- It holds `TEMPLATE_COPY.name`, `.describe` (one line each, for the picker), `.link` (per `LinkLabelId`), `.tip` (per `TipLabelId`, `line` and `withAmount`) and `.hint` (starter placeholders, e.g. "e.g. My music", "e.g. Upcoming shows", "e.g. What I offer").
- `apps/web/test/contracts-client-imports.test.mjs` gains the new entry, so the no-imports rule is enforced.

**Length caps (my call; owner's visibility rule, 28 Nov: link labels stay on one line in both styles at 320 px, in English):**

Text widths at 320 px, from the C/P geometry (C/P §7.1, §7.2) and the drawn boards:

| Where                      | Sum                                                                                                                                         | Text width |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Creator row                | 320 − 2×20 gutter = 280 row; − 12 and 14 padding − 2 border − 32 badge − 16 chevron − 2×12 gaps                                             | **180 px** |
| Professional row (in card) | 320 − 2×12 card inset = 296 card; − 2×20 card padding (board) = 256 row; − 12 and 14 padding − 2 border − 32 badge − 16 chevron − 2×12 gaps | **156 px** |
| Creator Tip line 1         | 280 button − 20 and 18 padding − 24 heart − 18 chevron − 2×14 gaps (the amount has wrapped under line 2, C/P §6.5)                          | **172 px** |
| Professional pill text     | 256 pill − 2×20 padding − 18 heart − 8 gap                                                                                                  | **190 px** |

- The card padding (20) and pill padding (20) are read off the boards, because the C/P spec doesn't state them. The builder takes the real values from the built C/P CSS and sets the constants in 8.1 from them. **(builder's call:** the measurement test in 14.2 is the arbiter**)**
- **Link label: at most 152 px** of Studio Inter 15 px 600, measured. That is the tighter style's width (Professional, 156) less 4 px for rendering differences between platforms. A unit test also holds a coarse guard of 22 characters. **No link label wraps in English.** A future translation may wrap to two lines; the row grows and nothing clips.
- **Tip label `line`: at most 168 px** of Studio Inter 17 px 650 (Creator's 172 less 4), and at most 20 characters. The widest, "Appreciate my work", is 148.9 px.
- **The Professional pill** follows the rule in 8.1. A label that fits only without the amount is kept: it shows label-only.
- A contracts unit test asserts the character guards. A Chromium measurement test (14.2) asserts the pixel caps on every string.

### 7.4 The document (v2, three optional fields)

```ts
interface StudioDocument {
  // … v2 as today
  template?: StudioTemplateId | null;
  tipLabel?: TipLabelId | null; // null or absent = the template's first
  linkLabels?: { link: string; label: LinkLabelId }[]; // `link` = linkKey(url)
}
```

- **No version bump (my call):** the fields are optional and absent means exactly today's page. `isClassicDefault` is unchanged, Classic stays byte-identical and no stored document changes. A bump is for changed meaning, and nothing existing changes meaning.
- **A row stores a label id, never text (owner decided item 2; shape my call).** Labels sit in the Studio document rather than on `profiles.links` so they go through draft, preview, undo, discard and publish like every other look choice, while links stay live data. **(my call)**
- `link` is `linkKey(url)` (the normalised key the links schema already dedupes on), so reordering links keeps labels. A label whose link is gone is dropped on read and on the next save.
- **Strict schema (writes):**
  - `template` must be a known id; `tipLabel` must be in that template's `tipLabels`; each `linkLabels[].label` must be in that template's `linkLabels`; at most `STORED_LINK_LIMIT` entries; no `link` twice.
  - `tipLabel` or `linkLabels` without a `template` is refused.
  - Label-to-site fit is **not** checked on write, because the links can change in Settings without a Studio save. It is applied on read.
- **`resolveStudio` (reads), never throws:** unknown template → null and both other fields dropped; unknown or out-of-list labels dropped; a label whose link is missing, hidden or on a site outside the label's `sites` is ignored for that render. Idempotent, as today.
- **When the template applies:** only while `style === STUDIO_TEMPLATES[template].style` and the page shows that style (Pro, not lapsed). Otherwise the page renders the style's own fixed labels and the fields stay stored. **(my call:** switching style changes only the look, and switching back restores the person's choices, the same "nothing is deleted" rule as lapse**)**

### 7.5 API, gating and the design check

- **No new route.** Everything saves through `PUT …/draft` and publishes through the existing publish.
- **Free:** `PUT …/draft` refuses a Free **change** to `template`, `tipLabel` or `linkLabels` with 403 `STUDIO_PRO_REQUIRED`; unchanged stored values are accepted, so a lapsed person can still save other edits (the existing rule for Pro styles). Publish already refuses a Pro style on Free (422 `pro-only`), and a template is only shown on its Pro style.
- **Design check: no new rule and no version bump (my call).** Labels can't be empty or misfit after resolve, and starter blocks are caught by `empty-block` as in C/P §7.6. `DESIGN_CHECK_VERSION` stays 3.
- **`PublicStudio`** carries the document as today; the renderer resolves label text from the copy file on the server.

---

## 8. Rendering

### 8.1 The tip button

- `AppreciationForm` takes an optional `tipLabel?: TipLabelId`. With none, the skin's fixed C/P label renders exactly as built.
- **Creator:** line 1 is the label's `line`; line 2 stays "Give, tip or appreciate". Accessible name: "{line}, tip ₦2,000" ("{line}" with no valid amount).
- **Professional, "label · amount" or label only (my call:** the amount must never clip or wrap the pill, and the chips and the sticky bar already show it**):**
  - The pill shows `withAmount(amount)` only when it fits on one line in the 320 px pill. Otherwise it shows the label alone. The same rule holds at every width, so the pill never changes form between devices.
  - The rule is arithmetic, so the server and the client agree and nothing shifts. The page reads no layout:
    `fits = labelWidth[tipLabel] + 12.75 + amountWidth(amount) ≤ 186`.
    - `labelWidth` is each label's measured width at 17 px 600, a generated constant in `template-copy.ts`.
    - 12.75 is " · ". For "Send a tip", the form is `77.0 + amountWidth` ("Send a " + " tip").
    - `amountWidth` = 12.28 (₦) + 8.5 × digits + 4.25 × (commas + points). The figures are tabular, so the width depends only on the characters.
    - 186 is the 190 px pill text width less 4 px.
  - The test (14.2) re-measures every constant in Chromium to within 0.5 px.
  - Examples, measured 28 Nov: "Tip the artist · ₦100,000" 175.4 fits; "Support my work · ₦2,000" 191.8 shows "Support my work"; "Send a ₦1,000,000 tip" 157.3 fits.
  - **The largest amount:** there is no tip maximum (`packages/domain/src/fees.ts`), and the form accepts up to 12 digits of kobo (`checkout.ts`), so the largest is ₦9,999,999,999.99 (131.3 px). It shows label-only for every label except "Send a tip" (208.3, also label-only). `pro.ts` `limits.maxMinor` is the Pro price's limit, not a tip limit.
  - **Accessible name:** "{line}, ₦2,000" when label-only, or the visible text when the amount shows. The amount is always spoken.
- The sticky phone bar keeps "Tip ₦…" in every case (§13). "Starting your tip…" and every closed, error and Custom state are unchanged.

### 8.2 Link rows

- **A labelled link is a row (my call).** A link with a label renders as a row even if its site's `place` is `icon`. That is how the drawn Musician board shows "Follow on Instagram" as a row. Each link still renders exactly once; the featured link is still the first row.
- The row's visible text is the chosen label. Without one, it is the site's `featured` words, or the site's short row form (7.2), as built.
- **A link whose URL changes loses its label (my call:** a label was chosen for that destination**).** The stored `link` key no longer matches, so the public page shows the site's standard words. On the next Studio open, the editor shows a one-line notice per affected link: "Your link to {Site} changed. Choose its label again." The stale entry is dropped on the next save.
- **Accessible name:** "{label}, {Site}{: handle}, opens in a new tab". A custom label never hides where the link goes. **(my call)**
- Rows are links out, with a chevron, never filled with the accent and never styled like the Tip button. **(owner decided item 3: featured content links out and never looks like a checkout)**

### 8.3 Row glyphs

- Eleven generic glyphs: `calendar`, `bag`, `chat`, `pen`, `grid`, `image`, `plane`, `people`, `truck`, `headset`, `menu`. They are inline SVG, stroke `currentColor`, drawn at 16 px, decorative. **(my call:** they match the drawn boards and need no brand rules**)**
- **The builder authors them** as SVG on the 24-unit construction grid, with optical alignment and rounded joins, per `docs/design/ICONOGRAPHY.md`. They are added to the canvas boards in "Studio Page Styles" for review **before PR 2** (section 16). **(my call:** icons are reviewed where the rest of the look is reviewed**)**
- **The disc** follows C/P's existing badge discs exactly: 32 px circle, `fg` on `el2`, a pair the C/P build proves.
- **Forced colours:** each disc gets a 1 px `CanvasText` border, and the glyph keeps `currentColor`, so the disc stays visible with no background. **(my call)**
- `menu` is for phase 2 (restaurant). All eleven together stay under 2 KB of markup. They are server-rendered, so they add no client script.

---

## 9. Applying a template

### 9.1 What changes (my call on each, within owner decision 4)

One application is **one undo step**, named "Undo: template applied". It sets:

- `style`, `accent` and `mode` to the template's;
- `template` to its id, `tipLabel` to null (the default);
- the cover type to "Your cover" when the style offers it (both do).

**Mode is part of the preset (owner decided, 28 Nov).** Applying a template sets the template's light or dark mode: "Personal" is Creator in light, so applying it sets light. The person can switch back in one tap. Switching **style** alone still keeps the person's mode (C/P §6.2; the 27 Nov rule stands for style switches).

### 9.2 What never changes

- Photo, cover photo, name, bio, links and blocks. Nothing is reordered or removed.
- **Existing links keep their words.** On a page that already has links, applying a template stores **no** labels. The editor shows each row with its current words and a one-tap suggestion when the template has a label that fits the site, e.g. "Use 'Listen on Spotify'". Nothing changes until the person picks it. **(my call:** owner decision 4**)**
- **Starter blocks only on an empty page.** If the draft has zero blocks, the editor offers "Add the {template} blocks" (C/P §7.6 mechanics: Pro only, one undo step "Undo: starter layout added", placeholders not stored). A page with blocks never gets them.
- **Hints after a reload (my call:** hints are never stored, yet they shouldn't vanish on reload**).** The editor derives them by matching the template's `starter` sequence against the page's blocks, by kind (and variant, for text) and order, from the first block. If the sequence matches, each still-empty block gets its template hint. If it doesn't, empty blocks get the generic hints the editor already uses.
- **Suggested rows** are never written anywhere. In the editor, each suggestion without a matching link shows as an empty row, e.g. "Listen on Spotify: add your link". It never appears on the public page.

### 9.3 Changing template, removing it, switching style

- **Another template:** sets the new preset. Labels not in the new template's list are dropped from the draft, as part of the same undo step. The editor says how many: "2 link labels go back to the site's own words." **(my call:** an out-of-list label would be refused on save; the person sees the effect and can undo**)**
- **"No template":** `template`, `tipLabel` and `linkLabels` are cleared, and the style, accent and mode stay as they are. One undo step.
- **Switching style** to anything but the template's style keeps all three fields and hides them (7.4). The Style tab says: "Your {template} wording shows when you use {style}."
- **Discard changes** returns everything to the published version, as built.

### 9.4 Free, Pro and lapse

- **Free** can open any template as a preview (§12.4): the status reads "Previewing a Pro style: not saved", and nothing is saved. Starter blocks and label pickers are hidden, as in C/P §7.6.
- **Lapse:** visitors see Classic (C/P §7.7); the template fields stay stored and return on renewal.

---

## 10. Picker UX

### 10.1 In Studio: a "Templates" section (my call)

- The section sits at the **top of the Style tab**, above the style cards, headed "Start from a template".
- It is a radio group of cards (`role="radiogroup"`). Each card shows a miniature (the style's miniature in the template's accent and mode), the name and the one-line description. A "No template" card comes first. On phones the cards scroll horizontally with snap; on desktop they wrap in a grid of three.
- **Card text caps (my call:** cards must line up and never clip**):** name at most 22 characters, description at most 48. Type sizes are fixed, the same as the existing style cards (`style-cards.tsx`: the name in `pst-card__name`, the description at the card's mood size). All cards are equal height (the tallest content sets one grid row). Tested at 320 (14.2).
- **Selected card in forced colours:** a 2 px `Highlight` outline plus the existing check mark, so the choice doesn't rely on colour or background. Unselected cards keep a 1 px `CanvasText` border. **(my call)**
- Choosing a card applies it to the draft at once (9.1) and the live preview updates. Under the group: "Your photo, bio, links and blocks stay as they are."
- With a template active (Pro), two sections follow:
  - **"Tip button wording":** a radio group of that template's tip labels, each previewed with an example amount.
  - **"Link rows":** each visible link, in page order, with a native `<select>` named "Words for your {Site} link". Its options are "The site's own words" plus each of the template's labels whose `sites` include that site. The template's suggested rows without a link follow, each with "Add link".
- **"Add link"** opens the existing links editor (the one in Settings) and saves the link live, as links always do. The label is pre-chosen in the draft. Row order and removal stay in the links editor; Studio doesn't duplicate them. **(builder's call:** an in-place dialog reusing the Settings component, or a link to `/dashboard/settings#links` that returns to Studio**)**
- The template's style card in the Style tab shows the usual check mark; changing style there is an ordinary style switch (9.3).

### 10.2 In setup: "What best describes you?" (my call)

- It is shown on the welcome flow's **done** screen, not as a fourth step. **(my call:** the three-step setup and its "Step n of 3" copy stay as they are, and nobody has to pass a Pro choice to finish setup**)**
- It shows the six template cards and "Skip". Choosing one goes to `/dashboard/studio?template=<id>`. Nothing is stored by the choice itself, and there is no new profile field.
- **No silent change (my call:** owner decision 4; an autosaved draft must not change from a link**).**
  - **New empty page** (Classic default, no blocks, no Studio row yet): the template applies straight away, on Pro to the draft, or as a preview on Free (9.4).
  - **Page with content** (any block, a non-default style, or a published design): the editor opens with a confirm, "Use the {template} template? Your photo, bio, links and blocks stay as they are." The buttons are "Use template" and "Not now". Nothing changes until the person confirms.

---

## 11. New block kinds (phase 2)

### 11.1 The featured item card (for Seller) (my call: phase 2)

**(my call:** a new kind must render in all eleven styles, enter the strict schema, `isEmpty`, the limits, the image pipeline and the render matrix, and needs a checkout-likeness review; Seller ships first with link rows and a gallery**)**

- Kind `product` (Pro): `{ imageId, name (one line, at most 60), priceMinor? (as `services`), url }`. The `url` follows `socialLinkProblem('website', …)`: https only, link-in-bio pages and redirects refused.
- **The call to action is fixed:** "Shop" with an outward arrow, accessible name "Shop {name}, opens in a new tab". It is drawn as an **outline** in `fg` on `control`, never the accent fill and never a button shape like the Tip.
- The card shows no quantity, no cart and no "Buy". A price, if given, is plain text. **(owner decided item 3: links out, never a checkout)**
- `isEmpty` and `empty-block` cover a card with no name or no url. Each card's photo counts toward `pageImages`.

### 11.2 The two-tile link grid (my call: phase 2, with business)

- This is **not a block.** It is a template-fixed row layout: `rowLayout: 'list' | 'tiles-2'` on the template, which draws the first two non-featured rows as two square tiles (glyph over label). For example a restaurant's "Our menu" and "Reserve a table".
- The person can't toggle it: it belongs to the template, like the tip line belongs to the style. **(my call:** no free layout control**)**
- It only matters for business templates, so it ships with them.

---

## 12. Business and giving (phases 2 and 3)

### 12.1 Business templates: what's needed first

Business templates apply to the TipMe for businesses page (owner decided). That page cannot render Studio styles today (section 5). Before any business template ships:

1. **A Studio document per business** (style, accent, mode, cover, blocks, template fields), with its own draft and publish. It is owned by the business and edited by its owners. It can reuse `page_studios`' shape keyed by `business_id`. **(builder's call** on table shape**)**
2. **The renderer takes an identity**, not a profile: name, logo (in place of the avatar), cover, meta line ("Restaurant, Yaba") and bio. `StudioStylePage` then renders `/b/<business>` and the location page.
3. **A links list for a business**, in the same `SocialLink` shape and rules.
4. **The tip button on a business page means a team tip at a location.** The drawn "Tip our team" uses the release 2 team tip. With several locations, the button leads to the location choice first. A business-wide tip that isn't a team tip is out of scope.
5. **Gating on Business Pro**, with lapse as in the business plan's R8.
6. **The planned branded page (C6–C7), a phase 2 question that doesn't block phase 1:** its free `brand_color` breaks the curated rule. The recommendation is that Business Pro's "branded page" becomes these Studio styles and templates. The owner decides before phase 2 is planned (section 17).

### 12.2 Giving templates: what's needed first

Church and nonprofit templates start a TipMe Giving organisation, not a personal page (owner decided). Giving is staging-only and not built on `dev`. Its plan applies Studio colours only. Before giving templates ship:

1. Giving phase 1 merged.
2. The same identity-driven renderer as 12.1, for `/give/<org>` (logo, cover, name, the organisation's type as meta).
3. **The gift form gets skins** like the tip form. The labels come from a giving list ("Give online", "Give today", "Support our work"), never "Tip". "Donate" is allowed here only, because the page belongs to a verified organisation. It is still copy, not a claim of tax status.
4. Choosing a church or nonprofit template from setup or Studio **routes to Giving registration** and doesn't change the personal page.

---

## 13. Accessibility and performance

**Accessibility (WCAG 2.2 AA, as §4.4):**

- The template group, tip wording and each row's label are native radio groups and selects with visible labels; focus moves to the preview's status line after applying ("Musician applied. Undo").
- Every row and icon keeps the C/P accessible names, plus 8.2's rule that a custom label never hides the site.
- Targets are at least 44×44; template cards at least 104 wide.
- Axe is clean per template per mode. Reduced motion: the card selection doesn't animate.
- Nothing truncates with an ellipsis. English link labels never wrap (7.3).

**The owner's four design tests (owner, 28 Nov: "contrast, visibility, smoothness, fluidity").** Each is defined so a test can fail it:

1. **Contrast.** Every text and non-text pair a template page draws is a WCAG pair proven in the contrast test: text 4.5:1, large text 3:1, UI 3:1, in light and dark.
   - Templates only choose combinations the C/P matrix already proves (7.1).
   - The glyph disc reuses the badge pair (`fg` on `el2`).
   - A unit test asserts that every template's style × accent × mode is in the proven set.
2. **Visibility.**
   - Type sizes are the C/P sizes. Targets are at least 44×44.
   - No clipping and no overlap at 320, 390 and 430 (`geometryProblems` empty), with English link labels on one line (7.3).
   - In forced colours (`forced-colors: active`), the Tip, rows, chips, glyph discs and the selected template card stay visible with borders or outlines (8.3, 10.1).
   - At 200% zoom (a 1280 px viewport zoomed to 640 CSS px), the page reflows with no horizontal scroll and no lost content.
3. **Smoothness** (`docs/design/EXPERIENCE-AND-MOTION.md` §9–10), measured in Playwright with CPU throttling on the `/@tpl<id>` fixtures:
   - CLS below 0.1, and 0 on the Tip action; the label-only rule (8.1) is arithmetic, so it can't shift.
   - INP below 200 ms for pressing a chip and the Tip.
   - Only `transform` and `opacity` animate, checked by a test that reads the computed `transition-property` of every animated element.
   - Reduced motion is honoured: final screens match with it on.
   - **"Apply template" in the editor** has an INP budget of 200 ms on the same throttled profile. The live preview must swap to the target style without waiting for its sheet to load, so the editor **preloads the style sheets of the templates' two styles** (Creator and Professional) when the Templates section mounts. **(my call:** the two sheets are a few KB each and the editor already loads its preview styles**)**
4. **Fluidity.** The layout holds at every width from 320 to 1440: tested at 320, 360, 390, 430, 768, 1024, 1280 and 1440, with no horizontal overflow (`scrollWidth ≤ clientWidth`) and the C/P DOM order at each.

**Performance (§4.3 budgets, unchanged):**

- No new public-page client script: label text and glyphs are server-rendered, and `template-copy.ts` has no imports.
- The C/P 3 KB script-delta test and `scripts/web-bundle.test.mjs` must not move.
- CSS: rows and glyphs reuse the C/P sheets. Any addition stays inside the 12 KB styled-page budget, and Classic's 8 KB doesn't move.
- One template fixture per phase-1 template (`/@tpl<id>`) joins `tests/e2e-perf/lcp.spec.ts` at under 2000 ms and the pre-switch `perf:lab` re-run.
- The template catalogue (`studio-templates.ts`) is imported by the editor and the API only.

---

## 14. How we know it's right (evidence each PR records)

1. **Contracts (unit):**
   - Every template's style is `creator` or `professional`, its accent curated or null, its labels and hints exist, and its suggested rows are inside its `linkLabels`.
   - Every link label's `sites` are real catalogue keys and contain no adult site.
   - The character guards hold (link 22, tip 20, card name 22, description 48), and no string contains a banned word or the payment provider's name (the copy grep, §14.10).
   - The label-only rule: `fits` is true and false exactly where 8.1's measured examples say, and false for every label with ₦9,999,999,999.99.
   - Every template's style × accent × mode is in the proven contrast set.
   - The starter-hint matcher: an exact starter sequence gets template hints, and a reordered or edited sequence gets generic hints.
   - Schema: an unknown template is refused, as are a tip label outside the template's list, a link label outside it, labels without a template, and a duplicate `link`.
   - Resolve: unknown values are dropped, and misfit labels are ignored for the render. Idempotent. A fast-check property: any resolved document passes the strict schema.
   - A document with none of the three fields is byte-identical through resolve.
2. **Render (web unit and e2e):**
   - Each phase-1 template × light and dark × 320, 390, 768, 1024 and 1440: axe clean, no horizontal overflow, no clipped text.
   - **Measurement test (Chromium, Studio Inter):** every link label and every short row word is at most 152 px; every tip `line` is at most 168 px; every `labelWidth` constant is within 0.5 px of measured.
   - At 320 in both styles, every link label renders on one line (the row's label box height equals one line height) for the longest label in each template.
   - Professional at 320 with the longest tip label and ₦9,999,999,999.99 typed into Custom shows the label only, with no clipping, and the accessible name ends with the amount. With "Tip the artist" and ₦100,000 it shows both.
   - The changed-URL case: after a link's URL changes, the public row shows the site's standard words.
   - The four design tests of section 13: contrast, visibility (320/390/430, forced colours, 200% zoom), smoothness (CLS, INP, transform/opacity only, reduced motion) and fluidity (320–1440, no overflow) on every `/@tpl<id>` fixture.
   - Template cards at 320: names and descriptions at their caps fit, and all cards are the same height.
   - Each link renders once. A labelled icon-site link becomes a row; the featured link is still first.
   - Labels show only when the style matches the template; switching style shows the fixed C/P labels.
   - The row's accessible name includes the site. No menu button, no Sign in, no verified mark, and "Powered by tipme" present.
3. **Editor (e2e):**
   - Applying a template changes style, accent and mode as one undo step, and leaves blocks, links, photo and bio untouched.
   - The starter offer shows only on an empty Pro draft.
   - A label swap saves, undoes and discards correctly. Changing template drops out-of-list labels with the notice.
   - "No template" clears the fields.
   - The setup link `?template=` applies straight away on a new empty page. On a page with content it shows the confirm, and "Not now" leaves the draft byte-identical.
   - The changed-URL notice shows once on the next Studio open.
   - Starter hints come back after a reload.
   - "Apply template" meets the 200 ms INP budget on the throttled profile, with the style sheet preloaded.
   - Free preview saves nothing.
4. **Integration:** Free PUT that changes any template field → 403; a lapsed page shows Classic and keeps the fields; renewal restores the template page.
5. **Snapshots (Linux, from CI artifacts only):** 12 new images, each phase-1 template at phone 390 **and** desktop 1440 in its own mode. The canvas boards are the reference; the missing `tipme-interface-directions.png` doesn't block (Sources). The C/P images, the 18 existing style images and Classic's `profile.visual` must not change.

## 15. Where this design departs from the earlier specs (resolved)

1. **"No custom link titles" (C/P §4)** → rows may carry a label chosen from the template's list (owner decided item 2). There is still no free text.
2. **Fixed tip label per skin (C/P §6.5)** → on a template the label comes from the template's list. The C/P labels remain the default when there is no template.
3. **"No new document field" (C/P plan, Global Constraints)** → three optional fields (7.4), with no version bump.
4. **Fixed `place` per site (C/P §5.4)** → a labelled link is always a row (8.2).
5. **Switching style keeps the mode (C/P §6.2)** → applying a template sets the template's mode (owner decided, 28 Nov; 9.1). Switching style still keeps it.
6. **Rows use the site's `featured` words (C/P §5.4)** → four sites use a short row form on Creator and Professional rows, to keep the one-line rule (7.2).
7. **Professional's pill always shows the amount (C/P §6.5)** → on a template, it shows label-only when "label · amount" doesn't fit (8.1).

## 16. Order of work (my call)

1. **Contracts:** `studio-templates.ts`, `template-copy.ts`, the three document fields, schema and resolve, and tests (14.1).
2. **Public render:** tip labels in both skins, labelled rows and glyphs, the template fixtures, and render, perf and snapshot tests.
3. **Editor:** the Templates section, tip wording, link rows with "Add link", the starter offer per template, undo and discard, and the Free preview; then the setup done-screen entry.
4. **Boards (in parallel with 1):** move the six drafts in the canvas row "Templates · draft" to final after owner review, and draw `creative`. Add the eleven authored glyphs (8.3) to the boards for review **before PR 2**. No new artifact. A board wins on any look once approved; the PR names each difference.
5. **Phase 2 (business) and phase 3 (giving)** each start with their own plan from section 12.

**Left to the builder:** component structure; the template card miniature details; the "Add link" route (10.1); PR slicing within this order; hint wording for `creative` within the 7.3 rules (copy grep applies).

## 17. Open questions for the owner

None block phase 1. The catalogue (6.1) and the template mode (9.1) were decided by the owner on 28 Nov.

- **Phase 2 question: the Business Pro "branded page" (12.1).** The planned free brand colour conflicts with curated styles. The recommendation is that the branded page becomes Studio styles and templates on the business page. This is answered before phase 2 is planned.
- **For review, not blocking: the wording lists (7.2).** They are my call, built from the boards. The owner may add or remove entries; the shape takes any list within the caps and banned words.
