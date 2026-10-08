/**
 * STEP 8 — MERCHANT SCORING
 *
 * The module everything else exists to feed. Turns six signals plus the two
 * clustering results into a trust score, a risk band, and a list of named
 * patterns.
 *
 * Called as generateMerchantScore(cleanData, signalData, dbscanResult, kmeansResult)
 * from merchantProcessor.js:35. Return shape is read back at :61-65 and :121-122.
 *
 * ==================== HIGHER = SAFER. THIS IS THE INVERSION ================
 * The six signals are all "higher = worse". The trust score is "higher = SAFER":
 * 100 is a clean merchant, 5 is the worst we will report.
 *
 * The flip happens here and ONLY here: score = 100 - (sum of penalties).
 * ==========================================================================
 *
 * WHY A PENALTY MODEL RATHER THAN A TRAINED CLASSIFIER:
 * There are no labels. Nobody has told us which merchants are actually abusive,
 * so there is nothing to train against. A weighted penalty model is honest about
 * that — it is a stated policy, auditable line by line, and every point lost is
 * attributable to a named cause in score_breakdown. A model would be a guess
 * wearing a lab coat. This is the right call for an unlabelled problem and it is
 * worth saying so out loud rather than apologising for it.
 */

// ============================ THE PENALTY MODEL ============================
// Maximum points each factor can remove from a perfect 100.
//
// THEY SUM TO EXACTLY 95. That is deliberate: the floor is 5 BY CONSTRUCTION,
// not by clamping. A score of 5 means "every factor we measure is at its worst",
// and the 5 points that remain encode "we still might be wrong about you".
// Never reporting absolute zero on inferred evidence is a deliberate choice.
//
// The ordering encodes the product's judgement about consumer harm:
// price manipulation and identity evasion sit at the top because they are what
// stops a customer recognising and cancelling a charge.
const PENALTY_WEIGHTS = {
   price_volatility: 20,          // the headline abuse: the price moved a lot
   rename_frequency: 17,          // identity evasion: the charge became unrecognisable
   stealth_price_changes: 13,     // it moved AND they did not say
   cancellation_friction: 9,      // they could not get out
   retry_aggressiveness: 9,       // the dead card got hammered
   price_change_frequency: 7,     // it keeps moving
   chargeback: 7,                 // the bank sided with customers against them
   dispute: 4,                    // customers formally complained
   notification: 4,               // poor disclosure generally
   outlier: 5                     // does not behave like anyone else
};
// 20+17+13+9+9+7+7+4+4+5 = 95

// Rates at which the non-signal penalties reach their maximum.
// 2% chargebacks is the card-network danger line — Visa/Mastercard place a
// merchant into a monitoring programme around there, so it is an external
// benchmark rather than a number we invented.
const CHARGEBACK_RATE_SATURATION = 0.02;
// No equivalent published line for disputes; 5% is our own judgement and is
// labelled as such.
const DISPUTE_RATE_SATURATION = 0.05;

// Trust score band boundaries. These match the comment block at
// merchantProcessor.js:133-137 and the getRiskLevel ladder at :211-216.
const BANDS = { HEALTHY: 66, NEEDS_ATTENTION: 41, HIGH_RISK: 21 };
const BANDS_DESCRIPTION = '0-20 CRITICAL | 21-40 HIGH_RISK | 41-65 NEEDS_ATTENTION | 66-100 HEALTHY';

// Thresholds at which a signal is loud enough to name as a human-readable
// pattern. Higher than the scoring thresholds on purpose: scoring is continuous
// and every merchant gets a number, but a PATTERN is an accusation shown to a
// user, so it needs to clear a higher bar.
const PATTERN_THRESHOLDS = {
   PRICE_CREEP: 0.6,
   IDENTITY_EVASION: 0.6,
   AGGRESSIVE_RETRY: 0.3,
   SILENT_PRICE_INCREASE: 0.5,
   SUBSCRIPTION_TRAP: 0.5,
   BILLING_INCONSISTENCY: 0.5
};

