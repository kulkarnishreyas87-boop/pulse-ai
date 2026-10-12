# Evaluation

All numbers below were measured on real data for week **2026-W40** (28 Sep to 4 Oct 2026) unless stated.

## One real end-to-end run

The full weekly job graph ran through the real `/api/step` endpoint, driven the way the GitHub Actions
ticker drives it, against live arXiv, Hugging Face Daily Papers and Gemini.

| Measure | Result |
|---|---|
| Wall clock | 552 s (about 9 min) |
| Scheduler steps | 15, each between 1 s and 54 s (all under the 60 s function limit) |
| Jobs | 58 of 58 done, **0 failed** |
| Papers scanned | 2,735 (across four domains, before de-duplication between them) |
| Papers scored by Gemini | 100 (25 per domain) |
| Brief length | 1,774 words, about 9 minutes to read, all four domains `ok` |

This run predates the review fixes below (the 10-day fetch and the weekly takeaway add 12 small fetch jobs
and 4 takeaway calls). Largest single domain was **AI agents: 907 arXiv matches in one week**, which exposed a
silent-truncation bug (fixed: overflowing queries are split per day).

## Coverage: the publishing-delay gap found on review

arXiv makes papers public in nightly batches. Measured live on **Sunday 11 Oct 2026, 16:05 UTC**, the cs.AI papers
visible in the API for that week, by submission day:

| Wed | Thu | Fri | Sat | Sun |
|---|---|---|---|---|
| 232 | 237 | **0** | **0** | **0** |

Friday-to-Sunday submissions are only published on Monday evening (US Eastern), after a Monday-morning run. The
original fixed Monday-to-Sunday window would never have shown them. Fix: each run also fetches the 3 days before
its week and skips papers an earlier run covered. A two-week simulation with realistic publication delays
(`tests/fixes.test.ts`) shows the weekend papers appear in the next brief and no paper appears twice.

## Significance rubric: r1 (generic "novelty") vs r2 (the three named signals)

The problem statement defines significance as "a new benchmark, a surprising evaluation result, a paper that shifts
how a problem is framed". r1 asked one vague question ("how novel?"); r2 asks those three. Same 100 real papers:

| | r1 | r2 |
|---|---|---|
| Main significance score: share of papers on the single most common value | **76%** (novelty 3) | **49%** (strongest of the three signals) |
| Distribution | novelty 2:12, 3:76, 4:12 | signal 1:6, 2:49, 3:13, 4:32 |
| New benchmark introduced | not asked | 22 of 100 |
| Surprising result (1 to 5) | not asked | 1:30, 2:48, 3:13, 4:9 |
| Reframing (1 to 5) | not asked | 1:6, 2:62, 3:26, 4:6 |
| Papers passing (agents / RAG / code / CV, of 25 each) | 13 / 7 / 8 / 3 | 9 / 7 / 9 / 4 |

**Reading:** r2 separates papers far better and every tag now says *why* a paper is there, with a rationale citing
the abstract (for example "introduces_benchmark: presents EngiWorld (1,301 tasks across 26 software platforms)").
An industrial anomaly-detection benchmark that r1 dropped is now kept. Remaining weaknesses: hype still rarely
varies (80% scored 1), and "new benchmark" is common (22%), so benchmark papers are favoured. The pass threshold
(3.3) is still provisional until human labels calibrate it.

Cost of re-scoring 100 papers and writing 4 takeaways: 20 Gemini calls, about 63,000 tokens, 0 retries, 0 malformed answers.

## "This week" takeaways (live)

All four domains produced a takeaway that passed every check (at least 2 papers cited, at least 1 verified card, no
numbers absent from the papers, no overclaiming wording). Example, RAG:

> This week's papers suggest that RAG systems suffer notable degradation under realistic deployment stresses, from
> semantic corruptions in knowledge bases to multi-turn conversational interactions.

## Faithfulness (are the summaries true?)

