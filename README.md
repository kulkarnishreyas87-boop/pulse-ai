# Pulse-AI
n**Live:** https://pulse-ai-brief.vercel.app (also https://research-pulse-sandy.vercel.app)

Weekly AI/ML research brief, organised by domain. All AI calls use Gemini Flash.
Components Map: `docs/components-map.png`.

## Run locally

```bash
cp .env.example .env.local   # fill in keys (optional for step 1: the seed brief renders without them)
npm install
npm run dev
```

- `/` shows the latest brief from Neon, or the committed sample brief when the database is empty or not configured.
- `/api/health` reports database, Gemini, email, cron and admin configuration status (never secrets).

## Build status

- [x] Step 1: skeleton, Zod schema, storage layer, Gemini JSON client, seed brief page
- [x] Step 2: arXiv ingest and prefilter (`npm run ingest -- --domain rag`, `npm test`)
- [x] Step 3: score, summarise, verify, plus eval harness
  - `npm run brief -- --domain rag` runs Gemini scoring, ranking, writing and verification on live data
  - `npm run live-check` runs adversarial checks against the real model (hallucination, hype, prompt injection)
  - `npm run eval -- --init` then label papers in `eval/golden.json`, then `npm run eval` for recall/precision
- [x] Step 4: compose and word budget (`npm run compose -- --week 2026-W40`; page now shows the real brief, archive at `/brief/<week>`)
- [x] Step 5: domain settings and query expansion (`/settings`, edits domains with no code change; AI suggests search terms)
- [x] Step 6: job queue and Vercel Cron (`/api/run`, `/api/step`, `/status`)
- [x] Step 7: email via Resend (`npm run email:preview` renders it without sending; `-- --send` sends one test)
- [x] Step 8: hardening, failure-mode tests (`docs/FAILURE_MODES.md`, `docs/EVALUATION.md`, `docs/DEPLOY.md`)
- [x] Search: a Search button in the top bar opens `/search`, which finds a topic, paper, author or domain across the last 26 weekly briefs (no AI call)
- [x] Save for later: a Save button on every paper; `/saved` lists them (kept in the reader's browser, no account)

## Deploy

Import the repo into Vercel, then add the env vars from `.env.example`.

## How a week runs (step 6)

Monday 00:00 UTC, Vercel Cron calls `/api/run`, which creates the week's job graph (idempotent) and starts working
through it. Twelve more Vercel Cron entries (00:10 to 06:00 UTC) call `/api/step`. Each step runs jobs for up to about
4 minutes and returns, inside Vercel's 5-minute function limit. No job makes more than one Gemini call. A full week
needs about 20 minutes of work (115 jobs), so the first five or six steps normally finish it and the rest are slack
for retries. Vercel Cron is the only scheduler in use.

```
hf ─┐
fetch ×10 (one per day: the week + 3-day look back) ─► prefilter ─► judge ×N ─► write ─► verify ─► synth ─┐
                                                                                                          ├─► compose ─► email
(other domains in parallel) ──────────────────────────────────────────────────────────────────────────────┘
```

**Why the 3-day look back:** arXiv publishes in nightly batches, and anything submitted after Thursday afternoon
(US Eastern) only goes public on Monday evening, after the Monday-morning run. Each run therefore also fetches
the 3 days before its week and skips papers an earlier run already covered, so every paper appears exactly once,
in the first brief after it became public (see `lib/coverage.ts`).

Failures degrade instead of stopping: a failed fetch day is skipped (brief flagged stale), failed scoring shows
abstract excerpts, and at the cutoff (Monday 02:00 UTC) the brief publishes with what is ready, marked partial,
and is recomposed once if late domains finish. If no domain produced any content, nothing is published and the
previous brief stays in place.

Vercel sends `CRON_SECRET` to the cron routes automatically.

## Email (step 7)

After `compose` publishes, an `email` job sends the brief through Resend: top three, one line per domain card,
and a link to the full brief, with a plain-text part. Guarantees:

- At most one email per week and variant (partial, full): a guard is taken before sending, and Resend's
  Idempotency-Key stops a retry after a timeout from delivering twice.
- A partial brief is emailed at the cutoff; if late domains finish, one "Updated" email follows.
- Missing config (no key or recipient) skips the email; it never fails the week.
- Paper titles and URLs are third-party text: everything is HTML-escaped and only plain https arXiv links are linked.
- If nothing could be published, nothing is emailed.

## Database (Neon Postgres)

All data is stored in Neon: `briefs` (one row per published week, the archive the page reads), `domains`
(the monitored domains edited on Settings), and `kv` (job queue state, leases, cached scores, "email sent" guards;
rows expire). Tables are created automatically on first use, or explicitly with `npm run db -- migrate`.

```bash
npm run db -- migrate              # create tables
npm run db -- import-brief 2026-W40  # load a locally generated brief
npm run db -- status               # row counts, weeks, domains
```

Claiming a job is a single atomic `INSERT ... ON CONFLICT ... WHERE expired` statement, so concurrent serverless
invocations cannot run the same job. The Postgres code is tested against a real in-process Postgres (PGlite).

## Documentation

- `docs/components-map.png`: the Components Map (source: `components-map.html`)
- `docs/FAILURE_MODES.md`: where it can go wrong, what stops it, and the evidence (including known gaps)
- `docs/EVALUATION.md`: measured results from a real week
- `docs/DEPLOY.md`: step-by-step deployment and verification
