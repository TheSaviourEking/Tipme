# Adult-platform links (OnlyFans, Fansly)

The owner's decision of 5 Nov 2026 allows OnlyFans and Fansly links on Pro pages only. That is a
product decision. It is not legal advice, and it is not a regulatory or payment-partner approval
(`docs/00-DECISIONS.md`). Two things are still open:

- **The payment partner's written position** on pages that link to adult platforms.
- **The acceptable-use section of the Terms**, which is still only a heading.

`ADULT_PLATFORM_LINKS` is the lever for when the partner answers.

| Setting            | What it does                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `on` (the default) | Pro pages can add OnlyFans and Fansly links, and they show.                                                                                                        |
| `off`              | They show on no public page, and no one can add a new one (`409 SOCIAL_LINK_UNAVAILABLE`). Stored links are kept, and their owners see them marked as not showing. |

**Nothing is deleted either way.** Turning it back `on` brings every stored link back as it was.

## Switching it

1. **Set the value:** in the API's settings, set `ADULT_PLATFORM_LINKS=off` (or `on`). In production that is
   `/srv/tipme-production/production.env`. In staging it is the staging env file. Check it by name only:
   `grep -c '^ADULT_PLATFORM_LINKS=off$' production.env`.
2. **Restart the API:** the API reads the setting when it starts, so it takes effect with the next ship
   (`docs/runbooks/production.md`).
3. **Wait for the pages:** cached public pages catch up within the web cache's backstop, about 30 seconds after
   their next visit (`apps/web/src/lib/profiles-api.ts`). A page also refreshes at once when its owner saves.
4. **Check:** open a Pro page known to have such a link, and confirm it no longer shows.

## Notes

- **Not a no-deploy switch:** it needs the API to restart. If one is needed, a staff-side switch like the
  withdrawals switch would be a separate piece of work.
- **What it covers:** only the two listed sites. A Pro page's own website can still point anywhere, so
  acceptable use and the page's Report button still matter.
