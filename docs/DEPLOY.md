# Deploy checklist

Everything below needs your accounts. Do them in order.

## 1. Neon (database)

1. Create a project at neon.tech.
2. Copy the **pooled** connection string (the host contains `-pooler`).
3. Put it in `.env.local` as `DATABASE_URL=...`, then:

Locally, everything uses an isolated `dev` schema. To work on the live tables from your machine (for example the
import below), prefix the command with `DB_SCHEMA=public`.

```bash
DB_SCHEMA=public npm run db -- migrate            # creates the tables
DB_SCHEMA=public npm run db -- import-brief 2026-W40   # loads the real brief so the site has data on day one
DB_SCHEMA=public npm run db -- import-domains     # optional: loads the starter domains
DB_SCHEMA=public npm run db -- status             # confirm
```

## 2. GitHub

Create a repository and push the contents of this folder. `.env.local` and `.cache/` are gitignored; the CI workflow
(`.github/workflows/ci.yml`) runs typecheck, tests, build and audit with no secrets.

## 3. Vercel

Every Vercel build runs the full test suite first (`vercel-build` in `package.json`), so a failing test blocks the deploy.

Import the repository. Add these **Environment Variables** (Production):

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon pooled connection string |
| `GEMINI_API_KEY` | your Gemini key |
| `GEMINI_MODEL` | `gemini-3.8-flash` (optional; this is the default) |
| `CRON_SECRET` | any long random string you invent |
| `RESEND_API_KEY` | your Resend key |
| `EMAIL_TO` | recipient address (with no verified domain, Resend only delivers to your own Resend account email) |
| `APP_URL` | the deployed URL, e.g. `https://pulse-ai.vercel.app` |

`vercel.json` already schedules the Monday 00:00 UTC cron.

## 4. Scheduling

Nothing to do: `vercel.json` schedules the Monday run on Vercel Cron (00:00 UTC) plus six follow-up steps, and Vercel
sends `CRON_SECRET` automatically. Optional extra driver: add `.github/workflows/tick.yml` to the repository (this needs a
GitHub token with the `workflow` scope) and set the repository secrets `APP_URL` and `CRON_SECRET`.

## 5. Verify

```bash
curl https://<your-app>/api/health        # database "ok", gemini/cron/admin "configured"
```

Then trigger one real run without waiting for Monday: Vercel dashboard, the project, **Settings, Cron Jobs**, then **Run** next to `/api/run`. Watch
`https://<your-app>/status`. When it finishes, the home page shows the new brief and (if email is configured) one email arrives.

## Things to expect

- Vercel Hobby cron fires "within the hour" of its scheduled time. The six follow-up steps and the 02:00 UTC cutoff absorb this.
- Resend's shared sender (`onboarding@resend.dev`) only delivers to your own account's email address.
- The first live run on a fresh database re-scores every paper (nothing is cached yet).
