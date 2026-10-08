/**
 * LABELLED BENCHMARK - does the pipeline catch abusive merchants, and how
 * often does it wrongly flag honest ones?
 *
 *   npm run benchmark        (then: python ml/evaluate.py for the full report)
 *
 * Real labels don't exist for this problem - nobody publishes "these merchants
 * are abusive". So the benchmark builds synthetic merchants whose behaviour is
 * set on purpose, which means the right answer is known for every one:
 *
 *   NORMAL      honest, but with the messy-yet-innocent things real data has:
 *               the same name written several ways, a declined charge at an
 *               odd amount, a webhook that delivers the same charge twice, one
 *               polite retry days after a failure, a price rise with notice.
 *   AGGRESSIVE  several bad habits, none extreme.
 *   ABUSIVE     price creep, unannounced increases, name changes, failed cards
 *               hammered within hours, cancellations that never go through.
 *
 * 500 merchants: 70% normal, 20% aggressive, 10% abusive (abuse is rare).
 * Behaviour is drawn from overlapping ranges, so the groups are not trivially
 * separable. The random numbers are seeded: every run builds the same benchmark.
 *
 * Every merchant goes through the REAL pipeline (the same nine modules as
 * production, in memory), including the population pass the cron runs.
 * Then the same data is run again with one cleaning rule switched off at a
 * time, to measure what each rule is actually worth.
 *
 * What this can tell you: whether the pipeline separates the behaviours it was
 * designed to catch, and whether innocent noise triggers false alarms.
 * What it can't: real-world accuracy. The behaviour ranges are judgement.
 *
 * Output: ml/data/benchmark.csv, one row per merchant.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import validate from '../src/ingestion/cleaning/validate.js';
import normalize from '../src/ingestion/cleaning/normalize.js';
import deduplicate from '../src/ingestion/cleaning/deduplicate.js';
import enrich from '../src/ingestion/cleaning/enrich.js';
import extractSignals from '../src/ingestion/analysis/extractSignals.js';
import { performDBSCANClustering } from '../src/ingestion/analysis/dbscanAnalysis.js';
import { performKMeansClustering } from '../src/ingestion/analysis/kmeansAnalysis.js';
import generateMerchantScore from '../src/ingestion/analysis/merchantScoring.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, '..', '..', 'ml', 'data');

// ---- seeded randomness (mulberry32: a small, standard 32-bit generator) ----
let state = 20261009;
function random() {
   state |= 0;
   state = (state + 0x6d2b79f5) | 0;
   let t = Math.imul(state ^ (state >>> 15), 1 | state);
   t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
   return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const uniform = (low, high) => low + random() * (high - low);
const randInt = (low, high) => Math.floor(uniform(low, high + 1));
const chance = (p) => random() < p;
const pick = (items) => items[Math.floor(random() * items.length)];
function shuffle(items) {  // Fisher-Yates, driven by the seeded generator
   for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
   }
   return items;
}

// ---- the three behaviour profiles ---------------------------------------
// Ranges overlap on purpose: some honest merchants raise prices without
// notice, some aggressive ones look mild.
const PROFILES = {
   NORMAL: {
      count: 350,
      priceChanges: () => (chance(0.4) ? 1 : 0),
      priceIncrease: () => uniform(0.05, 0.2),
      notified: () => chance(0.9),
      distinctNames: () => 1,
      failRate: 0.08,
      retriesAfterFailure: () => (chance(0.7) ? 1 : 0),
      retryGapHours: () => uniform(48, 120),
      cancelRequests: () => randInt(0, 2),
      cancelCompletes: () => chance(0.95),
      chargebackRate: 0.001,
      disputeRate: 0.004
   },
   AGGRESSIVE: {
      count: 100,
      priceChanges: () => randInt(1, 2),
      priceIncrease: () => uniform(0.1, 0.3),
      notified: () => chance(0.4),
      distinctNames: () => randInt(2, 3),
      failRate: 0.12,
      retriesAfterFailure: () => randInt(1, 3),
      retryGapHours: () => uniform(6, 36),
      cancelRequests: () => randInt(1, 3),
      cancelCompletes: () => chance(0.5),
      chargebackRate: 0.005,
      disputeRate: 0.02
   },
   ABUSIVE: {
      count: 50,
      priceChanges: () => randInt(2, 4),
      priceIncrease: () => uniform(0.25, 0.6),
      notified: () => chance(0.1),
      distinctNames: () => randInt(4, 6),
      failRate: 0.15,
      retriesAfterFailure: () => randInt(3, 5),
      retryGapHours: () => uniform(1, 8),
      cancelRequests: () => randInt(2, 4),
      cancelCompletes: () => chance(0.15),
      chargebackRate: 0.02,
      disputeRate: 0.05
   }
};

const PREFIXES = ['Pixel', 'Meal', 'Fit', 'Lingo', 'Pod', 'Doc', 'Game', 'Note', 'Ride', 'Pet', 'Sky', 'Tune',
   'Cloud', 'Snap', 'Byte', 'Leaf', 'Nova', 'Echo', 'Zen', 'Quill', 'Orbit', 'Peak', 'Bloom', 'Flux',
   'Spark', 'Wave', 'Atlas', 'Ember', 'Glide', 'Harbor', 'Iris', 'Jolt', 'Kite', 'Lumen', 'Mint', 'Nimbus',
   'Opal', 'Prism', 'Quest', 'Rally'];
const SUFFIXES = ['Vault', 'Box', 'Track', 'Lab', 'Stream', 'Safe', 'Chest', 'Nest', 'Pass', 'Care',
   'Drive', 'Room', 'Hub', 'Ly', 'Wise', 'Path', 'Deck', 'Mate', 'Works', 'Club'];
const MONTH_MS = 30 * 24 * 3600 * 1000;
const ANCHOR = Date.UTC(2026, 7, 1);  // 1 Aug 2026, fixed so the benchmark never drifts
const iso = (ms) => new Date(ms).toISOString();

/** Ways an honest merchant's ONE name shows up on statements - all normalise to the same thing. */
function formattingVariants(brand) {
   const upper = brand.toUpperCase();
   return [upper, `${brand} Inc`, `${upper}.`, `${brand.toLowerCase()} ltd`, `${upper}*`];
}

