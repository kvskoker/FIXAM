const express = require('express');
const router = express.Router();
const db = require('../db');
const authService = require('../services/authService');


const whatsappService = require('../services/whatsappService');
const FixamHandler = require('../services/whatsappHandler');
const FixamHelpers = require('../services/fixamHelpers');
const { getServiceArea } = require('../services/countries');
const aiService = require('../services/aiService');
const { requireAdmin, requireFullAdmin } = require('../middleware/requireAdmin');
const { getScope, attachScope, canAccessIssue } = require('../middleware/mdaScope');
const auditLog = require('../services/auditLog');
const adminOtp = require('../services/adminOtp');

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

// Records administrative changes. Mounted before the routes so it applies to
// every one of them, including any added later.
router.use(auditLog.auditAdminMutations);

// GET /api/config - Public configuration
router.get('/config', (req, res) => {
    // Base URL: use explicit env var or derive from the request
    const baseUrl = process.env.FIXAM_BASE_URL ||
        `${req.protocol}://${req.get('host')}`;

    res.json({ 
        dev_mode: process.env.DEV_MODE === 'true',
        maintenance_message: "The application has been closed to public use for now until the final Hackathon event day. Only admins are allowed to access the platform.",
        // ── DPG: Dynamic privacy / instance configuration ─────────────────
        instance: {
            country: getServiceArea().name,
            contact_email: process.env.FIXAM_CONTACT_EMAIL || 'privacy@fixam.sl',
            website: process.env.FIXAM_WEBSITE || 'https://fixam.sl',
            base_url: baseUrl,
            privacy_url: `${baseUrl}/privacy`,
            // Served area, so the admin map frames and constrains itself to the
            // same bounds the bot enforces rather than hardcoding a second copy.
            service_area: getServiceArea(),
            // Shown on the sign-in page so an administrator knows where to send
            // LOGIN for their code, rather than having to be told separately.
            bot_number: process.env.BOT_PHONE_NUMBER || null,
            admin_2fa: String(process.env.ADMIN_2FA_ENABLED ?? 'true').toLowerCase() !== 'false',
        }
    });
});

// Middleware for DEV_MODE blocking
router.use((req, res, next) => {
    if (process.env.DEV_MODE === 'true') {
        // Safe paths
        if (req.path === '/config' || req.path === '/webhook' || req.path.startsWith('/admin/login') || req.path.startsWith('/test/')) {
            return next();
        }
        
        // A signed session token, not a header. `X-Admin-Access: true` used to
        // be enough here, which meant the maintenance gate -- and everything
        // behind it -- could be bypassed by anyone who set a header.
        const bearer = (req.headers.authorization || '').startsWith('Bearer ')
            ? req.headers.authorization.slice(7).trim()
            : null;
        if (authService.verifyToken(bearer)) {
            return next();
        }

        // Return 503 Service Unavailable
        return res.status(503).json({ 
            error: 'Maintenance Mode', 
            message: "The application has been closed to public use for now until the final Hackathon event day. Only admins are allowed to access the platform."
        });
    }
    next();
}); 


/**
 * Scope for a request that may or may not be authenticated.
 *
 * /issues serves both the public map and the admin portal, so it cannot simply
 * require a token. Returns null when there is no valid session, meaning "apply
 * no scoping" -- the public behaviour.
 */
