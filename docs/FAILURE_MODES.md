# Failure-mode register

Where can this system go wrong, what stops it, and what is the evidence? Evidence is labelled honestly:

- **Test** = an automated test in `tests/` (run `npm test`, 117 tests, no API keys needed).
- **Live** = observed against the real arXiv, Hugging Face and Gemini.
- **Open** = not proven yet, with the reason.

## Data and ranking

| # | Failure | Mitigation | Evidence |
|---|---|---|---|
| 1 | **Misses an important paper** (recall) | Wide ingest; a busy domain is split into per-day queries so nothing is truncated; 20% of shortlist slots are reserved for the most-attended matching papers | Test: split and reserve-slot behaviour. Live: found a real truncation (907 matches vs a 600 cap) and fixed it. **Open: recall itself is unmeasured until the golden set is labelled** (`eval/golden.json`) |
| 2 | **Brief full of mediocre papers** | Quality threshold; a domain with nothing above it shows "quiet week" instead of padding | Test: quiet week, off-topic never surfaces. **Open: the 3.4 threshold is a provisional guess** until labels calibrate it |
| 3 | **Hallucinated summary or claim** | Abstract-only prompt; evidence quote must appear verbatim in the abstract (code); every number must appear in the abstract (code); separate fact-check pass; failures fall back to the abstract's own sentences | Test: each guard. Live: verifier caught a planted invented number and a fake "beats GPT-6" comparison; 0 of 15 real cards contained a number absent from its abstract |
| 4 | **Hype presented as significance** | `hype_risk` rubric score, penalty in ranking, high-hype papers cannot be a client flag | Live: a "RAG is solved" abstract scored hype 5 and was out-ranked. **Open: on 100 real papers hype never exceeded 2, so it is rarely exercised** |
| 5 | **Score drift or compression** | Rubric r2 asks the three concrete questions the problem names (new benchmark, surprising result, reframing); any one is enough; a new benchmark only counts as strong with solid evidence (otherwise moderate); hype is the higher of the model's judgement and a **wording check in code**; temperature 0; scores cached per rubric version | Test. r1 observed: novelty was 3 for 76% of real papers; r2 measured in `docs/EVALUATION.md`. **Still open: the threshold needs human labels to calibrate** |
| 12 | **Same paper repeated** (versions, cross-lists, several domains) | Dedupe by arXiv id without version; a paper appears once, in the domain where it is most relevant | Test |
| 13 | **Terminology mismatch** (relevant paper uses unfamiliar words) | Each day also fetches the domain's categories **without** the keyword filter; Gemini embeddings score every paper's similarity to the domain description; a paper qualifies by keywords **or** by meaning (top 3%), with reserved shortlist slots for keyword-free matches | Test: with the keyword query returning nothing, a relevant paper still reaches the brief end to end. Live: see `docs/EVALUATION.md` (new vs old pipeline on the same week) |
| 26 | **Late-week papers never shown** (arXiv publishes them after the Monday run) | Each run also fetches the 3 days before its week and skips papers an earlier run covered | Live: on Sunday 16:05 UTC arXiv showed 232 and 237 cs.AI papers for Wed and Thu, and **0** for Fri, Sat and Sun. Test: a two-week simulation with publication delays shows the weekend papers appear in the next brief and nothing appears twice. **This was a real gap in the original design, found on review** |
| 20 | **Popularity bias** | Attention can order papers but never decides whether a paper is significant | Test: popularity alone cannot make a weak paper pass |

## AI service failures

| # | Failure | Mitigation | Evidence |
|---|---|---|---|
| 6 | **Malformed or off-schema JSON** | JSON mode + Zod validation; one repair attempt that feeds the error back; bounded to 3 tries | Test (6 cases incl. repair prompt, bounded retries, missing key not retried) |
| 7 | **Rate limits, quota, outage** | Exponential backoff; calls spaced; domain degrades to abstract excerpts rather than failing | Test: Gemini fully down still ships a brief. Live: `gemini-2.5-flash` was retired mid-project; the pipeline degraded and then an automatic fallback model was added |
| 14 | **Prompt injection via abstracts** | Abstracts are sanitised, delimited, and declared data in every prompt; output shape is schema-constrained | Test: cannot break out of the delimiter. Live: an abstract demanding "rate this 5/5/5" was not obeyed |
| 22 | **Model retired by Google** | Pinned model plus ordered fallbacks | Live: actually happened |
| 27 | **The weekly takeaway overreaches** (a synthesis that sounds authoritative) | Must cite 2+ papers in the brief, 1+ of them a verified card; no numbers absent from the papers; no "consensus / proves / the field has shifted" wording; 45-word cap; otherwise dropped | Test (every rejection path). A failed takeaway never blocks the brief |

## Source failures

