const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FixamDatabase = require('./fixamDatabase');
const FixamHelpers = require('./fixamHelpers');
const logger = require('./logger');
const simulator = require('./simulator');
const aiService = require('./aiService');
const adminOtp = require('./adminOtp');
const botFlow = require('./botFlow');
const sanitizer = require('./inputSanitizer');
const smallTalk = require('./smallTalk');
const nameValidator = require('./nameValidator');

// Replies that decline a follow-up questionnaire before it starts.
const STOP_REPLIES = ['stop', 'no', 'no thanks', 'cancel', 'later'];

// Commands that mean "I came here to do something else". An unanswered
// invitation must not swallow these.
const MENU_TRIGGERS = ['hi', 'hello', 'menu', 'start', 'help', 'report',
    '1', '2', '3', '4', '5', '6', '7', '8'];
const { analyzeIssue, analyzeIntent } = aiService; // Keep backward compatibility for existing calls

// Where media the bot receives is written so the static frontend can serve it at
// /uploads/... Resolved from this file rather than process.cwd(), so it lands in
// the same place whether the process was started from backend/, the repo root,
// or simulator/.
const UPLOADS_ROOT = process.env.UPLOADS_DIR
    ? path.resolve(process.env.UPLOADS_DIR)
    : path.resolve(__dirname, '..', '..', 'frontend', 'uploads');

// A report is treated as a possible duplicate when an open issue was filed this
// close, this recently. Overridable per deployment: a dense city may want a
// tighter radius than a rural district.
const DUPLICATE_RADIUS_METERS = Number(process.env.DUPLICATE_RADIUS_METERS) || 100;
const DUPLICATE_WINDOW_DAYS = Number(process.env.DUPLICATE_WINDOW_DAYS) || 7;
// Minimum embedding similarity for two nearby reports to count as duplicates.
// A truck blocking a road and rubbish on the pavement are both "within 100 m"
// but score well below this; two potholes described differently score well
// above.
const DUPLICATE_SIMILARITY_THRESHOLD = Number(process.env.DUPLICATE_SIMILARITY_THRESHOLD) || 0.45;

// Refuse photographs showing a child's face. On by default: this is a
// safeguarding control, so disabling it should be a deliberate act.
const MINOR_DETECTION_ENABLED = process.env.MINOR_DETECTION_ENABLED !== 'false';

// Citizen free text is capped before it reaches the AI or the database. A
// WhatsApp message has no practical length limit, and the classifier, the
// admin timeline and the report view are all built around a few sentences --
// an unbounded description is a novel stored and billed as a report.
const MAX_DESCRIPTION_LENGTH = Number(process.env.MAX_DESCRIPTION_LENGTH) || 1000;
const MAX_ADDRESS_LENGTH = Number(process.env.MAX_ADDRESS_LENGTH) || 200;

// The ceiling every inbound message is cut to before anything -- the logger,
// the state machine, the AI -- sees it. Sits above MAX_DESCRIPTION_LENGTH so
// the description step can still give its own, kinder refusal rather than
// silently receiving a truncated report.
const MAX_MESSAGE_LENGTH = Number(process.env.MAX_MESSAGE_LENGTH) || 4096;

// A name is asked for again rather than accepted, but not forever without help:
// after this many refusals the bot stops rephrasing and spells out the exact
// two words it wants.
const NAME_HELP_AFTER_ATTEMPTS = 3;

/**
 * Steps where the bot is waiting for one specific answer.
 *
 * Small talk arriving at one of these must not be stored as the answer and must
 * not throw the citizen back to the menu -- four questions into a report,
 * "ok" means "I am still here", not "start again". Everything that is not the
 * menu is in here, which is the point: the menu is the only place where
 * changing the subject is free.
 */
const ANSWER_EXPECTED_STEPS = new Set([
    'awaiting_name',
    'awaiting_consent',
    'awaiting_delete_confirmation',
    'awaiting_feedback',
    'awaiting_report_evidence',
    'awaiting_report_location',
    'awaiting_report_description',
    'awaiting_report_confirmation',
    'awaiting_address_selection',
    'awaiting_unresolved_location_choice',
    'awaiting_reused_photo_choice',
    'awaiting_duplicate_action',
    'awaiting_duplicate_selection_for_vote',
    'awaiting_vote_ticket_id',
    'awaiting_vote_confirmation',
    'awaiting_track_ticket_id',
    'awaiting_track_action_selection',
    'awaiting_endorse_confirmation',
    'awaiting_trending_community',
    'awaiting_trending_selection',
]);

// What to say to bring somebody back to the question they were on. Steps with
// nothing listed get the generic line below.
const STEP_REMINDERS = {
    awaiting_delete_confirmation: 'Type *YES* to confirm deletion, or *9* to cancel.',
    awaiting_feedback: 'Please type your feedback, or send a voice note.',
    awaiting_vote_ticket_id: 'Please send the Issue ID (for example *FIX-A1B2C3*), or *9* to cancel.',
    awaiting_track_ticket_id: 'Please send the Issue ID (for example *FIX-A1B2C3*), or *9* to cancel.',
};

/**
 * The reporting flow as an ordered list, so "back" has something to walk.
 *
 * Each entry says which step to return to and what to clear on the way. Data is
 * dropped deliberately: going back to the photo step while keeping the old
 * photo would leave the citizen unable to tell whether their replacement took
 * effect.
 */
const REPORT_STEPS = [
    { step: 'awaiting_report_evidence', clears: ['image_url', 'image_sha256', 'image_mime_type', 'image_forwarded', 'image_reused_from'] },
    { step: 'awaiting_report_location', clears: ['lat', 'lng', 'address', 'district', 'city', 'ward', 'location_source', 'pending_addresses', 'address_attempts'] },
    { step: 'awaiting_report_description', clears: ['description', 'title', 'category', 'urgency'] },
    { step: 'awaiting_report_confirmation', clears: ['potential_duplicates'] },
];

/**
 * Appended to every prompt in the reporting flow that waits for an answer.
 *
 * The way out has to be on the message the citizen is looking at. Documenting
 * "0" and "9" once at the start of the flow does not help somebody four
 * questions in on a phone, and the commands are useless if nobody knows they
 * exist at the moment they need them.
 */
const REPORT_NAV_FOOTER = '\n\n_↩️ *0* go back  •  ❌ *9* cancel_';

// The first step of the report has nothing behind it, so offering "go back"
// there advertises a command that cannot work.
const REPORT_CANCEL_FOOTER = '\n\n_❌ *9* cancel_';

/**
 * Attach the navigation footer, unless it is already there.
 * Pass { back: false } on the first step of the flow.
 */
function withNav(message, { back = true } = {}) {
    if (message.includes('*9* cancel')) return message;
    return `${message}${back ? REPORT_NAV_FOOTER : REPORT_CANCEL_FOOTER}`;
}

// What the bot says when it re-asks a step the citizen stepped back to.
const REPORT_STEP_PROMPTS = {
    awaiting_report_evidence: "📸 Please send a *Photo* or *Video* of the issue, or type *skip* if you don't have one.",
    awaiting_report_location: "📍 Please share the *Location* of the issue.\n\nUse the attachment icon > Location, or type the address.",
    awaiting_report_description: "📝 Please describe the issue (Text or Voice Note).",
};

const BACK_WORDS = ['back', 'previous', 'prev', 'go back', '0'];

// Steps that ask the citizen to choose what to do about a problem with the
// stage they are on. They are branches, not stages: "back" from one means "back
// from the stage that raised it", so they resolve to their owner first.
const BACK_STEP_ALIASES = {
    awaiting_reused_photo_choice: 'awaiting_report_evidence',
    awaiting_unresolved_location_choice: 'awaiting_report_location',
    // Picking between several geocoder matches is still the location stage.
    awaiting_address_selection: 'awaiting_report_location',
    // The duplicate prompts follow the description, so back returns to it.
    awaiting_duplicate_action: 'awaiting_report_confirmation',
    awaiting_duplicate_selection_for_vote: 'awaiting_report_confirmation',
};

class FixamHandler {
    constructor(whatsAppService, db, io, debugLog) {
        this.whatsAppService = whatsAppService;
        this.db = db; // This is the raw pool/client
        this.io = io;
        this.debugLog = debugLog || console.log;

        this.fixamDb = new FixamDatabase(db, this.debugLog);
        this.helpers = new FixamHelpers(this.debugLog);
    }

    /**
     * Pilot mode restricts reporting to the activated community champions.
     *
     * Voting, tracking and feedback stay open to everyone; only a report is
     * refused. Returns false (having already replied) when the citizen is
     * blocked, true when they may continue.
     */
    async pilotReportGate(fromNumber, user) {
        const pilotMode = (await this.fixamDb.getPlatformSetting('pilot_mode')) === 'true';
        // A missing user object is treated as not-a-champion: while pilot mode
        // is on, the only safe answer to "can this number report?" is no.
        if (pilotMode && !(user && user.pilot_activated === true)) {
            await this.sendMessage(fromNumber,
                '🚧 *Pilot Phase*\n\nReporting is currently open only to selected community champions. '
                + 'Public reporting opens after the pilot. Thank you for your interest!');
            return false;
        }
        return true;
    }

    /**
     * Is this report an emergency?
     *
     * A report qualifies when its category is on the emergency list or its
     * description carries an emergency keyword. Both lists are configurable in
     * the admin portal, so what counts as an emergency is a governance decision,
     * not a hardcoded one.
     */
    async isEmergencyReport(category, description) {
        const categoriesRaw = await this.fixamDb.getPlatformSetting('emergency_categories');
        const keywordsRaw = await this.fixamDb.getPlatformSetting('emergency_keywords');

        const categories = (categoriesRaw || '')
            .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        const keywords = (keywordsRaw || '')
            .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

        if (category && categories.includes(String(category).toLowerCase())) return true;

        const lower = (description || '').toLowerCase();
        return keywords.some((k) => lower.includes(k));
    }

    async processIncomingMessage(data) {
        logger.log('webhook', '========== Received webhook ==========');
        logger.logObject('webhook', 'Full webhook data', data);

        // Is this the simulator driving us rather than Meta? Only ever true in
        // development with SIMULATOR_ENABLED=true — see services/simulator.js.
        const isSimulated = simulator.isSimulatedPayload(data);
        if (isSimulated) {
            logger.log('webhook', '🧪 Simulated message (source: WhatsApp simulator)');
        }

        // Security Check: Verify Phone Number ID
        const value = data.entry?.[0]?.changes?.[0]?.value;
        const metadata = value?.metadata;

        if (!isSimulated && process.env.WHATSAPP_PHONE_NUMBER_ID && metadata?.phone_number_id) {
            if (metadata.phone_number_id !== process.env.WHATSAPP_PHONE_NUMBER_ID) {
                logger.log('webhook', `⚠️ Use configured Phone ID: ${process.env.WHATSAPP_PHONE_NUMBER_ID}. Received ID: ${metadata.phone_number_id}. Ignoring.`);
                return;
            }
        }

        if (value?.messages?.[0]) {
            const message = data.entry[0].changes[0].value.messages[0];
            const fromNumber = message.from;

            // Restrict to the configured country's numbers. The dial code comes
            // from services/countries.js, so a deployment for another country
            // changes this without touching the handler.
            const serviceArea = this.helpers.serviceArea;
            if (!fromNumber.startsWith(serviceArea.dialCode)) {
                logger.log('webhook', `Rejected message from unsupported region: ${fromNumber}`);
                await this.sendMessage(fromNumber, `Fixam is not yet supported in your country. Use a ${serviceArea.name} phone number.`);
                return;
            }

            // DEV MODE BLOCK — skipped for the simulator, whose whole purpose is
            // to exercise the citizen flows that this gate closes off.
            if (process.env.DEV_MODE === 'true' && !isSimulated) {
                const roles = await this.fixamDb.getUserRoles(fromNumber);
                if (!roles.includes('Admin')) {
                    logger.log('webhook', `Blocked non-admin user in DEV_MODE: ${fromNumber}`);
                    await this.sendMessage(fromNumber, "🚧 *Maintenance Mode* 🚧\n\nThe application has been closed to public use for now until the final Hackathon event day. Only admins are allowed to access the platform.");
                    return;
                }
            }

            logger.log('webhook', `Message from: ${fromNumber}, Type: ${message.type}`);
            logger.logObject('webhook', 'Message object', message);

            // Clean before anything reads it -- including the log. A message
            // padded with zero-width characters or reversed with a bidi
            // override should not reach the database in that state, and an
            // operator reading the transcript should see what the state machine
            // saw, not something that renders differently.
            const rawBody = message.text?.body || message.type;
            const cleaned = sanitizer.sanitize(rawBody, { maxLength: MAX_MESSAGE_LENGTH });
            if (cleaned.flags.length) {
                logger.log('webhook', `Input sanitised [${cleaned.flags.join(', ')}] from ${logger.pseudonym(fromNumber)}`);
            }
            const messageBody = cleaned.text;

            await this.fixamDb.logMessage({
                conversationId: fromNumber,
                direction: 'incoming',
                messageType: message.type,
                messageBody: messageBody
            });

            // Check if user is disabled
            const user = await this.fixamDb.getUser(fromNumber);
            if (user && user.is_disabled) {
                logger.log('webhook', `Blocked message from disabled user: ${fromNumber}`);
                await this.sendMessage(fromNumber, "🚫 *Access Denied*\n\nYour account has been disabled. Please contact support if you believe this is a mistake.");
                return;
            }

            // Handle different message types
            if (message.type === 'text') {
                logger.log('webhook', 'Handling text message');
                await this.handleTextMessage(fromNumber, messageBody);
            } else if (message.type === 'location') {
                logger.log('webhook', 'Handling location message');
                await this.handleLocationMessage(fromNumber, message.location);
            } else if (message.type === 'image' || message.type === 'video') {
                logger.log('webhook', 'Handling media message (image/video)');
                await this.handleMediaMessage(fromNumber, message);
            } else if (message.type === 'audio' || message.type === 'voice') {
                logger.log('webhook', 'Handling voice message');
                await this.handleVoiceMessage(fromNumber, message);
            } else {
                logger.log('webhook', `Unknown message type: ${message.type}`);
                await this.sendMessage(fromNumber, "Sorry, I don't understand this message type yet.");
            }
        } else {
            logger.log('webhook', 'No message found in webhook data');
        }
        logger.log('webhook', '========== Webhook processing complete ==========');
    }

