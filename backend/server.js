const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
require('./loadEnv');

const apiRoutes = require('./routes/api');
const db = require('./db');
const fixamHandler = require('./services/bot');

const app = express();
const PORT = process.env.PORT || 5000;

// ── Proxy awareness ──────────────────────────────────────────────────────────
//
// Nothing reaches this process directly: a request crosses Cloudflare, the host
// nginx that terminates TLS, and the frontend container that routes /api and
// /webhook. Without telling Express that, req.ip is the last proxy's address --
// so express-rate-limit counts every citizen in the country as one client and
// the limit becomes global instead of per-IP.
//
// The number is how many proxies sit in front, counted from this process
// outwards. It is configurable because that count is a property of the
// deployment, not of the code: behind Cloudflare + nginx + frontend it is 2;
// running the stack locally with only the frontend container it is 1.
//
// Verify rather than assume -- GET /healthz reports the client IP it derived.
// If that is your own address, the setting is right. If it is 172.x or a
// Cloudflare address, raise or lower it by one.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 2));

// ── DPG FIX: HTTPS enforcement ───────────────────────────────────────────────
// In production, redirect all HTTP requests to HTTPS.
//
// Reads the header rather than req.secure on purpose: this has to work whether
// or not the trust setting above is correct for the deployment. The health
// check is exempt so a monitor hitting it over the internal network is not
// bounced into a redirect it cannot follow.
app.use((req, res, next) => {
    if (
        process.env.NODE_ENV === 'production' &&
        req.path !== '/healthz' &&
        req.headers['x-forwarded-proto'] !== 'https'
    ) {
        return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
});

// ── DPG FIX: Restricted CORS (was open wildcard) ─────────────────────────────
// Set ALLOWED_ORIGINS env variable to a comma-separated list of allowed origins.
// Falls back to localhost + the demo deployment if not configured.
// Example: ALLOWED_ORIGINS=https://fixam.sl,https://www.fixam.sl,https://fixam.maxcit.com
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : [
        'http://localhost:3000',
        'http://localhost:5000',
        'http://localhost:4000',
        'https://fixam.maxcit.com',   // demo deployment
        'http://fixam.maxcit.com',    // demo (non-https fallback)
      ];

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (WhatsApp webhooks, server-to-server, curl, Postman)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        // Log the rejection for debugging, then reject
        console.warn(`CORS blocked origin: ${origin}. Add it to ALLOWED_ORIGINS env variable.`);
        return callback(new Error(`CORS policy: origin ${origin} not allowed. Contact the administrator to add this origin.`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Access'],
}));

// The raw body is kept alongside the parsed one because Meta's webhook
// signature is computed over the exact bytes sent. Re-serialising req.body
// produces different bytes -- key order, whitespace, unicode escaping -- and
// the signature would never match.
app.use(bodyParser.json({
    verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(bodyParser.urlencoded({ extended: true }));

// Rate Limiter
const rateLimit = require('express-rate-limit');
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." }
});

// Routes
app.use('/api', apiLimiter);

// Questionnaire authoring. A separate router because the approval workflow is
// self-contained, and api.js is long enough already.
app.use('/api', require('./routes/botFlowRoutes'));

app.use('/api', apiRoutes);

// ── DPG FIX: Data deletion endpoint (Right to Erasure) ───────────────────────
// DELETE /api/user/data — deletes the authenticated user's account and all data
// Called by admin dashboard; WhatsApp-triggered deletion is handled in whatsappHandler.js
const fixamDb = fixamHandler.fixamDb;

app.delete('/api/user/data', async (req, res) => {
    // Expect phone_number in request body (admin tool) or from auth token
    const phoneNumber = req.body.phone_number;
    if (!phoneNumber) {
        return res.status(400).json({ error: 'phone_number is required' });
    }
    try {
        const deleted = await fixamDb.deleteUser(phoneNumber);
        if (!deleted) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({ success: true, message: 'User and all associated data permanently deleted.' });
    } catch (err) {
        console.error('Delete user error:', err);
        res.status(500).json({ error: 'Failed to delete user.' });
    }
});

// ── DPG FIX: Data export endpoint (Data Portability) ─────────────────────────
// GET /api/user/data?phone_number=232XXXXXXX
app.get('/api/user/data', async (req, res) => {
    const phoneNumber = req.query.phone_number;
    if (!phoneNumber) {
        return res.status(400).json({ error: 'phone_number is required' });
    }
    try {
        const data = await fixamDb.getUserData(phoneNumber);
        if (!data || !data.profile) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.setHeader('Content-Disposition', 'attachment; filename="my-fixam-data.json"');
        res.json(data);
    } catch (err) {
        console.error('Data export error:', err);
        res.status(500).json({ error: 'Failed to export data.' });
    }
});

// Webhook routes. These are the only webhook handlers now: the router in
// api.js used to expose a second copy under /api/webhook with different
// failure behaviour, and nginx pointed Meta at this one, so this is the one
// that stays.
app.get('/webhook', (req, res) => {
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
    } else {
        res.sendStatus(400);
    }
});

