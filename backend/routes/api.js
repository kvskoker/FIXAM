const express = require('express');
const router = express.Router();
const db = require('../db');

const whatsappService = require('../services/whatsappService');
const FixamHandler = require('../services/whatsappHandler');

// Initialize Handler
const fixamHandler = new FixamHandler(whatsappService, db, null, console.log);

// User session store to track conversation state (still in-memory for now)
// User session store to track conversation state (still in-memory for now)
const userSessions = {}; 

// Helper to generate 10-char alphanumeric ticket ID
function generateTicketId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 10; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
} 

// GET /api/issues - Fetch all issues from DB with vote counts, search, filter, and sort
router.get('/issues', async (req, res) => {
    try {
        const { search, category, status, sort, ticket } = req.query;

        let query = `
            SELECT 
                i.*,
                i.*,
                u.name as reported_by_name,
                COALESCE(v.upvotes, 0) as upvotes,
                COALESCE(v.downvotes, 0) as downvotes,
                COALESCE(v.net_votes, 0) as votes
            FROM issues i
            LEFT JOIN users u ON i.reported_by = u.id
            LEFT JOIN (
                SELECT 
                    issue_id,
                    SUM(CASE WHEN vote_type = 'upvote' THEN 1 ELSE 0 END) as upvotes,
                    SUM(CASE WHEN vote_type = 'downvote' THEN 1 ELSE 0 END) as downvotes,
                    SUM(CASE WHEN vote_type = 'upvote' THEN 1 WHEN vote_type = 'downvote' THEN -1 ELSE 0 END) as net_votes
                FROM votes
                GROUP BY issue_id
            ) v ON i.id = v.issue_id
            WHERE 1=1
        `;

        const params = [];
        let paramCount = 1;

        if (search) {
            query += ` AND (i.title ILIKE $${paramCount} OR i.description ILIKE $${paramCount})`;
            params.push(`%${search}%`);
            paramCount++;
        }

        if (category) {
            query += ` AND i.category = $${paramCount}`;
            params.push(category);
            paramCount++;
        }

        if (status) {
            query += ` AND i.status = $${paramCount}`;
            params.push(status);
            paramCount++;
        }

        if (ticket) {
            query += ` AND i.ticket_id = $${paramCount}`;
            params.push(ticket);
            paramCount++;
        }

        // Sorting
        if (sort === 'oldest') {
            query += ` ORDER BY i.created_at ASC`;
        } else if (sort === 'most_votes') {
            query += ` ORDER BY votes DESC, i.created_at DESC`;
        } else {
            // Default: newest
            query += ` ORDER BY i.created_at DESC`;
        }

        const result = await db.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST /api/issues/:id/vote - Vote on an issue
router.post('/issues/:id/vote', async (req, res) => {
    try {
        const { id } = req.params;
        const { user_phone, vote_type } = req.body; // vote_type: 'upvote' or 'downvote'

        if (!user_phone || !vote_type || !['upvote', 'downvote'].includes(vote_type)) {
            return res.status(400).json({ error: 'Invalid request. Provide user_phone and vote_type (upvote/downvote)' });
        }

        // Find or create user
        let userResult = await db.query('SELECT id FROM users WHERE phone_number = $1', [user_phone]);
        let userId;

        if (userResult.rows.length === 0) {
            const insertUser = await db.query(
                'INSERT INTO users (phone_number) VALUES ($1) RETURNING id',
                [user_phone]
            );
            userId = insertUser.rows[0].id;
        } else {
            userId = userResult.rows[0].id;
        }

        // Insert or update vote (using UPSERT)
        await db.query(`
            INSERT INTO votes (issue_id, user_id, vote_type)
            VALUES ($1, $2, $3)
            ON CONFLICT (issue_id, user_id)
            DO UPDATE SET vote_type = $3, created_at = CURRENT_TIMESTAMP
        `, [id, userId, vote_type]);

        res.json({ success: true, message: `${vote_type} recorded` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/issues/:id/tracker - Get issue tracker logs
router.get('/issues/:id/tracker', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db.query(`
            SELECT 
                it.*,
                u.name as performed_by_name,
                u.phone_number as performed_by_phone
            FROM issue_tracker it
            LEFT JOIN users u ON it.performed_by = u.id
            WHERE it.issue_id = $1
            ORDER BY it.created_at ASC
        `, [id]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/categories - Fetch all categories
router.get('/categories', async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM categories ORDER BY name ASC');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/stats - Fetch dashboard statistics
router.get('/stats', async (req, res) => {
    try {
        // 1. Total Reports (This Week)
        const totalReportsResult = await db.query(`
            SELECT COUNT(*) as count 
            FROM issues 
            WHERE created_at >= date_trunc('week', CURRENT_DATE)
        `);
        const totalReports = parseInt(totalReportsResult.rows[0].count);

        // 2. Total Reports (Last Week) - for comparison
        const lastWeekReportsResult = await db.query(`
            SELECT COUNT(*) as count 
            FROM issues 
            WHERE created_at >= date_trunc('week', CURRENT_DATE - INTERVAL '1 week')
            AND created_at < date_trunc('week', CURRENT_DATE)
        `);
        const lastWeekReports = parseInt(lastWeekReportsResult.rows[0].count);
        
        // Calculate percentage change
        let percentageChange = 0;
        if (lastWeekReports > 0) {
            percentageChange = Math.round(((totalReports - lastWeekReports) / lastWeekReports) * 100);
        } else if (totalReports > 0) {
            percentageChange = 100; // If last week was 0 and this week is > 0
        }

        // 3. Resolved Issues
        const resolvedResult = await db.query(`
            SELECT COUNT(*) as count FROM issues WHERE status = 'fixed'
        `);
        const resolvedCount = parseInt(resolvedResult.rows[0].count);

        // 4. Total Issues (All time) for resolution rate
        const allTimeResult = await db.query('SELECT COUNT(*) as count FROM issues');
        const allTimeCount = parseInt(allTimeResult.rows[0].count);
        const resolutionRate = allTimeCount > 0 ? Math.round((resolvedCount / allTimeCount) * 100) : 0;

        // 5. Critical Pending
        const criticalPendingResult = await db.query(`
            SELECT COUNT(*) as count FROM issues WHERE status = 'critical'
        `);
        const criticalPendingCount = parseInt(criticalPendingResult.rows[0].count);

        res.json({
            total_reports_week: totalReports,
            reports_change_pct: percentageChange,
            resolved_issues: resolvedCount,
            resolution_rate: resolutionRate,
            critical_pending: criticalPendingCount
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST /api/webhook - WhatsApp Webhook Verification
router.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// POST /api/webhook - Handle Incoming Messages
router.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object) {
        try {
            await fixamHandler.processIncomingMessage(body);
        } catch (err) {
            console.error("Error processing message:", err);
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

module.exports = router;
