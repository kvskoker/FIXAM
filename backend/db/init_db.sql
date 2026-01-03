-- FIXAM Database Schema

-- 1. Roles Table
CREATE TABLE IF NOT EXISTS roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL
);

INSERT INTO roles (name) VALUES ('Admin'), ('User'), ('Operation') ON CONFLICT (name) DO NOTHING;

-- 2. Users Table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(100),
    role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL,
    password TEXT,
    last_login TIMESTAMP,
    is_disabled BOOLEAN DEFAULT FALSE,
    points INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Ensure columns exist if table was already created
ALTER TABLE users ADD COLUMN IF NOT EXISTS points INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_disabled BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_users_points ON users (points DESC);

-- 3. User Roles Table (Many-to-Many)
CREATE TABLE IF NOT EXISTS user_roles (
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

-- 4. Categories Table
CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    icon VARCHAR(50), -- FontAwesome icon class
    color VARCHAR(20), -- Hex color
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert Default Categories
INSERT INTO categories (name, icon, color) VALUES
('Electricity & Power Supply', 'fa-bolt', '#eab308'),
('Water Supply', 'fa-faucet-drip', '#3b82f6'),
('Road Infrastructure', 'fa-road', '#64748b'),
('Public Transportation', 'fa-bus', '#f59e0b'),
('Drainage & Flooding', 'fa-water', '#0ea5e9'),
('Waste Management', 'fa-trash', '#ef4444'),
('Housing & Urban Development', 'fa-city', '#6366f1'),
('Telecommunications', 'fa-tower-cell', '#8b5cf6'),
('Internet Access', 'fa-wifi', '#d946ef'),
('Health Facilities', 'fa-heart-pulse', '#22c55e'),
('Education Facilities', 'fa-school', '#f43f5e'),
('Public Safety', 'fa-shield-halved', '#ef4444'),
('Security', 'fa-lock', '#334155'),
('Fire Services', 'fa-fire-extinguisher', '#dc2626'),
('Social Welfare', 'fa-hand-holding-heart', '#ec4899'),
('Environmental Pollution', 'fa-smog', '#71717a'),
('Deforestation', 'fa-tree', '#16a34a'),
('Animal Control', 'fa-dog', '#a16207'),
('Public Space Maintenance', 'fa-broom', '#14b8a6'),
('Natural Disaster Response', 'fa-house-tsunami', '#b91c1c'),
('Corruption', 'fa-money-bill-transfer', '#854d0e'),
('Accountability', 'fa-scale-balanced', '#1e293b'),
('Local Taxation', 'fa-file-invoice-dollar', '#15803d'),
('Streetlights', 'fa-lightbulb', '#facc15'),
('Bridges & Culverts', 'fa-bridge', '#57534e'),
('Public Buildings', 'fa-building-columns', '#475569'),
('Sewage & Sanitation', 'fa-toilet', '#7c2d12'),
('Traffic Management', 'fa-traffic-light', '#ef4444'),
('Road Safety', 'fa-car-burst', '#b91c1c'),
('Youth Engagement', 'fa-people-group', '#8b5cf6'),
('Gender-Based Violence', 'fa-person-harassing', '#9f1239'),
('Child Protection', 'fa-child-reaching', '#fbbf24'),
('Disability Access', 'fa-wheelchair', '#2563eb'),
('Market Operations', 'fa-shop', '#ea580c'),
('Service Access', 'fa-universal-access', '#06b6d4')
ON CONFLICT (name) DO NOTHING;

-- 5. Groups Table
CREATE TABLE IF NOT EXISTS groups (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO groups (name, description) VALUES 
('EDSA', 'Electricity Distribution and Supply Authority'),
('SLRSA', 'Sierra Leone Road Safety Authority'),
('MOH', 'Ministry of Health'),
('FCC', 'Freetown City Council'),
('EPA', 'Environmental Protection Agency'),
('GUMA', 'Guma Valley Water Company'),
('SLRA', 'Sierra Leone Roads Authority')
ON CONFLICT (name) DO NOTHING;

-- 6. User Groups Table
CREATE TABLE IF NOT EXISTS user_groups (
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, group_id)
);

-- 7. Category Groups Mapping (Routing Logic)
CREATE TABLE IF NOT EXISTS category_groups (
    category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
    group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (category_id, group_id)
);

-- 8. Issues Table
CREATE TABLE IF NOT EXISTS issues (
    id SERIAL PRIMARY KEY,
    ticket_id VARCHAR(10) UNIQUE NOT NULL,
    title VARCHAR(200) NOT NULL,
    category VARCHAR(50), -- De-normalized for easier querying
    lat DECIMAL(10, 8),
    lng DECIMAL(11, 8),
    description TEXT,
    image_url TEXT,
    audio_url TEXT,
    reported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(20) DEFAULT 'critical', -- critical, acknowledged, in_progress, fixed
    urgency VARCHAR(20) DEFAULT 'medium',
    duplicate_of INTEGER REFERENCES issues(id) ON DELETE SET NULL,
    resolution_note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for Issues
CREATE INDEX IF NOT EXISTS idx_issues_lat_lng ON issues (lat, lng);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues (status);
CREATE INDEX IF NOT EXISTS idx_issues_reported_by ON issues (reported_by);

-- 9. Votes Table
CREATE TABLE IF NOT EXISTS votes (
    id SERIAL PRIMARY KEY,
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    vote_type VARCHAR(10) NOT NULL, -- 'upvote' or 'downvote'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(issue_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_votes_issue_id ON votes (issue_id);
CREATE INDEX IF NOT EXISTS idx_votes_user_id ON votes (user_id);

-- 10. Conversation State (WhatsApp Session)
CREATE TABLE IF NOT EXISTS conversation_state (
    phone_number VARCHAR(20) PRIMARY KEY,
    current_step VARCHAR(50),
    data JSONB,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 11. Message Logs
CREATE TABLE IF NOT EXISTS message_logs (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20),
    direction VARCHAR(10), -- 'incoming', 'outgoing'
    message_type VARCHAR(20),
    message_body TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 12. Issue Tracker (Audit Log)
CREATE TABLE IF NOT EXISTS issue_tracker (
    id SERIAL PRIMARY KEY,
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
    action VARCHAR(50) NOT NULL, -- 'created', 'status_change', 'merge', etc.
    description TEXT,
    performed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_issue_tracker_issue_id ON issue_tracker (issue_id);

-- 13. User Point Logs (Gamification)
CREATE TABLE IF NOT EXISTS user_point_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    action_type VARCHAR(50) NOT NULL, -- 'report_created', 'issue_resolved', 'issue_upvoted'
    related_issue_id INTEGER REFERENCES issues(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 14. View for Issues with Vote Counts
DROP VIEW IF EXISTS issues_with_votes;
CREATE OR REPLACE VIEW issues_with_votes AS
SELECT 
    i.*,
    COALESCE(v_agg.upvotes, 0) AS upvotes,
    COALESCE(v_agg.downvotes, 0) AS downvotes,
    COALESCE(v_agg.net_votes, 0) AS net_votes
FROM issues i
LEFT JOIN (
    SELECT 
        COALESCE(i2.duplicate_of, i2.id) as effective_issue_id,
        SUM(CASE WHEN v.vote_type = 'upvote' THEN 1 ELSE 0 END) AS upvotes,
        SUM(CASE WHEN v.vote_type = 'downvote' THEN 1 ELSE 0 END) AS downvotes,
        SUM(CASE WHEN v.vote_type = 'upvote' THEN 1 WHEN v.vote_type = 'downvote' THEN -1 ELSE 0 END) AS net_votes
    FROM votes v
    JOIN issues i2 ON v.issue_id = i2.id
    GROUP BY COALESCE(i2.duplicate_of, i2.id)
) v_agg ON i.id = v_agg.effective_issue_id;

-- Seed Category-Group mappings (Simplified for key categories)
DO $$
DECLARE
    cat_electricity INT;
    cat_water INT;
    cat_roads INT;
    cat_health INT;
    cat_waste INT;
    
    grp_edsa INT;
    grp_guma INT;
    grp_slra INT;
    grp_moh INT;
    grp_fcc INT;
    grp_epa INT;
BEGIN
    SELECT id INTO cat_electricity FROM categories WHERE name = 'Electricity & Power Supply';
    SELECT id INTO cat_water FROM categories WHERE name = 'Water Supply';
    SELECT id INTO cat_roads FROM categories WHERE name = 'Road Infrastructure';
    SELECT id INTO cat_health FROM categories WHERE name = 'Health Facilities';
    SELECT id INTO cat_waste FROM categories WHERE name = 'Waste Management';

    SELECT id INTO grp_edsa FROM groups WHERE name = 'EDSA';
    SELECT id INTO grp_guma FROM groups WHERE name = 'GUMA';
    SELECT id INTO grp_slra FROM groups WHERE name = 'SLRA';
    SELECT id INTO grp_moh FROM groups WHERE name = 'MOH';
    SELECT id INTO grp_fcc FROM groups WHERE name = 'FCC';
    SELECT id INTO grp_epa FROM groups WHERE name = 'EPA';

    -- Insert mappings
    INSERT INTO category_groups (category_id, group_id) VALUES 
    (cat_electricity, grp_edsa),
    (cat_water, grp_guma),
    (cat_roads, grp_slra),
    (cat_health, grp_moh),
    (cat_waste, grp_fcc),
    (cat_waste, grp_epa)
    ON CONFLICT DO NOTHING;
END $$;
