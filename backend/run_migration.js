const db = require('./db');
const fs = require('fs');
const path = require('path');

async function runMigration() {
    const migrationPath = path.join(__dirname, 'db', 'migration_users_groups.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    try {
        console.log('Running migration...');
        await db.query(sql);
        console.log('Migration completed successfully.');
        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
}

runMigration();
