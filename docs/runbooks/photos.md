# Runbook: page photos and covers in Cloudflare R2

Page photos and uploaded covers are re-encoded by the API (photos 512×512 WebP, about 30 KB; covers 2240×600 WebP; no metadata in either). Where they're kept:

- **R2 configured:** in a **private** R2 bucket, with the database row holding only the object's key.
- **R2 not configured:** in Postgres, as before. Local development and tests use this.

The bucket is never public. The API serves each photo at `/v1/avatars/<page>/<version>.webp` and each cover at `/v1/covers/<page>/<version>.webp`, and only while the page is live and not paused. So a hidden page's photo stays hidden, even to someone who saved its link.

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

## How it behaves

- **Upload:** the photo goes to R2 first, then its row. If the row fails, the new object is removed. The old object is removed after the new row is saved.
- **Remove a photo, or delete an account:** the row goes first, then the object. A failed object removal only leaves an unused object; it never breaks a page.
- **Covers are bigger than photos.** Measured at 2240×600, quality 80: about 40 to 160 KB typically (2 to 5 times a photo), about 630 KB at worst. These are from test images, not real camera photos. Without R2 they sit in Postgres, in every dump, and in the WAL, including staging's archive, every time one is replaced. WebP won't compress further, and the 48 GB disk is shared with production, where WAL growth is the known risk. Switch R2 on before 500 pages have an uploaded cover (`SELECT count(*) FROM profile_covers WHERE bytes IS NOT NULL`).
- **Moving doesn't give the disk back.** After step 5 the space is reusable by Postgres but only returns to the disk after `VACUUM FULL profile_covers`, which locks the table: plan it.
- **A failed object removal is logged, not retried.** `PhotoStore` has no list operation and there is no retry queue, so if removing an object fails (after a replace, a removal, a staff takedown or an account deletion) the API logs `photo_object.remove_failed` with `kind` and `objectKey` (`<kind>/<page id>/<random>.webp`: opaque ids, no handle or email). That line is the only record: search the logs for it and delete that key in Cloudflare R2 by hand. A deleted person's file therefore stays until someone does; check for the event after any R2 incident. If these ever appear in practice, add a table the worker retries from.
- **Staff review and removal.** On the admin Pages screen, staff with `pages.suspend` can view a cover or photo (each view is audited) and remove either with a written reason. The owner gets an email without the reason. The URL never returns, even after a pause and restore. The owner can upload another straight away.
- **Backups:** the database dumps hold the photo keys, not the photos. R2 keeps the objects; Cloudflare doesn't version them unless you turn that on.
