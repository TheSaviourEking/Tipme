# Runbook: the changelog and What's new

**When:** switching the changelog on, a draft or a "now live" mark went missing, rotating the signing secret, or a deploy summary warns about entries stuck for 14 days.

How it works (the plan is `.superpowers/program/plans/2026-11-05-changelog.md`):

- **Drafts.** When a pull request merges into `dev`, `.github/workflows/changelog-draft.yml` runs `scripts/changelog-send.mjs`. It sends the PR's number, title, body, merge commit and merge time to TipMe, signed with `CHANGELOG_SIGNING_SECRET`. TipMe keeps a staff text (the title and the body's first paragraph) and a user text (the PR's **For users** section). It never stores the body. An empty For users section makes the entry staff only. A PR TipMe already has is left alone, so staff edits are never overwritten.
- **On staging, then live.** After each deploy's release check passes, `deploy-staging.yml` and `deploy-production.yml` run `scripts/changelog-sync.mjs`. It asks TipMe which entries that environment has not run yet, and gets back numbers and merge commits only. It then checks each merge commit with `git merge-base --is-ancestor <merge commit> <deployed version>`, and tells TipMe which ones the version contains. The job summary says "Changelog: N entries now live (#…)".
- **The step never fails a deploy.** It is `continue-on-error`. A failed step shows as failed on the step only: the job, the deploy's result and its Slack message are unchanged. The next deploy, or the **Changelog sync** workflow, catches up, because every pending entry is checked against the running version each time.
- **Where entries live.** Drafts and both marks ("on staging" and "live") are kept in **production's** database, because that is where staff and users read them (Open Q3). Staging's own database gets nothing. So `CHANGELOG_API_URL` is production's API for every workflow.
- **What users see.** Users only ever see an entry once it is approved in `/ops/changelog` and live in production.

## Turning it on

Do this once all six changelog PRs are in production.

1. **Make a secret.** `openssl rand -base64 48` gives 64 characters (48 bytes). Keep it in the password manager. Never paste it into an issue, a PR, a chat or a job log.
2. **Set it on the server.** Put `CHANGELOG_SIGNING_SECRET=<secret>` in production's env file on the server (`/srv/tipme-production/production.env`; the template is `deploy/production.env.example`). The compose files pass it to the API only.
3. **Set it in GitHub.** Go to Settings → Secrets and variables → Actions → **Secrets**, and add the repository secret `CHANGELOG_SIGNING_SECRET` with the same value. Use a repository secret, not an environment one: the draft workflow runs in no environment.
4. **Set the API URL.** In the same place, under **Variables**, add `CHANGELOG_API_URL` = production's API URL (the same as `PRODUCTION_API_URL`).
5. **Deploy production**, so the API reads the secret. Until the API has it, the changelog routes answer 404.
6. **Check it.** Merge a PR into `dev`. The **Changelog draft** run should say "Changelog: #N drafted.", and the entry should appear in `/ops/changelog`. The next staging deploy's summary should say "now on staging".

Until steps 3 and 4 are done, every changelog step only notes "Changelog not set up" and passes. PRs merged before then get no entry (Open Q8). Resend the ones you want, as below.

Staging's own API does not need the secret (Open Q3). Set it there only if the owner wants drafts in staging's database for testing. That also needs a second, staging-only URL, which no workflow uses today.

## Writing the For users section

The PR template has a `## For users` section. Write one or two plain sentences a recipient would notice, such as "You can now pin a supporter note.". Leave it empty when they won't notice anything: the entry is then staff only, and needs no approval.

Never name our payment partner, and never say TipMe is licensed, regulated or approved. The admin refuses to publish text like that, but it is easier not to write it.

A body over 128 KiB (very rare) is cut from the end before it is sent. Keep For users near the top, where the template puts it.

## Resending a draft

Go to Actions → **Changelog draft** → Run workflow, and enter the PR number. The run reads the PR with `gh pr view` and sends it again.

- It only sends a PR that was **merged into `dev`**. Anything else stops with an error.
- If TipMe already has the entry, nothing changes ("already drafted"). A resend never undoes staff edits.
- To start an entry's text over, edit it in `/ops/changelog`. Resending does not do that.

## Running a sync by hand

Go to Actions → **Changelog sync** → Run workflow, and choose `production` or `staging`.

1. It reads the running version from that environment's `/health/release`.
2. It checks out full history.
3. It marks every pending entry that version contains.

Running it twice is harmless: a mark is only ever set once, and keeps its first date.

Use it when a deploy's "Changelog" step failed (the step shows failed, the job still passes), was skipped, or ran before the secret was set.

## Rotating the secret

1. Make a new secret (step 1 above).
2. Set it in the server's env file **and** in the Actions secret.
3. Deploy production, so the API picks it up.

Between steps 2 and 3, signed calls are refused ("signature refused (401)"). Drafts sent in that gap fail, so resend them afterwards, and run **Changelog sync** for production. To keep the gap short, do steps 2 and 3 together. If the secret leaked, rotate at once. A leaked secret lets someone add drafts and mark entries live. It cannot publish anything to users, because users only see entries after an approval in `/ops/changelog`. It also cannot read anything beyond PR numbers and merge commits.

## What the messages mean

| Message                                                                                   | Meaning and what to do                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Changelog not set up: … is not set`                                                      | The secret or the URL variable is missing. Expected before switching on, and nothing to do. After switching on, check steps 3–4.                                                                                                                                                                                                                                 |
| `signature refused (401)`                                                                 | The secret differs between GitHub and the server, or the runner's clock is more than 5 minutes off. Check both values (without printing them), then deploy production.                                                                                                                                                                                           |
| `TipMe answered 404`                                                                      | The API has no secret (the feature is off), or `CHANGELOG_API_URL` points at the wrong place.                                                                                                                                                                                                                                                                    |
| `TipMe answered 429`                                                                      | More than 60 calls a minute from one runner. Wait a minute and run again.                                                                                                                                                                                                                                                                                        |
| `Skipped, merge commit not in this checkout: #N`                                          | TipMe has an entry whose merge commit this repository doesn't have, for example a resend from a fork or a rewritten branch. Check the PR, and withdraw the entry in admin if it never really merged.                                                                                                                                                             |
| `not in this version after 14 days: check that main still merges dev with a merge commit` | Production has run for 14 days without containing these merges, judged by the commit date in git. Usually `dev` was squashed or rebased into `main`, which breaks ancestry. Merge `dev` into `main` with a merge commit again. If a change was dropped on purpose, withdraw its entry. On staging, the same warning says "check that staging still deploys dev". |

## Known limits

- **`main` must take `dev` through a merge commit.** A squash or rebase of `dev` into `main` breaks ancestry, so those entries never go live. The 14-day warning makes this visible, but cannot fix it.
- **A hotfix merged straight into `main`** (like #135) gets no entry of its own. Its twin into `dev` gets one, which goes live only when `dev` next reaches `main`, so its date may be later than the real one.
- **A rollback does not un-live entries** (Open Q6). If a change is really gone, withdraw its entry in admin.
- **No backfill** (Open Q8). The changelog starts at the first PR merged after switching on. Resend older PRs one by one if wanted.
- **PRs from forks** get no secrets on `pull_request` runs, so they are not drafted. Resend them by hand after merging.
- **Live means production ran it**, not that a user saw it. "On staging" is set by staging deploys of `dev`. Production's mark is set only after production's release check confirms that version is serving.
