const express = require('express');
const router = express.Router();
const db = require('../db');
const { analyzeIssue } = require('../services/aiService');
const { sendMessage, requestLocation } = require('../services/whatsappService');

// User session store to track conversation state (still in-memory for now)
const userSessions = {}; 

// GET /api/issues - Fetch all issues from DB with vote counts
router.get('/issues', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT 
                i.*,
                u.name as reported_by_name,
                u.phone_number as reported_by_phone,
                COALESCE(v.upvotes, 0) as upvotes,
                COALESCE(v.downvotes, 0) as downvotes,
                COALESCE(v.net_votes, 0) as votes
            FROM issues i
            LEFT JOIN users u ON i.reported_by = u.id
            LEFT JOIN (
                SELECT 
                    issue_id,
                    SUM(CASE WHEN vote_type = 'upvote' THEN 1 ELSE 0 END) as upvotes,
                    SUM(CASE WHEN vote_type = 'downvote' THEN 1 ELSE 0 END) as downvotes,
                    SUM(CASE WHEN vote_type = 'upvote' THEN 1 WHEN vote_type = 'downvote' THEN -1 ELSE 0 END) as net_votes
                FROM votes
                GROUP BY issue_id
            ) v ON i.id = v.issue_id
            ORDER BY i.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST /api/issues/:id/vote - Vote on an issue
router.post('/issues/:id/vote', async (req, res) => {
    try {
        const { id } = req.params;
        const { user_phone, vote_type } = req.body; // vote_type: 'upvote' or 'downvote'

        if (!user_phone || !vote_type || !['upvote', 'downvote'].includes(vote_type)) {
            return res.status(400).json({ error: 'Invalid request. Provide user_phone and vote_type (upvote/downvote)' });
        }

        // Find or create user
        let userResult = await db.query('SELECT id FROM users WHERE phone_number = $1', [user_phone]);
        let userId;

        if (userResult.rows.length === 0) {
            const insertUser = await db.query(
                'INSERT INTO users (phone_number) VALUES ($1) RETURNING id',
                [user_phone]
            );
            userId = insertUser.rows[0].id;
        } else {
            userId = userResult.rows[0].id;
        }

        // Insert or update vote (using UPSERT)
        await db.query(`
            INSERT INTO votes (issue_id, user_id, vote_type)
            VALUES ($1, $2, $3)
            ON CONFLICT (issue_id, user_id)
            DO UPDATE SET vote_type = $3, created_at = CURRENT_TIMESTAMP
        `, [id, userId, vote_type]);

        res.json({ success: true, message: `${vote_type} recorded` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/issues/:id/tracker - Get issue tracker logs
router.get('/issues/:id/tracker', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db.query(`
            SELECT 
                it.*,
                u.name as performed_by_name,
                u.phone_number as performed_by_phone
            FROM issue_tracker it
            LEFT JOIN users u ON it.performed_by = u.id
            WHERE it.issue_id = $1
            ORDER BY it.created_at ASC
        `, [id]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST /api/webhook - WhatsApp Webhook Verification
router.get('/webhook', (req, res) => {
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
    }
});

// POST /api/webhook - Handle Incoming Messages
router.post('/webhook', async (req, res) => {
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
            const msgBody = message.text ? message.text.body : null;
            const type = message.type;

            // Initialize session
            if (!userSessions[from]) {
                userSessions[from] = { step: 'START' };
            }
            const session = userSessions[from];

            try {
                // Find or create user
                let userResult = await db.query('SELECT id FROM users WHERE phone_number = $1', [from]);
                let userId;

                if (userResult.rows.length === 0) {
                    const insertUser = await db.query(
                        'INSERT INTO users (phone_number) VALUES ($1) RETURNING id',
                        [from]
                    );
                    userId = insertUser.rows[0].id;
                } else {
                    userId = userResult.rows[0].id;
                }

                // Simple State Machine for "Chat-to-Map"
                if (session.step === 'START') {
                    await sendMessage(from, "Welcome to FIXAM! \nReport an issue by replying with a description (e.g., 'Broken street light at Lumley').");
                    session.step = 'DESCRIBE';
                } 
                else if (session.step === 'DESCRIBE' && type === 'text') {
                    // 1. Analyze with AI
                    const analysis = await analyzeIssue(msgBody);
                    session.data = { ...analysis, description: msgBody, userId };
                    
                    await sendMessage(from, `I understood: "${analysis.summary}" (Category: ${analysis.category}). \n\nPlease share the location of this issue (Attachment > Location).`);
                    session.step = 'LOCATION';
                } 
                else if (session.step === 'LOCATION' && type === 'location') {
                    const loc = message.location;
                    session.data.lat = loc.latitude;
                    session.data.lng = loc.longitude;

                    // Save Issue to DB
                    const insertQuery = `
                        INSERT INTO issues (title, category, status, lat, lng, description, image_url, reported_by, reported_on)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
                        RETURNING id
                    `;
                    const values = [
                        session.data.summary,
                        session.data.category,
                        'critical',
                        session.data.lat,
                        session.data.lng,
                        session.data.description,
                        "https://via.placeholder.com/400", // Placeholder
                        session.data.userId
                    ];
                    
                    const result = await db.query(insertQuery, values);
                    const newIssueId = result.rows[0].id;

                    // Log in issue tracker
                    await db.query(`
                        INSERT INTO issue_tracker (issue_id, action, description, performed_by)
                        VALUES ($1, $2, $3, $4)
                    `, [newIssueId, 'reported', 'Issue reported via WhatsApp', session.data.userId]);

                    await sendMessage(from, `Thank you! Your report has been logged. Ticket ID: #${newIssueId}. \nYou can view it on the map.`);
                    session.step = 'START'; // Reset
                } 
                else {
                    await sendMessage(from, "Sorry, I didn't catch that. Please follow the instructions.");
                }
            } catch (err) {
                console.error("Error processing message:", err);
                await sendMessage(from, "An error occurred. Please try again later.");
            }
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

module.exports = router;
