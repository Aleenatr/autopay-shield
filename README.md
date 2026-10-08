# Autopay Shield

An **unsupervised machine-learning system** that scores subscription merchants
on how fairly they bill their customers.

Subscription merchants abuse customers in ways a single transaction never
reveals. The price creeps up over months. The name on the statement keeps
changing, so the charge becomes unrecognisable. Declined cards get retried
again and again. Cancellation requests go unanswered. None of that is visible
in one transaction, only across a merchant's whole history.

The pipeline turns each merchant's history into **six normalised behavioural
features**. It groups the whole population with **k-means** and finds merchants
unlike any other with **DBSCAN**. The result is an **explainable trust score
from 0 to 100** (higher is safer) in four bands: `HEALTHY`, `NEEDS_ATTENTION`,
`HIGH_RISK` and `CRITICAL`. Every point deducted is tied to a named reason.
A Node/Express API serves the results to a React dashboard.

---

## Results: labelled benchmark

There is no public dataset of "abusive merchants", so the evaluation uses
**500 synthetic merchants whose behaviour is known**: 350 honest, 100 aggressive
and 50 abusive. The honest ones include the innocent noise real data has:
- the same name written several ways;
- a declined charge at an odd amount;
- a charge delivered twice;
- a polite retry days after a failure.

Every merchant goes through the **real pipeline**, including the six-hourly
population pass. Full report: [`ml/results.md`](ml/results.md).

| Measure | Result |
|---|---|
| Abusive merchants caught (high risk or critical) | **96%** (48 of 50) |
| Aggressive merchants warned (not healthy) | 67% |
| Honest merchants wrongly warned | **0%** (0 of 350) |
| Warnings that were right | 100% |

**What each cleaning rule is worth** (the same data, one rule switched off at a time):

| Pipeline | Abusive caught | Honest wrongly warned |
|---|---|---|
| All rules on | 96% | 0% |
| Name normalisation off ("ACME Inc" and "acme" count as two names) | 96% | 2.6% |
| Duplicates detected by "same subscription, amount and day" instead of transaction ID | **74%** | 0% |
| Price range taken from all attempts, declined ones included | 96% | 1.4% |

**Independent check in Python.** scikit-learn's own `KMeans` and `DBSCAN`, run
on the same features with the same settings, agree with the hand-written
JavaScript versions: adjusted Rand index 1.000, and the same outlier decision
for 100% of merchants.

**Read these honestly.** The data is synthetic and its behaviour ranges were
chosen by hand. The numbers show the pipeline separates the behaviours it was
designed to catch, and that innocent noise doesn't set it off. They are not
real-world accuracy, which would need labelled outcomes such as chargebacks.

### What the benchmark found

- **A real bug in the retry feature.** A retry that also fails is itself a failed
  transaction. Dividing retries by *all* failures meant the ratio could never pass
  1, so the feature topped out near 0.53 instead of 1.0. It now counts retries
  against the original failed charges. Unit tests pin both cases.
- **DBSCAN alone would miss coordinated abuse.** It flags merchants that behave like
  *no one else*. The 50 abusive merchants behave like *each other*, so they form their own
  dense group: only 2% of them are DBSCAN outliers. k-means puts all 50 in the
  abusive group, and the rule-based score catches 96%. The three methods
  answer different questions, which is why the system uses all three.
- **Aggressive merchants are the hard middle.** A third of them stay "healthy".
  k-means splits them between the abusive and aggressive groups.

---

## How the ML works

### The six features (all 0 to 1, higher = worse)

| Feature | Reaches 1.0 when... |
|---|---|
| `price_volatility` | the highest successful charge is double the lowest |
| `price_change_frequency` | the price changes at least once a month |
| `stealth_price_changes` | every price change was made without notice |
| `rename_frequency` | 5+ distinct billing names (after normalisation) |
| `cancellation_friction` | no cancellation request ever completed |
| `retry_aggressiveness` | 3+ retries per failed charge, all within 24 hours (70% volume, 30% speed) |

Each feature is scaled by a **fixed rule**, not by min-max or z-scores. A
merchant's value never changes just because other merchants changed, and
1.0 always means the same thing.

### Clustering

- **k-means, k = 3**, written by hand. It starts from deterministic centres
  (merchants sorted by average signal, three evenly spaced picks), so the same
  data always gives the same groups. Groups are **named by thresholding their
  centre** (average ≥ 0.60 abusive, ≥ 0.35 aggressive), never by rank. Ranking
  would call some group "abusive" even in an all-honest population.
- **DBSCAN, eps = 0.3, minPts = 2**. A merchant with no other merchant within 0.3
  (in the 6-feature space) is an outlier. Its distance to the nearest merchant
  becomes an anomaly score worth up to 5 penalty points.
- **Why these settings** (`ml/results.md` §5):
  - **k:** the silhouette score is almost flat from k = 2 to 6 (0.66-0.68),
    so the data doesn't demand a particular k. Three matches the three archetypes
    the product needs to name.
  - **eps = 0.3** sits between the 95th and 99th percentile of nearest-neighbour
    distance, so it flags only the rarest ~2% of merchants.

### The trust score

`score = 100 - (ten named penalties)`. The penalty weights add up to **95**, so
the floor is 5 by construction. Every deducted point is listed in
`score_breakdown`, for example "-20 price volatility, -17 renaming". That is
why a rule-based score was chosen over a trained classifier: there are no labels
to train on, and every decision can be explained.

