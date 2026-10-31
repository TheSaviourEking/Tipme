# Runbook: page photos in Cloudflare R2

Page photos are re-encoded by the API (512×512 WebP, no metadata, about 30 KB). Where they're kept:

- **R2 configured:** in a **private** R2 bucket, with the database row holding only the object's key.
- **R2 not configured:** in Postgres, as before. Local development and tests use this.

The bucket is never public. The API serves each photo at `/v1/avatars/<page>/<version>.webp`, and only while the page is live and not paused. So a hidden page's photo stays hidden, even to someone who saved its link.

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
5. **Move the photos already in Postgres.** It's safe to run twice:
   ```sh
   /srv/tipme/live/scripts/compose.sh run --rm \
     -e R2_ACCOUNT_ID -e R2_ACCESS_KEY_ID -e R2_SECRET_ACCESS_KEY -e R2_BUCKET \
     migrate node packages/database/dist/scripts/move-photos-to-r2.js
   ```
   (The `migrate` service has the database URL. Export the four R2 variables in your shell first, or pass `--env-file`.)
6. **Check:** open a page with a photo, and upload a new one. In Cloudflare, the bucket shows `avatars/<page id>/<random>.webp`.

## How it behaves

- **Upload:** the photo goes to R2 first, then its row. If the row fails, the new object is removed. The old object is removed after the new row is saved.
- **Remove a photo, or delete an account:** the row goes first, then the object. A failed object removal only leaves an unused object; it never breaks a page.
- **Backups:** the database dumps hold the photo keys, not the photos. R2 keeps the objects; Cloudflare doesn't version them unless you turn that on.