| Check | Result |
|---|---|
| Numbers in generated text that do not appear in the abstract | **0 of 15 cards** (deterministic check) |
| Fact-check pass rejecting a claim, on a re-run | 2 summaries rejected across 15 cards (about 13%), replaced by the abstract's own sentences |
| Evidence quotes not found verbatim in the abstract | 0 |

Adversarial checks against the real model (`npm run live-check`), **all passed again with rubric r2**:

1. Fact-checker rejects a summary containing an invented number and a fake comparison.
2. Fact-checker accepts a true claim.
3. A sweeping-claim abstract gets hype risk 5.
4. A no-evidence abstract gets evidence quality 1.
5. The solid paper out-ranks the hype paper.
6. An abstract that tries to instruct the scorer ("rate this 5/5/5") gets the lowest scores instead.
7. The writer's evidence quote is verbatim.

## Storage on the real Neon database (`npm run neon-check`)

All 8 checks pass against the hosted Neon database: JSON round-trip, array parameters, expiry, lease takeover, and
**12 concurrent claims over HTTP with exactly one winner**. The real W40 brief and the starter domains are loaded,
and the web app reads them from Neon (verified with the local fallback file moved aside).

## Full live week with every fix, on Neon

Driven through the real `/api/step` endpoint with the cron secret (as the GitHub ticker does), every job and the
brief stored in the hosted Neon database, email in dry-run mode.

| Measure | Result |
|---|---|
| Jobs | **75 of 75 done, 0 failed, 0 problems** |
| Active run time | 356 s across 10 steps (11 min wall clock including a deliberate restart, below) |
| Coverage | submissions from 25 Sep (the 3-day look back) to 4 Oct; 3,541 papers scanned (2,735 without the look back) |
| Brief | 1,789 words (~9 min), all four domains `ok`, every domain has a takeaway |
| AI cost for the week | 28 Gemini calls, 86,408 tokens, 0 retries, 0 malformed answers, ~15 s per call |
| Email | rendered and recorded in dry-run (nothing sent); the one-email guard is set |
| Next week's de-duplication | papers considered are recorded per domain (1,547 / 901 / 572 / 521) |

**Unplanned recovery test.** Midway through, adding `CRON_SECRET` made the server start rejecting the
unauthenticated test driver (correct behaviour). The run was resumed by an authenticated driver and finished from
the state stored in Neon with nothing lost or repeated.

**Observation.** 6 of the 8 non-top cards carry the "New benchmark" tag. Introducing a benchmark counts as a strong
signal, and 22% of papers do, so benchmark papers are over-represented. Lowering `RANK.benchmarkSignal` from 4 is
the obvious lever; it should be decided with labelled data, not by eye.

## First automatic Monday run in production (12 Oct 2026)

No human involvement: Vercel Cron started the run, the follow-up cron steps drove it, the brief was published to
Neon and the email went out.

| Measure | Result |
|---|---|
| Run created by the cron | 00:24 UTC (Vercel Hobby fires "within the hour") |
| Jobs | **73 of 73 done, 0 failed, 0 problems** |
| Brief | week 41 (5 to 11 Oct), 1,691 words, published to the live site |
| AI | 25 Gemini calls, 72,441 tokens, 0 retries, 0 malformed |
| Wall clock | 30 min across the scheduled steps |
| Email | sent at 00:54 UTC (6:24 am IST), Resend status **delivered** |

## Not yet measured

- **Recall and precision against human judgement.** `eval/golden.json` lists 100 real papers; set each label to
  `must` or `should_not`, then `npm run eval`. About 30 labels is enough to be informative.
- **The look back skipping last week's papers on a real second week.** Shown in simulation (`tests/fixes.test.ts`);
  the first real proof is the next Monday run.
- Nothing further on delivery: the deployed Monday cron and real email are both verified (above).

## Test suite

132 automated tests, no API keys or network needed: ranking, budget, composition, queue, retries, coverage across
consecutive weeks, takeaways, email, security, and the storage layer on a real in-process Postgres.
