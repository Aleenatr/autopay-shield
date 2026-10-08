/**
 * STEP 5 — EXTRACT SIGNALS
 *
 * Job: turn one merchant's history into six numbers in [0,1].
 *
 * Returns { core: {...} } — merchantProcessor.js:59 reads signalData.core, and
 * the schema declares signals.core (models:134-143). The six names and the
 * 0..1 bounds are fixed by that schema; do not rename or rescale them.
 *
 * ================== THE ONE RULE THAT CANNOT BE BROKEN ==================
 * HIGHER = WORSE, for all six signals.
 *
 * The inversion to "higher = safer" happens exactly ONCE, in merchantScoring.js
 * where score = 100 - penalties. Invert anywhere else as well and the product
 * recommends cancelling the honest merchants.
 * =======================================================================
 *
 * EVERY THRESHOLD BELOW IS STATED AS A SENTENCE FIRST.
 * "This signal reaches 1.0 when ___." If you cannot finish that sentence, the
 * number is not defensible and does not belong here. These are judgement calls
 * on a hand-labelled sample, not learned parameters — that is a real limitation
 * and the honest thing to say when asked where they came from.
 */

/** Force a value into [0,1]. Called on every return path. */
function clamp01(value) {
   if (!Number.isFinite(value)) return 0;
   return Math.max(0, Math.min(1, value));
}

// --- Saturation points: the value at which a signal reaches 1.0 -------------

// 1.0 when the dearest charge is at least DOUBLE the cheapest.
const PRICE_DOUBLING_RATIO = 1.0;

// 1.0 when the price changes at least once a month, on average.
const CHANGES_PER_MONTH_SATURATION = 1.0;

// 1.0 at five or more distinct billing descriptors. One descriptor is normal,
// so we count the EXTRAS: 5 descriptors = 4 extras = 4/4 = 1.0.
const EXTRA_DESCRIPTORS_SATURATION = 4;

// 1.0 when every failed charge is retried three or more times.
const RETRIES_PER_FAILURE_SATURATION = 3;

// A retry inside this many hours of the failure counts as "rapid".
const RAPID_RETRY_HOURS = 24;

const MS_PER_HOUR = 1000 * 60 * 60;
const MS_PER_DAY = MS_PER_HOUR * 24;

function parseTime(value) {
   const time = new Date(value).getTime();
   return Number.isFinite(time) ? time : null;
}

/** Length of the merchant's transaction history, in months, minimum 1. */
function historyMonths(transactions) {
   const times = transactions.map(t => parseTime(t.timestamp)).filter(t => t !== null);
   if (times.length < 2) return 1;
   const spanDays = (Math.max(...times) - Math.min(...times)) / MS_PER_DAY;
   return Math.max(1, spanDays / 30);
}

/**
 * SIGNAL 1 — price_volatility
 * "Reaches 1.0 when the highest charge is at least double the lowest."
 *
 * Measured as spread relative to the floor price, (max - min) / min, so it is
 * scale-free: a $5 plan going to $10 and a $50 plan going to $100 are the same
 * abuse and score the same. An absolute dollar threshold would only ever catch
 * expensive merchants.
 */
function priceVolatility(metrics) {
   if (!metrics.min_price_usd) return 0;
   const spreadRatio = (metrics.max_price_usd - metrics.min_price_usd) / metrics.min_price_usd;
   return clamp01(spreadRatio / PRICE_DOUBLING_RATIO);
}

/**
 * SIGNAL 2 — price_change_frequency
 * "Reaches 1.0 when the price changes at least once a month on average."
 *
 * Separate from volatility on purpose: a merchant can move the price often in
 * small steps (low volatility, high frequency) or once, hugely (the reverse).
 * Both are worth knowing and they are different behaviours. Normalising per
 * month stops a merchant with five years of history from looking worse than an
 * identical one with six months.
 */
function priceChangeFrequency(data, metrics) {
   const months = historyMonths(data.transactions);
   return clamp01((metrics.total_price_changes / months) / CHANGES_PER_MONTH_SATURATION);
}

/**
 * SIGNAL 3 — stealth_price_changes
 * "Reaches 1.0 when every price change was made without notifying the customer."
 *
 * Already a proportion, so it needs no saturation constant. Zero price changes
 * scores 0 — no changes means no unannounced changes.
 */
function stealthPriceChanges(metrics) {
   if (!metrics.total_price_changes) return 0;
   return clamp01(metrics.stealth_price_changes / metrics.total_price_changes);
}

