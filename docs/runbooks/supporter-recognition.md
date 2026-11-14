# Supporter recognition (repeat supporters)

The owner's decision of 5 Nov 2026 lets a supporter choose, on a Pro page's tip form, "Let {name} recognise me
next time" (option (a) of the Pro additions board). That is a product decision. It is not legal advice, and it is
not a regulatory, data-protection or payment-partner approval (`docs/00-DECISIONS.md`). Decision D-07, the privacy
review, is still open, and **whether recognition should wait for it is the owner's call**.

## How it works

- The tick box shows only on Pro pages, only once the supporter has typed a name, and is off by default.
- When ticked, the supporter's browser makes a random key for that one recipient and keeps it in its own storage
  (`tipme.supporters.v1`). The API stores only the key's SHA-256 (`supporters.key_hash`) and links the tip to it
  (`tip_supporters`). It is never a card, IP, device or browser fingerprint, and keys differ per recipient.
- Any receipt of a recognised tip has "Stop {name} recognising me" (`POST /v1/tips/{tipId}/recognition/stop`, with
  the receipt's status token). It deletes that supporter row; their past tips stop being grouped. The tips stay.

The `supporter_recognition` switch in admin (`/ops/switches`, **Repeat supporters**) is the lever. It replaced the
`SUPPORTER_RECOGNITION` setting (owner, 14 Nov 2026).

| Setting            | What it does                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `on` (the default) | Pro pages offer the tick box (`recognition: true` on the public page), and a ticked tip with a name on a Pro page is recorded.                                       |
| `off`              | No page offers the tick box, and any key sent is ignored: nothing new is recorded. The recipient's supporters list (a later PR) is hidden. Stored rows are all kept. |

**Nothing is deleted either way.** Turning it back `on` shows everything as it was. "Stop {name} recognising me"
keeps working while it is `off`: stopping is always the supporter's to do.

## Switching it

1. **Set it in admin:** at `/ops/switches`, find **Repeat supporters** (it replaced `SUPPORTER_RECOGNITION`), choose on or off, give a
   reason and enter a fresh code. It is audited and shows in the switch's history (`settings-and-switches.md`).
2. **No restart:** the API copy that took the change uses it at once; the others within 15 seconds (at once while
   live updates are on).
3. **Wait for the pages:** cached public pages catch up within the web cache's backstop, about 30 seconds after their
   next visit (`apps/web/src/lib/profiles-api.ts`). Until then a form may still show the tick box; the API ignores
   the key anyway.
4. **Check:** open a Pro page, type a name in the tip form, and confirm the tick box is (or is not) there.

## Notes

- **Deleting an account** deletes that page's supporter rows (and their tip links). The tips themselves stay.
- **What a recipient can never see:** the key, its hash, or anything linking a supporter's tips to other recipients.
- **Logs:** `supporterKey` is on the logger's redaction list (`packages/observability/src/logger.ts`), and request
  bodies are never logged.