async function resolveRequestScope(req) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return null;

    const payload = authService.verifyToken(header.slice(7).trim());
    if (!payload) return null;

    const result = await db.query(
        `SELECT u.id, COALESCE(ARRAY_AGG(r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
         FROM users u
         LEFT JOIN user_roles ur ON u.id = ur.user_id
         LEFT JOIN roles r ON ur.role_id = r.id
         WHERE u.id = $1 GROUP BY u.id`,
        [payload.uid]
    );
    if (result.rows.length === 0) return null;

    return getScope({ id: result.rows[0].id, roles: result.rows[0].roles });
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
                u.phone_number as reported_by_phone,
                COALESCE(v.upvotes, 0) as upvotes,
                COALESCE(v.downvotes, 0) as downvotes,
                COALESCE(v.net_votes, 0) as votes,
                COALESCE(e.count, 0) as endorsements
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
            LEFT JOIN (
                SELECT issue_id, COUNT(*) as count 
                FROM endorsements 
                GROUP BY issue_id
            ) e ON i.id = e.issue_id
            WHERE 1=1
        `;

        // Filters are built once and shared by the page query and the count
        // query. They used to be written out twice and the copies drifted: the
        // count ignored MDA scoping and the spam exclusion, so an MDA holding a
        // handful of reports was offered pages of results that did not exist.
        const params = [];
        let where = '';
        const add = (clause, value) => {
            params.push(value);
            // split/join so a clause may reference the same value more than once.
            where += clause.split('$?').join(`$${params.length}`);
        };

        if (search) {
            add(' AND (i.title ILIKE $? OR i.description ILIKE $? OR i.ticket_id ILIKE $? OR i.address ILIKE $?)',
                `%${search}%`);
        }

        if (category) add(' AND i.category = $?', category);

        if (status) {
            add(' AND i.status = $?', status);
        } else if (req.query.include_spam !== 'true') {
            // Default: hide spam unless explicitly requested.
            where += " AND i.status != 'spam'";
        }

        // MDA scoping. Only applies to a signed-in Operations user: anonymous
        // callers get the public view and full Admins see everything. Without
        // this an MDA officer could read every report on the platform through
        // the same endpoint the portal uses.
        const scope = await resolveRequestScope(req);
        if (scope && !scope.unrestricted) {
            if (scope.categories.length === 0) {
                // In no group, or a group with no categories: show nothing
                // rather than everything.
                where += ' AND FALSE';
            } else {
                add(' AND i.category = ANY($?)', scope.categories);
            }
        }

        // Lifecycle state, which is a different question from status: 'open'
        // is what is still someone's work, 'closed' is what is finished with,
        // whether or not it was fixed.
        const state = req.query.state;
        if (state === 'open') where += ' AND i.closed_at IS NULL';
        else if (state === 'closed') where += ' AND i.closed_at IS NOT NULL';
        else if (state === 'disputed') where += ' AND i.dispute_count > 0';

        if (ticket) add(' AND i.ticket_id = $?', ticket);
        if (req.query.start_date) add(' AND i.created_at >= $?', req.query.start_date);
        if (req.query.end_date) add(' AND i.created_at <= $?', `${req.query.end_date} 23:59:59`);

        query += where;

        // Sorting
        if (sort === 'oldest') {
            query += ` ORDER BY i.created_at ASC`;
        } else if (sort === 'most_votes') {
            query += ` ORDER BY votes DESC, i.created_at DESC`;
        } else {
            // Default: newest
            query += ` ORDER BY i.created_at DESC`;
        }

        // Counted before the page is sliced, and off the same clause, so the
        // page count always matches what the caller is actually allowed to see.
        const countResult = await db.query(
            `SELECT COUNT(*) as total FROM issues i WHERE 1=1${where}`,
            params
        );
        const totalItems = parseInt(countResult.rows[0].total);

        query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        const result = await db.query(query, [...params, limitNum, offset]);

        const totalPages = Math.ceil(totalItems / limitNum);

        // Three tiers, because "who reported this" is answered differently
        // depending on who is asking.
        //
        //   Public          - nobody. A report is about a place and a problem.
        //   MDA officer     - name and phone, but only for reports in their own
        //                     categories. Following up with the citizen is the
        //                     job; an officer who cannot call the reporter back
        //                     cannot ask which junction, or whether it recurred.
        //                     They still see nothing about other institutions'
        //                     reports, so this widens what they see about their
        //                     own work rather than widening their reach.
        //   Administrator   - all reports.
        //
        // The query selects `i.*`, so any column added later would be public by
        // default; redaction is applied here at the boundary rather than
        // trusting the SELECT list to stay safe.
        const rows = scope
            ? result.rows
            : result.rows.map(({ reported_by, reported_by_name, reported_by_phone, ...rest }) => ({
                ...rest,
                reported_by_name: reported_by_name ? 'Citizen' : null
            }));

        res.json({
            data: rows,
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
/**
 * A report's activity history.
 *
 * This endpoint is public, because the point of the platform is that anyone can
 * see what happened to a report. It used to return every actor's name AND phone
 * number, which meant the phone number of every citizen, MDA officer and
 * administrator who had ever touched a report could be harvested by walking
 * issue ids. Phone numbers are now never returned here at all.
 *
 * The public sees who acted in institutional terms -- "Freetown City Council",
 * "Citizen", "Administrator" -- which is what accountability actually requires.
 * Signed-in staff additionally see the individual's name, because internally it
 * matters which officer acted.
 */
router.get('/issues/:id/tracker', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db.query(`
            SELECT
                it.id, it.issue_id, it.action, it.description, it.created_at,
                u.id AS actor_id,
                u.name AS actor_name,
                COALESCE(
                    (SELECT g.name FROM user_groups ug
                     JOIN groups g ON g.id = ug.group_id
                     WHERE ug.user_id = u.id
                     ORDER BY g.id LIMIT 1),
                    CASE WHEN EXISTS (
                        SELECT 1 FROM user_roles ur
                        JOIN roles r ON r.id = ur.role_id
                        WHERE ur.user_id = u.id AND r.name = 'Admin'
                    ) THEN 'Administrator' ELSE 'Citizen' END
                ) AS actor_institution
            FROM issue_tracker it
            LEFT JOIN users u ON it.performed_by = u.id
            WHERE it.issue_id = $1
            ORDER BY it.created_at ASC
        `, [id]);

        // Only a verified session gets individual names.
        const staff = !!authService.verifyToken(
            (req.headers.authorization || '').startsWith('Bearer ')
                ? req.headers.authorization.slice(7).trim()
                : null
        );

        res.json(result.rows.map((row) => ({
            id: row.id,
            issue_id: row.issue_id,
            action: row.action,
            description: row.description,
            created_at: row.created_at,
            performed_by_name: staff
                ? (row.actor_name || 'System')
                : (row.actor_institution || 'System')
        })));
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


// ── Category administration ──────────────────────────────────────────────────
//
// Categories drive both classification and MDA routing, so a change here has to
// reach the AI engine as well as the database. The engine embeds the category
// list at startup; without the reload below, a new category would appear in the
// portal and be mappable to an MDA while the classifier never assigned anything
// to it.

const axios = require('axios');
const AI_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';

async function reloadAiCategories() {
    try {
        const res = await axios.post(`${AI_URL}/reload-categories`, {}, { timeout: 15000 });
        console.log(`AI engine reloaded ${res.data.count} categories`);
        return true;
    } catch (err) {
        // Not fatal: the category exists and is mappable, it just will not be
        // auto-assigned until the engine picks it up. Say so rather than fail
        // the admin's action.
        console.error('Could not reload categories on the AI engine:', err.message);
        return false;
    }
}

// POST /api/admin/categories - Create a category
router.post('/admin/categories', requireFullAdmin, attachScope, async (req, res) => {
    try {
        const { name, icon, color } = req.body;
        const trimmed = (name || '').trim();

        if (!trimmed) {
            return res.status(400).json({ error: 'Category name is required' });
        }
        if (trimmed.length > 50) {
            return res.status(400).json({ error: 'Category name must be 50 characters or fewer' });
        }

        const existing = await db.query('SELECT id FROM categories WHERE LOWER(name) = LOWER($1)', [trimmed]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'A category with this name already exists' });
        }

        const result = await db.query(
            'INSERT INTO categories (name, icon, color) VALUES ($1, $2, $3) RETURNING *',
            [trimmed, icon || 'fa-tag', color || '#64748b']
        );

        const reloaded = await reloadAiCategories();
        res.json({ success: true, category: result.rows[0], classifier_updated: reloaded });
    } catch (err) {
        console.error('Create category failed:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// PUT /api/admin/categories/:id - Rename or restyle a category
router.put('/admin/categories/:id', requireFullAdmin, attachScope, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, icon, color } = req.body;
        const trimmed = (name || '').trim();

        if (!trimmed) {
            return res.status(400).json({ error: 'Category name is required' });
        }

        const current = await db.query('SELECT name FROM categories WHERE id = $1', [id]);
        if (current.rows.length === 0) {
            return res.status(404).json({ error: 'Category not found' });
        }

        const clash = await db.query(
            'SELECT id FROM categories WHERE LOWER(name) = LOWER($1) AND id != $2', [trimmed, id]);
        if (clash.rows.length > 0) {
            return res.status(400).json({ error: 'Another category already uses this name' });
        }

        const previousName = current.rows[0].name;

        await db.query(
            'UPDATE categories SET name = $1, icon = $2, color = $3 WHERE id = $4',
            [trimmed, icon || 'fa-tag', color || '#64748b', id]
        );

        // issues.category stores the name, not the id. Without this a rename
        // orphans every existing report in that category: they keep the old
        // string, disappear from category filters, and lose their MDA routing.
        let updatedIssues = 0;
        if (previousName !== trimmed) {
            const upd = await db.query(
                'UPDATE issues SET category = $1 WHERE category = $2', [trimmed, previousName]);
            updatedIssues = upd.rowCount;
        }

        const reloaded = await reloadAiCategories();
        res.json({ success: true, issues_updated: updatedIssues, classifier_updated: reloaded });
    } catch (err) {
        console.error('Update category failed:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// DELETE /api/admin/categories/:id
router.delete('/admin/categories/:id', requireFullAdmin, attachScope, async (req, res) => {
    try {
        const { id } = req.params;

        const current = await db.query('SELECT name FROM categories WHERE id = $1', [id]);
        if (current.rows.length === 0) {
            return res.status(404).json({ error: 'Category not found' });
        }
        const categoryName = current.rows[0].name;

        // Reports keep the category as text, so deleting one in use would leave
        // them pointing at something that no longer exists -- unfilterable and
        // unroutable. Refuse and say how many are affected.
        const inUse = await db.query('SELECT COUNT(*) AS count FROM issues WHERE category = $1', [categoryName]);
        const count = parseInt(inUse.rows[0].count, 10);
        if (count > 0) {
            return res.status(400).json({
                error: `Cannot delete: ${count} report(s) use this category. Reassign them first.`
            });
        }

        await db.query('DELETE FROM category_groups WHERE category_id = $1', [id]);
        await db.query('DELETE FROM categories WHERE id = $1', [id]);

        const reloaded = await reloadAiCategories();
        res.json({ success: true, classifier_updated: reloaded });
    } catch (err) {
        console.error('Delete category failed:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/stats/trends - Daily reporting and resolution trends
router.get('/stats/trends', async (req, res) => {
    try {
        const { start_date, end_date, category } = req.query;
        // Explicitly set session timezone to UTC for consistent aggregation
        await db.query("SET LOCAL timezone TO 'UTC'");

        let reportsQuery = `
            SELECT (created_at AT TIME ZONE 'UTC')::date::text as date, COUNT(*) as count
            FROM issues
            WHERE 1=1
        `;
        let resolutionsQuery = `
            SELECT (it.created_at AT TIME ZONE 'UTC')::date::text as date, COUNT(*) as count
            FROM issue_tracker it
            JOIN issues i ON it.issue_id = i.id
            WHERE it.action = 'resolved'
        `;
        const params = [];
        let pCount = 1;

        if (start_date) {
            reportsQuery += ` AND created_at >= $${pCount}`;
            resolutionsQuery += ` AND it.created_at >= $${pCount}`;
            params.push(start_date);
            pCount++;
        }
        if (end_date) {
            reportsQuery += ` AND created_at <= $${pCount}::timestamp + interval '1 day' - interval '1 second'`;
            resolutionsQuery += ` AND it.created_at <= $${pCount}::timestamp + interval '1 day' - interval '1 second'`;
            params.push(end_date);
            pCount++;
        }

        if (category) {
            reportsQuery += ` AND category = $${pCount}`;
            resolutionsQuery += ` AND i.category = $${pCount}`;
            params.push(category);
            pCount++;
        }

        // If no dates provided, default to last 14 days
        if (!start_date && !end_date) {
            reportsQuery += ` AND created_at >= CURRENT_DATE - INTERVAL '14 days'`;
            resolutionsQuery += ` AND it.created_at >= CURRENT_DATE - INTERVAL '14 days'`;
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
        const { start_date, end_date, category } = req.query;

        // Common condition for category
        let categoryCond = '';
        let categoryParams = [];
        if (category) {
            categoryCond = ` AND category = $${(start_date || end_date ? (start_date && end_date ? 3 : 2) : 1)}`;
            categoryParams = [category];
        }

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

            if (category) {
                whereClause += ` AND category = $${pCount}`;
                params.push(category);
                pCount++;
            }

            const [totalRes, resolvedRes, criticalRes, allTimeRes] = await Promise.all([
                db.query(`SELECT COUNT(*) as count FROM issues ${whereClause}`, params),
                db.query(`SELECT COUNT(*) as count FROM issue_tracker it JOIN issues i ON it.issue_id = i.id WHERE it.action = 'resolved' ${whereClause.replace(/created_at/g, 'it.created_at').replace(/category/g, 'i.category').replace('WHERE', 'AND')}`, params),
                db.query(`SELECT COUNT(*) as count FROM issues ${whereClause} AND status = 'critical'`, params),
                db.query(`SELECT COUNT(*) as count FROM issues ${category ? 'WHERE category = $1' : ''}`, category ? [category] : [])
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
        const currentParams = category ? [category] : [];
        const catIdx = category ? 1 : null;
        
        // 1. Total Reports (This Week)
        const totalReportsResult = await db.query(`
            SELECT COUNT(*) as count 
            FROM issues 
            WHERE created_at >= date_trunc('week', CURRENT_DATE)
            ${category ? `AND category = $1` : ''}
        `, currentParams);
        const totalReports = parseInt(totalReportsResult.rows[0].count);

        // 2. Total Reports (Last Week) - for comparison
        const lastWeekReportsResult = await db.query(`
            SELECT COUNT(*) as count 
            FROM issues 
            WHERE created_at >= date_trunc('week', CURRENT_DATE - INTERVAL '1 week')
            AND created_at < date_trunc('week', CURRENT_DATE)
            ${category ? `AND category = $1` : ''}
        `, currentParams);
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
            SELECT COUNT(*) as count FROM issues WHERE status = 'fixed' ${category ? `AND category = $1` : ''}
        `, currentParams);
        const resolvedCount = parseInt(resolvedResult.rows[0].count);

        // 4. Total Issues (All time) for resolution rate
        const allTimeResult = await db.query(`SELECT COUNT(*) as count FROM issues ${category ? `WHERE category = $1` : ''}`, currentParams);
        const allTimeCount = parseInt(allTimeResult.rows[0].count);
        const resolutionRate = allTimeCount > 0 ? Math.round((resolvedCount / allTimeCount) * 100) : 0;

        // 5. Critical Pending
        const criticalPendingResult = await db.query(`
            SELECT COUNT(*) as count FROM issues WHERE status = 'critical' ${category ? `AND category = $1` : ''}
        `, currentParams);
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

