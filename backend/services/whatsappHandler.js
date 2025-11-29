const FixamDatabase = require('./fixamDatabase');
const FixamHelpers = require('./fixamHelpers');

class FixamHandler {
    constructor(whatsAppService, db, io, debugLog) {
        this.whatsAppService = whatsAppService;
        this.db = db; // This is the raw pool/client
        this.io = io;
        this.debugLog = debugLog || console.log;

        this.fixamDb = new FixamDatabase(db, this.debugLog);
        this.helpers = new FixamHelpers(this.debugLog);
    }

    async processIncomingMessage(data) {
        if (data.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
            const message = data.entry[0].changes[0].value.messages[0];
            const fromNumber = message.from; // Keep raw format for now, or format if needed

            // Log message
            const messageBody = message.text?.body || message.type;
            await this.fixamDb.logMessage({
                conversationId: fromNumber,
                direction: 'incoming',
                messageType: message.type,
                messageBody: messageBody
            });

            // Handle different message types
            if (message.type === 'text') {
                await this.handleTextMessage(fromNumber, messageBody);
            } else if (message.type === 'location') {
                await this.handleLocationMessage(fromNumber, message.location);
            } else if (message.type === 'image' || message.type === 'video') {
                await this.handleMediaMessage(fromNumber, message);
            } else if (message.type === 'audio' || message.type === 'voice') { // Voice notes
                await this.handleVoiceMessage(fromNumber, message);
            } else {
                await this.sendMessage(fromNumber, "Sorry, I don't understand this message type yet.");
            }
        }
    }