/** Genuinely different billing names (they normalise to different strings). */
function differentNames(brand, n) {
   const upper = brand.toUpperCase();
   const short = upper.slice(0, 4);
   const all = [upper, `${short}*BILLING`, `${short} DIGITAL SERVICES`, `SUBS*${short}`,
      `${upper} PLUS MEMBERSHIP`, `ONLINE*PAY ${short}`];
   return all.slice(0, n);
}

function buildMerchant(index, label) {
   const p = PROFILES[label];
   const brand = PREFIXES[index % PREFIXES.length] + SUFFIXES[Math.floor(index / PREFIXES.length) % SUFFIXES.length];
   const id = `BM_${String(index).padStart(4, '0')}`;
   const months = randInt(6, 14);
   const start = ANCHOR - months * MONTH_MS;
   const users = randInt(2, 6);

   // Price over time: a base price, then rises at random months.
   const basePrice = Number(uniform(3, 20).toFixed(2));
   const changeMonths = [...new Set(Array.from({ length: p.priceChanges() }, () => randInt(2, months - 1)))].sort((a, b) => a - b);
   const priceAt = [];
   let price = basePrice;
   const lifecycle_events = [];
   for (let m = 0; m < months; m++) {
      if (changeMonths.includes(m)) {
         const newPrice = Number((price * (1 + p.priceIncrease())).toFixed(2));
         lifecycle_events.push({
            subscription_id: `${id}_S0`, event_type: 'price_change', timestamp: iso(start + m * MONTH_MS),
            old_amount: price, new_amount: newPrice, notification_sent: p.notified()
         });
         price = newPrice;
      }
      priceAt.push(price);
   }

   // Billing names: honest merchants keep one (sometimes written several ways);
   // the others switch names as time goes on.
   const names = label === 'NORMAL' ? null : differentNames(brand, p.distinctNames());
   const messyFormatting = label === 'NORMAL' && chance(0.5);
   const descriptorAt = (m) => {
      if (names) return names[Math.min(names.length - 1, Math.floor((m / months) * names.length))];
      return messyFormatting ? pick(formattingVariants(brand)) : brand.toUpperCase();
   };

   // Cancellations: requested by some users; completed or left hanging.
   const cancelledAt = new Map();  // user -> month their billing stops
   const askers = shuffle([...Array(users).keys()]).slice(0, Math.min(users, p.cancelRequests()));
   for (const u of askers) {
      const m = randInt(3, Math.max(3, months - 2));
      const at = start + m * MONTH_MS + 5 * 24 * 3600 * 1000;
      lifecycle_events.push({ subscription_id: `${id}_S${u}`, event_type: 'cancellation_requested', timestamp: iso(at) });
      if (p.cancelCompletes()) {
         lifecycle_events.push({ subscription_id: `${id}_S${u}`, event_type: 'cancellation_completed', timestamp: iso(at + 24 * 3600 * 1000) });
         cancelledAt.set(u, m + 1);
      }
   }

   const subscriptions = [];
   const transactions = [];
   let txnNo = 0;
   const txn = (fields) => ({ transaction_id: `${id}_T${txnNo++}`, payment_method_type: 'card', ...fields });

   for (let u = 0; u < users; u++) {
      const sub = `${id}_S${u}`;
      const user = `${id.toLowerCase()}_u${u}`;
      const day = randInt(0, 25) * 24 * 3600 * 1000;
      subscriptions.push({ subscription_id: sub, user_hash: user, billing_interval: 'monthly', start_date: iso(start).slice(0, 10) });
      const stopAt = cancelledAt.has(u) ? cancelledAt.get(u) : months;

      for (let m = randInt(0, 2); m < stopAt; m++) {
         const at = start + m * MONTH_MS + day;
         const base = { subscription_id: sub, user_hash: user, amount_usd: priceAt[m], descriptor: descriptorAt(m) };

         if (chance(p.failRate)) {
            transactions.push(txn({ ...base, status: 'failed', attempt: 1, timestamp: iso(at), failure_reason: 'insufficient_funds' }));
            const retries = p.retriesAfterFailure();
            const gap = p.retryGapHours();
            const recovers = chance(0.8);
            for (let r = 1; r <= retries; r++) {
               const last = r === retries;
               transactions.push(txn({ ...base, status: last && recovers ? 'success' : 'failed', attempt: r + 1, timestamp: iso(at + r * gap * 3600 * 1000) }));
            }
            continue;
         }

         const charge = txn({ ...base, status: 'success', attempt: 1, timestamp: iso(at) });
         if (chance(p.chargebackRate)) charge.chargeback_filed_at = iso(at + 20 * 24 * 3600 * 1000);
         if (chance(p.disputeRate)) charge.dispute_filed_at = iso(at + 10 * 24 * 3600 * 1000);
         transactions.push(charge);

         // Innocent noise that honest merchants' data really has:
         if (label === 'NORMAL' && chance(0.03)) transactions.push({ ...charge });  // same charge delivered twice
         if (label === 'NORMAL' && chance(0.02)) {                                  // a declined charge at an odd amount
            transactions.push(txn({ ...base, amount_usd: Number((priceAt[m] * 2.5).toFixed(2)), status: 'failed', attempt: 1, timestamp: iso(at + 3600 * 1000) }));
         }
      }
   }

   return {
      label,
      raw: {
         merchant: { merchant_id: id, merchant_name: brand, country: pick(['IN', 'US', 'GB']), category_code: 'SUBSCRIPTION' },
         subscriptions, transactions, lifecycle_events, dispute_events: []
      }
   };
}

