const axios = require('axios');
require('dotenv').config();
const logger = require('./logger');
const simulator = require('./simulator');

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

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
            `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`,
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
            let filename = mediaId === 'TEST_AUDIO' ? 'test_audio.ogg' : 'test_image.jpg';
            let type = mediaId === 'TEST_AUDIO' ? 'audio/ogg' : 'image/jpeg';
            
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
        const graphUrl = `https://graph.facebook.com/v17.0/${mediaId}`;
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

module.exports = { sendMessage, requestLocation, downloadMedia, muteUser, unmuteUser };

