/**
 * SELF-CONTAINED DEMO
 *
 *   npm run demo
 *
 * Starts an in-memory MongoDB, ingests data/sample_merchants.json through the
 * real pipeline, and launches the API on port 5050. Then start the frontend
 * (`cd ../website && npm run dev`) and the dashboard is live.
 *
 * WHY THIS EXISTS:
 * The app needs MongoDB and Redis. Neither is installed on most laptops, and
 * "it works on my machine, give me twenty minutes to install Mongo" is not a
 * demo. mongodb-memory-server downloads a real mongod binary and runs it from a
 * temp directory, so this is not a mock — it is genuine MongoDB, genuine
 * Mongoose, genuine indexes. It just evaporates when the process exits.
 *
 * Redis is simply left down. redis.js:38-41 and :68 already FAIL OPEN — a
 * missing cache is indistinguishable from a cache miss and every request falls
 * through to MongoDB. That was already true; this demo just relies on it.
 *
 * NOTHING IS PERSISTED. Every run starts from the same fixture, which is the
 * point: the demo is reproducible.
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

console.log('\nStarting in-memory MongoDB...');
const mongod = await MongoMemoryServer.create();
const uri = mongod.getUri();
console.log(`   ${uri}`);

// Must be set BEFORE server.js is imported — database.js reads process.env.DB_URL
// at connect time (database.js:8), and server.js connects during module load.
process.env.DB_URL = uri;

// Port 5050, not the repo default of 5000. On macOS the AirPlay Receiver in
// Control Centre binds 5000 and answers every request with 403 — the API looks
// dead when it is running perfectly. Cost half an hour to find once; not twice.
process.env.PORT = process.env.PORT || '5050';

// Admin routes need an API key (src/middleware/requireApiKey.js). The demo
// makes a fresh random one per run and prints it below.
const { randomBytes } = await import('crypto');
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || `demo-${randomBytes(8).toString('hex')}`;

// No Redis in the demo, on purpose: skip connecting instead of retrying and
// printing connection errors. The cache fails open, so everything still works.
process.env.REDIS_ENABLED = 'false';

// Import AFTER the env var is set. A static import would be hoisted above these
// lines and connect to the wrong (or missing) database.
const { default: connectDB } = await import('../src/config/database.js');
const { CleanedData, MerchantAnalysis, ApiResponse } = await import('../src/models/MerchantAnalysis.js');
const { processMerchantsBatch } = await import('../src/services/merchantProcessor.js');
const { reprocessAllMerchants } = await import('../src/services/cronScheduler.js');

await connectDB();

console.log('\nIngesting sample merchants through the real pipeline...');
const merchants = JSON.parse(
   readFileSync(join(here, '..', 'data', 'sample_merchants.json'), 'utf8')
);
const result = await processMerchantsBatch(merchants);
console.log(`   processed ${result.processed}, skipped ${result.skipped}, failed ${result.failed}`);

// Run the population pass immediately. Without it, every merchant carries the
// deferred single-merchant placeholders for cluster and outlier status, because
// neither is computable one merchant at a time. In production this happens on
// the six-hourly cron; here we do not want to wait six hours to see it.
console.log('\nRunning the population pass (clustering + outlier detection)...');
await reprocessAllMerchants();

// Prove the data landed, rather than assuming it did. The old cron wrote
// documents that Mongoose silently stripped to almost nothing, and it logged
// success the whole time — so this check is here specifically because that
// failure mode is possible and invisible.
const counts = {
   cleaned_data: await CleanedData.countDocuments(),
   merchant_analysis_snapshots: await MerchantAnalysis.countDocuments(),
   api_responses: await ApiResponse.countDocuments()
};
console.log('\nCollection counts:', counts);

const sample = await MerchantAnalysis.findOne({ merchantId: 'MRC_001' }).lean();
console.log('\nVerifying MRC_001 stored a full document (not a stripped one):');
console.log(`   trust_score.score      = ${sample?.trust_score?.score}`);
console.log(`   trust_score.risk_level = ${sample?.trust_score?.risk_level}`);
console.log(`   signals.core keys      = ${Object.keys(sample?.signals?.core || {}).length}/6`);
console.log(`   score_breakdown keys   = ${Object.keys(sample?.score_breakdown || {}).length}/11`);
console.log(`   patterns               = ${sample?.patterns?.length}`);
console.log(`   cluster                = ${sample?.cluster_assignment?.cluster}`);
console.log(`   is_outlier             = ${sample?.anomaly_analysis?.is_outlier}`);

console.log('\nStarting the API...');
await import('../src/server.js');

console.log('\n' + '='.repeat(70));
console.log(`  API      http://localhost:${process.env.PORT}`);
console.log(`  Try      curl http://localhost:${process.env.PORT}/api/public/merchants?limit=5`);
console.log(`           curl http://localhost:${process.env.PORT}/api/public/merchants/MRC_001`);
console.log(`           curl http://localhost:${process.env.PORT}/api/public/stats`);
console.log(`  Admin    curl -H "x-api-key: ${process.env.ADMIN_API_KEY}" http://localhost:${process.env.PORT}/api/admin/stats`);
console.log('  Frontend cd ../website && npm run dev   -> http://localhost:5173');
console.log('='.repeat(70));
console.log('  Redis is switched off for the demo. The cache fails open by design,');
console.log('  so every request reads MongoDB directly and everything still works.');
console.log('  Ctrl-C to stop. Nothing is persisted.');
console.log('='.repeat(70) + '\n');

const shutdown = async () => {
   console.log('\nShutting down in-memory MongoDB...');
   await mongod.stop();
   process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