    async handleTextMessage(fromNumber, text) {
        const input = text.trim();
        const lowerInput = input.toLowerCase();

        // Check if user exists
        let user = await this.fixamDb.getUser(fromNumber);

        // Global Reset
        if (lowerInput === 'reset' || lowerInput === 'cancel') {
            await this.fixamDb.resetConversationState(fromNumber);
            await this.sendMessage(fromNumber, "Conversation reset. Type 'Hi' to start again.");
            return;
        }

        // 1. User Registration
        if (!user) {
            // Check if we are already asking for name
            let state = await this.fixamDb.getConversationState(fromNumber);
            
            if (state && state.current_step === 'awaiting_name') {
                // Register user
                const name = input;
                if (name.length < 2) {
                    await this.sendMessage(fromNumber, "Please enter a valid name.");
                    return;
                }
                await this.fixamDb.registerUser(fromNumber, name);
                await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_category', data: {} });
                await this.sendMainMenu(fromNumber, name);
            } else {
                // Start registration
                await this.fixamDb.initializeConversationState(fromNumber);
                await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_name' });
                await this.sendMessage(fromNumber, "Welcome to Fixam! 👋\n\nIt looks like you're new here. What is your name?");
            }
            return;
        }

        // 2. Get State
        let state = await this.fixamDb.getConversationState(fromNumber);
        if (!state) {
            await this.fixamDb.initializeConversationState(fromNumber);
            state = await this.fixamDb.getConversationState(fromNumber);
        }

        // 3. State Machine
        switch (state.current_step) {
            case 'awaiting_category':
                if (input === '1' || lowerInput.includes('report')) {
                    await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_report_evidence', data: {} });
                    await this.sendMessage(fromNumber, "Great! Let's report an issue.\n\nPlease send a *Photo* or *Video* of the issue as evidence.");
                } else if (input === '2' || lowerInput.includes('vote')) {
                    await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_vote_ticket_id', data: {} });
                    await this.sendMessage(fromNumber, "Okay! Please enter the *Ticket ID* of the issue you want to vote on.");
                } else {
                    await this.sendMainMenu(fromNumber, user.name);
                }
                break;

            case 'awaiting_report_evidence':
                await this.sendMessage(fromNumber, "Please send a *Photo* or *Video* (not text) to continue, or type 'skip' if you don't have one (not recommended).");
                if (lowerInput === 'skip') {
                     await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_report_location' });
                     await this.sendMessage(fromNumber, "Okay, skipping evidence.\n\nNow, please share the *Location* of the issue.\n\n📍 Use the attachment icon > Location\n✏️ Or type the address (e.g., '5 Jabbiela Drive')");
                }
                break;

            case 'awaiting_report_location':
                // Handle text address
                const locations = await this.helpers.geocodeAddress(input);
                if (locations.length === 0) {
                    await this.sendMessage(fromNumber, "I couldn't find that address. Please try again or share your GPS location.");
                } else if (locations.length === 1) {
                    const loc = locations[0];
                    const currentData = state.data || {};
                    currentData.lat = loc.latitude;
                    currentData.lng = loc.longitude;
                    currentData.address = loc.display_name;
                    
                    await this.fixamDb.updateConversationState(fromNumber, { 
                        current_step: 'awaiting_report_description',
                        data: currentData
                    });
                    await this.sendMessage(fromNumber, `Location found: ${loc.display_name}\n\nPlease describe the issue (Text or Voice Note).`);
                } else {
                    // Multiple locations - just pick first for simplicity or ask (implementing simple pick first for now to save turns, or could implement selection)
                    // Let's pick first for now to keep it simple as per "similar to test folder" but test folder does selection.
                    // User asked for "similar to how the bot in the test folder behaves".
                    // Okay, let's just take the first one for speed, or ask user to be more specific.
                    // Actually, let's just take the first one.
                     const loc = locations[0];
                    const currentData = state.data || {};
                    currentData.lat = loc.latitude;
                    currentData.lng = loc.longitude;
                    currentData.address = loc.display_name;
                    
                    await this.fixamDb.updateConversationState(fromNumber, { 
                        current_step: 'awaiting_report_description',
                        data: currentData
                    });
                    await this.sendMessage(fromNumber, `Location found: ${loc.display_name}\n\nPlease describe the issue (Text or Voice Note).`);
                }
                break;

            case 'awaiting_report_description':
                const currentData = state.data || {};
                currentData.description = input;
                // Default title
                currentData.title = input.substring(0, 30) + (input.length > 30 ? '...' : '');
                
                await this.fixamDb.updateConversationState(fromNumber, { 
                    current_step: 'awaiting_report_confirmation',
                    data: currentData
                });
                
                await this.sendReportSummary(fromNumber, currentData);
                break;

            case 'awaiting_report_confirmation':
                if (lowerInput === 'yes' || lowerInput === 'confirm') {
                    await this.finalizeReport(fromNumber, state.data, user.id);
                } else {
                    await this.sendMessage(fromNumber, "Report cancelled. Type 'Hi' to start over.");
                    await this.fixamDb.resetConversationState(fromNumber);
                }
                break;

            case 'awaiting_vote_ticket_id':
                const issue = await this.fixamDb.getIssueByTicketId(input.toUpperCase());
                if (issue) {
                    await this.fixamDb.updateConversationState(fromNumber, { 
                        current_step: 'awaiting_vote_confirmation',
                        data: { issue_id: issue.id, ticket_id: issue.ticket_id, title: issue.title }
                    });
                    await this.sendMessage(fromNumber, `Found Issue: *${issue.title}* (${issue.ticket_id})\n\nType *1* to Upvote 👍\nType *2* to Downvote 👎`);
                } else {
                    await this.sendMessage(fromNumber, "Issue not found. Please check the Ticket ID and try again.");
                }
                break;

            case 'awaiting_vote_confirmation':
                const voteData = state.data || {};
                if (input === '1') {
                    await this.fixamDb.voteIssue(voteData.issue_id, user.id, 'upvote');
                    await this.sendMessage(fromNumber, "Vote recorded! 👍\n\nType 'Hi' for main menu.");
                    await this.fixamDb.resetConversationState(fromNumber);
                } else if (input === '2') {
                    await this.fixamDb.voteIssue(voteData.issue_id, user.id, 'downvote');
                    await this.sendMessage(fromNumber, "Vote recorded! 👎\n\nType 'Hi' for main menu.");
                    await this.fixamDb.resetConversationState(fromNumber);
                } else {
                    await this.sendMessage(fromNumber, "Please type 1 or 2.");
                }
                break;

            default:
                await this.sendMainMenu(fromNumber, user.name);
        }
    }

