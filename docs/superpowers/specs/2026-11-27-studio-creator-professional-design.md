# Page Studio: the Creator and Professional styles (design addendum)

**Date:** 27 Nov 2026 · **Status:** design draft for review · **Base:** `origin/dev` at `3bc41af9`

**What this is.** An addendum to the styles design of 17 Nov, `docs/superpowers/specs/2026-11-17-page-studio-styles-design.md`, here called "the styles spec". Every rule in the styles spec applies to the two new styles unless this document names the change (section 11). Section numbers like "§8" point into the styles spec.

**Sources.**

- The owner's mockup (two phones, "1. Modern Creator" and "2. Professional"), shared 27 Nov 2026.
- The canvas "Studio Page Styles", https://claude.ai/artifact/CFaqbtC1zkoyvVqNVhFz4q. It stays the visual authority. The Creator and Professional boards go **into that canvas** (no new artifact). Until they exist, the mockup is the reference, minus the three changes in section 2 item 8. Once the boards exist, a board wins over this document on any look, as §0 of the styles spec says, except where section 11 names the disagreement.
- The built code on `dev`: `packages/contracts/src/studio-styles.ts`, `studio-document.ts`, `studio-check.ts`, `social-links.ts`, `covers.ts`; `apps/web/src/components/studio-styles/` (renderer, sheets, fonts); `apps/web/src/components/appreciation-form.tsx` (the tip form and its `skin`); `apps/web/src/app/dashboard/studio/` (the editor).

**Not an approval.** This is a product and design decision only. It is not legal, data-protection, regulatory or payment-partner approval. D-07 stays OPEN (`docs/00-DECISIONS.md`). Nothing here changes a fee, a minimum, a checkout amount, a ledger posting or a payout. The `page_studio` switch stays off in production. It waits on the #283 tall-crop read and a `perf:lab` re-run (`docs/runbooks/settings-and-switches.md`, `PAGE_STUDIO_ENABLED`). This work does not change that, and section 9.3 adds the two new fixtures to the re-run.

**How decisions are marked** (as in the styles spec):

- **(owner decided)**: the owner's words or ruling. Binding.
- **(my call)**: decided by the coordinator who wrote this document. Each has a one-line reason. Change one only through the coordinator.
- **(builder's call)**: the builder decides, within the rules given, and says what they chose in the PR.

---

## 1. Intent

The owner shared two phone mockups and wants them as looks a person can switch to. They become two new finished styles in Page Studio, **Creator** and **Professional**. They join the nine and follow the same contract: a curated look, proven in every combination, with only the four safe choices inside it.

## 2. Owner decisions this addendum carries

1. **Two new Page Studio styles (owner decided, 27 Nov).** The two mockups become themes a person can switch to: two **new** styles beside the existing nine. They are not changes to Stage or Clear, and not a separate theme system.
2. **Both are Pro (owner decided, 27 Nov).** When Pro lapses they behave like the other Pro styles: the page shows Classic, and the choice is kept for renewal (§12.5).
3. **Switching changes only the look (owner decided, 27 Nov).** Photo, bio, links and blocks stay where they are. A page with **no blocks yet** gets a one-time **"Start with this layout"** option, which fills in that style's starter blocks. Nobody's existing content is moved unless they ask.
4. **Carried owner rules (owner decided):**
   - every tip page header shows **only the TipMe logo**, with no menu button and no Sign in (19 Nov). So the mockups' ☰ is dropped. The header is already built this way; nothing new is drawn;
   - users never see the payment provider's name. It is always "our payment partner";
   - no copy implies regulatory approval;
   - curated styles, with no free colour, font or layout controls. Inside a style a person chooses only the accent (the tested set, plus Pro "From your photo"), light/dark/auto, the cover type and the block order (16–17 Nov).
5. **Names (owner decided, 27 Nov: "Sure, let's go"):** "Creator" and "Professional".
6. **Creator (owner decided, 27 Nov):**
   - dark by default;
   - a full-width photo cover with the avatar overlapping it;
   - a row of social icons;
   - a big two-line tip button reading "Support my work" / "Give, tip or appreciate";
   - links as rows, each with an icon, a label and a chevron.
7. **Professional (owner decided, 27 Nov):**
   - light by default;
   - a photo cover with the profile on a card rising over it;
   - social icons;
   - rows for links, about and services;
   - a dark "Send a tip" pill button.
8. **Changes from the mockup (owner decided, 27 Nov):**
   - **no blue verified tick.** TipMe does not verify identity on these pages, so a tick would mislead supporters;
   - **"Powered by tipme" stays** on both;
   - the ☰ is dropped (item 4).
9. **Visual authority (owner decided, 27 Nov):** boards go in the existing "Studio Page Styles" canvas. Until they exist, the mockup is the reference, minus item 8.

## 3. Approaches

- **A. Two new styles in the existing registry (chosen).** They are added to `STUDIO_STYLE_IDS` and get the same document, check, gating, lapse, tests and budgets. That is the least new machinery, and every existing guarantee (exhaustive contrast, render matrix, CSS and font budgets, Free and Pro on the server) covers them automatically once they are listed.
- **B. Restyle Stage and Clear to look like the mockups (rejected).** It changes looks the owner already approved on 17 Nov, and pages already published in them would change without their owners asking.
- **C. A separate theme system on top of styles (rejected).** It duplicates the style system: two places decide a page's look, two sets of contrast proofs, and a combination matrix that multiplies. It breaks the "finite, exhaustive" promise of §3.

## 4. Goals and non-goals

**Goals**

- Creator and Professional look finished in every accent, mode, cover type and block order, proven by the existing exhaustive tests once the two ids are listed (section 9).
- Switching to either changes no content. The starter layout only ever fills an **empty** page, and only when asked.
- No visible change for any page that doesn't pick them. Classic stays byte-identical, and the existing 18 snapshots don't move.
- Both stay inside the §4.3 budgets.

**Non-goals**

- New block kinds, custom link titles, brand-logo icons (still "a later, brand-rules job", `social-links.ts`), a verified mark, or new analytics.
- Changing the nine existing styles in any way.

---

## 5. Contracts

### 5.1 Registry (`studio-styles.ts`)

- `STUDIO_STYLE_IDS` gains `'creator'` and `'professional'`, **appended after `'horizon'`**. **(my call:** appending keeps every existing card position and fixture order)
- The Style tab copy is generated, so it becomes "4 of 11 free" / "11 styles". The Pro banner's generated list gains the two names ("Stage, Signboard, Sprint, Tiles, Horizon, Creator and Professional come with Pro."). **(my call:** the generated sentence already exists, so this needs no new copy)
- Registry entries (shape unchanged, §5.1):

| Field           | Creator                                                       | Professional                                                    |
| --------------- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| `name` / `mood` | "Creator" / "Bold, personal, made to be shared" **(my call)** | "Professional" / "Clean, composed, easy to trust" **(my call)** |
| `plan`          | `'pro'` **(owner decided)**                                   | `'pro'` **(owner decided)**                                     |
| `displayFont`   | `null` (Inter only), section 6.4                              | `null` (Inter only)                                             |
| `defaultAccent` | `null` = **TipMe purple**, section 6.1                        | `'ink'`                                                         |
| `naturalMode`   | `'dark'` **(owner decided)**                                  | `'light'` **(owner decided)**                                   |
| `modes`         | light, dark, auto                                             | light, dark, auto                                               |
| `covers`        | yours, gradient, plain                                        | yours, gradient, plain                                          |
| `needsPhoto`    | `true`                                                        | `false`                                                         |
| `linksAt`       | `'after-identity'` (icon row; section 7.4)                    | `'after-identity'`                                              |

The moods are mine, written to the §9 pattern, and the mockup captions ("Bold. Personal. Engaging." / "Clean. Elegant. Timeless.") are the source. **(my call:** a mood is a sentence in the Style tab, and the captions read as taglines)

- `defaultAccent: null` today means "Classic purple". Its comment and `accentChoices` change from "Classic" to "**any style whose `defaultAccent` is null**". "TipMe purple" then shows first in Creator's swatches as well as Classic's. `accentValues` already returns `CLASSIC_PURPLE` for a null default, so it doesn't change.
- `studioContrastPairs` gains a `creator` and a `professional` case (section 9.1). `studioTokens` gains Creator's `deep` and `deepLabel` tokens (section 6.1).
- `studioSlotWidth` (`studio-check.ts`) gains each style's slot widths for the photo-resolution check and `sizes`. **(builder's call** on values, from section 8)

