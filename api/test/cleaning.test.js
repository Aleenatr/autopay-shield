import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText } from '../src/ingestion/cleaning/normalize.js';
import { analyse, merchant, month } from './helpers.js';

test('normalisation: case, punctuation and legal suffixes do not make a new name', () => {
   assert.equal(normalizeText('NFLX*PREMIUM Ltd.'), 'nflx premium');
   assert.equal(normalizeText('nflx  premium'), 'nflx premium');
});

test('de-duplication drops a re-delivered record but keeps retries', () => {
   const failed = { transaction_id: 'F1', subscription_id: 'S1', user_hash: 'u1', amount_usd: 10, status: 'failed', attempt: 1, timestamp: month(6) };
   const redelivered = { ...failed };                                                  // same transaction_id
   const retry = { ...failed, transaction_id: 'F1-R1', attempt: 2, status: 'success', timestamp: month(6, 3) };  // same sub + amount
   const { data } = analyse(merchant({ extraTxns: [failed, redelivered, retry] }));
   assert.equal(data.transactions.filter(t => t.transaction_id === 'F1').length, 1);
   assert.equal(data.transactions.filter(t => t.transaction_id === 'F1-R1').length, 1);
});

test('prices come from successful charges only: a declined odd amount is not volatility', () => {
   const declined = { transaction_id: 'D1', subscription_id: 'S1', user_hash: 'u1', amount_usd: 99, status: 'failed', attempt: 1, timestamp: month(3) };
   assert.equal(analyse(merchant({ extraTxns: [declined] })).signals.price_volatility, 0);
});