    async handleTextMessage(fromNumber, text) {
        // Sanitised again here rather than trusted from the caller: this method
        // is re-entered from inside the state machine (a ticket ID pulled out of
        // a sentence, for instance), and it is cheap and idempotent.
        const input = sanitizer.sanitizeText(text, { maxLength: MAX_MESSAGE_LENGTH });
        const lowerInput = input.toLowerCase();

        // Check if user exists
        const user = await this.fixamDb.getUser(fromNumber);

        // Nothing survived cleaning: the message was invisible characters,
        // formatting marks, or empty to begin with. Say so rather than feeding
        // an empty string into whichever step is waiting.
        if (sanitizer.isBlank(input)) {
            await this.sendMessage(fromNumber,
                user
                    ? "I didn't get any text in that message. Please type your reply, or send *Hi* for the menu."
                    : "I didn't get any text in that message. Please type *Hi* to start.");
            return;
        }

        // Every message from a citizen re-opens WhatsApp's 24-hour window.
        // Recorded here, at the one point every inbound message passes through,
        // so nothing has to remember to do it.
        if (user) {
            await this.fixamDb.db.query(
                'UPDATE users SET last_inbound_at = CURRENT_TIMESTAMP WHERE id = $1',
                [user.id]
            ).catch(() => { /* never block a conversation on a timestamp */ });
        }

        // ── Follow-up questionnaire ─────────────────────────────────────────────
        //
        // Sits ahead of the menu because someone part-way through answering an
        // institution's questions is in a conversation, not at a menu. Their
        // "1" means the first option, not "report an issue".
        if (user) {
            const run = await botFlow.activeRunForUser(user.id);

            if (run && run.state === "invited") {
                // The window had closed when the MDA acknowledged, so the
                // citizen was invited rather than asked.
                //
                // Any reply is taken as consent -- insisting on the exact word
                // CONTINUE would strand anyone who typed "ok" or "yes" -- with
                // one exception. Someone who opens the bot to do something else
                // entirely must not be captured by an invitation they had
                // already decided to ignore, so a recognised menu command
                // quietly retires the invitation and carries on to what they
                // actually asked for.
                if (MENU_TRIGGERS.includes(lowerInput)) {
                    await this.fixamDb.db.query(
                        "UPDATE bot_flow_runs SET state = 'abandoned', completed_at = CURRENT_TIMESTAMP WHERE id = $1",
                        [run.id]
                    );
                    // Deliberately falls through to normal handling below.
                } else if (STOP_REPLIES.includes(lowerInput)) {
                    await this.fixamDb.db.query(
                        "UPDATE bot_flow_runs SET state = 'abandoned', completed_at = CURRENT_TIMESTAMP WHERE id = $1",
                        [run.id]
                    );
                    await this.sendMessage(fromNumber,
                        "No problem — your report is still with the team. Type *Hi* for the menu.");
                    return;
                } else {
                    await this.fixamDb.db.query(
                        "UPDATE bot_flow_runs SET state = 'in_progress', started_at = CURRENT_TIMESTAMP WHERE id = $1",
                        [run.id]
                    );
                    run.state = "in_progress";

                    const intro = botFlow.text(run.definition.intro);
                    if (intro) await this.sendMessage(fromNumber, intro);
                    await this.sendMessage(fromNumber, botFlow.promptFor(run));
                    return;
                }
            }

            if (run && run.state === "in_progress") {
                const result = await botFlow.handleAnswer(run, input);
                if (result.reply) await this.sendMessage(fromNumber, result.reply);
                return;
            }
        }

        // ── Administrator sign-in code ──────────────────────────────────────────
        //
        // The administrator asks; the bot answers. Doing it this way keeps the
        // exchange inside WhatsApp's customer service window, so no approved
        // template is needed and nothing depends on Meta's review queue.
        if (['login', 'login code', 'otp', 'sign in', 'signin'].includes(lowerInput)) {
            const result = await adminOtp.issue(fromNumber);

            if (!result.ok && result.reason === 'not_portal_user') {
                // Deliberately not "you are not an administrator": that would
                // confirm which numbers are, to anyone who cares to ask.
                await this.sendMessage(fromNumber,
                    "This number is not set up for portal access.\n\nIf you should have an account, please contact your administrator.");
                return;
            }
            if (!result.ok && result.reason === 'disabled') {
                await this.sendMessage(fromNumber, "This account is disabled. Please contact your administrator.");
                return;
            }
            if (!result.ok && result.reason === 'rate_limited') {
                // Reaching this now means a run of codes was requested and none
                // of them used, which is worth flagging. Ordinary signing in and
                // out does not get here.
                await this.sendMessage(fromNumber,
                    "⏳ Several sign-in codes have been requested for this account and not used.\n\nIf you already have a code, it is still valid — use that one.\n\nIf you did not request these codes, tell your administrator: someone may know your password.");
                return;
            }
            if (!result.ok) {
                await this.sendMessage(fromNumber, "Sorry, the code could not be generated. Please try again shortly.");
                return;
            }

            await this.sendMessage(fromNumber,
                "🔐 *FIXAM sign-in code*\n\n"
                + `*${result.code}*\n\n`
                + `Enter it with your phone number and password to sign in. It expires in ${result.expiresInMinutes} minutes and works once.\n\n`
                + "⚠️ FIXAM will never ask you for this code. If you did not try to sign in, ignore this message and tell your administrator.");
            return;
        }

        // ── DPG: Global data commands (available to all users) ───────────────────
        if (lowerInput === 'my data' || lowerInput === 'mydata') {
            if (!user) {
                await this.sendMessage(fromNumber, "You are not registered yet. Please complete registration first.");
                return;
            }
            const data = await this.fixamDb.getUserData(fromNumber);
            if (!data || !data.profile) {
                await this.sendMessage(fromNumber, "Unable to retrieve your data at this time. Please try again later.");
                return;
            }
            const summary = `📊 *Your Data Summary*\n\n` +
                `👤 *Name:* ${data.profile.name || 'N/A'}\n` +
                `📱 *Phone:* ${data.profile.phone_number}\n` +
                `⭐ *Points:* ${data.profile.points || 0}\n` +
                `📝 *Issues Reported:* ${data.issues_reported.length}\n` +
                `🗳️ *Votes Cast:* ${data.votes_cast.length}\n` +
                `🕒 *Exported:* ${new Date(data.exported_at).toLocaleString()}\n\n` +
                `Type *Hi* to return to the main menu, or *DELETE MY DATA* to erase your account permanently.`;
            await this.sendMessage(fromNumber, summary);
            return;
        }

        if (lowerInput === 'delete my data' || lowerInput === 'deletemydata') {
            if (!user) {
                await this.sendMessage(fromNumber, "You are not registered. No data to delete.");
                return;
            }
            // Ask for explicit confirmation
            await this.fixamDb.updateConversationState(fromNumber, {
                current_step: 'awaiting_delete_confirmation',
                data: {}
            });
            await this.sendMessage(fromNumber, "⚠️ *Delete Account Confirmation*\n\nYou are about to permanently delete your account and ALL associated data. This action cannot be undone.\n\nType *YES* to confirm deletion\n");
            return;
        }

        // Global: step back one stage of the report. Checked before the state
        // machine so it works from any step, and before the greeting/
        // acknowledgement handlers below so those cannot swallow it.
        if (BACK_WORDS.includes(lowerInput) && user) {
            const backState = await this.fixamDb.getConversationState(fromNumber);
            if (backState && await this.goBackOneStep(fromNumber, backState)) {
                return;
            }
        }

        // Global Reset (skip if confirming deletion — let switch handle it)
        if (lowerInput === 'reset' || lowerInput === 'cancel' || input === '9') {
            const currentState = await this.fixamDb.getConversationState(fromNumber);
            if (currentState && currentState.current_step === 'awaiting_delete_confirmation') {
                // Let the switch case handle cancellation of deletion
            } else {
                await this.fixamDb.resetConversationState(fromNumber);
                if (user) {
                    await this.sendMainMenu(fromNumber, user.name);
                } else {
                    await this.sendMessage(fromNumber, "Conversation reset. Type 'Hi' to start again.");
                }
                return;
            }
        }

        // 1. User Registration
        // 2. Global: Check for direct Ticket ID (FIX-XXXXXX)
        //    But only intercept when user is NOT already in a track/vote flow
        //    (the state machine handles those flows with proper context)
        const voteCodeMatch = input.toUpperCase().match(/^FIX-[A-Z0-9]{6}$/);
        if (voteCodeMatch) {
             const ticketId = voteCodeMatch[0];
             const issue = await this.fixamDb.getIssueByTicketId(ticketId);
             if (issue && !user) {
                 // New user — route through consent; store intent for after consent
                 const pendingConsent = await this.fixamDb.getPendingConsent(fromNumber);
                 if (!pendingConsent) {
                     await this.fixamDb.setPendingConsent(fromNumber, null, input);
                     await this.fixamDb.initializeConversationState(fromNumber);
                     await this.fixamDb.updateConversationState(fromNumber, {
                         current_step: 'awaiting_consent',
                         data: { pending_vote_ticket: ticketId }
                     });
                     await this.sendMessage(fromNumber, this.getConsentMessage());
                 }
                 return;
             }
             if (issue && user) {
                 // Check current state — if in a track/vote flow, let the state machine handle it
                 const currentState = await this.fixamDb.getConversationState(fromNumber);
                 if (currentState && (currentState.current_step === 'awaiting_track_ticket_id' ||
                                      currentState.current_step === 'awaiting_vote_ticket_id')) {
                     // Don't intercept — fall through to state machine switch
                 } else {
                     // Catch-all: from main menu, route to vote
                     await this.fixamDb.updateConversationState(fromNumber, { 
                        current_step: 'awaiting_vote_confirmation',
                        data: { issue_id: issue.id, ticket_id: issue.ticket_id, title: issue.title }
                     });
                     await this.sendMessage(fromNumber, `🗳️ *Vote Request Detected*\n\nFound Issue: *${issue.title}* (${issue.ticket_id})\n\nType *1* to Upvote 👍\nType *2* to Downvote 👎\n`);
                     return;
                 }
             }
             // If issue not found, fall through to state machine or other handlers
        }

        if (!user) {
            // ── DPG: Consent-based registration flow ────────────────────────
            const state = await this.fixamDb.getConversationState(fromNumber);
            const pendingConsent = await this.fixamDb.getPendingConsent(fromNumber);

            // Already consented — proceed to name registration
            if (state && state.current_step === 'awaiting_name') {
                const stateData = (state && state.data) || {};
                const parsed = nameValidator.parseName(input, {
                    blacklist: await this.getNameBlacklist(),
                });

                if (!parsed.ok) {
                    // Keep everything already in the state -- a pending vote
                    // ticket must survive however many attempts the name takes.
                    const attempts = (stateData.name_attempts || 0) + 1;
                    await this.fixamDb.updateConversationState(fromNumber, {
                        current_step: 'awaiting_name',
                        data: { ...stateData, name_attempts: attempts },
                    });
                    logger.log('webhook', `Name refused (${parsed.reason}), attempt ${attempts}`);

                    // Repeating the same guidance a fourth time is not help.
                    const spellItOut = attempts >= NAME_HELP_AFTER_ATTEMPTS
                        ? '\n\nSend just the two words and nothing else, like this:\n*Aminata Kamara*'
                        : '';
                    await this.sendMessage(fromNumber, parsed.message + spellItOut);
                    return;
                }

                await this.fixamDb.registerUser(fromNumber, parsed.fullName, {
                    firstName: parsed.firstName,
                    lastName: parsed.lastName,
                });

                const pendingTicket = stateData.pending_vote_ticket;
                if (pendingTicket) {
                    const issue = await this.fixamDb.getIssueByTicketId(pendingTicket);
                    if (issue) {
                        await this.fixamDb.updateConversationState(fromNumber, {
                            current_step: 'awaiting_vote_confirmation',
                            data: { issue_id: issue.id, ticket_id: issue.ticket_id, title: issue.title }
                        });
                        await this.sendMessage(fromNumber, `Thanks ${parsed.firstName}! ✅\n\nNow back to your vote:\n\n🗳️ *${issue.title}*\nType *1* to Upvote 👍\nType *2* to Downvote 👎\n`);
                        return;
                    }
                }

                await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_category', data: {} });
                await this.sendMainMenu(fromNumber, parsed.firstName);
                return;
            }

            // No pending consent yet — first contact, request consent
            if (!pendingConsent) {
                await this.fixamDb.setPendingConsent(fromNumber, null, input);
                await this.fixamDb.initializeConversationState(fromNumber);
                await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_consent' });
                await this.sendMessage(fromNumber, this.getConsentMessage());
                return;
            }

            // Pending consent exists — process response
            if (lowerInput === 'yes') {
                await this.fixamDb.clearPendingConsent(fromNumber);
                await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_name' });
                await this.sendMessage(fromNumber, "Thank you for agreeing! 🙏\n\nWhat is your name?");
                return;
            } else if (lowerInput === 'no') {
                await this.fixamDb.clearPendingConsent(fromNumber);
                await this.fixamDb.resetConversationState(fromNumber);
                await this.sendMessage(fromNumber, "We understand. Your data has not been stored. You can change your mind anytime — just say \"Hi\" to start over. 👋");
                return;
            }

            // Still waiting for consent decision
            await this.sendMessage(fromNumber, "Please reply *YES* to agree to our privacy policy and continue, or *NO* to decline.");
            return;
        }



        // 3. Get State
        let state = await this.fixamDb.getConversationState(fromNumber);
        if (!state) {
            await this.fixamDb.initializeConversationState(fromNumber);
            state = await this.fixamDb.getConversationState(fromNumber);
        }

        // --- SMALL TALK -------------------------------------------------------
        //
        // Whole-message matching only. The version this replaces asked whether
        // the input *contained* "thanks", which meant a citizen describing "the
        // road by Thanksgiving Ground is washed away" had their description
        // discarded and replaced with "You're very welcome!".
        //
        // "Yes" and "no" are not small talk and never reach here -- they are
        // answers, and the state machine below owns them.
        const chat = smallTalk.classify(input);
        if (chat) {
            // Mid-flow, small talk is company, not an instruction. Acknowledge
            // it and put the citizen back on the question they were answering,
            // with their progress intact.
            if (ANSWER_EXPECTED_STEPS.has(state.current_step)) {
                const reminder = STEP_REMINDERS[state.current_step]
                    || REPORT_STEP_PROMPTS[state.current_step]
                    || 'Please answer the question above, or type *9* to cancel.';
                await this.sendMessage(fromNumber, `${smallTalk.replyFor(chat.type)}\n\n${reminder}`);
                return;
            }

            if (chat.type === 'greeting') {
                await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_category', data: {} });
                await this.sendMainMenu(fromNumber, this.firstNameOf(user));
                return;
            }

            // "Bye" ends the conversation. Following it with the full menu
            // would be the bot refusing to take the hint.
            if (chat.type === 'farewell') {
                await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_category', data: {} });
                await this.sendMessage(fromNumber, smallTalk.replyFor('farewell'));
                return;
            }

            await this.sendMessage(fromNumber, smallTalk.replyFor(chat.type));
            if (smallTalk.showsMenu(chat.type)) {
                await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_category', data: {} });
                await this.sendMainMenu(fromNumber, this.firstNameOf(user));
            }
            return;
        }
        // --- END SMALL TALK ---------------------------------------------------

        // 3. State Machine
        switch (state.current_step) {
            case 'awaiting_category':
                // 1. Try AI Intent Analysis First
                let analysis = null;
                // People open with a greeting and then say what they want:
                // "hello, there is a burst pipe at Congo Cross". The greeting
                // carries no intent and drags the classifier towards small talk,
                // so the request is analysed without it. A message that is only
                // a greeting never reaches here -- it was answered above.
                const intentInput = smallTalk.stripGreetingPrefix(input) || input;
                // Only use AI if input is long enough to be a sentence, otherwise it might just be a menu number or keyword
                if (intentInput.length > 2) {
                    try {
                        analysis = await analyzeIntent(intentInput);
                    } catch (e) {
                         logger.logError('ai_debug', 'Intent analysis failed', e);
                    }
                }

                if (analysis && analysis.entities && analysis.entities.ticket_id && 
                    (!analysis.intent || analysis.intent === 'unknown' || analysis.intent === 'vote_issue')) {
                    // Special case: If a ticket ID is found but intent is weak, 
                    // and there are NO vote keywords, default to tracking/viewing.
                    const voteKeywords = ['upvote', 'downvote', 'support', 'reject', 'vote'];
                    const hasVoteKeyword = voteKeywords.some(kw => lowerInput.includes(kw));
                    
                    if (!hasVoteKeyword) {
                        logger.log('ai_debug', `Ticket ID detected without vote keywords, defaulting to track_status`);
                        analysis.intent = 'track_status';
                    }
                }

                if (analysis && analysis.intent && analysis.intent !== 'unknown') {
                        logger.log('ai_debug', `Detected intent: ${analysis.intent}`);
                        
                        if (analysis.intent === 'report_issue') {
                            // Check rate limit
                            const dailyCount = await this.fixamDb.getDailyIssueCount(user.id);
                            if (dailyCount >= 20) {
                                await this.sendMessage(fromNumber, "🚫 Daily Limit Reached\n\nYou have reported 20 issues today. To prevent spam, we have a daily limit. Please try again tomorrow.");
                                return;
                            }
                            
                            if (!(await this.pilotReportGate(fromNumber, user))) return;
                            
                            const newData = {};
                            const entities = analysis.entities || {};
                            if (entities.description) newData.description = entities.description;
                            if (entities.location) {
                                // Try to geocode
                                try {
                                    const locs = (await this.helpers.geocodeAddress(entities.location)).results;
                                    if (locs.length > 0) {
                                        newData.lat = locs[0].latitude;
                                        newData.lng = locs[0].longitude;
                                        newData.address = locs[0].display_name;
                                        newData.location_source = 'geocoded';
                                        this.applyAdminAreas(newData, locs[0].admin);
                                    } else {
                                        newData.address = entities.location;
                                    }
                                } catch(e) { newData.address = entities.location; }
                            }

                            await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_report_evidence', data: newData });
                            
                            let msg = "Great! Let's report an issue.";
                            if(newData.description) msg += `\n\n📝 I noted the description: "${newData.description}"`;
                            if(newData.address) msg += `\n📍 I noted the location: "${newData.address}"`;
                            msg += "\n\nPlease send a *Photo* or *Video* of the issue as evidence.";

                            // First stage of the report: nothing to go back to.
                            await this.sendMessage(fromNumber, withNav(msg, { back: false }));
                            return;

                        } else if (analysis.intent === 'vote_issue') {
                             logger.log('ai_debug', `Vote intent detected. Ticket: ${analysis.entities?.ticket_id}, VoteType: ${analysis.entities?.vote_type}`);
                             const entities = analysis.entities || {};
                             const ticketId = entities.ticket_id ? entities.ticket_id.toUpperCase() : null;
                             const voteType = entities.vote_type ? entities.vote_type.toLowerCase() : null;

                             if (ticketId) {
                                 // Verify ticket
                                 const issue = await this.fixamDb.getIssueByTicketId(ticketId);
                                 if (issue) {
                                     // Check if they want to upvote directly
                                     if (voteType && (voteType.includes('up') || voteType.includes('down'))) {
                                         // If intent is strong and clear (e.g. "Upvote FIX-123"), maybe just do it?
                                         // For safety, let's confirm.
                                         await this.fixamDb.updateConversationState(fromNumber, { 
                                            current_step: 'awaiting_vote_confirmation',
                                            data: { issue_id: issue.id, ticket_id: issue.ticket_id, title: issue.title, pre_vote: voteType }
                                         });
                                         await this.sendMessage(fromNumber, `Found Issue: *${issue.title}* (${issue.ticket_id})\n\nI see you want to *${voteType}*.\n\nType *1* to Confirm Upvote 👍\nType *2* to Confirm Downvote 👎\n`);
                                     } else {
                                         // If it's just a ticket ID in a vote context but NO clear vote intent keywords,
                                         // maybe redirect to tracking instead? 
                                         // Actually, let's keep it consistent: if they were in a vote flow, keep it.
                                         // But if this was an AI detection, the earlier block already handled the redirection.
                                         await this.fixamDb.updateConversationState(fromNumber, { 
                                            current_step: 'awaiting_vote_confirmation',
                                            data: { issue_id: issue.id, ticket_id: issue.ticket_id, title: issue.title }
                                         });
                                         await this.sendMessage(fromNumber, `Found Issue: *${issue.title}* (${issue.ticket_id})\n\nType *1* to Upvote 👍\nType *2* to Downvote 👎\n`);
                                     }
                                 } else {
                                     await this.sendMessage(fromNumber, `Could not find issue with ID: ${ticketId}. Please check and try again.`);
                                     await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_vote_ticket_id', data: {} });
                                 }
                             } else {
                                await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_vote_ticket_id', data: {} });
                                await this.sendMessage(fromNumber, "Okay! Please enter the *Issue ID* of the issue you want to vote on.");
                             }
                             return;

                        } else if (analysis.intent === 'view_trending') {
                             const entities = analysis.entities || {};
                             const community = entities.location;

                             if (community) {
                                 // Trigger trending logic directly
                                 const locations = (await this.helpers.geocodeAddress(community)).results;
                                 if (locations.length > 0) {
                                      const loc = locations[0];
                                      // Increased radius from 1km to 3km for better results in communities
                                      const trendingIssues = await this.fixamDb.getTrendingIssues(loc.latitude, loc.longitude, 3000, 5);
                                    
                                         const isGlobal = trendingIssues[0]?.is_global;
                                         let msg = isGlobal 
                                            ? `🔥 *Global Trending in Sierra Leone*\n(Nothing found recently in ${loc.name || 'this area'})\n\n`
                                            : `🔥 *Trending in ${loc.name || loc.display_name}*\n\n`;

                                         trendingIssues.forEach((issue, i) => {
                                            msg += `${i+1}. *${issue.title}*\n`;
                                            msg += `   📍 ${issue.address || 'Location N/A'}\n`;
                                            msg += `   👍 ${issue.upvote_count} Upvotes\n\n`;
                                         });
                                         msg += `Reply with the number (e.g. *1*) to view details and vote.`;

                                         await this.fixamDb.updateConversationState(fromNumber, { 
                                            current_step: 'awaiting_trending_selection',
                                            data: { trending_issues: trendingIssues }
                                        });
                                        await this.sendMessage(fromNumber, msg);
                                 } else {
                                    await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_trending_community', data: {} });
                                    await this.sendMessage(fromNumber, `I couldn't find "${community}". Please enter the name of the community again (e.g. 'Lumley').`);
                                 }
                             } else {
                                await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_trending_community', data: {} });
                                await this.sendMessage(fromNumber, "Please enter the name of the community or area you want to check (e.g. 'Lumley', 'Kissy').");
                             }
                             return;

                        } else if (analysis.intent === 'view_points') {
                             const points = user.points || 0;
                             await this.sendMessage(fromNumber, `🏆 *Your Citizen Score*\n\nYou currently have: *${points} Points* ⭐\n\n*How to earn points:*\n+10 pts: Report an Issue\n+50 pts: Issue Resolved\n+5 pts: Endorsing Resolution ✅\n+1 pt: Getting Upvoted\n\nKeep participating to unlock future rewards! 🎁`);
                             await this.sendMainMenu(fromNumber, user.name);
                             return;

                        } else if (analysis.intent === 'track_status') {
                             const entities = analysis.entities || {};
                             const ticketId = (entities.ticket_id || '').toUpperCase();

                             if (ticketId) {
                                 // If ticket ID is provided in the sentence, jump straight to tracking
                                 // I need to replicate the tracker logic here or move it to a helper
                                 // But for now, let's just push to the state
                                 await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_track_ticket_id', data: {} });
                                 return await this.handleTextMessage(fromNumber, ticketId);
                             } else {
                                await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_track_ticket_id', data: {} });
                                await this.sendMessage(fromNumber, "🔍 *Track/Endorse Issue*\n\nPlease enter the *Issue ID* you want to follow up on.");
                             }
                             return;

                        } else if (analysis.intent === 'provide_feedback') {
                             const entities = analysis.entities || {};
                             const feedback = entities.feedback_text;

                             if (feedback) {
                                 await this.saveFeedback(user.id, 'text', feedback);
                                 await this.sendMessage(fromNumber, "Thank you for your feedback! 🙏\n\nI've saved it.");
                                 await this.sendMainMenu(fromNumber, user.name);
                             } else {
                                await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_feedback', data: {} });
                                await this.sendMessage(fromNumber, "We value your feedback! 💬\n\nPlease type your feedback or send a *Voice Note*.");
                             }
                             return;

                        } else if (analysis.intent === 'get_help') {
                            const helpMsg = `ℹ️ *Fixam Help Guide*\n\n` +
                                            `*1. Report*: Tell us about problems like potholes or water leaks.\n` +
                                            `*2. Vote*: Support issues reported by others.\n` +
                                            `*3. Track/Endorse*: Check status of an issue or confirm if it's fixed!\n` +
                                            `*4. Trending*: Find popular issues in your area to support.\n` +
                                            `*5. Points*: Earn points for being an active citizen!\n` +
                                            `*6. Feedback*: Share your thoughts with us.\n\n` +
                                            `*Useful Commands:*\n` +
                                            `- Type *9* to Cancel any action.\n` +
                                            `- Type *Reset* to start over.\n\n` +
                                            `For more support, contact: ${process.env.FIXAM_CONTACT_EMAIL || 'fixam@maxcit.com'}`;
                            await this.sendMessage(fromNumber, helpMsg);
                            await this.sendMainMenu(fromNumber, user.name);
                            return;

                        } else if (analysis.intent === 'greeting') {
                            await this.sendMainMenu(fromNumber, user.name);
                            return;

                        } else if (analysis.intent === 'appreciation') {
                            await this.sendMessage(fromNumber, "You're very welcome! Happy to help. 😊");
                            await this.sendMainMenu(fromNumber, user.name);
                            return;

                        } else if (analysis.intent === 'agreement') {
                            await this.sendMessage(fromNumber, "Great! Let me know if you need anything else.");
                            await this.sendMainMenu(fromNumber, user.name);
                            return;
                        }
                }

                // 2. Fallback to Menu logic if AI didn't catch it
                if (input === '1' || lowerInput.includes('report')) {
                    // Check rate limit
                    const dailyCount = await this.fixamDb.getDailyIssueCount(user.id);
                    if (dailyCount >= 20) {
                        await this.sendMessage(fromNumber, "🚫 Daily Limit Reached\n\nYou have reported 20 issues today. To prevent spam, we have a daily limit. Please try again tomorrow.\n\nThank you for helping improve our community! 🌟");
                        return;
                    }

                    if (!(await this.pilotReportGate(fromNumber, user))) return;

                    await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_report_evidence', data: {} });
                    await this.sendMessage(fromNumber, withNav("Great! Let's report an issue.\n\nPlease send a *Photo* or *Video* of the issue as evidence.", { back: false }));
                } else if (input === '2' || lowerInput.includes('vote')) {
                    await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_vote_ticket_id', data: {} });
                    await this.sendMessage(fromNumber, "Okay! Please enter the *Issue ID* of the issue you want to vote on.");
                } else if (input === '3' || lowerInput.includes('track') || lowerInput.includes('endorse') || lowerInput.includes('status')) {
                    await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_track_ticket_id', data: {} });
                    await this.sendMessage(fromNumber, "🔍 *Track/Endorse Issue*\n\nPlease enter the *Issue ID* you want to follow up on.");
                } else if (input === '4' || lowerInput.includes('trending')) {
                    await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_trending_community', data: {} });
                    await this.sendMessage(fromNumber, "Please enter the name of the community or area you want to check (e.g. 'Lumley', 'Kissy').");
                } else if (input === '5' || lowerInput.includes('point')) {
                    const points = user.points || 0;
                    await this.sendMessage(fromNumber, `🏆 *Your Citizen Score*\n\nYou currently have: *${points} Points* ⭐\n\n*How to earn points:*\n+10 pts: Report an Issue\n+50 pts: Issue Resolved\n+5 pts: Endorsing Resolution\n+1 pt: Getting Upvoted\n\nKeep participating to unlock future rewards! 🎁\n\nType *Hi* to return to the main menu.`);
                } else if (input === '6' || lowerInput.includes('feedback')) {
                    await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_feedback', data: {} });
                    await this.sendMessage(fromNumber, "We value your feedback! 💬\n\nPlease type your feedback or send a *Voice Note*.");
                } else if (input === '7' || lowerInput.includes('help')) {
                    const helpMsg = `ℹ️ *Fixam Help Guide*\n\n` +
                                    `*1. Report*: Tell us about problems like potholes or water leaks.\n` +
                                    `*2. Vote*: Support issues reported by others.\n` +
                                    `*3. Track/Endorse*: Check status of an issue or confirm if it's fixed!\n` +
                                    `*4. Trending*: Find popular issues in your area to support.\n` +
                                    `*5. Points*: Earn points for being an active citizen!\n` +
                                    `*6. Feedback*: Share your thoughts with us.\n\n` +
                                    `*Useful Commands:*\n` +
                                    `- Type *MY DATA* to see your data summary.\n` +
                                    `- Type *DELETE MY DATA* to erase your account.\n` +
                                    `- Type *9* to Cancel any action.\n` +
                                    `- Type *Reset* to start over.\n\n` +
                                    `For more support, contact: ${process.env.FIXAM_CONTACT_EMAIL || 'fixam@maxcit.com'}\n\n` +
                                    `Type *Hi* to return to the main menu.`;
                    await this.sendMessage(fromNumber, helpMsg);
                } else if (input === '8' || lowerInput.includes('my data') || lowerInput.includes('mydata')) {
                    const data = await this.fixamDb.getUserData(fromNumber);
                    if (!data || !data.profile) {
                        await this.sendMessage(fromNumber, "Unable to retrieve your data at this time. Please try again later.");
                    } else {
                        const summary = `📊 *Your Data Summary*\n\n` +
                            `👤 *Name:* ${data.profile.name || 'N/A'}\n` +
                            `📱 *Phone:* ${data.profile.phone_number}\n` +
                            `⭐ *Points:* ${data.profile.points || 0}\n` +
                            `📝 *Issues Reported:* ${data.issues_reported.length}\n` +
                            `🗳️ *Votes Cast:* ${data.votes_cast.length}\n` +
                            `🕒 *Exported:* ${new Date(data.exported_at).toLocaleString()}\n\n` +
                            `Type *Hi* to return to the main menu, or *DELETE MY DATA* to erase your account permanently.`;
                        await this.sendMessage(fromNumber, summary);
                    }
                } else {
                    await this.sendMessage(fromNumber, "I'm not sure what you mean. Please select an option from the menu (1-8) or try describing what you want to do.");
                    await this.sendMainMenu(fromNumber, user.name);
                }
                break;

            case 'awaiting_feedback':
                // Text Feedback
                await this.saveFeedback(user.id, 'text', input.substring(0, MAX_DESCRIPTION_LENGTH));
                await this.sendMessage(fromNumber, "Thank you for your feedback! 🙏\n\nWe appreciate you helping us improve Fixam.");
                await this.sendMainMenu(fromNumber, user.name);
                break;

            // ── DPG: Delete confirmation ──────────────────────────────────
            case 'awaiting_delete_confirmation':
                if (lowerInput === 'yes') {
                    const deleted = await this.fixamDb.deleteUser(fromNumber);
                    if (deleted) {
                        await this.fixamDb.resetConversationState(fromNumber);
                        await this.sendMessage(fromNumber, "✅ Your account and all associated data have been permanently deleted.\n\nThank you for using Fixam. If you ever want to return, just say \"Hi\". 👋");
                    } else {
                        await this.sendMessage(fromNumber, "❌ Sorry, we couldn't delete your account. Please try again later or contact " + (process.env.FIXAM_CONTACT_EMAIL || 'privacy@fixam.sl') + ".");
                    }
                } else {
                    await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_category' });
                    await this.sendMessage(fromNumber, "Account deletion cancelled. Your data is safe. ✅");
                    await this.sendMainMenu(fromNumber, user.name);
                }
                break;

            case 'awaiting_report_evidence':
                if (lowerInput === 'skip') {
                     await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_report_location' });
                     await this.sendMessage(fromNumber, withNav("Okay, skipping evidence.\n\nNow, please share the *Location* of the issue.\n\n📍 Use the attachment icon > Location\n✏️ Or type the address (e.g., '5 Jabbiela Drive')\n\n"));
                } else {
                    await this.sendMessage(fromNumber, withNav("Please send a *Photo* or *Video* (not text) to continue, or type 'skip' if you don't have one.", { back: false }));
                }
                break;

            case 'awaiting_unresolved_location_choice': {
                const unresolvedData = state.data || {};
                const typedAddress = unresolvedData.unresolved_address || '';

                if (input === '1' || lowerInput === 'keep') {
                    // Filed with the citizen's own wording and no coordinates.
                    // The report is worth more than the pin: an admin can place
                    // it from the description and photo.
                    unresolvedData.address = typedAddress;
                    unresolvedData.lat = null;
                    unresolvedData.lng = null;
                    unresolvedData.location_source = 'unresolved';
                    delete unresolvedData.unresolved_address;
                    delete unresolvedData.address_attempts;

                    await this.fixamDb.updateConversationState(fromNumber, {
                        current_step: 'awaiting_report_description',
                        data: unresolvedData
                    });
                    await this.sendMessage(fromNumber, withNav(
                        `✅ Noted: *${typedAddress}*\n\n_An admin will pinpoint this on the map._\n\n`
                        + `Please describe the issue (Text or Voice Note).`));
                } else if (input === '2' || lowerInput === 'retry' || lowerInput === 'again') {
                    delete unresolvedData.unresolved_address;
                    await this.fixamDb.updateConversationState(fromNumber, {
                        current_step: 'awaiting_report_location',
                        data: unresolvedData
                    });
                    await this.sendMessage(fromNumber,
                        "📍 Please share the location again.\n\n"
                        + "Use the attachment icon > Location for an exact position, or type the address "
                        + "with a nearby landmark or town (e.g. \"Wilkinson Road, Freetown\").");
                } else if (input === '3') {
                    delete unresolvedData.unresolved_address;
                    await this.goBackOneStep(fromNumber, {
                        current_step: state.current_step,
                        data: unresolvedData
                    });
                } else {
                    await this.sendMessage(fromNumber,
                        "Please reply *1* to keep it as written, *2* to try the location again, *3* to go back.");
                }
                break;
            }

            case 'awaiting_reused_photo_choice': {
                const reusedData = state.data || {};

                if (input === '1' || lowerInput === 'use') {
                    await this.fixamDb.updateConversationState(fromNumber, {
                        current_step: 'awaiting_report_location',
                        data: reusedData
                    });
                    await this.sendMessage(fromNumber,
                        reusedData.address
                            ? `Keeping that photo. 📸\n\nI previously noted the location: *${reusedData.address}*.\n\nType *Yes* to confirm, or share a new location.`
                            : "Keeping that photo. 📸\n\nNow, please share the *Location* of the issue.\n\n📍 Use the attachment icon > Location\n✏️ Or type the address");
                } else if (input === '2' || lowerInput === 'new' || lowerInput === 'different') {
                    // Drop the flagged photo so there is no doubt about which one
                    // ends up on the report.
                    for (const key of ['image_url', 'image_sha256', 'image_mime_type', 'image_forwarded', 'image_reused_from']) {
                        delete reusedData[key];
                    }
                    await this.fixamDb.updateConversationState(fromNumber, {
                        current_step: 'awaiting_report_evidence',
                        data: reusedData
                    });
                    await this.sendMessage(fromNumber,
                        "👍 No problem. Please send the *Photo* or *Video* you meant to use, or type *skip* to continue without one.");
                } else if (input === '3' || lowerInput === 'view') {
                    // Hand over to the existing tracking flow, which already
                    // shows status and offers voting or a follow-up.
                    const ticket = reusedData.image_reused_from
                        ? (await this.fixamDb.getIssueById(reusedData.image_reused_from))?.ticket_id
                        : null;

                    if (!ticket) {
                        await this.sendMessage(fromNumber, "Sorry, I couldn't open that report. Type *1* to use your photo anyway, or *2* to send a different one.");
                        break;
                    }

                    // Set the step in one write. Resetting first cleared the row,
                    // so the ticket arrived with no state and the global
                    // FIX-xxxxxx handler grabbed it into the voting flow instead
                    // of showing the report's status.
                    await this.fixamDb.updateConversationState(fromNumber, {
                        current_step: 'awaiting_track_ticket_id',
                        data: {}
                    });
                    await this.sendMessage(fromNumber, `Opening *${ticket}* — your draft report has been discarded.`);
                    return await this.handleTextMessage(fromNumber, ticket);
                } else {
                    await this.sendMessage(fromNumber,
                        "Please reply *1* to use the photo anyway, *2* to send a different one, *3* to view the earlier report.");
                }
                break;
            }

            case 'awaiting_report_location': {
                if (input.toLowerCase() === 'yes' && state.data && state.data.address) {
                    await this.fixamDb.updateConversationState(fromNumber, { 
                        current_step: 'awaiting_report_description',
                        data: state.data
                    });
                    
                    let msg = `Location confirmed: ${state.data.address}\n\nPlease describe the issue (Text or Voice Note)`;
                    if (state.data.description) {
                        msg += `\n(💡 I noted: "${state.data.description}". Type *Use* to keep this description)`;
                    } else {
                        msg += `.`;
                    }
                    await this.sendMessage(fromNumber, withNav(msg));
                    break;
                }

                // Handle text address
                const currentData = state.data || {};

                // Escape hatch offered after repeated failed lookups: file the
                // report with the citizen's own wording and no coordinates.
                const keepMatch = input.match(/^keep\s+(.{3,})$/i);
                if (keepMatch) {
                    // An address is short; cap what is stored so a paste of a
                    // long document cannot become the report's location text.
                    currentData.address = sanitizer.sanitizeIdentifier(keepMatch[1], MAX_ADDRESS_LENGTH).text;
                    currentData.lat = null;
                    currentData.lng = null;
                    currentData.location_source = 'unresolved';
                    delete currentData.address_attempts;

                    await this.fixamDb.updateConversationState(fromNumber, {
                        current_step: 'awaiting_report_description',
                        data: currentData
                    });
                    await this.sendMessage(fromNumber,
                        `✅ Noted: *${currentData.address}*\n\n`
                        + `_An admin will pinpoint this on the map._\n\n`
                        + `Please describe the issue (Text or Voice Note).`
                        + REPORT_NAV_FOOTER);
                    break;
                }

                const lookup = await this.helpers.geocodeAddress(input);
                const locations = lookup.results;

                if (!lookup.ok) {
                    // The geocoder is unreachable. Repeating "I couldn't find
                    // that address" would be a lie and would trap the citizen in
                    // a loop, so keep what they typed and let the report through
                    // for admins to place manually.
                    currentData.address = sanitizer.sanitizeIdentifier(input, MAX_ADDRESS_LENGTH).text;
                    currentData.lat = null;
                    currentData.lng = null;
                    currentData.location_source = 'unresolved';

                    await this.fixamDb.updateConversationState(fromNumber, {
                        current_step: 'awaiting_report_description',
                        data: currentData
                    });
                    await this.sendMessage(fromNumber,
                        `⚠️ I can't verify addresses at the moment, so I've noted your location as:\n*${currentData.address}*\n\n`
                        + `An admin will confirm it. If you can, share your GPS location later for an exact position.\n\n`
                        + `Please describe the issue (Text or Voice Note).`
                        + REPORT_NAV_FOOTER);
                    break;
                }

                if (locations.length === 0) {
                    const attempts = (currentData.address_attempts || 0) + 1;
                    currentData.address_attempts = attempts;
                    await this.fixamDb.updateConversationState(fromNumber, { data: currentData });

                    // Offered as a choice from the first failure. The citizen
                    // knows where they are far better than the geocoder does, so
                    // making them fail repeatedly before mentioning they can file
                    // it as written just loses reports.
                    const typed = input.trim();
                    currentData.unresolved_address = typed;

                    await this.fixamDb.updateConversationState(fromNumber, {
                        current_step: 'awaiting_unresolved_location_choice',
                        data: currentData
                    });

                    const preamble = attempts >= 3
                        ? `I still can't find "${typed}" on the map. Many places in ${this.helpers.serviceArea.name} aren't mapped, so this may well be one of them.`
                        : `I couldn't find "${typed}" on the map.`;

                    await this.sendMessage(fromNumber,
                        `📍 *Location not found*\n\n${preamble}\n\n`
                        + `What would you like to do?\n\n`
                        + `1️⃣ *Keep it as written* — an admin will place it on the map\n`
                        + `2️⃣ *Try again* — type it differently, or share your GPS location\n`
                        + `3️⃣ *Go back* — change your photo`
                        + REPORT_NAV_FOOTER);
                } else if (locations.length === 1) {
                    const loc = locations[0];
                    currentData.lat = loc.latitude;
                    currentData.lng = loc.longitude;
                    currentData.address = loc.display_name;
                    currentData.location_source = 'geocoded';
                    this.applyAdminAreas(currentData, loc.admin);
                    delete currentData.address_attempts;

                    await this.fixamDb.updateConversationState(fromNumber, {
                        current_step: 'awaiting_report_description',
                        data: currentData
                    });
                    await this.sendMessage(fromNumber, withNav(`📍 Location found: ${loc.display_name}\n\nPlease describe the issue (Text or Voice Note).`));
                } else {
                    // Several matches: the citizen has to disambiguate, so show
                    // the district rather than three near-identical strings.
                    currentData.pending_addresses = locations;
                    delete currentData.address_attempts;

                    await this.fixamDb.updateConversationState(fromNumber, {
                        current_step: 'awaiting_address_selection',
                        data: currentData
                    });

                    let msg = `I found ${locations.length} places matching "${input.trim()}". Which one? Reply with the number:\n\n`;
                    locations.forEach((loc, i) => {
                        const context = [loc.admin.ward, loc.admin.city, loc.admin.district]
                            .filter(Boolean).join(', ');
                        msg += `${i + 1}. *${context || loc.display_name}*\n   ${loc.display_name}\n\n`;
                    });
                    msg += `Or share your GPS location for an exact position.` + REPORT_NAV_FOOTER;
                    await this.sendMessage(fromNumber, msg);
                }
                break;
            }

            case 'awaiting_address_selection':
                const selection = parseInt(input);
                const pendingAddresses = state.data.pending_addresses;
                
                if (selection >= 1 && selection <= pendingAddresses.length) {
                    const loc = pendingAddresses[selection - 1];
                    const currentData = state.data;
                    currentData.lat = loc.latitude;
                    currentData.lng = loc.longitude;
                    currentData.address = loc.display_name;
                    currentData.location_source = 'geocoded';
                    this.applyAdminAreas(currentData, loc.admin);
                    delete currentData.pending_addresses; // Clean up

                    await this.fixamDb.updateConversationState(fromNumber, { 
                        current_step: 'awaiting_report_description',
                        data: currentData
                    });
                    await this.sendMessage(fromNumber, withNav(`Location confirmed: ${loc.display_name}\n\nPlease describe the issue (Text or Voice Note).`));
                } else {
                    await this.sendMessage(fromNumber, `Please reply with a valid number (1-${pendingAddresses.length}).`);
                }
                break;

            case 'awaiting_report_description':
                const currentData = state.data || {};

                // Reject rather than truncate: silently cutting a citizen's
                // description could drop the one detail that identifies the
                // problem, and asking them to shorten it is what they would
                // expect from a clerk.
                if (input.length > MAX_DESCRIPTION_LENGTH) {
                    await this.sendMessage(fromNumber,
                        `⚠️ That description is very long (${input.length} characters). `
                        + `Please describe the issue in a few short sentences and send again.`);
                    break;
                }

                // The previous question was the location. A description that
                // merely repeats it -- the same wording, or a part of it --
                // tells nobody what is actually wrong, so ask for the "what".
                // Only the direction that adds nothing is refused: "flooding at
                // <full address>" still answers the question.
                if (input.toLowerCase() !== 'use') {
                    const locationText = (currentData.address || '').trim().toLowerCase().replace(/\s+/g, ' ');
                    const descriptionText = input.trim().toLowerCase().replace(/\s+/g, ' ');
                    if (locationText && descriptionText
                        && (locationText === descriptionText || locationText.includes(descriptionText))) {
                        await this.sendMessage(fromNumber,
                            `⚠️ That looks like the location, not the problem. Please describe what is wrong there `
                            + `(for example, "the road is flooded and water is entering houses").`);
                        break;
                    }
                }

                let descriptionToUse = input;
                if (input.toLowerCase() === 'use' && currentData.description) {
                     descriptionToUse = currentData.description;
                } else {
                     currentData.description = input;
                     descriptionToUse = input;
                }
                
                // Analyze with AI
                await this.sendMessage(fromNumber, "Analyzing your report");
                let category = 'Uncategorized';
                let title = descriptionToUse.substring(0, 30) + (descriptionToUse.length > 30 ? '...' : '');
                let urgency = 'medium';
                
                try {
                    const analysis = await analyzeIssue(descriptionToUse);
                    logger.logObject('ai_debug', 'AI Analysis Result (Handler)', analysis);
                    if (analysis) {
                        category = analysis.category || 'Uncategorized';
                        title = analysis.summary || title;
                        urgency = analysis.urgency || 'medium';
                    }
                } catch (err) {
                    logger.logError('ai_debug', 'Error analyzing issue (Handler)', err);
                }
                
                currentData.category = category;
                currentData.title = title;
                currentData.urgency = urgency;

                await this.promptDuplicatesOrConfirm(fromNumber, currentData);
                break;

            case 'awaiting_duplicate_action':
                if (input === '1') {
                    // View details
                    const dups = state.data.potential_duplicates;
                    let msg = `📝 *Issue Details:*\n\n`;
                    dups.forEach(dup => {
                        msg += `🎫 *Issue ID:* ${dup.ticket_id}\n`;
                        msg += `📋 *Title:* ${dup.title}\n`;
                        msg += `📝 *Desc:* ${dup.description || 'No description'}\n`;
                        msg += `-------------------\n`;
                    });
                    msg += `\n1️⃣ Report as *NEW* issue\n2️⃣ *Vote* on an existing issue\n9️⃣ Cancel`;
                    await this.sendMessage(fromNumber, msg);
                } else if (input === '2') {
                    // Report anyway
                    await this.fixamDb.updateConversationState(fromNumber, { 
                        current_step: 'awaiting_report_confirmation'
                    });
                    await this.sendReportSummary(fromNumber, state.data);
                } else if (input === '3') {
                    // Vote
                    const dups = state.data.potential_duplicates;
                    let msg = `Which issue would you like to support? Reply with the number (e.g. 1):\n\n`;
                    dups.forEach((dup, i) => {
                        msg += `${i + 1}. *${dup.title}* (${dup.ticket_id})\n`;
                    });
                    msg += `\n9. Cancel`;
                    await this.fixamDb.updateConversationState(fromNumber, { 
                        current_step: 'awaiting_duplicate_selection_for_vote'
                    });
                    await this.sendMessage(fromNumber, msg);
                } else if (input === '9') {
                    await this.sendMessage(fromNumber, "Cancelled. Type 'Hi' for main menu.");
                    await this.fixamDb.resetConversationState(fromNumber);
                } else {
                    await this.sendMessage(fromNumber, "Please choose 1, 2, 3 or 9.");
                }
                break;

            case 'awaiting_duplicate_selection_for_vote':
                const sel = parseInt(input);
                const potentialDups = state.data.potential_duplicates;
                if (sel >= 1 && sel <= potentialDups.length) {
                    const selectedIssue = potentialDups[sel - 1];
                    await this.fixamDb.updateConversationState(fromNumber, { 
                        current_step: 'awaiting_vote_confirmation',
                        data: { ...state.data, issue_id: selectedIssue.id, ticket_id: selectedIssue.ticket_id, title: selectedIssue.title }
                    });
                    await this.sendMessage(fromNumber, `Found Issue: *${selectedIssue.title}* (${selectedIssue.ticket_id})\n\nType *1* to Upvote 👍\nType *2* to Downvote 👎\n`);
                } else if (input === '9') {
                    await this.sendMessage(fromNumber, "Cancelled. Type 'Hi' for main menu.");
                    await this.fixamDb.resetConversationState(fromNumber);
                } else {
                    await this.sendMessage(fromNumber, `Please enter a number between 1 and ${potentialDups.length}.`);
                }
                break;

            case 'awaiting_report_confirmation':
                if (input === '1') {
                    await this.finalizeReport(fromNumber, state.data, user.id);
                } else if (input === '9') {
                    // This block is technically unreachable due to global handler, but keeping for clarity/safety
                    await this.sendMessage(fromNumber, "Report cancelled. Type 'Hi' to start over.");
                    await this.fixamDb.resetConversationState(fromNumber);
                } else {
                    await this.sendMessage(fromNumber, "Please type the number *1* to confirm or *9* to cancel.");
                }
                break;

            case 'awaiting_vote_ticket_id':
                const issueVote = await this.fixamDb.getIssueByTicketId(input.toUpperCase());
                if (issueVote) {
                    await this.fixamDb.updateConversationState(fromNumber, { 
                        current_step: 'awaiting_vote_confirmation',
                        data: { issue_id: issueVote.id, ticket_id: issueVote.ticket_id, title: issueVote.title }
                    });
                    await this.sendMessage(fromNumber, `Found Issue: *${issueVote.title}* (${issueVote.ticket_id})\n\nType *1* to Upvote 👍\nType *2* to Downvote 👎\n`);
                } else {
                    await this.sendMessage(fromNumber, "Issue not found. Please check the Issue ID and try again.");
                }
                break;

            case 'awaiting_track_ticket_id':
                const trackIssue = await this.fixamDb.getIssueByTicketId(input.toUpperCase());
                if (trackIssue) {
                    const endorsements = await this.fixamDb.getEndorsementCount(trackIssue.id);
                    const statusEmoji = {
                        'reported': '📥 Received',
                        'acknowledged': '🟡 Acknowledged',
                        // The column stores 'progress'. 'in_progress' was
                        // listed here and never matched, so a report being
                        // worked on displayed the raw word instead.
                        'progress': '🔵 In Progress',
                        'fixed': '✅ Fixed/Resolved'
                    }[trackIssue.status] || trackIssue.status;

                    // A closed report shows as closed. Without this, a citizen
                    // tracking something the MDA has finished with is told it is
                    // "Critical" -- the status it happened to hold when the
                    // decision was taken.
                    const lifecycle = trackIssue.closed_at
                        ? (trackIssue.closure_reason === 'resolved'
                            ? '✅ Fixed/Resolved'
                            : '📁 Closed without a repair')
                        : statusEmoji;

                    let msg = `🔍 *Issue Status Report*\n\n` +
                                `*ID:* ${trackIssue.ticket_id}\n` +
                                `*Title:* ${trackIssue.title}\n` +
                                `*Status:* ${lifecycle}\n` +
                                `*Category:* ${trackIssue.category}\n` +
                                `*Location:* ${trackIssue.address || 'Sierra Leone'}\n\n` +
                                `*Description:* ${trackIssue.description || 'No description provided.'}\n\n` +
                                `*Endorsements:* ${endorsements} 👍\n\n`;

                    if (trackIssue.closed_at && trackIssue.closure_reason !== 'resolved'
                        && trackIssue.closure_note) {
                        // Closed without a repair. There is nothing to endorse
                        // or dispute, but the citizen is owed the reason.
                        msg += `📝 *Why it was closed:*\n${trackIssue.closure_note}\n\n`
                             + `If the problem is still there, please send a new report and we will look again.`;
                        await this.sendMessage(fromNumber, msg);
                        await this.sendMainMenu(fromNumber, user.name);
                    } else if (trackIssue.status === 'fixed') {
                        const hasEndorsed = await this.fixamDb.checkUserEndorsement(trackIssue.id, user.id);
                        if (hasEndorsed) {
                            msg += `✨ You have already endorsed this resolution. Thank you!`;
                            await this.sendMessage(fromNumber, msg);
                            await this.sendMainMenu(fromNumber, user.name);
                        } else {
                            msg += `Government has marked this as *FIXED*. Do you agree? \n\nType *1* to Endorse/Confirm Resolution ✅\nType *2* if it is *NOT* actually fixed ❌\nType *9* to return to menu.`;
                            await this.fixamDb.updateConversationState(fromNumber, { 
                                current_step: 'awaiting_endorse_confirmation',
                                data: { issue_id: trackIssue.id, ticket_id: trackIssue.ticket_id }
                            });
                            await this.sendMessage(fromNumber, msg);
                        }
                    } else {
                        msg += `Would you like to take further action?\n\nType *1* to Vote on this issue 🗳️\nType *2* to Follow Up / Alert Admins 🔔\nType *9* for Menu.`;
                        await this.fixamDb.updateConversationState(fromNumber, { 
                            current_step: 'awaiting_track_action_selection',
                            data: { issue_id: trackIssue.id, ticket_id: trackIssue.ticket_id, title: trackIssue.title }
                        });
                        await this.sendMessage(fromNumber, msg);
                    }
                } else {
                    await this.sendMessage(fromNumber, "Issue not found. Please check the Issue ID and try again.");
                }
                break;

            case 'awaiting_track_action_selection':
                if (input === '1') {
                    await this.fixamDb.updateConversationState(fromNumber, { 
                        current_step: 'awaiting_vote_confirmation',
                        data: state.data
                    });
                    await this.sendMessage(fromNumber, `🗳️ *Voting for: ${state.data.title}*\n\nType *1* to Upvote 👍\nType *2* to Downvote 👎\n`);
                } else if (input === '2') {
                    // Follow up: log the follow-up in the tracker and alert admins
                    try {
                        // One follow-up per person per issue per day. Each one
                        // messages every member of every MDA mapped to the
                        // category, so without a limit a single citizen tapping
                        // "2" repeatedly can flood an institution's phones --
                        // and officers would learn to ignore the alerts.
                        const recentFollowUp = await this.fixamDb.db.query(
                            `SELECT 1 FROM issue_tracker
                             WHERE issue_id = $1 AND performed_by = $2 AND action = 'citizen_followup'
                               AND created_at > NOW() - INTERVAL '24 hours'
                             LIMIT 1`,
                            [state.data.issue_id, user.id]
                        );

                        if (recentFollowUp.rows.length > 0) {
                            await this.sendMessage(fromNumber,
                                `⏳ *Already Following Up*\n\nYou followed up on this issue in the last 24 hours and the team has been notified.\n\nYou can follow up again tomorrow if there is still no update.`);
                            await this.sendMainMenu(fromNumber, user.name);
                            break;
                        }

                        await this.fixamDb.db.query(
                            `INSERT INTO issue_tracker (issue_id, action, description, performed_by) VALUES ($1, 'citizen_followup', 'Citizen requested an update on this issue', $2)`,
                            [state.data.issue_id, user.id]
                        );
                        await this.sendMessage(fromNumber, `🔔 *Follow-up Alert Sent*\n\nWe've notified the responsible team that you are following up on this issue. They will review and provide an update soon.\n\nThank you for staying engaged, citizen! 🫡`);
                        
                        // Alert relevant groups
                        const trackIssue = await this.fixamDb.getIssueById(state.data.issue_id);
                        if (trackIssue) {
                            await this.notifyResponsibleTeam(trackIssue,
                                `🔔 *Citizen Follow-up*\n\nA citizen is requesting an update on:\n\n*${trackIssue.title}* (${trackIssue.ticket_id})\n*Status:* ${trackIssue.status}\n\nPlease review and provide an update.`);
                        }
                    } catch (e) {
                        logger.logError('handler', 'Error logging follow-up', e);
                        await this.sendMessage(fromNumber, "Sorry, we couldn't process your follow-up request. Please try again later.");
                    }
                    await this.sendMainMenu(fromNumber, user.name);
                } else {
                    await this.sendMainMenu(fromNumber, user.name);
                }
                break;

            case 'awaiting_endorse_confirmation':
                if (input === '1') {
                    const success = await this.fixamDb.endorseIssue(state.data.issue_id, user.id);
                    if (success) {
                        await this.sendMessage(fromNumber, "Thank you! Your endorsement has been recorded. +5 Citizen Points awarded! 🏆");
                    } else {
                        await this.sendMessage(fromNumber, "You have already endorsed this issue or an error occurred.");
                    }
                    await this.sendMainMenu(fromNumber, user.name);
                } else if (input === '2') {
                    // The citizen says it is not actually fixed.
                    //
                    // This does not reopen the report by itself. Whether the
                    // work is done is the MDA's call and one dissenting voice
                    // is not proof -- but it must reach them, and it must be on
                    // the record, otherwise "resolved" only ever means "an
                    // institution said so".
                    await this.fixamDb.db.query(
                        `INSERT INTO issue_tracker (issue_id, action, description, performed_by)
                         VALUES ($1, 'resolution_disputed', 'Citizen reports the issue is not actually resolved', $2)`,
                        [state.data.issue_id, user.id]
                    );

                    // Counted on the report itself so the portal can show it.
                    // An alert can be missed and an audit log is not something
                    // anyone reads unprompted.
                    await this.fixamDb.db.query(
                        'UPDATE issues SET dispute_count = dispute_count + 1 WHERE id = $1',
                        [state.data.issue_id]
                    );

                    const disputed = await this.fixamDb.getIssueById(state.data.issue_id);
                    if (disputed) {
                        await this.notifyResponsibleTeam(disputed,
                            `⚠️ *Resolution Disputed*\n\nA citizen says this report is not actually fixed:\n\n`
                            + `*${disputed.title}* (${disputed.ticket_id})\n\n`
                            + `Please re-check and either reopen it or explain the resolution.`);
                    }

                    await this.sendMessage(fromNumber,
                        `❌ *Thank you for telling us*\n\nWe have recorded that this issue is not resolved and notified the responsible team. They will re-check it.\n\nYour report stays on the public map with your response attached.`);
                    await this.sendMainMenu(fromNumber, user.name);
                } else {
                    await this.sendMainMenu(fromNumber, user.name);
                }
                break;

            case 'awaiting_vote_confirmation':
                const voteData = state.data || {};
                
                // Check if already voted
                const existingVote = await this.fixamDb.checkUserVote(voteData.issue_id, user.id);
                if (existingVote) {
                    await this.sendMessage(fromNumber, `⚠️ You have already voted (${existingVote.vote_type}) on this issue.`);
                    await this.sendMainMenu(fromNumber, user.name);
                    return;
                }

                if (input === '1') {
                    await this.fixamDb.voteIssue(voteData.issue_id, user.id, 'upvote');
                    await this.sendMessage(fromNumber, "Vote recorded! 👍");
                    await this.sendMainMenu(fromNumber, user.name);
                } else if (input === '2') {
                    if (!voteData.downvote_confirmed) {
                         voteData.downvote_confirmed = true;
                         await this.fixamDb.updateConversationState(fromNumber, { 
                            current_step: 'awaiting_vote_confirmation',
                            data: voteData
                        });
                        await this.sendMessage(fromNumber, "⚠️ *Confirm Downvote*\n\nYour downvote will penalize the reporter (-2 Points). Please use this ONLY for:\n\n❌ Spam/Fake Reports\n❌ Abusive Content\n\nAbuse of downvoting may result in penalties to YOUR account.\n\nType *2* again to confirm.");
                        return;
                    }

                    await this.fixamDb.voteIssue(voteData.issue_id, user.id, 'downvote');
                    await this.sendMessage(fromNumber, "Vote recorded! 👎");
                    await this.sendMainMenu(fromNumber, user.name);
                } else if (input === '9') {
                     await this.sendMessage(fromNumber, "Voting cancelled.");
                     await this.sendMainMenu(fromNumber, user.name);
                } else {
                    await this.sendMessage(fromNumber, "Please type the number 1 for Upvote, 2 for Downvote.");
                }
                break;
            
            case 'awaiting_trending_community': {
                const communityLookup = await this.helpers.geocodeAddress(input);
                const locations = communityLookup.results;
                if (!communityLookup.ok) {
                    await this.sendMessage(fromNumber, "⚠️ I can't look up places right now. Please try again in a moment.");
                } else if (locations.length === 0) {
                    await this.sendMessage(fromNumber, "I couldn't find a community with that name. Please try again (e.g. 'Freetown', 'Bo').");
                } else {
                    // Use first match
                    // Increased search radius from 1km to 5km to be more inclusive of community issues
                    const loc = locations[0];
                    const trendingIssues = await this.fixamDb.getTrendingIssues(loc.latitude, loc.longitude, 5000, 5);

                    const isGlobal = trendingIssues[0]?.is_global;
                    let msg = isGlobal 
                        ? `🔥 *Global Trending in Sierra Leone*\n(Nothing found recently in ${loc.name || 'this area'})\n\n`
                        : `🔥 *Trending in ${loc.name || loc.display_name}*\n\n`;

                    trendingIssues.forEach((issue, i) => {
                       msg += `${i+1}. *${issue.title}*\n`;
                       msg += `   📍 ${issue.address || 'Location N/A'}\n`;
                       msg += `   👍 ${issue.upvote_count} Upvotes\n\n`;
                    });
                         msg += `Reply with the number (e.g. *1*) to view details and vote, type another community name to switch location.`;

                         await this.fixamDb.updateConversationState(fromNumber, { 
                            current_step: 'awaiting_trending_selection',
                            data: { trending_issues: trendingIssues }
                        });
                    await this.sendMessage(fromNumber, msg);
                }
            }
            break;

        case 'awaiting_trending_selection':
                const tSelection = parseInt(input);
                const tIssues = state.data.trending_issues;
                
                if (!isNaN(tSelection) && tSelection >= 1 && tSelection <= tIssues.length) {
                    const tIssue = tIssues[tSelection - 1];
                    const link = this.getIssueUrl(tIssue.ticket_id);
                    
                    const msg = `📌 *Issue Details*\n\n` +
                                `*Title:* ${tIssue.title}\n` +
                                `*Location:* ${tIssue.address || 'N/A'}\n` +
                                `*Upvotes:* ${tIssue.upvote_count} 👍\n` +
                                `*ID:* ${tIssue.ticket_id}\n` +
                                `*Link:* ${link}\n\n` +
                                `Type *1* to Upvote 👍\n` +
                                `Type *2* to Downvote 👎\n` +
                                `Type *9* to Cancel`;

                     await this.fixamDb.updateConversationState(fromNumber, { 
                        current_step: 'awaiting_vote_confirmation',
                        data: { issue_id: tIssue.id, ticket_id: tIssue.ticket_id, title: tIssue.title }
                    });
                    await this.sendMessage(fromNumber, msg);
                } else if (input === '9') {
                     await this.sendMessage(fromNumber, "Cancelled.");
                     await this.sendMainMenu(fromNumber, user.name);
                } else {
                    // Treat as a new location search
                    const locations = (await this.helpers.geocodeAddress(input)).results;
                    if (locations.length === 0) {
                        await this.sendMessage(fromNumber, `I couldn't find "${input}". Please enter a valid number (1-${tIssues.length}), a valid community name, or 9 to cancel.`);
                    } else {
                        const loc = locations[0];
                        const newTrending = await this.fixamDb.getTrendingIssues(loc.latitude, loc.longitude, 1000, 5); // 1km

                        if (newTrending.length === 0) {
                             await this.sendMessage(fromNumber, `No trending issues found in *${loc.display_name}* (1km radius).\n\nType another location.`);
                             // Keep waiting for location or number (though number invalid now technically, but logic allows infinite loop of location searching)
                             // To be clean, we basically just stay in this state but with empty list? 
                             // Better: Just update the list to empty so next input must be location.
                             await this.fixamDb.updateConversationState(fromNumber, { 
                                data: { trending_issues: [] } 
                             });
                        } else {
                             let msg = `🔥 *Trending in ${loc.name || loc.display_name}*\n\n`;
                             newTrending.forEach((issue, i) => {
                                msg += `${i+1}. *${issue.title}*\n`;
                                msg += `   📍 ${issue.address || 'Location N/A'}\n`;
                                msg += `   👍 ${issue.upvote_count} Upvotes\n\n`;
                             });
                             msg += `Reply with the number (e.g. *1*) to view details and vote, type another community name to switch location.`;

                             await this.fixamDb.updateConversationState(fromNumber, { 
                                current_step: 'awaiting_trending_selection',
                                data: { trending_issues: newTrending }
                            });
                            await this.sendMessage(fromNumber, msg);
                        }
                    }
                }
                break;

            default:
                await this.sendMainMenu(fromNumber, user.name);
        }
    }