### 5.2 Neutrals (proposed; the boards may refine them inside the envelope)

| Token     | Creator dark (natural) | Creator light | Professional light (natural) | Professional dark |
| --------- | ---------------------- | ------------- | ---------------------------- | ----------------- |
| `bg`      | #0E0B16                | #F7F5FC       | #F2EFEA                      | #0F0F11           |
| `card`    | #1A1626                | #FFFFFF       | #FAF8F4 (the rising card)    | #18181B           |
| `el2`     | #262033                | #EEEAF6       | #ECE8E1                      | #2A2A2F           |
| `fg`      | #F5F3FA                | #17131F       | #16151A                      | #F4F4F6           |
| `fg2`     | #ABA5BA                | #5F5970       | #5E5B63                      | #A6A6AE           |
| `line`    | #2E2840                | #E2DDEC       | #E4DFD6                      | #2E2E33           |
| `control` | #6E6780                | #8F889E       | #8A857D                      | #6C6C74           |
| `row`     | (none)                 | (none)        | #FFFFFF                      | #202024           |

**(my call** on every value: they are read off the mockup and checked by me on 27 Nov with the WCAG formula)

- fg and fg2 pass 4.5:1 on every surface. The lowest is fg2 on Professional light `el2`, at 5.45.
- `control` passes 3:1 on `bg`, `card` and `row`. The lowest is Professional dark on `row`, at 3.12.
- Professional dark `row` is `#202024` (luminance 0.0147), inside the envelope below. It was `#222226` (0.0162), which sat outside it (builder check, 27 Nov). On it: `fg` 14.78, `fg2` 6.72, `control` 3.12, and the lowest curated dark `accText` 7.01 (so the focus ring and selected border pass 3:1 with room). Against `card` `#18181B` the row still reads as a lifted surface (1.09:1, plus its 1 px `line`). `control` stays `#6C6C74`.
- The lowest curated `accText` on `bg` or `card` is Coral on Professional light `bg`, at 4.68.

**The envelope rule (my call:** it keeps every stored photo accent and the §7.3 table valid with no recomputation)