**Cold start:** a merchant with fewer than 6 charges or under 3 months of history
gets `confidence: LOW` (and `scoreConfidence: LOW` in the API). Without enough
evidence, "no evidence of abuse" must not read as "evidence of no abuse".

The LLM endpoint (Groq, Llama 3.3 70B) only rewrites a verdict that is already
computed into plain English. It never decides anything.

---

## Run it

**Full app, no MongoDB or Redis install needed:**

```bash
cd api && npm install
npm run demo                      # in-memory MongoDB, 15 sample merchants, API on :5050
cd ../website && npm install && npm run dev    # dashboard on http://localhost:5173
```

The demo prints a one-off admin key. Admin routes need it as an `x-api-key` header.

**Pipeline only (no database):** `cd api && npm run pipeline`

**Tests:** `cd api && npm test` (25 unit tests using Node's built-in test runner, no extra dependency)

**Benchmark + ML evaluation:**

```bash
cd api && npm run benchmark       # 500 labelled merchants through the real pipeline -> ml/data/benchmark.csv
cd ..
python3 -m venv ml/.venv && source ml/.venv/bin/activate
pip install -r ml/requirements.txt
python ml/evaluate.py             # metrics, scikit-learn cross-checks, charts -> ml/results.md
```

> Port **5050**, not 5000: on macOS the AirPlay Receiver binds 5000 and answers
> every request with `403`.

---

## Architecture

```
  Browser (React 19 + Vite + TS + Tailwind v4, :5173)
      │  GET /api/public/merchants
      ▼
  Node / Express 5 API (:5050)  ── the only thing that talks to the databases
      │                    │        /api/admin/* needs the x-api-key header
      │ cache-aside        │ Mongoose
      ▼                    ▼
  Redis (:6379)        MongoDB — 3 collections
  fails open           cleaned_data → merchant_analysis_snapshots
                                    → api_responses
      ▲
      └── node-cron, every 6h: recompute clustering across ALL merchants
          (one run at a time: in-process guard + Redis lock across servers)
```

### The three collections

| Collection | What | Written by |
|---|---|---|
| `cleaned_data` | Every transaction, dispute and lifecycle event, validated and normalised | ingest |
| `merchant_analysis_snapshots` | The full internal analysis: signals, score breakdown, clusters, patterns | ingest + cron |
| `api_responses` | The flat, precomputed public read model the dashboard fetches | ingest + cron |

Reads and writes want opposite shapes. The dashboard needs one small flat
document per merchant; an analyst needs the full derivation. So the pipeline
**precomputes the read model**, and the dashboard never drags a merchant's
whole transaction history over the network.

### The pipeline: `api/src/ingestion/`

```
cleaning/    validate → normalize → deduplicate → enrich
analysis/    extractSignals → dbscanAnalysis → kmeansAnalysis → merchantScoring
controller/  generateApiResponse
```

### Why there is a cron job

**Clustering is population-level.** k-means partitions *all* merchants; DBSCAN
judges a merchant against the density of its *neighbours*. Neither is defined
for one merchant alone. So a newly ingested merchant gets its features and a
provisional score at once, with its cluster and outlier status marked as
deferred, and the six-hourly job fills those in. Only one run can happen at a
time: an in-process flag stops overlapping runs on one server, and a Redis lock
(`SET NX` with an expiry, released only by its owner) stops two servers racing.

---

## Known limitations

Stated deliberately rather than discovered in review.

- **The benchmark is synthetic.** Real-world accuracy needs real labelled
  outcomes (confirmed chargebacks, regulator complaints).
- **Feature thresholds and penalty weights are judgement calls**, not learned
  parameters. With no labels there is nothing to learn them from. Every
  threshold is written as a sentence in the source.
- **Admin access is one shared API key.** It is fine for a single operator; a
  real deployment needs per-user accounts (JWT or OAuth) and audit logs.
- **The cron runs in-process.** Clustering is the only CPU-heavy step, so a very
  large run would block HTTP requests. A separate worker process is the fix.
- **DBSCAN compares every merchant with every other one (O(n²)).** That is fine for
  thousands of merchants. Beyond that it needs a spatial index (k-d tree).
- **No transactions across the three collections.** A crash between writes can
  leave the snapshot and the public response disagreeing. MongoDB supports
  multi-document transactions on a replica set; this doesn't use them yet.
- **`cleaned_data` embeds the full transaction history.** MongoDB's 16 MB
  document limit is a real ceiling. The fix is the bucket pattern (one document
  per merchant per month).
- **Timestamps are stored as strings**, so date-range queries need a schema change.

---

## Layout

```
api/
  src/ingestion/       the pipeline: cleaning, features, clustering, scoring, response
  src/services/        single-merchant ingest; the six-hourly population job (+ lock)
  src/routes/          public (read, cached) and admin (write, API key)
  src/middleware/      requireApiKey.js
  src/models/          Mongoose schemas for the three collections
  test/                unit tests (npm test)
  scripts/             demo.js, testPipeline.js, benchmark.js, generateSampleData.js
  data/                archetypes.json (hand-written), sample_merchants.json (generated)
ml/
  evaluate.py          Python + scikit-learn evaluation of the benchmark
  data/benchmark.csv   one row per benchmark merchant (written by api/scripts/benchmark.js)
  results.md           the full evaluation report
  figures/             PCA view, choosing k, k-distance curve
website/
  src/pages/           Home, Dashboard
```
