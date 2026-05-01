// Fixam Authentication Service Tests
const authService = require('../services/authService');

describe('AuthService — Password Hashing (DPG: bcrypt)', () => {
    const phone = '23276123456';
    const password = 'TestPass123!';

    test('hashPassword returns a bcrypt hash (starts with $2b$)', async () => {
        const hash = await authService.hashPassword(password);
        expect(hash).toBeDefined();
        expect(hash).not.toBeNull();
        expect(hash.startsWith('$2b$')).toBe(true);
    });

    test('hashPassword does NOT use phone as salt', async () => {
        const hash1 = await authService.hashPassword(password);
        const hash2 = await authService.hashPassword(password);
        // bcrypt generates unique salt each time — hashes should differ
        expect(hash1).not.toBe(hash2);
    });

    test('hashPassword returns null for empty password', async () => {
        const hash = await authService.hashPassword('');
        expect(hash).toBeNull();
    });

    test('hashPassword returns null for null/undefined password', async () => {
        const hash = await authService.hashPassword(null);
        expect(hash).toBeNull();
    });

    test('verifyPassword returns true for matching password', async () => {
        const hash = await authService.hashPassword(password);
        const result = await authService.verifyPassword(password, hash);
        expect(result).toBe(true);
    });

    test('verifyPassword returns false for wrong password', async () => {
        const hash = await authService.hashPassword(password);
        const result = await authService.verifyPassword('WrongPassword', hash);
        expect(result).toBe(false);
    });

    test('verifyPassword returns false for null inputs', async () => {
        const result = await authService.verifyPassword(null, null);
        expect(result).toBe(false);
    });

    test('verifyPassword returns false for empty inputs', async () => {
        const result = await authService.verifyPassword('', '');
        expect(result).toBe(false);
    });

    // Legacy SHA-512 migration tests
    test('verifyLegacyPassword matches SHA-512(phone + password)', () => {
        const crypto = require('crypto');
        const legacyHash = crypto.createHash('sha512').update(password + phone).digest('hex');
        const result = authService.verifyLegacyPassword(password, phone, legacyHash);
        expect(result).toBe(true);
    });

    test('verifyLegacyPassword rejects wrong password', () => {
        const crypto = require('crypto');
        const legacyHash = crypto.createHash('sha512').update(password + phone).digest('hex');
        const result = authService.verifyLegacyPassword('wrong', phone, legacyHash);
        expect(result).toBe(false);
    });

    test('verifyLegacyPassword returns false for null inputs', () => {
        expect(authService.verifyLegacyPassword(null, null, null)).toBe(false);
    });

    // bcrypt should NOT be verifiable by legacy method (good — they are different)
    test('verifyLegacyPassword does NOT match bcrypt hashes', async () => {
        const hash = await authService.hashPassword(password);
        const result = authService.verifyLegacyPassword(password, phone, hash);
        expect(result).toBe(false);
    });
});
