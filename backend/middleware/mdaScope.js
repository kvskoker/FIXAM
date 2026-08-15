const db = require('../db');

/**
 * What an MDA user is allowed to see.
 *
 * A full Admin oversees the whole platform. An Operations user belongs to one
 * or more MDA groups and should only see the reports their institution is
 * responsible for -- the categories mapped to their groups.
 *
 * Returned shape:
 *   { unrestricted: true }                       - full Admin
 *   { unrestricted: false, categories: [...],    - MDA user
 *     groupIds: [...], groupNames: [...] }
 *
 * An Operations user in no group gets an empty category list, which correctly
 * shows them nothing: being unassigned should not mean seeing everything.
 */
async function getScope(admin) {
    if (!admin) return { unrestricted: false, categories: [], groupIds: [], groupNames: [] };

    if (admin.roles && admin.roles.includes('Admin')) {
        return { unrestricted: true, categories: null, groupIds: null, groupNames: null };
    }

    const result = await db.query(
        `SELECT g.id AS group_id, g.name AS group_name, c.name AS category
         FROM user_groups ug
         JOIN groups g ON ug.group_id = g.id
         LEFT JOIN category_groups cg ON cg.group_id = g.id
         LEFT JOIN categories c ON c.id = cg.category_id
         WHERE ug.user_id = $1`,
        [admin.id]
    );

    const categories = [];
    const groupIds = new Set();
    const groupNames = new Set();

    for (const row of result.rows) {
        groupIds.add(row.group_id);
        groupNames.add(row.group_name);
        if (row.category && !categories.includes(row.category)) categories.push(row.category);
    }

    return {
        unrestricted: false,
        categories,
        groupIds: [...groupIds],
        groupNames: [...groupNames],
    };
}

/**
 * Attach the scope to the request so handlers can filter without each of them
 * re-deriving it. Must run after requireAdmin.
 */
async function attachScope(req, res, next) {
    try {
        req.scope = await getScope(req.admin);
        next();
    } catch (err) {
        console.error('Failed to resolve MDA scope:', err);
        res.status(500).json({ success: false, message: 'Could not determine your access scope.' });
    }
}

/**
 * Guard a single report. Returns true when the caller may act on it.
 *
 * Checked against the issue's category rather than who reported it: a report
 * belongs to the institution responsible for fixing it.
 */
async function canAccessIssue(scope, issueId) {
    if (scope.unrestricted) return true;
    if (!scope.categories || scope.categories.length === 0) return false;

    const result = await db.query('SELECT category FROM issues WHERE id = $1', [issueId]);
    if (result.rows.length === 0) return false;

    return scope.categories.includes(result.rows[0].category);
}

module.exports = { getScope, attachScope, canAccessIssue };
