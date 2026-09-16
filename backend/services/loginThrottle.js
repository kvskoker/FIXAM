const db = require('../db');

/**
 * Attempt throttling for /admin/login.
 *
 * A failed attempt (wrong password or wrong OTP) is recorded per phone number.
 * The wait before the next attempt doubles with each recent failure, and the
 * account locks itself out once five land inside a minute -- backoff slows a
 * script down, the lock stops it.
 */

const WINDOW_SECONDS = 60;
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

function backoffSeconds(failures) {
    return failures === 0 ? 0 : Math.min(2 ** failures, 60);
}

async function recentFailures(phoneNumber) {
    const result = await db.query(
        `SELECT COUNT(*)::int AS count, MAX(created_at) AS last_at
         FROM login_failures
         WHERE phone_number = $1 AND created_at > NOW() - ($2 || ' seconds')::INTERVAL`,
        [phoneNumber, WINDOW_SECONDS]
    );
    return result.rows[0];
}

/** Is this account allowed to attempt a sign-in right now? */
async function check(phoneNumber) {
    const userResult = await db.query('SELECT locked_until FROM users WHERE phone_number = $1', [phoneNumber]);
    const lockedUntil = userResult.rows[0] && userResult.rows[0].locked_until;
    if (lockedUntil && new Date(lockedUntil) > new Date()) {
        return {
            allowed: false,
            reason: 'locked',
            retryAfterSeconds: Math.ceil((new Date(lockedUntil) - new Date()) / 1000),
        };
    }

    const { count, last_at } = await recentFailures(phoneNumber);
    if (count === 0) return { allowed: true };

    const wait = backoffSeconds(count);
    const elapsed = (Date.now() - new Date(last_at).getTime()) / 1000;
    if (elapsed < wait) {
        return { allowed: false, reason: 'backoff', retryAfterSeconds: Math.ceil(wait - elapsed) };
    }
    return { allowed: true };
}

/**
 * Record a failed attempt. Locks the account once MAX_FAILURES lands inside
 * WINDOW_SECONDS and returns { locked: true } so the caller can alert the
 * account holder -- once, on the attempt that tripped the lock, not on every
 * attempt made against an account that is already locked.
 */
async function recordFailure(phoneNumber, ip) {
    await db.query('INSERT INTO login_failures (phone_number, ip_address) VALUES ($1, $2)', [phoneNumber, ip]);

    const { count } = await recentFailures(phoneNumber);
    if (count >= MAX_FAILURES) {
        await db.query(
            `UPDATE users SET locked_until = NOW() + ($1 || ' minutes')::INTERVAL WHERE phone_number = $2`,
            [LOCK_MINUTES, phoneNumber]
        );
        return { locked: true };
    }
    return { locked: false, failures: count };
}

/** Wipe the slate on a successful sign-in. */
async function clear(phoneNumber) {
    await db.query('DELETE FROM login_failures WHERE phone_number = $1', [phoneNumber]);
    await db.query('UPDATE users SET locked_until = NULL WHERE phone_number = $1', [phoneNumber]);
}

module.exports = { check, recordFailure, clear, MAX_FAILURES, WINDOW_SECONDS, LOCK_MINUTES };
