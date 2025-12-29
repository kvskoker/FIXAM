-- Create roles table
CREATE TABLE IF NOT EXISTS roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL
);

-- Insert default roles
INSERT INTO roles (name) VALUES ('Admin'), ('User') ON CONFLICT (name) DO NOTHING;

-- Add new columns to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id INTEGER REFERENCES roles(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP;

-- Set default role for existing users as 'User'
UPDATE users SET role_id = (SELECT id FROM roles WHERE name = 'User') WHERE role_id IS NULL;

-- Example: Create an admin user if not exists (phone: 000, password: admin)
-- The password hash for 'admin' with salt '000' should be generated via the app.
-- For now, we just leave it and I will handle it in a script.
