const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fileUpload = require('express-fileupload');
const { Pool } = require('pg');
const axios = require('axios');

// Share the backend's configuration loader so both read the same root .env.
// Without this the simulator silently falls back to the defaults below, which
// would connect somewhere unexpected the moment they diverge.
require('../backend/loadEnv');

const FixamHandler = require('../backend/services/whatsappHandler');
const simulator = require('../backend/services/simulator');
const MockWhatsAppService = require('./mockWhatsApp');

const PORT = process.env.SIMULATOR_PORT || 4001;
const DEFAULT_PHONE = normalizePhone(process.env.SIMULATOR_PHONE || '23272123456');
const BACKEND_URL = (process.env.SIMULATOR_BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`)
    .replace(/\/+$/, '');

/**
 * Normalise a phone number to the form the bot expects: digits only, country
 * code included. The handler rejects anything that does not start with 232, so
 * "+232 72 123456", "072123456" and "23272123456" all have to end up the same.
 */
function normalizePhone(input) {
    if (!input) return '';
    let digits = String(input).replace(/[^\d]/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.startsWith('0')) digits = digits.slice(1);          // local 0-prefix
    if (!digits.startsWith('232')) digits = `232${digits}`;        // assume Sierra Leone
    return digits;
}

async function createServer() {
    const app = express();
    app.use(express.json());
    app.use(fileUpload({
        limits: { fileSize: 16 * 1024 * 1024 },
        abortOnLimit: true,
    }));
    app.use(express.static(path.join(__dirname, 'public')));

    if (!process.env.DB_PASSWORD) {
        throw new Error(
            'DB_PASSWORD is not set. The simulator reads the repo-root .env -- copy .env.example '
            + 'to .env and make sure it defines DB_NAME, DB_USER and DB_PASSWORD.'
        );
    }

    // Simulated conversations write real rows (users, issues, votes). Point
    // SIMULATOR_DB_NAME at a scratch database to keep them out of the main one.
    const dbName = process.env.SIMULATOR_DB_NAME || process.env.DB_NAME;

    // The simulator builds its own pool because it may point at a scratch
    // database, but it must follow the same transport rule as everything else
    // -- otherwise turning on encryption leaves one service quietly outside it.
    const db = new Pool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: dbName,
        port: process.env.DB_PORT || 5432,
        ssl: String(process.env.DB_SSL || '').toLowerCase() === 'true'
            ? { rejectUnauthorized: false }
            : false,
    });

    // Without this, an idle client failing -- as happens whenever the database
    // restarts -- raises an unhandled 'error' event and ends the process. The
    // simulator died exactly that way and stayed down until it was noticed.
    db.on('error', (err) => {
        console.error('  [sim] Idle database client error (the pool will reconnect):', err.message);
    });

    console.log(`  Simulator database: ${dbName} @ ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432} as ${process.env.DB_USER}`);
    if (!process.env.SIMULATOR_DB_NAME) {
        console.log(`  NOTE: writing to the main database. Set SIMULATOR_DB_NAME to use a scratch copy.`);
    }
    if (!simulator.isEnabled()) {
        console.warn(
            '\n  WARNING: SIMULATOR_ENABLED is not "true" in the root .env.\n'
            + '  The bot will not recognise simulated messages, so the DEV_MODE gate and the\n'
            + '  phone-number-ID check will reject them. Add SIMULATOR_ENABLED=true and restart.\n'
        );
    }

    await verifySchema(db, dbName);

    const whatsAppService = new MockWhatsAppService({
        knownPhonesFile: path.join(__dirname, '.known-phones.json'),
        seedPhones: [DEFAULT_PHONE],
    });

    // Previously a no-op, which silently discarded every diagnostic the handler
    // and database layer emit -- including the reason a registration failed.
    const debugLog = (message, meta) => {
        if (meta !== undefined) {
            console.log(`  [sim] ${message}`, typeof meta === 'object' ? JSON.stringify(meta) : meta);
        } else {
            console.log(`  [sim] ${message}`);
        }
    };

    const handler = new FixamHandler(whatsAppService, db, null, debugLog);

    /**
     * Run one webhook payload through the bot and return everything it said.
     * Shared by the text/location/media endpoints so they cannot drift apart.
     */
    async function dispatch(res, phoneNumber, buildPayload) {
        whatsAppService.startCapture(phoneNumber);

        try {
            await handler.processIncomingMessage(buildPayload(phoneNumber));
            res.json({ success: true, responses: whatsAppService.getResponses() });
        } catch (err) {
            console.error('  [sim] handler error:', err);
            res.status(500).json({
                success: false,
                error: err.message,
                responses: whatsAppService.getResponses(),
            });
        }
    }

    app.post('/simulate/upload', async (req, res) => {
        if (!req.files || !req.files.file) {
            return res.status(400).json({ error: 'No file uploaded.' });
        }

        const uploaded = req.files.file;
        const mediaId = `sim-upload-${crypto.randomUUID()}`;

        let mimeType = uploaded.mimetype || 'application/octet-stream';
        if (!mimeType || mimeType === 'application/octet-stream') {
            const ext = path.extname(uploaded.name || '').toLowerCase();
            const mimeMap = {
                '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                '.gif': 'image/gif', '.webp': 'image/webp',
                '.mp4': 'video/mp4', '.mov': 'video/quicktime',
                '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg; codecs=opus',
                '.opus': 'audio/ogg; codecs=opus', '.wav': 'audio/wav',
                '.pdf': 'application/pdf',
            };
            mimeType = mimeMap[ext] || mimeType;
        }

        whatsAppService.registerFile(mediaId, uploaded.data, mimeType);

        res.json({ success: true, media_id: mediaId, mime_type: mimeType, name: uploaded.name });
    });

    app.post('/simulate', async (req, res) => {
        const { phone_number, message, message_type } = req.body;

        if (!phone_number || !message) {
            return res.status(400).json({ error: 'phone_number and message are required.' });
        }

        await dispatch(res, normalizePhone(phone_number), (phone) =>
            buildWebhookPayload(phone, message, message_type || 'text'));
    });

    app.post('/simulate/location', async (req, res) => {
        const { phone_number, latitude, longitude } = req.body;

        if (!phone_number || latitude == null || longitude == null) {
            return res.status(400).json({ error: 'phone_number, latitude, and longitude are required.' });
        }

        await dispatch(res, normalizePhone(phone_number), (phone) =>
            buildLocationPayload(phone, latitude, longitude));
    });

    app.post('/simulate/media', async (req, res) => {
        const { phone_number, media_id, media_type, forwarded } = req.body;

        if (!phone_number || !media_id) {
            return res.status(400).json({ error: 'phone_number and media_id are required.' });
        }

        await dispatch(res, normalizePhone(phone_number), (phone) =>
            buildMediaPayload(phone, media_id, media_type || 'image', forwarded));
    });

    // Called by the backend (services/simulator.js) to mirror messages sent from
    // outside this process -- admin status updates and group alerts. `accepted`
    // tells the backend whether this number is one the simulator is driving; if
    // it is not, the backend still delivers through its normal path.
    app.post('/simulate/notify', async (req, res) => {
        const { phone_number, message, type } = req.body;
        if (!phone_number || !message) {
            return res.status(400).json({ error: 'phone_number and message are required.' });
        }
        const phone = normalizePhone(phone_number);
        const accepted = whatsAppService.isKnownPhone(phone);
        whatsAppService.pushNotification(phone, message, type || 'system');

        // These come from the backend process, which sends them straight through
        // whatsappService and so never reaches the handler's message logging.
        // Recording them here is what lets a reloaded window show the admin
        // update in the transcript instead of replaying it as if it were new.
        if (accepted) {
            try {
                await db.query(
                    `INSERT INTO message_logs (phone_number, direction, message_type, message_body)
                     VALUES ($1, 'outgoing', 'text', $2)`,
                    [phone, message]
                );
            } catch (err) {
                console.warn(`  [sim] Could not log notification for ${phone}: ${err.message}`);
            }
        }

        res.json({ success: true, accepted });
    });

    app.get('/simulate/notifications', (req, res) => {
        const phone = req.query.phone;
        const since = req.query.since;
        if (!phone) return res.json({ notifications: [] });
        const notifications = whatsAppService.getNotifications(normalizePhone(phone), since);
        const lastTs = notifications.length > 0
            ? notifications[notifications.length - 1].timestamp
            : since || null;
        res.json({ notifications, last_timestamp: lastTs });
    });

    // Where polling should start for a number, so a page load or a switch to
    // another number does not replay notifications already delivered.
    app.get('/simulate/notifications/cursor', (req, res) => {
        const phone = normalizePhone(req.query.phone);
        if (!phone) return res.json({ last_timestamp: null });
        res.json({ last_timestamp: whatsAppService.getLatestNotificationTimestamp(phone) });
    });

    // Conversation history for a number, oldest first. `direction` is written
    // from the bot's point of view: "incoming" is what the citizen sent.
    app.get('/simulate/history', async (req, res) => {
        const phone = normalizePhone(req.query.phone);
        if (!phone) return res.status(400).json({ error: 'phone is required.' });

        const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

        try {
            const result = await db.query(
                `SELECT direction, message_type, message_body, created_at
                 FROM message_logs
                 WHERE phone_number = $1
                 ORDER BY created_at DESC, id DESC
                 LIMIT $2`,
                [phone, limit]
            );
            // The browser adopts this number as the active one, which keeps
            // normalisation in one place instead of reimplementing it there.
            res.json({ phone, messages: result.rows.reverse() });
        } catch (err) {
            res.status(500).json({ error: err.message, phone, messages: [] });
        }
    });

    // Issues reported by this number, newest first -- the picker for the
    // "admin update" action below.
    app.get('/simulate/issues', async (req, res) => {
        const phone = normalizePhone(req.query.phone);
        if (!phone) return res.json({ issues: [] });

        try {
            const result = await db.query(
                `SELECT i.id, i.ticket_id, i.title, i.status
                 FROM issues i
                 JOIN users u ON i.reported_by = u.id
                 WHERE u.phone_number = $1
                 ORDER BY i.created_at DESC
                 LIMIT 10`,
                [phone]
            );
            res.json({ issues: result.rows });
        } catch (err) {
            res.status(500).json({ error: err.message, issues: [] });
        }
    });

    // Simulate an admin changing an issue's status. This deliberately calls the
    // real backend endpoint rather than updating the database here, so what gets
    // tested is the actual admin path -- including the WhatsApp notification it
    // sends back, which lands in this simulator via /simulate/notify.
    app.post('/simulate/admin-update', async (req, res) => {
        const { ticket_id, status, note } = req.body;
        if (!ticket_id || !status) {
            return res.status(400).json({ error: 'ticket_id and status are required.' });
        }

        try {
            const found = await db.query('SELECT id FROM issues WHERE ticket_id = $1', [ticket_id.toUpperCase()]);
            if (found.rows.length === 0) {
                return res.status(404).json({ error: `No issue found with ID ${ticket_id}.` });
            }

            const response = await axios.put(
                `${BACKEND_URL}/api/admin/issues/${found.rows[0].id}/status`,
                { status, note: note || null },
                {
                    // Same header the admin portal sends; without it the DEV_MODE
                    // maintenance gate in routes/api.js answers 503.
                    headers: { 'X-Admin-Access': 'true' },
                    timeout: 15000,
                    validateStatus: () => true,
                }
            );

            if (response.status >= 400) {
                return res.status(response.status).json({
                    error: response.data?.message || `Backend returned ${response.status}.`,
                });
            }

            res.json({ success: true, message: response.data?.message || 'Status updated.' });
        } catch (err) {
            const hint = err.code === 'ECONNREFUSED'
                ? ` Is the backend running at ${BACKEND_URL}? (cd backend && npm start)`
                : '';
            res.status(502).json({ error: `${err.message}.${hint}` });
        }
    });

    // Wipe the conversation state for a number so the next message starts a
    // fresh session without having to delete the user.
    app.post('/simulate/reset-state', async (req, res) => {
        const phone = normalizePhone(req.body.phone_number);
        if (!phone) return res.status(400).json({ error: 'phone_number is required.' });

        try {
            await db.query('DELETE FROM conversation_state WHERE phone_number = $1', [phone]);
            await db.query('DELETE FROM pending_consent WHERE phone_number = $1', [phone]);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/config', (_req, res) => {
        res.json({
            defaultPhone: DEFAULT_PHONE,
            backendUrl: BACKEND_URL,
            simulatorRecognised: simulator.isEnabled(),
        });
    });

    app.get('/status', async (_req, res) => {
        try {
            await db.query('SELECT 1');
            res.json({ status: 'ok', database: 'connected', simulatorRecognised: simulator.isEnabled() });
        } catch (err) {
            res.json({ status: 'ok', database: 'disconnected', error: err.message });
        }
    });

    return { app, db, PORT };
}

/**
 * Confirm the connected database has the tables and columns the current code
 * depends on.
 *
 * The simulator often points at a different database from production, so a
 * migration applied on the server can be missing here. Without this check the
 * only symptom is a generic failure at the very end of a long conversation,
 * which is slow and confusing to diagnose.
 */
async function verifySchema(db, dbName) {
    const required = [
        { source: 'db/init_db.sql', kind: 'table', name: 'users' },
        { source: 'db/init_db.sql', kind: 'table', name: 'roles' },
        { source: 'db/init_db.sql', kind: 'table', name: 'user_roles' },
        { source: 'db/init_db.sql', kind: 'table', name: 'issues' },
        { source: 'db/init_db.sql', kind: 'table', name: 'votes' },
        { source: 'db/init_db.sql', kind: 'table', name: 'endorsements' },
        { source: 'db/init_db.sql', kind: 'table', name: 'conversation_state' },
        { source: 'db/init_db.sql', kind: 'table', name: 'message_logs' },
        { source: 'db/init_db.sql', kind: 'table', name: 'issue_tracker' },
        { source: 'db/init_db.sql', kind: 'table', name: 'user_point_logs' },
        { source: 'db/init_db.sql', kind: 'table', name: 'feedback' },
        { source: 'db/init_db.sql', kind: 'table', name: 'groups' },
        { source: 'db/init_db.sql', kind: 'table', name: 'category_groups' },
        { source: 'db/init_db.sql', kind: 'table', name: 'user_groups' },
        // Consent flow: a new user cannot get past the first message without it.
        { source: 'db/migration_dpg_privacy.sql', kind: 'table', name: 'pending_consent' },
        { source: 'db/migration_dpg_privacy.sql', kind: 'column', table: 'users', name: 'consent_given' },
        { source: 'db/migration_dpg_privacy.sql', kind: 'column', table: 'users', name: 'consent_timestamp' },
        // Report flow.
        { source: 'db/init_db.sql', kind: 'column', table: 'issues', name: 'address' },
        { source: 'db/init_db.sql', kind: 'column', table: 'issues', name: 'resolution_note' },
        { source: 'db/init_db.sql', kind: 'column', table: 'issues', name: 'audio_url' },
        { source: 'db/init_db.sql', kind: 'column', table: 'issues', name: 'duplicate_of' },
        { source: 'db/init_db.sql', kind: 'column', table: 'conversation_state', name: 'data' },
        { source: 'db/init_db.sql', kind: 'column', table: 'users', name: 'points' },
        { source: 'db/init_db.sql', kind: 'column', table: 'users', name: 'is_disabled' },
    ];

    const missing = [];
    for (const item of required) {
        try {
            if (item.kind === 'table') {
                const r = await db.query('SELECT to_regclass($1) AS t', [`public.${item.name}`]);
                if (!r.rows[0].t) missing.push(item);
            } else {
                const r = await db.query(
                    'SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2',
                    [item.table, item.name]);
                if (r.rows.length === 0) missing.push(item);
            }
        } catch (err) {
            console.error(`  Could not verify schema: ${err.message}`);
            return;
        }
    }

    if (missing.length === 0) {
        console.log('  Schema check: OK\n');
        return;
    }

    const sources = [...new Set(missing.map(m => m.source))];
    console.error('\n  ' + '='.repeat(72));
    console.error('  SCHEMA OUT OF DATE -- the chatbot WILL fail on this database');
    console.error('  ' + '='.repeat(72));
    for (const m of missing) {
        console.error(`    missing ${m.kind}: ${m.kind === 'table' ? m.name : m.table + '.' + m.name}`);
    }
    console.error(`\n  This database (${dbName}) is missing objects defined in:`);
    sources.forEach(s => console.error(`    backend/${s}`));
    console.error('\n  Apply them with:');
    console.error('    cd backend && npm run db:init');
    console.error('  ' + '='.repeat(72) + '\n');
}

/**
 * Webhook envelope shared by all payload builders.
 *
 * `simulator: true` and the sentinel phone_number_id are what let the bot tell a
 * simulated message from a real one -- see backend/services/simulator.js.
 */
function buildEnvelope(message) {
    return {
        object: 'whatsapp_business_account',
        simulator: true,
        entry: [{
            id: 'simulator',
            changes: [{
                value: {
                    messaging_product: 'whatsapp',
                    metadata: {
                        display_phone_number: process.env.BOT_PHONE_NUMBER || '23233788736',
                        phone_number_id: simulator.SIMULATOR_PHONE_NUMBER_ID,
                    },
                    messages: [message],
                },
                field: 'messages',
            }],
        }],
    };
}

function buildWebhookPayload(phoneNumber, text, type = 'text') {
    return buildEnvelope({
        from: phoneNumber,
        id: `sim-msg-${Date.now()}`,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: type,
        text: { body: text },
    });
}

function buildLocationPayload(phoneNumber, latitude, longitude) {
    return buildEnvelope({
        from: phoneNumber,
        id: `sim-loc-${Date.now()}`,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'location',
        location: {
            latitude: parseFloat(latitude),
            longitude: parseFloat(longitude),
        },
    });
}

function buildMediaPayload(phoneNumber, mediaId, mediaType = 'image', forwarded) {
    const msg = {
        from: phoneNumber,
        id: `sim-med-${Date.now()}`,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: mediaType,
    };

    // Mirrors the `context` object WhatsApp attaches to a forwarded message, so
    // the handler's provenance path can be exercised without a real device.
    // Omitted entirely when not requested -- the handler distinguishes "not
    // reported" from "reported as not forwarded".
    if (forwarded !== undefined) {
        msg.context = { forwarded: Boolean(forwarded), frequently_forwarded: false };
    }

    if (mediaType === 'image') msg.image = { id: mediaId, mime_type: 'image/jpeg' };
    else if (mediaType === 'video') msg.video = { id: mediaId, mime_type: 'video/mp4' };
    else if (mediaType === 'audio' || mediaType === 'voice') {
        msg.type = 'audio';
        msg.audio = { id: mediaId, mime_type: 'audio/ogg; codecs=opus' };
    }
    else msg.document = { id: mediaId, mime_type: 'application/octet-stream' };

    return buildEnvelope(msg);
}

module.exports = { createServer, PORT, normalizePhone };
