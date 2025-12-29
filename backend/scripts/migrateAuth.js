const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { hashPassword } = require('../services/authService');
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

async function createAdmin() {
    const phone = '000';
    const password = 'admin';
    const name = 'System Admin';
    const hashedPassword = hashPassword(password, phone);

    try {
        // Get Admin role ID
        const roleRes = await pool.query('SELECT id FROM roles WHERE name = $1', ['Admin']);
        if (roleRes.rows.length === 0) {
            console.error('Admin role not found');
            return;
        }
        const roleId = roleRes.rows[0].id;

        // Check if user exists
        const userRes = await pool.query('SELECT * FROM users WHERE phone_number = $1', [phone]);
        
        if (userRes.rows.length === 0) {
            console.log('Creating default admin user...');
            await pool.query(
                'INSERT INTO users (phone_number, name, password, role_id) VALUES ($1, $2, $3, $4)',
                [phone, name, hashedPassword, roleId]
            );
            console.log('Admin user created: 000 / admin');
        } else {
            console.log('Admin user already exists. Updating password and role...');
            await pool.query(
                'UPDATE users SET password = $1, role_id = $2, name = $3 WHERE phone_number = $4',
                [hashedPassword, roleId, name, phone]
            );
            console.log('Admin user updated.');
        }
    } catch (err) {
        console.error('Error creating admin:', err);
    }
}

async function main() {
    await runSqlFile('update_users_auth.sql');
    await createAdmin();
    await pool.end();
}

main();
