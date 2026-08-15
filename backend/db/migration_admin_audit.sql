-- Audit trail for administrative actions.
--
-- Everything done to a *report* was already recorded in issue_tracker: status
-- changes, closures, reassignments, location corrections, spam flags. Nothing
-- recorded what was done to the *platform*.
--
-- So there was no record of an account being created, a role being granted, an
-- MDA's category mapping being changed, or personal data being exported. Those
-- are precisely the actions that decide who can see what, and precisely the
-- ones an audit is for -- a system where the reports are audited but the
-- granting of access is not, audits the wrong half.
--
-- Kept separate from issue_tracker rather than folded into it: that table hangs
-- off an issue id and cascades when an issue is deleted, which is right for
-- report history and wrong for a security record.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS admin_audit (
    id SERIAL PRIMARY KEY,

    -- Who. Kept if the account is later deleted, because an audit trail that
    -- disappears when someone removes their account is not an audit trail.
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor_name VARCHAR(100),
    actor_phone VARCHAR(20),

    -- What: 'user.create', 'user.update', 'user.delete', 'group.create',
    -- 'group.update', 'group.delete', 'category.create', 'category.update',
    -- 'category.delete', 'export.issues', 'export.users', 'auth.login',
    -- 'auth.login_failed'
    action VARCHAR(50) NOT NULL,

    -- Which record it concerned, where that makes sense.
    target_type VARCHAR(30),
    target_id VARCHAR(50),
    target_label VARCHAR(200),

    -- What changed, or what an export contained. Never credentials.
    detail TEXT,

    ip_address VARCHAR(60),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_actor ON admin_audit (actor_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit (action);
