import mongoose from 'mongoose';
const cleanedDataSchema = new mongoose.Schema({
   processed_at: { type: String, required: true },
   merchant: {
      merchant_id: { type: String, required: true, unique: true, index: true },
      merchant_name: { type: String, required: true },
      legal_name: String,
      country: String,
      category_code: String,
      first_seen_at: String,
      normalized_name: String,
      descriptor_variants: [String],
      normalized_descriptors: [String],
      business_age_days: Number,
      website_url: String,
      customer_support_channels: [String],
      transparency_score: Number,
      industry_benchmarks: {
         category_avg_chargeback_rate: Number,
         category_avg_retry_rate: Number,
         category_avg_price_volatility: Number
      }
   },
   subscriptions: [{
      subscription_id: String,
      user_hash: String,
      billing_interval: String,
      trial_days: Number,
      start_date: String
   }],
   lifecycle_events: [{
      subscription_id: String,
      event_type: String,
      timestamp: String,
      old_amount: Number,
      new_amount: Number,
      notification_sent: Boolean,
      notification_method: String,
      advance_notice_days: Number
   }],
   transactions: [{
      transaction_id: String,
      subscription_id: String,
      user_hash: String,
      amount_usd: Number,
      status: String,
      attempt: Number,
      timestamp: String,
      descriptor: String,
      dispute_filed_at: String,
      dispute_reason: String,
      dispute_status: String,
      chargeback_filed_at: String,
      chargeback_reason: String,
      chargeback_status: String,
      failure_reason: String,
      risk_signals: {
         cvv_match: Boolean,
         avs_match: String,
         ip_country: String,
         card_country: String,
         velocity_flags: [String]
      },
      device_fingerprint: String,
      payment_method_type: String,
      card_bin: String
   }],
   dispute_events: [new mongoose.Schema({
      dispute_id: String,
      transaction_id: String,
      filed_at: String,
      type: String,
      reason: String,
      status: String,
      customer_explanation: String
   }, { _id: false })],
   aggregated_metrics: {
      total_users: Number,
      total_subscriptions: Number,
      total_transactions: Number,
      successful_transactions: Number,
      failed_transactions: Number,
      max_price_usd: Number,
      min_price_usd: Number,
      price_increase_percent: Number,
      unique_descriptors: Number,
      retry_attempts: Number,
      total_retry_attempts: Number,
      avg_retry_rate: Number,
      chargebacks_90d: Number,
      disputes_90d: Number,
      refunds_90d: Number,
      chargeback_rate: Number,
      dispute_rate: Number,
      stealth_price_changes: Number,
      total_price_changes: Number,
      notification_compliance_rate: Number,
      risk_signal_quality: {
         coverage: Number,
         cvv_match_rate: Number,
         avs_full_match_rate: Number,
         geographic_mismatches: Number
      },
      chargeback_zscore: Number,
      retry_zscore: Number,
      price_volatility_zscore: Number
   },
   ingestion_metadata: {
      batch_id: String,
      record_count: Number,
      schema_version: String,
      ingestion_mode: String,
      latency_ms: Number,
      target_latency_ms: Number
   }
}, {
   timestamps: true,
   collection: 'cleaned_data'
});

cleanedDataSchema.index({ 'merchant.merchant_name': 1 });
cleanedDataSchema.index({ 'merchant.country': 1 });
cleanedDataSchema.index({ processed_at: -1 });

const merchantAnalysisSchema = new mongoose.Schema({
   merchantId: { type: String, required: true, unique: true, index: true },
   merchantName: { type: String, required: true },
   analysis_window: {
      from: String,
      to: String,
      months: Number
   },

   signals: {
      core: {
         price_volatility: { type: Number, min: 0, max: 1 },
         price_change_frequency: { type: Number, min: 0, max: 1 },
         stealth_price_changes: { type: Number, min: 0, max: 1 },
         rename_frequency: { type: Number, min: 0, max: 1 },
         cancellation_friction: { type: Number, min: 0, max: 1 },
         retry_aggressiveness: { type: Number, min: 0, max: 1 }
      }
   },

   derived_indicators: {
      price_creep_detected: Boolean,
      descriptor_churn_detected: Boolean,
      retry_pattern_detected: Boolean
   },

   anomaly_analysis: {
      is_outlier: Boolean,
      anomaly_score: Number,
      method: String
   },
   cluster_assignment: {
      cluster: String,
      confidence: Number
   },

   trust_score: {
      score: { type: Number, min: 0, max: 100 },
      scale: String,
      risk_level: {
         type: String,
         enum: ['HEALTHY', 'NEEDS_ATTENTION', 'HIGH_RISK', 'CRITICAL']
      },
      // Declared here on purpose: the schema is strict, so a field the scorer
      // writes but the schema doesn't know is silently dropped (the cron bug).
      confidence: { type: String, enum: ['LOW', 'NORMAL'] },
      evidence: {
         transactions: Number,
         history_months: Number
      }
   },

   score_breakdown: {
      base_score: Number,
      price_volatility_penalty: Number,
      price_change_frequency_penalty: Number,
      stealth_price_changes_penalty: Number,
      rename_frequency_penalty: Number,
      cancellation_friction_penalty: Number,
      retry_aggressiveness_penalty: Number,
      chargeback_penalty: Number,
      dispute_penalty: Number,
      notification_penalty: Number,
      outlier_penalty: Number
   },

   patterns: [{
      type: {
         type: String,
         enum: [
            'PRICE_CREEP',
            'IDENTITY_EVASION',
            'AGGRESSIVE_RETRY',
            'SUBSCRIPTION_TRAP',
            'BILLING_INCONSISTENCY',
            'SILENT_PRICE_INCREASE',
            'CHARGEBACK_ABUSE',
            'DESCRIPTOR_DISPUTE_CORRELATION'
         ]
      },
      severity: {
         type: String,
         enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
      },
      evidence: String,
      confidence: Number,
      data_points: mongoose.Schema.Types.Mixed
   }],

   recommended_action: {
      primary: String,
      urgency: {
         type: String,
         enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT']
      },
      nextSteps: [String]
   },

   cleaned_data_ref: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CleanedData'
   },

   // Metadata
   metadata: {
      total_users: Number,
      total_subscriptions: Number,
      analysis_timestamp: String,
      pipeline_version: String
   }
}, {
   timestamps: true,
   collection: 'merchant_analysis_snapshots'
});

