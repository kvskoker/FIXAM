const express = require('express');
const router = express.Router();
const db = require('../db');
const logger = require('../services/logger');
const auditLog = require('../services/auditLog');
const botFlow = require('../services/botFlow');
const { validateDefinition } = require('../services/botFlowValidation');
const { requireAdmin, requireFullAdmin } = require('../middleware/requireAdmin');
const { attachScope } = require('../middleware/mdaScope');

/**
 * Authoring and approval of follow-up questionnaires.
 *
 * An institution writes its own questions -- EDSA knows it needs a meter number
 * and MoCTI does not -- but nothing an institution writes reaches a citizen
 * until an administrator has approved it. The questions go out under the
 * platform's name to people who did not ask to be surveyed, so somebody who is
 * accountable for the platform as a whole reads them first.
 */

const EDITABLE_STATES = ['draft', 'changes_requested'];

/** Does this caller own this questionnaire? Full Admins own everything. */
function ownsFlow(scope, flow) {
    if (scope.unrestricted) return true;
    return Boolean(flow.group_id) && (scope.groupIds || []).includes(flow.group_id);
}

async function loadFlow(id) {
    const result = await db.query(
        `SELECT f.*, g.name AS group_name
         FROM bot_flows f LEFT JOIN groups g ON g.id = f.group_id
         WHERE f.id = $1`,
        [id]
    );
    return result.rows[0] || null;
}

async function loadVersion(id) {
    const result = await db.query(
        `SELECT v.*, f.id AS flow_id, f.key AS flow_key, f.name AS flow_name,
                f.group_id, f.category, g.name AS group_name
         FROM bot_flow_versions v
         JOIN bot_flows f ON f.id = v.flow_id
         LEFT JOIN groups g ON g.id = f.group_id
         WHERE v.id = $1`,
        [id]
    );
    return result.rows[0] || null;
}

