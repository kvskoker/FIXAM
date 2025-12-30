-- 1. Insert Operation role
INSERT INTO roles (name) VALUES ('Operation') ON CONFLICT (name) DO NOTHING;

-- 2. Create user_roles table
CREATE TABLE IF NOT EXISTS user_roles (
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

-- 3. Migrate existing roles
INSERT INTO user_roles (user_id, role_id)
SELECT id, role_id FROM users WHERE role_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- 4. Make role_id nullable (for backward compatibility during migration)
ALTER TABLE users ALTER COLUMN role_id DROP NOT NULL;

-- 5. Add is_disabled to users
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='is_disabled') THEN
        ALTER TABLE users ADD COLUMN is_disabled BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- 6. Create groups table
CREATE TABLE IF NOT EXISTS groups (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. Create user_groups table
CREATE TABLE IF NOT EXISTS user_groups (
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, group_id)
);

-- 8. Insert some default groups
INSERT INTO groups (name, description) VALUES 
('EDSA', 'Electricity Distribution and Supply Authority'),
('SLRSA', 'Sierra Leone Road Safety Authority'),
('MOH', 'Ministry of Health'),
('FCC', 'Freetown City Council'),
('EPA', 'Environmental Protection Agency')
ON CONFLICT (name) DO NOTHING;
