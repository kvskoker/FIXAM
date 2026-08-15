const fs = require('fs');
const path = require('path');
const logger = require('./logger');

/**
 * Enforce the retention periods the privacy policy promises.
 *
 * The published policy stated that message logs are kept for 90 days and that
 * deleted account data is purged within 30 days. Nothing enforced either --
 * every WhatsApp message ever exchanged was retained indefinitely, which meant
 * the policy described a platform that did not exist. A promise about personal
 * data that nothing enforces is worse than no promise, because people rely on
 * it when deciding to use the service.
 *
 * What is deliberately NOT purged:
 *
 *   Reports and their photographs. A report is a public record of a problem at
 *   a place, and the pilot's whole value is the history of what was reported
 *   and whether it was fixed. Reports are anonymised when an account is deleted
 *   rather than removed.
 *
 *   The audit trail. Who did what to a report has to outlive the working data,
 *   or accountability lasts only as long as the retention window.
 *
 * Windows are configurable so the deployment can be tightened without a code
 * change, but they default to what the policy says.
 */

const UPLOADS_ROOT = process.env.UPLOADS_DIR
    || path.join(__dirname, '..', '..', 'uploads');

function days(name, fallback) {
    const raw = parseInt(process.env[name], 10);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const WINDOWS = {
    // Conversation transcripts. The bot needs recent history to hold a
    // conversation; it has no use for a message from three months ago.
    messageLogs: () => days('MESSAGE_LOG_RETENTION_DAYS', 90),

    // Half-finished reporting flows. These hold whatever the citizen had typed
    // so far -- descriptions, addresses -- for a conversation nobody resumed.
    conversationState: () => days('CONVERSATION_STATE_RETENTION_DAYS', 7),

    // Consent records for people who never completed sign-up.
    pendingConsent: () => days('PENDING_CONSENT_RETENTION_DAYS', 30)
};

async function purgeOnce(db) {
    const result = { message_logs: 0, conversation_state: 0, pending_consent: 0, orphan_media: 0 };

    const step = async (label, fn) => {
        try {
            result[label] = await fn();
        } catch (err) {
            logger.logError('retention', `Retention sweep failed for ${label}`, err);
            result[label] = null;
        }
    };

    await step('message_logs', async () => (await db.query(
        `DELETE FROM message_logs
         WHERE created_at < NOW() - ($1 || ' days')::INTERVAL`,
        [WINDOWS.messageLogs()]
    )).rowCount);

    await step('conversation_state', async () => (await db.query(
        `DELETE FROM conversation_state
         WHERE last_updated < NOW() - ($1 || ' days')::INTERVAL`,
        [WINDOWS.conversationState()]
    )).rowCount);

    await step('pending_consent', async () => (await db.query(
        `DELETE FROM pending_consent
         WHERE sent_at < NOW() - ($1 || ' days')::INTERVAL`,
        [WINDOWS.pendingConsent()]
    )).rowCount);

    await step('orphan_media', () => purgeOrphanMedia(db));

    logger.log('retention', `Retention pass complete: ${JSON.stringify(result)}`);

    return result;
}

/**
 * Remove uploaded files no row points at any more.
 *
 * Deleting an account clears the rows that referenced a citizen's voice notes,
 * but the files themselves stayed on disk -- so "delete my data" left the
 * recording of the person's voice exactly where it was. Anything on disk that
 * nothing references is deleted here.
 */
async function purgeOrphanMedia(db) {
    let removed = 0;

    const referenced = new Set();
    const collect = (rows, ...cols) => {
        for (const row of rows) {
            for (const col of cols) {
                if (row[col]) referenced.add(path.basename(row[col]));
            }
        }
    };

    const issues = await db.query('SELECT image_url, audio_url FROM issues');
    collect(issues.rows, 'image_url', 'audio_url');

    const feedback = await db.query('SELECT media_url FROM feedback');
    collect(feedback.rows, 'media_url');

    const dirs = [
        path.join(UPLOADS_ROOT, 'issues', 'images'),
        path.join(UPLOADS_ROOT, 'issues', 'audio'),
        path.join(UPLOADS_ROOT, 'feedback', 'audio')
    ];

    for (const dir of dirs) {
        let entries;
        try {
            entries = fs.readdirSync(dir);
        } catch (err) {
            continue; // Directory may not exist yet on a fresh deployment.
        }

        for (const name of entries) {
            if (referenced.has(name)) continue;

            const full = path.join(dir, name);
            try {
                // A grace period, so a file written seconds ago -- before its
                // row is committed -- is never mistaken for an orphan.
                const stat = fs.statSync(full);
                if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) continue;

                fs.unlinkSync(full);
                removed++;
            } catch (err) {
                logger.logError('retention', `Could not remove orphaned file ${full}`, err);
            }
        }
    }

    return removed;
}

/**
 * Run a pass at startup and then daily. Deliberately simple: the pilot runs a
 * single backend container, so an in-process timer is enough and adds no
 * infrastructure to operate.
 */
function schedule(db) {
    const DAILY = 24 * 60 * 60 * 1000;

    // Not immediately on boot -- a restart loop would otherwise run this on
    // every crash. A minute in, once the process has proven it is staying up.
    setTimeout(() => purgeOnce(db), 60 * 1000);
    setInterval(() => purgeOnce(db), DAILY);

    logger.log('retention', `Retention scheduled: message logs ${WINDOWS.messageLogs()}d, `
        + `conversation state ${WINDOWS.conversationState()}d, `
        + `pending consent ${WINDOWS.pendingConsent()}d`);
}

module.exports = { schedule, purgeOnce, purgeOrphanMedia, WINDOWS };
