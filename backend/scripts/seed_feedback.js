const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function seedFeedback() {
    try {
        console.log('Connecting to database...');
        
        // Get a user
        const userRes = await pool.query('SELECT id FROM users LIMIT 1');
        if (userRes.rows.length === 0) {
            console.log('No users found. Creating a test user...');
            const newUser = await pool.query("INSERT INTO users (phone_number, name) VALUES ('23277000000', 'Test User') RETURNING id");
            userRes.rows.push(newUser.rows[0]);
        }
        const userId = userRes.rows[0].id;

        console.log(`Seeding feedback for user ID: ${userId}`);

        // 1. Text Feedback
        await pool.query(`
            INSERT INTO feedback (user_id, type, content, status, created_at)
            VALUES ($1, 'text', 'The app is great, but I think the map loads a bit slowly on my phone.', 'pending', NOW())
        `, [userId]);
        console.log('Added text feedback.');

        // 2. Audio Feedback
        await pool.query(`
            INSERT INTO feedback (user_id, type, transcription, media_url, status, created_at)
            VALUES ($1, 'audio', 'I noticed a large pothole near the market entrance. Please fix it soon using better materials.', '/uploads/samples/sample_audio.ogg', 'pending', NOW() - INTERVAL '1 hour')
        `, [userId]);
        console.log('Added audio feedback.');

        // 3. Acknowledged Feedback
        await pool.query(`
            INSERT INTO feedback (user_id, type, content, status, created_at)
            VALUES ($1, 'text', 'Thanks for fixing the street light!', 'acknowledged', NOW() - INTERVAL '1 day')
        `, [userId]);
        console.log('Added acknowledged feedback.');

        console.log('Seeding complete.');
    } catch (err) {
        console.error('Error seeding feedback:', err);
    } finally {
        await pool.end();
    }
}

seedFeedback();
