# Adult-platform links (OnlyFans, Fansly)

The owner's decision of 5 Nov 2026 allows OnlyFans and Fansly links on Pro pages only. That is a
product decision. It is not legal advice, and it is not a regulatory or payment-partner approval
(`docs/00-DECISIONS.md`). Two things are still open:

- **The payment partner's written position** on pages that link to adult platforms.
- **The acceptable-use section of the Terms**, which is still only a heading.

The `adult_platform_links` switch in admin (`/ops/switches`, **OnlyFans and Fansly links**) is the lever for
when the partner answers. It replaced the `ADULT_PLATFORM_LINKS` setting (owner, 14 Nov 2026).

| Setting            | What it does                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `on` (the default) | Pro pages can add OnlyFans and Fansly links, and they show.                                                                                                        |
| `off`              | They show on no public page, and no one can add a new one (`409 SOCIAL_LINK_UNAVAILABLE`). Stored links are kept, and their owners see them marked as not showing. |

**Nothing is deleted either way.** Turning it back `on` brings every stored link back as it was.

## Switching it

1. **Set it in admin:** at `/ops/switches`, find **OnlyFans and Fansly links** (it replaced `ADULT_PLATFORM_LINKS`), choose on or off, give a
   reason and enter a fresh code. It is audited and shows in the switch's history (`settings-and-switches.md`).
2. **No restart:** the API copy that took the change uses it at once; the others within 15 seconds (at once while
   live updates are on).
3. **Wait for the pages:** cached public pages catch up within the web cache's backstop, about 30 seconds after
   their next visit (`apps/web/src/lib/profiles-api.ts`). A page also refreshes at once when its owner saves.
4. **Check:** open a Pro page known to have such a link, and confirm it no longer shows.

## Notes

- **A no-deploy switch** since 14 Nov 2026: staff with `switches.manage` set it; no restart.
- **What it covers:** only the two listed sites. A Pro page's own website can still point anywhere, so
  acceptable use and the page's Report button still matter.