// ---- the pipeline, with one rule at a time switched off --------------------
const VARIANTS = {
   all_rules: 'All rules on (production)',
   no_name_normalisation: 'Name normalisation off: "ACME Inc" and "acme" count as two names',
   same_day_dedupe: 'De-duplicate on "same subscription, amount and day" instead of transaction ID',
   prices_from_all_attempts: 'Price range taken from all attempts, declined ones included'
};

function sameDayDedupe(data) {
   // The tempting rule - "same customer, same amount, same day must be a
   // duplicate" - which also deletes every same-day retry.
   const seen = new Set();
   data.transactions = data.transactions.filter(t => {
      const key = `${t.subscription_id}|${t.amount_usd}|${String(t.timestamp).slice(0, 10)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
   });
   return deduplicate(data);
}

function clean(raw, variant) {
   let data = normalize(validate(raw));
   if (variant === 'no_name_normalisation') {
      data.merchant.normalized_descriptors = [...new Set(data.transactions.map(t => t.descriptor).filter(Boolean))];
   }
   data = enrich(variant === 'same_day_dedupe' ? sameDayDedupe(data) : deduplicate(data));
   if (variant === 'prices_from_all_attempts') {
      const amounts = data.transactions.map(t => t.amount_usd).filter(a => a > 0);
      data.aggregated_metrics.min_price_usd = Math.min(...amounts);
      data.aggregated_metrics.max_price_usd = Math.max(...amounts);
   }
   return data;
}

const squaredDistance = (a, b) => a.reduce((sum, x, i) => sum + (x - b[i]) ** 2, 0);

function runPipeline(raws, variant) {
   const cleaned = raws.map(raw => clean(raw, variant));
   const signals = cleaned.map(data => extractSignals(data));
   // The population pass, exactly as the six-hourly cron runs it.
   const kmeans = performKMeansClustering(signals, 3);
   const dbscan = performDBSCANClustering(signals, 0.3, 2);
   return cleaned.map((data, i) => {
      const scored = generateMerchantScore(data, signals[i], dbscan.perMerchant[i], kmeans.merchantAssignments[i]);
      const vector = Object.values(signals[i].core);
      const centroids = kmeans.clusters.map(c => Object.values(c.centroid));
      const clusterIndex = centroids.reduce((best, c, k) => (squaredDistance(vector, c) < squaredDistance(vector, centroids[best]) ? k : best), 0);
      return {
         signals: signals[i].core,
         score: scored.trust_score.score,
         band: scored.trust_score.risk_level,
         cluster: scored.cluster_assignment.cluster,
         cluster_index: clusterIndex,
         outlier: scored.anomaly_analysis.is_outlier,
         anomaly_score: scored.anomaly_analysis.anomaly_score,
         confidence: scored.trust_score.confidence,
         patterns: scored.patterns.length
      };
   });
}

// ---- build, run, write ---------------------------------------------------
const merchants = [];
let index = 0;
for (const [label, profile] of Object.entries(PROFILES)) {
   for (let i = 0; i < profile.count; i++) merchants.push(buildMerchant(index++, label));
}
shuffle(merchants);  // mixed order, so nothing depends on position

const raws = merchants.map(m => m.raw);
const results = Object.fromEntries(Object.keys(VARIANTS).map(v => [v, runPipeline(raws, v)]));

const SIGNALS = Object.keys(results.all_rules[0].signals);
const header = ['merchant_id', 'label', ...SIGNALS, 'score', 'band', 'cluster', 'cluster_index', 'outlier',
   'anomaly_score', 'confidence', 'patterns',
   ...Object.keys(VARIANTS).filter(v => v !== 'all_rules').flatMap(v => [`score_${v}`, `band_${v}`])];
const rows = merchants.map((m, i) => {
   const r = results.all_rules[i];
   return [m.raw.merchant.merchant_id, m.label, ...SIGNALS.map(s => r.signals[s].toFixed(6)), r.score, r.band,
      r.cluster, r.cluster_index, r.outlier, r.anomaly_score.toFixed(6), r.confidence, r.patterns,
      ...Object.keys(VARIANTS).filter(v => v !== 'all_rules').flatMap(v => [results[v][i].score, results[v][i].band])];
});
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'benchmark.csv'), [header, ...rows].map(r => r.join(',')).join('\n') + '\n');

// ---- a quick summary (ml/evaluate.py produces the full report) -------------
const bad = (band) => band === 'HIGH_RISK' || band === 'CRITICAL';
const share = (items, test) => `${((100 * items.filter(test).length) / items.length).toFixed(1)}%`;
console.log(`\nBenchmark: ${merchants.length} merchants (${Object.entries(PROFILES).map(([k, p]) => `${p.count} ${k}`).join(', ')})`);
console.log(`Transactions generated: ${raws.reduce((n, r) => n + r.transactions.length, 0)}\n`);
for (const [variant, description] of Object.entries(VARIANTS)) {
   const res = results[variant];
   const of = (label) => res.filter((_, i) => merchants[i].label === label);
   console.log(description);
   console.log(`   abusive flagged (high risk or critical) : ${share(of('ABUSIVE'), r => bad(r.band))}`);
   console.log(`   aggressive warned (not healthy)         : ${share(of('AGGRESSIVE'), r => r.band !== 'HEALTHY')}`);
   console.log(`   honest wrongly warned (not healthy)     : ${share(of('NORMAL'), r => r.band !== 'HEALTHY')}\n`);
}
console.log(`Wrote ml/data/benchmark.csv - now run: python ml/evaluate.py\n`);
