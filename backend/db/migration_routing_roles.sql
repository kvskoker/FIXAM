-- Routing: default MDAs, and lead/support roles on the category mapping.
--
-- Two gaps this closes:
--
--  1. A report in a category with no MDA mapped alerted nobody. The report was
--     filed and the citizen got a ticket, but no institution was told. Groups
--     marked `is_default` now receive anything unmapped, so a report can never
--     fall into silence because of a gap in configuration.
--
--  2. Several MDAs can share a category (flooding from a blocked drain concerns
--     both drainage and waste), but every one of them was alerted identically,
--     with nobody owning it. `role` distinguishes the institution that owns the
--     fix from those alerted for awareness.
--
-- Safe to re-run.

ALTER TABLE groups ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT FALSE;

-- 'lead'    - owns the resolution
-- 'support' - alerted because they are involved, but not accountable
ALTER TABLE category_groups ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'support';

-- Existing mappings pre-date the distinction. A category mapped to exactly one
-- MDA has an unambiguous owner, so promote those; leave genuinely shared ones
-- as support until an admin nominates the lead.
UPDATE category_groups cg
SET role = 'lead'
WHERE role = 'support'
  AND (SELECT COUNT(*) FROM category_groups x WHERE x.category_id = cg.category_id) = 1;

CREATE INDEX IF NOT EXISTS idx_groups_is_default ON groups (is_default) WHERE is_default;
