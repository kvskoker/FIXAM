const db = require('../db');
const logger = require('./logger');

/**
 * Runs a follow-up questionnaire as a conversation.
 *
 * The questions come from a published flow version in the database, not from
 * this file. This is the interpreter; the institution writes the script.
 *
 * Everything here is deliberately answerable in one tap or a short line. A
 * citizen has already reported the problem and done their part -- these are
 * extra questions asked afterwards for the institution's benefit, so every one
 * of them can be skipped and the whole thing can be stopped. A questionnaire
 * that traps someone is worse than no questionnaire.
 */

const DEFAULT_LANGUAGE = 'en';

// A citizen's reply that means "I do not want to do this".
const STOP_WORDS = ['stop', 'cancel', 'quit', 'exit', 'no thanks'];
const SKIP_WORDS = ['skip', 'pass', 'next'];

/**
 * Pick the citizen's language, falling back to English.
 *
 * Prompts are stored as { en: "..." } with room for more languages. A missing
 * translation falls back rather than showing a key: an English prompt is
 * usable, `meter_number.prompt` is not.
 */
function text(field, language = DEFAULT_LANGUAGE) {
    if (!field) return '';
    if (typeof field === 'string') return field;
    return field[language] || field[DEFAULT_LANGUAGE] || Object.values(field)[0] || '';
}

/** The published questionnaire for a category, or null if nobody asks anything. */
async function publishedFlowForCategory(category) {
    const result = await db.query(
        `SELECT v.id AS version_id, v.definition, v.version_number,
                f.id AS flow_id, f.key, f.name, f.group_id, g.name AS group_name
         FROM bot_flows f
         JOIN bot_flow_versions v ON v.flow_id = f.id AND v.state = 'published'
         LEFT JOIN groups g ON g.id = f.group_id
         WHERE f.status = 'active' AND f.category = $1
         LIMIT 1`,
        [category]
    );
    return result.rows[0] || null;
}

/**
 * Is the citizen still inside WhatsApp's 24-hour customer service window?
 *
 * Inside it, the platform may message freely. Outside it, the first message has
 * to be an approved template, which is why the invitation exists at all.
 */
async function withinServiceWindow(userId) {
    const result = await db.query(
        `SELECT last_inbound_at > NOW() - INTERVAL '24 hours' AS open
         FROM users WHERE id = $1`,
        [userId]
    );
    return result.rows.length > 0 && result.rows[0].open === true;
}

/** The run this citizen is currently in the middle of, if any. */
async function activeRunForUser(userId) {
    const result = await db.query(
        `SELECT r.*, v.definition, f.name AS flow_name, g.name AS group_name
         FROM bot_flow_runs r
         JOIN bot_flow_versions v ON v.id = r.flow_version_id
         JOIN bot_flows f ON f.id = v.flow_id
         LEFT JOIN groups g ON g.id = f.group_id
         WHERE r.user_id = $1 AND r.state IN ('invited', 'in_progress')
         LIMIT 1`,
        [userId]
    );
    return result.rows[0] || null;
}

/**
 * Create a run for a report that has just been acknowledged.
 *
 * Returns { run, flow, windowOpen } or null when there is nothing to ask --
 * which is the common case, and the citizen never knows anything was considered.
 */
