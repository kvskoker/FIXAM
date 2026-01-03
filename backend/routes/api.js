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
                i.resolution_note,
                u.name as reported_by_name,
                COALESCE(v.upvotes, 0) as upvotes,
                COALESCE(v.downvotes, 0) as downvotes,
                COALESCE(v.net_votes, 0) as votes
            FROM issues i
            LEFT JOIN users u ON i.reported_by = u.id
            LEFT JOIN (
                SELECT 
                    COALESCE(i2.duplicate_of, i2.id) as effective_issue_id,
                    SUM(CASE WHEN vote_type = 'upvote' THEN 1 ELSE 0 END) as upvotes,
                    SUM(CASE WHEN vote_type = 'downvote' THEN 1 ELSE 0 END) as downvotes,
                    SUM(CASE WHEN vote_type = 'upvote' THEN 1 WHEN vote_type = 'downvote' THEN -1 ELSE 0 END) as net_votes
                FROM votes v
                JOIN issues i2 ON v.issue_id = i2.id
                GROUP BY COALESCE(i2.duplicate_of, i2.id)
            ) v ON i.id = v.effective_issue_id
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
        
        if (search) { 
            countSql += ` AND (i.title ILIKE $${pCount} OR i.description ILIKE $${pCount} OR i.ticket_id ILIKE $${pCount})`; 
            countSqlParams.push(`%${search}%`); 
            pCount++; 
        }
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

