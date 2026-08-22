const logger = require('./logger');
const dataMode = require('./dataMode');

/**
 * SLA tracking, plus the platform settings it reads.
 *
 * Two SLAs are measurable and are enforced: how long a report may wait to be
 * acknowledged, and how long it may wait after acknowledgement before work
 * starts. Resolution is deliberately not enforced -- a broken bridge can take
 * months and the funding to fix it may not exist -- so it is tracked only as an
 * informational "open beyond the resolution window" note.
 *
 * The numbers are configurable in the admin portal, which is why they live in
 * platform_settings rather than the environment.
 */

const DEFAULTS = {
    pilot_mode: 'false',
    // Which phase the platform is in: test (shown as "Demo"), pilot or live.
    // Decides the tag new records get and which tags the portal displays.
    // See services/dataMode.js.
    data_mode: 'pilot',
    sla_acknowledge_hours: '24',
    sla_progress_hours: '72',
    sla_resolution_days: '30',
    // A report whose category is on this list -- or whose description carries
    // one of the keywords -- takes the emergency fast path.
    emergency_categories: 'Fire Services,Natural Disaster Response,Public Safety,Road Safety',
    emergency_keywords: 'emergency,fire,on fire,burning,collapse,collapsed,flood,flooding,injury,serious accident,trapped,drowning',
};

const ALLOWED_SETTINGS = Object.keys(DEFAULTS);

/**
 * Make sure the pilot/SLA schema exists. The migration file does the same on a
 * fresh volume; this runs at boot so an existing database -- where the
 * docker-entrypoint migrations never run again -- still has the tables the
 * toggle and the sweep need. Every statement is idempotent.
 */
async function ensureSchema(db) {
    await db.query(`
        CREATE TABLE IF NOT EXISTS platform_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS pilot_activated BOOLEAN NOT NULL DEFAULT FALSE');
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_team BOOLEAN NOT NULL DEFAULT FALSE');
    await db.query('ALTER TABLE issues ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMP');
    await db.query('ALTER TABLE issues ADD COLUMN IF NOT EXISTS progress_at TIMESTAMP');

    await db.query(`
        INSERT INTO platform_settings (key, value) VALUES
            ('pilot_mode', 'false'),
            ('data_mode', 'pilot'),
            ('sla_acknowledge_hours', '24'),
            ('sla_progress_hours', '72'),
            ('sla_resolution_days', '30'),
            ('emergency_categories', 'Fire Services,Natural Disaster Response,Public Safety,Road Safety'),
            ('emergency_keywords', 'emergency,fire,on fire,burning,collapse,collapsed,flood,flooding,injury,serious accident,trapped,drowning')
        ON CONFLICT (key) DO NOTHING
    `);
}

async function getSettings(db) {
    const result = await db.query('SELECT key, value FROM platform_settings');
    const settings = { ...DEFAULTS };
    for (const row of result.rows) settings[row.key] = row.value;
    return settings;
}

/**
 * Persist changed settings, ignoring anything not in the allow-list.
 * Returns the resulting full set so the caller can echo it back.
 */
async function saveSettings(db, updates, adminId) {
    for (const [key, value] of Object.entries(updates || {})) {
        if (!ALLOWED_SETTINGS.includes(key)) continue;

        // data_mode is the one setting where a typo does lasting damage: it is
        // written into every record created afterwards, and the CHECK
        // constraint on the tables would reject those inserts. Refuse the value
        // here, where the operator finds out immediately.
        if (key === 'data_mode' && !dataMode.isValid(value)) {
            const err = new Error(
                `Invalid data_mode "${value}". Expected one of: ${dataMode.MODES.join(', ')}`);
            err.statusCode = 400;
            throw err;
        }

        await db.query(
            `INSERT INTO platform_settings (key, value, updated_by, updated_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
             ON CONFLICT (key) DO UPDATE SET
                 value = EXCLUDED.value,
                 updated_by = EXCLUDED.updated_by,
                 updated_at = CURRENT_TIMESTAMP`,
            [key, String(value), adminId]
        );
    }
    return getSettings(db);
}

/**
 * One pass over open reports, writing a tracker entry the first time each one
 * misses an SLA. Entries are recorded once (matched on the description), so the
 * daily run does not pile duplicates onto a report that stays breached.
 */
async function checkBreaches(db) {
    const s = await getSettings(db);
    const ackHours = Number(s.sla_acknowledge_hours) || 24;
    const progressHours = Number(s.sla_progress_hours) || 72;
    const resolutionDays = Number(s.sla_resolution_days) || 30;

    let flagged = 0;

    const flag = async (issueId, action, description) => {
        const existing = await db.query(
            'SELECT id FROM issue_tracker WHERE issue_id = $1 AND action = $2 AND description = $3',
            [issueId, action, description]
        );
        if (existing.rows.length === 0) {
            await db.query(
                'INSERT INTO issue_tracker (issue_id, action, description) VALUES ($1, $2, $3)',
                [issueId, action, description]
            );
            flagged++;
        }
    };

    // Acknowledge deadline: still waiting to be picked up past the window.
    const ackResult = await db.query(
        `SELECT id FROM issues
         WHERE status = 'reported'
           AND created_at < NOW() - ($1 || ' hours')::INTERVAL`,
        [ackHours]
    );
    for (const row of ackResult.rows) {
        await flag(row.id, 'sla_breach', `SLA breach: not acknowledged within ${ackHours}h`);
    }

    // Progress deadline: acknowledged but work has not started past the window.
    const progressResult = await db.query(
        `SELECT id FROM issues
         WHERE status = 'acknowledged'
           AND COALESCE(acknowledged_at, created_at) < NOW() - ($1 || ' hours')::INTERVAL`,
        [progressHours]
    );
    for (const row of progressResult.rows) {
        await flag(row.id, 'sla_breach', `SLA breach: not in progress within ${progressHours}h`);
    }

    // Resolution window (informational, not a breach): work started but is
    // still unfinished past the cap. Recorded once so a long-running repair
    // is visible without being re-flagged daily.
    const resolutionResult = await db.query(
        `SELECT id FROM issues
         WHERE status = 'progress'
           AND COALESCE(progress_at, acknowledged_at, created_at) < NOW() - ($1 || ' days')::INTERVAL`,
        [resolutionDays]
    );
    for (const row of resolutionResult.rows) {
        await flag(row.id, 'sla_overdue', `Open beyond the ${resolutionDays}-day resolution window`);
    }

    if (flagged > 0) {
        logger.log('sla', `SLA sweep flagged ${flagged} report(s)`);
    }
    return flagged;
}

/**
 * Run a sweep at startup and then daily. Same in-process timer pattern as
 * retention: a single backend container is the pilot's deployment model.
 */
function schedule(db) {
    const DAILY = 24 * 60 * 60 * 1000;

    setTimeout(() => checkBreaches(db).catch((err) => logger.logError('sla', 'SLA sweep failed', err)), 2 * 60 * 1000);
    setInterval(() => checkBreaches(db).catch((err) => logger.logError('sla', 'SLA sweep failed', err)), DAILY);

    logger.log('sla', 'SLA sweep scheduled (daily)');
}

module.exports = { ensureSchema, getSettings, saveSettings, checkBreaches, schedule, DEFAULTS };
