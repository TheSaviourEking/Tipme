# Public page redesign, covers, Pro QR designs and the handle rule

Status: direction approved by the owner, 1 November 2026. The visual reference is the mockup canvas: https://claude.ai/artifact/8D6hJZsqMkLSGh8KUUBmmh

## 1. Intent

A supporter arrives from a link or QR code, usually on a phone, to tip one person. The page should lead with that person and the tip. Recipients should be able to make the page and their printed code feel like theirs, and the best QR designs are a reason to pay for Pro.

Owner's words: hide the nav options; "the same photo in 2 places" is wrong; social links belong "in the profile card"; "Demo link" is not valid in production; "Free users shouldn't be able to print the pro qr code, they shouldn't be able to snap it"; "Free users can't change" their handle; Pro users change it 3 times and then contact the team; they "must get a confirmation" first.

## 2. Goals

1. Redesigned public page, on phone and desktop.
2. Each page has a cover: an uploaded photo, a chosen design, or an automatic one.
3. Pro QR designs that Free users can preview but not use.
4. The handle rule.

## 3. Non-goals

- Billing. Pro stays granted by staff until payments are approved.
- Live updates (SSE): a separate piece of work.
- Business-logo QR codes (needs a second upload type); later.
- The post-tip thank-you polish; later.

## 4. Anti-goals

- A QR design that doesn't scan. Every design is read back by a test, at more than one size, before it can ship.
- A Free user's working page or basic QR getting worse. Tipping always comes first.
- A printed code ever going dead because someone stopped paying.
- Provider names in user text.
- Copying named cultural motifs. Adire and aso-oke influenced two covers, which are original; Nsibidi and Uli are not used.

## 5. Public page

- Header: the TipMe logo only. No nav, sign-in or breadcrumb on `/@handle`.
- Order: cover; profile photo overlapping its edge; name as the page's main heading (`h1`), handle, role, bio, links.
- Remove "Support Great People" and its lede, and the portrait. The profile photo appears once.
- Social links, phone and email sit in the identity block as one left-aligned row with icons.
- Share: an icon button by the name copying the page link. Copy: "Link copied."; the word "demo" goes. A closed-checkout page also offers "Copy page link".
- Tipping is its own raised panel with the black Tip button (2026-10-25 decision stands), overlapping the cover's lower right on desktop. Beside the button: "No account needed. You'll see the full total before you pay, and our payment partner handles your card securely."
- Phone: one sequence, with a Tip button always in view at the bottom while the form is available.
- Footer: "Report this page", and "Get your own TipMe page". Pro pages hide the second.

## 6. Covers

Precedence: uploaded photo, then chosen design, then automatic.

- **Automatic:** from the handle, stably, one of `scattered`, `large`, `dark`. No database write.
- **Designs:** six heart designs (`scattered`, `large`, `dark`, `outline`, `ripple`, `rising`) and eighteen pattern designs (`indigo`, `woven`, `danfo`, `harmattan`, `lagoon`, `citylights`, `vinyl`, `waveform`, `sunburst`, `engraved`, `contour`, `flow`, `geometry`, `overprint`, `paper`, `terrazzo`, `opcheck`, `confetti`).
- **Colour:** heart designs other than `dark` take a colour: `neutral` (default), `violet`, `lilac`, `forest`, `ocean`, `sun`, `rose`. Violet and lilac are a recorded exception to "purple is not background decoration", chosen by the person, never automatic.
- **Upload:** JPEG, PNG or WebP up to 5 MB, re-encoded to 2240×600 WebP with metadata dropped, the same safeguards as profile photos.
- All covers and designs are free. Focal points sit near the centre so the tipping panel and phone crop don't hide them.

The set is a catalogue: removing an option means deleting one entry.

## 7. QR designs

- **Free:** `purple`, `night`, `clean`, drawn as today.
- **Pro styles:** heart, jewel, stitch, keys, petals, chips, coin, heartshape, liquid, pillars, diamond, sparkle, circles, leaf, dusk, lagoon, naira, and `mosaic` (the person's own photo).
- **Pro collection cards:** indigo, woven, danfo, harmattan, lagoon, citylights, vinyl, sunburst, engraved, contour, geometry, paper.
- **The server draws Pro designs**, and only sends a real one to a Pro page. The browser never holds the drawing code.
- **Free preview:** the same design with a burned-in "Preview" mark, encoding the TipMe home page, with an upgrade action in place of print, download and full screen. A screenshot leads to TipMe, not to the person's page.
- **Retired:** the old `sunset`, `glow` and `stripe` styles. Pages holding one show `purple`.
- **Formats (Pro), composed in the browser around the server's code:** counter card, poster, round sticker, ticket, receipt slip, phone lock screen, business card, hang tag.
- **Leaving Pro:** codes already printed keep working, because they lead to the same link. New Pro prints stop.
- This can't stop anyone putting their public link into another QR generator; what's sold is the design.

## 8. Handle rule

- Free: can't change a handle once claimed.
- Pro: 3 changes in total, counted on the server, including switching back to an old handle. A change of letter case alone is not a change.
- After the last one: the form is replaced by a message to contact the team. Staff can allow more, with a reason, logged.
- Before saving, a confirmation shows the new handle, that old links keep working, and how many changes remain.
- The count starts at zero when this ships. Leaving Pro keeps the handle; upgrading doesn't reset the count.
- Old handles keep leading to the page and stay unclaimable. The limit of 5 old handles goes, since the change count now bounds them.

## 9. Builder's calls, for the owner to check

Chosen so work can start; each is small to change:

- Everything shown in the mockups ships, except the logo code and the earlier `Sunset`, `Glow`, `Stripe`. The owner hasn't yet cut the list.
- Covers free; QR designs Pro.
- Free preview leads to the home page (as drawn in the mockup), tagged so scans can be counted.
- Printed Pro codes keep working after Pro ends.
- Pro hides the "Get your own TipMe page" footer.
- Staff's handle allowance uses the existing `pages.plan` permission until admin roles lands.

## 10. Before launch, outside this build

Phone and print scan tests on several devices with a minimum print size; review of `indigo` and `woven` by a Nigerian designer or textile specialist; approval of the payment wording against real checkout behaviour.
