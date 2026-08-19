-- Structured names, and a place to configure what may not be registered.
--
-- Until now a citizen's name was one free-text column filled with whatever they
-- happened to send when the bot asked. The pilot database shows what that
-- produces: "I'm John Doe", "call me John", "I Just Saw This", "Wasup", "Kon3",
-- "Tester", "Who Win The Big Five AI And Blockchain Hackathon?". Those are not
-- edge cases -- they are what a single open-ended question collects.
--
-- Two changes here. First, first_name and last_name so the register holds a
-- name in the shape everything downstream assumes it has. Second, a
-- platform_settings key so the blacklist can be extended from the admin portal
-- when a new brand or institution starts being impersonated, without a
-- deployment.
--
-- `name` stays, and stays authoritative for display. Splitting into columns
-- while leaving the original intact means nothing that reads users.name today
-- has to change, and a bad split can be corrected without data loss.

ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name  VARCHAR(50);

-- Did this name come through the validator, or is it pilot-era free text?
-- Anything FALSE is a candidate for the operator to review or re-ask.
ALTER TABLE users ADD COLUMN IF NOT EXISTS name_verified BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_users_name_verified ON users (name_verified);

-- ── Backfill ────────────────────────────────────────────────────────────────
--
-- Only the unambiguous cases: exactly two words, letters (with the apostrophes
-- and hyphens real names carry) and nothing else, each part at least two
-- characters. "Aminata Kamara" is split and marked verified. Everything else --
-- single words, sentences, anything with a digit -- is left untouched with
-- name_verified FALSE, because guessing at it is how the mess got here.
--
-- Deliberately not attempted in SQL: stripping "I'm" / "call me" prefixes. The
-- parser in services/nameValidator.js does that properly, with the blacklist
-- applied; re-running those users through the bot is safer than a regex here.

UPDATE users
SET first_name = split_part(btrim(name), ' ', 1),
    last_name  = split_part(btrim(name), ' ', 2),
    name_verified = TRUE
WHERE name IS NOT NULL
  AND first_name IS NULL
  AND btrim(name) ~ '^[[:alpha:]][[:alpha:]''-]{1,29}[[:space:]]+[[:alpha:]][[:alpha:]''-]{1,29}$'
  -- Never mark a reserved or brand name as verified, however well-formed it is.
  AND lower(btrim(name)) NOT IN (
      'john doe', 'jane doe', 'joe bloggs', 'foo bar', 'lorem ipsum',
      'fixam sl', 'fixam bot', 'fixam admin', 'fixam team', 'fixam support',
      'sierra leone', 'city council', 'coca cola', 'orange money'
  );

-- ── Configurable blacklist ──────────────────────────────────────────────────
--
-- Added to the built-in list in services/nameValidator.js, never replacing it:
-- an administrator can extend the block list but cannot accidentally empty it.
-- Comma separated. Multi-word entries only block the whole name, so adding
-- "Sierra Leone" here does not stop anyone called Sierra from registering.
INSERT INTO platform_settings (key, value) VALUES
    ('blacklisted_names', '')
ON CONFLICT (key) DO NOTHING;