- §6 step 4 proves a photo accent's text value against "every style's page and card surfaces". Adding surfaces could silently invalidate stored values.
- So in light mode, every new surface an accent value is drawn on (`bg`, `card`, `row`) must be **no darker** (relative luminance) than the darkest existing light page or card surface (0.857, Tiles `#EEEEF1`).
- In dark mode, they must be **no lighter** than the lightest existing dark page or card surface (0.0149, Linen `#24201B`).
- Both thresholds are stricter than the surfaces accent text is already proven on (Classic's `#EEEDE8` recessed light surface; Clear's `#3A3A3F` dark thumb), so meeting them is enough.
- Inside the envelope, any text value that passes on the old surfaces passes on the new ones too.
- The values above sit inside it, and a unit test asserts the envelope. If a board needs a value outside it, the builder stops and asks the coordinator. That is not a builder's call, because it would mean bumping the photo-accent algorithm and recomputing stored values.

### 5.3 Document, API, database, check

- **Document:** unchanged (v2). The style id is in the jsonb, and the strict schema and `resolveStudio` read `STUDIO_STYLE_IDS`, so they accept the new ids. There is no migration and no SQL.
- **Deploy order:** web and API ship together on the one server (self-host, 26 Nov). An older web reading a `creator` document would resolve it to Classic (`resolveStudio` picks `'classic'` for an unknown id), so nothing breaks in between. **(my call:** noted so nobody adds a feature flag for it)
- **API:** no new route.
  - `PUT …/draft` refuses a Free **switch** to either style with 403 `STUDIO_PRO_REQUIRED`, and publish refuses them with 422 `pro-only`. Both rules key on `plan === 'pro'` in the registry, so they need no new code.
  - The starter layout saves through the normal `PUT …/draft` (section 7.6).
- **Design check (v3, no version bump):** no new rule.
  - `cover-photo` fires for Creator (`needsPhoto`) as for Stage and Horizon.
  - `name-fallback` never fires (Inter only).
  - `empty-block` is what keeps starter blocks from being published empty (section 7.6).
  - **(my call:** a bump is for changed rules, and none changes)

### 5.4 Link placement (`social-links.ts`)

Both styles show links in two forms, an **icon row** and **rows** (owner decided, items 6 and 7). To keep "each link renders once" (§8), each site gets a fixed placement in the catalogue. **(my call:** a fixed split by site needs no stored setting, no free text and no per-link choice, which matches the curated rule)

- New field `PlatformSpec.place: 'icon' | 'row'`:
  - **`icon`** (places people follow): TikTok, Facebook, Instagram, X, Snapchat, Threads, LinkedIn.
  - **`row`** (places people go to watch, listen, join, read, buy or support): YouTube, WhatsApp channel, Twitch, Kick, Audiomack, Boomplay, Spotify, Apple Music, SoundCloud, Website, Telegram, Patreon, Selar, Substack, OnlyFans, Fansly.
- **The featured link** (Pro, at most one) is always the **first row**, whatever its site.
- A row's label is the site's existing fixed `featured` words ("Watch me on YouTube", "Visit my website"). This is the only first-person row copy TipMe already has, and there is no free text to moderate. **(my call)**
- Which links show is unchanged: `visibleLinks` (Pro 8; the adult-links switch hides adult sites as today). Order inside each group is the person's saved order.
- Only Creator and Professional read `place`. The other nine styles and Classic don't change.

---

## 6. Shared rules for both styles

### 6.1 Accent

- **Allowed places (§7.2, unchanged):** the Tip button, the selected amount, the focus ring and link underlines.
- **Creator's default is TipMe purple** (`accent: null`): `#7A32F9` / `#C8AEFF`. **(my call:** the mockup's button is TipMe's own purple, a locked brand colour, and Violet is already Stage's default)
- **Creator's "deep" button (my call:** the mockup's saturated button with a white label, in dark mode, while staying inside the tested pairs). The big Tip button uses the accent's **light-mode `fill` and `label` in both modes**, served as the tokens `deep` and `deepLabel`.
  - Those pairs are already proven at 4.5:1 or better, whatever the surface (5.37 for Coral at the lowest; TipMe purple 5.75).
  - **Exception, decided by value:** in dark mode, when the page's resolved **light** values are Ink's light values (`#1D1D1F` / `#FFFFFF`), the button uses the resolved dark values instead, which are Ink's dark values. A near-black fill measures 1.16:1 on Creator's dark `bg` and the button would vanish.
    - The comparison is on the values `accentValues` returns, **not** on `accent === 'ink'`. So it also covers "From your photo" stored as failed with Ink as its fallback (§6 step 5), which resolves to Ink's values. **(my call, builder check 27 Nov)**
    - A successful photo accent can't be near-black, because its light fill is clamped to OKLCH L 0.45 to 0.55 (§6 step 3). So no other value needs the exception.
  - `photo-accent.ts` proves a candidate by running `studioContrastPairs` for each mode with that mode's values only. So Creator's case adds the `deep` pair only in the **light** pass, where it is the light pair. In the dark pass it adds it only when the values are Ink's (the exception above). Otherwise the dark pass would test a pair the page never draws. **(my call)**
  - The fill may carry a vertical sheen from `deep` to `deep` darkened up to 6% in OKLCH lightness. Both ends must keep `deepLabel` at 4.5:1 or better, and that pair is in the contrast test. **(builder's call** on the sheen amount, 0 to 6%)
  - There is **no glow** behind the button. **(my call:** the constitution bans excessive glow, and the deep fill carries the look)
  - Chips, the focus ring and link underlines use the mode's own values, as in every style.
- **Professional's default is Ink:** a near-black pill on light, and the light Ink pill in dark. The mockup's purple heart is drawn in `accLabel`, not a second colour. **(my call:** the §3 anti-goal is "a second accent on a page")
- Professional sharing Ink with Sprint, and Creator sharing purple with Classic, are named in section 11. With 11 styles and 9 defaults, some sharing can't be avoided.

### 6.2 Light and dark

- **Both offer light, dark and auto (owner decided, 16 Nov: every style).** Creator light is a soft lilac-white page. Professional dark is a near-black page with a lifted card.
- **"Dark by default" / "light by default"** sets `naturalMode`. That drives the style card, the boards, the snapshots and the examples.
- **Switching keeps the person's mode,** as §10 already does for Stage. Someone in Light who picks Creator stays in Light, one tap from Dark. **(my call:** §10's "switching keeps everything the new style can use" holds for every style, and a mode that changes by itself would surprise people more than it helps them)
- Auto is plain CSS, as built.

