import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGuarded } from '../src/services/cronScheduler.js';

const noRedis = { isReady: false };

test('runs the job when nothing else is running', async () => {
   assert.equal(await runGuarded(async () => 'done', noRedis), 'done');
});

test('a second run on the same server is skipped while the first is still going', async () => {
   let finish;
   const slow = runGuarded(() => new Promise(resolve => { finish = resolve; }), noRedis);
   const second = await runGuarded(async () => 'should not run', noRedis);
   assert.match(second.skipped, /already in progress/);
   finish('first done');
   assert.equal(await slow, 'first done');
});

test('skipped when another server holds the Redis lock', async () => {
   const lockedElsewhere = { isReady: true, set: async () => null, eval: async () => 0 };
   const result = await runGuarded(async () => 'should not run', lockedElsewhere);
   assert.match(result.skipped, /another server/);
});

test('takes the lock, runs, and releases only its own lock', async () => {
   let released = null;
   let taken = null;
   const free = {
      isReady: true,
      set: async (key, token, options) => { taken = { key, token, options }; return 'OK'; },
      eval: async (script, { keys, arguments: args }) => { released = { key: keys[0], token: args[0] }; return 1; }
   };
   assert.equal(await runGuarded(async () => 'done', free), 'done');
   assert.equal(taken.options.NX, true);
   assert.deepEqual(released, { key: taken.key, token: taken.token });
});
