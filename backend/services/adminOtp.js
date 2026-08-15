const crypto = require('crypto');
const db = require('../db');
const logger = require('./logger');

/**
 * One-time sign-in codes for administrators, delivered over WhatsApp.
 *
 * The administrator asks the bot for a code; the bot replies. The platform
 * never sends one unprompted, which keeps every message inside WhatsApp's
 * customer service window and out of the approved-template process.
 *
 * The code is a second factor, not a password replacement: signing in still
 * requires the phone number, the password *and* a live code. Holding the phone
 * without the password gets nothing, and the reverse is equally true.
 */

const CODE_TTL_MINUTES = parseInt(process.env.ADMIN_OTP_TTL_MINUTES, 10) || 10;
const MAX_ATTEMPTS = 5;
const MAX_PER_HOUR = parseInt(process.env.ADMIN_OTP_MAX_PER_HOUR, 10) || 10;

/** Enabled unless explicitly switched off, so the secure path is the default. */
function isEnabled() {
    return String(process.env.ADMIN_2FA_ENABLED ?? 'true').toLowerCase() !== 'false';
}

/**
 * Hashed with the same secret that signs sessions, so a leaked database alone
 * does not yield working codes.
 */
function hashCode(code) {
    const secret = process.env.SECRET || 'fixam-dev-secret';
    return crypto.createHmac('sha256', secret).update(String(code)).digest('hex');
}

function generateCode() {
    // randomInt is drawn from the CSPRNG; Math.random would be predictable
    // enough to be worth attacking.
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/**
 * Is this account allowed into the portal at all?
 *
 * Returns the user when they hold a portal role, otherwise null. Used to
 * decide whether a WhatsApp request for a code should be answered.
 */
async function findPortalUser(phoneNumber) {
    const result = await db.query(
        `SELECT u.id, u.name, u.phone_number, u.is_disabled,
                ARRAY_REMOVE(ARRAY_AGG(r.name), NULL) AS roles
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         LEFT JOIN roles r ON r.id = ur.role_id
         WHERE u.phone_number = $1
         GROUP BY u.id`,
        [phoneNumber]
    );
    if (result.rows.length === 0) return null;

    const user = result.rows[0];
    const portalRoles = (user.roles || []).filter((r) => r === 'Admin' || r === 'Operation');
    return portalRoles.length ? user : null;
}

/**
 * Issue a code for an administrator who has asked for one.
 *
 * Returns { ok: true, code, expiresInMinutes } or { ok: false, reason }.
 * The caller decides what to say; this decides what is allowed.
 */
async function issue(phoneNumber) {
    const user = await findPortalUser(phoneNumber);
    if (!user) return { ok: false, reason: 'not_portal_user' };
    if (user.is_disabled) return { ok: false, reason: 'disabled' };

    // Rate limit per account, so repeatedly asking cannot be used to flood an
    // administrator's phone with codes.
    //
    // Only codes that were never used to sign in count. A code that completed a
    // sign-in is evidence of legitimate use, and counting those meant an
    // administrator who signed in, signed out and signed in again exhausted
    // their own allowance -- then read a warning implying someone had stolen
    // their password. What this limit is actually for is a pile of codes
    // arriving that nobody asked for, and that is what it now measures.
    const recent = await db.query(
        `SELECT COUNT(*) AS count FROM admin_otp
         WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'
           AND NOT verified`,
        [user.id]
    );
    if (parseInt(recent.rows[0].count, 10) >= MAX_PER_HOUR) {
        return { ok: false, reason: 'rate_limited', user };
    }

    // A new code retires any earlier one, so a code from an old message cannot
    // still be used after a fresh one was requested.
    await db.query(
        `UPDATE admin_otp SET consumed_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND consumed_at IS NULL`,
        [user.id]
    );

    const code = generateCode();
    await db.query(
        `INSERT INTO admin_otp (user_id, code_hash, expires_at)
         VALUES ($1, $2, NOW() + ($3 || ' minutes')::INTERVAL)`,
        [user.id, hashCode(code), CODE_TTL_MINUTES]
    );

    logger.log('admin_otp', `Sign-in code issued for ${user.name} (${phoneNumber})`);
    return { ok: true, code, expiresInMinutes: CODE_TTL_MINUTES, user };
}

/**
 * Check a code supplied at sign-in and spend it.
 *
 * A code is valid once. Verifying it consumes it whether or not the rest of the
 * sign-in succeeds, so a code cannot be tried repeatedly against anything.
 */
async function verify(userId, code) {
    if (!code || !/^\d{4,8}$/.test(String(code).trim())) {
        return { ok: false, reason: 'malformed' };
    }

    const result = await db.query(
        `SELECT id, code_hash, expires_at, attempts
         FROM admin_otp
         WHERE user_id = $1 AND consumed_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [userId]
    );

    if (result.rows.length === 0) return { ok: false, reason: 'no_code' };

    const row = result.rows[0];
    if (new Date(row.expires_at) < new Date()) {
        await db.query('UPDATE admin_otp SET consumed_at = CURRENT_TIMESTAMP WHERE id = $1', [row.id]);
        return { ok: false, reason: 'expired' };
    }

    if (row.attempts >= MAX_ATTEMPTS) {
        await db.query('UPDATE admin_otp SET consumed_at = CURRENT_TIMESTAMP WHERE id = $1', [row.id]);
        return { ok: false, reason: 'too_many_attempts' };
    }

    const supplied = hashCode(String(code).trim());
    const expected = row.code_hash;

    // Constant-time comparison: a byte-by-byte check leaks how much of the code
    // was right through how long the comparison took.
    const matches = supplied.length === expected.length
        && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));

    if (!matches) {
        await db.query('UPDATE admin_otp SET attempts = attempts + 1 WHERE id = $1', [row.id]);
        return { ok: false, reason: 'incorrect', attemptsLeft: MAX_ATTEMPTS - (row.attempts + 1) };
    }

    // `verified` marks a code that actually completed a sign-in, as distinct
    // from one retired because a newer code was requested.
    await db.query(
        'UPDATE admin_otp SET consumed_at = CURRENT_TIMESTAMP, verified = TRUE WHERE id = $1',
        [row.id]
    );
    return { ok: true };
}

module.exports = { isEnabled, issue, verify, findPortalUser, CODE_TTL_MINUTES, MAX_PER_HOUR };
