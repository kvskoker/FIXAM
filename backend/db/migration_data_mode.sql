-- Label every record with the phase of the platform that produced it.
--
-- Three phases, and the distinction matters as soon as anyone asks "how many
-- reports have we had?":
--
--   test   Data that came from building the thing -- the hackathon demo, the
--          old server, anything filed before this platform was real. Migrated
--          rows get this, unconditionally.
--   pilot  Real reports from the community champions during the pilot.
--   live   Public operation.
--
-- Deliberately separate from `pilot_mode`. That setting controls *who may
-- report*; this one records *what the data is*. They move independently: a
-- pilot can be opened to the public for a day without reclassifying the
-- backlog, and the label on a report must never change because an access rule
-- changed.
--
-- The stamping happens in the database, not the application. A column default
-- calling current_data_mode() means every INSERT is labelled correctly whether
-- it came from the bot, the admin portal, a migration or a psql session --
-- there is no code path that can forget. Adding it to the four INSERT
-- statements in fixamDatabase.js would have left exactly that gap.

-- platform_settings comes from migration_pilot_scope.sql; create it here too so
-- this migration is safe to run standalone against an older database.
CREATE TABLE IF NOT EXISTS platform_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 'pilot' is the right default for a fresh install: the pilot is what happens
-- next. A restored database has its historical rows forced to 'test' below,
-- regardless of this value.
INSERT INTO platform_settings (key, value) VALUES ('data_mode', 'pilot')
ON CONFLICT (key) DO NOTHING;

-- The current phase, read at insert time. STABLE rather than IMMUTABLE: the
-- answer changes when an administrator changes the setting, but never within a
-- single statement.
CREATE OR REPLACE FUNCTION current_data_mode() RETURNS TEXT AS $$
    SELECT COALESCE(
        (SELECT value FROM platform_settings WHERE key = 'data_mode'),
        'pilot'
    );
$$ LANGUAGE sql STABLE;

-- Applied to every table that holds something a citizen produced.
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['issues', 'users', 'votes', 'feedback', 'endorsements']
    LOOP
        IF to_regclass('public.' || t) IS NULL THEN
            CONTINUE;
        END IF;

        -- Three steps rather than one ADD COLUMN ... DEFAULT, and the order is
        -- the point: add the column empty, force every pre-existing row to
        -- 'test', and only then attach the default. Adding the column with the
        -- default already attached would stamp the historical rows with
        -- whatever the current setting happens to say.
        EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS data_mode VARCHAR(10)', t);
        EXECUTE format('UPDATE %I SET data_mode = ''test'' WHERE data_mode IS NULL', t);
        EXECUTE format('ALTER TABLE %I ALTER COLUMN data_mode SET DEFAULT current_data_mode()', t);
        EXECUTE format('ALTER TABLE %I ALTER COLUMN data_mode SET NOT NULL', t);

        EXECUTE format(
            'ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_data_mode_check');
        EXECUTE format(
            'ALTER TABLE %I ADD CONSTRAINT %I CHECK (data_mode IN (''test'', ''pilot'', ''live''))',
            t, t || '_data_mode_check');

        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON %I (data_mode)', 'idx_' || t || '_data_mode', t);
    END LOOP;
END $$;

-- Reporting convenience: counts per phase, so "how many real reports" is one
-- query rather than a remembered WHERE clause.
CREATE OR REPLACE VIEW issue_counts_by_mode AS
SELECT data_mode, status, COUNT(*) AS issues
FROM issues
GROUP BY data_mode, status;
