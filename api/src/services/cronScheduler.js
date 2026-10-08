import cron from 'node-cron';
import { CleanedData, MerchantAnalysis, ApiResponse } from '../models/MerchantAnalysis.js';
import extractSignals from '../ingestion/analysis/extractSignals.js';
import { performKMeansClustering } from '../ingestion/analysis/kmeansAnalysis.js';
import { performDBSCANClustering } from '../ingestion/analysis/dbscanAnalysis.js';
import generateMerchantScore from '../ingestion/analysis/merchantScoring.js';
import generateApiResponse from '../ingestion/controller/generateApiResponse.js';
import redisClient from '../config/redis.js';
import { randomUUID } from 'crypto';

/**
 * ============================ WHY THIS JOB EXISTS ============================
 * Not for freshness. The stored data does not go stale on its own.
 *
 * It exists because CLUSTERING AND OUTLIER DETECTION ARE POPULATION-LEVEL
 * OPERATIONS AND SCORING IS RELATIVE. k-means partitions ALL merchants into k
 * groups. DBSCAN calls a merchant an outlier relative to the density of its
 * NEIGHBOURS. Neither is defined for one merchant in isolation — which is
 * exactly why runKMeans() and runDBSCAN() return deferred placeholders on the
 * single-merchant ingest path.
 *
 * The moment a new merchant is ingested, every existing merchant's cluster
 * membership and outlier status is potentially stale. This job is where those
 * two things become real numbers.
 * ============================================================================
 *
 * REWRITTEN 14 Aug 2026. What was wrong before:
 *
 * The old snapshot object wrote merchant.id, cleanedData, signals.coreSignals,
 * kmeansAnalysis, dbscanAnalysis and trustScore. NOT ONE of those is a path in
 * merchantAnalysisSchema (models:125-231), and Mongoose schemas are strict by
 * default — unknown fields are SILENTLY STRIPPED on write.
 *
 * So this job ran every six hours, logged a tick per merchant, and wrote
 * essentially empty documents. It failed silently and reported success. It also
 * called generateMerchantScore with its 2nd and 4th arguments swapped relative
 * to merchantProcessor.js:35, and generateApiResponse with a completely
 * different argument shape.
 *
 * Both callers now use the same contract — the one the schema agrees with.
 */

export async function reprocessAllMerchants() {
   const startTime = Date.now();

   try {
      console.log('\n[1] Loading merchants...');
      // Field names must match cleanedDataSchema exactly. The previous version
      // selected camelCase names (subscriptionCount, aggregatedMetrics) that do
      // not exist on this schema, so it silently fetched documents with the
      // aggregated metrics missing — and every downstream signal read undefined.
      const allMerchants = await CleanedData.find({})
         .select('merchant subscriptions transactions lifecycle_events dispute_events aggregated_metrics processed_at')
         .lean();

      if (allMerchants.length === 0) {
         return { success: true, message: 'No merchants to process', processed: 0 };
      }

      console.log(`   Found ${allMerchants.length} merchants`);

      console.log('\n[2] Extracting signals...');
      const allSignals = allMerchants.map(merchant => ({
         merchantId: merchant.merchant.merchant_id,
         merchantName: merchant.merchant.merchant_name,
         cleanData: merchant,
         signals: extractSignals(merchant)
      }));

      console.log('\n[3] Running K-Means clustering...');
      // k = min(3, n). Three because the product reasons in three archetypes
      // (ABUSIVE / AGGRESSIVE / NORMAL), and you can never have more clusters
      // than points.
      const kmeansResult = performKMeansClustering(
         allSignals.map(m => m.signals),
         Math.min(3, allSignals.length)
      );
      console.log(`   ${kmeansResult.note}`);

      console.log('\n[4] Running DBSCAN outlier detection...');
      // eps = 0.3, minPts = 2. eps is a radius in the 6-D unit cube whose full
      // diagonal is ~2.449, so 0.3 is a genuinely tight neighbourhood. minPts=2
      // is the smallest value that means anything: "at least one other merchant
      // behaves like you".
      const dbscanResult = performDBSCANClustering(
         allSignals.map(m => m.signals),
         0.3,
         2
      );
      console.log(`   Identified ${dbscanResult.outliers.length} outliers`);

      console.log('\n[5] Updating merchant analyses...');
      let updated = 0;
      let failed = 0;

      for (let i = 0; i < allSignals.length; i++) {
         const merchantData = allSignals[i];

         try {
            // Per-merchant slices of the two population results. Both arrays are
            // parallel to allSignals, so the index is the join key.
            const merchantDbscan = dbscanResult.perMerchant[i];
            const merchantKmeans = kmeansResult.merchantAssignments[i];

            // SAME ARGUMENT ORDER AS merchantProcessor.js:35. This is the fix.
            const scoringResult = generateMerchantScore(
               merchantData.cleanData,
               merchantData.signals,
               merchantDbscan,
               merchantKmeans
            );

            const times = merchantData.cleanData.transactions
               .map(t => new Date(t.timestamp).getTime())
               .filter(t => Number.isFinite(t));
            const toDay = (ms) => new Date(ms).toISOString().split('T')[0];

            // Schema-shaped. Identical structure to merchantProcessor.js:50-77,
            // because both write the same collection.
            const snapshot = {
               merchantId: merchantData.merchantId,
               merchantName: merchantData.merchantName,
               analysis_window: {
                  from: times.length ? toDay(Math.min(...times)) : toDay(Date.now()),
                  to: times.length ? toDay(Math.max(...times)) : toDay(Date.now()),
                  months: times.length
                     ? Math.round((Math.max(...times) - Math.min(...times)) / (1000 * 60 * 60 * 24 * 30))
                     : 0
               },
               signals: { core: merchantData.signals.core },
               derived_indicators: scoringResult.derived_indicators,
               anomaly_analysis: scoringResult.anomaly_analysis,
               cluster_assignment: scoringResult.cluster_assignment,
               trust_score: scoringResult.trust_score,
               score_breakdown: scoringResult.score_breakdown,
               recommended_action: scoringResult.recommended_action,
               patterns: scoringResult.patterns,
               metadata: {
                  total_users: merchantData.cleanData.aggregated_metrics?.total_users || 0,
                  total_subscriptions: merchantData.cleanData.aggregated_metrics?.total_subscriptions || 0,
                  analysis_timestamp: new Date().toISOString(),
                  pipeline_version: '2.0.0'
               }
            };

            const apiResponse = generateApiResponse({
               cleanData: merchantData.cleanData,
               signals: merchantData.signals,
               scoring: scoringResult
            });

            // Keyed on merchantId — the unique indexed field (models:126).
            // The previous version queried {'merchant.id': ...}, which is not a
            // schema path, so with strictQuery:false it matched nothing and
            // upserted a fresh near-empty document on every single run.
            await MerchantAnalysis.findOneAndUpdate(
               { merchantId: merchantData.merchantId },
               snapshot,
               { upsert: true, new: true, runValidators: true }
            );

            await ApiResponse.findOneAndUpdate(
               { merchantId: merchantData.merchantId },
               apiResponse,
               { upsert: true, new: true, runValidators: true }
            );

            updated++;
            console.log(`   ✓ ${merchantData.merchantName} — ${scoringResult.trust_score.score}/100 (${scoringResult.trust_score.risk_level})`);

         } catch (error) {
            // The try/catch is INSIDE the loop on purpose: one bad merchant
            // increments `failed` and the run continues, rather than aborting
            // the whole population refresh.
            failed++;
            console.error(`   ✗ ${merchantData.merchantName}: ${error.message}`);
         }
      }

      const totalTime = Date.now() - startTime;
      console.log(`\n   Reprocessed ${updated}/${allMerchants.length} in ${totalTime}ms`);

      return { success: true, processed: updated, failed, total: allMerchants.length, duration: totalTime };

   } catch (error) {
      console.error('Cron job error:', error);
      throw error;
   }
}

