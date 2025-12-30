const db = require('./db');

async function run() {
    try {
        console.log('Adding duplicate_of column to issues table...');
        await db.query('ALTER TABLE issues ADD COLUMN IF NOT EXISTS duplicate_of INTEGER REFERENCES issues(id) ON DELETE SET NULL;');
        console.log('Column added successfully.');
        process.exit(0);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

run();
