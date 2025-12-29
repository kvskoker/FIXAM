const express = require('express');
const router = express.Router();
const db = require('../db');
const authService = require('../services/authService');


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
        const { search, category, status, sort, ticket, page = 1, limit = 1000 } = req.query;
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const offset = (pageNum - 1) * limitNum;

        let query = `
            SELECT 
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
            query += ` AND (i.title ILIKE $${paramCount} OR i.description ILIKE $${paramCount} OR i.ticket_id ILIKE $${paramCount})`;
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

        if (req.query.start_date) {
            console.log('Applying start_date filter:', req.query.start_date);
            query += ` AND i.created_at >= $${paramCount}`;
            params.push(req.query.start_date);
            paramCount++;
        }

        if (req.query.end_date) {
            console.log('Applying end_date filter:', req.query.end_date);
            query += ` AND i.created_at <= $${paramCount}`;
            params.push(`${req.query.end_date} 23:59:59`);
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

        // 1. Get filtered count
        let countQuery = `SELECT COUNT(*) FROM issues i WHERE 1=1`;
        const countParams = [];
        let countParamCount = 1;

        // Re-apply filters for count query (simplified for brevity, ideally share logic)
        // ... (We need to replicate the filter logic here or structure it better)
        // A better approach: Use CTE or window function count(*) OVER()
        
        // Let's rewrite the main query to include count within the same result set if possible, 
        // OR just run two queries. For simplicity and correctness with the existing structure, let's just create a base WHERE clause builder.

        // Actually, let's keep the existing query building and add pagination at the end.
        // We will run a separate count query with the same WHERE clause components.

        // ... Wait, to avoid code duplication, let's just modify the main Query to return total count using Window Function
        // BUT `issues_with_votes` logic makes it complex.
        
        // Let's stick to the prompt's request for pagination.
        
        query += ` LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
        params.push(limitNum, offset);

        const result = await db.query(query, params);
        
        // Get total count for pagination metadata (Approximation for simplicity: if we fetched < limit, we know we are at end. 
        // But to generic "Page 1 of X", we need total.
        // Let's run a separate cleaner count query for now.
        
        let countSql = `SELECT COUNT(*) as total FROM issues i WHERE 1=1`;
        const countSqlParams = [];
        let pCount = 1;
        
        if (search) { countSql += ` AND (i.title ILIKE $${pCount} OR i.description ILIKE $${pCount})`; countSqlParams.push(`%${search}%`); pCount++; }
        if (category) { countSql += ` AND i.category = $${pCount}`; countSqlParams.push(category); pCount++; }
        if (status) { countSql += ` AND i.status = $${pCount}`; countSqlParams.push(status); pCount++; }
        if (ticket) { countSql += ` AND i.ticket_id = $${pCount}`; countSqlParams.push(ticket); pCount++; }
        if (req.query.start_date) { countSql += ` AND i.created_at >= $${pCount}`; countSqlParams.push(req.query.start_date); pCount++; }
        if (req.query.end_date) { countSql += ` AND i.created_at <= $${pCount}`; countSqlParams.push(`${req.query.end_date} 23:59:59`); pCount++; }

        const countResult = await db.query(countSql, countSqlParams);
        const totalItems = parseInt(countResult.rows[0].total);
        const totalPages = Math.ceil(totalItems / limitNum);

        res.json({
            data: result.rows,
            pagination: {
                current_page: pageNum,
                per_page: limitNum,
                total_items: totalItems,
                total_pages: totalPages
            }
        });
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


// ==========================================
// ADMIN ROUTES
// ==========================================