/**
 * SIGNAL 4 — rename_frequency
 * "Reaches 1.0 at five or more distinct billing descriptors."
 *
 * This is the identity-evasion signal. A merchant who keeps changing the name
 * on your statement is making the charge unrecognisable, which is what stops
 * customers cancelling.
 *
 * Counts EXTRAS, not total: one descriptor is the honest baseline and must
 * score 0. Depends entirely on normalize.js having collapsed formatting
 * variants first — without that, this signal measures punctuation.
 */
function renameFrequency(metrics) {
   const extras = Math.max(0, metrics.unique_descriptors - 1);
   return clamp01(extras / EXTRA_DESCRIPTORS_SATURATION);
}

/**
 * SIGNAL 5 — cancellation_friction
 * "Reaches 1.0 when no cancellation request ever completed."
 *
 * The subscription-trap signal: customers asking to leave and not getting out.
 * Read from lifecycle_events rather than a metric because it needs the request/
 * completion pairing, which aggregated_metrics does not carry.
 *
 * Matched on the substring "cancel" so it survives the several spellings
 * processors use (cancel_requested, cancellation_requested, cancel_request).
 * An event containing "request" is an attempt; any other cancel event is an
 * exit. No requests at all scores 0 — nobody tried to leave.
 */
function cancellationFriction(data) {
   const cancelEvents = data.lifecycle_events.filter(e =>
      typeof e.event_type === 'string' && e.event_type.includes('cancel')
   );
   if (cancelEvents.length === 0) return 0;

   const requests = cancelEvents.filter(e => e.event_type.includes('request')).length;
   if (requests === 0) return 0;

   const completions = cancelEvents.length - requests;
   const unresolved = Math.max(0, requests - completions);
   return clamp01(unresolved / requests);
}

/**
 * SIGNAL 6 — retry_aggressiveness
 * "Reaches 1.0 when every failed charge is retried three or more times, and
 *  those retries all come within 24 hours."
 *
 * Two components, because volume and speed are different abuses:
 *   - VOLUME (70%): retries per failed charge. Hammering a dead card racks up
 *     the customer's bank fees.
 *   - SPEED  (30%): the share of retries landing within 24h of the failure.
 *     Same-day retries are the pattern that overdraws an account.
 *
 * The 70/30 split is a judgement call. Volume dominates because it is the
 * component that scales the harm; speed alone, at low volume, is normal
 * processor behaviour.
 */
function retryAggressiveness(data) {
   // FIXED 9 Oct 2026 (found by the unit tests). The old version divided all
   // retries by ALL failed transactions - but a retry that also fails is itself
   // a failed transaction. In a chain "fail, retry, retry, retry" retries and
   // failures grow together, so the ratio could never pass 1 and this signal
   // topped out near 0.53 instead of 1.0. A failed CHARGE is the original
   // attempt (attempt 1); retries are counted against those.
   const originals = data.transactions.filter(t => t.status === 'failed' && t.attempt <= 1);
   if (originals.length === 0) return 0;

   const retries = data.transactions.filter(t => t.attempt > 1);
   const volume = clamp01((retries.length / originals.length) / RETRIES_PER_FAILURE_SATURATION);
   if (retries.length === 0) return clamp01(volume * 0.7);

   // Speed: is each retry within 24h of the failed charge it is retrying - the
   // latest original failure on the same subscription at or before it? (The old
   // version measured from the subscription's FIRST-EVER failure, so a fast
   // retry in a later month looked months late.)
   const failureTimes = new Map();
   for (const txn of originals) {
      const time = parseTime(txn.timestamp);
      if (time === null) continue;
      if (!failureTimes.has(txn.subscription_id)) failureTimes.set(txn.subscription_id, []);
      failureTimes.get(txn.subscription_id).push(time);
   }

   const rapidRetries = retries.filter(txn => {
      const retriedAt = parseTime(txn.timestamp);
      const candidates = (failureTimes.get(txn.subscription_id) || []).filter(t => retriedAt !== null && t <= retriedAt);
      if (candidates.length === 0) return false;
      const hoursLater = (retriedAt - Math.max(...candidates)) / MS_PER_HOUR;
      return hoursLater <= RAPID_RETRY_HOURS;
   }).length;

   const speed = clamp01(rapidRetries / retries.length);
   return clamp01(volume * 0.7 + speed * 0.3);
}

export default function extractSignals(data) {
   const metrics = data.aggregated_metrics;

   if (!metrics) {
      throw new Error('extractSignals: aggregated_metrics missing — enrich() must run first');
   }

   return {
      core: {
         price_volatility: priceVolatility(metrics),
         price_change_frequency: priceChangeFrequency(data, metrics),
         stealth_price_changes: stealthPriceChanges(metrics),
         rename_frequency: renameFrequency(metrics),
         cancellation_friction: cancellationFriction(data),
         retry_aggressiveness: retryAggressiveness(data)
      }
   };
}
