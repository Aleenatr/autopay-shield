/**
 * STEP 9 — GENERATE API RESPONSE
 *
 * Job: build the public read model — the flat document the dashboard actually
 * fetches. Output shape is apiResponseSchema (models:240-316).
 *
 * Called as generateApiResponse({ cleanData, signals, scoring }) from
 * merchantProcessor.js:76-80. ONE object argument.
 *
 * ==================== SIBLING, NOT A CHAIN ====================
 * This does NOT read the snapshot. It takes the same in-memory objects the
 * snapshot was built from (merchantProcessor.js:50-72 and :76-80 use the same
 * `data`, `signalData`, `scoringResult`).
 *
 * The consequence, and it is worth knowing before someone asks: you CANNOT
 * regenerate api_responses from merchant_analysis_snapshots alone. You would
 * need cleaned_data plus a re-run of the scorer. Two derived collections from
 * one computation, with no path between them.
 * ==============================================================
 *
 * NOTE THE CASE FLIP. The internal snapshot is snake_case (trust_score,
 * patterns). This public document is camelCase (riskAssessment.trustScore,
 * patternsDetected). That is not sloppiness — it is a real boundary between the
 * internal analysis record and the public contract, and public.js:114 reinforces
 * it by stripping _id/__v/timestamps so the API stays storage-agnostic.
 */

const API_VERSION = '2.0.0';

/** Turn a 0..1 signal into a word, for the supportingData block. */
function describeLevel(value, lowLabel, mediumLabel, highLabel) {
   if (!Number.isFinite(value)) return 'unknown';
   if (value >= 0.66) return highLabel;
   if (value >= 0.33) return mediumLabel;
   return lowLabel;
}

function formatPercent(rate) {
   if (!Number.isFinite(rate)) return 'unknown';
   return `${(rate * 100).toFixed(2)}%`;
}

/**
 * The one-line reason shown under the headline.
 *
 * Ordered most-specific-first: a merchant doing two things gets the combined
 * sentence rather than whichever single pattern happened to be checked first.
 */
function buildOneLineReason(patterns, metrics) {
   if (patterns.length === 0) return 'Standard subscription billing pattern';

   const has = (type) => patterns.some(p => p.type === type);

   if (has('PRICE_CREEP') && has('IDENTITY_EVASION')) {
      return 'Significant price increases combined with frequent merchant renaming';
   }
   if (has('CHARGEBACK_ABUSE')) {
      return `Chargeback rate of ${formatPercent(metrics.chargeback_rate)} is above the card-network monitoring threshold`;
   }
   if (has('SUBSCRIPTION_TRAP')) {
      return 'Cancellation requests are not completing';
   }
   if (has('PRICE_CREEP')) {
      return `Price increased ${metrics.price_increase_percent}% across the analysis window`;
   }
   if (has('IDENTITY_EVASION')) {
      return `${metrics.unique_descriptors} different billing names used`;
   }
   if (has('SILENT_PRICE_INCREASE')) {
      return 'Price changes were made without notifying customers';
   }
   if (has('AGGRESSIVE_RETRY')) {
      return 'Failed payments are retried aggressively';
   }

   // Reached when a pattern fired that has no bespoke sentence. Falls back to
   // the pattern's own evidence rather than a generic line, so the user always
   // gets the specific reason.
   return patterns[0].evidence;
}

const HEADLINES = {
   CRITICAL: 'High-risk recurring billing behavior detected',
   HIGH_RISK: 'Concerning recurring billing patterns detected',
   NEEDS_ATTENTION: 'Monitor this subscription for changes',
   HEALTHY: 'Subscription billing appears normal'
};

export default function generateApiResponse({ cleanData, signals, scoring }) {
   const merchant = cleanData.merchant;
   const metrics = cleanData.aggregated_metrics || {};
   const core = (signals && signals.core) ? signals.core : {};

   // Analysis window, recomputed from the transaction timestamps. Same
   // derivation as merchantProcessor.js:38-48 — kept here so this module can
   // be called without a snapshot in hand, which is the whole point of it being
   // a sibling rather than a chain.
   const times = cleanData.transactions
      .map(t => new Date(t.timestamp).getTime())
      .filter(t => Number.isFinite(t));

   const toDay = (ms) => new Date(ms).toISOString().split('T')[0];
   const from = times.length ? toDay(Math.min(...times)) : toDay(Date.now());
   const to = times.length ? toDay(Math.max(...times)) : toDay(Date.now());
   const durationMonths = times.length
      ? Math.round((Math.max(...times) - Math.min(...times)) / (1000 * 60 * 60 * 24 * 30))
      : 0;

   const riskLevel = scoring.trust_score.risk_level;

   return {
      merchantId: merchant.merchant_id,
      merchantName: merchant.merchant_name,
      category: merchant.category_code || 'UNKNOWN',

      analysisWindow: { from, to, durationMonths },

      riskAssessment: {
         trustScore: scoring.trust_score.score,
         riskLevel,
         // The clustering's own confidence in the archetype it assigned — NOT
         // confidence in the trust score, which is deterministic and has none.
         confidence: (scoring.cluster_assignment && scoring.cluster_assignment.confidence) || 0,
         // Separate from `confidence` above: this one is about the trust SCORE.
         // LOW means "too little history to be sure", the cold-start case.
         scoreConfidence: scoring.trust_score.confidence || 'NORMAL',
         isOutlier: (scoring.anomaly_analysis && scoring.anomaly_analysis.is_outlier) || false,
         clusterMapping: scoring.cluster_mapping
      },

      // Passed through unchanged: the patterns array is already in the shape
      // apiResponseSchema declares (models:262-283), identical to the internal
      // one. Reshaping it here would be two definitions of the same thing.
      patternsDetected: scoring.patterns,

      summary: {
         headline: HEADLINES[riskLevel] || 'Subscription analysis complete',
         oneLineReason: buildOneLineReason(scoring.patterns, metrics)
      },

      recommendedAction: scoring.recommended_action,

      // The numbers behind the verdict, in words. This is what makes the score
      // contestable rather than an oracle — a user can see WHY without reading
      // the breakdown.
      supportingData: {
         chargeback_rate: Number((metrics.chargeback_rate || 0).toFixed(4)),
         dispute_rate: Number((metrics.dispute_rate || 0).toFixed(4)),
         price_change_frequency: describeLevel(core.price_change_frequency, 'stable', 'occasional', 'frequent'),
         notification_compliance: formatPercent(metrics.notification_compliance_rate),
         descriptor_stability: describeLevel(core.rename_frequency, 'stable', 'some churn', 'high churn'),
         // Reports OUR evidence quality, not the merchant's behaviour. Thin
         // telemetry should read as "we know little", not as "they are clean".
         risk_signal_quality: describeLevel(
            (metrics.risk_signal_quality && metrics.risk_signal_quality.coverage) || 0,
            'sparse', 'partial', 'good'
         )
      },

      metadata: {
         generated_at: new Date().toISOString(),
         api_version: API_VERSION,
         trustScoreBands: scoring.bands_description
      }
   };
}
