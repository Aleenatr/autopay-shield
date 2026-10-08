import { test } from 'node:test';
import assert from 'node:assert/strict';
import generateMerchantScore, { assessEvidence } from '../src/ingestion/analysis/merchantScoring.js';
import { signals, month } from './helpers.js';

const cleanMetrics = { chargeback_rate: 0, dispute_rate: 0, notification_compliance_rate: 1 };
const sixCharges = Array.from({ length: 6 }, (_, i) => ({ timestamp: month(i) }));

test('a clean merchant keeps all 100 points', () => {
   const result = generateMerchantScore({ aggregated_metrics: cleanMetrics, transactions: sixCharges }, signals([0, 0, 0, 0, 0, 0]), null, null);
   assert.equal(result.trust_score.score, 100);
   assert.equal(result.trust_score.risk_level, 'HEALTHY');
});

test('the ten penalties add up to 95, so the worst possible merchant scores exactly 5', () => {
   const worstMetrics = { chargeback_rate: 0.05, dispute_rate: 0.1, notification_compliance_rate: 0 };
   const result = generateMerchantScore(
      { aggregated_metrics: worstMetrics, transactions: sixCharges },
      signals([1, 1, 1, 1, 1, 1]),
      { is_outlier: true, anomaly_score: 1 },
      null
   );
   assert.equal(result.trust_score.score, 5);
   assert.equal(result.trust_score.risk_level, 'CRITICAL');
});

test('every deducted point is attributed to a named cause', () => {
   const result = generateMerchantScore({ aggregated_metrics: cleanMetrics, transactions: sixCharges }, signals([0.5, 0, 1, 0, 0, 0]), null, null);
   const { base_score, ...penalties } = result.score_breakdown;
   const total = Object.values(penalties).reduce((a, b) => a + b, 0);
   assert.equal(Math.round(base_score - total), result.trust_score.score);
   assert.equal(penalties.price_volatility_penalty, 10);   // half of its 20
   assert.equal(penalties.stealth_price_changes_penalty, 13);
});

test('cold start: thin history is reported as LOW confidence, not as a confident 100', () => {
   const threeCharges = [0, 1, 2].map(i => ({ timestamp: month(i) }));
   assert.equal(assessEvidence({ transactions: threeCharges }).level, 'LOW');
   const twelveCharges = Array.from({ length: 12 }, (_, i) => ({ timestamp: month(i) }));
   assert.equal(assessEvidence({ transactions: twelveCharges }).level, 'NORMAL');
   const result = generateMerchantScore({ aggregated_metrics: cleanMetrics, transactions: threeCharges }, signals([0, 0, 0, 0, 0, 0]), null, null);
   assert.equal(result.trust_score.score, 100);
   assert.equal(result.trust_score.confidence, 'LOW');
});
