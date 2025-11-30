const axios = require('axios');
const logger = require('./logger');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const AI_API_KEY = process.env.AI_API_KEY;
// Using gemini-2.0-flash-lite
// Local AI Engine URL
const AI_URL = 'http://localhost:9000/analyze';

/**
 * Analyze text using local AI Engine to categorize and summarize.
 * @param {string} text - The user's description of the issue.
 * @returns {Promise<Object>} - { category, summary, urgency }
 */
async function analyzeIssue(text) {
    // logger.log('ai_debug', `Analyzing issue. Text length: ${text.length}`);

    const prompt = `
    Analyze the following report about a civic issue in Sierra Leone.
    Report: "${text}"
    
    1. Categorize it into one of these: Water, Electricity, Roads, Transportation, Drainage, Waste, Housing, Telecommunications, Health, Education, Public Safety & Security, Fire Services, Social Welfare, Environmental Pollution, Deforestation & Land Degradation, Animal Control, Public Space Maintenance, Disaster Management, Streetlights, Bridges or Culverts, Public Buildings, Traffic Management & Road Safety, Youth Engagement, Gender-Based Violence, Child Protection, Disability Access & Inclusion, Market Operations, Agriculture, Fisheries, Service Access, others.
    2. Summarize it in one short sentence (max 15 words).
    3. Rate urgency as: low, medium, or high.
    
    Return JSON format only: { "category": "...", "summary": "...", "urgency": "..." }
    `;

    try {
        const requestBody = {
            input_text: prompt
        };

        // logger.logObject('ai_debug', 'Request Body', requestBody);

        const response = await axios.post(AI_URL, requestBody, {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        // logger.logObject('ai_debug', 'Local AI Response', response.data);

        const content = response.data.response;
        // Clean up markdown code blocks if present
        const jsonString = content.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(jsonString);
    } catch (error) {
        logger.logError('ai_debug', 'AI Engine Error', error);
        return {
            category: "Uncategorized",
            summary: "Could not analyze text.",
            urgency: "medium"
        };
    }
}

module.exports = { analyzeIssue };