// ============================ ONE RUN AT A TIME ==============================
// Two runs at once would race each other's writes. That can happen two ways:
//  1. Inside one server: a run takes longer than the gap until the next tick.
//     The `running` flag below stops that.
//  2. Across servers: two API replicas both fire at 06:00. A Redis lock stops
//     that - SET with NX ("only if nobody holds it") and an expiry, so a server
//     that crashes mid-run can't hold the lock forever. Only the holder of the
//     random token can release it, so one server can't free another's lock.
// If Redis is down, the lock is skipped (single-server behaviour), in line
// with the cache, which also fails open.
const LOCK_KEY = 'lock:reprocess-all-merchants';
const LOCK_TTL_MS = 30 * 60 * 1000;   // longer than any run should take
const RELEASE_IF_OWNER = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

let running = false;

export async function acquireLock(client = redisClient) {
   if (!client?.isReady) return { acquired: true, token: null };   // no Redis: single-server mode
   const token = randomUUID();
   const ok = await client.set(LOCK_KEY, token, { NX: true, PX: LOCK_TTL_MS });
   return { acquired: ok === 'OK', token };
}

export async function releaseLock(token, client = redisClient) {
   if (!token || !client?.isReady) return;
   await client.eval(RELEASE_IF_OWNER, { keys: [LOCK_KEY], arguments: [token] });
}

/**
 * Run the population pass unless one is already running here or elsewhere.
 * Returns the job's result, or { skipped: reason } when it did not run.
 */
export async function runGuarded(job = reprocessAllMerchants, client = redisClient) {
   if (running) return { skipped: 'a run is already in progress on this server' };
   running = true;
   let lock = { acquired: false, token: null };
   try {
      lock = await acquireLock(client);
      if (!lock.acquired) return { skipped: 'another server holds the lock' };
      return await job();
   } finally {
      running = false;
      if (lock.acquired) await releaseLock(lock.token, client);
   }
}

/**
 * Schedule the job. The default cron expression is minute 0 of every 6th hour,
 * so 00:00 / 06:00 / 12:00 / 18:00 server-local. Overridable via CRON_SCHEDULE
 * (server.js:75). The five fields are: minute hour day-of-month month day-of-week.
 *
 * KNOWN LIMITATION, worth stating before anyone asks:
 *  - Runs IN-PROCESS on the same event loop as the API. The clustering is the
 *    only CPU-bound work in the system, so during a large run it blocks HTTP.
 *    A separate worker process is the correct fix. (Overlapping runs and
 *    multi-server races are handled by runGuarded above.)
 */
export function startCronJob(schedule = '0 */6 * * *') {
   const job = cron.schedule(schedule, async () => {
      try {
         const result = await runGuarded();
         if (result?.skipped) console.log(`Cron run skipped: ${result.skipped}`);
      } catch (error) {
         console.error('Cron job execution failed:', error);
      }
   });

   console.log(`Cron job scheduled: ${schedule}\n`);
   return job;
}

export async function runImmediateReprocessing() {
   console.log('\nRunning immediate reprocessing...');
   return await runGuarded();
}

export default { startCronJob, reprocessAllMerchants, runImmediateReprocessing, runGuarded };
