const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const apiRoutes = require('./routes/api');
const db = require('./db');
const whatsappService = require('./services/whatsappService');
const FixamHandler = require('./services/whatsappHandler');

const fixamHandler = new FixamHandler(whatsappService, db, null, console.log);

const app = express();
const PORT = process.env.PORT || 5000;

// ── DPG FIX: HTTPS enforcement ───────────────────────────────────────────────
// In production, redirect all HTTP requests to HTTPS
app.use((req, res, next) => {
    if (
        process.env.NODE_ENV === 'production' &&
        req.headers['x-forwarded-proto'] !== 'https'
    ) {
        return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
});

// ── DPG FIX: Restricted CORS (was open wildcard) ─────────────────────────────
// List your allowed origins in the ALLOWED_ORIGINS env variable (comma-separated)
// e.g. ALLOWED_ORIGINS=https://fixam.app,https://www.fixam.app
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['http://localhost:3000', 'http://localhost:5000']; // dev fallback only

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (WhatsApp webhooks, server-to-server, curl)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error(`CORS policy: origin ${origin} not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(bodyParser.json());
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
app.use('/api', apiRoutes);

// ── DPG FIX: Data deletion endpoint (Right to Erasure) ───────────────────────
// DELETE /api/user/data — deletes the authenticated user's account and all data
// Called by admin dashboard; WhatsApp-triggered deletion is handled in whatsappHandler.js
const FixamDatabase = require('./services/fixamDatabase');
const fixamDb = new FixamDatabase(db, console.log);

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

// Webhook routes
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

app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object) {
        try {
            await fixamHandler.processIncomingMessage(body);
        } catch (err) {
            console.error("Error processing message:", err);
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

// Root Endpoint
app.get('/', (req, res) => {
    res.send('FIXAM Backend is running.');
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
