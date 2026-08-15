const db = require('../db');
const logger = require('./logger');

/**
 * Record an administrative action.
 *
 * The actor's name and phone are copied in rather than only referenced, so the
 * record still says who did something after that account is deleted. An audit
 * trail that empties itself when someone removes their account would be worse
 * than none, because it would look complete.
 *
 * Never throws. A failure to write the audit row is logged loudly but does not
 * fail the action the administrator was performing -- refusing to save a user
 * because the audit table is unavailable would be a strange trade, and the
 * failure is visible in the service logs either way.
 */
async function record(req, { action, targetType, targetId, targetLabel, detail, actor }) {
    try {
        // `actor` covers the one case where the request cannot say who acted:
        // a successful sign-in, where authentication is the thing that just
        // happened. Everywhere else the verified session is the source.
        const admin = actor || req.admin || {};
        await db.query(
            `INSERT INTO admin_audit
                (actor_id, actor_name, actor_phone, action, target_type, target_id, target_label, detail, ip_address)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
                admin.id || null,
                admin.name || null,
                admin.phone || admin.phone_number || null,
                action,
                targetType || null,
                targetId != null ? String(targetId) : null,
                targetLabel || null,
                detail || null,
                // Behind nginx the direct socket address is the proxy, so the
                // forwarded header is preferred where present.
                (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null
            ]
        );
    } catch (err) {
        logger.logError('audit', `Failed to record ${action}`, err);
    }
}

/**
 * Describe a change without dumping the whole record.
 *
 * Only the fields that actually changed, and never a password -- an audit log
 * is read by more people than the table it describes.
 */
function describeChange(before, after, fields) {
    const parts = [];
    for (const field of fields) {
        const from = before ? before[field] : undefined;
        const to = after ? after[field] : undefined;
        if (from === undefined && to === undefined) continue;

        const a = Array.isArray(from) ? from.join(', ') : from;
        const b = Array.isArray(to) ? to.join(', ') : to;
        if (String(a ?? '') !== String(b ?? '')) {
            parts.push(`${field}: ${a ?? '(none)'} -> ${b ?? '(none)'}`);
        }
    }
    return parts.length ? parts.join('; ') : 'no field changes';
}

module.exports = { record, describeChange };

/**
 * Classify an admin request into an audit action.
 *
 * Route-pattern based rather than a call inside each handler, so a new admin
 * endpoint is audited by existing in the URL space rather than by whoever adds
 * it remembering to log. Anything unrecognised is not audited -- reads are not
 * worth recording, and guessing at unknown routes would fill the log with
 * noise that hides the entries that matter.
 */
const AUDITED = [
    [/^\/admin\/users\/?$/,            { POST: 'user.create' },                       'user'],
    [/^\/admin\/users\/(\d+)$/,        { PUT: 'user.update', DELETE: 'user.delete' }, 'user'],
    [/^\/admin\/groups\/?$/,           { POST: 'group.create' },                      'group'],
    [/^\/admin\/groups\/(\d+)$/,       { PUT: 'group.update', DELETE: 'group.delete' }, 'group'],
    [/^\/admin\/categories\/?$/,       { POST: 'category.create' },                   'category'],
    [/^\/admin\/categories\/(\d+)$/,   { PUT: 'category.update', DELETE: 'category.delete' }, 'category'],
    [/^\/admin\/login\/?$/,            { POST: 'auth.login' },                        'session'],
];

// Never written to the audit log, whatever route they arrive on.
const NEVER_LOG = new Set(['password', 'new_password', 'current_password', 'token', 'secret']);

function summariseBody(body) {
    if (!body || typeof body !== 'object') return null;
    const parts = [];
    for (const [k, v] of Object.entries(body)) {
        if (NEVER_LOG.has(k)) { parts.push(`${k}: (set)`); continue; }
        if (v === undefined || v === null || v === '') continue;
        const text = Array.isArray(v) ? v.join(', ') : String(v);
        parts.push(`${k}: ${text.length > 80 ? text.slice(0, 80) + '…' : text}`);
    }
    return parts.join('; ') || null;
}

function classify(method, path) {
    for (const [pattern, methods, targetType] of AUDITED) {
        const m = path.match(pattern);
        if (m && methods[method]) {
            return { action: methods[method], targetType, targetId: m[1] || null };
        }
    }
    return null;
}

/**
 * Record admin mutations after they succeed.
 *
 * Wraps res.json so the outcome is known: an attempt that was refused with a
 * 403 is recorded as a failure rather than as a change that never happened.
 */
function auditAdminMutations(req, res, next) {
    const match = classify(req.method, req.path);
    if (!match) return next();

    const originalJson = res.json.bind(res);
    res.json = (body) => {
        const failed = res.statusCode >= 400;

        // A rejected sign-in is the entry a security review most wants, so it
        // is recorded under its own action rather than as a failed login.
        // A refused sign-in is recorded under its own action. A failed second
        // factor is recorded separately again: it means someone had the
        // password, which is a materially different event from a wrong password
        // and the one worth looking into.
        let action = match.action;
        if (match.action === 'auth.login' && failed) {
            action = body && body.requires_otp ? 'auth.otp_failed' : 'auth.login_failed';
        }

        // The login body carries the password and, on failure, an attacker's
        // guess at a phone number; only the identity attempted is useful.
        const detail = match.action === 'auth.login'
            ? `phone: ${req.body && req.body.phone ? req.body.phone : '(none)'}`
            : summariseBody(req.body);

        // On a successful sign-in the identity is only known from the response.
        // Passed as an override rather than by copying the request: spreading an
        // Express request drops `headers`, which silently broke every sign-in
        // audit entry until it was caught.
        const actor = (action === 'auth.login' && !failed && body && body.user)
            ? { id: body.user.id, name: body.user.name, phone: body.user.phone }
            : null;

        record(req, {
            actor,
            action,
            targetType: match.targetType,
            targetId: match.targetId,
            targetLabel: (req.body && (req.body.name || req.body.phone)) || null,
            detail: failed ? `REFUSED (${res.statusCode}) — ${detail || 'no detail'}` : detail
        });

        return originalJson(body);
    };

    next();
}

module.exports.auditAdminMutations = auditAdminMutations;
module.exports.summariseBody = summariseBody;
module.exports.classify = classify;
