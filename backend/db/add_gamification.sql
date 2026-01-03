-- Add points column to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS points INTEGER DEFAULT 0;

-- Create table to log point transaction history
CREATE TABLE IF NOT EXISTS user_point_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    action_type VARCHAR(50) NOT NULL, -- 'report_created', 'issue_resolved', 'issue_upvoted'
    related_issue_id INTEGER REFERENCES issues(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for leadership board queries
CREATE INDEX IF NOT EXISTS idx_users_points ON users (points DESC);
