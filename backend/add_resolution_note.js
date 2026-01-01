
const db = require('./db');

async function runMigration() {
    try {
        console.log('Adding resolution_note column to issues table...');
        
        await db.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='issues' AND column_name='resolution_note') THEN 
                    ALTER TABLE issues ADD COLUMN resolution_note TEXT; 
                END IF;
            END $$;
        `);

        console.log('Migration successful: resolution_note column added.');
        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
}

runMigration();
