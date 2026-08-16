-- Configurable follow-up questionnaires.
--
-- The reporting flow is deliberately three questions: evidence, location,
-- description. That is as much as we can ask of someone standing in the street
-- and it is all most reports need.
--
-- But institutions need different things. EDSA cannot dispatch to an outage
-- without a meter number; FCC does not care about meter numbers at all. Asking
-- every citizen every institution's questions would make reporting unusable,
-- and asking them at reporting time is worse still: the category is a guess
-- until someone confirms it, so a miscategorised report would collect the
-- wrong answers from a person who has already put their phone away.
--
-- So the extra questions are asked later, by the institution that turns out to
-- own the report, once a human there has acknowledged it.
--
-- The questions live here as JSON rather than in code, so an MDA can change
-- what it asks without a deployment. Nothing in this file involves Meta: these
-- are our definitions, read by our bot.
--
-- Safe to re-run.

-- One questionnaire per MDA per purpose.
CREATE TABLE IF NOT EXISTS bot_flows (
    id SERIAL PRIMARY KEY,
    key VARCHAR(60) NOT NULL UNIQUE,
    name VARCHAR(120) NOT NULL,
    description TEXT,

    -- Whose questionnaire this is, and which reports it applies to.
    group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    category VARCHAR(100),

    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bot_flows_category ON bot_flows (category) WHERE status = 'active';

-- Versions are immutable once published, so a citizen part-way through a
-- questionnaire finishes the one they started even if it is edited underneath
-- them, and so "what were we asking in August" has an answer.
CREATE TABLE IF NOT EXISTS bot_flow_versions (
    id SERIAL PRIMARY KEY,
    flow_id INTEGER NOT NULL REFERENCES bot_flows(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,

    definition JSONB NOT NULL,

    -- draft → pending_review → published, with changes_requested sending it
    -- back. The slice only uses draft and published; the review states are here
    -- because the approval workflow is the next phase and a state column that
    -- has to be widened later is a migration nobody enjoys.
    state VARCHAR(20) NOT NULL DEFAULT 'draft',

    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    submitted_at TIMESTAMP,
    reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP,
    review_note TEXT,
    published_at TIMESTAMP,
    change_note TEXT,

    UNIQUE (flow_id, version_number)
);

-- At most one published version per flow: the question "what is live" must have
-- exactly one answer.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_flow_one_published
    ON bot_flow_versions (flow_id) WHERE state = 'published';

-- One run per citizen per report.
CREATE TABLE IF NOT EXISTS bot_flow_runs (
    id SERIAL PRIMARY KEY,
    flow_version_id INTEGER NOT NULL REFERENCES bot_flow_versions(id) ON DELETE CASCADE,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,

    --   invited     - asked to reply because the 24h window had closed
    --   in_progress - answering
    --   completed   - finished
    --   abandoned   - gave up, or never replied to the invitation
    --   superseded  - the report was recategorised and another MDA now asks
    state VARCHAR(20) NOT NULL DEFAULT 'invited',

    -- What the report was categorised as when the questions were sent. A report
    -- can move afterwards, and answers given in good faith under the previous
    -- category are still evidence -- they are kept and labelled, not discarded.
    category_at_send VARCHAR(100),

    current_step INTEGER NOT NULL DEFAULT 0,
    answers JSONB NOT NULL DEFAULT '{}'::jsonb,

    invited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bot_flow_runs_issue ON bot_flow_runs (issue_id);
CREATE INDEX IF NOT EXISTS idx_bot_flow_runs_user ON bot_flow_runs (user_id);

-- A citizen can only be answering one questionnaire at a time. Without this a
-- second acknowledgement could start a run while the first is still going and
-- the bot would interleave two sets of questions.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_flow_runs_active
    ON bot_flow_runs (user_id) WHERE state IN ('invited', 'in_progress');

-- When the citizen last messaged us. WhatsApp only allows free-form business
-- messages within 24 hours of that moment; after it, the first message must be
-- an approved template. Kept on the user rather than derived from message_logs,
-- which retention trims.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMP;

-- Seed from what is already known, so the window check is right on day one.
UPDATE users u
SET last_inbound_at = sub.last_seen
FROM (
    SELECT phone_number, MAX(created_at) AS last_seen
    FROM message_logs
    WHERE direction = 'incoming'
    GROUP BY phone_number
) sub
WHERE u.phone_number = sub.phone_number AND u.last_inbound_at IS NULL;


-- ── A worked example: EDSA electricity outages ──────────────────────────────
--
-- Seeded so the shape is exercised by real data rather than described in a
-- document. EDSA will edit this once the editor exists.
DO $$
DECLARE
    grp_edsa INTEGER;
    v_flow_id INTEGER;
BEGIN
    SELECT id INTO grp_edsa FROM groups WHERE name = 'EDSA';
    IF grp_edsa IS NULL THEN
        RAISE NOTICE 'EDSA group not found; skipping the example questionnaire.';
        RETURN;
    END IF;

    INSERT INTO bot_flows (key, name, description, group_id, category)
    VALUES ('edsa_outage_details',
            'Electricity outage — follow-up',
            'Details EDSA needs before dispatching a team to a reported outage.',
            grp_edsa,
            'Electricity & Power Supply')
    ON CONFLICT (key) DO NOTHING;

    SELECT id INTO v_flow_id FROM bot_flows WHERE key = 'edsa_outage_details';

    INSERT INTO bot_flow_versions (flow_id, version_number, state, published_at, change_note, definition)
    SELECT v_flow_id, 1, 'published', CURRENT_TIMESTAMP, 'Initial questionnaire', $json$
    {
      "intro": { "en": "EDSA has received your report and needs a few details before sending a team." },
      "outro": { "en": "Thank you — EDSA has everything they need for now." },
      "steps": [
        {
          "key": "meter_number",
          "type": "text",
          "prompt": { "en": "What is your meter number?" },
          "help": { "en": "The 11 digits printed on the front of the meter." },
          "validation": {
            "pattern": "^[0-9]{11}$",
            "error": { "en": "A meter number is 11 digits. Check and send it again, or reply SKIP." }
          },
          "skippable": true
        },
        {
          "key": "whole_street",
          "type": "choice",
          "prompt": { "en": "Is the whole street affected, or only your house?" },
          "options": [
            { "value": "street", "label": { "en": "The whole street" } },
            { "value": "house",  "label": { "en": "Only my house" } },
            { "value": "unsure", "label": { "en": "I am not sure" } }
          ],
          "skippable": true
        },
        {
          "key": "started_when",
          "type": "choice",
          "prompt": { "en": "When did the power go off?" },
          "options": [
            { "value": "today",     "label": { "en": "Today" } },
            { "value": "yesterday", "label": { "en": "Yesterday" } },
            { "value": "longer",    "label": { "en": "More than two days ago" } }
          ],
          "skippable": true
        }
      ]
    }
    $json$::jsonb
    WHERE NOT EXISTS (
        SELECT 1 FROM bot_flow_versions WHERE flow_id = (SELECT id FROM bot_flows WHERE key = 'edsa_outage_details')
    );
END $$;
