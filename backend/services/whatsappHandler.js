const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FixamDatabase = require('./fixamDatabase');
const FixamHelpers = require('./fixamHelpers');
const logger = require('./logger');

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
        logger.log('webhook', '========== Received webhook ==========');
        logger.logObject('webhook', 'Full webhook data', data);
        
        if (data.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
            const message = data.entry[0].changes[0].value.messages[0];
            const fromNumber = message.from;

            logger.log('webhook', `Message from: ${fromNumber}, Type: ${message.type}`);
            logger.logObject('webhook', 'Message object', message);

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
        const input = text.trim();
        const lowerInput = input.toLowerCase();

        // Check if user exists
        let user = await this.fixamDb.getUser(fromNumber);

        // Global Reset
        if (lowerInput === 'reset' || lowerInput === 'cancel' || input === '9') {
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
                if (lowerInput === 'skip') {
                     await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_report_location' });
                     await this.sendMessage(fromNumber, "Okay, skipping evidence.\n\nNow, please share the *Location* of the issue.\n\n📍 Use the attachment icon > Location\n✏️ Or type the address (e.g., '5 Jabbiela Drive')");
                } else {
                    await this.sendMessage(fromNumber, "Please send a *Photo* or *Video* (not text) to continue, or type 'skip' if you don't have one.");
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
                    // Multiple locations - Ask user to select
                    const currentData = state.data || {};
                    currentData.pending_addresses = locations;
                    
                    await this.fixamDb.updateConversationState(fromNumber, { 
                        current_step: 'awaiting_address_selection',
                        data: currentData
                    });

                    let msg = `I found ${locations.length} locations. Please reply with the number (1-${locations.length}) to select:\n\n`;
                    locations.forEach((loc, i) => {
                        msg += `${i + 1}. ${loc.display_name}\n`;
                    });
                    await this.sendMessage(fromNumber, msg);
                }
                break;

            case 'awaiting_address_selection':
                const selection = parseInt(input);
                const pendingAddresses = state.data.pending_addresses;
                
                if (selection >= 1 && selection <= pendingAddresses.length) {
                    const loc = pendingAddresses[selection - 1];
                    const currentData = state.data;
                    currentData.lat = loc.latitude;
                    currentData.lng = loc.longitude;
                    currentData.address = loc.display_name;
                    delete currentData.pending_addresses; // Clean up

                    await this.fixamDb.updateConversationState(fromNumber, { 
                        current_step: 'awaiting_report_description',
                        data: currentData
                    });
                    await this.sendMessage(fromNumber, `Location confirmed: ${loc.display_name}\n\nPlease describe the issue (Text or Voice Note).`);
                } else {
                    await this.sendMessage(fromNumber, `Please reply with a valid number (1-${pendingAddresses.length}).`);
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
                if (input === '1') {
                    await this.finalizeReport(fromNumber, state.data, user.id);
                } else if (input === '9') {
                    await this.sendMessage(fromNumber, "Report cancelled. Type 'Hi' to start over.");
                    await this.fixamDb.resetConversationState(fromNumber);
                } else {
                    await this.sendMessage(fromNumber, "Please type *1* to confirm or *9* to cancel.");
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
        logger.log('media_handler', `========== handleMediaMessage called for ${fromNumber} ==========`);
        let state = await this.fixamDb.getConversationState(fromNumber);
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
            
            let mediaUrl = '';

            if (downloadResult) {
                const extension = downloadResult.mimeType ? downloadResult.mimeType.split('/')[1].split(';')[0] : 'bin';
                const filename = `${crypto.randomUUID()}.${extension}`;
                const folder = mediaType === 'image' ? 'images' : 'videos';
                
                // Log current working directory for debugging
                logger.log('media_handler', `Current working directory: ${process.cwd()}`);
                
                // Use frontend/uploads for web accessibility
                const uploadsDir = path.join(process.cwd(), 'frontend', 'uploads', 'issues', folder);
                const filePath = path.join(uploadsDir, filename);
                
                logger.log('media_handler', `Constructed uploads dir: ${uploadsDir}`);
                logger.log('media_handler', `Full file path: ${filePath}`);
                logger.log('media_handler', `Directory exists: ${fs.existsSync(uploadsDir)}`);
                
                // Ensure directory exists
                if (!fs.existsSync(uploadsDir)) {
                    logger.log('media_handler', `Creating directory: ${uploadsDir}`);
                    try {
                        fs.mkdirSync(uploadsDir, { recursive: true });
                        logger.log('media_handler', 'Directory created successfully');
                    } catch (mkdirError) {
                        logger.logError('media_handler', 'Failed to create directory', mkdirError);
                        await this.sendMessage(fromNumber, "⚠️ Server error. Please contact support.");
                        return;
                    }
                }
                
                logger.log('media_handler', `Attempting to save file...`);
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
            
            await this.fixamDb.updateConversationState(fromNumber, { 
                current_step: 'awaiting_report_location',
                data: currentData
            });
            logger.log('media_handler', 'Updated state to awaiting_report_location');
            await this.sendMessage(fromNumber, "Evidence received! 📸\n\nNow, please share the *Location* of the issue.\n\n📍 Use the attachment icon > Location\n✏️ Or type the address");
        } else {
            logger.log('media_handler', `User not in correct state. Current: ${state?.current_step || 'null'}, Expected: awaiting_report_evidence`);
            await this.sendMessage(fromNumber, "I'm not expecting media right now.");
        }
        logger.log('media_handler', '========== handleMediaMessage complete ==========');
    }

    async handleVoiceMessage(fromNumber, message) {
        let state = await this.fixamDb.getConversationState(fromNumber);
        if (state && state.current_step === 'awaiting_report_description') {
            const mediaId = message.voice ? message.voice.id : message.audio.id;
            
            // Download Voice Note
            const downloadResult = await this.whatsAppService.downloadMedia(mediaId);
            let mediaUrl = '';

            if (downloadResult) {
                const extension = downloadResult.mimeType ? downloadResult.mimeType.split('/')[1].split(';')[0] : 'ogg';
                const filename = `${crypto.randomUUID()}.${extension}`;
                
                // Use frontend/uploads for web accessibility
                const uploadsDir = path.join(process.cwd(), 'frontend', 'uploads', 'issues', 'audio');
                const filePath = path.join(uploadsDir, filename);
                
                // Ensure directory exists
                if (!fs.existsSync(uploadsDir)) {
                    fs.mkdirSync(uploadsDir, { recursive: true });
                }
                
                fs.writeFileSync(filePath, downloadResult.buffer);
                mediaUrl = `/uploads/issues/audio/${filename}`;
            } else {
                await this.sendMessage(fromNumber, "⚠️ Failed to download the voice note. Please try again.");
                return;
            }

            const currentData = state.data || {};
            currentData.description = `[Voice Note] ${mediaUrl}`; // Store URL in description or separate field
            currentData.title = "Voice Report";
            currentData.voice_url = mediaUrl; // Store separately if schema supports it, else just description

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
            `Type *1* to confirm or *9* to cancel.`
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