merchantAnalysisSchema.index({ 'trust_score.score': 1 });
merchantAnalysisSchema.index({ 'trust_score.risk_level': 1 });
merchantAnalysisSchema.index({ 'anomaly_analysis.is_outlier': 1 });
merchantAnalysisSchema.index({ 'cluster_assignment.cluster': 1 });
merchantAnalysisSchema.index({ 'metadata.analysis_timestamp': -1 });

// Public API Response Schema
const apiResponseSchema = new mongoose.Schema({
   merchantId: { type: String, required: true, unique: true, index: true },
   merchantName: { type: String, required: true },
   category: String,

   analysisWindow: {
      from: String,
      to: String,
      durationMonths: Number
   },

   riskAssessment: {
      trustScore: { type: Number, min: 0, max: 100 },
      riskLevel: {
         type: String,
         enum: ['HEALTHY', 'NEEDS_ATTENTION', 'HIGH_RISK', 'CRITICAL']
      },
      confidence: Number,
      // How much evidence the trust score rests on: LOW = thin history (cold start).
      scoreConfidence: { type: String, enum: ['LOW', 'NORMAL'] },
      isOutlier: Boolean,
      clusterMapping: String  // e.g., "AGGRESSIVE_PATTERN → HIGH_RISK"
   },

   patternsDetected: [{
      type: {
         type: String,
         enum: [
            'PRICE_CREEP',
            'IDENTITY_EVASION',
            'AGGRESSIVE_RETRY',
            'SUBSCRIPTION_TRAP',
            'BILLING_INCONSISTENCY',
            'SILENT_PRICE_INCREASE',
            'CHARGEBACK_ABUSE',
            'DESCRIPTOR_DISPUTE_CORRELATION'
         ]
      },
      severity: {
         type: String,
         enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
      },
      evidence: String,
      confidence: Number,
      data_points: mongoose.Schema.Types.Mixed
   }],

   summary: {
      headline: String,
      oneLineReason: String
   },

   recommendedAction: {
      primary: String,
      urgency: {
         type: String,
         enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT']
      },
      nextSteps: [String]
   },

   supportingData: {
      chargeback_rate: Number,
      dispute_rate: Number,
      price_change_frequency: String,
      notification_compliance: String,
      descriptor_stability: String,
      risk_signal_quality: String
   },

   metadata: {
      generated_at: String,
      api_version: String,
      trustScoreBands: String  // Formalized bands for transparency
   }
}, {
   timestamps: true,
   collection: 'api_responses'
});

apiResponseSchema.index({ 'riskAssessment.trustScore': 1 });
apiResponseSchema.index({ 'riskAssessment.riskLevel': 1 });
apiResponseSchema.index({ merchantName: 'text' });
apiResponseSchema.index({ 'metadata.generated_at': -1 });

// Delete existing models if they exist (to prevent schema conflicts)
if (mongoose.models.CleanedData) delete mongoose.models.CleanedData;
if (mongoose.models.MerchantAnalysis) delete mongoose.models.MerchantAnalysis;
if (mongoose.models.ApiResponse) delete mongoose.models.ApiResponse;

export const CleanedData = mongoose.model('CleanedData', cleanedDataSchema);
export const MerchantAnalysis = mongoose.model('MerchantAnalysis', merchantAnalysisSchema);
export const ApiResponse = mongoose.model('ApiResponse', apiResponseSchema);

export default { CleanedData, MerchantAnalysis, ApiResponse };
