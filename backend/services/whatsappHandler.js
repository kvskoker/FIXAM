const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FixamDatabase = require('./fixamDatabase');
const FixamHelpers = require('./fixamHelpers');
const logger = require('./logger');
const { analyzeIssue, analyzeIntent } = require('./aiService');
const axios = require('axios');
const FormData = require('form-data');

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

        // Security Check: Verify Phone Number ID
        const value = data.entry?.[0]?.changes?.[0]?.value;
        const metadata = value?.metadata;
        
        if (process.env.WHATSAPP_PHONE_NUMBER_ID && metadata?.phone_number_id) {
            if (metadata.phone_number_id !== process.env.WHATSAPP_PHONE_NUMBER_ID) {
                logger.log('webhook', `⚠️ Use configured Phone ID: ${process.env.WHATSAPP_PHONE_NUMBER_ID}. Received ID: ${metadata.phone_number_id}. Ignoring.`);
                return;
            }
        }
        
        if (value?.messages?.[0]) {
            const message = data.entry[0].changes[0].value.messages[0];
            const fromNumber = message.from;

            // Restrict to Sierra Leone numbers (232)
            if (!fromNumber.startsWith('232')) {
                logger.log('webhook', `Rejected message from unsupported region: ${fromNumber}`);
                await this.sendMessage(fromNumber, "Fixam is not yet supported in your country. Use a Sierra Leone phone number.");
                return;
            }

            // DEV MODE BLOCK
            if (process.env.DEV_MODE === 'true') {
                const roles = await this.fixamDb.getUserRoles(fromNumber);
                if (!roles.includes('Admin')) {
                    logger.log('webhook', `Blocked non-admin user in DEV_MODE: ${fromNumber}`);
                    await this.sendMessage(fromNumber, "🚧 *Maintenance Mode* 🚧\n\nThe application has been closed to public use for now until the final Hackathon event day. Only admins are allowed to access the platform.");
                    return;
                }
            }

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
        const input = text.trim();
        const lowerInput = input.toLowerCase();

        // Check if user exists
        let user = await this.fixamDb.getUser(fromNumber);

        // Global Reset
        if (lowerInput === 'reset' || lowerInput === 'cancel' || input === '9') {
            await this.fixamDb.resetConversationState(fromNumber);
            if (user) {
                await this.sendMainMenu(fromNumber, user.name);
            } else {
                await this.sendMessage(fromNumber, "Conversation reset. Type 'Hi' to start again.");
            }
            return;
        }

        // 1. User Registration
        // 2. Global: Check for direct Vote Code (FIX-XXXXXX)
        const voteCodeMatch = input.toUpperCase().match(/^FIX-[A-Z0-9]{6}$/);
        if (voteCodeMatch) {
             const ticketId = voteCodeMatch[0];
             const issue = await this.fixamDb.getIssueByTicketId(ticketId);
             if (issue) {
                 if (!user) {
                     // New user: Start registration but save intent
                     await this.fixamDb.initializeConversationState(fromNumber);
                     await this.fixamDb.updateConversationState(fromNumber, { 
                        current_step: 'awaiting_name',
                        data: { pending_vote_ticket: ticketId }
                     });
                     await this.sendMessage(fromNumber, `Welcome to Fixam! 👋\n\nTo vote on *${issue.title}*, please first tell us your name.`);
                     return;
                 } else {
                     // Registered user: Proceed to vote
                     await this.fixamDb.updateConversationState(fromNumber, { 
                        current_step: 'awaiting_vote_confirmation',
                        data: { issue_id: issue.id, ticket_id: issue.ticket_id, title: issue.title }
                    });
                    await this.sendMessage(fromNumber, `🗳️ *Vote Request Detected*\n\nFound Issue: *${issue.title}* (${issue.ticket_id})\n\nType *1* to Upvote 👍\nType *2* to Downvote 👎\nType *9* to cancel.`);
                    return;
                 }
             }
             // If not found, fall through
        }

        if (!user) {
            // Check if we are already asking for name
            let state = await this.fixamDb.getConversationState(fromNumber);
            
            if (state && state.current_step === 'awaiting_name') {
                // Register user
                const name = this.extractName(input);
                if (name.length < 2) {
                    await this.sendMessage(fromNumber, "Please enter a valid name.");
                    return;
                }
                await this.fixamDb.registerUser(fromNumber, name);
                
                // Check if they had a pending vote
                const pendingTicket = state.data && state.data.pending_vote_ticket;
                if (pendingTicket) {
                    const issue = await this.fixamDb.getIssueByTicketId(pendingTicket);
                    if (issue) {
                        const newUser = await this.fixamDb.getUser(fromNumber); // Re-fetch to get ID
                        await this.fixamDb.updateConversationState(fromNumber, { 
                            current_step: 'awaiting_vote_confirmation',
                            data: { issue_id: issue.id, ticket_id: issue.ticket_id, title: issue.title }
                        });
                        await this.sendMessage(fromNumber, `Thanks ${name}! ✅\n\nNow back to your vote:\n\n🗳️ *${issue.title}*\nType *1* to Upvote 👍\nType *2* to Downvote 👎\nType *9* to cancel.`);
                        return;
                    }
                }

                // Normal flow
                await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_category', data: {} });
                await this.sendMainMenu(fromNumber, name);
            } else {
                // Check if user provided name in this message via AI
                try {
                    const analysis = await analyzeIntent(input);
                    if (analysis && analysis.intent === 'registration' && analysis.entities && analysis.entities.name) {
                        const name = this.extractName(analysis.entities.name);
                        if (name.length >= 2) {
                             await this.fixamDb.registerUser(fromNumber, name);
                             await this.fixamDb.initializeConversationState(fromNumber);
                             await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_category', data: {} });
                             
                             await this.sendMessage(fromNumber, `Welcome to Fixam, ${name}! 👋`);
                             await this.sendMainMenu(fromNumber, name);
                             return;
                        }
                    }
                } catch (e) {
                    logger.logError('ai_debug', 'Registration Intent analysis failed', e);
                }

                // Start registration
                await this.fixamDb.initializeConversationState(fromNumber);
                await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_name' });
                await this.sendMessage(fromNumber, "Welcome to Fixam! 👋\n\nIt looks like you're new here. What is your name?");
            }
            return;
        }



        // 3. Get State
        let state = await this.fixamDb.getConversationState(fromNumber);
        if (!state) {
            await this.fixamDb.initializeConversationState(fromNumber);
            state = await this.fixamDb.getConversationState(fromNumber);
        }

        // 3. State Machine
        switch (state.current_step) {
            case 'awaiting_category':
                if (input === '1' || lowerInput.includes('report')) {
                    // Check rate limit
                    const dailyCount = await this.fixamDb.getDailyIssueCount(user.id);
                    if (dailyCount >= 20) {
                        await this.sendMessage(fromNumber, "🚫 Daily Limit Reached\n\nYou have reported 20 issues today. To prevent spam, we have a daily limit. Please try again tomorrow.\n\nThank you for helping improve our community! 🌟");
                        return;
                    }

                    await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_report_evidence', data: {} });
                    await this.sendMessage(fromNumber, "Great! Let's report an issue.\n\nPlease send a *Photo* or *Video* of the issue as evidence, or type *9* to cancel.");
                } else if (input === '2' || lowerInput.includes('vote')) {
                    await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_vote_ticket_id', data: {} });
                    await this.sendMessage(fromNumber, "Okay! Please enter the *Issue ID* of the issue you want to vote on, or type *9* to cancel.");
                } else if (input === '3' || lowerInput.includes('trending')) {
                    await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_trending_community', data: {} });
                    await this.sendMessage(fromNumber, "Please enter the name of the community or area you want to check (e.g. 'Lumley', 'Kissy'), or type *9* to cancel.");
                } else if (input === '4' || lowerInput.includes('point')) {
                    const points = user.points || 0;
                    // Mock leaderboard rank for now or fetch it
                    // Simple message
                    await this.sendMessage(fromNumber, `🏆 *Your Citizen Score*\n\nYou currently have: *${points} Points* ⭐\n\n*How to earn points:*\n+10 pts: Report an Issue\n+50 pts: Issue Resolved\n+1 pt: Getting Upvoted\n\nKeep participating to unlock future rewards! 🎁`);
                    // Stay in main menu
                    await this.sendMainMenu(fromNumber, user.name);
                } else if (input === '5' || lowerInput.includes('feedback')) {
                    await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_feedback', data: {} });
                    await this.sendMessage(fromNumber, "We value your feedback! 💬\n\nPlease type your feedback or send a *Voice Note*.");
                } else if (input === '6' || lowerInput.includes('help')) {
                    const helpMsg = `ℹ️ *Fixam Help Guide*\n\n` +
                                    `*1. Report an Issue*: Tell us about problems like potholes, water leaks, or trash. Share location and a photo!\n` +
                                    `*2. Vote*: Support issues reported by others using their Issue ID.\n` +
                                    `*3. Trending*: Find popular issues in your area (e.g. 'Freetown') to support.\n` +
                                    `*4. Points*: Earn points for being an active citizen!\n` +
                                    `*5. Feedback*: Share your thoughts with the Fixam team.\n\n` +
                                    `*Useful Commands:*\n` +
                                    `- Type *9* to Cancel any action.\n` +
                                    `- Type *Reset* to start over.\n\n` +
                                    `For more support, contact: fixam@maxcit.com`;
                    await this.sendMessage(fromNumber, helpMsg);
                    await this.sendMainMenu(fromNumber, user.name);
                } else {
                    // AI Intent Analysis
                    let analysis = null;
                    try {
                        analysis = await analyzeIntent(input);
                    } catch (e) {
                         logger.logError('ai_debug', 'Intent analysis failed', e);
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
                            
                            const newData = {};
                            const entities = analysis.entities || {};
                            if (entities.description) newData.description = entities.description;
                            if (entities.location) {
                                // Try to geocode
                                try {
                                    const locs = await this.helpers.geocodeAddress(entities.location + ", Sierra Leone");
                                    if (locs.length > 0) {
                                        newData.lat = locs[0].latitude;
                                        newData.lng = locs[0].longitude;
                                        newData.address = locs[0].display_name;
                                    } else {
                                        newData.address = entities.location;
                                    }
                                } catch(e) { newData.address = entities.location; }
                            }

                            await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_report_evidence', data: newData });
                            
                            let msg = "Great! Let's report an issue.";
                            if(newData.description) msg += `\n\n📝 I noted the description: "${newData.description}"`;
                            if(newData.address) msg += `\n📍 I noted the location: "${newData.address}"`;
                            msg += "\n\nPlease send a *Photo* or *Video* of the issue as evidence, or type *9* to cancel.";
                            
                            await this.sendMessage(fromNumber, msg);
                            return;

                        } else if (analysis.intent === 'vote_issue') {
                             console.log("DEBUG_HANDLER: Vote intent detected. Analysis:", JSON.stringify(analysis));
                             const entities = analysis.entities || {};
                             const ticketId = entities.ticket_id ? entities.ticket_id.toUpperCase() : null;
                             const voteType = entities.vote_type ? entities.vote_type.toLowerCase() : null;
                             console.log(`DEBUG_HANDLER: Extracted Ticket: ${ticketId}, VoteType: ${voteType}`);

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
                                         await this.sendMessage(fromNumber, `Found Issue: *${issue.title}* (${issue.ticket_id})\n\nI see you want to *${voteType}*.\n\nType *1* to Confirm Upvote 👍\nType *2* to Confirm Downvote 👎\nType *9* to cancel.`);
                                     } else {
                                         await this.fixamDb.updateConversationState(fromNumber, { 
                                            current_step: 'awaiting_vote_confirmation',
                                            data: { issue_id: issue.id, ticket_id: issue.ticket_id, title: issue.title }
                                        });
                                        await this.sendMessage(fromNumber, `Found Issue: *${issue.title}* (${issue.ticket_id})\n\nType *1* to Upvote 👍\nType *2* to Downvote 👎\nType *9* to cancel.`);
                                     }
                                 } else {
                                     await this.sendMessage(fromNumber, `Could not find issue with ID: ${ticketId}. Please check and try again.`);
                                     await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_vote_ticket_id', data: {} });
                                 }
                             } else {
                                await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_vote_ticket_id', data: {} });
                                await this.sendMessage(fromNumber, "Okay! Please enter the *Issue ID* of the issue you want to vote on, or type *9* to cancel.");
                             }
                             return;

                        } else if (analysis.intent === 'view_trending') {
                             const entities = analysis.entities || {};
                             const community = entities.location;

                             if (community) {
                                 // Trigger trending logic directly
                                 const locations = await this.helpers.geocodeAddress(community + ", Sierra Leone");
                                 if (locations.length > 0) {
                                     const loc = locations[0];
                                     const trendingIssues = await this.fixamDb.getTrendingIssues(loc.latitude, loc.longitude, 5000, 5);
                                    
                                     if (trendingIssues.length === 0) {
                                         await this.sendMessage(fromNumber, `No trending issues found in *${loc.display_name}*.`);
                                         await this.sendMainMenu(fromNumber, user.name);
                                     } else {
                                         let msg = `🔥 *Trending in ${loc.name || loc.display_name}*\n\n`;
                                         trendingIssues.forEach((issue, i) => {
                                            msg += `${i+1}. *${issue.title}*\n`;
                                            msg += `   📍 ${issue.address || 'Location N/A'}\n`;
                                            msg += `   👍 ${issue.upvote_count} Upvotes\n\n`;
                                         });
                                         msg += `Reply with the number (e.g. *1*) to view details and vote, or *9* to cancel.`;

                                         await this.fixamDb.updateConversationState(fromNumber, { 
                                            current_step: 'awaiting_trending_selection',
                                            data: { trending_issues: trendingIssues }
                                        });
                                        await this.sendMessage(fromNumber, msg);
                                     }
                                 } else {
                                    await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_trending_community', data: {} });
                                    await this.sendMessage(fromNumber, `I couldn't find "${community}". Please enter the name of the community again (e.g. 'Lumley'), or type *9* to cancel.`);
                                 }
                             } else {
                                await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_trending_community', data: {} });
                                await this.sendMessage(fromNumber, "Please enter the name of the community or area you want to check (e.g. 'Lumley', 'Kissy'), or type *9* to cancel.");
                             }
                             return;

                        } else if (analysis.intent === 'view_points') {
                             const points = user.points || 0;
                             await this.sendMessage(fromNumber, `🏆 *Your Citizen Score*\n\nYou currently have: *${points} Points* ⭐\n\n*How to earn points:*\n+10 pts: Report an Issue\n+50 pts: Issue Resolved\n+1 pt: Getting Upvoted\n\nKeep participating to unlock future rewards! 🎁`);
                             await this.sendMainMenu(fromNumber, user.name);
                             return;

                        } else if (analysis.intent === 'provide_feedback') {
                             const entities = analysis.entities || {};
                             const feedback = entities.feedback_text;

                             if (feedback) {
                                 await this.fixamDb.createFeedback(user.id, 'text', feedback);
                                 await this.sendMessage(fromNumber, "Thank you for your feedback! 🙏\n\nI've saved it.");
                                 await this.sendMainMenu(fromNumber, user.name);
                             } else {
                                await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_feedback', data: {} });
                                await this.sendMessage(fromNumber, "We value your feedback! 💬\n\nPlease type your feedback or send a *Voice Note*.");
                             }
                             return;

                        } else if (analysis.intent === 'get_help') {
                             const helpMsg = `ℹ️ *Fixam Help Guide*\n\n` +
                                            `*1. Report an Issue*: Tell us about problems like potholes, water leaks, or trash. Share location and a photo!\n` +
                                            `2. *Use natural language*: You can say "Report a leaking pipe at X" or "Register me as John".\n` +
                                            `*3. Vote*: Support issues reported by others using their Issue ID.\n` +
                                            `*4. Trending*: Find popular issues in your area.\n` +
                                            `*5. Points*: Earn points for being an active citizen!\n` +
                                            `*6. Feedback*: Share your thoughts.\n\n` +
                                            `For more support, contact: fixam@maxcit.com`;
                            await this.sendMessage(fromNumber, helpMsg);
                            await this.sendMainMenu(fromNumber, user.name);
                            return;
                        }
                    }

                    await this.sendMainMenu(fromNumber, user.name);
                }
                break;

            case 'awaiting_feedback':
                // Text Feedback
                await this.fixamDb.createFeedback(user.id, 'text', input);
                await this.sendMessage(fromNumber, "Thank you for your feedback! 🙏\n\nWe appreciate you helping us improve Fixam.");
                await this.sendMainMenu(fromNumber, user.name);
                break;

            case 'awaiting_report_evidence':
                if (lowerInput === 'skip') {
                     await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_report_location' });
                     await this.sendMessage(fromNumber, "Okay, skipping evidence.\n\nNow, please share the *Location* of the issue.\n\n📍 Use the attachment icon > Location\n✏️ Or type the address (e.g., '5 Jabbiela Drive')\n\nType *9* to cancel.");
                } else {
                    await this.sendMessage(fromNumber, "Please send a *Photo* or *Video* (not text) to continue, or type 'skip' if you don't have one. Type *9* to cancel.");
                }
                break;

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
                        msg += `, or type *9* to cancel.`;
                    }
                    await this.sendMessage(fromNumber, msg);
                    break;
                }

                // Handle text address
                const locations = await this.helpers.geocodeAddress(input);
                if (locations.length === 0) {
                    await this.sendMessage(fromNumber, "I couldn't find that address. Please try again or share your GPS location, or type *9* to cancel.");
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
                    await this.sendMessage(fromNumber, `Location found: ${loc.display_name}\n\nPlease describe the issue (Text or Voice Note), or type *9* to cancel.`);
                } else {
                    // Multiple locations - Ask user to select
                    const currentData = state.data || {};
                    currentData.pending_addresses = locations;
                    
                    await this.fixamDb.updateConversationState(fromNumber, { 
                        current_step: 'awaiting_address_selection',
                        data: currentData
                    });

                    let msg = `I found ${locations.length} locations. Please reply with the number (e.g. 1) to select, or type *9* to cancel:\n\n`;
                    locations.forEach((loc, i) => {
                        msg += `${i + 1}. ${loc.display_name}\n`;
                    });
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
                    delete currentData.pending_addresses; // Clean up

                    await this.fixamDb.updateConversationState(fromNumber, { 
                        current_step: 'awaiting_report_description',
                        data: currentData
                    });
                    await this.sendMessage(fromNumber, `Location confirmed: ${loc.display_name}\n\nPlease describe the issue (Text or Voice Note), or type *9* to cancel.`);
                } else {
                    await this.sendMessage(fromNumber, `Please reply with a valid number (1-${pendingAddresses.length}), or type *9* to cancel.`);
                }
                break;

            case 'awaiting_report_description':
                const currentData = state.data || {};
                
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

                // Check for duplicates within 100m and 1 month
                const duplicates = await this.fixamDb.findPotentialDuplicates(currentData.lat, currentData.lng, 100, category, 30);
                
                if (duplicates.length > 0) {
                    currentData.potential_duplicates = duplicates;
                    await this.fixamDb.updateConversationState(fromNumber, { 
                        current_step: 'awaiting_duplicate_action',
                        data: currentData
                    });

                    let msg = `🔍 *Similar issues found nearby:*\n\n`;
                    duplicates.forEach((dup, i) => {
                        msg += `📍 *${dup.title}* (${dup.ticket_id})\n`;
                        msg += `   Status: ${dup.status}\n`;
                    });
                    msg += `\nIt seems this might have been reported already. What would you like to do? (Reply with the number)\n\n`;
                    msg += `1️⃣ *View more details* of these issues\n`;
                    msg += `2️⃣ *Report as a new* separate issue\n`;
                    msg += `3️⃣ *Vote/Support* an existing issue\n\n`;
                    msg += `Type *9* to cancel.`;
                    
                    await this.sendMessage(fromNumber, msg);
                } else {
                    await this.fixamDb.updateConversationState(fromNumber, { 
                        current_step: 'awaiting_report_confirmation',
                        data: currentData
                    });
                    await this.sendReportSummary(fromNumber, currentData);
                }
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
                    await this.sendMessage(fromNumber, `Found Issue: *${selectedIssue.title}* (${selectedIssue.ticket_id})\n\nType *1* to Upvote 👍\nType *2* to Downvote 👎\nType *9* to cancel.`);
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
                const issue = await this.fixamDb.getIssueByTicketId(input.toUpperCase());
                if (issue) {
                    await this.fixamDb.updateConversationState(fromNumber, { 
                        current_step: 'awaiting_vote_confirmation',
                        data: { issue_id: issue.id, ticket_id: issue.ticket_id, title: issue.title }
                    });
                    await this.sendMessage(fromNumber, `Found Issue: *${issue.title}* (${issue.ticket_id})\n\nType *1* to Upvote 👍\nType *2* to Downvote 👎\nType *9* to cancel.`);
                } else {
                    await this.sendMessage(fromNumber, "Issue not found. Please check the Issue ID and try again, or type *9* to cancel.");
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
                        await this.sendMessage(fromNumber, "⚠️ *Confirm Downvote*\n\nYour downvote will penalize the reporter (-2 Points). Please use this ONLY for:\n\n❌ Spam/Fake Reports\n❌ Abusive Content\n\nAbuse of downvoting may result in penalties to YOUR account.\n\nType *2* again to confirm, or *9* to cancel.");
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
                const locations = await this.helpers.geocodeAddress(input + ", Sierra Leone"); // Append Country for better results
                if (locations.length === 0) {
                    await this.sendMessage(fromNumber, "I couldn't find a community with that name. Please try again (e.g. 'Freetown', 'Bo'), or type *9* to cancel.");
                } else {
                    // Use first match
                    const loc = locations[0];
                    const trendingIssues = await this.fixamDb.getTrendingIssues(loc.latitude, loc.longitude, 5000, 5); // 5km radius, top 5

                    if (trendingIssues.length === 0) {
                         await this.sendMessage(fromNumber, `No trending issues found in *${loc.display_name}* (5km radius).\n\nType *1* to Report an Issue instead, or *9* to return to menu.`);
                         await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_category' }); // Slightly hacky to move them to a state where 1 works or just send menu
                         // Actually let's just send main menu to match standard flow if empty
                         await this.sendMainMenu(fromNumber, user.name);
                    } else {
                         let msg = `🔥 *Trending in ${loc.name || loc.display_name}*\n\n`;
                         trendingIssues.forEach((issue, i) => {
                            msg += `${i+1}. *${issue.title}*\n`;
                            msg += `   📍 ${issue.address || 'Location N/A'}\n`;
                            msg += `   👍 ${issue.upvote_count} Upvotes\n\n`;
                         });
                         msg += `Reply with the number (e.g. *1*) to view details and vote, or *9* to cancel.`;

                         await this.fixamDb.updateConversationState(fromNumber, { 
                            current_step: 'awaiting_trending_selection',
                            data: { trending_issues: trendingIssues }
                        });
                        await this.sendMessage(fromNumber, msg);
                    }
                }
                break;
            }

            case 'awaiting_trending_selection':
                const tSelection = parseInt(input);
                const tIssues = state.data.trending_issues;
                
                if (tSelection >= 1 && tSelection <= tIssues.length) {
                    const tIssue = tIssues[tSelection - 1];
                    const link = `https://fixam.maxcit.com/?ticket=${tIssue.ticket_id}`;
                    
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
                    await this.sendMessage(fromNumber, `Please enter a number between 1 and ${tIssues.length}, or 9 to cancel.`);
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

            if (downloadResult && mediaType === 'image') {
                try {
                    logger.log('media_handler', 'Checking for sensitive content...');
                    const formData = new FormData();
                    formData.append('image', downloadResult.buffer, { filename: 'image.jpg', contentType: downloadResult.mimeType || 'image/jpeg' });
                    
                    const aiResponse = await axios.post('http://localhost:8000/classify-image', formData, {
                        headers: { ...formData.getHeaders() },
                        maxContentLength: Infinity,
                        maxBodyLength: Infinity
                    });

                    if (aiResponse.data.status === 'nude') {
                        logger.log('media_handler', 'Image rejected: Nudity detected');
                        await this.sendMessage(fromNumber, "⚠️ This image contains sensitive content and has been rejected.");
                        return;
                    }
                    logger.log('media_handler', 'Image passed safety check');
                } catch (error) {
                    logger.logError('media_handler', 'AI Safety Check failed', error.message);
                    // Proceeding despite error to avoid blocking user flow if AI service is down
                }
            } else if (downloadResult && mediaType === 'video') {
                // Check duration
                try {
                    logger.log('media_handler', 'Checking video duration...');
                    const formData = new FormData();
                    formData.append('file', downloadResult.buffer, { filename: 'video.mp4', contentType: downloadResult.mimeType || 'video/mp4' });
                    
                    const durationRes = await axios.post('http://localhost:8000/check-duration', formData, {
                        headers: { ...formData.getHeaders() },
                        maxContentLength: Infinity,
                        maxBodyLength: Infinity
                    });
                    
                    const duration = durationRes.data.duration;
                    if (duration > 60) {
                        logger.log('media_handler', `Video rejected: Duration ${duration}s > 60s`);
                        await this.sendMessage(fromNumber, "⚠️ Video too long! Please send a video shorter than 1 minute.");
                        return;
                    }
                } catch (error) {
                    logger.logError('media_handler', 'Duration Check failed', error.message);
                }
            }
            
            let mediaUrl = '';

            if (downloadResult) {
                const extension = downloadResult.mimeType ? downloadResult.mimeType.split('/')[1].split(';')[0] : 'bin';
                const filename = `${crypto.randomUUID()}.${extension}`;
                const folder = mediaType === 'image' ? 'images' : 'videos';
                
                // Use frontend/uploads for web accessibility
                const uploadsDir = path.join(process.cwd(), 'frontend', 'uploads', 'issues', folder);
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
            
            await this.fixamDb.updateConversationState(fromNumber, { 
                current_step: 'awaiting_report_location',
                data: currentData
            });
            logger.log('media_handler', 'Updated state to awaiting_report_location');

            if (currentData.address) {
                await this.sendMessage(fromNumber, `Evidence received! 📸\n\nI previously noted the location: *${currentData.address}*.\n\nIs this correct?\nType *Yes* to confirm, or share a new location/type address.`);
            } else {
                await this.sendMessage(fromNumber, "Evidence received! 📸\n\nNow, please share the *Location* of the issue.\n\n📍 Use the attachment icon > Location\n✏️ Or type the address");
            }
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
            let transcribedText = '';

            if (downloadResult) {
                // Check duration first
                try {
                    const formData = new FormData();
                    formData.append('file', downloadResult.buffer, { filename: 'audio.ogg', contentType: downloadResult.mimeType || 'audio/ogg' });
                    
                    const durationRes = await axios.post('http://localhost:8000/check-duration', formData, {
                        headers: { ...formData.getHeaders() },
                        maxContentLength: Infinity,
                        maxBodyLength: Infinity
                    });
                    
                    const duration = durationRes.data.duration;
                    if (duration > 300) {
                        await this.sendMessage(fromNumber, "⚠️ Voice note too long! Please keep it under 5 minutes.");
                        return; // Stop processing, do not save
                    }
                } catch (error) {
                    logger.logError('media_handler', 'Audio Duration Check failed', error.message);
                    // Proceed cautiously or block? proceeding for now
                }

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

                // Transcribe with Whisper
                try {
                    await this.sendMessage(fromNumber, "Transcribing your voice note... 🎙️");
                    const formData = new FormData();
                    formData.append('file', downloadResult.buffer, { filename: `audio.${extension}`, contentType: downloadResult.mimeType || 'audio/ogg' });
                    
                    const aiResponse = await axios.post('http://localhost:8000/transcribe', formData, {
                        headers: { ...formData.getHeaders() },
                        maxContentLength: Infinity,
                        maxBodyLength: Infinity
                    });
                    
                    transcribedText = aiResponse.data.text;
                    logger.log('media_handler', `Transcription: ${transcribedText}`);
                } catch (error) {
                    logger.logError('media_handler', 'Transcription failed', error.message);
                }

            } else {
                await this.sendMessage(fromNumber, "⚠️ Failed to download the voice note. Please try again.");
                return;
            }

            const currentData = state.data || {};
            // Use transcribed text if available, otherwise fallback to a user-friendly message
            currentData.description = transcribedText ? transcribedText : "[Voice Note - Transcription unavailable]";
            currentData.audio_url = mediaUrl; // Capture for saving

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

            await this.fixamDb.updateConversationState(fromNumber, { 
                current_step: 'awaiting_report_confirmation',
                data: currentData
            });
            await this.sendReportSummary(fromNumber, currentData);
        } else if (state && state.current_step === 'awaiting_feedback') {
            const mediaId = message.voice ? message.voice.id : message.audio.id;
            const downloadResult = await this.whatsAppService.downloadMedia(mediaId);
            let mediaUrl = '';
            let transcribedText = '[Transcription Unavailable]';

            if (downloadResult) {
                const extension = downloadResult.mimeType ? downloadResult.mimeType.split('/')[1].split(';')[0] : 'ogg';
                const filename = `${crypto.randomUUID()}.${extension}`;
                const uploadsDir = path.join(process.cwd(), 'frontend', 'uploads', 'feedback', 'audio');
                const filePath = path.join(uploadsDir, filename);
                
                if (!fs.existsSync(uploadsDir)) {
                    fs.mkdirSync(uploadsDir, { recursive: true });
                }
                
                try {
                    fs.writeFileSync(filePath, downloadResult.buffer);
                    mediaUrl = `/uploads/feedback/audio/${filename}`;

                    // Transcribe
                    await this.sendMessage(fromNumber, "Transcribing your feedback... 🎙️");
                    const formData = new FormData();
                    formData.append('file', downloadResult.buffer, { filename: `audio.${extension}`, contentType: downloadResult.mimeType || 'audio/ogg' });
                    
                    try {
                        const aiResponse = await axios.post('http://localhost:8000/transcribe', formData, {
                            headers: { ...formData.getHeaders() },
                            maxContentLength: Infinity,
                            maxBodyLength: Infinity
                        });
                        transcribedText = aiResponse.data.text;
                    } catch (err) {
                        logger.logError('media_handler', 'Feedback Transcription failed', err.message);
                    }
                } catch (writeError) {
                    logger.logError('media_handler', 'Failed to save feedback audio', writeError);
                }
            }

            const user = await this.fixamDb.getUser(fromNumber);
            await this.fixamDb.createFeedback(user.id, 'audio', transcribedText, mediaUrl, transcribedText);
            await this.sendMessage(fromNumber, "Thank you for your voice feedback! 🙏\n\nWe appreciate you helping us improve Fixam.");
            await this.sendMainMenu(fromNumber, user.name);
        } else {
            await this.sendMessage(fromNumber, "I'm not expecting a voice note right now.");
        }
    }

    async sendMainMenu(fromNumber, name) {
        await this.sendMessage(fromNumber, `Hello ${name}! 👋\n\nHow can I help you today? (Reply with the number)\n\n1️⃣ *Report an Issue*\n2️⃣ *Vote on an Issue*\n3️⃣ *Trending Issues* 🔥\n4️⃣ *My Points* 🏆\n5️⃣ *Feedback* 💬\n6️⃣ *Help & Info* ℹ️`);
        await this.fixamDb.updateConversationState(fromNumber, { current_step: 'awaiting_category' });
    }

    async sendReportSummary(fromNumber, data) {
        const urgencyEmoji = {
            'low': '🟢',
            'medium': '🟡',
            'high': '🟠',
            'critical': '🔴'
        };
        
        await this.sendMessage(fromNumber, 
            `Please review your report:\n\n` +
            `📋 *Title*: ${data.title || 'Untitled'}\n` +
            `📍 *Location*: ${data.address}\n` +
            `📂 *Category*: ${data.category || 'General'}\n` +
            `${urgencyEmoji[data.urgency] || '🟡'} *Urgency*: ${(data.urgency || 'medium').toUpperCase()}\n` +
            `📝 *Description*: ${data.description}\n` +
            `📸 *Evidence*: ${data.image_url ? 'Attached' : 'None'}\n\n` +
            `Type the number *1* to confirm or *9* to cancel.`
        );
    }

    async finalizeReport(fromNumber, data, userId) {
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
            address: data.address
        };

        const issue = await this.fixamDb.createIssue(issueData);
        if (issue) {
            // 1. Send Success Message
            await this.sendMessage(fromNumber, `✅ *Report Submitted Successfully!*\n\nIssue ID: *${ticketId}*\n\nYou can track this issue here: https://fixam.maxcit.com/?ticket=${ticketId}`);
            
            // 2. Alert Operational Team if necessary
            await this.alertOperationalTeam(issue, data.address);

            // 3. Send Sharing Link
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

    async alertOperationalTeam(issue, address) {
        // Alert relevant groups for ALL issues regardless of urgency

        // Get mapped groups for this category
        const groups = await this.fixamDb.getGroupsForCategory(issue.category);
        
        if (!groups || groups.length === 0) {
            logger.log('alert_system', `No groups found for category ${issue.category}`);
            return;
        }

        for (const group of groups) {
            logger.log('alert_system', `Alerting group ${group.name} for issue ${issue.ticket_id}`);

            const members = await this.fixamDb.getGroupMembers(group.name);
            if (!members || members.length === 0) {
                logger.log('alert_system', `No members found for group ${group.name}`);
                continue;
            }

            const alertMessage = `🚨 *ISSUE ALERT* 🚨\n\n` +
                `*Title:* ${issue.title}\n` +
                `*Loc:* ${address || `${issue.lat}, ${issue.lng}`}\n` +
                `*ID:* ${issue.ticket_id}\n` +
                `*Link:* https://fixam.maxcit.com/?ticket=${issue.ticket_id}`;

            for (const member of members) {
                try {
                    await this.sendMessage(member.phone_number, alertMessage);
                    logger.log('alert_system', `Alert sent to ${member.name} (${member.phone_number})`);
                } catch (err) {
                    logger.logError('alert_system', `Failed to send alert to ${member.phone_number}`, err);
                }
            }
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
    extractName(input) {
        // 1. Remove common greetings/punctuation from start
        let clean = input.replace(/^(hi|hello|hey|good\s+(morning|afternoon|evening))\s*[!,.]*\s*/i, '');
        
        // 2. Remove trailing punctuation
        clean = clean.replace(/[.!]+$/, '');
        
        // 3. Check for Intro Patterns
        const patterns = [
            /^my name is\s+(.+)/i,
            /^name is\s+(.+)/i,
            /^i am\s+(.+)/i,
            /^i'm\s+(.+)/i,
            /^im\s+(.+)/i,
            /^call me\s+(.+)/i,
            /^this is\s+(.+)/i,
            /^names\s+(.+)/i,
            /^it's\s+(.+)/i,
            /^its\s+(.+)/i
        ];

        for (const pattern of patterns) {
            const match = clean.match(pattern);
            if (match && match[1]) {
                // Return the captured name, trimmed
                // Also capitalize first letter of each word for good measure
                return match[1].trim().replace(/\w\S*/g, (w) => (w.replace(/^\w/, (c) => c.toUpperCase())));
            }
        }
        
        // 4. Fallback: Return formatted original input
        return clean.trim().replace(/\w\S*/g, (w) => (w.replace(/^\w/, (c) => c.toUpperCase())));
    }
}

module.exports = FixamHandler;
