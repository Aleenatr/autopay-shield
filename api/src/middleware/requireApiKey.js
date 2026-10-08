import { timingSafeEqual } from 'crypto';

/**
 * Admin routes need an API key, sent as the `x-api-key` header.
 *
 * Before this, anyone who could reach the API could DELETE any merchant: the
 * admin/public split was a split in data shape, not a security boundary.
 *
 * - The key lives in the ADMIN_API_KEY environment variable, never in code.
 * - If ADMIN_API_KEY is not set, admin routes are switched OFF (503) rather
 *   than left open. A missing setting should fail closed, not open.
 * - The comparison is constant-time (timingSafeEqual). A normal `===` stops at
 *   the first wrong character, so response timing could leak the key one
 *   character at a time.
 */
export default function requireApiKey(req, res, next) {
   const expected = process.env.ADMIN_API_KEY;
   if (!expected) {
      return res.status(503).json({ success: false, message: 'Admin API disabled: set ADMIN_API_KEY to enable it' });
   }
   const given = req.get('x-api-key') || '';
   const a = Buffer.from(given);
   const b = Buffer.from(expected);
   if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return res.status(401).json({ success: false, message: 'Missing or invalid x-api-key header' });
   }
   next();
}
