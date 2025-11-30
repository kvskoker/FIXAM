const axios = require('axios');
require('dotenv').config({ path: './backend/.env' });

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const MEDIA_ID = '825144160320755'; // From user's example

async function testDownload() {
    console.log('--- Starting Download Test ---');
    console.log('Phone ID:', PHONE_NUMBER_ID);
    console.log('Token:', ACCESS_TOKEN ? 'Present' : 'Missing');
    console.log('Media ID:', MEDIA_ID);

    try {
        // Step 1: Get URL
        console.log('1. Fetching URL...');
        const urlResponse = await axios.get(
            `https://graph.facebook.com/v17.0/${MEDIA_ID}`,
            {
                headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
            }
        );
        
        console.log('Response Status:', urlResponse.status);
        console.log('Media URL:', urlResponse.data.url);
        
        const mediaUrl = urlResponse.data.url;

        // Step 2: Download Binary
        console.log('2. Downloading Binary...');
        const mediaResponse = await axios.get(mediaUrl, {
            headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
            responseType: 'arraybuffer'
        });
        
        console.log('Download Status:', mediaResponse.status);
        console.log('Data Length:', mediaResponse.data.length);
        console.log('--- Test Complete: SUCCESS ---');

    } catch (error) {
        console.error('--- Test Failed ---');
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', error.response.data.toString());
        } else {
            console.error('Error:', error.message);
        }
    }
}

testDownload();
