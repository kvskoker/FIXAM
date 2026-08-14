-- Image provenance for reports.
--
-- Evidence photos previously left no record beyond a file path, so there was no
-- way to answer two questions an admin reasonably asks: has this exact photo
-- been submitted before, and did the reporter actually take it?
--
-- Deliberately NOT an automated relevance check. Whether an image is adequate
-- evidence is a human judgement; these columns give an admin the facts to make
-- it, and the existing spam action to act on it.
--
-- Safe to re-run.

-- SHA-256 of the stored image bytes. Computed locally rather than taken from
-- WhatsApp's `sha256` field so it is consistent across channels (the simulator
-- has no such field) and always matches the file actually on disk.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS image_sha256 VARCHAR(64);

ALTER TABLE issues ADD COLUMN IF NOT EXISTS image_mime_type VARCHAR(100);

-- True when WhatsApp reported the message as forwarded, i.e. the reporter did
-- not take the photo in the moment. NULL means "not reported", which is not the
-- same as false -- see the note in whatsappHandler.js.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS image_forwarded BOOLEAN;

-- The earlier report this photo was already used on, if any.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS image_reused_from INTEGER REFERENCES issues(id) ON DELETE SET NULL;

-- Recycled-evidence lookups hit this on every photo report.
CREATE INDEX IF NOT EXISTS idx_issues_image_sha256 ON issues (image_sha256);
