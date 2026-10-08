import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse, merchant, month } from './helpers.js';

test('a clean merchant scores 0 on all six signals', () => {
   const { signals } = analyse(merchant());
   for (const [name, value] of Object.entries(signals)) assert.equal(value, 0, name);
});

test('price_volatility reaches 1.0 when the price doubles', () => {
   assert.equal(analyse(merchant({ prices: [10, 10, 20, 20, 20, 20] })).signals.price_volatility, 1);
   assert.equal(analyse(merchant({ prices: [10, 10, 15, 15, 15, 15] })).signals.price_volatility, 0.5);
});

test('formatting differences are not renames; five different names are', () => {
   const formatting = merchant({ descriptors: ['ACME', 'Acme Ltd.', 'acme'] });
   assert.equal(analyse(formatting).signals.rename_frequency, 0);
   const renamed = merchant({ descriptors: ['ACME', 'ACM*BILL', 'AC PAYMENTS', 'XYZ SERVICES', 'QQ*SUB'] });
   assert.equal(analyse(renamed).signals.rename_frequency, 1);
});

test('stealth_price_changes is the share of price changes made without notice', () => {
   const events = [
      { subscription_id: 'S1', event_type: 'price_change', timestamp: month(2), old_amount: 10, new_amount: 12, notification_sent: true },
      { subscription_id: 'S1', event_type: 'price_change', timestamp: month(4), old_amount: 12, new_amount: 15, notification_sent: false }
   ];
   assert.equal(analyse(merchant({ events })).signals.stealth_price_changes, 0.5);
});

test('cancellation_friction is the share of cancel requests never completed', () => {
   const events = [
      { subscription_id: 'S1', event_type: 'cancellation_requested', timestamp: month(3) },
      { subscription_id: 'S1', event_type: 'cancellation_requested', timestamp: month(4) }
   ];
   assert.equal(analyse(merchant({ events })).signals.cancellation_friction, 1);
   events.push({ subscription_id: 'S1', event_type: 'cancellation_completed', timestamp: month(4, 1) });
   assert.equal(analyse(merchant({ events })).signals.cancellation_friction, 0.5);
});

test('retry_aggressiveness reaches 1.0: three fast retries of one failed charge', () => {
   // The bug this guards: failed retries used to count as new failures, so the
   // ratio "retries per failed charge" could never pass 1 and this stayed ~0.53.
   const failed = { transaction_id: 'F1', subscription_id: 'S1', user_hash: 'u1', amount_usd: 10, status: 'failed', attempt: 1, timestamp: month(6) };
   const retries = [1, 2, 3].map(r => ({
      ...failed, transaction_id: `F1-R${r}`, attempt: r + 1, timestamp: month(6, r * 2), status: r === 3 ? 'success' : 'failed'
   }));
   const { signals, data } = analyse(merchant({ extraTxns: [failed, ...retries] }));
   assert.equal(data.transactions.filter(t => t.attempt > 1).length, 3, 'a retry is not a duplicate');
   assert.equal(signals.retry_aggressiveness, 1);
});

test('a single retry days later is normal processor behaviour, not aggression', () => {
   const failed = { transaction_id: 'F1', subscription_id: 'S1', user_hash: 'u1', amount_usd: 10, status: 'failed', attempt: 1, timestamp: month(6) };
   const retry = { ...failed, transaction_id: 'F1-R1', attempt: 2, status: 'success', timestamp: month(6, 72) };
   const value = analyse(merchant({ extraTxns: [failed, retry] })).signals.retry_aggressiveness;
   assert.ok(value < 0.3, `expected a low score, got ${value}`);
});

test('a fast retry in a later month is measured from ITS failure, not the first-ever one', () => {
   const fail = (id, m) => ({ transaction_id: id, subscription_id: 'S1', user_hash: 'u1', amount_usd: 10, status: 'failed', attempt: 1, timestamp: month(m) });
   const retry = (id, m) => ({ transaction_id: id, subscription_id: 'S1', user_hash: 'u1', amount_usd: 10, status: 'success', attempt: 2, timestamp: month(m, 2) });
   const { signals } = analyse(merchant({ extraTxns: [fail('A', 1), retry('A2', 1), fail('B', 5), retry('B2', 5)] }));
   // volume: 2 retries for 2 failed charges = 1 per charge = 1/3 of the saturation point.
   // speed: both retries came 2 hours after their own failure, so both are fast.
   const expected = 0.7 * (1 / 3) + 0.3 * 1;
   assert.ok(Math.abs(signals.retry_aggressiveness - expected) < 1e-9, `got ${signals.retry_aggressiveness}`);
});
