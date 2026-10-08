import { test } from 'node:test';
import assert from 'node:assert/strict';
import requireApiKey from '../src/middleware/requireApiKey.js';

function call(headerValue, configuredKey) {
   const saved = process.env.ADMIN_API_KEY;
   if (configuredKey === undefined) delete process.env.ADMIN_API_KEY;
   else process.env.ADMIN_API_KEY = configuredKey;
   const req = { get: (name) => (name.toLowerCase() === 'x-api-key' ? headerValue : undefined) };
   const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
   let passed = false;
   requireApiKey(req, res, () => { passed = true; });
   if (saved === undefined) delete process.env.ADMIN_API_KEY; else process.env.ADMIN_API_KEY = saved;
   return { status: res.statusCode, passed };
}

test('no key configured: admin routes are switched off, not left open', () => {
   assert.deepEqual(call('anything', undefined), { status: 503, passed: false });
});

test('missing or wrong key: 401', () => {
   assert.deepEqual(call(undefined, 'secret-key'), { status: 401, passed: false });
   assert.deepEqual(call('wrong-key!', 'secret-key'), { status: 401, passed: false });
});

test('right key: the request goes through', () => {
   assert.deepEqual(call('secret-key', 'secret-key'), { status: 200, passed: true });
});