function clamp(value, low, high) {
   if (!Number.isFinite(value)) return low;
   return Math.max(low, Math.min(high, value));
}

function round2(value) {
   return Number(value.toFixed(2));
}

/**
 * Every point deducted, attributed to a named cause.
 * Shape matches score_breakdown (models:170-182).
 *
 * This object is the reason the model is defensible: any score can be handed
 * back as "you lost 20 for price volatility and 17 for descriptor churn",
 * which no trained classifier could produce without a separate explainer.
 */
function calculateScoreBreakdown(core, metrics, dbscanResult) {
   const chargebackRate = metrics.chargeback_rate || 0;
   const disputeRate = metrics.dispute_rate || 0;
   // notification_compliance_rate is 1 when there was nothing to disclose, so
   // this correctly becomes 0 penalty in that case.
   const nonCompliance = 1 - (Number.isFinite(metrics.notification_compliance_rate)
      ? metrics.notification_compliance_rate
      : 1);

   return {
      base_score: 100,

      price_volatility_penalty:       round2(clamp(core.price_volatility, 0, 1) * PENALTY_WEIGHTS.price_volatility),
      price_change_frequency_penalty: round2(clamp(core.price_change_frequency, 0, 1) * PENALTY_WEIGHTS.price_change_frequency),
      stealth_price_changes_penalty:  round2(clamp(core.stealth_price_changes, 0, 1) * PENALTY_WEIGHTS.stealth_price_changes),
      rename_frequency_penalty:       round2(clamp(core.rename_frequency, 0, 1) * PENALTY_WEIGHTS.rename_frequency),
      cancellation_friction_penalty:  round2(clamp(core.cancellation_friction, 0, 1) * PENALTY_WEIGHTS.cancellation_friction),
      retry_aggressiveness_penalty:   round2(clamp(core.retry_aggressiveness, 0, 1) * PENALTY_WEIGHTS.retry_aggressiveness),

      chargeback_penalty:   round2(clamp(chargebackRate / CHARGEBACK_RATE_SATURATION, 0, 1) * PENALTY_WEIGHTS.chargeback),
      dispute_penalty:      round2(clamp(disputeRate / DISPUTE_RATE_SATURATION, 0, 1) * PENALTY_WEIGHTS.dispute),
      notification_penalty: round2(clamp(nonCompliance, 0, 1) * PENALTY_WEIGHTS.notification),

      outlier_penalty: dbscanResult && dbscanResult.is_outlier
         ? round2(clamp(dbscanResult.anomaly_score, 0, 1) * PENALTY_WEIGHTS.outlier)
         : 0
   };
}

function calculateTrustScore(breakdown) {
   const totalPenalty = Object.entries(breakdown)
      .filter(([key]) => key !== 'base_score')
      .reduce((sum, [, value]) => sum + value, 0);

   // The clamp is belt-and-braces. Because the weights sum to 95, the result is
   // already inside [5,100] — but a future weight change should fail safe rather
   // than emit a negative trust score.
   return clamp(Math.round(breakdown.base_score - totalPenalty), 5, 100);
}

function getRiskLevel(trustScore) {
   if (trustScore >= BANDS.HEALTHY) return 'HEALTHY';
   if (trustScore >= BANDS.NEEDS_ATTENTION) return 'NEEDS_ATTENTION';
   if (trustScore >= BANDS.HIGH_RISK) return 'HIGH_RISK';
   return 'CRITICAL';
}

// ============================ COLD START ====================================
// A merchant with three charges scores close to 100, because none of the six
// signals has anything to fire on - "no evidence of abuse" is not "evidence of
// no abuse". So every score now says how much evidence it rests on. Below
// these minimums it is reported with LOW confidence instead of looking certain.
// The score itself is not changed: hiding the number would be its own lie.
const MIN_TRANSACTIONS = 6;      // fewer charges than this cannot show a pattern
const MIN_HISTORY_MONTHS = 3;    // in under a quarter a price change cannot even repeat

