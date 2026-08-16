-- Stop labelling every new report "critical".
--
-- Two separate things were sharing one word. `urgency` is what the AI judges
-- about the problem (low, medium, high). `status` is where the report has got
-- to in the work (acknowledged, in progress, resolved). But a new report was
-- given the *status* 'critical', which is an urgency word, and the portal shows
-- status as its badge.
--
-- So a citizen was told their report was LOW urgency and the portal showed the
-- same report as CRITICAL. Both were displaying honestly; they were displaying
-- different fields. The review asked which was authoritative -- the answer was
-- that the question did not have one, which is the actual defect.
--
-- 'reported' says what it means: received, nobody has picked it up yet.
--
-- Safe to re-run.

UPDATE issues SET status = 'reported' WHERE status = 'critical';

-- The old comment on the column described the wrong vocabulary.
COMMENT ON COLUMN issues.status IS
    'Where the report has got to: reported, acknowledged, progress, fixed, spam. '
    'How urgent the problem is lives in issues.urgency.';

COMMENT ON COLUMN issues.urgency IS
    'How urgent the problem is, judged from the description: low, medium, high. '
    'Independent of status.';

-- The tracker recorded the same word for the same reason.
UPDATE issue_tracker SET action = 'reported' WHERE action = 'critical';
