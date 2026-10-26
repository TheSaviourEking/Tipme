# Web deployment branches

The Vercel `tipme` project builds this directory (`apps/web`).

- `dev` creates Preview deployments for `https://staging.usetipme.xyz`.
- `main` creates Production deployments for `https://www.usetipme.xyz`.

Keep the staging domain assigned to the `dev` branch. Use Preview environment
variables for the staging API, site URL and password gate; Production settings
belong to the public site.

Vercel skips monorepo deployments when no web files or dependencies changed.
An empty commit is therefore not a reliable way to create the first deployment
after assigning a branch domain. Redeploy the branch from Vercel, or push an
actual change to this application. Confirm the deployment is Ready and the
staging domain is attached before running the staging release check.

## Production countdown for 27 October 2026

The application treats `https://www.usetipme.xyz` as the production authority.
`https://usetipme.xyz` must remain assigned in Vercel as an alias/redirect; verify
both hostnames during release rather than changing `SITE_URL` away from `www`.

Before deploying the countdown:

1. Set the Production environment variable exactly to
   `PRODUCTION_LAUNCH_AT=2026-10-26T23:00:00Z`. This is 27 October 2026 at
   00:00 WAT (`Africa/Lagos`, UTC+01:00).
2. Keep the variable server-only. Do not add a `NEXT_PUBLIC_` equivalent.
3. Confirm the production deployment built from the intended `main` commit and
   that both production domains point to it.
4. Before midnight, request `/`, `/@ada`, `/dashboard` and `/ops`. Each URL must
   stay visible in the address bar while showing the same countdown. Confirm the
   response is `no-store`, the page is `noindex`, and `/robots.txt`,
   `/sitemap.xml` and `/api/revalidate` are not rewritten to the holding page.
5. Check the layout at 320px and desktop width, the exact displayed time
   `27 October 2026 · 00:00 WAT`, and the route-specific social image.

At 00:00 WAT, request both production hostnames in a fresh browser and verify:

- `/` serves the public site, not the countdown;
- `/coming-soon` redirects to `/`;
- `/people/ada` resumes its permanent redirect to `/@ada`;
- `/@ada`, sign-in and staff entry routes reach their normal applications; and
- CDN responses do not retain the pre-launch rewrite.

After the release is verified, remove `PRODUCTION_LAUNCH_AT` from the Production
environment and redeploy. Unset environments retain the normal application, so
removing it is cleanup rather than the release mechanism. Keep the countdown
route and tests until the release branch is retired; do not delete them during
the midnight check.