### 6.3 Identity

- **Order:** avatar, name, meta (`@handle · role`, as built), the Pro badge (built placement), bio, celebration label. The name is **centred** in both, as drawn.
- **No verified mark (owner decided).** Nothing is drawn after the name except the existing Pro badge in the meta line.

### 6.4 Type

- **Inter only, in both (my call:** Inter is the only face here already proven for ₦ and the Yoruba, Igbo and Hausa letters. The mockup's geometric sans reads close enough at 700–800 with tight tracking. A new face would need the §4.1 cmap check, a register entry and font bytes, so the builder may **not** add one; that change goes to the coordinator.)
- One family is loaded. Studio Inter (400–800, the existing file) is preloaded as the name face, and `name-fallback` can't fire.
- **Money:** Inter tabular lining figures, with ₦ tight against the digits (§4.1, unchanged).

### 6.5 The Tip moment and the tip-look mechanism

- **The form stays the form.** `AppreciationForm` is the same component with the same amounts, minimum, "Custom", message drawer, fee line, errors and closed/opens-soon states (§13).
  - `TipSkin` is `Exclude<StudioStyleId, 'classic'>`, so `'creator'` and `'professional'` become skins automatically.
  - The two button labels below are **fixed per style, keyed by the skin**. They are not a stored field and not editable copy. **(my call:** the label is part of the look, like Tiles' "Send a tip" title, so it belongs to the style)
- **The amount still flows into the label** (§8 family law). The mockups draw no amounts, but every page has real presets and a minimum, so both styles show amount chips above the button. **(my call:** a tip with no visible amount would break §8 and payment clarity, the constitution's first rule)
- **Creator's button** (owner decided copy) is a 72 px tall, r20, full-width `deep` button:
  - left: a heart glyph (24 px, `deepLabel`, decorative);
  - middle, two lines: **"Support my work"** (17/22 650) over **"Give, tip or appreciate"** (13/18 500, `deepLabel` at 85%);
  - right: the chosen amount (Inter 17/22 650 tabular) and a chevron.
  - The accessible name is "Support my work, tip ₦2,000" ("Support my work" with no valid amount). While the tip starts, both lines read "Starting your tip…", as built. At 320 px, the amount wraps under line 2 rather than shrinking. **(my call** on putting the amount at the right: it keeps both decided lines and §8)
- **Professional's button** is a 56 px full-width pill, `acc` / `accLabel`, labelled **"Send a ₦2,000 tip"** with a decorative heart after it, or **"Send a tip"** with no valid amount. **(my call:** "Send a tip" is the decided copy, and it reads naturally with the amount inside)
- **Chips:**
  - **Creator:** pill, 48 tall, on `card`, 1 px `control`; selected is a 1.5 px inset `accText` ring at weight 650 (Stage's pattern).
  - **Professional:** r14, 44 tall, on `row`, 1 px `control`; selected is a 1.5 px `accText` border at weight 650.
  - "Custom" is the fourth chip in both (§9 intro).
- **Sticky bar (phone):** one line, "Tip ₦…", as in every style.
  - **Creator:** `bar` + `saturate(1.6) blur(20px)`, 1 px `line` top, a `deep` pill 48 tall.
  - **Professional:** solid `bg`, 1 px `line` top, an `acc` pill 48 tall.
  - **(my call:** the two-line button doesn't fit a 48 px bar, and Tiles' bar already differs from its in-page Tip)

### 6.6 Footer and "Powered by tipme"

- Both styles show a line: "Powered by" (12/16 Inter 500, `fg2`) followed by the TipMe wordmark (the existing SVG, 14 px tall, `fg`) (owner decided). It is one link to the home page, with the accessible name "Powered by TipMe" and no tracking parameter. **(my call:** a brand mark that looks tappable should be, and a parameter would be analytics, which waits on D-07)
- **Creator:** at the foot of the page, above `ProfileFoot`.
- **Professional:** always at the **foot of the card**, under the Tip button, as the mockup draws it. Blocks, if any, follow the card. **(owner decided, 27 Nov: the mockup is the reference)**
- `ProfileFoot` is unchanged. These are Pro pages, so "Get your own TipMe page" doesn't show.

### 6.7 Header

The header is the existing site header: TipMe logo only (owner decided, 19 Nov). Over a photo cover it is laid over the cover, white on the frame's soft scrim (`HEADER_OVER`). Add `creator: ['photo']` and `professional: ['photo']`. **(my call:** Creator's gradient is pale in light mode, where white header words would fail, so only photo covers take the over-header in either style)

---

## 7. The two styles

Phone width is 390. Values are size/line-height and weight, as in §9. The board is authoritative for anything not restated here. `deep` and `deepLabel` are defined in 6.1.

### 7.1 Creator: "Bold, personal, made to be shared" · Pro

|                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Faces           | Inter only. Name 800, section titles 750.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Default         | TipMe purple · **dark** · Your cover (a photo)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Radii           | rows and cards 16 · the Tip button 20 · chips pill · avatar circle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Phone type      | name 30/36 800 −0.03em · meta 14/20 500 fg2 · bio 16/24 fg · section title 20/26 750 −0.015em · row label 15/20 600, sub 13/18 fg2 · chip 16/20 600 · Tip as in 6.5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Desktop type    | name 48/54 800 −0.035em · bio 18/28 · section title 24/30                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Cover           | **Photo (signature):** full-bleed, **488 tall on phone and 640 from 1024 px**, plus the header strip it runs under, the same box as Stage (section 9.3). Its lower 45% fades to opaque `bg` (stops: transparent 55%, `bg` 80%, `bg` 100%). The avatar sits on the faded foot, and the name and everything below it are on solid `bg`, never on the photo. **(my call:** text on solid `bg` stays provable in the exhaustive test with no scrim rule, and it looks the same as the mockup.) **Gradient:** deep accent (OKLCH L .30 dark, L .92 light) fading to `bg`, 280 tall, avatar on its foot. **Plain:** no cover; 32 px under the header, the avatar starts the page. **Your cover that isn't a photo** (design, automatic, animated) draws the gradient treatment and the `cover-photo` notice, as Stage does (`needsPhoto`). **(my call:** a 488 px box would stretch cover art made for a wide band) |
| Avatar          | 112 phone, 144 desktop, circle, 4 px ring in `bg`, centred, half over the cover's faded foot                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Icon row        | under the bio: 44 px circles on `el2`, gap 12, centred, wrapping (8 links make two rows at 320). Each holds the site's existing badge in `fg` (section 7.4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Tip moment      | chips, then the two-line `deep` button (6.5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Rows            | after the Tip: the `row` links (featured first), each 56 tall, r16, `card`, 1 px `line`: a 32 px badge circle on `el2`, the label, the handle as sub when there is one, and a trailing chevron in `fg2`. No section title over them. The list is a `<nav aria-label="Find me elsewhere">`. **(my call:** the fixed §8 title still names it for screen readers, without a visible heading the mockup doesn't have)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Sticky bar      | 6.5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| States / motion | 220 ms `cubic-bezier(.2,.8,.2,1)` · Tip hover: brightness 1.06; press: scale .97 · chip press: .96 · row hover: `el2` · focus: 2 px `accText`, offset 2 · load: avatar and name fade up 8 px, 240 ms · reduced: fades only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Desktop layout  | content 1040. The cover spans the width, and the avatar overlaps it on the left of the content. Then a 420 px column (identity left-aligned, icon row, Tip) beside the main column (rows, then blocks), gap 80. **(my call** until the board exists; the board wins)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### 7.2 Professional: "Clean, composed, easy to trust" · Pro

|                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Faces           | Inter only. Name 700, section titles 650.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Default         | Ink · **light** · Your cover (a photo)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Radii           | the card 24 · rows, chips and photos 14 · the Tip pill · avatar circle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Phone type      | name 26/32 700 −0.02em · meta 14/20 500 fg2 · bio 15/22 fg2 · section title 18/24 650 −0.01em · row label 15/20 600, sub 13/18 fg2 · chip 15/20 550 · Tip 17/22 600                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Desktop type    | name 40/46 700 −0.025em · bio 17/26 · section title 20/26                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Cover           | **Photo (signature):** full-bleed, **488 tall on phone** (plus the header strip, the same box as Stage) and **440 from 1024 px**. **The card** (`card`, opaque, r24, inset 12 px from the screen edges on phone) rises **112 px** over the cover's foot. No text ever sits on the photo. **Gradient:** two tints of the accent at low chroma (OKLCH L .95 → .90 light; .28 → .22 dark), 240 tall, card rising 96. **Plain:** no cover; the card starts 24 px under the header. **Your cover that isn't a photo** renders as today's cover art in a 240 px band, card rising 96 (`needsPhoto: false`). **(my call:** nothing is drawn over the cover, so art is safe there)        |
| Avatar          | 96 phone, 120 desktop, circle, 4 px ring in `card`, centred on the card's top edge                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The card        | holds, in this order: the avatar, name, meta and bio; the icon row (40 px glyph circles on `el2` with 44 px targets, gap 16, centred); the **link rows** (`row` links, featured first: 56 tall, r14, `row`, 1 px `line`, a 32 px badge, the label, the sub and a chevron, in a `<nav aria-label="Find me elsewhere">`); the amount chips and the Send-a-tip pill; and "Powered by tipme" at its foot (6.6). This follows the mockup **(owner decided, 27 Nov)**. **No shadow:** the opaque card on the photo separates itself. **(my call:** §8 allows only three shadows, and the constitution warns against glass; the board may ask for an exception, through the coordinator) |
| Blocks          | after the card, on `bg`, in the person's order (7.3). With no blocks the page ends at the card, then `ProfileFoot`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Sticky bar      | 6.5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| States / motion | 180 ms ease-out, colour and border only · Tip hover: brightness 1.08 (dark: 0.94); press: scale .98 · row hover: `el2` · focus: 2 px `accText`, offset 2 · reduced: no scale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Desktop layout  | content 960. The card (960 wide) rises 160 over a 440 px cover. Inside it are two columns, gap 56. Left: the identity and the icon row. Right (400): the link rows, then the chips and the Tip, then "Powered by tipme" under them. Below the card, the blocks go in one column of 640, centred. **(my call** on the column split until the board exists; the order inside the card is the mockup's)                                                                                                                                                                                                                                                                              |

### 7.3 How each block renders

The blocks keep the person's order. They follow the rows on Creator and the card on Professional. Headings start sections, as built (`StyleBlocks`). **A chevron appears only on something that navigates. (my call:** a chevron on a service row would promise a link that isn't there)

| Block            | Creator                                                                                                                         | Professional                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `text` heading   | section title (7.1), `h2`, left-aligned                                                                                         | section title (7.2), `h2`, left-aligned                                                                          |
| `text` paragraph | `card` r16, padding 20, 16/25 `fg`, max 62ch                                                                                    | `row` r14, 1 px `line`, padding 18, 16/25 `fg`                                                                   |
| `photo`          | column width, wide crop, r16, caption 13/18 `fg2`                                                                               | column width, wide crop, r14, caption 13/18 `fg2`                                                                |
| `gallery`        | a horizontal strip of 156×208 r16 tiles, gap 8 (the "portfolio" feel)                                                           | a 3-up grid, square, r14, gap 8                                                                                  |
| `video`          | the built embed, 16:9, r16, caption under it                                                                                    | the built embed in a `row` r14 frame, caption under it                                                           |
| `services`       | rows: `card` r16, name 16/22 600, detail 13/18 `fg2`, price right (Inter tabular 15/20 650, "From" as built), no chevron        | rows: `row` r14, 1 px `line`, the same content, price right, no chevron                                          |
| `events`         | rows with a 56 px date tile (`el2` r12; day 22/24 800, month 11/14 650 caps `fg2`), title 16/22 600, place and time 13/18 `fg2` | rows on `row`: date as text in a 48 px column (day 20/24 700, month 11/14 600 caps `fg2`), title, place and time |
| `quote`          | no card; 20/28 600 `fg`, opening mark in `fg2`, 2 px `line` rule on the left                                                    | `row` r14, 18/27 500 `fg`, opening mark in `fg2` (no italic: Studio Inter ships upright only)                    |
| `supporters`     | refused, as built (Task 13)                                                                                                     | refused, as built                                                                                                |

The accent never fills a block (§7.2). Desktop mapping of blocks to columns follows 7.1 and 7.2. **(builder's call** on pairing list sections 2-up on Creator's main column)

### 7.4 Icons

- **The links already show icons:** `StyleLinks` draws each link's `LinkBadge`, the site's letters ("IG", "www", "18+"), today. Brand logos are explicitly "a later, brand-rules job" (`social-links.ts`).
- **Both styles use the existing badge,** drawn monochrome in `fg` on `el2` in the icon row and in the rows. **(my call:** brand marks need their brand rules first, and colour badges would bring many colours to a page that allows one accent)
  - A monochrome badge variant (e.g. `<LinkBadge mono>`) is the builder's call.
  - When the brand-rules job ships marks, both styles take them with no change here.
- **Accessible name of each icon link:** "{Site}: {handle}, opens in a new tab" ("{Site}, opens in a new tab" with no handle). Targets are at least 44×44.

### 7.5 Long names

- The §9.10 rule: one step down (about 80%) when a name would take a third line, with balanced wrapping and no mid-word breaks.
- Test names: "Olúwadámilọ́lá Ọ̀ṣúnfúnmiláyọ̀-Adébáyọ̀", "Chukwuemeka Ọ̀kọ̀nkwọ́-Adéyẹmí", "Ɗanlami Ƙwairanga Ɓello".
- Both are set in Inter, so one face draws the whole name. **(builder's call** on step sizes, proven at 320 and 390)

### 7.6 "Start with this layout" (owner decided; mechanics are my call)

**When it shows:**

- The editor shows a card, "Start with this layout", with the line "Adds {n} empty blocks you can fill in or remove. Nothing on your page moves."
- It shows only when all three hold:
  - the chosen style is Creator or Professional;
  - the draft has **zero blocks**;
  - the person is on Pro.
- It sits under the style cards in the Style tab, with a matching button in the Blocks tab's empty state. **(builder's call** on the Blocks tab placement)
- **Hidden on Free** **(my call:** a Free preview of a Pro style isn't saved (§12.4), and starter blocks include Pro kinds the server refuses to add)

**What it adds** (new, empty blocks from `newBlock`, appended in this order):

| Creator (5 blocks)                                                               | Professional (6 blocks)                                          |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| heading · gallery · heading · paragraph · quote                                  | heading · paragraph · heading · gallery · heading · services     |
| (the mockup's "My portfolio"; a few words about them; a quote for a fan's words) | (the mockup's "About me", "My portfolio", "Let's work together") |

- **Every starter block is empty,** headings included. The editor shows **placeholder hints** in the inputs, which are not stored:
  - Creator: "e.g. My work", "e.g. About me";
  - Professional: "e.g. About me", "e.g. My portfolio", "e.g. Work with me".
  - **(my call:** TipMe never puts words on a public page that the person didn't write; the same principle as the checkout prefill decision of 22 Nov)
- The existing `empty-block` rule then lists each unfilled block, with its "Remove the block" fix. **An unfilled starter can't be published.**
- **Only kinds that can be empty.** Every starter kind is one `newBlock` creates empty, the strict write schema accepts empty, and `isEmpty` / `empty-block` already catch: text, quote, gallery and services. **No video block** (my call, builder check 27 Nov): the write schema refuses an empty `video.url` (it must pass `parseVideoLink`), and `isEmpty` has no video case. Creator's mockup row "Watch my videos" is covered by a YouTube, Twitch or Kick link row (5.4) instead. No schema change and no check-version bump.
- **Limits:** at most 6 blocks are added (Creator 5, Professional 6), with 0 photos and 0 videos, since `blockCounts` counts only photo and gallery images and video blocks, and none of those is added. That is far inside `studio-limits.ts`. Photos arrive as the person fills a gallery, and the existing limits apply.

**"One-time"** means it fills an empty page once, and never adds to or rearranges a page that has blocks. **(my call:** nothing stored. The card reappears only if the page is empty again, for example after undo or discard, which is harmless because it only ever fills emptiness. A stored "dismissed" flag would need a column for no user benefit.)

- **"No thanks"** hides the card for the session.

**Undo and discard (§12.2, §12.3):**

- Adding the layout is **one undo step**, named "Undo: starter layout added". Undo removes all of its blocks at once, which leaves the page empty, so the card returns.
- Edits to the blocks afterwards are their own steps, as built.
- **Discard changes** returns the draft to the published version. If that had no blocks, the starter blocks go and the card can return.
- Nothing about the starter is stored beyond the blocks themselves.

**Switching style afterwards** keeps the blocks, as for any blocks (owner decided item 3). Switching to the other new style doesn't offer its starter, because the page isn't empty.

**Server:** the blocks save through `PUT …/draft` like any additions. A Free account adding them is refused with 403, as for any Pro block. The client hides the option there anyway.

### 7.7 Free, Pro and lapse

These need no new rules; listing the ids covers them.

- **Free users** can preview both (§12.4: not saved, status "Previewing a Pro style: not saved"). They can't save or publish them (403 / 422 `pro-only`).
- **On lapse (owner decided item 2),** visitors see **Classic** with the person's accent (Creator's null stays null, which is Classic's TipMe purple; the photo accent becomes purple), their mode, their cover choice, and their text and quote blocks in order. Pro blocks are hidden, nothing is deleted, and the design returns on renewal (`studioShown`).
- **The editor banner** is as built: "Your page shows Classic until Pro is back."

---

## 8. Ops and analytics

- **Analytics: none.** No new event, property or parameter. Block and link analytics stay parked on D-07 (§3 non-goals).
- **Ops: none.**
  - The ops page tools touch only Studio photos (view, remove), which work on the new styles unchanged.
  - The `page_studio` switch and its runbook row don't change.
  - The perf re-run named in that row ("every `/@style*` fixture") picks up the two new fixtures (9.3) by name. **(my call:** no runbook edit is needed, because the row already says "every")
- **Support:** no new copy reaches a payment screen. The provider's name appears nowhere (the copy grep, 9.5).

## 9. How we know it's right (evidence each PR records)

These extend §14. Adding the ids to `STUDIO_STYLE_IDS` puts both styles into every existing loop. The builder confirms that each loop really iterates the registry and doesn't use a hand-written list.

1. **Contrast (exhaustive):**
   - Both styles × the 8 curated accents × 2 modes, **plus TipMe purple for Creator**.
   - New pairs:
     - Creator: `deepLabel` on `deep`, at both sheen ends; in dark mode, the Ink exception for curated Ink **and** for a photo accent stored as failed with fallback Ink (both resolve to Ink's dark values; a unit test on `studioTokens` and a render test assert it); chip label (`fg`) on `card`; the selected ring (`accText`) on `card`; the icon badge (`fg`) on `el2`; chip border (`control`) on `bg` and `card`.
     - Professional: `fg`, `fg2` and `accText` on `row`; chip border on `row` and `card`; the selected border on `row`; the badge on `el2`.
   - **The envelope test** (5.2) runs over every new surface.
   - The photo-accent property test is unchanged, because the envelope holds.
2. **Glyphs:** the long-names render test (7.5) at 320 and 390 in both styles. One computed face (Inter) covers the whole name, and ₦ is in the same face as its digits.
3. **Render and performance:**
   - Every existing render test, for both styles × light/dark at 320, 390, 768, 1024 and 1440: axe clean, no horizontal overflow, no clipped text. The documents are `min`, `max`, long names and hostile text, with 0, 1 and 8 links (all `icon`, all `row`, mixed, with and without a featured one).
   - **Cover:** both styles join `STYLE_COVER` with Stage's numbers (488 + 76 phone; Creator 640 + 76 desktop; Professional's desktop band 440 + 76). So the #283 `<picture>` tall-crop read the runbook requires serves them too, under its 4:5-or-taller media query. The photo is the likely LCP: eager, `fetchpriority="high"`, correct `srcset` and `sizes`.
   - **Fixtures** `/@stylecreator` and `/@styleprofessional` (`tests/e2e/profile-fixtures.ts`, the lab examples) must each stay **under 2000 ms** in `tests/e2e-perf/lcp.spec.ts`. They are part of the pre-switch `perf:lab` re-run.
   - **CSS:** each style has its own sheet module (`sheets/creator.tsx`, `sheets/professional.tsx`) behind `style-sheets.tsx`. A styled page's Studio CSS stays at most 12 KB gzip, and a standard or Classic page's at most 8 KB, unchanged, because the new sheets are never linked there. `route-css.test.mjs` holds "every style has one".
   - **Fonts:** one family (Inter), within the 2-family, 4-file, 200 KB budget.
   - **Script:** no new client script on the public page. The starter layout is editor-only code. The script-delta test must not move.
4. **Snapshots (Linux authority):**
   - **6 new images:** Creator at 390 dark, 1440 dark and 390 light; Professional at 390 light, 1440 light and 390 dark.
   - The Professional fixtures have link rows and at least one block, so the images show the rows inside the card above the chips and Tip, "Powered by tipme" at the card's foot, and a block after the card.
   - **The existing 18 and Classic's `profile.visual` must not change.** Baseline rules as in `VISUAL-QUALITY-GATE.md`.
5. **Copy:**
   - The copy grep (§14.10) covers the new strings: the moods, the button labels, the starter card, the placeholders and "Powered by".
   - A test asserts **no menu button and no Sign in** in the header on both styles.
   - A test asserts **no verified mark** after the name.
6. **Links and order (5.4):** each visible link renders exactly once on both styles, and the featured one is the first row.
   - **Creator** DOM order: identity, icon row, chips, Tip, rows, blocks, "Powered by", footer.
   - **Professional** DOM order: inside the card, identity, icon row, rows, chips, Tip, "Powered by"; then the blocks after the card; then the footer. The test asserts it at 390 and 1440, and that the in-page Tip is still the sticky bar's watch target. The other nine styles render links exactly as before; their snapshots prove it.
7. **Starter layout (unit and e2e):**
   - The offer shows only for Creator or Professional, zero blocks and Pro.
   - It adds exactly the listed empty blocks, as one undo step. The saved draft passes the strict write schema, and it holds no video block.
   - Undo empties the page, and the offer returns.
   - Discard restores the published blocks.
   - Publish is blocked by `empty-block` until each block is filled or removed.
   - A page with blocks never sees the offer, and switching style never adds or moves blocks.
   - A Free PUT with starter blocks gets 403.
8. **Gating (integration):**
   - Free can't switch to either (403) or publish either (422).
   - A lapsed Creator page shows Classic with TipMe purple, the person's mode and their text and quote blocks.
   - Renewed Pro shows Creator again.

**Screenshots:** every UI PR body shows the expected UI, phone and desktop, with images on the `pr-assets` branch (standing rule). That includes the undrawn tip-form states (§9 intro) in both styles.

## 10. Order of work (my call)

1. **Contracts:** ids, registry entries, neutrals, the `deep` tokens, purple swatch eligibility, `place` on the link catalogue, contrast pairs, slot widths, and the envelope test.
2. **Renderer, behind the lab:**
   - the two sheets and the two branches in `StudioStylePage` (identity, icon row, rows, card);
   - the two skins in `AppreciationForm`, with their labels;
   - "Powered by", `HEADER_OVER` and `STYLE_COVER`;
   - the fixtures, and the render, contrast, performance and snapshot tests.
3. **Editor:** the two miniatures in `style-cards.tsx`, the swatch change, "Start with this layout" with its undo step, and the e2e tests.
4. **Boards:** the Creator and Professional boards in the existing canvas, which can run in parallel with 1. Wherever a board differs from this document, the board wins, and the PR names each difference.

## 11. Where this addendum departs from the styles spec (resolved)

1. **"A tenth style" was a non-goal (§3)** → superseded by the owner's 27 Nov decision for two new styles.
2. **"Links: one treatment per page", at a fixed position after the Tip, under the visible title "Find me elsewhere" (§8)** → in these two styles the icon row sits in the identity, before the Tip, and the rows come after it on Creator and inside Professional's card before the Tip (item 9), with no visible title (the nav keeps the name). Each link still renders once. This follows from the owner's decision on the look (items 6 and 7), and the split rule is my call (5.4).
3. **"Made with TipMe" was left out of the footer (§8, my call of 17 Nov)** → "Powered by tipme" is shown on these two styles only (owner decided, 27 Nov). The other nine don't change.
4. **TipMe purple was Classic's alone (§7.3)** → also Creator's default (my call, 6.1).
5. **"Each style ships a different default" (§15.1)** → Professional shares Ink with Sprint, and Creator shares purple with Classic. With 11 styles and 9 defaults, sharing can't be avoided, and each pair looks unlike the other in every other way. (My call.)
6. **Accent values are per mode (§7.3)** → Creator's Tip button uses the light pair in dark mode, except Ink (my call, 6.1). It adds no colour that isn't already in the tested table.
7. **The mockup draws no amounts** → amount chips are shown (6.5), as §15.4 did for the canvas.
8. **The mockup draws text over the photo (Creator) and a translucent card (Professional)** → text sits on solid `bg`, and the card is opaque (7.1, 7.2).
9. **The Tip moment comes before links and blocks (§8 skeleton)** → on Professional, the link rows sit inside the card **above** the chips and the Tip, with "Powered by tipme" at the card's foot and blocks after the card, as the mockup draws them. Owner decided, 27 Nov: the mockup is the reference (builder check). Creator keeps §8's order (Tip, then rows).

## 12. Left to the builder

Each item below is the builder's call:

- component structure;
- slot widths;
- the sheen amount (0 to 6%);
- the monochrome badge variant;
- the long-name step sizes;
- 2-up pairing of list sections on Creator's desktop;
- where the starter button sits in the Blocks tab;
- the styling of the undrawn tip-form states, within section 6;
- PR slicing within section 10.

## 13. Open questions for the owner

None. The (my call) items can be changed through the coordinator. The one most likely to need the owner is 6.2: whether switching to Creator should also switch the page to Dark. This document keeps the person's mode, as every style does today.
