-- Open/closed as a lifecycle state, separate from status.
--
-- Status says how far the work has got: reported, acknowledged, in progress,
-- resolved. It could not say whether a report is finished with, and those are
-- different questions. A report can be finished with without being fixed --
-- the thing was gone by the time anyone looked, it is not actionable, it
-- genuinely cannot be addressed -- and with only a status field those reports
-- had nowhere to go. They sat open forever, inflating every MDA's backlog and
-- telling the citizen nothing.
--
-- So:
--
--   open    - closed_at IS NULL. Still someone's work.
--   closed  - closed_at set, with a reason and an explanation.
--
-- Resolving closes automatically: an institution that has fixed something is
-- not asked to then also declare it finished.
--
-- Closing unresolved requires a reason AND a written explanation, both shown
-- to the citizen and on the public map. Closing a report unresolved is the
-- platform telling someone that nothing further will happen about the problem
-- they reported; that is exactly when an explanation is owed, not optional.
--
-- Safe to re-run.

-- NULL means open. One source of truth, so there is no boolean that can
-- disagree with the timestamp about whether a report is closed.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Fixed vocabulary, so "how many reports were closed without being fixed, and
-- why" is a question the pilot can actually answer:
--   resolved          - the work was done (set automatically)
--   no_longer_present - the problem was gone when the team attended
--   not_actionable    - nothing to act on: unclear, mistaken, or not a report
--   not_feasible      - real, but cannot be addressed (resources, mandate, land)
--   duplicate         - merged into another report
--   spam              - flagged as abuse
ALTER TABLE issues ADD COLUMN IF NOT EXISTS closure_reason VARCHAR(30);
ALTER TABLE issues ADD COLUMN IF NOT EXISTS closure_note TEXT;

CREATE INDEX IF NOT EXISTS idx_issues_closed_at ON issues (closed_at);
CREATE INDEX IF NOT EXISTS idx_issues_open ON issues (created_at) WHERE closed_at IS NULL;

-- A citizen saying "it is not actually fixed" needs to be visible in the
-- portal, not only in an alert somebody may have missed. Counted rather than
-- flagged, so repeated disputes on one report are distinguishable from one.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS dispute_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_issues_disputed ON issues (dispute_count) WHERE dispute_count > 0;

-- Backfill. Reports already resolved, merged or flagged are finished with, and
-- leaving them open would show every MDA a backlog of work already done.
UPDATE issues
SET closed_at = COALESCE(updated_at, created_at),
    closure_reason = 'resolved',
    closure_note = resolution_note
WHERE status = 'fixed' AND closed_at IS NULL;

UPDATE issues
SET closed_at = COALESCE(updated_at, created_at),
    closure_reason = 'spam'
WHERE status = 'spam' AND closed_at IS NULL;

UPDATE issues
SET closed_at = COALESCE(updated_at, created_at),
    closure_reason = 'duplicate'
WHERE duplicate_of IS NOT NULL AND closed_at IS NULL;

-- Disputes raised before this column existed live only in the audit log.
UPDATE issues i
SET dispute_count = sub.n
FROM (
    SELECT issue_id, COUNT(*) AS n
    FROM issue_tracker
    WHERE action = 'resolution_disputed'
    GROUP BY issue_id
) sub
WHERE i.id = sub.issue_id AND i.dispute_count = 0;
