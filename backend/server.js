const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Routes
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
        if (
            body.entry &&
            body.entry[0].changes &&
            body.entry[0].changes[0].value.messages &&
            body.entry[0].changes[0].value.messages[0]
        ) {
            const message = body.entry[0].changes[0].value.messages[0];
            const from = message.from;

            // Simple auto-reply for development
            try {
                const { sendMessage } = require('./services/whatsappService');
                await sendMessage(from, "We have received your message and that Fixam is currently being developed.");
            } catch (err) {
                console.error("Error processing message:", err);
            }
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
