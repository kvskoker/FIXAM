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

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Rate Limiter
const rateLimit = require('express-rate-limit');
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 60, // Limit each IP to 60 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." }
});

// Routes
app.use('/api', apiLimiter);
app.use('/api', apiRoutes);

// Webhook routes (also available at root level for easier integration)
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