// GET /api/stats/trends - Daily reporting and resolution trends
router.get('/stats/trends', async (req, res) => {
    try {
        const { start_date, end_date } = req.query;
        // Explicitly set session timezone to UTC for consistent aggregation
        await db.query("SET LOCAL timezone TO 'UTC'");

        let reportsQuery = `
            SELECT (created_at AT TIME ZONE 'UTC')::date::text as date, COUNT(*) as count
            FROM issues
            WHERE 1=1
        `;
        let resolutionsQuery = `
            SELECT (created_at AT TIME ZONE 'UTC')::date::text as date, COUNT(*) as count
            FROM issue_tracker
            WHERE action = 'resolved'
        `;
        const params = [];
        let pCount = 1;

        if (start_date) {
            reportsQuery += ` AND created_at >= $${pCount}`;
            resolutionsQuery += ` AND created_at >= $${pCount}`;
            params.push(start_date);
            pCount++;
        }
        if (end_date) {
            reportsQuery += ` AND created_at <= $${pCount}::timestamp + interval '1 day' - interval '1 second'`;
            resolutionsQuery += ` AND created_at <= $${pCount}::timestamp + interval '1 day' - interval '1 second'`;
            params.push(end_date);
            pCount++;
        }

        // If no dates provided, default to last 14 days
        if (!start_date && !end_date) {
            reportsQuery += ` AND created_at >= CURRENT_DATE - INTERVAL '14 days'`;
            resolutionsQuery += ` AND created_at >= CURRENT_DATE - INTERVAL '14 days'`;
        }

        reportsQuery += ` GROUP BY 1 ORDER BY 1 ASC`;
        resolutionsQuery += ` GROUP BY 1 ORDER BY 1 ASC`;

        const [reportsResult, resolutionsResult] = await Promise.all([
            db.query(reportsQuery, params),
            db.query(resolutionsQuery, params)
        ]);

        res.json({
            reports: reportsResult.rows,
            resolutions: resolutionsResult.rows
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/stats - Fetch dashboard statistics
router.get('/stats', async (req, res) => {
    try {
        const { start_date, end_date } = req.query;

        if (start_date || end_date) {
            const params = [];
            let pCount = 1;
            let whereClause = ' WHERE 1=1';
            
            if (start_date) {
                whereClause += ` AND created_at >= $${pCount}`;
                params.push(start_date);
                pCount++;
            }
            if (end_date) {
                whereClause += ` AND created_at <= $${pCount}`;
                params.push(`${end_date} 23:59:59`);
                pCount++;
            }

            const [totalRes, resolvedRes, criticalRes, allTimeRes] = await Promise.all([
                db.query(`SELECT COUNT(*) as count FROM issues ${whereClause}`, params),
                db.query(`SELECT COUNT(*) as count FROM issue_tracker WHERE action = 'resolved' ${whereClause.replace('WHERE', 'AND')}`, params),
                db.query(`SELECT COUNT(*) as count FROM issues ${whereClause} AND status = 'critical'`, params),
                db.query(`SELECT COUNT(*) as count FROM issues`)
            ]);

            const total = parseInt(totalRes.rows[0].count);
            const resolved = parseInt(resolvedRes.rows[0].count);
            const critical = parseInt(criticalRes.rows[0].count);
            const allTime = parseInt(allTimeRes.rows[0].count);
            const resolutionRate = total > 0 ? Math.round((resolved / total) * 100) : 0;

            return res.json({
                total_reports_week: total, // We keep the key generic or UI uses it
                reports_change_pct: 0, // No comparison logic for custom range yet
                resolved_issues: resolved,
                resolution_rate: resolutionRate,
                critical_pending: critical,
                is_custom_range: true
            });
        }

        // Default logic: This Week vs Last Week
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
            percentageChange = 100;
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
        // Process in background to avoid timeout
        fixamHandler.processIncomingMessage(body)
            .catch(err => console.error("Error processing message:", err));
            
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

        // Check if user exists and has roles
        const query = `
            SELECT u.*, ARRAY_AGG(r.name) as roles 
            FROM users u
            JOIN user_roles ur ON u.id = ur.user_id
            JOIN roles r ON ur.role_id = r.id
            WHERE u.phone_number = $1
            GROUP BY u.id
        `;
        const userResult = await db.query(query, [phone]);
        
        if (userResult.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid credentials or access denied' });
        }

        const user = userResult.rows[0];

        if (!user.roles.includes('Admin') && !user.roles.includes('Operation')) {
            return res.status(403).json({ success: false, message: 'Access denied: Admin or Operations role required' });
        }

        if (user.is_disabled) {
            return res.status(403).json({ success: false, message: 'Account is disabled. Please contact support.' });
        }

        // Verify password
        const isValid = authService.verifyPassword(password, phone, user.password);
        if (!isValid) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        // Update last login
        await db.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

        // Determine preferred role for display
        let preferredRole = 'User';
        if (user.roles.includes('Admin')) preferredRole = 'Admin';
        else if (user.roles.includes('Operation')) preferredRole = 'Operations';
        else if (user.roles.includes('User')) preferredRole = 'User';
        else preferredRole = user.roles[0] || 'User';

        // Return success
        res.json({
            success: true,
            user: {
                id: user.id,
                name: user.name,
                phone: user.phone_number,
                role: preferredRole,
                roles: user.roles,
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

        // 0. Check if this is a duplicate issue or already has the same status
        const checkIssue = await db.query('SELECT duplicate_of, status FROM issues WHERE id = $1', [id]);
        if (checkIssue.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Issue not found' });
        }
        
        const currentIssue = checkIssue.rows[0];
        if (currentIssue.duplicate_of) {
            return res.status(400).json({ success: false, message: 'Status cannot be set directly on a duplicate issue. Update the original issue instead.' });
        }
        
        if (currentIssue.status === status) {
            return res.status(400).json({ success: false, message: `Issue is already in ${status} status.` });
        }

        // 1. Update Issue Status
        if (status === 'fixed' && note) {
            await db.query('UPDATE issues SET status = $1, resolution_note = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3', [status, note, id]);
            
            // 1.b Propagation: Update all duplicates of this issue
            await db.query('UPDATE issues SET status = $1, resolution_note = $2, updated_at = CURRENT_TIMESTAMP WHERE duplicate_of = $3', [status, note, id]);
        } else {
            await db.query('UPDATE issues SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [status, id]);
            
            // 1.b Propagation: Update all duplicates of this issue
            await db.query('UPDATE issues SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE duplicate_of = $2', [status, id]);
        }

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

        // Log for duplicates too
        const duplicates = await db.query('SELECT id FROM issues WHERE duplicate_of = $1', [id]);
        for (const dup of duplicates.rows) {
            await db.query(`
                INSERT INTO issue_tracker (issue_id, action, description, performed_by)
                VALUES ($1, $2, $3, $4)
            `, [dup.id, action, `Status synced from original: ${status}`, admin_id || null]);
        }

        // 3. Notify Reporters via WhatsApp
        try {
            const reportersResult = await db.query(`
                SELECT i.ticket_id, i.title, u.phone_number
                FROM issues i
                JOIN users u ON i.reported_by = u.id
                WHERE (i.id = $1 OR i.duplicate_of = $1) 
                AND u.phone_number IS NOT NULL
            `, [id]);

            const statusMap = {
                'acknowledged': 'Acknowledged 📝',
                'progress': 'In Progress 🏗️',
                'fixed': 'Resolved ✅',
                'critical': 'High Priority 🚨'
            };
            const friendlyStatus = (statusMap[status] || status).toUpperCase();

            for (const row of reportersResult.rows) {
                const message = `🔔 *Issue Update*\n\nThe status of your report *${row.title}* (#${row.ticket_id}) has been updated to: *${friendlyStatus}*.\n\nThank you for helping us make our community better! 🌟`;
                await whatsappService.sendMessage(row.phone_number, message);
                
                // Gamification: Award 50 points to reporter for resolution
                if (status === 'fixed') {
                     // Get user ID from phone number (since we have phone_number in row, we need user ID)
                     // Actually `reportersResult` joins users table, let's fetch user ID there too.
                     // But wait, the SELECT above only fetches ticket_id, title, phone_number.
                     // I should fix the SELECT query first to include user_id.
                     // HOWEVER, `reported_by` in issues table is the user ID.
                     // Doing a separate query for cleaniness.
                     const reporterRes = await db.query('SELECT reported_by FROM issues WHERE id = $1', [id]);
                     if (reporterRes.rows.length > 0 && reporterRes.rows[0].reported_by) {
                         const userId = reporterRes.rows[0].reported_by;
                         // Add points
                         await db.query('UPDATE users SET points = points + 50 WHERE id = $1', [userId]);
                         // Log
                         await db.query(`INSERT INTO user_point_logs (user_id, amount, action_type, related_issue_id) VALUES ($1, 50, 'issue_resolved', $2)`, [userId, id]);
                         
                         // Notify user about points
                         await whatsappService.sendMessage(row.phone_number, `🎉 *Bonus Points Earned!* 🎉\n\nYou received *50 points* because your reported issue was RESOLVED! Keep up the great work citizen! 👏`);
                     }
                }
            }
        } catch (notifyErr) {
            console.error('Error notifying reporters:', notifyErr);
        }

        res.json({ success: true, message: 'Status updated successfully' });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// POST /api/admin/issues/:id/mark-duplicate - Mark an issue as duplicate
router.post('/admin/issues/:id/mark-duplicate', async (req, res) => {
    try {
        const { id } = req.params;
        const { original_issue_id, admin_id, note } = req.body;

        if (!original_issue_id) {
            return res.status(400).json({ success: false, message: 'Original issue ID (parent issue) is required' });
        }

        // 0. Get original issue status
        const originalIssue = await db.query('SELECT ticket_id, status FROM issues WHERE id = $1', [original_issue_id]);
        if (originalIssue.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Original issue not found' });
        }
        const { ticket_id: originalTicketId, status: originalStatus } = originalIssue.rows[0];

        // 1. Update issue: Set duplicate_of AND sync status
        await db.query('UPDATE issues SET duplicate_of = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3', [original_issue_id, originalStatus, id]);

        // 3. Log to Tracker
        const description = note || `Marked as duplicate of ticket ${originalTicketId}`;
        await db.query(`
            INSERT INTO issue_tracker (issue_id, action, description, performed_by)
            VALUES ($1, $2, $3, $4)
        `, [id, 'marked_duplicate', description, admin_id || null]);

        res.json({ success: true, message: 'Issue marked as duplicate' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// POST /api/admin/issues/:id/unlink-duplicate - Unlink a duplicate issue
router.post('/admin/issues/:id/unlink-duplicate', async (req, res) => {
    try {
        const { id } = req.params;
        const { admin_id, note } = req.body;

        // 1. Update issue
        await db.query('UPDATE issues SET duplicate_of = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

        // 2. Log to Tracker
        const description = note || `Unlinked from original issue (marked as unique)`;
        await db.query(`
            INSERT INTO issue_tracker (issue_id, action, description, performed_by)
            VALUES ($1, $2, $3, $4)
        `, [id, 'unlinked_duplicate', description, admin_id || null]);

        res.json({ success: true, message: 'Issue unlinked successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// ==========================================
// USER MANAGEMENT ROUTES
// ==========================================

// GET /api/admin/users - List users with roles and groups
router.get('/admin/users', async (req, res) => {
    try {
        const { search, role, group, sort, page = 1, limit = 8 } = req.query;
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const offset = (pageNum - 1) * limitNum;

        // Base filter clauses for both main query and count query
        let filterClauses = ' WHERE 1=1';
        const filterParams = [];
        let pCount = 1;

        if (search) {
            filterClauses += ` AND (u.name ILIKE $${pCount} OR u.phone_number ILIKE $${pCount})`;
            filterParams.push(`%${search}%`);
            pCount++;
        }

        if (role) {
            filterClauses += ` AND u.id IN (SELECT user_id FROM user_roles ur JOIN roles r ON ur.role_id = r.id WHERE r.name = $${pCount})`;
            filterParams.push(role);
            pCount++;
        }

        if (group) {
            filterClauses += ` AND u.id IN (SELECT user_id FROM user_groups ug JOIN groups g ON ug.group_id = g.id WHERE g.name = $${pCount})`;
            filterParams.push(group);
            pCount++;
        }

        // 1. Get total filtered count
        const countSql = `SELECT COUNT(*) as total FROM users u ${filterClauses}`;
        const countResult = await db.query(countSql, filterParams);
        const totalItems = parseInt(countResult.rows[0].total);

        // 2. Main query with pagination
        // Using subqueries to aggregate roles and groups to avoid row explosion
        let sql = `
            SELECT 
                u.id, 
                u.name, 
                u.phone_number, 
                u.last_login,
                u.created_at,
                u.is_disabled,
                u.points,
                (
                    SELECT COALESCE(array_agg(r.name), '{}')
                    FROM user_roles ur
                    JOIN roles r ON ur.role_id = r.id
                    WHERE ur.user_id = u.id
                ) as roles,
                (
                    SELECT COALESCE(array_agg(g.name), '{}')
                    FROM user_groups ug
                    JOIN groups g ON ug.group_id = g.id
                    WHERE ug.user_id = u.id
                ) as groups
            FROM users u
            ${filterClauses}
        `;

        // Sorting
        if (sort === 'oldest') {
            sql += ` ORDER BY u.created_at ASC`;
        } else if (sort === 'newest') {
            sql += ` ORDER BY u.created_at DESC`;
        } else if (sort === 'name_asc') {
            sql += ` ORDER BY u.name ASC`;
        } else if (sort === 'name_desc') {
            sql += ` ORDER BY u.name DESC`;
        } else {
            sql += ` ORDER BY u.created_at DESC`; // Default
        }

        sql += ` LIMIT $${pCount} OFFSET $${pCount + 1}`;
        filterParams.push(limitNum, offset);

        const result = await db.query(sql, filterParams);

        res.json({
            data: result.rows,
            pagination: {
                current_page: pageNum,
                per_page: limitNum,
                total_items: totalItems,
                total_pages: Math.ceil(totalItems / limitNum)
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST /api/admin/users/:id/penalize - Admin Penalty Route
router.post('/admin/users/:id/penalize', async (req, res) => {
    try {
        const { id } = req.params;
        const { amount, reason } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid penalty amount' });
        }

        const client = await db.connect();
        try {
            await client.query('BEGIN');
            // Allow points to go negative (no GREATEST check)
            await client.query('UPDATE users SET points = points - $1 WHERE id = $2', [amount, id]);
            await client.query(
                'INSERT INTO user_point_logs (user_id, amount, action_type) VALUES ($1, $2, $3)',
                [id, -amount, 'admin_penalty']
            );
            await client.query('COMMIT');
            
            // Notify User
            const userRes = await client.query('SELECT phone_number FROM users WHERE id = $1', [id]);
            if (userRes.rows.length > 0) {
                const phone = userRes.rows[0].phone_number;
                const msg = `⚠️ *Account Alert*\n\nYou have been penalized *${amount} points* by an administrator.\nReason: ${reason || 'Violation of community guidelines'}.\n\nPlease adhere to our terms to avoid further penalties.`;
                await whatsappService.sendMessage(phone, msg);
            }
            
            res.json({ success: true, message: 'User penalized successfully' });
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});


// POST /api/admin/users - Create User
router.post('/admin/users', async (req, res) => {
    try {
        const { phone_number, name, password, roles, groups } = req.body;
        if (!phone_number) return res.status(400).json({ error: 'Phone number is required' });

        // Check if phone number already exists
        const checkUser = await db.query('SELECT id FROM users WHERE phone_number = $1', [phone_number]);
        if (checkUser.rows.length > 0) {
            return res.status(400).json({ error: 'A user with this phone number already exists' });
        }

        const hashedPassword = password ? authService.hashPassword(password, phone_number) : null;

        const userInsert = await db.query(
            'INSERT INTO users (phone_number, name, password) VALUES ($1, $2, $3) RETURNING id',
            [phone_number, name, hashedPassword]
        );
        const userId = userInsert.rows[0].id;

        // Assign Roles (default User)
        const roleList = roles && roles.length > 0 ? roles : ['User'];
        for (const roleName of roleList) {
            await db.query(`
                INSERT INTO user_roles (user_id, role_id)
                SELECT $1, id FROM roles WHERE name = $2
            `, [userId, roleName]);
        }

        // Assign Groups
        if (groups && groups.length > 0) {
            for (const groupName of groups) {
                await db.query(`
                    INSERT INTO user_groups (user_id, group_id)
                    SELECT $1, id FROM groups WHERE name = $2
                `, [userId, groupName]);
            }
        }

        res.json({ success: true, userId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// PUT /api/admin/users/:id - Update User
router.put('/admin/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, phone_number, is_disabled, roles, groups, password, admin_id } = req.body;

        // 1. Prevent self-disabling
        if (id == admin_id && is_disabled === true) {
            return res.status(400).json({ error: 'You cannot disable your own account' });
        }

        // 2. Check if phone number is taken by another user
        const checkUser = await db.query('SELECT id FROM users WHERE phone_number = $1 AND id != $2', [phone_number, id]);
        if (checkUser.rows.length > 0) {
            return res.status(400).json({ error: 'This phone number is already assigned to another user' });
        }

        // Update basic info
        let updateQuery = 'UPDATE users SET name = $1, phone_number = $2, is_disabled = $3, updated_at = CURRENT_TIMESTAMP';
        const params = [name, phone_number, is_disabled, id];
        
        if (password) {
            const hashedPassword = authService.hashPassword(password, phone_number);
            updateQuery += ', password = $5 WHERE id = $4';
            params.push(hashedPassword);
        } else {
            updateQuery += ' WHERE id = $4';
        }

        await db.query(updateQuery, params);

        // Update Roles
        if (roles) {
            await db.query('DELETE FROM user_roles WHERE user_id = $1', [id]);
            for (const roleName of roles) {
                await db.query(`
                    INSERT INTO user_roles (user_id, role_id)
                    SELECT $1, id FROM roles WHERE name = $2
                `, [id, roleName]);
            }
        }

        // Update Groups
        if (groups) {
            await db.query('DELETE FROM user_groups WHERE user_id = $1', [id]);
            for (const groupName of groups) {
                await db.query(`
                    INSERT INTO user_groups (user_id, group_id)
                    SELECT $1, id FROM groups WHERE name = $2
                `, [id, groupName]);
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// DELETE /api/admin/users/:id - Remove User
router.delete('/admin/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { admin_id } = req.query;

        // Prevent self-deletion
        if (id == admin_id) {
            return res.status(400).json({ error: 'You cannot delete your own account' });
        }

        await db.query('DELETE FROM users WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/admin/roles
router.get('/admin/roles', async (req, res) => {
    try {
        const result = await db.query('SELECT name FROM roles ORDER BY name ASC');
        res.json(result.rows.map(r => r.name));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/admin/groups
router.get('/admin/groups', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT 
                g.*, 
                COUNT(DISTINCT ug.user_id) as member_count,
                COALESCE(
                    JSON_AGG(json_build_object('id', c.id, 'name', c.name)) 
                    FILTER (WHERE c.id IS NOT NULL), 
                    '[]'
                ) as categories
            FROM groups g
            LEFT JOIN user_groups ug ON g.id = ug.group_id
            LEFT JOIN category_groups cg ON g.id = cg.group_id
            LEFT JOIN categories c ON cg.category_id = c.id
            GROUP BY g.id
            ORDER BY g.name ASC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST /api/admin/groups
router.post('/admin/groups', async (req, res) => {
    try {
        const { name, description, categories } = req.body; // categories is now array of IDs

        // Check for duplicate group name
        const checkGroup = await db.query('SELECT id FROM groups WHERE name = $1', [name]);
        if (checkGroup.rows.length > 0) {
            return res.status(400).json({ error: 'A group with this name already exists' });
        }

        const result = await db.query(
            'INSERT INTO groups (name, description) VALUES ($1, $2) RETURNING id',
            [name, description]
        );
        const groupId = result.rows[0].id;

        // Assign Categories
        if (categories && categories.length > 0) {
            for (const catId of categories) {
                // Ensure it's an integer to prevent SQL injection if raw, but param binding handles it.
                // Depending on frontend, it might send strings "1", "2". Check parse.
                await db.query(`
                    INSERT INTO category_groups (group_id, category_id)
                    VALUES ($1, $2)
                    ON CONFLICT DO NOTHING
                `, [groupId, parseInt(catId)]);
            }
        }

        res.json({ success: true, groupId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// PUT /api/admin/groups/:id
router.put('/admin/groups/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, categories } = req.body;

        // Check if group name is taken by another group
        const checkGroup = await db.query('SELECT id FROM groups WHERE name = $1 AND id != $2', [name, id]);
        if (checkGroup.rows.length > 0) {
            return res.status(400).json({ error: 'Another group with this name already exists' });
        }

        await db.query(
            'UPDATE groups SET name = $1, description = $2 WHERE id = $3',
            [name, description, id]
        );

        // Update Categories
        if (categories) { 
            await db.query('DELETE FROM category_groups WHERE group_id = $1', [id]);
            for (const catId of categories) {
                await db.query(`
                    INSERT INTO category_groups (group_id, category_id)
                    VALUES ($1, $2)
                    ON CONFLICT DO NOTHING
                `, [id, parseInt(catId)]);
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// DELETE /api/admin/groups/:id
router.delete('/admin/groups/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Check for assigned users
        const checkUsers = await db.query('SELECT COUNT(*) as count FROM user_groups WHERE group_id = $1', [id]);
        if (parseInt(checkUsers.rows[0].count) > 0) {
            return res.status(400).json({ error: 'Cannot delete group with assigned users. Please unassign all users first.' });
        }

        await db.query('DELETE FROM groups WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ==========================================
// FEEDBACK ROUTES
// ==========================================

// GET /api/admin/feedback
router.get('/admin/feedback', async (req, res) => {
    try {
        const feedback = await fixamHandler.fixamDb.getFeedback();
        res.json(feedback);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST /api/admin/feedback/:id/acknowledge
router.post('/admin/feedback/:id/acknowledge', async (req, res) => {
    try {
        const { id } = req.params;
        const success = await fixamHandler.fixamDb.acknowledgeFeedback(id);
        if (success) {
            res.json({ success: true });
        } else {
            res.status(400).json({ success: false, message: 'Failed to acknowledge feedback' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

module.exports = router;

