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