export function assessEvidence(cleanData) {
   const times = (cleanData.transactions || [])
      .map(t => new Date(t.timestamp).getTime())
      .filter(Number.isFinite);
   const months = times.length > 1
      ? round2((Math.max(...times) - Math.min(...times)) / (1000 * 60 * 60 * 24 * 30))
      : 0;
   const level = times.length < MIN_TRANSACTIONS || months < MIN_HISTORY_MONTHS ? 'LOW' : 'NORMAL';
   return { level, transactions: times.length, history_months: months };
}

/**
 * Human-readable abuse patterns. Each carries EVIDENCE — the specific numbers
 * that triggered it — because "this merchant is risky" is not actionable and
 * "the price went from $4.99 to $19.99 across 5 billing names" is.
 *
 * All eight enum values from models:186-196 are reachable.
 */
function detectPatterns(core, metrics) {
   const patterns = [];

   const add = (type, severity, evidence, confidence, dataPoints) => {
      patterns.push({
         type,
         severity,
         evidence,
         confidence: Number(clamp(confidence, 0, 1).toFixed(3)),
         data_points: dataPoints
      });
   };

   if (core.price_volatility > PATTERN_THRESHOLDS.PRICE_CREEP) {
      add('PRICE_CREEP',
         core.price_volatility > 0.8 ? 'HIGH' : 'MEDIUM',
         `Price ranged from $${metrics.min_price_usd} to $${metrics.max_price_usd} (+${metrics.price_increase_percent}%) with no corresponding plan change`,
         core.price_volatility,
         { min_price_usd: metrics.min_price_usd, max_price_usd: metrics.max_price_usd });
   }

   if (core.rename_frequency > PATTERN_THRESHOLDS.IDENTITY_EVASION) {
      add('IDENTITY_EVASION',
         core.rename_frequency > 0.8 ? 'CRITICAL' : 'HIGH',
         `${metrics.unique_descriptors} distinct billing descriptors used, making the charge hard to recognise on a statement`,
         core.rename_frequency,
         { unique_descriptors: metrics.unique_descriptors });
   }

   if (core.retry_aggressiveness > PATTERN_THRESHOLDS.AGGRESSIVE_RETRY) {
      add('AGGRESSIVE_RETRY',
         core.retry_aggressiveness > 0.6 ? 'HIGH' : 'MEDIUM',
         `${metrics.total_retry_attempts} retry attempts against ${metrics.failed_transactions} failed charges`,
         core.retry_aggressiveness,
         { total_retry_attempts: metrics.total_retry_attempts, failed_transactions: metrics.failed_transactions });
   }

   if (core.stealth_price_changes > PATTERN_THRESHOLDS.SILENT_PRICE_INCREASE) {
      add('SILENT_PRICE_INCREASE',
         core.stealth_price_changes > 0.8 ? 'CRITICAL' : 'HIGH',
         `${metrics.stealth_price_changes} of ${metrics.total_price_changes} price changes were made without notifying the customer`,
         core.stealth_price_changes,
         { stealth_price_changes: metrics.stealth_price_changes, total_price_changes: metrics.total_price_changes });
   }

   if (core.cancellation_friction > PATTERN_THRESHOLDS.SUBSCRIPTION_TRAP) {
      add('SUBSCRIPTION_TRAP',
         core.cancellation_friction > 0.8 ? 'CRITICAL' : 'HIGH',
         `Cancellation requests are not resulting in completed cancellations`,
         core.cancellation_friction,
         { cancellation_friction: round2(core.cancellation_friction) });
   }

   if (core.price_change_frequency > PATTERN_THRESHOLDS.BILLING_INCONSISTENCY) {
      add('BILLING_INCONSISTENCY',
         'MEDIUM',
         `${metrics.total_price_changes} price changes recorded across the analysis window`,
         core.price_change_frequency,
         { total_price_changes: metrics.total_price_changes });
   }

   // Above the card-network monitoring line: the customer's BANK has repeatedly
   // ruled against this merchant. That is third-party evidence, not our inference,
   // which is why it is CRITICAL rather than HIGH.
   if ((metrics.chargeback_rate || 0) > CHARGEBACK_RATE_SATURATION) {
      add('CHARGEBACK_ABUSE',
         'CRITICAL',
         `Chargeback rate of ${(metrics.chargeback_rate * 100).toFixed(2)}% exceeds the 2% card-network monitoring threshold`,
         Math.min(1, metrics.chargeback_rate / CHARGEBACK_RATE_SATURATION),
         { chargeback_rate: round2(metrics.chargeback_rate), chargebacks_90d: metrics.chargebacks_90d });
   }

   // The correlation pattern: renaming AND being disputed. Either alone is
   // ambiguous — a rebrand is legitimate, and disputes happen. Together they are
   // the signature of a merchant changing names to outrun complaints.
   if (metrics.unique_descriptors > 2 && (metrics.dispute_rate || 0) > 0.03) {
      add('DESCRIPTOR_DISPUTE_CORRELATION',
         'HIGH',
         `${metrics.unique_descriptors} billing descriptors alongside a ${(metrics.dispute_rate * 100).toFixed(2)}% dispute rate`,
         Math.min(1, metrics.dispute_rate / DISPUTE_RATE_SATURATION),
         { unique_descriptors: metrics.unique_descriptors, dispute_rate: round2(metrics.dispute_rate) });
   }

   return patterns;
}

