-- Mode-aware views, so "what am I looking at" is answered once.
--
-- migration_data_mode.sql labelled every record. This decides which labels are
-- visible, and does it in the database rather than in each of the twenty-odd
-- queries that list or count reports. Threading a filter through all of them by
-- hand would work until somebody adds the twenty-first.
--
-- The rule, in full:
--
--   Demo (test)   sees test        -- while demonstrating, live reports are
--                                     not yours to browse
--   Pilot         sees pilot       -- demo noise stays out of pilot numbers
--   Live          sees live, pilot -- pilot reports are real problems reported
--                                     by real people; a pothole does not stop
--                                     existing because it was reported a week
--                                     before launch
--
-- Only reads go through these views. Inserts, updates and deletes still address
-- `issues` directly, which is what lets an administrator clean up demo data
-- while the platform is in live mode and cannot see it.

-- Which tags the current mode may see.
CREATE OR REPLACE FUNCTION current_visible_modes() RETURNS TEXT[] AS $$
    SELECT CASE current_data_mode()
        WHEN 'test'  THEN ARRAY['test']
        WHEN 'pilot' THEN ARRAY['pilot']
        WHEN 'live'  THEN ARRAY['live', 'pilot']
        -- An unset or corrupted setting shows fewer records rather than more.
        ELSE ARRAY['pilot']
    END;
$$ LANGUAGE sql STABLE;

-- Dropped and recreated rather than CREATE OR REPLACE'd.
--
-- A view built on SELECT * fixes its column list at creation time, so it does
-- not pick up a column later added to `issues` -- and every query reading the
-- view would silently miss it. Re-run this file after any migration that adds
-- a column to `issues`. CASCADE because issues_with_votes depends on it; it is
-- recreated immediately below.
DROP VIEW IF EXISTS issues_with_votes;
DROP VIEW IF EXISTS visible_issues CASCADE;

-- Every report the current mode may see. A drop-in replacement for `issues` in
-- any read query: same columns, fewer rows.
CREATE VIEW visible_issues AS
SELECT * FROM issues
WHERE data_mode = ANY(current_visible_modes());

-- Vote counts, filtered the same way.
--
-- The vote aggregate deliberately still counts across `issues`: a report's vote
-- total is a property of the report, and it should not appear to drop because
-- the viewer switched mode. Only which reports are listed changes.
CREATE VIEW issues_with_votes AS
SELECT
    i.*,
    COALESCE(v_agg.upvotes, 0) AS upvotes,
    COALESCE(v_agg.downvotes, 0) AS downvotes,
    COALESCE(v_agg.net_votes, 0) AS net_votes
FROM visible_issues i
LEFT JOIN (
    SELECT
        COALESCE(i2.duplicate_of, i2.id) AS effective_issue_id,
        SUM(CASE WHEN v.vote_type = 'upvote' THEN 1 ELSE 0 END) AS upvotes,
        SUM(CASE WHEN v.vote_type = 'downvote' THEN 1 ELSE 0 END) AS downvotes,
        SUM(CASE WHEN v.vote_type = 'upvote' THEN 1 WHEN v.vote_type = 'downvote' THEN -1 ELSE 0 END) AS net_votes
    FROM votes v
    JOIN issues i2 ON v.issue_id = i2.id
    GROUP BY COALESCE(i2.duplicate_of, i2.id)
) v_agg ON i.id = v_agg.effective_issue_id;

-- Counts per mode, for the portal's mode switcher: an operator about to move to
-- Live should be able to see how much demo data is still in the database.
CREATE OR REPLACE VIEW data_mode_summary AS
SELECT
    m.data_mode,
    (SELECT COUNT(*) FROM issues   WHERE data_mode = m.data_mode) AS issues,
    (SELECT COUNT(*) FROM users    WHERE data_mode = m.data_mode) AS users,
    (SELECT COUNT(*) FROM votes    WHERE data_mode = m.data_mode) AS votes,
    (SELECT COUNT(*) FROM feedback WHERE data_mode = m.data_mode) AS feedback
FROM (VALUES ('test'), ('pilot'), ('live')) AS m(data_mode);