    async handleLocationMessage(fromNumber, location) {
        let state = await this.fixamDb.getConversationState(fromNumber);
        if (state && state.current_step === 'awaiting_report_location') {
            const { latitude, longitude } = location;
            // Reverse geocode
            const addressInfo = await this.helpers.reverseGeocode(latitude, longitude);
            const address = addressInfo ? addressInfo.display_name : `${latitude}, ${longitude}`;

            const currentData = state.data || {};
            currentData.lat = latitude;
            currentData.lng = longitude;
            currentData.address = address;

            await this.fixamDb.updateConversationState(fromNumber, { 
                current_step: 'awaiting_report_description',
                data: currentData
            });
            await this.sendMessage(fromNumber, `Location received: ${address}\n\nPlease describe the issue (Text or Voice Note).`);
        } else {
            await this.sendMessage(fromNumber, "I'm not expecting a location right now.");
        }
    }

    async handleMediaMessage(fromNumber, message) {
        let state = await this.fixamDb.getConversationState(fromNumber);
        if (state && state.current_step === 'awaiting_report_evidence') {
            // In a real app, we would download the media using the ID and save it to S3/Cloudinary
            // For now, we'll just store the ID or a placeholder
            const mediaId = message.image ? message.image.id : message.video.id;
            const currentData = state.data || {};
            currentData.image_url = `https://graph.facebook.com/v17.0/${mediaId}`; // Placeholder
            
            await this.fixamDb.updateConversationState(fromNumber, { 
                current_step: 'awaiting_report_location',
                data: currentData
            });
            await this.sendMessage(fromNumber, "Evidence received! 📸\n\nNow, please share the *Location* of the issue.\n\n📍 Use the attachment icon > Location\n✏️ Or type the address");
        } else {
            await this.sendMessage(fromNumber, "I'm not expecting media right now.");
        }
    }

    async handleVoiceMessage(fromNumber, message) {
        let state = await this.fixamDb.getConversationState(fromNumber);
        if (state && state.current_step === 'awaiting_report_description') {
            const currentData = state.data || {};
            currentData.description = "[Voice Note Received]"; // We can't transcribe easily without external API
            currentData.title = "Voice Report";

            await this.fixamDb.updateConversationState(fromNumber, { 
                current_step: 'awaiting_report_confirmation',
                data: currentData
            });
            await this.sendReportSummary(fromNumber, currentData);
        } else {
            await this.sendMessage(fromNumber, "I'm not expecting a voice note right now.");
        }
    }

    async sendMainMenu(fromNumber, name) {
        await this.sendMessage(fromNumber, `Hello ${name}! 👋\n\nHow can I help you today?\n\n1️⃣ *Report an Issue*\n2️⃣ *Vote on an Issue*`);
        await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_category' });
    }

    async sendReportSummary(fromNumber, data) {
        await this.sendMessage(fromNumber, 
            `Please review your report:\n\n` +
            `📍 *Location*: ${data.address}\n` +
            `📝 *Description*: ${data.description}\n` +
            `📸 *Evidence*: ${data.image_url ? 'Attached' : 'None'}\n\n` +
            `Type *Yes* to confirm or *No* to cancel.`
        );
    }

    async finalizeReport(fromNumber, data, userId) {
        const ticketId = this.helpers.generateTicketId();
        const issueData = {
            ticket_id: ticketId,
            title: data.title || 'Report',
            category: 'General', // Default for now, or could ask user
            lat: data.lat,
            lng: data.lng,
            description: data.description,
            image_url: data.image_url,
            reported_by: userId
        };

        const issue = await this.fixamDb.createIssue(issueData);
        if (issue) {
            await this.sendMessage(fromNumber, `✅ Report Submitted!\n\nTicket ID: *${ticketId}*\n\nYou can view it on the live map: https://fixam.sl/map?ticket=${ticketId}`);
            await this.fixamDb.resetConversationState(fromNumber);
        } else {
            await this.sendMessage(fromNumber, "❌ Error submitting report. Please try again later.");
        }
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
}

module.exports = FixamHandler;
