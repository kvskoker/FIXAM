const crypto = require('crypto');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 12;

/**
 * Hash a password using bcrypt (DPG Fix: replaces SHA-512 + phone salt).
 * bcrypt generates its own salt internally — no need to pass phone number.
 * @param {string} password - The plain text password
 * @returns {Promise<string>} - The bcrypt hash
 */
async function hashPassword(password) {
    if (!password) return null;
    return await bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a password against a stored bcrypt hash.
 * @param {string} password - The plain text password
 * @param {string} storedHash - The bcrypt hash stored in the database
 * @returns {Promise<boolean>} - True if match
 */
async function verifyPassword(password, storedHash) {
    if (!password || !storedHash) return false;
    try {
        return await bcrypt.compare(password, storedHash);
    } catch (err) {
        // Legacy SHA-512 hashes are not valid bcrypt input. Treat a malformed
        // hash as "no match" so the caller can fall back to
        // verifyLegacyPassword() rather than the request erroring out.
        return false;
    }
}

/**
 * Migration helper: verify a password against the OLD SHA-512 scheme.
 * Use this during login to transparently upgrade legacy users:
 *   1. Try verifyPassword() first (bcrypt)
 *   2. If it fails, try verifyLegacyPassword()
 *   3. If legacy passes, rehash with hashPassword() and update DB
 * @param {string} password - Plain text password
 * @param {string} phone - Phone number (was used as salt)
 * @param {string} storedHash - The legacy SHA-512 hash from DB
 * @returns {boolean}
 */
function verifyLegacyPassword(password, phone, storedHash) {
    if (!password || !phone || !storedHash) return false;
    const legacyHash = crypto.createHash('sha512').update(password + phone).digest('hex');
    return legacyHash === storedHash;
}

// ── Session tokens ───────────────────────────────────────────────────────────
//
// Signed with HMAC-SHA256 rather than pulling in a JWT library: the payload is
// three fields and the verification is a constant-time compare, so a dependency
// would add supply-chain surface for no benefit.

const TOKEN_TTL_HOURS = Number(process.env.ADMIN_SESSION_HOURS) || 12;

/**
 * The signing key. A stable SECRET keeps sessions valid across restarts; without
 * one a random key is generated per boot, which is safe but logs every admin out
 * on every deploy -- so say so loudly rather than let it be a mystery.
 */
const TOKEN_SECRET = (() => {
    const configured = process.env.SECRET && process.env.SECRET.trim();
    if (configured) return configured;

    console.warn(
        '[auth] SECRET is not set. Generating a random signing key for this process: '
        + 'admin sessions will not survive a restart. Set SECRET in .env.'
    );
    return crypto.randomBytes(32).toString('hex');
})();

function base64url(buffer) {
    return Buffer.from(buffer).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payloadB64) {
    return base64url(crypto.createHmac('sha256', TOKEN_SECRET).update(payloadB64).digest());
}

/** Issue a session token for an authenticated admin. */
function createToken(user) {
    const payload = {
        uid: user.id,
        phone: user.phone_number,
        roles: user.roles || [],
        exp: Date.now() + TOKEN_TTL_HOURS * 3600 * 1000,
    };
    const payloadB64 = base64url(JSON.stringify(payload));
    return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Verify a token and return its payload, or null.
 *
 * Returns null for every failure mode -- malformed, bad signature, expired --
 * so a caller cannot accidentally treat "expired" as "valid but stale".
 */
function verifyToken(token) {
    if (!token || typeof token !== 'string') return null;

    const parts = token.split('.');
    if (parts.length !== 2) return null;

    const [payloadB64, signature] = parts;
    const expected = sign(payloadB64);

    // Constant-time compare; lengths must match first or timingSafeEqual throws.
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    try {
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
        if (!payload.exp || Date.now() > payload.exp) return null;
        return payload;
    } catch (err) {
        return null;
    }
}

module.exports = {
    hashPassword,
    verifyPassword,
    verifyLegacyPassword,
    createToken,
    verifyToken,
    TOKEN_TTL_HOURS
};
