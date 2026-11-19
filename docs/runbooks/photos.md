# Runbook: page photos and covers in Cloudflare R2

Page photos and uploaded covers are re-encoded by the API (photos 512×512 WebP, about 30 KB; covers 2240×600 WebP; no metadata in either). Where they're kept:

- **R2 configured:** in a **private** R2 bucket, with the database row holding only the object's key.
- **R2 not configured:** in Postgres, as before. Local development and tests use this.

The bucket is never public. The API serves each photo at `/v1/avatars/<page>/<version>.webp` and each cover at `/v1/covers/<page>/<version>.webp`, and only while the page is live and not paused. So a hidden page's photo stays hidden, even to someone who saved its link. Business logos sit in the same bucket under `logos/<business id>/<random>.webp`; the API serves each at `/v1/business-logos/<business>/<version>.webp` only while the business is verified (its managers and TipMe staff read it through their own signed-in routes whatever its status). The move script below moves them with the photos.

## Switching R2 on (per copy: staging, then production)

1. **Create the bucket.** In Cloudflare: R2 → Create bucket, e.g. `tipme-staging-photos`. No public access, no custom domain.
2. **Create an API token.** R2 → Manage API tokens → Create: **Object Read & Write**, limited to that bucket. Note the Access Key ID, the Secret Access Key, and your Account ID (shown on the R2 overview).
3. **Add the settings** to the copy's env file (e.g. `/srv/tipme/staging.env`):
   ```sh
   R2_ACCOUNT_ID=<account id>
   R2_ACCESS_KEY_ID=<access key id>
   R2_SECRET_ACCESS_KEY=<secret access key>
   R2_BUCKET=tipme-staging-photos
   ```
   You need all four, or none: with only some set, the API refuses to start and names the missing ones.
4. **Deploy.** New photos go to R2.
5. **Move the photos and covers already in Postgres.** It's safe to run twice:
   ```sh
   /srv/tipme/live/scripts/compose.sh run --rm \
     -e R2_ACCOUNT_ID -e R2_ACCESS_KEY_ID -e R2_SECRET_ACCESS_KEY -e R2_BUCKET \
     migrate node packages/database/dist/scripts/move-photos-to-r2.js
   ```
   (The `migrate` service has the database URL. Export the four R2 variables in your shell first, or pass `--env-file`.)
6. **Check:** open a page with a photo, and upload a new one. In Cloudflare, the bucket shows `avatars/<page id>/<random>.webp`, and covers under `covers/<page id>/`.

## Cover sizes (renditions)

Each uploaded cover is also kept at 640, 1080 and 1600 wide (WebP, quality 75, same shape, no metadata), in table `profile_cover_renditions`, wherever the cover itself is: in Postgres beside its row, or in R2 beside its object as `covers/<page id>/<random>-<width>-<salt>.webp`. The Studio styles that show the cover full-bleed on phones use them through `srcset`; the standard profile page still uses the full file. They are served at `/v1/covers/<page>/<version>-<width>.webp` under the cover's rules (live, not paused, current version, one-hour cache); any other width is not found. Replacing, removing, a staff removal and account deletion remove them with the cover; the move script above moves them too.

Measured on a generated test photo (`apps/api/test/photo-like.mjs`): full cover 118 KB, 1600 wide 25 KB, 1080 wide 15 KB, 640 wide 8 KB.

**Tall crops.** Each cover also gets the 4:5 region the phone hero of Stage and Horizon shows (`object-fit: cover`, `object-position: 50% 33%`): the full band height, centred across, so a 2240×600 cover gives a 480×600 crop cut at x=880. Widths 480 and 720 (`COVER_TALL_WIDTHS`), never upscaled, so a 2240×600 cover gets only 480. Same table, with `shape = 'tall'` (the wide copies are `shape = 'wide'`; migration `0116_cover_tall_crops`), same lifecycle and rules, served at `/v1/covers/<page>/<version>-tall-<width>.webp`, in R2 as `covers/<page id>/<random>-tall-<width>-<salt>.webp`. The public profile lists them as `tall`. Measured on the same generated photo: 480×600 is 23 KB. The two width lists never overlap, so an API from before `shape` (blue/green) never serves a crop as a wide copy.