// GET /api/admin/bot-flows — questionnaires this caller may see.
router.get('/admin/bot-flows', requireAdmin, attachScope, async (req, res) => {
    try {
        const params = [];
        let where = '';

        // An MDA sees its own questionnaires. It has no business reading what
        // another institution asks its citizens.
        if (!req.scope.unrestricted) {
            if (!req.scope.groupIds || req.scope.groupIds.length === 0) {
                where = ' WHERE FALSE';
            } else {
                params.push(req.scope.groupIds);
                where = ` WHERE f.group_id = ANY($${params.length})`;
            }
        }

        const result = await db.query(
            `SELECT f.id, f.key, f.name, f.description, f.category, f.status,
                    f.group_id,
                    g.name AS group_name,
                    (SELECT version_number FROM bot_flow_versions
                      WHERE flow_id = f.id AND state = 'published') AS live_version,
                    (SELECT COUNT(*) FROM bot_flow_versions
                      WHERE flow_id = f.id AND state = 'pending_review') AS awaiting_review,
                    (SELECT COUNT(*) FROM bot_flow_versions
                      WHERE flow_id = f.id AND state IN ('draft', 'changes_requested')) AS drafts,
                    (SELECT COUNT(*) FROM bot_flow_runs r
                       JOIN bot_flow_versions v ON v.id = r.flow_version_id
                      WHERE v.flow_id = f.id AND NOT r.is_test) AS times_sent,
                    (SELECT COUNT(*) FROM bot_flow_runs r
                       JOIN bot_flow_versions v ON v.id = r.flow_version_id
                      WHERE v.flow_id = f.id AND r.state = 'completed' AND NOT r.is_test) AS times_completed
             FROM bot_flows f
             LEFT JOIN groups g ON g.id = f.group_id
             ${where}
             ORDER BY f.name`,
            params
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/admin/bot-flows/pending-count — for the review badge. Admin only.
router.get('/admin/bot-flows/pending-count', requireFullAdmin, attachScope, async (req, res) => {
    try {
        const result = await db.query(
            "SELECT COUNT(*) AS count FROM bot_flow_versions WHERE state = 'pending_review'"
        );
        res.json({ count: parseInt(result.rows[0].count, 10) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/admin/bot-flows/:id — one questionnaire with its full version history.
router.get('/admin/bot-flows/:id', requireAdmin, attachScope, async (req, res) => {
    try {
        const flow = await loadFlow(req.params.id);
        if (!flow) return res.status(404).json({ error: 'Questionnaire not found' });
        if (!ownsFlow(req.scope, flow)) {
            return res.status(403).json({ message: 'This questionnaire belongs to another institution.' });
        }

        const versions = await db.query(
            `SELECT v.id, v.version_number, v.definition, v.state, v.change_note, v.review_note,
                    v.created_at, v.submitted_at, v.reviewed_at, v.published_at,
                    c.name AS created_by_name, s.name AS submitted_by_name, r.name AS reviewed_by_name
             FROM bot_flow_versions v
             LEFT JOIN users c ON c.id = v.created_by
             LEFT JOIN users s ON s.id = v.submitted_by
             LEFT JOIN users r ON r.id = v.reviewed_by
             WHERE v.flow_id = $1
             ORDER BY v.version_number DESC`,
            [req.params.id]
        );

        res.json({ flow, versions: versions.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST /api/admin/bot-flows — create a questionnaire.
router.post('/admin/bot-flows', requireAdmin, attachScope, async (req, res) => {
    try {
        const { key, name, description, category, group_id } = req.body;

        if (!key || !/^[a-z][a-z0-9_]{2,59}$/.test(key)) {
            return res.status(400).json({ message: 'The key must be lower case letters, numbers and underscores.' });
        }
        if (!name || !name.trim()) return res.status(400).json({ message: 'A name is required.' });
        if (!category) return res.status(400).json({ message: 'Choose the report category this applies to.' });

        // A questionnaire without an owning institution has nobody to maintain
        // it and nobody to name to the citizen, so it is not a valid state.
        let owningGroup = group_id;
        if (req.scope.unrestricted) {
            if (!owningGroup) {
                return res.status(400).json({ message: 'Choose which institution is asking.' });
            }
            const exists = await db.query('SELECT 1 FROM groups WHERE id = $1', [owningGroup]);
            if (exists.rows.length === 0) {
                return res.status(400).json({ message: 'That institution does not exist.' });
            }
        }

        // An MDA creates only for itself and only for categories it owns.
        // Otherwise one institution could attach questions to another's reports.
        if (!req.scope.unrestricted) {
            owningGroup = (req.scope.groupIds || [])[0];
            if (!owningGroup) {
                return res.status(403).json({ message: 'Your account is not attached to an institution.' });
            }
            if (!(req.scope.categories || []).includes(category)) {
                return res.status(403).json({
                    message: `"${category}" is not one of your institution's categories.`
                });
            }
        }

        const existing = await db.query(
            'SELECT 1 FROM bot_flows WHERE category = $1 AND status = $2',
            [category, 'active']
        );
        if (existing.rows.length > 0) {
            return res.status(409).json({
                message: `A questionnaire already covers "${category}". `
                    + 'Edit that one rather than adding a second — only one can be live per category.'
            });
        }

        const created = await db.query(
            `INSERT INTO bot_flows (key, name, description, group_id, category)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [key.trim(), name.trim(), (description || '').trim() || null, owningGroup, category]
        );

        await auditLog.record(req, {
            action: 'bot_flow.create',
            targetType: 'bot_flow',
            targetId: created.rows[0].id,
            targetLabel: name.trim(),
            detail: `category: ${category}`
        });

        res.status(201).json(created.rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ message: 'That key is already used by another questionnaire.' });
        }
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// PUT /api/admin/bot-flows/:id/status — stop or resume asking.
//
// Deactivating is deliberately easier than activating. Turning questions off
// only ever means citizens are asked less, so the institution that owns the
// questionnaire can do it immediately -- waiting for approval to *stop* asking
// something would be the wrong way round. Turning them back on puts questions
// in front of citizens again, so it goes through an administrator, the same as
// publishing.
//
// Nothing is lost either way: versions, answers and history stay exactly as
// they are, and a citizen already part-way through a questionnaire finishes the
// one they started rather than being cut off mid-conversation.
router.put('/admin/bot-flows/:id/status', requireAdmin, attachScope, async (req, res) => {
    try {
        const flow = await loadFlow(req.params.id);
        if (!flow) return res.status(404).json({ error: 'Questionnaire not found' });
        if (!ownsFlow(req.scope, flow)) {
            return res.status(403).json({ message: 'This questionnaire belongs to another institution.' });
        }

        const { status } = req.body;
        if (!['active', 'inactive'].includes(status)) {
            return res.status(400).json({ message: 'Status must be active or inactive.' });
        }
        if (status === flow.status) {
            return res.json({ success: true, message: `Already ${status}.` });
        }

        if (status === 'active') {
            if (!req.scope.unrestricted) {
                return res.status(403).json({
                    message: 'Only an administrator can start a questionnaire asking again. '
                        + 'Ask MoCTI/DSTI to reactivate it.'
                });
            }

            // Only one questionnaire may cover a category, so reactivating has
            // to check that nothing took its place while it was off.
            const taken = await db.query(
                "SELECT name FROM bot_flows WHERE category = $1 AND status = 'active' AND id <> $2",
                [flow.category, flow.id]
            );
            if (taken.rows.length > 0) {
                return res.status(409).json({
                    message: `"${taken.rows[0].name}" now covers ${flow.category}. `
                        + 'Deactivate that one first.'
                });
            }
        }

        await db.query('UPDATE bot_flows SET status = $1 WHERE id = $2', [status, req.params.id]);

        await auditLog.record(req, {
            action: status === 'active' ? 'bot_flow.activate' : 'bot_flow.deactivate',
            targetType: 'bot_flow',
            targetId: req.params.id,
            targetLabel: flow.name,
            detail: `category "${flow.category}"`
        });

        res.json({
            success: true,
            message: status === 'inactive'
                ? 'Stopped. Citizens will no longer be asked these questions.'
                : 'Active again. Citizens will be asked these questions after acknowledgement.'
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// DELETE /api/admin/bot-flows/:id — remove a questionnaire entirely.
//
// Only when nobody has ever answered it. Deleting cascades to the versions and
// from there to the runs, which would destroy answers citizens took the trouble
// to give -- and those answers are evidence attached to real reports. A
// questionnaire that has been used is deactivated, never deleted.
//
// So this is for cleaning up a mistake: one created with the wrong category, or
// an experiment that never went anywhere.
router.delete('/admin/bot-flows/:id', requireFullAdmin, attachScope, async (req, res) => {
    try {
        const flow = await loadFlow(req.params.id);
        if (!flow) return res.status(404).json({ error: 'Questionnaire not found' });

        const used = await db.query(
            `SELECT COUNT(*) AS count
             FROM bot_flow_runs r
             JOIN bot_flow_versions v ON v.id = r.flow_version_id
             WHERE v.flow_id = $1 AND NOT r.is_test`,
            [req.params.id]
        );
        const timesUsed = parseInt(used.rows[0].count, 10);

        if (timesUsed > 0) {
            return res.status(409).json({
                message: `This questionnaire has been sent to ${timesUsed} citizen${timesUsed === 1 ? '' : 's'}, `
                    + 'and their answers are attached to reports. Deactivate it instead — '
                    + 'it will stop asking, and the answers already given stay where they are.'
            });
        }

        await db.query('DELETE FROM bot_flows WHERE id = $1', [req.params.id]);

        await auditLog.record(req, {
            action: 'bot_flow.delete',
            targetType: 'bot_flow',
            targetId: req.params.id,
            targetLabel: flow.name,
            detail: `category "${flow.category}"; never answered by any citizen`
        });

        res.json({ success: true, message: 'Questionnaire deleted.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST /api/admin/bot-flows/:id/versions — start a new draft.
router.post('/admin/bot-flows/:id/versions', requireAdmin, attachScope, async (req, res) => {
    try {
        const flow = await loadFlow(req.params.id);
        if (!flow) return res.status(404).json({ error: 'Questionnaire not found' });
        if (!ownsFlow(req.scope, flow)) {
            return res.status(403).json({ message: 'This questionnaire belongs to another institution.' });
        }

        const open = await db.query(
            `SELECT id, version_number, state FROM bot_flow_versions
             WHERE flow_id = $1 AND state IN ('draft', 'changes_requested', 'pending_review')
             LIMIT 1`,
            [req.params.id]
        );
        if (open.rows.length > 0) {
            return res.status(409).json({
                message: `Version ${open.rows[0].version_number} is already open for editing. `
                    + 'Finish or discard it first.',
                version_id: open.rows[0].id
            });
        }

        // A new draft starts as a copy of what is live, because editing is
        // almost always a change to the current questions rather than a blank page.
        const live = await db.query(
            "SELECT definition FROM bot_flow_versions WHERE flow_id = $1 AND state = 'published'",
            [req.params.id]
        );
        const starting = req.body.definition
            || (live.rows[0] && live.rows[0].definition)
            || { steps: [] };

        const next = await db.query(
            'SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM bot_flow_versions WHERE flow_id = $1',
            [req.params.id]
        );

        const created = await db.query(
            `INSERT INTO bot_flow_versions (flow_id, version_number, definition, state, created_by)
             VALUES ($1, $2, $3, 'draft', $4) RETURNING *`,
            [req.params.id, next.rows[0].n, starting, req.admin.id]
        );

        res.status(201).json(created.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// PUT /api/admin/bot-flow-versions/:id — save a draft.
router.put('/admin/bot-flow-versions/:id', requireAdmin, attachScope, async (req, res) => {
    try {
        const version = await loadVersion(req.params.id);
        if (!version) return res.status(404).json({ error: 'Version not found' });
        if (!ownsFlow(req.scope, version)) {
            return res.status(403).json({ message: 'This questionnaire belongs to another institution.' });
        }
        if (!EDITABLE_STATES.includes(version.state)) {
            return res.status(409).json({
                message: version.state === 'published'
                    ? 'A published version cannot be edited. Start a new draft instead.'
                    : 'This version is awaiting review and is locked so that what is reviewed is what goes live.'
            });
        }

        const { definition, change_note } = req.body;
        const { errors, warnings } = validateDefinition(definition);
        if (errors.length > 0) {
            return res.status(400).json({ message: 'The questionnaire has problems.', errors, warnings });
        }

        const updated = await db.query(
            `UPDATE bot_flow_versions SET definition = $1, change_note = $2, state = 'draft'
             WHERE id = $3 RETURNING *`,
            [definition, (change_note || '').trim() || null, req.params.id]
        );

        res.json({ version: updated.rows[0], warnings });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST /api/admin/bot-flow-versions/:id/submit — send a draft for approval.
router.post('/admin/bot-flow-versions/:id/submit', requireAdmin, attachScope, async (req, res) => {
    try {
        const version = await loadVersion(req.params.id);
        if (!version) return res.status(404).json({ error: 'Version not found' });
        if (!ownsFlow(req.scope, version)) {
            return res.status(403).json({ message: 'This questionnaire belongs to another institution.' });
        }
        if (!EDITABLE_STATES.includes(version.state)) {
            return res.status(409).json({ message: 'Only a draft can be submitted for review.' });
        }

        const { errors } = validateDefinition(version.definition);
        if (errors.length > 0) {
            return res.status(400).json({ message: 'Fix these before submitting.', errors });
        }

        await db.query(
            `UPDATE bot_flow_versions
             SET state = 'pending_review', submitted_by = $1, submitted_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [req.admin.id, req.params.id]
        );

        await auditLog.record(req, {
            action: 'bot_flow.submit',
            targetType: 'bot_flow_version',
            targetId: req.params.id,
            targetLabel: `${version.flow_name} v${version.version_number}`,
            detail: `${(version.definition.steps || []).length} questions`
        });

        res.json({ success: true, message: 'Sent to MoCTI/DSTI for approval.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * Make a version live and retire whatever it replaces.
 *
 * Shared by approval, direct publication and rollback so there is one place
 * where "what is live" changes.
 */
async function publishVersion(versionId, flowId) {
    await db.query(
        `UPDATE bot_flow_versions SET state = 'archived'
         WHERE flow_id = $1 AND state = 'published'`,
        [flowId]
    );
    await db.query(
        `UPDATE bot_flow_versions
         SET state = 'published', published_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [versionId]
    );
}

// POST /api/admin/bot-flow-versions/:id/approve — Admin only.
router.post('/admin/bot-flow-versions/:id/approve', requireFullAdmin, attachScope, async (req, res) => {
    try {
        const version = await loadVersion(req.params.id);
        if (!version) return res.status(404).json({ error: 'Version not found' });

        // A questionnaire an administrator wrote themselves is published
        // directly; approval is for work that came from an institution.
        const approvable = ['pending_review', 'draft', 'changes_requested'];
        if (!approvable.includes(version.state)) {
            return res.status(409).json({ message: 'This version cannot be published from its current state.' });
        }

        const { errors } = validateDefinition(version.definition);
        if (errors.length > 0) {
            return res.status(400).json({ message: 'This questionnaire has problems and cannot go live.', errors });
        }

        await db.query(
            `UPDATE bot_flow_versions
             SET reviewed_by = $1, reviewed_at = CURRENT_TIMESTAMP, review_note = $2
             WHERE id = $3`,
            [req.admin.id, (req.body.note || '').trim() || null, req.params.id]
        );
        await publishVersion(req.params.id, version.flow_id);

        await auditLog.record(req, {
            action: 'bot_flow.publish',
            targetType: 'bot_flow_version',
            targetId: req.params.id,
            targetLabel: `${version.flow_name} v${version.version_number}`,
            detail: `now live for category "${version.category}"`
        });

        logger.log('bot_flow', `${version.flow_key} v${version.version_number} published by ${req.admin.name}`);
        res.json({ success: true, message: 'Published — this is now live.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST /api/admin/bot-flow-versions/:id/reject — send it back, with a reason.
router.post('/admin/bot-flow-versions/:id/reject', requireFullAdmin, attachScope, async (req, res) => {
    try {
        const version = await loadVersion(req.params.id);
        if (!version) return res.status(404).json({ error: 'Version not found' });
        if (version.state !== 'pending_review') {
            return res.status(409).json({ message: 'Only a version awaiting review can be sent back.' });
        }

        const note = (req.body.note || '').trim();
        if (!note) {
            // Someone did the work. If the answer is no, they are owed why.
            return res.status(400).json({
                message: 'Explain what needs changing. The institution sees this note.'
            });
        }

        await db.query(
            `UPDATE bot_flow_versions
             SET state = 'changes_requested', reviewed_by = $1,
                 reviewed_at = CURRENT_TIMESTAMP, review_note = $2
             WHERE id = $3`,
            [req.admin.id, note, req.params.id]
        );

        await auditLog.record(req, {
            action: 'bot_flow.reject',
            targetType: 'bot_flow_version',
            targetId: req.params.id,
            targetLabel: `${version.flow_name} v${version.version_number}`,
            detail: note
        });

        res.json({ success: true, message: 'Sent back with your note.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST /api/admin/bot-flow-versions/:id/rollback — bring an old version back.
router.post('/admin/bot-flow-versions/:id/rollback', requireFullAdmin, attachScope, async (req, res) => {
    try {
        const version = await loadVersion(req.params.id);
        if (!version) return res.status(404).json({ error: 'Version not found' });
        if (version.state === 'published') {
            return res.status(409).json({ message: 'That version is already live.' });
        }

        // Copied forward as a new version rather than reactivated in place, so
        // the history reads as what actually happened: this was live, then that
        // was live, then we went back. Rewriting an old row would erase the
        // fact that anything went wrong.
        const next = await db.query(
            'SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM bot_flow_versions WHERE flow_id = $1',
            [version.flow_id]
        );

        const created = await db.query(
            `INSERT INTO bot_flow_versions
                (flow_id, version_number, definition, state, created_by, reviewed_by,
                 reviewed_at, change_note)
             VALUES ($1, $2, $3, 'draft', $4, $4, CURRENT_TIMESTAMP, $5)
             RETURNING id`,
            [
                version.flow_id, next.rows[0].n, version.definition, req.admin.id,
                `Restored from version ${version.version_number}`
            ]
        );

        await publishVersion(created.rows[0].id, version.flow_id);

        await auditLog.record(req, {
            action: 'bot_flow.rollback',
            targetType: 'bot_flow_version',
            targetId: created.rows[0].id,
            targetLabel: `${version.flow_name} v${next.rows[0].n}`,
            detail: `restored the content of version ${version.version_number}`
        });

        res.json({ success: true, message: `Version ${version.version_number} is live again as v${next.rows[0].n}.` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST /api/admin/bot-flow-versions/:id/test — run a draft on a real phone.
router.post('/admin/bot-flow-versions/:id/test', requireAdmin, attachScope, async (req, res) => {
    try {
        const version = await loadVersion(req.params.id);
        if (!version) return res.status(404).json({ error: 'Version not found' });
        if (!ownsFlow(req.scope, version)) {
            return res.status(403).json({ message: 'This questionnaire belongs to another institution.' });
        }

        const phone = String(req.body.phone || '').replace(/\D/g, '');
        if (!phone) return res.status(400).json({ message: 'Enter the number to send the test to.' });

        const { errors } = validateDefinition(version.definition);
        if (errors.length > 0) {
            return res.status(400).json({ message: 'Fix these before testing.', errors });
        }

        const target = await db.query('SELECT id, name FROM users WHERE phone_number = $1', [phone]);
        if (target.rows.length === 0) {
            return res.status(404).json({
                message: 'That number has never used the bot, so there is no conversation to send into. '
                    + 'Send "Hi" from it first.'
            });
        }
        const targetUser = target.rows[0];

        const busy = await db.query(
            "SELECT 1 FROM bot_flow_runs WHERE user_id = $1 AND state IN ('invited', 'in_progress')",
            [targetUser.id]
        );
        if (busy.rows.length > 0) {
            return res.status(409).json({
                message: `${targetUser.name} is already part-way through a questionnaire. `
                    + 'Wait for it to finish, or send the test to a different number.'
            });
        }

        const run = await db.query(
            `INSERT INTO bot_flow_runs
                (flow_version_id, issue_id, user_id, state, category_at_send, is_test, started_by, started_at)
             VALUES ($1, NULL, $2, 'in_progress', $3, TRUE, $4, CURRENT_TIMESTAMP)
             RETURNING *`,
            [req.params.id, targetUser.id, version.category, req.admin.id]
        );

        const whatsappService = require('../services/whatsappService');
        await whatsappService.sendMessage(phone,
            `🧪 *Test questionnaire*\n\n`
            + `This is a draft of "${version.flow_name}" (v${version.version_number}), sent by ${req.admin.name} for testing. `
            + `Your answers will not be attached to any report.`);

        const intro = botFlow.text(version.definition.intro);
        if (intro) await whatsappService.sendMessage(phone, intro);
        await whatsappService.sendMessage(phone,
            botFlow.promptFor({ ...run.rows[0], definition: version.definition }));

        await auditLog.record(req, {
            action: 'bot_flow.test',
            targetType: 'bot_flow_version',
            targetId: req.params.id,
            targetLabel: `${version.flow_name} v${version.version_number}`,
            detail: `test sent to ${phone}`
        });

        res.json({ success: true, message: `Test sent to ${targetUser.name}.` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST /api/admin/bot-flow-versions/:id/validate — check without saving.
router.post('/admin/bot-flow-versions/:id/validate', requireAdmin, attachScope, async (req, res) => {
    const { errors, warnings } = validateDefinition(req.body.definition);
    res.json({ ok: errors.length === 0, errors, warnings });
});

module.exports = router;