/**
 * Is this delivery really from Meta?
 *
 * Meta signs every webhook POST with an HMAC-SHA256 of the raw body, keyed on
 * the app secret, in X-Hub-Signature-256. Without checking it, `/webhook` is an
 * open endpoint that accepts anything shaped like a WhatsApp payload -- anyone
 * who finds the URL can file reports, cast votes and send messages as any
 * citizen, and nothing afterwards can distinguish those from real ones.
 *
 * Returns { ok } or { ok: false, reason } so the caller can log precisely why.
 */
function verifyMetaSignature(req) {
    const secret = process.env.WHATSAPP_APP_SECRET;

    if (!secret) {
        // Unconfigured rather than invalid. Refusing every delivery here would
        // turn a missing setting into a silent outage, so this is allowed
        // through and shouted about at startup instead.
        return { ok: true, reason: 'unverified_no_secret' };
    }
    if (!req.rawBody || !req.rawBody.length) {
        return { ok: false, reason: 'no_raw_body' };
    }

    const header = req.get('x-hub-signature-256') || '';
    const [scheme, provided] = header.split('=');
    if (scheme !== 'sha256' || !provided) {
        return { ok: false, reason: 'missing_signature' };
    }

    const expected = crypto.createHmac('sha256', secret)
        .update(req.rawBody)
        .digest('hex');

    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(provided, 'hex');
    // timingSafeEqual throws on a length mismatch, so check that first.
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return { ok: false, reason: 'signature_mismatch' };
    }
    return { ok: true };
}

app.post('/webhook', (req, res) => {
    const check = verifyMetaSignature(req);
    if (!check.ok) {
        // 403 and nothing else. A forged delivery gets no detail about why it
        // was refused, and Meta never sees this path for a genuine one.
        console.warn(`Rejected unsigned webhook delivery: ${check.reason}`);
        return res.sendStatus(403);
    }
    if (check.reason === 'unverified_no_secret') {
        console.warn('WEBHOOK UNVERIFIED: set WHATSAPP_APP_SECRET to authenticate deliveries');
    }

    const body = req.body;

    if (body.object) {
        // Acknowledge immediately and process in the background. Meta retries a
        // webhook it has not heard from, so waiting for the whole conversation
        // (AI, geocoding, media) before replying risks the same message being
        // delivered again.
        fixamHandler.processIncomingMessage(body)
            .catch(err => console.error("Error processing message:", err));

        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

// Root Endpoint
app.get('/', (req, res) => {
    res.send('FIXAM Backend is running.');
});

/**
 * Health check with enough depth to be worth monitoring.
 *
 * `GET /` returns a fixed string without touching anything, so an uptime check
 * pointed at it reports green while the database is unreachable. This one
 * actually asks, and returns 503 when a dependency is down -- which is what
 * makes an alert fire.
 *
 * It also echoes the client IP Express derived, which is the only practical way
 * to confirm TRUST_PROXY_HOPS is right for this deployment: call it from your
 * own machine and check the address is yours.
 */
app.get('/healthz', async (req, res) => {
    const checks = {};

    try {
        await db.query('SELECT 1');
        checks.database = 'ok';
    } catch (err) {
        checks.database = `error: ${err.message}`;
    }

    // The AI engine is not required for the platform to accept reports --
    // categories fall back to Uncategorized and voice notes go untranscribed --
    // so it is reported but does not decide the status code.
    try {
        const url = `${process.env.AI_SERVICE_URL || 'http://localhost:8000'}/health`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        checks.ai_engine = response.ok ? 'ok' : `http ${response.status}`;
    } catch (err) {
        checks.ai_engine = `unreachable: ${err.message}`;
    }

    const healthy = checks.database === 'ok';
    res.status(healthy ? 200 : 503).json({
        status: healthy ? 'ok' : 'degraded',
        checks,
        client_ip: req.ip,               // confirms TRUST_PROXY_HOPS
        uptime_seconds: Math.round(process.uptime()),
    });
});

// Start Server
const { ensureSuperAdmin } = require('./services/bootstrapAdmin');

const retention = require('./services/retention');
const slaService = require('./services/slaService');

app.listen(PORT, async () => {
    console.log(`Server is running on port ${PORT}`);
    // After listen, so a slow database cannot delay the port opening.
    await ensureSuperAdmin(db);

    // Ensure the pilot/SLA schema exists on databases that were created before
    // the migration files ran, so the toggle works without a manual step.
    await slaService.ensureSchema(db);

    // 2FA on with no administrator who can receive a code locks everyone out,
    // and does it silently. Say so at boot, while somebody is still watching
    // the logs, rather than at the moment they need to sign in.
    const adminReadiness = require('./services/adminReadiness');
    await adminReadiness.warnIfLockedOut(
        db,
        String(process.env.ADMIN_2FA_ENABLED ?? 'true').toLowerCase() !== 'false'
    );

    // The privacy policy states retention periods; this is what enforces them.
    retention.schedule(db);

    // Flags reports that have missed their acknowledge / progress SLA.
    slaService.schedule(db);

    // Repairs reports left without an administrative area by a geocoder blip.
    require('./services/locationBackfill').schedule();
});
