// Small builders shared by the tests: real pipeline code, tiny hand-made inputs.
import validate from '../src/ingestion/cleaning/validate.js';
import normalize from '../src/ingestion/cleaning/normalize.js';
import deduplicate from '../src/ingestion/cleaning/deduplicate.js';
import enrich from '../src/ingestion/cleaning/enrich.js';
import extractSignals from '../src/ingestion/analysis/extractSignals.js';

/** An ISO timestamp i "months" (30-day steps) after 1 Jan 2026, plus some hours. */
export const month = (i, hours = 0) =>
   new Date(Date.UTC(2026, 0, 1) + i * 30 * 86400000 + hours * 3600000).toISOString();

/** A raw merchant with one subscription and one successful charge per price. */
export function merchant({ prices = [10, 10, 10, 10, 10, 10], descriptors = ['ACME'], extraTxns = [], events = [] } = {}) {
   const charges = prices.map((amount, i) => ({
      transaction_id: `T${i}`, subscription_id: 'S1', user_hash: 'u1', amount_usd: amount,
      status: 'success', attempt: 1, timestamp: month(i), descriptor: descriptors[i % descriptors.length]
   }));
   return {
      merchant: { merchant_id: 'M1', merchant_name: 'Acme' },
      subscriptions: [{ subscription_id: 'S1', user_hash: 'u1' }],
      transactions: [...charges, ...extraTxns],
      lifecycle_events: events,
      dispute_events: []
   };
}

/** Run the four cleaning steps, then the six signals. */
export function analyse(raw) {
   const data = enrich(deduplicate(normalize(validate(raw))));
   return { data, signals: extractSignals(data).core };
}

/** A signals object from six numbers, in the pipeline's fixed order. */
export const signals = ([pv, pcf, spc, rf, cf, ra]) => ({
   core: {
      price_volatility: pv, price_change_frequency: pcf, stealth_price_changes: spc,
      rename_frequency: rf, cancellation_friction: cf, retry_aggressiveness: ra
   }
});