function getRecommendedAction(riskLevel) {
   const actions = {
      CRITICAL: {
         primary: 'Cancel this subscription immediately',
         urgency: 'URGENT',
         nextSteps: [
            'Cancel via the merchant platform',
            'Contact your bank to block future charges',
            'Monitor statements for 90 days'
         ]
      },
      HIGH_RISK: {
         primary: 'Review and consider canceling',
         urgency: 'HIGH',
         nextSteps: ['Review subscription terms', 'Check the cancellation process', 'Set price alerts']
      },
      NEEDS_ATTENTION: {
         primary: 'Monitor future charges',
         urgency: 'MEDIUM',
         nextSteps: ['Monitor the next billing cycle', 'Review recent price changes']
      },
      HEALTHY: {
         primary: 'No action needed',
         urgency: 'LOW',
         nextSteps: ['Continue monitoring']
      }
   };
   return actions[riskLevel] || actions.NEEDS_ATTENTION;
}

export default function generateMerchantScore(cleanData, signalData, dbscanResult, kmeansResult) {
   const core = (signalData && signalData.core) ? signalData.core : {};
   const metrics = cleanData.aggregated_metrics || {};

   const score_breakdown = calculateScoreBreakdown(core, metrics, dbscanResult);
   const score = calculateTrustScore(score_breakdown);
   const risk_level = getRiskLevel(score);
   const patterns = detectPatterns(core, metrics);
   const evidence = assessEvidence(cleanData);

   return {
      // Boolean roll-ups for callers that just want a yes/no (models:145-149).
      derived_indicators: {
         price_creep_detected: patterns.some(p => p.type === 'PRICE_CREEP'),
         descriptor_churn_detected: patterns.some(p => p.type === 'IDENTITY_EVASION'),
         retry_pattern_detected: patterns.some(p => p.type === 'AGGRESSIVE_RETRY')
      },

      // Passed through unchanged — these already arrive in schema shape.
      anomaly_analysis: dbscanResult,
      cluster_assignment: kmeansResult,

      trust_score: {
         score,
         scale: '0-100, higher is safer',
         risk_level,
         confidence: evidence.level,  // LOW = too little history to trust the number (see COLD START)
         evidence: { transactions: evidence.transactions, history_months: evidence.history_months }
      },

      score_breakdown,
      patterns,
      recommended_action: getRecommendedAction(risk_level),

      // Not schema fields — carried for generateApiResponse, which needs the
      // bands string and the cluster name for its display strings.
      bands_description: BANDS_DESCRIPTION,
      cluster_mapping: `${(kmeansResult && kmeansResult.cluster) || 'UNCLASSIFIED'} → ${risk_level}`
   };
}
