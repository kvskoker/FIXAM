-- Create Users Table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create Issues Table
CREATE TABLE IF NOT EXISTS issues (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    category VARCHAR(50) NOT NULL,
    status VARCHAR(20) DEFAULT 'critical', -- critical, progress, fixed
    lat DECIMAL(10, 6) NOT NULL,
    lng DECIMAL(10, 6) NOT NULL,
    description TEXT,
    image_url TEXT,
    reported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
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
    COALESCE(SUM(CASE WHEN v.vote_type = 'upvote' THEN 1 ELSE 0 END), 0) AS upvotes,
    COALESCE(SUM(CASE WHEN v.vote_type = 'downvote' THEN 1 ELSE 0 END), 0) AS downvotes,
    COALESCE(SUM(CASE WHEN v.vote_type = 'upvote' THEN 1 WHEN v.vote_type = 'downvote' THEN -1 ELSE 0 END), 0) AS net_votes
FROM issues i
LEFT JOIN votes v ON i.id = v.issue_id
GROUP BY i.id;
