const axios = require('axios');
require('dotenv').config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

/**
 * Analyze text using Gemini to categorize and summarize.
 * @param {string} text - The user's description of the issue.
 * @returns {Promise<Object>} - { category, summary, urgency }
 */
async function analyzeIssue(text) {
    if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_gemini_api_key') {
        console.warn("Gemini API Key not set. Returning dummy analysis.");
        return {
            category: "General",
            summary: text.substring(0, 50) + "...",
            urgency: "medium"
        };
    }

    const prompt = `
    Analyze the following report about a civic issue in Sierra Leone.
    Report: "${text}"
    
    1. Categorize it into one of these: Water, Electricity, Roads, Transportation, Drainage, Waste, Housing, Telecommunications, Health, Education, Public Safety & Security, Fire Services, Social Welfare, Environmental Pollution, Deforestation & Land Degradation, Animal Control, Public Space Maintenance, Disaster Management, Streetlights, Bridges or Culverts, Public Buildings, Traffic Management & Road Safety, Youth Engagement, Gender-Based Violence, Child Protection, Disability Access & Inclusion, Market Operations, Agriculture, Fisheries, Service Access, others.
    2. Summarize it in one short sentence (max 15 words).
    3. Rate urgency as: low, medium, or high.
    
    Return JSON format only: { "category": "...", "summary": "...", "urgency": "..." }
    `;

    try {
        const response = await axios.post(GEMINI_URL, {
            contents: [{ parts: [{ text: prompt }] }]
        });

        const content = response.data.candidates[0].content.parts[0].text;
        // Clean up markdown code blocks if present
        const jsonString = content.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(jsonString);
    } catch (error) {
        console.error("Gemini AI Error:", error.response ? error.response.data : error.message);
        return {
            category: "Other",
            summary: "Could not analyze text.",
            urgency: "medium"
        };
    }
}

module.exports = { analyzeIssue };
