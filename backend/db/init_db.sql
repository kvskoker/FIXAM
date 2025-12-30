-- Create Roles Table
CREATE TABLE IF NOT EXISTS roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL
);

-- Insert Default Roles
INSERT INTO roles (name) VALUES ('Admin'), ('User') ON CONFLICT (name) DO NOTHING;

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
    reported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    duplicate_of INTEGER REFERENCES issues(id) ON DELETE SET NULL,
    urgency VARCHAR(20) DEFAULT 'medium', -- low, medium, high, critical
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
('Water', 'fa-faucet-drip', '#3b82f6'),
('Road', 'fa-road', '#64748b'),
('Waste', 'fa-trash', '#ef4444'),
('Electricity', 'fa-bolt', '#eab308'),
('Health', 'fa-heart-pulse', '#22c55e')
ON CONFLICT (name) DO NOTHING;
