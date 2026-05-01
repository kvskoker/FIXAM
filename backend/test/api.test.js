// Fixam API Route Tests — DPG Compliance
// Tests for data export, data deletion, and configuration endpoints

const request = require('supertest');
const express = require('express');

// We mock dependencies before requiring the router
jest.mock('../db', () => ({
    query: jest.fn(),
    connect: jest.fn(),
}));

jest.mock('../services/authService', () => ({
    hashPassword: jest.fn(),
    verifyPassword: jest.fn(),
    verifyLegacyPassword: jest.fn(),
}));

jest.mock('../services/whatsappService', () => ({
    sendMessage: jest.fn().mockResolvedValue(true),
}));

jest.mock('../services/whatsappHandler', () => {
    return jest.fn().mockImplementation(() => ({
        processIncomingMessage: jest.fn().mockResolvedValue(true),
        fixamDb: {
            getUserData: jest.fn(),
            deleteUser: jest.fn(),
            getFeedback: jest.fn(),
            acknowledgeFeedback: jest.fn(),
        },
    }));
});

// We also need to mock FixamDatabase for server.js data routes
jest.mock('../services/fixamDatabase', () => {
    return jest.fn().mockImplementation(() => ({
        getUserData: jest.fn(),
        deleteUser: jest.fn(),
    }));
});

const db = require('../db');
const FixamDatabase = require('../services/fixamDatabase');

describe('API Routes — DPG Compliance', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.DEV_MODE = 'false';
        process.env.NODE_ENV = 'test';
        process.env.ALLOWED_ORIGINS = 'http://localhost:3000';

        // Set up the app fresh each test
        delete require.cache[require.resolve('../server')];
        app = require('../server');
    });

    describe('GET /api/config', () => {
        test('returns dev_mode and maintenance_message', async () => {
            const res = await request(app).get('/api/config');
            expect(res.status).toBe(200);
            expect(res.body).toHaveProperty('dev_mode');
            expect(res.body).toHaveProperty('maintenance_message');
        });
    });

    describe('GET /api/user/data — Data Export', () => {
        test('returns 400 when phone_number is missing', async () => {
            const res = await request(app).get('/api/user/data');
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('phone_number is required');
        });

        test('returns user data JSON with attachment header', async () => {
            const mockData = {
                profile: { id: 1, phone_number: '23276123456', name: 'John' },
                issues_reported: [],
                votes_cast: [],
                points_history: [],
                recent_messages: [],
                exported_at: '2026-01-01T00:00:00.000Z',
            };

            const fixamDbInstance = new FixamDatabase();
            fixamDbInstance.getUserData.mockResolvedValue(mockData);

            const res = await request(app)
                .get('/api/user/data')
                .query({ phone_number: '23276123456' });

            expect(res.status).toBe(200);
            expect(res.headers['content-disposition']).toBe(
                'attachment; filename="my-fixam-data.json"'
            );
            expect(res.body.profile.name).toBe('John');
        });

        test('returns 404 for unknown user', async () => {
            const fixamDbInstance = new FixamDatabase();
            fixamDbInstance.getUserData.mockResolvedValue({ profile: null });

            const res = await request(app)
                .get('/api/user/data')
                .query({ phone_number: '99999999' });

            expect(res.status).toBe(404);
        });
    });

    describe('DELETE /api/user/data — Data Deletion', () => {
        test('returns 400 when phone_number is missing', async () => {
            const res = await request(app).delete('/api/user/data');
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('phone_number is required');
        });

        test('deletes user data when user found', async () => {
            const fixamDbInstance = new FixamDatabase();
            fixamDbInstance.deleteUser.mockResolvedValue(true);

            const res = await request(app)
                .delete('/api/user/data')
                .send({ phone_number: '23276123456' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.message).toContain('permanently deleted');
        });

        test('returns 404 when user not found', async () => {
            const fixamDbInstance = new FixamDatabase();
            fixamDbInstance.deleteUser.mockResolvedValue(false);

            const res = await request(app)
                .delete('/api/user/data')
                .send({ phone_number: '99999999' });

            expect(res.status).toBe(404);
        });
    });

    describe('GET /api/issues — Public Issue Data', () => {
        test('returns paginated issue data', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [{ id: 1, title: 'Test Issue' }] })
                .mockResolvedValueOnce({ rows: [{ total: '1' }] });

            const res = await request(app).get('/api/issues');
            expect(res.status).toBe(200);
            expect(res.body).toHaveProperty('data');
            expect(res.body).toHaveProperty('pagination');
            expect(res.body.pagination).toHaveProperty('current_page');
            expect(res.body.pagination).toHaveProperty('total_items');
        });
    });

    describe('GET / — Root', () => {
        test('returns running message', async () => {
            const res = await request(app).get('/');
            expect(res.status).toBe(200);
            expect(res.text).toBe('FIXAM Backend is running.');
        });
    });
});