// POST /api/admin/login - Admin Login
router.post('/admin/login', async (req, res) => {
    try {
        const { phone, password } = req.body;

        if (!phone || !password) {
            return res.status(400).json({ success: false, message: 'Phone and password required' });
        }

        // Check if user exists and is an admin
        const query = `
            SELECT u.*, r.name as role_name 
            FROM users u
            JOIN roles r ON u.role_id = r.id
            WHERE u.phone_number = $1 AND r.name = 'Admin'
        `;
        const userResult = await db.query(query, [phone]);
        
        if (userResult.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid credentials or access denied' });
        }

        const user = userResult.rows[0];

        // Verify password
        const isValid = authService.verifyPassword(password, phone, user.password);
        if (!isValid) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        // Update last login
        await db.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

        // Return success
        res.json({
            success: true,
            user: {
                id: user.id,
                name: user.name,
                phone: user.phone_number,
                role: user.role_name,
                last_login: user.last_login
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// GET /api/admin/stats - Enhanced Admin Stats
router.get('/admin/stats', async (req, res) => {
    try {
        // Reuse basic stats logic or call internal function if refactored
        // 1. Total Reports (This Week)
        const totalReportsResult = await db.query(`
            SELECT COUNT(*) as count 
            FROM issues 
            WHERE created_at >= date_trunc('week', CURRENT_DATE)
        `);
        const totalReports = parseInt(totalReportsResult.rows[0].count);

        // 2. Last Week
        const lastWeekReportsResult = await db.query(`
            SELECT COUNT(*) as count 
            FROM issues 
            WHERE created_at >= date_trunc('week', CURRENT_DATE - INTERVAL '1 week')
            AND created_at < date_trunc('week', CURRENT_DATE)
        `);
        const lastWeekReports = parseInt(lastWeekReportsResult.rows[0].count);
        
        let percentageChange = 0;
        if (lastWeekReports > 0) {
            percentageChange = Math.round(((totalReports - lastWeekReports) / lastWeekReports) * 100);
        } else if (totalReports > 0) {
            percentageChange = 100;
        }

        // 3. Resolved
        const resolvedResult = await db.query("SELECT COUNT(*) as count FROM issues WHERE status = 'fixed'");
        const resolvedCount = parseInt(resolvedResult.rows[0].count);

        // 4. Resolution Rate
        const allTimeResult = await db.query('SELECT COUNT(*) as count FROM issues');
        const allTimeCount = parseInt(allTimeResult.rows[0].count);
        const resolutionRate = allTimeCount > 0 ? Math.round((resolvedCount / allTimeCount) * 100) : 0;

        // 5. Critical Pending
        const criticalPendingResult = await db.query("SELECT COUNT(*) as count FROM issues WHERE status = 'critical'");
        const criticalPendingCount = parseInt(criticalPendingResult.rows[0].count);

        // 6. Sentiment (Mocked for now)
        // In a real scenario, this would aggregate sentiment scores from an AI analysis table
        const sentimentScore = "Neutral"; // Placeholder

        res.json({
            total_reports_week: totalReports,
            reports_change_pct: percentageChange,
            resolved_issues: resolvedCount,
            resolution_rate: resolutionRate,
            critical_pending: criticalPendingCount,
            sentiment_score: sentimentScore
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/admin/insights - AI Insights & Alerts
router.get('/admin/insights', async (req, res) => {
    try {
        const insights = [];

        // 1. Hotspots (High Upvotes)
        const hotspotsResult = await db.query(`
            SELECT i.category, i.title, v.upvotes 
            FROM issues_with_votes i 
            JOIN (
                SELECT issue_id, upvotes FROM issues_with_votes WHERE upvotes > 10
            ) v ON i.id = v.issue_id
            ORDER BY v.upvotes DESC
            LIMIT 3
        `);

        hotspotsResult.rows.forEach(row => {
            insights.push({
                type: 'critical',
                title: 'High Priority Hotspot',
                description: `${row.title} (${row.category}) has received ${row.upvotes} upvotes. Immediate attention recommended.`
            });
        });

        // 2. Emerging Issues (Spike in specific category today)
        // This is a bit complex for a single query without more data, so we'll do a simple check
        const emergingResult = await db.query(`
            SELECT category, COUNT(*) as count 
            FROM issues 
            WHERE created_at >= CURRENT_DATE 
            GROUP BY category 
            HAVING COUNT(*) > 5
            ORDER BY count DESC
            LIMIT 1
        `);

        if (emergingResult.rows.length > 0) {
            const row = emergingResult.rows[0];
            insights.push({
                type: 'warning',
                title: 'Emerging Issue',
                description: `Spike in "${row.category}" reports. ${row.count} new reports today.`
            });
        }

        // 3. Sentiment (Mocked)
        insights.push({
            type: 'info',
            title: 'Sentiment Analysis',
            description: 'Citizens are expressing frustration regarding "Water Supply" in the East End. Negative sentiment score: 78%.'
        });


        res.json(insights);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// PUT /api/admin/issues/:id/status - Update Issue Status & Log History
router.put('/admin/issues/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status, admin_id, note } = req.body;

        if (!status) {
            return res.status(400).json({ success: false, message: 'Status is required' });
        }

        // 1. Update Issue Status
        await db.query('UPDATE issues SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [status, id]);

        // 2. Log to Tracker
        // Map status to a readable action
        let action = 'status_change';
        if (status === 'acknowledged') action = 'acknowledged';
        if (status === 'progress') action = 'in_progress';
        if (status === 'fixed') action = 'resolved';

        const description = note || `Status updated to ${status}`;

        await db.query(`
            INSERT INTO issue_tracker (issue_id, action, description, performed_by)
            VALUES ($1, $2, $3, $4)
        `, [id, action, description, admin_id || null]);

        res.json({ success: true, message: 'Status updated successfully' });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

module.exports = router;

