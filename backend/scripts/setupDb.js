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

async function runSqlFile(filename) {
    const filePath = path.join(__dirname, '../db', filename);
    try {
        const sql = fs.readFileSync(filePath, 'utf8');
        console.log(`Running ${filename}...`);
        await pool.query(sql);
        console.log(`Successfully executed ${filename}`);
    } catch (err) {
        console.error(`Error executing ${filename}:`, err);
    }
}

async function main() {
    const args = process.argv.slice(2);
    
    if (args.includes('drop')) {
        await runSqlFile('drop_tables.sql');
    }
    
    if (args.includes('init')) {
        await runSqlFile('init_db.sql');
    }
    
    if (args.includes('seed')) {
        await runSqlFile('mock_data.sql');
    }

    if (args.length === 0) {
        console.log("Usage: node setupDb.js [drop] [init] [seed]");
        console.log("  drop: Drop all existing tables");
        console.log("  init: Run init_db.sql to create tables");
        console.log("  seed: Run mock_data.sql to insert dummy data");
    }

    await pool.end();
}

main();