    async handleLocationMessage(fromNumber, location) {
        const state = await this.fixamDb.getConversationState(fromNumber);
        // Also accepted while the citizen is deciding what to do about an
        // address we could not resolve -- that prompt invites a GPS pin.
        const acceptsLocation = ['awaiting_report_location', 'awaiting_unresolved_location_choice'];
        if (!state || !acceptsLocation.includes(state.current_step)) {
            await this.sendMessage(fromNumber, "I'm not expecting a location right now.");
            return;
        }

        const area = this.helpers.serviceArea;
        const point = this.helpers.parseCoordinates(location?.latitude, location?.longitude);

        // A pin from outside the served area is a mis-tap, a spoofed client or a
        // test. Storing it would put a marker on the map nobody can action and
        // skew every distance calculation around it.
        if (!point) {
            logger.log('webhook', `Rejected out-of-area pin from ${fromNumber}: ${location?.latitude}, ${location?.longitude}`);
            await this.sendMessage(fromNumber,
                `📍 That location appears to be outside ${area.name}, so I can't attach it to a report.\n\n`
                + `Please share a location within ${area.name}, or type the address instead (e.g. "Wilkinson Road, Freetown").\n\n`
                + ``);
            return;
        }

        const lookup = await this.helpers.reverseGeocode(point.latitude, point.longitude);
        const currentData = state.data || {};
        currentData.lat = point.latitude;
        currentData.lng = point.longitude;
        // A pin is the most precise thing we get, whether or not it has a name.
        currentData.location_source = 'gps';

        let confirmation;
        if (lookup.result) {
            currentData.address = lookup.result.display_name;
            this.applyAdminAreas(currentData, lookup.result.admin);
            confirmation = `📍 Location received: ${currentData.address}`;
        } else {
            // Either the point is genuinely unnamed in OSM (common outside
            // Freetown) or the geocoder is unreachable. The coordinates are
            // still good, so the report proceeds either way -- losing a valid
            // pin because a third-party service is down would be the worse bug.
            currentData.address = `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`;
            confirmation = lookup.ok
                ? `📍 Location received: ${currentData.address}\n_(No street name is mapped here, so admins will see the coordinates.)_`
                : `📍 Location received: ${currentData.address}\n_(Address lookup is unavailable right now; your exact position is still recorded.)_`;
        }

        await this.fixamDb.updateConversationState(fromNumber, {
            current_step: 'awaiting_report_description',
            data: currentData
        });
        await this.sendMessage(fromNumber, withNav(`${confirmation}\n\nPlease describe the issue (Text or Voice Note).`));
    }

