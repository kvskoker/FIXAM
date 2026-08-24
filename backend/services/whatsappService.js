const axios = require('axios');
require('../loadEnv');
const logger = require('./logger');
const simulator = require('./simulator');

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

// Graph API version used for every call to Meta.
//
// Pinned rather than left to float, because Meta changes payload shapes between
// versions and an unpinned call would change behaviour on their schedule
// instead of ours. Overridable, because the pin has to be moved eventually:
// versions are deprecated roughly two years after release.
//
// This must be v21.0 or later for templates with NAMED parameters
// ({{customer_name}} rather than {{1}}). Older versions do not understand the
// parameter_name field, and reject the send as a parameter-count mismatch --
// an error that says nothing about the version being the cause.
const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v23.0';
const GRAPH_BASE = `https://graph.facebook.com/${API_VERSION}`;


// In-memory set of muted numbers for load testing
const mutedNumbers = new Set();

function muteUser(phoneNumber) {
    mutedNumbers.add(phoneNumber);
}

function unmuteUser(phoneNumber) {
    mutedNumbers.delete(phoneNumber);
}

/**
 * Send a text message via WhatsApp.
 * @param {string} to - The recipient's phone number.
 * @param {string} body - The message text.
 */
async function sendMessage(to, body) {
    // Check if user is muted (Load Testing)
    if (mutedNumbers.has(to)) {
        console.log(`[Mock WhatsApp - SILENT] To ${to}: ${body}`);
        return;
    }

    // Mirror into the WhatsApp simulator when one is running, so admin-side
    // messages (status updates, group alerts) show up in the simulated chat.
    // No-op unless SIMULATOR_ENABLED=true outside production. Only a number the
    // simulator is actually driving short-circuits the real send.
    const isSimulatedRecipient = await simulator.forwardMessage(to, body);
    if (isSimulatedRecipient) {
        console.log(`[Simulator] Delivered to ${to}: ${body}`);
        return;
    }

    if (!PHONE_NUMBER_ID || !ACCESS_TOKEN || PHONE_NUMBER_ID === 'your_phone_number_id') {
        console.log(`[Mock WhatsApp] Sending to ${to}: ${body}`);
        return;
    }

    try {
        await axios.post(
            `${GRAPH_BASE}/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: "whatsapp",
                to: to,
                text: { body: body }
            },
            {
                headers: {
                    Authorization: `Bearer ${ACCESS_TOKEN}`,
                    "Content-Type": "application/json"
                }
            }
        );
    } catch (error) {
        console.error("WhatsApp Send Error:", error.response ? error.response.data : error.message);
    }
}

/**
 * Send an approved message template.
 *
 * The only way to reach somebody outside the 24-hour service window. Unlike
 * sendMessage, this reports whether it worked: the caller is choosing between
 * two delivery routes and has to know when the chosen one failed.
 *
 * @param {string} to recipient's phone number
 * @param {string} templateName the name approved in the Meta dashboard
 * @param {Array<string|{name?: string, text: string}>} params body parameters.
 *        Plain strings fill a positional template ({{1}}, {{2}}); objects with
 *        a name fill a named one ({{customer_name}}).
 * @param {{language?: string}} [options]
 * @returns {Promise<boolean>} true when Meta accepted it
 */
async function sendTemplate(to, templateName, params, options = {}) {
    const language = options.language || 'en';
    const preview = `[template ${templateName}] `
        + params.map(p => (p && typeof p === 'object' ? p.text : p)).join(' | ');

    if (mutedNumbers.has(to)) {
        console.log(`[Mock WhatsApp - SILENT] To ${to}: ${preview}`);
        return true;
    }

    // The simulator has no notion of templates, so show it the rendered text.
    // An operator watching a simulated MDA inbox should see what the officer
    // would see, not a payload.
    const isSimulatedRecipient = await simulator.forwardMessage(to, preview);
    if (isSimulatedRecipient) {
        console.log(`[Simulator] Delivered to ${to}: ${preview}`);
        return true;
    }

    if (!PHONE_NUMBER_ID || !ACCESS_TOKEN || PHONE_NUMBER_ID === 'your_phone_number_id') {
        console.log(`[Mock WhatsApp] Sending to ${to}: ${preview}`);
        return true;
    }

    try {
        await axios.post(
            `${GRAPH_BASE}/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: "whatsapp",
                to: to,
                type: "template",
                template: {
                    name: templateName,
                    language: { code: language },
                    components: [
                        {
                            type: "body",
                            parameters: params.map(param => (
                                // A named-parameter template ({{customer_name}})
                                // needs parameter_name; a positional one ({{1}})
                                // rejects the field. Which one this is comes from
                                // the caller, because only the caller knows how
                                // the template in the dashboard was written.
                                param && typeof param === 'object' && param.name
                                    ? { type: "text", parameter_name: param.name, text: String(param.text) }
                                    : { type: "text", text: String(param && param.text !== undefined ? param.text : param) }
                            ))
                        }
                    ]
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${ACCESS_TOKEN}`,
                    "Content-Type": "application/json"
                }
            }
        );
        return true;
    } catch (error) {
        const detail = error.response ? error.response.data : { message: error.message };
        const code = detail && detail.error && detail.error.code;

        // These three account for almost every template failure, and the raw
        // Meta error names none of them in terms an operator can act on.
        if (code === 132001) {
            console.error(
                `WhatsApp Template Error: no template "${templateName}" in language "${language}". `
                + `The name and language must match the Meta dashboard exactly -- "en" and "en_US" are different templates.`
            );
        } else if (code === 132000) {
            console.error(
                `WhatsApp Template Error: "${templateName}" expects a different number of parameters than the ${params.length} sent. `
                + `Check the {{n}} placeholders in the approved body.`
            );
        } else if (code === 132005) {
            console.error(
                `WhatsApp Template Error: a parameter for "${templateName}" was rejected. `
                + `Parameters cannot contain newlines, tabs, or more than four consecutive spaces.`
            );
        } else {
            console.error("WhatsApp Template Send Error:", detail);
        }
        return false;
    }
}

/**
 * Send a location request message (interactive button or list not strictly supported for 'request location', 
 * usually we ask user to share it via attachment).
 */
async function requestLocation(to) {
    await sendMessage(to, "Please share your location using the attachment (paperclip) icon > Location.");
}

/**
 * Download media from WhatsApp/Facebook API.
 * @param {string} mediaId - The ID of the media to download.
 * @returns {Promise<{buffer: Buffer, mimeType: string}>} - The media buffer and mime type.
 */
async function downloadMedia(mediaId) {
    // DEV MODE MOCK for Load Testing
    if (process.env.DEV_MODE === 'true' && (mediaId === 'TEST_AUDIO' || mediaId === 'TEST_IMAGE')) {
        const fs = require('fs');
        const path = require('path');
        try {
            const filename = mediaId === 'TEST_AUDIO' ? 'test_audio.ogg' : 'test_image.jpg';
            const type = mediaId === 'TEST_AUDIO' ? 'audio/ogg' : 'image/jpeg';
            
            // Point to load_testing folder in backend
            const filePath = path.join(__dirname, '../load_testing', filename);
            console.log(`[MOCK DOWNLOAD] Checking path: ${filePath}`);
            
            if (fs.existsSync(filePath)) {
                console.log(`[MOCK DOWNLOAD] Serving local test file: ${filename} (${fs.statSync(filePath).size} bytes)`);
                const buffer = fs.readFileSync(filePath);
                return {
                    mimeType: type,
                    buffer: buffer
                };
            } else {
                console.error(`[MOCK DOWNLOAD] Test asset NOT FOUND at: ${filePath}`);
                return null;
            }
        } catch (e) {
            console.error("[MOCK DOWNLOAD] Error serving test asset", e);
            return null;
        }
    }

    logger.log('media_download', `========== Starting media download for ID: ${mediaId} ==========`);
    
    if (!PHONE_NUMBER_ID || !ACCESS_TOKEN || PHONE_NUMBER_ID === 'your_phone_number_id') {
        logger.log('media_download', `Mock mode - PHONE_NUMBER_ID: ${PHONE_NUMBER_ID}, ACCESS_TOKEN: ${ACCESS_TOKEN ? 'Present' : 'Missing'}`);
        console.log(`[Mock WhatsApp] Downloading media ${mediaId}`);
        return null;
    }

    logger.log('media_download', `PHONE_NUMBER_ID: ${PHONE_NUMBER_ID}`);
    logger.log('media_download', `ACCESS_TOKEN: ${ACCESS_TOKEN ? ACCESS_TOKEN.substring(0, 20) + '...' : 'Missing'}`);

    try {
        logger.log('media_download', 'STEP 1: Getting media URL from Graph API');
        const graphUrl = `${GRAPH_BASE}/${mediaId}`;
        logger.log('media_download', `Request URL: ${graphUrl}`);
        
        // 1. Get Media URL
        const urlResponse = await axios.get(graphUrl, {
            headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
            timeout: 10000 // 10s timeout
        });
        
        logger.log('media_download', `Response Status: ${urlResponse.status}`);
        logger.logObject('media_download', 'Response Data', urlResponse.data);
        
        const mediaUrl = urlResponse.data.url;
        const mimeType = urlResponse.data.mime_type;
        logger.log('media_download', `Media URL: ${mediaUrl}`);
        logger.log('media_download', `Mime Type: ${mimeType}`);

        // 2. Download Media Binary
        logger.log('media_download', 'STEP 2: Downloading binary from media URL');
        const mediaResponse = await axios.get(mediaUrl, {
            headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
            responseType: 'arraybuffer',
            timeout: 30000 // 30s timeout for download
        });
        
        logger.log('media_download', `Download Status: ${mediaResponse.status}`);
        logger.log('media_download', `Downloaded Size: ${mediaResponse.data.length} bytes`);
        logger.log('media_download', `========== Download complete for ID: ${mediaId} ==========`);

        return {
            buffer: mediaResponse.data,
            mimeType: mimeType
        };
    } catch (error) {
        logger.logError('media_download', `Failed to download media ${mediaId}`, error);
        logger.log('media_download', `========== Download FAILED for ID: ${mediaId} ==========`);
        console.error("WhatsApp Download Error:", error.response ? error.response.data : error.message);
        return null;
    }
}

module.exports = { sendMessage, sendTemplate, requestLocation, downloadMedia, muteUser, unmuteUser };

