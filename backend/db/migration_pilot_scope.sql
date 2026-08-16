-- Pilot scope and SLA tracking.
--
-- The pilot runs in Freetown with a fixed set of community champions. When
-- pilot mode is on, only users flagged `pilot_activated` may submit reports;
-- everyone else can still vote, track and give feedback, but their report is
-- refused. This is the "scoping to users" the review asked for -- there is no
-- volume cap, because only the champions are expected to file reports.
--
-- The switches and numbers live in platform_settings rather than the
-- environment so a decision made on the dashboard does not require a
-- deployment.

-- Which users may report during the pilot.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pilot_activated BOOLEAN NOT NULL DEFAULT FALSE;

-- Platform switches and SLA targets, editable from the admin portal.
CREATE TABLE IF NOT EXISTS platform_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO platform_settings (key, value) VALUES
    -- pilot_mode 'true' restricts reporting to activated champions;
    -- 'false' is the live, public-reporting state.
    ('pilot_mode', 'false'),
    ('sla_acknowledge_hours', '24'),
    ('sla_progress_hours', '72'),
    ('sla_resolution_days', '30')
ON CONFLICT (key) DO NOTHING;

-- When the owning institution first acknowledged the report, and when work
-- started. The SLA sweep measures against these rather than deriving them from
-- the tracker, so the clock reflects when the institution actually acted.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMP;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS progress_at TIMESTAMP;