// --- DEV MODE TESTING ENDPOINTS REMOVED ---

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

        // Verify password.
        //
        // This was calling verifyPassword(password, phone, user.password) without
        // awaiting it. The function takes (password, storedHash) and is async, so
        // it compared the password against the phone number and returned a
        // Promise -- always truthy, so `!isValid` never fired and ANY password
        // was accepted for an existing admin account.
        let isValid = await authService.verifyPassword(password, user.password);

        // Accounts created before the bcrypt switch still hold a SHA-512 hash.
        // Verify against the old scheme once, then upgrade the stored hash so
        // each legacy account converts on its next successful login.
        if (!isValid && authService.verifyLegacyPassword(password, phone, user.password)) {
            isValid = true;
            try {
                const upgraded = await authService.hashPassword(password);
                await db.query('UPDATE users SET password = $1 WHERE id = $2', [upgraded, user.id]);
                console.log(`Upgraded legacy password hash for user ${user.id}`);
            } catch (rehashErr) {
                // Login still succeeds; the upgrade retries next time.
                console.error('Failed to upgrade legacy password hash:', rehashErr);
            }
        }

        if (!isValid) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        // Second factor. Checked after the password, so a code alone is never
        // enough and an attacker holding the phone learns nothing by trying.
        if (adminOtp.isEnabled()) {
            const supplied = (req.body.otp || '').trim();

            if (!supplied) {
                // Not an error: the password was right, and this says what to do
                // next. The client shows the code field on seeing this.
                return res.status(401).json({
                    success: false,
                    requires_otp: true,
                    message: 'Send LOGIN to the FIXAM WhatsApp number to receive your sign-in code, then enter it below.'
                });
            }

            const check = await adminOtp.verify(user.id, supplied);
            if (!check.ok) {
                const messages = {
                    malformed: 'That code does not look right. Enter the 6-digit code from WhatsApp.',
                    no_code: 'No sign-in code is waiting. Send LOGIN to the FIXAM WhatsApp number to get one.',
                    expired: 'That code has expired. Send LOGIN on WhatsApp to get a new one.',
                    too_many_attempts: 'Too many incorrect codes. Send LOGIN on WhatsApp to get a new one.',
                    incorrect: 'That code is not correct.'
                };
                return res.status(401).json({
                    success: false,
                    requires_otp: true,
                    otp_error: check.reason,
                    message: messages[check.reason] || 'That code could not be verified.'
                });
            }
        }

        // Update last login
        await db.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

        // Determine preferred role for display
        let preferredRole = 'User';
        if (user.roles.includes('Admin')) preferredRole = 'Admin';
        else if (user.roles.includes('Operation')) preferredRole = 'Operations';
        else if (user.roles.includes('User')) preferredRole = 'User';
        else preferredRole = user.roles[0] || 'User';

        // Issue a signed session token. Everything under /admin now requires it;
        // the client stores it and sends it as a Bearer header.
        const token = authService.createToken({
            id: user.id,
            phone_number: user.phone_number,
            roles: user.roles,
        });

        res.json({
            success: true,
            token,
            expires_in_hours: authService.TOKEN_TTL_HOURS,
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
router.get('/admin/stats', requireAdmin, attachScope, async (req, res) => {
    try {
        // Every figure below is scoped: an MDA dashboard showing platform-wide
        // totals would misrepresent their workload and their resolution rate.
        const catFilter = req.scope.unrestricted
            ? ''
            : (req.scope.categories.length
                ? ` AND category IN (${req.scope.categories.map((c) => `'${c.replace(/'/g, "''")}'`).join(',')})`
                : ' AND FALSE');

        // Reuse basic stats logic or call internal function if refactored
        // 1. Total Reports (This Week)
        const totalReportsResult = await db.query(`
            SELECT COUNT(*) as count 
            FROM issues 
            WHERE created_at >= date_trunc('week', CURRENT_DATE)
            ${catFilter}
        `);
        const totalReports = parseInt(totalReportsResult.rows[0].count);

        // 2. Last Week
        const lastWeekReportsResult = await db.query(`
            SELECT COUNT(*) as count 
            FROM issues 
            WHERE created_at >= date_trunc('week', CURRENT_DATE - INTERVAL '1 week')
            AND created_at < date_trunc('week', CURRENT_DATE)
            ${catFilter}
        `);
        const lastWeekReports = parseInt(lastWeekReportsResult.rows[0].count);
        
        let percentageChange = 0;
        if (lastWeekReports > 0) {
            percentageChange = Math.round(((totalReports - lastWeekReports) / lastWeekReports) * 100);
        } else if (totalReports > 0) {
            percentageChange = 100;
        }

        // 3. Resolved
        const resolvedResult = await db.query(`SELECT COUNT(*) as count FROM issues WHERE status = 'fixed' ${catFilter}`);
        const resolvedCount = parseInt(resolvedResult.rows[0].count);

        // 4. Resolution Rate
        const allTimeResult = await db.query(`SELECT COUNT(*) as count FROM issues WHERE 1=1 ${catFilter}`);
        const allTimeCount = parseInt(allTimeResult.rows[0].count);
        const resolutionRate = allTimeCount > 0 ? Math.round((resolvedCount / allTimeCount) * 100) : 0;

        // 5. Critical Pending
        const criticalPendingResult = await db.query(`SELECT COUNT(*) as count FROM issues WHERE status = 'critical' ${catFilter}`);
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
router.get('/admin/insights', requireAdmin, attachScope, async (req, res) => {
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

// PUT /api/admin/issues/:id/location - Place a report on the map by hand
//
// Reports whose address could not be geocoded are stored with the citizen's own
// wording and no coordinates, which keeps the report but leaves it off the map.
// This is how an admin resolves that: they can read the description and the
// photo, and usually know the area far better than a geocoder does.
router.put('/admin/issues/:id/location', requireAdmin, attachScope, async (req, res) => {
    try {
        const { id } = req.params;
        // An MDA may only act on reports in the categories it is responsible
        // for. Checked per issue, because the id comes straight from the URL.
        if (!(await canAccessIssue(req.scope, id))) {
            return res.status(403).json({
                success: false,
                message: 'This report is not assigned to your institution.'
            });
        }

        const { lat, lng, address, district, city, ward } = req.body;

        const latitude = Number(lat);
        const longitude = Number(lng);

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            return res.status(400).json({ success: false, message: 'Valid lat and lng are required.' });
        }

        // Same service-area rule the bot applies to a citizen's GPS pin; an
        // admin typo should not put a report in the sea either.
        const helpers = new FixamHelpers(console.log);
        if (!helpers.isWithinServiceArea(latitude, longitude)) {
            return res.status(400).json({
                success: false,
                message: `Coordinates are outside ${helpers.serviceArea.name}.`
            });
        }

        const existing = await db.query('SELECT id, address FROM issues WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Issue not found' });
        }

        await db.query(
            `UPDATE issues
             SET lat = $1, lng = $2,
                 address = COALESCE($3, address),
                 district = COALESCE($4, district),
                 city = COALESCE($5, city),
                 ward = COALESCE($6, ward),
                 location_source = 'admin',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $7`,
            [latitude, longitude, address || null, district || null, city || null, ward || null, id]
        );

        // Recorded in the audit trail: someone changed where this issue is, and
        // that should be as traceable as changing its status.
        await db.query(
            `INSERT INTO issue_tracker (issue_id, action, description, performed_by)
             VALUES ($1, 'location_set', $2, $3)`,
            [id, `Location set manually to ${latitude}, ${longitude}${address ? ` (${address})` : ''}`, req.admin.id]
        );

        res.json({ success: true, message: 'Location updated.' });
    } catch (err) {
        console.error('Manual location update failed:', err);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// PUT /api/admin/issues/:id/status - Update Issue Status & Log History
router.put('/admin/issues/:id/status', requireAdmin, attachScope, async (req, res) => {
    try {
        const { id } = req.params;
        // An MDA may only act on reports in the categories it is responsible
        // for. Checked per issue, because the id comes straight from the URL.
        if (!(await canAccessIssue(req.scope, id))) {
            return res.status(403).json({
                success: false,
                message: 'This report is not assigned to your institution.'
            });
        }

        const { status, note } = req.body;

        if (!status) {
            return res.status(400).json({ success: false, message: 'Status is required' });
        }

        // 0. Check if this is a duplicate issue or already has the same status
        const checkIssue = await db.query('SELECT duplicate_of, status, closed_at FROM issues WHERE id = $1', [id]);
        if (checkIssue.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Issue not found' });
        }
        
        const currentIssue = checkIssue.rows[0];
        
        if (currentIssue.status === 'spam') {
            return res.status(403).json({ success: false, message: 'Cannot update status of a SPAM issue.' });
        }

        if (currentIssue.duplicate_of) {
            return res.status(400).json({ success: false, message: 'Status cannot be set directly on a duplicate issue. Update the original issue instead.' });
        }
        
        if (currentIssue.status === status) {
            return res.status(400).json({ success: false, message: `Issue is already in ${status} status.` });
        }

        // A closed report is finished with. Moving it along without reopening
        // it first would leave a report that is simultaneously closed and in
        // progress, and would notify the citizen about work on something they
        // were told was over.
        if (currentIssue.closed_at) {
            return res.status(409).json({
                success: false,
                message: 'This report is closed. Reopen it before changing its status.'
            });
        }

        if (status === 'fixed' && !note) {
            return res.status(400).json({
                success: false,
                message: 'A resolution note is required when resolving a report. It is sent to the citizen and shown publicly.'
            });
        }

        // 1. Update Issue Status
        //
        // Resolving closes the report in the same step: an institution that has
        // fixed something should not also have to declare it finished, and a
        // resolved report left open would sit in the MDA's queue as outstanding
        // work that no longer exists.
        if (status === 'fixed') {
            await db.query(
                `UPDATE issues
                 SET status = $1, resolution_note = $2, updated_at = CURRENT_TIMESTAMP,
                     closed_at = CURRENT_TIMESTAMP, closed_by = $3,
                     closure_reason = 'resolved', closure_note = $2
                 WHERE id = $4`,
                [status, note, req.admin.id, id]
            );

            // 1.b Propagation: duplicates follow their original.
            await db.query(
                `UPDATE issues
                 SET status = $1, resolution_note = $2, updated_at = CURRENT_TIMESTAMP,
                     closed_at = CURRENT_TIMESTAMP, closed_by = $3,
                     closure_reason = 'resolved', closure_note = $2
                 WHERE duplicate_of = $4`,
                [status, note, req.admin.id, id]
            );
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
        `, [id, action, description, req.admin.id]);

        // Log for duplicates too
        const duplicates = await db.query('SELECT id FROM issues WHERE duplicate_of = $1', [id]);
        for (const dup of duplicates.rows) {
            await db.query(`
                INSERT INTO issue_tracker (issue_id, action, description, performed_by)
                VALUES ($1, $2, $3, $4)
            `, [dup.id, action, `Status synced from original: ${status}`, req.admin.id]);
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
                let message = `🔔 *Issue Update*\n\nThe status of your report *${row.title}* (#${row.ticket_id}) has been updated to: *${friendlyStatus}*.`;

                if (status === 'fixed') {
                    // The resolution note is the substance of the update -- it
                    // is what the institution says it did. Sending "Resolved"
                    // without it tells the citizen an outcome they cannot check.
                    if (note) message += `\n\n📝 *What was done:*\n${note}`;

                    // And ask them, rather than waiting for them to come back:
                    // a resolution nobody verified is only a claim.
                    message += `\n\nIs it actually fixed? Reply *3*, then send *${row.ticket_id}* to confirm the repair — or to tell us it is not fixed.`;
                } else {
                    message += `\n\nThank you for helping us make our community better! 🌟`;
                }

                await whatsappService.sendMessage(row.phone_number, message);
                
                // Gamification: Award 50 points to reporter for resolution (if not already awarded)
                if (status === 'fixed') {
                     const reporterRes = await db.query('SELECT reported_by FROM issues WHERE id = $1', [id]);
                     if (reporterRes.rows.length > 0 && reporterRes.rows[0].reported_by) {
                         const userId = reporterRes.rows[0].reported_by;
                         
                         // Check if points were already awarded for this issue
                         const pointsCheck = await db.query(
                             "SELECT id FROM user_point_logs WHERE user_id = $1 AND related_issue_id = $2 AND action_type = 'issue_resolved'",
                             [userId, id]
                         );

                         if (pointsCheck.rows.length === 0) {
                             // Add points
                             await db.query('UPDATE users SET points = points + 50 WHERE id = $1', [userId]);
                             // Log
                             await db.query(`INSERT INTO user_point_logs (user_id, amount, action_type, related_issue_id) VALUES ($1, 50, 'issue_resolved', $2)`, [userId, id]);
                             
                             // Notify user about points
                             await whatsappService.sendMessage(row.phone_number, `🎉 *Bonus Points Earned!* 🎉\n\nYou received *50 points* because your reported issue was RESOLVED! Keep up the great work citizen! 👏`);
                         }
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

/**
 * Reasons a report can be closed without being fixed.
 *
 * A fixed vocabulary rather than free text, so "how many reports were closed
 * unresolved, and why" is a question the pilot can answer. 'resolved',
 * 'duplicate' and 'spam' are set by their own flows and are not offered here.
 */
const CLOSURE_REASONS = {
    no_longer_present: 'The problem was no longer there when the team attended',
    not_actionable: 'Not enough to act on, or not a report of a public problem',
    not_feasible: 'Real, but cannot be addressed at present'
};

// POST /api/admin/issues/:id/close - Close a report without resolving it.
//
// Available to MDAs and Admins alike: an institution that cannot fix something
// should be able to say so and explain, rather than leave the report open for
// ever. Both a reason and a written explanation are required, because closing
// a report unresolved tells a citizen that nothing further will happen about a
// problem they took the trouble to report -- that is precisely when an
// explanation is owed.
router.post('/admin/issues/:id/close', requireAdmin, attachScope, async (req, res) => {
    try {
        const { id } = req.params;
        if (!(await canAccessIssue(req.scope, id))) {
            return res.status(403).json({
                success: false,
                message: 'This report is not assigned to your institution.'
            });
        }

        const { reason, note } = req.body;

        if (!CLOSURE_REASONS[reason]) {
            return res.status(400).json({
                success: false,
                message: `Choose a closure reason: ${Object.keys(CLOSURE_REASONS).join(', ')}.`
            });
        }
        if (!note || !note.trim()) {
            return res.status(400).json({
                success: false,
                message: 'An explanation is required. It is sent to the citizen and shown on the public map.'
            });
        }

        const check = await db.query('SELECT status, closed_at, duplicate_of FROM issues WHERE id = $1', [id]);
        if (check.rows.length === 0) return res.status(404).json({ success: false, message: 'Issue not found' });
        if (check.rows[0].closed_at) {
            return res.status(409).json({ success: false, message: 'This report is already closed.' });
        }
        if (check.rows[0].duplicate_of) {
            return res.status(400).json({
                success: false,
                message: 'This is a duplicate. Close the original report instead.'
            });
        }

        const explanation = note.trim();

        await db.query(
            `UPDATE issues
             SET closed_at = CURRENT_TIMESTAMP, closed_by = $1,
                 closure_reason = $2, closure_note = $3, updated_at = CURRENT_TIMESTAMP
             WHERE id = $4 OR duplicate_of = $4`,
            [req.admin.id, reason, explanation, id]
        );

        await db.query(
            `INSERT INTO issue_tracker (issue_id, action, description, performed_by)
             VALUES ($1, 'closed', $2, $3)`,
            [id, `Closed without resolution (${reason}): ${explanation}`, req.admin.id]
        );

        // Tell everyone who reported it. A report that goes quiet is worse than
        // one that is refused with a reason.
        try {
            const reporters = await db.query(`
                SELECT i.ticket_id, i.title, u.phone_number
                FROM issues i
                JOIN users u ON i.reported_by = u.id
                WHERE (i.id = $1 OR i.duplicate_of = $1) AND u.phone_number IS NOT NULL
            `, [id]);

            for (const row of reporters.rows) {
                await whatsappService.sendMessage(row.phone_number,
                    `📁 *Report Closed*\n\nYour report *${row.title}* (#${row.ticket_id}) has been closed without a repair.\n\n`
                    + `*Reason:* ${CLOSURE_REASONS[reason]}\n\n`
                    + `📝 *Explanation:*\n${explanation}\n\n`
                    + `If the problem is still there, please send a new report and we will look again.`);
            }
        } catch (notifyErr) {
            console.error('Error notifying reporters of closure:', notifyErr);
        }

        res.json({ success: true, message: 'Report closed' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// POST /api/admin/issues/:id/reopen - Reopen a closed report.
//
// Whoever can close can reopen, so a wrongly closed report is fixable by the
// people who noticed rather than waiting on an escalation. The status returns
// to Acknowledged: the institution has demonstrably seen this report, so
// sending it back to newly-reported would misstate where it stands.
router.post('/admin/issues/:id/reopen', requireAdmin, attachScope, async (req, res) => {
    try {
        const { id } = req.params;
        if (!(await canAccessIssue(req.scope, id))) {
            return res.status(403).json({
                success: false,
                message: 'This report is not assigned to your institution.'
            });
        }

        const { note } = req.body;
        if (!note || !note.trim()) {
            return res.status(400).json({
                success: false,
                message: 'A note is required when reopening a report, so the record shows why.'
            });
        }

        const check = await db.query('SELECT closed_at, status FROM issues WHERE id = $1', [id]);
        if (check.rows.length === 0) return res.status(404).json({ success: false, message: 'Issue not found' });
        if (!check.rows[0].closed_at) {
            return res.status(409).json({ success: false, message: 'This report is already open.' });
        }
        if (check.rows[0].status === 'spam') {
            return res.status(403).json({ success: false, message: 'Unflag the report as spam before reopening it.' });
        }

        const reason = note.trim();

        await db.query(
            `UPDATE issues
             SET closed_at = NULL, closed_by = NULL, closure_reason = NULL, closure_note = NULL,
                 resolution_note = NULL, status = 'acknowledged', updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 OR duplicate_of = $1`,
            [id]
        );

        await db.query(
            `INSERT INTO issue_tracker (issue_id, action, description, performed_by)
             VALUES ($1, 'reopened', $2, $3)`,
            [id, `Reopened: ${reason}`, req.admin.id]
        );

        try {
            const reporters = await db.query(`
                SELECT i.ticket_id, i.title, u.phone_number
                FROM issues i
                JOIN users u ON i.reported_by = u.id
                WHERE (i.id = $1 OR i.duplicate_of = $1) AND u.phone_number IS NOT NULL
            `, [id]);

            for (const row of reporters.rows) {
                await whatsappService.sendMessage(row.phone_number,
                    `🔄 *Report Reopened*\n\nYour report *${row.title}* (#${row.ticket_id}) has been reopened and is being looked at again.\n\n`
                    + `📝 *Reason:*\n${reason}`);
            }
        } catch (notifyErr) {
            console.error('Error notifying reporters of reopening:', notifyErr);
        }

        res.json({ success: true, message: 'Report reopened' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// POST /api/admin/issues/:id/mark-duplicate - Mark an issue as duplicate
router.post('/admin/issues/:id/mark-duplicate', requireAdmin, attachScope, async (req, res) => {
    try {
        const { id } = req.params;
        // An MDA may only act on reports in the categories it is responsible
        // for. Checked per issue, because the id comes straight from the URL.
        if (!(await canAccessIssue(req.scope, id))) {
            return res.status(403).json({
                success: false,
                message: 'This report is not assigned to your institution.'
            });
        }

        const { original_issue_id, note } = req.body;

        if (!original_issue_id) {
            return res.status(400).json({ success: false, message: 'Original issue ID (parent issue) is required' });
        }

        // Check if target issue is spam
        const targetIssue = await db.query('SELECT status FROM issues WHERE id = $1', [id]);
        if (targetIssue.rows.length > 0 && targetIssue.rows[0].status === 'spam') {
             return res.status(403).json({ success: false, message: 'Cannot mark a SPAM issue as duplicate.' });
        }

        // 0. Get original issue status
        const originalIssue = await db.query('SELECT ticket_id, status FROM issues WHERE id = $1', [original_issue_id]);
        if (originalIssue.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Original issue not found' });
        }
        const { ticket_id: originalTicketId, status: originalStatus } = originalIssue.rows[0];

        // 1. Update issue: Set duplicate_of AND sync status
        await db.query(
            `UPDATE issues
             SET duplicate_of = $1, status = $2, updated_at = CURRENT_TIMESTAMP,
                 closed_at = CURRENT_TIMESTAMP, closed_by = $3, closure_reason = 'duplicate'
             WHERE id = $4`,
            [original_issue_id, originalStatus, req.admin.id, id]
        );

        // 3. Log to Tracker
        const description = note || `Marked as duplicate of ticket ${originalTicketId}`;
        await db.query(`
            INSERT INTO issue_tracker (issue_id, action, description, performed_by)
            VALUES ($1, 'duplicate', $2, $3)
        `, [id, description, req.admin.id]);

        res.json({ success: true, message: 'Marked as duplicate successfully' });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// PUT /api/admin/issues/:id/details - Edit Issue Details
router.put('/admin/issues/:id/details', requireAdmin, attachScope, async (req, res) => {
    try {
        const { id } = req.params;
        // An MDA may only act on reports in the categories it is responsible
        // for. Checked per issue, because the id comes straight from the URL.
        if (!(await canAccessIssue(req.scope, id))) {
            return res.status(403).json({
                success: false,
                message: 'This report is not assigned to your institution.'
            });
        }

        const { title, description, category } = req.body;

        if (!title || !description || !category) {
            return res.status(400).json({ success: false, message: 'Title, description, and category are required' });
        }

        // Check if issue is spam
        const check = await db.query('SELECT status, category FROM issues WHERE id = $1', [id]);
        if (check.rows.length === 0) return res.status(404).json({ success: false, message: 'Issue not found' });
        if (check.rows[0].status === 'spam') {
             return res.status(403).json({ success: false, message: 'Cannot edit details of a SPAM issue.' });
        }
        const previousCategory = check.rows[0].category;

        // Update issue
        const sql = `UPDATE issues SET title = $1, description = $2, category = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4`;
        await db.query(sql, [title, description, category, id]);

        // Log to tracker
        const reassigned = previousCategory !== category;
        await db.query(`
            INSERT INTO issue_tracker (issue_id, action, description, performed_by)
            VALUES ($1, $2, $3, $4)
        `, [
            id,
            reassigned ? 'reassigned' : 'edited',
            reassigned
                ? `Reassigned from ${previousCategory} to ${category}`
                : 'Issue details updated by admin',
            req.admin.id
        ]);

        // Changing the category changes which institution is responsible. The
        // new MDA had no way of knowing that until now -- the report simply
        // appeared in their list, with nobody told it had arrived.
        if (reassigned) {
            try {
                const moved = await db.query('SELECT id, ticket_id, title, category, address, lat, lng FROM issues WHERE id = $1', [id]);
                if (moved.rows.length > 0) {
                    const issue = moved.rows[0];
                    await fixamHandler.notifyResponsibleTeam(issue,
                        `📌 *Report Reassigned To You*\n\n`
                        + `*${issue.title}* (${issue.ticket_id})\n`
                        + `*Category:* ${issue.category} (was ${previousCategory})\n`
                        + `*Loc:* ${issue.address || `${issue.lat}, ${issue.lng}`}\n\n`
                        + `This report is now your institution's responsibility.`);
                }
            } catch (notifyErr) {
                // The reassignment itself succeeded; a failed alert must not undo it.
                console.error('Error notifying the newly responsible MDA:', notifyErr);
            }
        }

        res.json({ success: true, message: 'Issue details updated successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// PUT /api/admin/issues/:id/spam - Flag Issue as Spam
router.put('/admin/issues/:id/spam', requireAdmin, attachScope, async (req, res) => {
    try {
        const { id } = req.params;
        // An MDA may only act on reports in the categories it is responsible
        // for. Checked per issue, because the id comes straight from the URL.
        if (!(await canAccessIssue(req.scope, id))) {
            return res.status(403).json({
                success: false,
                message: 'This report is not assigned to your institution.'
            });
        }

        const { reason } = req.body;

         // Update issue status to spam
        await db.query(
            `UPDATE issues SET status = 'spam', resolution_note = $1, updated_at = CURRENT_TIMESTAMP,
                    closed_at = CURRENT_TIMESTAMP, closed_by = $2, closure_reason = 'spam'
             WHERE id = $3`,
            [reason || 'Flagged as spam', req.admin.id, id]
        );
        
        // Mark duplicates as spam too
        await db.query(
            `UPDATE issues SET status = 'spam', resolution_note = $1, updated_at = CURRENT_TIMESTAMP,
                    closed_at = CURRENT_TIMESTAMP, closed_by = $2, closure_reason = 'spam'
             WHERE duplicate_of = $3`,
            ["Original issue flagged as spam", req.admin.id, id]
        );

        // Log to tracker
        await db.query(`
            INSERT INTO issue_tracker (issue_id, action, description, performed_by)
            VALUES ($1, 'flagged_spam', $2, $3)
        `, [id, reason || 'Flagged as Spam', req.admin.id]);
        
        // Notify Reporter
         try {
            const reporterRes = await db.query(`
                SELECT i.ticket_id, i.title, u.phone_number, u.id as user_id
                FROM issues i
                JOIN users u ON i.reported_by = u.id
                WHERE i.id = $1
            `, [id]);

            if (reporterRes.rows.length > 0) {
                 const { ticket_id, title, phone_number, user_id } = reporterRes.rows[0];
                 if (phone_number) {
                     const msg = `⚠️ *Issue Flagged*\n\nYour reported issue *${title}* (#${ticket_id}) has been flagged as *SPAM* or violating our community guidelines.\n\nIt has been removed from public view. If you believe this is a mistake, please contact support.`;
                     await whatsappService.sendMessage(phone_number, msg);
                 }
                 
                 // Penalty: -5 points
                  await db.query('UPDATE users SET points = GREATEST(0, points - 5) WHERE id = $1', [user_id]);
                  await db.query(`INSERT INTO user_point_logs (user_id, amount, action_type, related_issue_id) VALUES ($1, -5, 'spam_penalty', $2)`, [user_id, id]);
            }
        } catch (notifyErr) {
            console.error('Error notifying reporter of spam:', notifyErr);
        }

        res.json({ success: true, message: 'Issue flagged as spam successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// POST /api/admin/issues/:id/unlink-duplicate - Unlink a duplicate issue
router.post('/admin/issues/:id/unlink-duplicate', requireAdmin, attachScope, async (req, res) => {
    try {
        const { id } = req.params;
        const { note } = req.body;

        // 1. Update issue
        await db.query('UPDATE issues SET duplicate_of = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

        // 2. Log to Tracker
        const description = note || `Unlinked from original issue (marked as unique)`;
        await db.query(`
            INSERT INTO issue_tracker (issue_id, action, description, performed_by)
            VALUES ($1, $2, $3, $4)
        `, [id, 'unlinked_duplicate', description, req.admin.id]);

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
router.get('/admin/users', requireAdmin, attachScope, async (req, res) => {
    try {
        const { search, role, group, sort, page = 1, limit = 8 } = req.query;
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const offset = (pageNum - 1) * limitNum;

        // Base filter clauses for both main query and count query
        let filterClauses = ' WHERE 1=1';
        const filterParams = [];
        let pCount = 1;

        // An MDA user may view their own colleagues, not the whole directory.
        if (!req.scope.unrestricted) {
            if (req.scope.groupIds.length === 0) {
                filterClauses += ' AND FALSE';
            } else {
                filterClauses += ` AND u.id IN (SELECT user_id FROM user_groups WHERE group_id = ANY($${pCount}))`;
                filterParams.push(req.scope.groupIds);
                pCount++;
            }
        }

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
router.post('/admin/users/:id/penalize', requireFullAdmin, attachScope, async (req, res) => {
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
router.post('/admin/users', requireFullAdmin, attachScope, async (req, res) => {
    try {
        const { phone_number, name, password, roles, groups } = req.body;
        if (!phone_number) return res.status(400).json({ error: 'Phone number is required' });

        // Check if phone number already exists
        const checkUser = await db.query('SELECT id FROM users WHERE phone_number = $1', [phone_number]);
        if (checkUser.rows.length > 0) {
            return res.status(400).json({ error: 'A user with this phone number already exists' });
        }

        // hashPassword is async and takes only the password; calling it the old
        // way stored the string "[object Promise]" as the account's password.
        const hashedPassword = password ? await authService.hashPassword(password) : null;

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
router.put('/admin/users/:id', requireFullAdmin, attachScope, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, phone_number, is_disabled, roles, groups, password } = req.body;

        // 1. Prevent self-disabling
        if (id == req.admin.id && is_disabled === true) {
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
            const hashedPassword = await authService.hashPassword(password);
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
router.delete('/admin/users/:id', requireFullAdmin, attachScope, async (req, res) => {
    try {
        const { id } = req.params;

        // Prevent self-deletion
        if (id == req.admin.id) {
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
router.get('/admin/roles', requireAdmin, attachScope, async (req, res) => {
    try {
        const result = await db.query('SELECT name FROM roles ORDER BY name ASC');
        res.json(result.rows.map(r => r.name));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/admin/groups
router.get('/admin/groups', requireAdmin, attachScope, async (req, res) => {
    try {
        // MDA users see the groups they belong to; full Admins see all.
        const groupFilter = req.scope.unrestricted
            ? ''
            : (req.scope.groupIds.length ? ' WHERE g.id = ANY($1)' : ' WHERE FALSE');
        const groupParams = (!req.scope.unrestricted && req.scope.groupIds.length)
            ? [req.scope.groupIds] : [];

        const result = await db.query(`
            SELECT 
                g.*, 
                COUNT(DISTINCT ug.user_id) as member_count,
                COALESCE(
                    JSON_AGG(json_build_object('id', c.id, 'name', c.name, 'role', cg.role))
                    FILTER (WHERE c.id IS NOT NULL),
                    '[]'
                ) as categories
            FROM groups g
            LEFT JOIN user_groups ug ON g.id = ug.group_id
            LEFT JOIN category_groups cg ON g.id = cg.group_id
            LEFT JOIN categories c ON cg.category_id = c.id
            ${groupFilter}
            GROUP BY g.id
            ORDER BY g.name ASC
        `, groupParams);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST /api/admin/groups
router.post('/admin/groups', requireFullAdmin, attachScope, async (req, res) => {
    try {
        const { name, description, categories, lead_categories, is_default } = req.body; // categories is now array of IDs

        // Check for duplicate group name
        const checkGroup = await db.query('SELECT id FROM groups WHERE name = $1', [name]);
        if (checkGroup.rows.length > 0) {
            return res.status(400).json({ error: 'A group with this name already exists' });
        }

        const result = await db.query(
            'INSERT INTO groups (name, description, is_default) VALUES ($1, $2, $3) RETURNING id',
            [name, description, is_default === true]
        );
        const groupId = result.rows[0].id;

        // Assign Categories, marking the ones this group leads.
        if (categories && categories.length > 0) {
            const leads = new Set((lead_categories || []).map((c) => String(c)));
            for (const catId of categories) {
                await db.query(`
                    INSERT INTO category_groups (group_id, category_id, role)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (group_id, category_id) DO UPDATE SET role = EXCLUDED.role
                `, [groupId, parseInt(catId), leads.has(String(catId)) ? 'lead' : 'support']);
            }
        }

        res.json({ success: true, groupId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// PUT /api/admin/groups/:id
router.put('/admin/groups/:id', requireFullAdmin, attachScope, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, categories, lead_categories, is_default } = req.body;

        // Check if group name is taken by another group
        const checkGroup = await db.query('SELECT id FROM groups WHERE name = $1 AND id != $2', [name, id]);
        if (checkGroup.rows.length > 0) {
            return res.status(400).json({ error: 'Another group with this name already exists' });
        }

        await db.query(
            'UPDATE groups SET name = $1, description = $2 WHERE id = $3',
            [name, description, id]
        );

        if (is_default !== undefined) {
            await db.query('UPDATE groups SET is_default = $1 WHERE id = $2', [is_default === true, id]);
        }

        // Update Categories, preserving which of them this group leads.
        if (categories) {
            const leads = new Set((lead_categories || []).map((c) => String(c)));
            await db.query('DELETE FROM category_groups WHERE group_id = $1', [id]);
            for (const catId of categories) {
                await db.query(`
                    INSERT INTO category_groups (group_id, category_id, role)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (group_id, category_id) DO UPDATE SET role = EXCLUDED.role
                `, [id, parseInt(catId), leads.has(String(catId)) ? 'lead' : 'support']);
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// DELETE /api/admin/groups/:id
router.delete('/admin/groups/:id', requireFullAdmin, attachScope, async (req, res) => {
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
router.get('/admin/feedback', requireAdmin, attachScope, async (req, res) => {
    try {
        const feedback = await fixamHandler.fixamDb.getFeedback(req.scope);
        res.json(feedback);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * Can this caller act on this piece of feedback?
 *
 * Same rule as reports: an MDA acts on what is routed to it. Platform feedback
 * and unclassified feedback belong to the Admins.
 */
async function canAccessFeedback(scope, feedbackId) {
    if (scope.unrestricted) return true;
    if (!scope.groupIds || scope.groupIds.length === 0) return false;

    const result = await db.query(
        'SELECT scope, routed_group_id FROM feedback WHERE id = $1',
        [feedbackId]
    );
    if (result.rows.length === 0) return false;

    const row = result.rows[0];
    return row.scope === 'service' && scope.groupIds.includes(row.routed_group_id);
}

// PUT /api/admin/feedback/:id/routing - Admin override of where feedback goes.
//
// Full Admin only. Routing decides which institution is answerable for a piece
// of feedback, so an MDA being able to push its own feedback elsewhere would
// defeat the point of routing it there.
router.put('/admin/feedback/:id/routing', requireFullAdmin, attachScope, async (req, res) => {
    try {
        const { id } = req.params;
        const { scope, category } = req.body;

        if (!['platform', 'service', 'unclassified'].includes(scope)) {
            return res.status(400).json({
                success: false,
                message: 'Scope must be platform, service or unclassified.'
            });
        }

        let groupId = null;
        if (scope === 'service') {
            if (!category) {
                return res.status(400).json({
                    success: false,
                    message: 'Service feedback needs a category so it can reach an MDA.'
                });
            }
            groupId = await fixamHandler.fixamDb.getLeadGroupForCategory(category);
            if (!groupId) {
                return res.status(400).json({
                    success: false,
                    message: `No MDA is mapped to "${category}". Assign one under Categories first.`
                });
            }
        }

        const ok = await fixamHandler.fixamDb.setFeedbackRouting(id, {
            scope,
            category: scope === 'service' ? category : null,
            groupId,
            source: 'admin',
            confidence: null,
            adminId: req.admin.id
        });

        if (!ok) return res.status(404).json({ success: false, message: 'Feedback not found' });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST /api/admin/feedback/classify - Classify everything still unclassified.
//
// Covers the backlog that arrived before routing existed, and anything the AI
// service was down for. Only touches unclassified rows: a decision an admin
// already made is not something a model gets to revisit.
router.post('/admin/feedback/classify', requireFullAdmin, attachScope, async (req, res) => {
    try {
        const pending = await db.query(
            `SELECT id, content, transcription FROM feedback
             WHERE scope IS NULL OR scope IN ('unclassified', 'suggested')`
        );

        let routed = 0;
        let suggested = 0;
        let left = 0;
        let failed = 0;

        for (const row of pending.rows) {
            const text = (row.transcription || row.content || '').trim();
            if (!text) { left++; continue; }

            const analysis = await aiService.analyzeFeedback(text);
            if (!analysis) { failed++; continue; }

            if (analysis.auto_routable) {
                // Platform feedback: filed, because its destination is fixed.
                await fixamHandler.fixamDb.setFeedbackRouting(row.id, {
                    scope: 'platform',
                    category: null,
                    groupId: null,
                    source: 'ai',
                    confidence: analysis.confidence,
                    adminId: null
                });
                routed++;
            } else if (analysis.scope === 'service') {
                // Service feedback: suggested, because the category guess is
                // not accurate enough to put in front of an MDA unreviewed.
                await fixamHandler.fixamDb.setFeedbackRouting(row.id, {
                    scope: 'suggested',
                    category: analysis.suggested_category,
                    groupId: null,
                    source: 'ai_suggested',
                    confidence: analysis.confidence,
                    adminId: null
                });
                suggested++;
            } else {
                left++;
            }
        }

        res.json({
            success: true,
            examined: pending.rows.length,
            routed,
            suggested,
            needs_review: left,
            failed
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST /api/admin/feedback/:id/acknowledge
router.post('/admin/feedback/:id/acknowledge', requireAdmin, attachScope, async (req, res) => {
    try {
        const { id } = req.params;
        if (!(await canAccessFeedback(req.scope, id))) {
            return res.status(403).json({
                success: false,
                message: 'This feedback is not routed to your institution.'
            });
        }
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


/**
 * Turn rows into CSV.
 *
 * Values are quoted and internal quotes doubled, and anything starting with
 * =, +, - or @ is prefixed with a quote: spreadsheet software treats those as
 * formulas, so a report description could otherwise execute when an officer
 * opens the file.
 */
function toCsv(rows, columns) {
    const escape = (value) => {
        if (value === null || value === undefined) return '';
        let text = value instanceof Date ? value.toISOString() : String(value);
        if (/^[=+\-@]/.test(text)) text = `'${text}`;
        return `"${text.replace(/"/g, '""')}"`;
    };

    const header = columns.map((c) => escape(c.label)).join(',');
    const body = rows.map((row) => columns.map((c) => escape(row[c.key])).join(',')).join('\n');
    return `${header}\n${body}\n`;
}

// GET /api/admin/export/issues.csv - Export reports.
//
// Scoped exactly like the portal: an MDA exports its own categories and nothing
// else. Personal data is excluded unless a full Admin explicitly asks for it
// via ?include_personal=true, because an export leaves the platform and stops
// being governed by it -- it lands in a spreadsheet, an inbox, a laptop.
router.get('/admin/export/issues.csv', requireAdmin, attachScope, async (req, res) => {
    try {
        // Name and phone are chosen independently. They are not the same
        // disclosure: a list of names is a weaker thing to hold than a list of
        // reachable phone numbers, and an export that only needs one should not
        // carry the other.
        const wantsName = req.query.include_name === 'true';
        const wantsPhone = req.query.include_phone === 'true';
        const isFullAdmin = req.scope.unrestricted;

        if ((wantsName || wantsPhone) && !isFullAdmin) {
            // Recorded, not just refused. Someone reaching for contact details
            // they are not entitled to is precisely the event this log exists
            // for, and a refusal leaves no other trace.
            const asked = [wantsName && 'names', wantsPhone && 'phone numbers']
                .filter(Boolean).join(' and ');
            await auditLog.record(req, {
                action: 'export.refused',
                targetType: 'export',
                targetLabel: `reporter ${asked}`,
                detail: `REFUSED — ${(req.scope.groupNames || []).join(', ') || 'no institution'} `
                    + `requested reporter ${asked} without the Admin role`
            });
            return res.status(403).json({
                success: false,
                message: 'Only a full Administrator may export reporter contact details.'
            });
        }

        const params = [];
        let where = '';
        if (!req.scope.unrestricted) {
            if (!req.scope.categories || req.scope.categories.length === 0) {
                where = ' AND FALSE';
            } else {
                params.push(req.scope.categories);
                where = ` AND i.category = ANY($${params.length})`;
            }
        }

        const result = await db.query(`
            SELECT i.ticket_id, i.title, i.description, i.category, i.status,
                   i.district, i.city, i.ward, i.address, i.lat, i.lng,
                   i.created_at, i.updated_at, i.closed_at, i.closure_reason,
                   i.closure_note, i.resolution_note, i.dispute_count,
                   u.name AS reporter_name, u.phone_number AS reporter_phone
            FROM issues i
            LEFT JOIN users u ON i.reported_by = u.id
            WHERE 1=1${where}
            ORDER BY i.created_at DESC
        `, params);

        const columns = [
            { key: 'ticket_id', label: 'Ticket' },
            { key: 'title', label: 'Title' },
            { key: 'description', label: 'Description' },
            { key: 'category', label: 'Category' },
            { key: 'status', label: 'Status' },
            { key: 'district', label: 'District' },
            { key: 'city', label: 'City' },
            { key: 'ward', label: 'Ward' },
            { key: 'address', label: 'Address' },
            { key: 'lat', label: 'Latitude' },
            { key: 'lng', label: 'Longitude' },
            { key: 'created_at', label: 'Reported At' },
            { key: 'updated_at', label: 'Last Updated' },
            { key: 'closed_at', label: 'Closed At' },
            { key: 'closure_reason', label: 'Closure Reason' },
            { key: 'closure_note', label: 'Closure Explanation' },
            { key: 'resolution_note', label: 'Resolution Note' },
            { key: 'dispute_count', label: 'Citizen Disputes' }
        ];

        if (wantsName) columns.push({ key: 'reporter_name', label: 'Reporter Name' });
        if (wantsPhone) columns.push({ key: 'reporter_phone', label: 'Reporter Phone' });

        // Recorded whether or not it contained personal data, naming exactly
        // which fields: "who exported what, and did it include contact details"
        // is the question this log exists to answer, and "personal data: yes"
        // does not answer it precisely enough to be useful later.
        const included = [wantsName && 'names', wantsPhone && 'phone numbers']
            .filter(Boolean).join(' + ') || 'none';
        await auditLog.record(req, {
            action: 'export.issues',
            targetType: 'export',
            targetLabel: `${result.rows.length} reports`,
            detail: `${result.rows.length} rows; personal data: ${included}; `
                + `scope: ${req.scope.unrestricted ? 'all categories' : (req.scope.groupNames || []).join(', ') || 'none'}`
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition',
            `attachment; filename="fixam-reports-${new Date().toISOString().slice(0, 10)}.csv"`);
        res.send(toCsv(result.rows, columns));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/admin/export/audit.csv - Export the administrative audit trail.
//
// Full Admin only. The audit log records who was granted access to what, so
// handing it to every account would defeat part of its purpose.
router.get('/admin/export/audit.csv', requireFullAdmin, attachScope, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT created_at, actor_name, actor_phone, action,
                   target_type, target_id, target_label, detail, ip_address
            FROM admin_audit
            ORDER BY created_at DESC
        `);

        await auditLog.record(req, {
            action: 'export.audit',
            targetType: 'export',
            targetLabel: `${result.rows.length} audit entries`,
            detail: `${result.rows.length} rows`
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition',
            `attachment; filename="fixam-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
        res.send(toCsv(result.rows, [
            { key: 'created_at', label: 'When' },
            { key: 'actor_name', label: 'Who' },
            { key: 'actor_phone', label: 'Phone' },
            { key: 'action', label: 'Action' },
            { key: 'target_type', label: 'Target Type' },
            { key: 'target_id', label: 'Target ID' },
            { key: 'target_label', label: 'Target' },
            { key: 'detail', label: 'Detail' },
            { key: 'ip_address', label: 'IP Address' }
        ]));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/admin/audit - Read the administrative audit trail. Full Admin only.
router.get('/admin/audit', requireFullAdmin, attachScope, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
        const result = await db.query(`
            SELECT id, created_at, actor_name, action, target_type, target_id,
                   target_label, detail
            FROM admin_audit
            ORDER BY created_at DESC
            LIMIT $1
        `, [limit]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

module.exports = router;

