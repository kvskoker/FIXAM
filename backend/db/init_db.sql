-- Ensure columns exist for older database versions
DO $$ 
BEGIN 
    -- Roles table must exist first for foreign key
    CREATE TABLE IF NOT EXISTS roles (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) UNIQUE NOT NULL
    );
    INSERT INTO roles (name) VALUES ('Admin'), ('Operation'), ('User') ON CONFLICT (name) DO NOTHING;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='role_id') THEN 
        ALTER TABLE users ADD COLUMN role_id INTEGER REFERENCES roles(id); 
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='password') THEN 
        ALTER TABLE users ADD COLUMN password TEXT; 
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='last_login') THEN 
        ALTER TABLE users ADD COLUMN last_login TIMESTAMP; 
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='is_disabled') THEN 
        ALTER TABLE users ADD COLUMN is_disabled BOOLEAN DEFAULT FALSE; 
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='created_at') THEN 
        ALTER TABLE users ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP; 
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='updated_at') THEN 
        ALTER TABLE users ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP; 
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='issues' AND column_name='duplicate_of') THEN 
        ALTER TABLE issues ADD COLUMN duplicate_of INTEGER REFERENCES issues(id) ON DELETE SET NULL; 
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='issues' AND column_name='urgency') THEN 
        ALTER TABLE issues ADD COLUMN urgency VARCHAR(20) DEFAULT 'medium'; 
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='issues' AND column_name='resolution_note') THEN 
        ALTER TABLE issues ADD COLUMN resolution_note TEXT; 
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='issues' AND column_name='audio_url') THEN 
        ALTER TABLE issues ADD COLUMN audio_url TEXT; 
    END IF;
END $$;

-- Create Roles Table
CREATE TABLE IF NOT EXISTS roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL
);

-- Insert Default Roles
INSERT INTO roles (name) VALUES ('Admin'), ('Operation'), ('User') ON CONFLICT (name) DO NOTHING;

-- Create Users Table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(255),
    role_id INTEGER REFERENCES roles(id),
    password TEXT,
    is_disabled BOOLEAN DEFAULT FALSE,
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create User Roles Mapping Table (Many-to-Many)
CREATE TABLE IF NOT EXISTS user_roles (
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

-- Create Groups Table
CREATE TABLE IF NOT EXISTS groups (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create User Groups Mapping Table
CREATE TABLE IF NOT EXISTS user_groups (
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, group_id)
);

-- Insert Default Groups
INSERT INTO groups (name, description) VALUES 
('EDSA', 'Electricity Distribution and Supply Authority'),
('SLRSA', 'Sierra Leone Road Safety Authority'),
('MOH', 'Ministry of Health'),
('FCC', 'Freetown City Council'),
('EPA', 'Environmental Protection Agency')
ON CONFLICT (name) DO NOTHING;

-- Create Issues Table
CREATE TABLE IF NOT EXISTS issues (
    id SERIAL PRIMARY KEY,
    ticket_id VARCHAR(10) UNIQUE NOT NULL,
    title VARCHAR(255) NOT NULL,
    category VARCHAR(50) NOT NULL,
    status VARCHAR(20) DEFAULT 'critical', -- critical, progress, fixed
    lat DECIMAL(10, 6) NOT NULL,
    lng DECIMAL(10, 6) NOT NULL,
    description TEXT,
    image_url TEXT,
    audio_url TEXT,
    reported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    duplicate_of INTEGER REFERENCES issues(id) ON DELETE SET NULL,
    urgency VARCHAR(20) DEFAULT 'medium', -- low, medium, high, critical
    resolution_note TEXT,
    reported_on TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create Votes Table
CREATE TABLE IF NOT EXISTS votes (
    id SERIAL PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vote_type VARCHAR(10) NOT NULL CHECK (vote_type IN ('upvote', 'downvote')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(issue_id, user_id) -- One vote per user per issue
);

-- Create Issue Tracker Table (Action Logs)
CREATE TABLE IF NOT EXISTS issue_tracker (
    id SERIAL PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    action VARCHAR(100) NOT NULL, -- e.g., 'reported', 'assigned', 'in_progress', 'resolved', 'verified'
    description TEXT,
    performed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create Conversation State Table
CREATE TABLE IF NOT EXISTS conversation_state (
    phone_number VARCHAR(20) PRIMARY KEY,
    current_step VARCHAR(50),
    data JSONB, -- Store temp data like draft issue details
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create Message Logs Table
CREATE TABLE IF NOT EXISTS message_logs (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20),
    direction VARCHAR(10), -- 'incoming', 'outgoing'
    message_type VARCHAR(20),
    message_body TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_issues_lat_lng ON issues (lat, lng);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues (status);
CREATE INDEX IF NOT EXISTS idx_issues_reported_by ON issues (reported_by);
CREATE INDEX IF NOT EXISTS idx_votes_issue_id ON votes (issue_id);
CREATE INDEX IF NOT EXISTS idx_votes_user_id ON votes (user_id);
CREATE INDEX IF NOT EXISTS idx_issue_tracker_issue_id ON issue_tracker (issue_id);

-- Create a view for issues with vote counts
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

-- Create Categories Table
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

-- Create Category-Group Mapping (Many-to-Many)
CREATE TABLE IF NOT EXISTS category_groups (
    category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
    group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (category_id, group_id)
);