| # | Failure | Mitigation | Evidence |
|---|---|---|---|
| 8 | **arXiv rate limit, downtime, garbage** | 3.1s spacing; retries with backoff on 429/5xx/network/timeout; no retry on 4xx; an HTML page returned with status 200 is rejected, never read as "no papers"; failed days are skipped and the brief is flagged **stale** | Test (5 cases) |
| 11 | **Wrong week or timezone** | One explicit Monday-to-Sunday UTC window, stored on the brief and shown to the reader | Test incl. ISO year edge |

## Pipeline and scheduling

| # | Failure | Mitigation | Evidence |
|---|---|---|---|
| 9 | **Function timeout or crash mid-job** | Jobs split so none makes more than one Gemini call; each job has a lease and a per-job timeout; abandoned jobs are retried | Test: killed worker recovered after lease expiry; hung call times out and is retried. Live: full week in 15 steps of at most 54s |
| 10 | **Cron missed or fired twice** | Every scheduled step also creates the run if the first cron did not, and six follow-up cron steps keep working it; run creation and job claiming are atomic | Test: 6 racing ticks create one run; 16 racing Postgres workers produce one lease winner. Live: the first automatic Monday run on Vercel (12 Oct 2026) finished 73 of 73 jobs and delivered the email |
| 21 | **Storage error while recording a result** | A one-off error marks the job for retry; a full outage leaves the job protected by its lease and recovered later | Test (both cases) |
| 23 | **Every source down** | If no domain produced any content, nothing is published and last week's brief stays in place | Test |
| 24 | **Partial week at the cutoff** | At 02:00 UTC Monday the brief publishes with what is ready, marked partial; recomposed once if the rest finishes | Test |

## Delivery, configuration and security

| # | Failure | Mitigation | Evidence |
|---|---|---|---|
| 15 | **Email duplicated, lost or abused** | One email per week and variant (guard taken before sending); Resend idempotency key; plain-text part; escaped HTML; only plain arXiv links; header-injection-proof subject; missing config skips instead of failing | Test (13 cases incl. dry run). Live: a real email of the live brief was delivered to the inbox (Resend status "delivered", confirmed by the recipient, not in spam) |
| 16 | **Bad domain settings** | Cap of 10 domains; unique names; categories validated against a list; keywords required | Test |
| 17 | **Secrets leaked or endpoints abused** | Cron secret **fails closed in production**; AI suggestions, saves and undo are rate limited; error text redacted in the public status; secret scan across the repository; security headers; API never cached | Test, and verified on a real production build. A scan test caught a real key-lookalike I had pasted into a test file; it was removed |
| 29 | **Someone else edits or deletes the domains** (Settings has no passcode, by the owner's choice) | The **last 10 versions** are kept and undo steps back one per click; saves, undo and AI suggestions are rate limited **per caller in the database** (shared by every server instance, so a script cannot dodge them by hitting different instances); a **daily cap** bounds AI suggestions for everyone; the limiter never fails open | Test. **Accepted risk:** anyone with the URL can change the list until the owner undoes it |
| 25 | **Vulnerable dependencies** | PostCSS pinned to a patched version; CI audits on every push | `npm audit`: 0 vulnerabilities |
| 18 | **Brief too long to read** | Hard 1,800-word budget enforced in code (takeaways included), trimming least valuable material first | Test; live brief was 1,774 words |
| 30 | **Development touching production data** | Local runs, scripts and tests default to an isolated `dev` schema; only production (or an explicit `DB_SCHEMA=public`) uses the live tables | Test: data written under dev is invisible under public in the same database |
| 31 | **A broken change reaching production** | The full test suite runs in every Vercel build (`vercel-build`): a failing test stops the deploy | Configured in `package.json` |
| 28 | **Documentation claims more than the code does** | A test fails if the Components Map claims embeddings, the old formula, the old budget, or omits the look back and takeaway | Test. On review the map had claimed embeddings and cross-week de-duplication that did not exist; both corrected (the second is now real) |
| 19 | **Empty app when first opened** | Committed sample brief, clearly labelled; falls back to it if the database is empty or down | Test |

## Known gaps (stated plainly)

1. **Recall and precision are unmeasured.** The labelling file exists (`eval/golden.json`, 100 papers) but only a human can label it.
2. **Rubric calibration.** Novelty and hype barely vary across real papers; the pass threshold is provisional.
3. **Recall is measured only against a community proxy** (Hugging Face upvotes), not human labels.
4. **Not yet run against real Neon, Vercel, GitHub Actions or a real email send.** The SQL and the full weekly pipeline are tested on a real Postgres engine in-process, but connectivity to the hosted services is unverified.
5. **Cost per week not measured over a full run.** Per-job token counts are now recorded and shown on `/status`, but the first full run predates that.
6. **Vercel Hobby cron runs "within the hour", not at an exact minute.** The ticker and the 02:00 UTC cutoff absorb this.