    /**
     * Step back one stage in the reporting flow.
     *
     * Returns true when it handled the message. Answers that depended on the
     * step being returned to are cleared, so the citizen is genuinely redoing it
     * rather than editing around a stale value.
     */
    async goBackOneStep(fromNumber, state) {
        const step = BACK_STEP_ALIASES[state.current_step] || state.current_step;
        const index = REPORT_STEPS.findIndex((s) => s.step === step);

        if (index < 0) return false;   // not in the reporting flow

        if (index === 0) {
            await this.sendMessage(fromNumber,
                "You're at the first step of the report. Type *9* to cancel, or send your photo to continue.");
            return true;
        }

        const target = REPORT_STEPS[index - 1];
        const data = { ...(state.data || {}) };

        // Clear this step's answer and everything after it, so stepping back two
        // steps cannot leave a later answer stranded.
        for (const s of REPORT_STEPS.slice(index - 1)) {
            for (const key of s.clears) delete data[key];
        }

        await this.fixamDb.updateConversationState(fromNumber, {
            current_step: target.step,
            data
        });

        const prompt = REPORT_STEP_PROMPTS[target.step] || 'Please continue.';
        // Landing on the first stage means there is nothing further back, so the
        // footer drops that option rather than advertising a dead end.
        await this.sendMessage(fromNumber,
            withNav(`↩️ *Going back.*\n\n${prompt}`, { back: index - 1 > 0 }));
        return true;
    }

