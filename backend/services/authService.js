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

module.exports = {
    hashPassword,
    verifyPassword,
    verifyLegacyPassword
};
