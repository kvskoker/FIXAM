const axios = require('axios');

async function testIntent() {
    const text = "Hi, I want to upvote on the issue FIX-FAI5N9";
    console.log(`Testing intent analysis for: "${text}"`);

    try {
        const response = await axios.post('http://localhost:8000/analyze-intent', {
            text: text
        });
        
        console.log("Response Status:", response.status);
        console.log("Response Data:", JSON.stringify(response.data, null, 2));
        
        const entities = response.data.entities || {};
        if (entities.ticket_id === 'FIX-FAI5N9' && (entities.vote_type === 'upvote')) {
            console.log("SUCCESS: Entities extracted correctly.");
        } else {
            console.log("FAILURE: Entities missing or incorrect.");
        }

    } catch (error) {
        console.error("Error connecting to AI service:", error.message);
        if (error.response) {
            console.error("Server responded with:", error.response.data);
        }
    }
}

testIntent();
