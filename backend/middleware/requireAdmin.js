const authService = require('../services/authService');
const db = require('../db');

/**
 * Gate for every administrative endpoint.
 *
 * Before this existed the only check was an `X-Admin-Access: true` request
 * header, which any caller could send. Changing an issue's status, marking a
 * report as spam, editing the category-to-MDA routing, creating or deleting
 * users -- all of it was reachable without credentials.
 *
 * The token is verified on every request, and the account is re-checked against
 * the database rather than trusted from the payload: a token issued before an
 * account was disabled or demoted must stop working immediately.
 */
function extractToken(req) {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) return header.slice(7).trim();
    return null;
}

async function requireAdmin(req, res, next) {
    const token = extractToken(req);
    const payload = authService.verifyToken(token);

    if (!payload) {
        return res.status(401).json({
            success: false,
            message: 'Authentication required. Please sign in again.',
        });
    }

    try {
        // Roles come from the database on every request, not from the token.
        // Otherwise revoking someone's access would not take effect until their
        // session happened to expire.
        const result = await db.query(
            `SELECT u.id, u.name, u.phone_number, u.is_disabled,
                    COALESCE(ARRAY_AGG(r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
             FROM users u
             LEFT JOIN user_roles ur ON u.id = ur.user_id
             LEFT JOIN roles r ON ur.role_id = r.id
             WHERE u.id = $1
             GROUP BY u.id`,
            [payload.uid]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Account no longer exists.' });
        }

        const user = result.rows[0];

        if (user.is_disabled) {
            return res.status(403).json({ success: false, message: 'This account has been disabled.' });
        }

        const roles = user.roles || [];
        if (!roles.includes('Admin') && !roles.includes('Operation')) {
            return res.status(403).json({
                success: false,
                message: 'Admin or Operations role required.',
            });
        }

        req.admin = { id: user.id, name: user.name, phone: user.phone_number, roles };
        next();
    } catch (err) {
        console.error('Admin authorisation check failed:', err);
        res.status(500).json({ success: false, message: 'Authorisation check failed.' });
    }
}

/** Stricter variant for actions only a full Admin should take. */
function requireFullAdmin(req, res, next) {
    requireAdmin(req, res, () => {
        if (!req.admin.roles.includes('Admin')) {
            return res.status(403).json({
                success: false,
                message: 'This action requires the Admin role.',
            });
        }
        next();
    });
}

module.exports = { requireAdmin, requireFullAdmin };
