jest.mock('../db', () => ({ query: jest.fn() }));

const db = require('../db');
const loginThrottle = require('../services/loginThrottle');

describe('loginThrottle', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('check', () => {
        test('allows a phone with no user row and no recent failures', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [] }) // no user
                .mockResolvedValueOnce({ rows: [{ count: 0, last_at: null }] });

            const result = await loginThrottle.check('23276000000');
            expect(result.allowed).toBe(true);
        });

        test('refuses while locked_until is in the future', async () => {
            const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
            db.query.mockResolvedValueOnce({ rows: [{ locked_until: future }] });

            const result = await loginThrottle.check('23276000000');
            expect(result.allowed).toBe(false);
            expect(result.reason).toBe('locked');
            expect(result.retryAfterSeconds).toBeGreaterThan(0);
        });

        test('allows once locked_until has passed', async () => {
            const past = new Date(Date.now() - 1000).toISOString();
            db.query
                .mockResolvedValueOnce({ rows: [{ locked_until: past }] })
                .mockResolvedValueOnce({ rows: [{ count: 0, last_at: null }] });

            const result = await loginThrottle.check('23276000000');
            expect(result.allowed).toBe(true);
        });

        test('backs off while the wait after a recent failure has not elapsed', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [{ locked_until: null }] })
                .mockResolvedValueOnce({ rows: [{ count: 2, last_at: new Date().toISOString() }] });

            const result = await loginThrottle.check('23276000000');
            expect(result.allowed).toBe(false);
            expect(result.reason).toBe('backoff');
        });
    });

    describe('recordFailure', () => {
        test('locks the account once failures reach MAX_FAILURES', async () => {
            db.query
                .mockResolvedValueOnce({}) // insert
                .mockResolvedValueOnce({ rows: [{ count: loginThrottle.MAX_FAILURES }] })
                .mockResolvedValueOnce({}); // lock update

            const result = await loginThrottle.recordFailure('23276000000', '127.0.0.1');
            expect(result.locked).toBe(true);
            expect(db.query).toHaveBeenLastCalledWith(
                expect.stringContaining('locked_until'),
                [loginThrottle.LOCK_MINUTES, '23276000000']
            );
        });

        test('does not lock below MAX_FAILURES', async () => {
            db.query
                .mockResolvedValueOnce({})
                .mockResolvedValueOnce({ rows: [{ count: 2 }] });

            const result = await loginThrottle.recordFailure('23276000000', '127.0.0.1');
            expect(result.locked).toBe(false);
            expect(result.failures).toBe(2);
        });
    });

    test('clear removes failures and unlocks the account', async () => {
        db.query.mockResolvedValue({});
        await loginThrottle.clear('23276000000');
        expect(db.query).toHaveBeenCalledWith('DELETE FROM login_failures WHERE phone_number = $1', ['23276000000']);
        expect(db.query).toHaveBeenCalledWith('UPDATE users SET locked_until = NULL WHERE phone_number = $1', ['23276000000']);
    });
});
