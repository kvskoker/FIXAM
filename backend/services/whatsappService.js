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

module.exports = { sendMessage, requestLocation };
