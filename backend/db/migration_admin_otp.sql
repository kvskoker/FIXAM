-- Second factor for administrator sign-in.
--
-- Administrator access carries every phone number in the system, and until now
-- it was protected by a password alone.
--
-- The code travels over WhatsApp, but the *administrator asks for it* -- they
-- message the bot, the bot replies. That direction matters: a message the
-- platform sends unprompted falls outside WhatsApp's customer service window
-- and would need an approved template, with all the delay and fragility that
-- brings. A reply to an incoming message needs none of that, and it works the
-- same on the day the pilot starts as on any other.
--
-- Possession of the registered WhatsApp account is the second factor: knowing
-- the password is not enough, and holding the phone is not enough either.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS admin_otp (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Hashed, never the code itself. Anyone who can read this table would
    -- otherwise hold a working second factor for every administrator, which
    -- would make the whole exercise decorative.
    code_hash VARCHAR(64) NOT NULL,

    expires_at TIMESTAMP NOT NULL,
    consumed_at TIMESTAMP,

    -- Wrong guesses against this specific code. Six digits is a million
    -- combinations; without a limit, a script would walk them.
    attempts INTEGER NOT NULL DEFAULT 0,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_admin_otp_user ON admin_otp (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_otp_expiry ON admin_otp (expires_at);

-- Only one code is live per administrator at a time: requesting a new one
-- retires the previous, so an old message cannot be replayed.
CREATE INDEX IF NOT EXISTS idx_admin_otp_live
    ON admin_otp (user_id) WHERE consumed_at IS NULL;