    /** Copy resolved administrative areas onto the in-progress report. */
    applyAdminAreas(currentData, admin) {
        if (!admin) return;
        currentData.district = admin.district || null;
        currentData.city = admin.city || null;
        currentData.ward = admin.ward || null;
    }

    async handleMediaMessage(fromNumber, message) {
        logger.log('media_handler', `========== handleMediaMessage called for ${fromNumber} ==========`);
        const state = await this.fixamDb.getConversationState(fromNumber);
        logger.log('media_handler', `User state: ${state?.current_step || 'null'}`);
        
        if (state && state.current_step === 'awaiting_report_evidence') {
            const mediaId = message.image ? message.image.id : message.video.id;
            const mediaType = message.image ? 'image' : 'video';
            
            logger.log('media_handler', `Media ID: ${mediaId}, Type: ${mediaType}`);
            logger.logObject('media_handler', 'Full message object', message);
            
            // Download Media
            logger.log('media_handler', 'Calling downloadMedia...');
            const downloadResult = await this.whatsAppService.downloadMedia(mediaId);
            logger.log('media_handler', `Download result: ${downloadResult ? 'Success' : 'Failed'}`);

            if (downloadResult && mediaType === 'image') {
                logger.log('media_handler', 'Checking for sensitive content...');
                const classification = await aiService.classifyImage(
                    downloadResult.buffer, 
                    downloadResult.mimeType || 'image/jpeg'
                );

                if (classification && classification.status === 'nude') {
                    logger.log('media_handler', 'Image rejected: Nudity detected');
                    await this.sendMessage(fromNumber, "⚠️ This image contains sensitive content and has been rejected.");
                    return;
                }

                if (!classification) {
                    // The check could not run. "We don't know" was being treated
                    // as "it's safe", so every unsafe image sent during an AI
                    // outage was published to a public map. Not knowing is not
                    // the same as being safe -- the same rule the child
                    // safeguarding check below already follows.
                    logger.log('media_handler', 'Safety check unavailable; refusing image');
                    await this.sendMessage(fromNumber,
                        "⚠️ We can't check this image right now. Please try sending it again in a moment, or type *skip* to continue without a photo.");
                    return;
                }

                logger.log('media_handler', 'Image passed safety check');

                // Child-safeguarding: refuse photographs showing a child's face.
                // Runs before the file is written to disk, so a flagged image is
                // never stored -- the whole point of the check.
                if (MINOR_DETECTION_ENABLED) {
                    const minorCheck = await aiService.detectMinor(
                        downloadResult.buffer,
                        downloadResult.mimeType || 'image/jpeg'
                    );

                    if (minorCheck && minorCheck.is_minor) {
                        logger.log('media_handler',
                            `Image rejected: child detected (${minorCheck.faces_found} face(s))`);
                        await this.sendMessage(fromNumber,
                            "⚠️ *Image not accepted*\n\n"
                            + "This photo appears to show a child. To protect children's privacy we cannot store it.\n\n"
                            + "Please send a photo of the issue itself, without people in the frame.");
                        return;
                    }

                    if (!minorCheck) {
                        // The check could not run. Not knowing is not the same as
                        // being safe, so refuse rather than store an unchecked
                        // image of a possible child.
                        logger.log('media_handler', 'Minor detection unavailable; refusing image');
                        await this.sendMessage(fromNumber,
                            "⚠️ We can't verify this image right now. Please try sending it again in a moment, or type *skip* to continue without a photo.");
                        return;
                    }
                }

            } else if (downloadResult && mediaType === 'video') {
                // Check duration
                logger.log('media_handler', 'Checking video duration...');
                const duration = await aiService.checkDuration(
                    downloadResult.buffer, 
                    'video.mp4', 
                    downloadResult.mimeType || 'video/mp4'
                );
                
                if (duration > 60) {
                    logger.log('media_handler', `Video rejected: Duration ${duration}s > 60s`);
                    await this.sendMessage(fromNumber, "⚠️ Video too long! Please send a video shorter than 1 minute.");
                    return;
                }
            }
            
            // Provenance, recorded for admins rather than acted on automatically.
            // Whether an image is adequate evidence is a human judgement; these
            // give a reviewer the facts behind it.
            // The sender's declared type is a claim and is sometimes absent
            // entirely; the file's own signature is the better authority. A
            // video that arrived with no MIME type was stored as `.bin`, which
            // nginx serves as application/octet-stream -- so the browser
            // downloaded it instead of playing it.
            const sniffed = downloadResult
                ? this.helpers.sniffMediaType(downloadResult.buffer)
                : null;
            const resolvedMime = sniffed || downloadResult?.mimeType || null;

            if (sniffed && downloadResult?.mimeType && sniffed !== downloadResult.mimeType) {
                logger.log('media_handler',
                    `Declared ${downloadResult.mimeType} but the file is ${sniffed}; trusting the file.`);
            }

            if (downloadResult && mediaType === 'image') {
                const currentData = state.data || {};
                currentData.image_sha256 = crypto
                    .createHash('sha256')
                    .update(downloadResult.buffer)
                    .digest('hex');
                currentData.image_mime_type = resolvedMime;

                // WhatsApp marks forwarded messages, which means the reporter did
                // not take this photo now. Absent on channels that do not report
                // it (and in the simulator), so undefined is stored as NULL --
                // "not reported" is not the same as "not forwarded".
                const forwarded = message.context?.forwarded;
                const frequentlyForwarded = message.context?.frequently_forwarded;
                if (forwarded !== undefined || frequentlyForwarded !== undefined) {
                    currentData.image_forwarded = Boolean(forwarded || frequentlyForwarded);
                }

                // Has this exact photo been submitted before? An exact answer,
                // unlike anything a content model could offer.
                const priorUse = await this.fixamDb.findIssueByImageHash(currentData.image_sha256);
                if (priorUse) {
                    currentData.image_reused_from = priorUse.id;
                    logger.log('media_handler',
                        `Image already used on ${priorUse.ticket_id} (issue ${priorUse.id})`);

                    // Held for a decision rather than announced in passing. Most
                    // reuse is honest -- re-reporting the same problem, or
                    // picking the wrong photo from the gallery -- and both are
                    // resolved by stopping to ask, not by carrying on. Recorded
                    // here and acted on once the evidence is safely stored.
                    currentData.reused_prompt = {
                        ticket_id: priorUse.ticket_id,
                        title: priorUse.title,
                    };
                }

                state.data = currentData;
            } else if (downloadResult && mediaType === 'video') {
                // A video only ever recorded its URL, so the portal had nothing
                // to tell it apart from a photograph except the file extension
                // -- which is exactly what was wrong in the first place.
                const currentData = state.data || {};
                currentData.image_mime_type = resolvedMime;
                state.data = currentData;
            }

            let mediaUrl = '';

            if (downloadResult) {
                const extension = this.helpers.extensionForMime(
                    resolvedMime,
                    mediaType === 'video' ? 'mp4' : 'jpg'
                );
                const filename = `${crypto.randomUUID()}.${extension}`;
                const folder = mediaType === 'image' ? 'images' : 'videos';
                
                // Use frontend/uploads for web accessibility
                const uploadsDir = path.join(UPLOADS_ROOT, 'issues', folder);
                const filePath = path.join(uploadsDir, filename);
                
                // Ensure directory exists
                if (!fs.existsSync(uploadsDir)) {
                    fs.mkdirSync(uploadsDir, { recursive: true });
                }
                
                try {
                    fs.writeFileSync(filePath, downloadResult.buffer);
                    mediaUrl = `/uploads/issues/${folder}/${filename}`;
                    logger.log('media_handler', `File saved successfully: ${mediaUrl}`);
                } catch (writeError) {
                    logger.logError('media_handler', 'Failed to write file', writeError);
                    await this.sendMessage(fromNumber, "⚠️ Failed to save the media. Please try again.");
                    return;
                }
            } else {
                logger.log('media_handler', 'Download failed, notifying user');
                await this.sendMessage(fromNumber, "⚠️ Failed to download the media. Please try sending it again.");
                return;
            }

            const currentData = state.data || {};
            currentData.image_url = mediaUrl;

            // This photo has been used on an earlier report. Stop and let the
            // citizen decide, rather than moving them on to the next question:
            // if they picked the wrong file, this is the moment to fix it, and
            // if the problem is already reported they may want that one instead
            // of filing a second.
            if (currentData.reused_prompt) {
                const prior = currentData.reused_prompt;
                delete currentData.reused_prompt;

                await this.fixamDb.updateConversationState(fromNumber, {
                    current_step: 'awaiting_reused_photo_choice',
                    data: currentData
                });

                await this.sendMessage(fromNumber,
                    `📸 *This photo has been used before*\n\n`
                    + `It was submitted with:\n*${prior.title}* (${prior.ticket_id})\n\n`
                    + `What would you like to do?\n\n`
                    + `1️⃣ *Use this photo anyway* and carry on\n`
                    + `2️⃣ *Send a different photo* — just send it now\n`
                    + `3️⃣ *View that report instead* — check its status or support it`
                    + REPORT_NAV_FOOTER);
                return;
            }

            await this.fixamDb.updateConversationState(fromNumber, {
                current_step: 'awaiting_report_location',
                data: currentData
            });
            logger.log('media_handler', 'Updated state to awaiting_report_location');

            if (currentData.address) {
                await this.sendMessage(fromNumber, `Evidence received! 📸\n\nI previously noted the location: *${currentData.address}*.\n\nIs this correct?\nType *Yes* to confirm, or share a new location/type address.`);
            } else {
                await this.sendMessage(fromNumber, withNav("Evidence received! 📸\n\nNow, please share the *Location* of the issue.\n\n📍 Use the attachment icon > Location\n✏️ Or type the address"));
            }
        } else {
            logger.log('media_handler', `User not in correct state. Current: ${state?.current_step || 'null'}, Expected: awaiting_report_evidence`);
            await this.sendMessage(fromNumber, "I'm not expecting media right now.");
        }
        logger.log('media_handler', '========== handleMediaMessage complete ==========');
    }

