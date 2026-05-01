// Fixam Database Service Tests — DPG Compliance
// Tests for consent, data export, data deletion, and registration

const FixamDatabase = require('../services/fixamDatabase');

// Mock the db pool
const mockDb = {
    query: jest.fn(),
    connect: jest.fn(),
};

describe('FixamDatabase — DPG Compliance Features', () => {
    let fixamDb;

    beforeEach(() => {
        jest.clearAllMocks();
        fixamDb = new FixamDatabase(mockDb, jest.fn());
    });

    describe('Consent Management', () => {
        test('setPendingConsent stores a pending user without registering', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [] });
            const result = await fixamDb.setPendingConsent('23276123456', 'John Doe', 'Hi');
            expect(result).toBe(true);
            expect(mockDb.query).toHaveBeenCalledWith(
                expect.stringContaining('pending_consent'),
                ['23276123456', 'John Doe', 'Hi']
            );
        });

        test('getPendingConsent retrieves a pending user', async () => {
            mockDb.query.mockResolvedValueOnce({
                rows: [{ phone_number: '23276123456', name: 'John', first_message: 'Hi' }],
            });
            const result = await fixamDb.getPendingConsent('23276123456');
            expect(result).not.toBeNull();
            expect(result.phone_number).toBe('23276123456');
            expect(result.name).toBe('John');
        });

        test('getPendingConsent returns null for unknown number', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [] });
            const result = await fixamDb.getPendingConsent('99999999');
            expect(result).toBeNull();
        });

        test('clearPendingConsent removes a pending user', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [] });
            const result = await fixamDb.clearPendingConsent('23276123456');
            expect(result).toBe(true);
        });

        test('registerUser sets consent_given = TRUE', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
            const userId = await fixamDb.registerUser('23276123456', 'Jane Doe');
            expect(userId).toBe(1);
            expect(mockDb.query).toHaveBeenCalledWith(
                expect.stringContaining('consent_given'),
                ['23276123456', 'Jane Doe']
            );
        });
    });

    describe('Data Export (Data Portability)', () => {
        test('getUserData returns structured JSON with all user data', async () => {
            mockDb.query
                .mockResolvedValueOnce({ rows: [{ id: 1, phone_number: '23276123456', name: 'John' }] })  // user
                .mockResolvedValueOnce({ rows: [{ ticket_id: 'FIX-ABC123', title: 'Pothole' }] })           // issues
                .mockResolvedValueOnce({ rows: [{ ticket_id: 'FIX-ABC123', vote_type: 'upvote' }] })        // votes
                .mockResolvedValueOnce({ rows: [{ amount: 10, action_type: 'report_created' }] })           // points
                .mockResolvedValueOnce({ rows: [] }); // messages

            const data = await fixamDb.getUserData('23276123456');
            expect(data).toHaveProperty('profile');
            expect(data).toHaveProperty('issues_reported');
            expect(data).toHaveProperty('votes_cast');
            expect(data).toHaveProperty('points_history');
            expect(data).toHaveProperty('recent_messages');
            expect(data).toHaveProperty('exported_at');
            expect(data.profile.name).toBe('John');
        });

        test('getUserData returns null for unknown user', async () => {
            mockDb.query
                .mockResolvedValueOnce({ rows: [] })  // user not found
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] });

            const data = await fixamDb.getUserData('99999999');
            expect(data.profile).toBeNull();
        });
    });

    describe('Data Deletion (Right to Erasure)', () => {
        test('deleteUser removes ALL user data in transaction', async () => {
            const mockClient = {
                query: jest.fn().mockResolvedValue({ rows: [{ id: 1 }] }),
                release: jest.fn(),
            };
            mockDb.connect.mockResolvedValueOnce(mockClient);

            const result = await fixamDb.deleteUser('23276123456');
            expect(result).toBe(true);
            expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
            expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
            // Verify deletions cascade through all tables
            expect(mockClient.query).toHaveBeenCalledWith(
                expect.stringContaining('DELETE FROM endorsements'),
                expect.anything()
            );
            expect(mockClient.query).toHaveBeenCalledWith(
                expect.stringContaining('DELETE FROM votes'),
                expect.anything()
            );
            expect(mockClient.query).toHaveBeenCalledWith(
                expect.stringContaining('DELETE FROM message_logs'),
                expect.anything()
            );
            expect(mockClient.query).toHaveBeenCalledWith(
                expect.stringContaining('DELETE FROM users'),
                expect.anything()
            );
            mockClient.release();
        });

        test('deleteUser returns false for unknown user', async () => {
            const mockClient = {
                query: jest.fn()
                    .mockResolvedValueOnce({ rows: [] }), // User not found
                release: jest.fn(),
            };
            mockDb.connect.mockResolvedValueOnce(mockClient);

            const result = await fixamDb.deleteUser('99999999');
            expect(result).toBe(false);
            mockClient.release();
        });

        test('deleteUser anonymizes issues instead of deleting them', async () => {
            const mockClient = {
                query: jest.fn()
                    .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // User found
                    .mockResolvedValue({ rows: [] }),
                release: jest.fn(),
            };
            mockDb.connect.mockResolvedValueOnce(mockClient);

            await fixamDb.deleteUser('23276123456');
            expect(mockClient.query).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE issues SET reported_by = NULL'),
                expect.anything()
            );
            mockClient.release();
        });
    });

    describe('Error Handling', () => {
        test('getUserData handles database errors gracefully', async () => {
            mockDb.query.mockRejectedValueOnce(new Error('Connection refused'));
            const data = await fixamDb.getUserData('23276123456');
            expect(data).toBeNull();
        });
    });
});
