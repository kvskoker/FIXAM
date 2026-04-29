-- DPG Privacy Fix: Migration for consent tracking and data deletion
-- Run this against your existing database BEFORE deploying the code changes.

-- 1. Add consent columns to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_given BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_timestamp TIMESTAMP;

-- 2. Mark all existing users as having given consent (they used the platform before this policy)
--    They will receive a notification about the updated policy via WhatsApp (see whatsappHandler changes).
UPDATE users SET consent_given = TRUE, consent_timestamp = CURRENT_TIMESTAMP WHERE consent_given IS FALSE OR consent_given IS NULL;

-- 3. Pending consent table: tracks new users who have been sent the consent message
--    but have not yet replied YES. We store them here temporarily (not in users table)
--    so we never register someone without consent.
CREATE TABLE IF NOT EXISTS pending_consent (
    phone_number VARCHAR(20) PRIMARY KEY,
    name VARCHAR(100),
    first_message TEXT,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