    async handleVoiceMessage(fromNumber, message) {
        const state = await this.fixamDb.getConversationState(fromNumber);
        if (state && state.current_step === 'awaiting_report_description') {
            const mediaId = message.voice ? message.voice.id : message.audio.id;
            
            // Download Voice Note
            const downloadResult = await this.whatsAppService.downloadMedia(mediaId);
            let mediaUrl = '';
            let transcribedText = '';
            let transcriptionConfidence = null;

            if (downloadResult) {
            // Check duration first
            const duration = await aiService.checkDuration(
                downloadResult.buffer, 
                'audio.ogg', 
                downloadResult.mimeType || 'audio/ogg'
            );
            
            if (duration > 300) {
                await this.sendMessage(fromNumber, "⚠️ Voice note too long! Please keep it under 5 minutes.");
                return; // Stop processing, do not save
            }

            const extension = this.helpers.extensionForMime(downloadResult.mimeType, 'ogg');
            const filename = `${crypto.randomUUID()}.${extension}`;

            // Use frontend/uploads for web accessibility
            const uploadsDir = path.join(UPLOADS_ROOT, 'issues', 'audio');
            const filePath = path.join(uploadsDir, filename);
            
            // Ensure directory exists
            if (!fs.existsSync(uploadsDir)) {
                fs.mkdirSync(uploadsDir, { recursive: true });
            }
            
            fs.writeFileSync(filePath, downloadResult.buffer);
            mediaUrl = `/uploads/issues/audio/${filename}`;

            // Transcribe the voice note
            await this.sendMessage(fromNumber, "Transcribing your voice note... 🎙️");
            const transcription = await aiService.transcribeAudio(
                downloadResult.buffer,
                `audio.${extension}`,
                downloadResult.mimeType || 'audio/ogg'
            );
            // A transcript is untrusted text too. It is machine output, but the
            // machine is repeating whatever the citizen said, and it reaches the
            // same places typed text does -- the classifier, the database, the
            // admin timeline.
            transcribedText = sanitizer.sanitizeText(transcription.text, { maxLength: MAX_MESSAGE_LENGTH });
            transcriptionConfidence = transcription.confidence;

            // A voice note is already capped at five minutes, but a fast talker
            // can exceed the description limit that far inside that. Truncate
            // rather than reject: the citizen cannot easily "say it again
            // shorter", and the tail of a long narration is rarely the point.
            if (transcribedText && transcribedText.length > MAX_DESCRIPTION_LENGTH) {
                transcribedText = transcribedText.substring(0, MAX_DESCRIPTION_LENGTH);
            }
            
            if (transcribedText) {
                logger.log('media_handler', `Transcription: ${transcribedText}`);
            } else {
                 // Warning usually logged in service, but we can log here too
                 logger.log('media_handler', 'Transcription returned empty');
            }

        } else {
            await this.sendMessage(fromNumber, "⚠️ Failed to download the voice note. Please try again.");
            return;
        }

            const currentData = state.data || {};
            // Use transcribed text if available, otherwise fallback to a user-friendly message
            currentData.description = transcribedText ? transcribedText : "[Voice Note - Transcription unavailable]";
            currentData.audio_url = mediaUrl; // Capture for saving
            currentData.transcription_confidence = transcriptionConfidence;

            // Analyze with AI using the transcribed text if available
            let category = 'Uncategorized';
            let title = transcribedText ? (transcribedText.substring(0, 30) + (transcribedText.length > 30 ? '...' : '')) : "Voice Report";
            let urgency = 'medium';
            
            if (transcribedText) {
                await this.sendMessage(fromNumber, "Analyzing your report");
                try {
                    const analysis = await analyzeIssue(transcribedText);
                    if (analysis) {
                        category = analysis.category || 'Uncategorized';
                        title = analysis.summary || title;
                        urgency = analysis.urgency || 'medium';
                    }
                } catch (err) {
                    logger.logError('ai_debug', 'Error analyzing issue (Handler)', err);
                }
            }
            
            currentData.category = category;
            currentData.title = title;
            currentData.urgency = urgency;

            await this.promptDuplicatesOrConfirm(fromNumber, currentData);
        } else if (state && state.current_step === 'awaiting_feedback') {
            const mediaId = message.voice ? message.voice.id : message.audio.id;
            const downloadResult = await this.whatsAppService.downloadMedia(mediaId);
            let mediaUrl = '';
            let transcribedText = '[Transcription Unavailable]';

            if (downloadResult) {
                const extension = this.helpers.extensionForMime(downloadResult.mimeType, 'ogg');
                const filename = `${crypto.randomUUID()}.${extension}`;
                const uploadsDir = path.join(UPLOADS_ROOT, 'feedback', 'audio');
                const filePath = path.join(uploadsDir, filename);
                
                if (!fs.existsSync(uploadsDir)) {
                    fs.mkdirSync(uploadsDir, { recursive: true });
                }
                
                try {
                    fs.writeFileSync(filePath, downloadResult.buffer);
                    mediaUrl = `/uploads/feedback/audio/${filename}`;

                    // Transcribe
                    await this.sendMessage(fromNumber, "Transcribing your feedback... 🎙️");
                    const tx = await aiService.transcribeAudio(
                        downloadResult.buffer,
                        `audio.${extension}`,
                        downloadResult.mimeType || 'audio/ogg'
                    );
                    if (tx.text) {
                        transcribedText = sanitizer.sanitizeText(tx.text, { maxLength: MAX_DESCRIPTION_LENGTH });
                    }
                } catch (writeError) {
                    logger.logError('media_handler', 'Failed to save feedback audio', writeError);
                }
            }

            const user = await this.fixamDb.getUser(fromNumber);
            await this.saveFeedback(user.id, 'audio', transcribedText, mediaUrl, transcribedText);
            await this.sendMessage(fromNumber, "Thank you for your voice feedback! 🙏\n\nWe appreciate you helping us improve Fixam.");
            await this.sendMainMenu(fromNumber, user.name);
        } else {
            await this.sendMessage(fromNumber, "I'm not expecting a voice note right now.");
        }
    }

