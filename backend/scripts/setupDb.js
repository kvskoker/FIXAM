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

const crypto = require('crypto');

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

async function ensureSuperAdmin() {
    const phone = process.env.SUPER_ADMIN_PHONE;
    const password = process.env.SUPER_ADMIN_PASSWORD;

    if (!phone || !password || phone.includes('X') || password === 'your_super_admin_password') {
        console.log('Skipping Super Admin creation: SUPER_ADMIN_PHONE or SUPER_ADMIN_PASSWORD not set in .env');
        return;
    }

    console.log(`Ensuring Super Admin (${phone}) exists...`);
    
    // Hash password (SHA-512 with phone as salt)
    const hashedPassword = crypto.createHash('sha512').update(password + phone).digest('hex');

    try {
        // 1. Get Admin role ID
        const roleRes = await pool.query("SELECT id FROM roles WHERE name = 'Admin'");
        if (roleRes.rows.length === 0) {
            console.error('Error: Admin role not found. Run init first.');
            return;
        }
        const adminRoleId = roleRes.rows[0].id;

        // 2. Upsert User
        const userRes = await pool.query(`
            INSERT INTO users (phone_number, name, password, role_id)
            VALUES ($1, 'Super Admin', $2, $3)
            ON CONFLICT (phone_number) 
            DO UPDATE SET 
                password = EXCLUDED.password,
                role_id = EXCLUDED.role_id,
                name = EXCLUDED.name
            RETURNING id
        `, [phone, hashedPassword, adminRoleId]);

        const userId = userRes.rows[0].id;

        // 3. Ensure role mapping in user_roles
        await pool.query(`
            INSERT INTO user_roles (user_id, role_id)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING
        `, [userId, adminRoleId]);

        console.log(`Super Admin (${phone}) is ready.`);
    } catch (err) {
        console.error('Error ensuring Super Admin:', err);
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

    // Always ensure Super Admin exists if we initialized or seeded
    if (args.includes('init') || args.includes('seed')) {
        await ensureSuperAdmin();
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
