# Social links (5 Nov 2026)

Spec: the SocialLinks board (`.superpowers/program/SocialLinks.board.html`, design artifact 8D6hJZsqMkLSGh8KUUBmmh v97),
approved by the owner on 5 Nov 2026 as designed. OnlyFans and Fansly are Pro only, by the owner's decision.
Branch `feat/social-links` from `origin/dev` d0325dd. Migration `0072_social_links` (regenerated after dev landed 0071).

## Tasks

1. **Catalogue and rules (contracts).** `SOCIAL_PLATFORMS`: key, label, badge, hosts, tier, featured wording.
   `socialLinksSchema` (https, no user or password, 200 characters, the site's own hosts, no link-list hosts),
   `detectPlatform`, `linkHandle`, `linksNeedPro`, `visibleLinks`, `mergeFreeSave`. Unit tests first.
2. **Storage and the save (database).** New column `profiles.links` (jsonb array), backfilled from `socials`, which
   stays in place. `setMyLinks` locks the page row in a transaction, so a plan change waits for the save to finish.
   Refuses Pro-only saves on Free (`SOCIAL_LINKS_PRO_REQUIRED`). `publicProfile` returns `visibleLinks`.
   `socials` is removed from the profile PATCH. Integration tests first.
3. **API.** `PUT /v1/me/links` `{ links, show }`, with errors per field (`links.N.url`), and the 403 code and its
   message. Integration test through HTTP.
4. **Web.** The "Your links" section from the board, and the public link row and featured key. Falls back to an older
   API's `socials`. E2E tests: a Free page, a Pro page, and a lapsed Pro page. Axe and keyboard checks.
5. **Decision record.** `docs/00-DECISIONS.md`, worded as a product decision, with its open items.

## Interfaces

```ts
type SocialPlatform = 'tiktok' | 'facebook' | … | 'website';
interface SocialLink { platform: SocialPlatform; url: string; featured?: true }
PUT /v1/me/links  { links: SocialLink[]; show: boolean } -> MyProfile
MyProfile.links?: SocialLink[]          // everything stored, hidden ones included
PublicProfile.links?: SocialLink[]      // only what this plan shows, in order
```

## Rules

- **Free:** up to 3 links, Free-tier sites only, in catalogue order, and no featured link.
- **Pro:** up to 8 links, any order, and at most one featured.
- **Pro lapsed:** the page shows the first 3 Free-tier links in the saved order, unfeatured.
- **Free save:** it replaces only the links that show on Free. The hidden ones are kept after them, so nothing is
  lost. Storage holds at most 11 links (8 plus 3).

## Review Focus

- **Plan race:** the save and a staff plan change, both on the locked row.
- **No data loss:** the backfill, and the Free save that keeps hidden links.
- **Website check:** it rejects link-list hosts, URL shorteners, catalogue hosts, IP addresses and ports.
- **Accessibility:** a label and an error for each field, Move up and Move down buttons as well as drag, and where
  focus goes after a move or a removal.
- **Press counts:** left out. Analytics is staff-only and off in production until D-07.