    /**
     * @param {string|object} who a first name, a full name, or a user row.
     *
     * Normalised here rather than at each of the two dozen call sites: a
     * greeting reads as a greeting when it uses one name ("Hello Aminata!"),
     * and callers holding a full user row should not each have to remember
     * that.
     */
    async sendMainMenu(fromNumber, who) {
    const name = typeof who === 'object' && who !== null
        ? this.firstNameOf(who)
        : (String(who || '').trim().split(/\s+/)[0] || 'there');
    await this.sendMessage(fromNumber, `Hello ${name}! 👋\n\nHow can I help you today? (Reply with a number [1-8] or text keywords!)\n\n1️⃣ *Report an Issue*\n2️⃣ *Vote on an Issue*\n3️⃣ *Track/Endorse Issue* 🔍\n4️⃣ *Trending Issues* 🔥\n5️⃣ *My Points* 🏆\n6️⃣ *Feedback* 💬\n7️⃣ *Help & Info* ℹ️\n8️⃣ *My Data* 📊`);
    await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_category' });
    }

    /**
     * Public address of this instance, as citizens should see it.
     *
     * Set FIXAM_BASE_URL per environment (compose points it at the local
     * frontend). The fallback is the hosted demo, so an instance deployed
     * without the variable keeps behaving as it did before.
     */
    getBaseUrl() {
        const base = process.env.FIXAM_BASE_URL || 'https://fixam.maxcit.com';
        return base.replace(/\/+$/, '');
    }

    /** Citizen-facing link for one ticket. */
    getIssueUrl(ticketId) {
        return `${this.getBaseUrl()}/?ticket=${ticketId}`;
    }

    // ── DPG: Build privacy URL from env, falling back to the configured base URL ──
    getPrivacyUrl() {
        return `${this.getBaseUrl()}/privacy`;
    }

    // ── DPG: Build instance-aware consent message ──────────────────────────────
    getConsentMessage() {
        const country = this.helpers.serviceArea.name;
        const privacyUrl = this.getPrivacyUrl();
        return `Welcome to Fixam! 🏗️\n\nFixam helps citizens report and track infrastructure issues in ${country}. We collect your phone number, name, location, and photos to process your reports.\n\n📄 Read our privacy policy: ${privacyUrl}\n\nReply *YES* to agree and continue, or *NO* to decline.`;
    }

    /**
     * Last step before the confirmation summary: warn if this looks like an
     * issue somebody already reported nearby, otherwise go straight to review.
     *
     * Every route into a report has to come through here. It used to live
     * inline in the text-description branch only, so a report narrated as a
     * voice note skipped the check entirely and duplicates went in unflagged.
     *
     * Flagging is deliberately not the final word -- the citizen can still say
     * "report as new" and the issue is filed for admins to review.
     */
    async promptDuplicatesOrConfirm(fromNumber, currentData) {
        // Emergencies take the fast path: no duplicate check (a second report
        // of a burning building is not noise), forced critical urgency, and
        // straight to confirmation. The duplicate prompt exists to cut spam, and
        // an emergency must not be slowed by it.
        if (await this.isEmergencyReport(currentData.category, currentData.description)) {
            currentData.is_emergency = true;
            currentData.urgency = 'critical';
            await this.fixamDb.updateConversationState(fromNumber, {
                current_step: 'awaiting_report_confirmation',
                data: currentData
            });
            await this.sendReportSummary(fromNumber, currentData);
            return;
        }

        let candidates = [];
        try {
            candidates = await this.fixamDb.findPotentialDuplicates(
                currentData.lat,
                currentData.lng,
                DUPLICATE_RADIUS_METERS,
                DUPLICATE_WINDOW_DAYS
            );
        } catch (err) {
            // A failure here must not cost the citizen their report.
            logger.logError('handler', 'Duplicate lookup failed', err);
        }

        // Proximity alone is not similarity. The old prompt filtered by
        // category, which put "garbage on the streets" next to "a truck is
        // blocking the road" whenever both sat within the radius. Compare the
        // descriptions themselves -- embedding similarity -- and keep only the
        // candidates that are actually about the same thing. If the AI service
        // is unreachable, fall back to the previous category match.
        let duplicates = [];
        if (candidates.length > 0 && currentData.description) {
            const texts = candidates.map((d) => `${d.title || ''} ${d.description || ''}`.trim());
            let scores = null;
            try {
                scores = await aiService.findSimilar(currentData.description, texts);
            } catch (err) {
                logger.logError('handler', 'Duplicate similarity check failed', err);
            }

            if (Array.isArray(scores) && scores.length === candidates.length) {
                duplicates = candidates
                    .filter((_, i) => scores[i] >= DUPLICATE_SIMILARITY_THRESHOLD)
                    .slice(0, 3);
            } else {
                duplicates = candidates
                    .filter((d) => !currentData.category || d.category === currentData.category)
                    .slice(0, 3);
            }
        }

        if (duplicates.length === 0) {
            await this.fixamDb.updateConversationState(fromNumber, {
                current_step: 'awaiting_report_confirmation',
                data: currentData
            });
            await this.sendReportSummary(fromNumber, currentData);
            return;
        }

        currentData.potential_duplicates = duplicates;
        await this.fixamDb.updateConversationState(fromNumber, {
            current_step: 'awaiting_duplicate_action',
            data: currentData
        });

        let msg = `🔍 *Similar issues reported nearby recently:*\n\n`;
        duplicates.forEach((dup) => {
            const metres = Math.round(Number(dup.distance) || 0);
            msg += `📍 *${dup.title}* (${dup.ticket_id})\n`;
            msg += `   Category: ${dup.category || 'Uncategorized'}\n`;
            msg += `   Status: ${dup.status}\n`;
            msg += `   About ${metres}m away, ${this.describeAge(dup.created_at)}\n\n`;
        });
        msg += `It seems this might have been reported already. What would you like to do? (Reply with the number)\n\n`;
        msg += `1️⃣ *View more details* of these issues\n`;
        msg += `2️⃣ *Report as a new* separate issue\n`;
        msg += `3️⃣ *Vote/Support* an existing issue`;
        msg += REPORT_NAV_FOOTER;

        await this.sendMessage(fromNumber, msg);
    }

