import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performKMeansClustering } from '../src/ingestion/analysis/kmeansAnalysis.js';
import { performDBSCANClustering } from '../src/ingestion/analysis/dbscanAnalysis.js';
import { signals } from './helpers.js';

const honest = Array.from({ length: 12 }, (_, i) => signals([0.02 * (i % 4), 0.01 * (i % 3), 0, 0, 0, 0.05 * (i % 2)]));

test('k-means is deterministic: the same input always gives the same groups', () => {
   const population = [...honest, signals([1, 0.9, 1, 1, 1, 0.9]), signals([0.5, 0.4, 0.6, 0.5, 0.5, 0.4])];
   assert.deepEqual(performKMeansClustering(population, 3), performKMeansClustering(population, 3));
});

test('groups are named by how bad their centre is, not by rank: all-honest means no ABUSIVE group', () => {
   const result = performKMeansClustering(honest, 3);
   assert.ok(result.clusters.every(c => c.label === 'NORMAL_PATTERN'));
});

test('DBSCAN flags the merchant that behaves like no one else', () => {
   const population = [...honest, signals([1, 1, 1, 1, 1, 1])];
   const result = performDBSCANClustering(population, 0.3, 2);
   assert.deepEqual(result.outliers, [honest.length]);
   assert.equal(result.perMerchant[honest.length].anomaly_score, 1);
});
