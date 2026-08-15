-- Route feedback to whoever can act on it.
--
-- Feedback arrived in one undifferentiated pile that only a full Admin could
-- read, which conflated two unrelated things: a complaint about uncollected
-- waste, which FCC can act on, and "the bot did not understand my voice note",
-- which only MoCTI and DSTI can. Neither reached the right desk.
--
-- Feedback is now classified on arrival into one of two destinations:
--
--   'platform' - about FIXAM itself: the bot, the app, the process. Stays with
--                MoCTI/DSTI and is not shown to MDAs.
--   'service'  - about a public service, carrying a category, and routed to the
--                MDA that owns that category the same way a report is.
--
-- The classification is a suggestion. An Admin can re-route anything, and the
-- override is recorded so we can tell a machine decision from a human one.
--
-- Safe to re-run.

ALTER TABLE feedback ADD COLUMN IF NOT EXISTS scope VARCHAR(20);
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS category VARCHAR(100);
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS routed_group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL;

-- 'ai' or 'admin'. Nothing distinguishes an unreviewed guess from a decision
-- someone made without this.
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS routing_source VARCHAR(20);
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS routing_confidence NUMERIC(4,3);
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS routed_at TIMESTAMP;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS routed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_feedback_scope ON feedback (scope);
CREATE INDEX IF NOT EXISTS idx_feedback_routed_group ON feedback (routed_group_id);
CREATE INDEX IF NOT EXISTS idx_feedback_category ON feedback (category);

-- Feedback that predates this is unclassified rather than assumed to be about
-- the platform: an MDA should not inherit a backlog nobody looked at, and an
-- Admin should be able to see what still needs a decision.
UPDATE feedback SET scope = 'unclassified' WHERE scope IS NULL;