**Covers uploaded before this release have no sizes.** They keep working: the public profile simply lists no `widths` (or no `tall`) for them, and pages use the full file. The backfill fills in whichever a cover lacks: the wide copies, the tall crop, or both; a shape a cover already has is never rewritten. To give them sizes, the owner runs the backfill once per copy (staging, then production), in the API image, which has the image library. It is a dry run unless `--write` is given, and safe to run again:

```sh
# 1. Dry run: counts the covers without sizes, changes nothing.
/srv/tipme/live/scripts/compose.sh run --rm \
  -e R2_ACCOUNT_ID -e R2_ACCESS_KEY_ID -e R2_SECRET_ACCESS_KEY -e R2_BUCKET \
  migrate node apps/api/dist/scripts/backfill-cover-renditions.js
# 2. Write them.
/srv/tipme/live/scripts/compose.sh run --rm \
  -e R2_ACCOUNT_ID -e R2_ACCESS_KEY_ID -e R2_SECRET_ACCESS_KEY -e R2_BUCKET \
  migrate node apps/api/dist/scripts/backfill-cover-renditions.js --write
```

- **A run killed mid-cover** (stopped, out of memory, lost connection) can leave up to five salted objects in R2 (`covers/<page>/<random>-<width>-<salt>.webp`, `…-tall-<width>-<salt>.webp`) that no row names. The backfill logs each key (`writing <key>`) before it writes it: after an interrupted run, delete in Cloudflare any key logged for a cover that has no matching `object_key` in `profile_cover_renditions`. Running it again is still safe; it writes new keys.
- **Blue/green overlap.** While the old API (from before renditions) and the new one both run, an upload or removal through the old one doesn't know about renditions. A replaced cover keeps rows for its previous version (never served or listed, and the next backfill drops them and their objects). A removal through the old API cascades the rows away and leaves their R2 objects unnamed. Keep the overlap short, and run the backfill after it.

Pass the R2 variables only on a copy with R2 switched on; without them, covers kept in R2 are skipped and counted. Each line names a page by its id only. Without R2, the sizes add about 70 KB per cover to Postgres (dumps and WAL; the tall crop is 23 KB of it), on top of the cover itself: count them in the 500-cover threshold below.

## How it behaves

- **Upload:** the photo goes to R2 first, then its row. If the row fails, the new object is removed. The old object is removed after the new row is saved.
- **Remove a photo, or delete an account:** the row goes first, then the object. A failed object removal only leaves an unused object; it never breaks a page.
- **Covers are bigger than photos.** Measured at 2240×600, quality 80: about 40 to 160 KB typically (2 to 5 times a photo), about 630 KB at worst. These are from test images, not real camera photos. Without R2 they sit in Postgres, in every dump, and in the WAL, including staging's archive, every time one is replaced. WebP won't compress further, and the 48 GB disk is shared with production, where WAL growth is the known risk. Switch R2 on before 500 pages have an uploaded cover (`SELECT count(*) FROM profile_covers WHERE bytes IS NOT NULL`).
- **Moving doesn't give the disk back.** After step 5 the space is reusable by Postgres but only returns to the disk after `VACUUM FULL profile_covers`, which locks the table: plan it.
- **A failed object removal is logged, not retried.** `PhotoStore` has no list operation and there is no retry queue, so if removing an object fails (after a replace, a removal, a staff takedown or an account deletion) the API logs `photo_object.remove_failed` with `kind` and `objectKey` (`<kind>/<page id>/<random>.webp`: opaque ids, no handle or email). That line is the only record: search the logs for it and delete that key in Cloudflare R2 by hand. A deleted person's file therefore stays until someone does; check for the event after any R2 incident. If these ever appear in practice, add a table the worker retries from.
- **Staff review and removal.** On the admin Pages screen, staff with `pages.suspend` can view a cover or photo (each view is audited) and remove either with a written reason. The owner gets an email without the reason. The URL never returns, even after a pause and restore. The owner can upload another straight away.
- **Backups:** the database dumps hold the photo keys, not the photos. R2 keeps the objects; Cloudflare doesn't version them unless you turn that on.
