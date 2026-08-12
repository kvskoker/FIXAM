-- Structured location detail for issues.
--
-- Until now a report kept only lat/lng and one free-text `address` string from
-- the geocoder. That is enough to drop a pin, but not to answer "how many open
-- drainage issues in Western Area Urban", to route a report to the MDA that
-- covers a ward, or to tell a precise GPS pin apart from an address the bot
-- could not resolve at all.
--
-- Safe to re-run.

ALTER TABLE issues ADD COLUMN IF NOT EXISTS district VARCHAR(100);
ALTER TABLE issues ADD COLUMN IF NOT EXISTS city VARCHAR(100);
ALTER TABLE issues ADD COLUMN IF NOT EXISTS ward VARCHAR(100);

-- No OSM/Nominatim equivalent exists for either of these. They are populated
-- only when an official boundary set is matched against the point; left NULL
-- otherwise rather than guessed at.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS constituency VARCHAR(100);

-- How the coordinates were obtained, so admins can weigh them:
--   gps        - citizen shared a WhatsApp location pin
--   geocoded   - resolved from an address the citizen typed
--   unresolved - address kept verbatim, no coordinates could be derived
ALTER TABLE issues ADD COLUMN IF NOT EXISTS location_source VARCHAR(20) DEFAULT 'geocoded';

CREATE INDEX IF NOT EXISTS idx_issues_district ON issues (district);
CREATE INDEX IF NOT EXISTS idx_issues_location_source ON issues (location_source);

-- Existing rows predate the distinction: they all have coordinates, but there
-- is no record of how they were captured.
UPDATE issues SET location_source = 'geocoded' WHERE location_source IS NULL;
