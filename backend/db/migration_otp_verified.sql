-- Distinguish a code that was used from one that was merely retired.
--
-- Requesting a new code retires the previous one, and both retirement and
-- successful use were recorded the same way: consumed_at. That made the two
-- indistinguishable, so the hourly limit counted every code ever issued --
-- including the ones that led to a successful sign-in.
--
-- The effect was that signing in, signing out and signing in again used up the
-- allowance, and an administrator doing nothing wrong was locked out with a
-- message suggesting someone knew their password.
--
-- The limit exists to stop unwanted codes arriving on someone's phone. A code
-- that was actually used to sign in is evidence of the opposite, so only
-- unverified codes count towards it now.
--
-- Safe to re-run.

ALTER TABLE admin_otp ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_admin_otp_unverified
    ON admin_otp (user_id, created_at) WHERE NOT verified;
