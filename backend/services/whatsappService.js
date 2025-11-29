const axios = require('axios');
require('dotenv').config();

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

/**
 * Send a text message via WhatsApp.
 * @param {string} to - The recipient's phone number.
 * @param {string} body - The message text.
 */
async function sendMessage(to, body) {
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
    if (!PHONE_NUMBER_ID || !ACCESS_TOKEN || PHONE_NUMBER_ID === 'your_phone_number_id') {
        console.log(`[Mock WhatsApp] Downloading media ${mediaId}`);
        return null;
    }

    try {
        console.log(`[WhatsApp] Getting media URL for ID: ${mediaId}`);
        // 1. Get Media URL
        const urlResponse = await axios.get(
            `https://graph.facebook.com/v17.0/${mediaId}`,
            {
                headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
                timeout: 10000 // 10s timeout
            }
        );
        
        const mediaUrl = urlResponse.data.url;
        const mimeType = urlResponse.data.mime_type;
        console.log(`[WhatsApp] Found media URL: ${mediaUrl}, Mime: ${mimeType}`);

        // 2. Download Media Binary
        console.log(`[WhatsApp] Downloading binary...`);
        const mediaResponse = await axios.get(mediaUrl, {
            headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
            responseType: 'arraybuffer',
            timeout: 30000 // 30s timeout for download
        });
        console.log(`[WhatsApp] Download complete. Size: ${mediaResponse.data.length}`);

        return {
            buffer: mediaResponse.data,
            mimeType: mimeType
        };
    } catch (error) {
        console.error("WhatsApp Download Error:", error.response ? error.response.data : error.message);
        return null;
    }
}

module.exports = { sendMessage, requestLocation, downloadMedia };
