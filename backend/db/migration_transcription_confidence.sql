-- How much the speech engine trusted its own transcription (0..1).
--
-- NULL means "not measured" -- an older report, or a decoder that could not
-- report one. That is deliberately distinct from a low score: the reader must
-- be able to tell "we are unsure" from "we never checked".
--
-- Safe to re-run.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS transcription_confidence NUMERIC(4,3);
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS transcription_confidence NUMERIC(4,3);
