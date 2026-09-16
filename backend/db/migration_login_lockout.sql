-- Login throttling and account lockout.
--
-- The password check on /admin/login had no limit on attempts, so a stolen or
-- guessed phone number could be brute-forced with nothing to stop it. Every
-- failed attempt is now recorded here, and an account locks itself out once
-- five land within a minute.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS login_failures (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) NOT NULL,
    ip_address VARCHAR(45),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_login_failures_phone ON login_failures (phone_number, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_failures_ip ON login_failures (ip_address, created_at DESC);

ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP;
