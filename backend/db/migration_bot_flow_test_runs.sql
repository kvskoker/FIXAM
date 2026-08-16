-- Let a draft questionnaire be run for real before it goes live.
--
-- Reading a questionnaire in an editor tells you what it says. Answering it on
-- a phone tells you what it is like -- whether the wording makes sense out of
-- context, whether the options cover the real answers, whether three questions
-- feels like three or like an interrogation. Nobody should discover that from
-- citizens.
--
-- A test run is an ordinary run with no report behind it, so it exercises the
-- same engine rather than a preview that could drift from the real thing.
--
-- Safe to re-run.

ALTER TABLE bot_flow_runs ALTER COLUMN issue_id DROP NOT NULL;

ALTER TABLE bot_flow_runs ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

-- Who asked for the test, so an unexpected questionnaire arriving on someone's
-- phone can be traced back to whoever sent it.
ALTER TABLE bot_flow_runs ADD COLUMN IF NOT EXISTS started_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bot_flow_runs_test ON bot_flow_runs (is_test) WHERE is_test;
