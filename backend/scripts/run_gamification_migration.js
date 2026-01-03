const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function runSQL() {
    try {
        const filePath = path.join(__dirname, '../db/add_gamification.sql');
        const sql = fs.readFileSync(filePath, 'utf8');
        console.log('Running add_gamification.sql...');
        await pool.query(sql);
        console.log('Success!');
    } catch (err) {
        console.error(err);
    } finally {
        await pool.end();
    }
}

runSQL();