    /** "today" / "3 days ago" -- enough for the citizen to judge recency. */
    describeAge(createdAt) {
        if (!createdAt) return 'recently';
        const days = Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000);
        if (days <= 0) return 'reported today';
        if (days === 1) return 'reported yesterday';
        return `reported ${days} days ago`;
    }

    async sendReportSummary(fromNumber, data) {
        // Urgency, not status. The AI classifies against exactly these four
        // words, so 'critical' belongs here -- it is the top of the urgency
        // scale. It used to also be the initial *status*, which is what made
        // the portal contradict this message.
        const urgencyEmoji = {
            'low': '🟢',
            'medium': '🟡',
            'high': '🟠',
            'critical': '🔴'
        };
        
        // Named area, when the geocoder gave us one. Citizens recognise
        // "Wilberforce, Western Area Urban" far quicker than a full OSM string.
        const area = [data.ward, data.city, data.district].filter(Boolean).join(', ');
        const unresolved = data.location_source === 'unresolved';

        await this.sendMessage(fromNumber,
            (data.is_emergency ? '🚨 *EMERGENCY REPORT* 🚨\n\n' : '') +
            `Please review your report:\n\n` +
            `📋 *Title*: ${data.title || 'Untitled'}\n` +
            `📍 *Location*: ${data.address}\n` +
            (area ? `🗺️ *Area*: ${area}\n` : '') +
            (unresolved ? `⚠️ _Not pinpointed on the map yet — an admin will confirm._\n` : '') +
            `📂 *Category*: ${data.category || 'General'}\n` +
            `${urgencyEmoji[data.urgency] || '🟡'} *Urgency*: ${(data.urgency || 'medium').toUpperCase()}\n` +
            `📝 *Description*: ${data.description}\n` +
            `📸 *Evidence*: ${data.image_url ? 'Attached' : 'None'}\n\n` +
            (data.is_emergency
                ? `This is being treated as an emergency and has been sent to the response team.\n\n`
                : '') +
            `Type the number *1* to confirm.` + REPORT_NAV_FOOTER
        );
    }

    async finalizeReport(fromNumber, data, userId) {
        // Authoritative pilot gate. The initiation gate is good UX -- a citizen
        // is told early that reporting is closed -- but this one is the
        // guarantee: a report cannot be created by a non-champion while pilot
        // mode is on, whatever path led here (a flow started before the switch
        // was flipped, a client still running older code, or a report finished
        // from a stale conversation state).
        const reporter = await this.fixamDb.getUser(fromNumber);
        if (!(await this.pilotReportGate(fromNumber, reporter))) {
            await this.fixamDb.resetConversationState(fromNumber);
            return;
        }

        const ticketId = this.helpers.generateTicketId();
        
        const issueData = {
            ticket_id: ticketId,
            title: data.title || 'Report',
            category: data.category || 'General',
            lat: data.lat,
            lng: data.lng,
            description: data.description,
            image_url: data.image_url,
            audio_url: data.audio_url || null,
            reported_by: userId,
            urgency: data.urgency || 'medium',
            address: data.address,
            district: data.district || null,
            city: data.city || null,
            ward: data.ward || null,
            // Recorded so admins can see whether the pin is a citizen's GPS, a
            // geocoder guess, or an address nobody has placed yet.
            location_source: data.location_source || (data.lat != null ? 'geocoded' : 'unresolved'),
            image_sha256: data.image_sha256 || null,
            image_mime_type: data.image_mime_type || null,
            image_forwarded: data.image_forwarded,
            image_reused_from: data.image_reused_from || null,
            transcription_confidence: data.transcription_confidence ?? null
        };

        const issue = await this.fixamDb.createIssue(issueData);
        if (issue) {
            // 1. Send Success Message
            //
            // Naming the institution matters: a report that goes to "the
            // government" is one nobody can be asked about later. If no MDA is
            // mapped to the category the line is left out rather than filled
            // with something vague -- an unmapped category is a configuration
            // gap, and claiming a recipient that does not exist would hide it.
            const responsible = await this.fixamDb.getGroupsForCategory(issue.category);
            const lead = (responsible || []).find((g) => g.role === 'lead') || (responsible || [])[0];
            const assignedLine = lead ? `\n👥 *Sent to:* ${lead.name}` : '';

            await this.sendMessage(fromNumber, `✅ *Report Submitted Successfully!*\n\nIssue ID: *${ticketId}*${assignedLine}\n\nYou can track this issue here: ${this.getIssueUrl(ticketId)}`);
            
            // 2. Alert Operational Team if necessary
            await this.alertOperationalTeam(issue, data.address, !!data.is_emergency);

            // 3. An emergency also alerts the coordination team (admins plus
            // everyone flagged onto it), so a life-safety report is seen by a
            // person even if the owning MDA's users are all away.
            if (data.is_emergency) {
                await this.alertEmergencyTeam(issue, data.address);
            }

            // 4. Send Sharing Link
            const botNumber = process.env.BOT_PHONE_NUMBER || '23274598229'; 
            const shareLink = `https://wa.me/${botNumber}?text=${ticketId}`;
            const shareMsg = `📢 *Share to Compile Votes!*\n\n*Issue:* ${data.title}\n*Location:* ${data.address}\n\nForward this message to your community to help prioritize this issue:\n\n"Help fix this issue! Click the link below to vote:"\n${shareLink}`;
            await this.sendMessage(fromNumber, shareMsg);

            // 4. Reset to Menu automatically
            const user = await this.fixamDb.getUser(fromNumber);
            await this.sendMainMenu(fromNumber, user ? user.name : 'there');
        } else {
            await this.sendMessage(fromNumber, "❌ Error submitting report. Please try again later.");
        }
    }

    /**
     * Send one message to everyone responsible for an issue's category.
     *
     * Used for the events that are not a new report -- a citizen following up,
     * a disputed resolution, a report reassigned to a different institution.
     * Failures are logged and skipped: one unreachable officer must not stop
     * the rest of the team being told.
     */
    async notifyResponsibleTeam(issue, message) {
        const groups = await this.fixamDb.getGroupsForCategory(issue.category);
        if (!groups || groups.length === 0) {
            logger.log('alert_system', `No groups mapped to ${issue.category} for ${issue.ticket_id}`);
            return 0;
        }

        let sent = 0;
        for (const group of groups) {
            const members = await this.fixamDb.getGroupMembers(group.name);
            for (const member of members || []) {
                try {
                    await this.sendMessage(member.phone_number, message);
                    sent++;
                } catch (err) {
                    logger.logError('alert_system', `Failed to notify ${member.phone_number}`, err);
                }
            }
        }
        return sent;
    }

    async alertOperationalTeam(issue, address, isEmergency = false) {
        // Alert relevant groups for ALL issues regardless of urgency

        // Get mapped groups for this category
        const groups = await this.fixamDb.getGroupsForCategory(issue.category);
        
        if (!groups || groups.length === 0) {
            logger.log('alert_system', `No groups found for category ${issue.category}`);
            return;
        }

        const header = isEmergency ? "🚨 *EMERGENCY DISPATCH* 🚨" : "📢 *ISSUE ALERT* 📢";
        const urgencyLabel = (issue.urgency || 'medium').toUpperCase();

        for (const group of groups) {
            logger.log('alert_system', `Alerting group ${group.name} for issue ${issue.ticket_id}`);

            const members = await this.fixamDb.getGroupMembers(group.name);
            if (!members || members.length === 0) {
                logger.log('alert_system', `No members found for group ${group.name}`);
                continue;
            }

            // Say whether this MDA owns the fix or is being kept informed.
            // Several can be alerted for one report, and without this every
            // recipient assumes somebody else is handling it.
            const roleLine = group.role === 'lead'
                ? '*Your role:* LEAD — your team owns this issue\n'
                : group.role === 'default'
                    ? '*Your role:* DEFAULT RECIPIENT — no MDA is mapped to this category yet\n'
                    : '*Your role:* SUPPORT — alerted for awareness\n';

            const alertMessage = `${header}\n\n` +
                roleLine +
                `*Urgency:* ${urgencyLabel}\n` +
                `*Category:* ${issue.category}\n` +
                `*Issue:* ${issue.title}\n` +
                `*Loc:* ${address || `${issue.lat}, ${issue.lng}`}\n` +
                `*ID:* ${issue.ticket_id}\n` +
                `*Link:* ${this.getIssueUrl(issue.ticket_id)}`;

            for (const member of members) {
                try {
                    await this.sendMessage(member.phone_number, alertMessage);
                    logger.log('alert_system', `Alert sent to ${member.name} (${member.phone_number}) in group ${group.name}`);
                } catch (err) {
                    logger.logError('alert_system', `Failed to send alert to ${member.phone_number}`, err);
                }
            }
        }
    }

    /**
     * Alert the emergency coordination team -- admins plus anyone flagged onto
     * it -- so an emergency is seen by a person even if the owning MDA's users
     * are all away. Separate from the MDA dispatch above: the team are the
     * accountable layer, not the owners of the fix.
     */
    async alertEmergencyTeam(issue, address) {
        const members = await this.fixamDb.getEmergencyTeamMembers();
        if (!members || members.length === 0) {
            logger.log('alert_system', `No emergency team members to alert for ${issue.ticket_id}`);
            return;
        }

        const message = `🚨 *EMERGENCY REPORT* 🚨\n\n`
            + `*Urgency:* CRITICAL\n`
            + `*Category:* ${issue.category}\n`
            + `*Issue:* ${issue.title}\n`
            + `*Loc:* ${address || `${issue.lat}, ${issue.lng}`}\n`
            + `*ID:* ${issue.ticket_id}\n`
            + `*Link:* ${this.getIssueUrl(issue.ticket_id)}`;

        for (const member of members) {
            try {
                await this.sendMessage(member.phone_number, message);
                logger.log('alert_system', `Emergency alert sent to ${member.name} (${member.phone_number})`);
            } catch (err) {
                logger.logError('alert_system', `Failed to send emergency alert to ${member.phone_number}`, err);
            }
        }
    }

    /**
     * Save feedback, working out who should receive it first.
     *
     * Classification is best-effort. If the AI service is unreachable the
     * feedback is still saved, just unclassified -- losing a citizen's feedback
     * because a model was down would be a far worse failure than an admin
     * having to route it by hand.
     */
    async saveFeedback(userId, type, content, mediaUrl = null, transcription = null) {
        const text = (transcription || content || '').trim();
        let routing = null;

        if (text) {
            try {
                const analysis = await aiService.analyzeFeedback(text);

                if (analysis && analysis.auto_routable) {
                    // Platform feedback only. This is the half the model gets
                    // right, and it has a fixed destination -- MoCTI and DSTI --
                    // so there is no institution to get wrong.
                    routing = {
                        scope: 'platform',
                        source: 'ai',
                        confidence: analysis.confidence
                    };
                } else if (analysis && analysis.scope === 'service') {
                    // A service complaint carries a suggested category but no
                    // MDA. It waits in the admin queue until someone confirms
                    // where it goes: the category guess is right about five
                    // times in eight, which is useful as a starting point and
                    // not good enough to file against an institution.
                    routing = {
                        scope: 'suggested',
                        category: analysis.suggested_category,
                        source: 'ai_suggested',
                        confidence: analysis.confidence
                    };
                }
            } catch (err) {
                logger.logError('feedback', 'Feedback routing failed', err);
            }
        }

        return this.fixamDb.createFeedback(userId, type, content, mediaUrl, transcription, routing);
    }

    async sendMessage(to, body) {
        await this.whatsAppService.sendMessage(to, body);
        // Log outgoing
        await this.fixamDb.logMessage({
            conversationId: to,
            direction: 'outgoing',
            messageType: 'text',
            messageBody: body
        });
    }
    /**
     * The blacklist the name parser should apply: the built-in list plus
     * whatever an administrator has added in platform settings.
     *
     * Cached briefly. Registration is the busiest moment in a citizen's first
     * conversation and the list changes about once a month, so re-reading it on
     * every keystroke buys nothing; a minute is short enough that an
     * administrator adding an entry sees it take effect while they are still
     * looking at the screen.
     */
    async getNameBlacklist() {
        const now = Date.now();
        if (this._nameBlacklist && this._nameBlacklistAt && (now - this._nameBlacklistAt) < 60000) {
            return this._nameBlacklist;
        }
        const configured = await this.fixamDb.getPlatformSetting('blacklisted_names');
        this._nameBlacklist = nameValidator.mergeBlacklist(configured);
        this._nameBlacklistAt = now;
        return this._nameBlacklist;
    }

    /**
     * What to call somebody in a greeting.
     *
     * Prefers the validated first name, falls back to the first word of the
     * legacy free-text name for accounts registered before it was split, and
     * ends on "there" rather than printing "undefined" at anybody.
     */
    firstNameOf(user) {
        if (!user) return 'there';
        if (user.first_name) return user.first_name;
        const firstWord = String(user.name || '').trim().split(/\s+/)[0];
        return firstWord || 'there';
    }
}

module.exports = FixamHandler;
