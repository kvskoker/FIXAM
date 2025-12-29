const crypto = require('crypto');

/**
 * Hash a password using SHA-512 with the phone number as salt.
 * @param {string} password - The plain text password
 * @param {string} phone - The user's phone number (used as salt)
 * @returns {string} - The hex-encoded hash
 */
function hashPassword(password, phone) {
    if (!password || !phone) return null;
    return crypto.createHash('sha512').update(password + phone).digest('hex');
}

/**
 * Verify a password against a stored hash.
 * @param {string} password - The plain text password
 * @param {string} phone - The user's phone number
 * @param {string} storedHash - The hash stored in the database
 * @returns {boolean} - True if match
 */
function verifyPassword(password, phone, storedHash) {
    const hash = hashPassword(password, phone);
    return hash === storedHash;
}

module.exports = {
    hashPassword,
    verifyPassword
};
