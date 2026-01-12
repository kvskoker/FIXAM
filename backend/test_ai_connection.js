const axios = require('axios');

async function testIntent() {
    // Test 1: Explicit Vote with ID
    const text1 = "Hi, I want to upvote on the issue FIX-FAI5N9";
    console.log(`\n--- Test 1: "${text1}" ---`);
    await runTest(text1);

    // Test 2: Ambiguous Question (The one that failed before)
    const text2 = "How do I vote on an issue?";
    console.log(`\n--- Test 2: "${text2}" ---`);
    await runTest(text2);
}

async function runTest(text) {
    try {
        const response = await axios.post('http://localhost:8000/analyze-intent', {
            text: text
        });
        
        console.log("Response Status:", response.status);
        console.log("Response Data:", JSON.stringify(response.data, null, 2));
        
    } catch (error) {
        console.error("Error connecting to AI service:", error.message);
        if (error.response) {
            console.error("Server responded with:", error.response.data);
        }
    }
}

testIntent();
