-- Emergency response.
--
-- A report is an emergency when its category is on the emergency list or its
-- description carries an emergency keyword. Emergencies skip the duplicate
-- check, are filed with urgency = critical, and alert both the owning MDA and
-- the emergency coordination team (admins plus anyone flagged below).
--
-- The lists live in platform_settings so the admin portal can change what
-- counts as an emergency without a deployment.

-- Users who receive emergency alerts (in addition to admins).
ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_team BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO platform_settings (key, value) VALUES
    ('emergency_categories', 'Fire Services,Natural Disaster Response,Public Safety,Road Safety'),
    ('emergency_keywords', 'emergency,fire,on fire,burning,collapse,collapsed,flood,flooding,injury,serious accident,trapped,drowning')
ON CONFLICT (key) DO NOTHING;