async function startRun(issue, userId, { category }) {
    const flow = await publishedFlowForCategory(category);
    if (!flow) return null;

    // Never ask the same questionnaire twice about the same report.
    const already = await db.query(
        `SELECT 1 FROM bot_flow_runs
         WHERE issue_id = $1 AND flow_version_id = $2
           AND state IN ('invited', 'in_progress', 'completed')
         LIMIT 1`,
        [issue.id, flow.version_id]
    );
    if (already.rows.length > 0) return null;

    // One questionnaire at a time. An earlier unanswered one is retired rather
    // than left to interleave with this.
    await db.query(
        `UPDATE bot_flow_runs SET state = 'superseded'
         WHERE user_id = $1 AND state IN ('invited', 'in_progress')`,
        [userId]
    );

    const windowOpen = await withinServiceWindow(userId);

    const inserted = await db.query(
        `INSERT INTO bot_flow_runs
            (flow_version_id, issue_id, user_id, state, category_at_send, started_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
            flow.version_id,
            issue.id,
            userId,
            windowOpen ? 'in_progress' : 'invited',
            category,
            windowOpen ? new Date() : null
        ]
    );

    logger.log('bot_flow',
        `Questionnaire ${flow.key} started for issue ${issue.ticket_id} `
        + `(${windowOpen ? 'window open' : 'invitation sent'})`);

    return { run: inserted.rows[0], flow, windowOpen };
}

/** The step a run is currently on, or null when it has run off the end. */
function currentStep(run) {
    const steps = (run.definition && run.definition.steps) || [];
    return steps[run.current_step] || null;
}

/**
 * The message to send for the current step.
 *
 * Choices are numbered because a numbered list is the one interaction that
 * works identically on every handset, and it is what the rest of the bot
 * already does.
 */
function promptFor(run, language = DEFAULT_LANGUAGE) {
    const step = currentStep(run);
    if (!step) return null;

    const steps = run.definition.steps;
    const position = `*Question ${run.current_step + 1} of ${steps.length}*`;

    let body = `${position}\n\n${text(step.prompt, language)}`;

    if (step.help) body += `\n_${text(step.help, language)}_`;

    if (step.type === 'choice' && Array.isArray(step.options)) {
        body += '\n';
        step.options.forEach((option, index) => {
            body += `\n*${index + 1}* — ${text(option.label, language)}`;
        });
    }

    const escapes = [];
    if (step.skippable !== false) escapes.push('*SKIP* to leave this one');
    escapes.push('*STOP* to finish');
    body += `\n\n_${escapes.join('  •  ')}_`;

    return body;
}

/**
 * Take a citizen's reply and move the run on.
 *
 * Returns { reply, done } — the message to send back, and whether the
 * questionnaire is now over.
 */
async function handleAnswer(run, input, language = DEFAULT_LANGUAGE) {
    const step = currentStep(run);
    if (!step) return { reply: null, done: true };

    const raw = String(input || '').trim();
    const lowered = raw.toLowerCase();

    if (STOP_WORDS.includes(lowered)) {
        await db.query(
            `UPDATE bot_flow_runs SET state = 'abandoned', completed_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [run.id]
        );
        return {
            reply: 'No problem — your report is still with the team and they will work on it. '
                 + 'Type *Hi* for the menu.',
            done: true
        };
    }

    const skipping = SKIP_WORDS.includes(lowered);
    if (skipping && step.skippable === false) {
        return { reply: `This one is needed.\n\n${promptFor(run, language)}`, done: false };
    }

    let value = null;

    if (!skipping) {
        if (step.type === 'choice') {
            const options = step.options || [];
            const index = parseInt(raw, 10);

            if (Number.isFinite(index) && index >= 1 && index <= options.length) {
                value = options[index - 1].value;
            } else {
                // Accept the label itself too -- people type "yes" as readily
                // as they type "1".
                const match = options.find(
                    (o) => text(o.label, language).toLowerCase() === lowered || o.value === lowered
                );
                if (match) value = match.value;
            }

            if (value === null) {
                return {
                    reply: `Please reply with the number of your answer.\n\n${promptFor(run, language)}`,
                    done: false
                };
            }
        } else if (step.type === 'number') {
            const numeric = raw.replace(/[^\d.-]/g, '');
            if (numeric === '' || !Number.isFinite(Number(numeric))) {
                return {
                    reply: `Please reply with a number.\n\n${promptFor(run, language)}`,
                    done: false
                };
            }
            value = Number(numeric);
        } else {
            value = raw;
        }

        // Validation is per-question and supplied by whoever wrote the
        // questionnaire, so the error message is theirs too.
        if (step.validation && step.validation.pattern && typeof value === 'string') {
            let pattern;
            try {
                pattern = new RegExp(step.validation.pattern);
            } catch (err) {
                // A questionnaire with a broken pattern must not trap the
                // citizen in a loop; treat it as no validation and move on.
                logger.logError('bot_flow',
                    `Invalid pattern on step ${step.key}: ${step.validation.pattern}`, err);
                pattern = null;
            }

            if (pattern && !pattern.test(value)) {
                const message = text(step.validation.error, language)
                    || 'That does not look right. Please try again.';
                const escape = step.skippable !== false ? '\n\n_Reply *SKIP* to leave it out._' : '';
                return { reply: `${message}${escape}`, done: false };
            }
        }
    }

    const answers = { ...(run.answers || {}) };
    answers[step.key] = skipping ? null : value;

    const steps = run.definition.steps;
    const next = run.current_step + 1;
    const finished = next >= steps.length;

    await db.query(
        `UPDATE bot_flow_runs
         SET answers = $1, current_step = $2, state = $3,
             completed_at = CASE WHEN $4::boolean THEN CURRENT_TIMESTAMP ELSE completed_at END
         WHERE id = $5`,
        [answers, next, finished ? 'completed' : 'in_progress', finished, run.id]
    );

    if (finished) {
        const outro = text(run.definition.outro, language)
            || 'Thank you — that is everything.';
        return { reply: `${outro}\n\nType *Hi* for the menu.`, done: true };
    }

    const advanced = { ...run, answers, current_step: next };
    return { reply: promptFor(advanced, language), done: false };
}

/** Everything asked and answered about a report, for the portal. */
async function runsForIssue(issueId) {
    const result = await db.query(
        `SELECT r.id, r.state, r.answers, r.category_at_send, r.current_step,
                r.invited_at, r.started_at, r.completed_at,
                v.definition, v.version_number,
                f.name AS flow_name, g.name AS group_name
         FROM bot_flow_runs r
         JOIN bot_flow_versions v ON v.id = r.flow_version_id
         JOIN bot_flows f ON f.id = v.flow_id
         LEFT JOIN groups g ON g.id = f.group_id
         WHERE r.issue_id = $1
         ORDER BY r.invited_at DESC`,
        [issueId]
    );

    // Pair each answer with the question that produced it. The portal should
    // show "Meter number: 03412345678", not a bare key and a value.
    return result.rows.map((row) => ({
        id: row.id,
        state: row.state,
        flow_name: row.flow_name,
        group_name: row.group_name,
        version_number: row.version_number,
        category_at_send: row.category_at_send,
        invited_at: row.invited_at,
        completed_at: row.completed_at,
        progress: `${row.current_step} of ${(row.definition.steps || []).length}`,
        answers: (row.definition.steps || []).map((step) => {
            const value = (row.answers || {})[step.key];
            let display = value;

            if (step.type === 'choice' && value != null) {
                const option = (step.options || []).find((o) => o.value === value);
                if (option) display = text(option.label);
            }

            return {
                key: step.key,
                question: text(step.prompt),
                answered: Object.prototype.hasOwnProperty.call(row.answers || {}, step.key),
                skipped: Object.prototype.hasOwnProperty.call(row.answers || {}, step.key) && value === null,
                value: display
            };
        })
    }));
}

module.exports = {
    publishedFlowForCategory,
    withinServiceWindow,
    activeRunForUser,
    startRun,
    promptFor,
    handleAnswer,
    runsForIssue,
    text,
    STOP_WORDS,
    SKIP_WORDS
};
