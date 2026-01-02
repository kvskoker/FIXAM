const axios = require('axios');
const logger = require('./logger');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const LOCAL_AI_URL = 'http://localhost:8000/analyze-issue';

const CATEGORIES = "Electricity & Power Supply, Water Supply, Road Infrastructure, Public Transportation, Drainage & Flooding, Waste Management, Housing & Urban Development, Telecommunications, Internet Access, Health Facilities, Education Facilities, Public Safety, Security, Fire Services, Social Welfare, Environmental Pollution, Deforestation, Animal Control, Public Space Maintenance, Natural Disaster Response, Corruption, Accountability, Local Taxation, Streetlights, Bridges & Culverts, Public Buildings, Sewage & Sanitation, Traffic Management, Road Safety, Youth Engagement, Gender-Based Violence, Child Protection, Disability Access, Market Operations, Service Access";

/**
 * Analyze text using Qwen AI to categorize, summarize, and determine urgency.
 * @param {string} text - The user's description of the issue.
 * @returns {Promise<Object>} - { category, summary, urgency }
 */
async function analyzeIssue(text) {
    logger.log('ai_debug', `Analyzing issue with Qwen AI. Text length: ${text.length}`);

    try {
        const requestBody = {
            description: text,
            categories: CATEGORIES
        };

        logger.logObject('ai_debug', 'Request Body', requestBody);

        const response = await axios.post(LOCAL_AI_URL, requestBody, {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 30000 // 30 second timeout for AI processing
        });

        logger.logObject('ai_debug', 'Qwen AI Response', response.data);

        const { summary, category, urgency } = response.data;

        return {
            category: category || "Uncategorized",
            summary: summary || text.substring(0, 100) + (text.length > 100 ? "..." : ""),
            urgency: urgency || "medium"
        };
    } catch (error) {
        logger.logError('ai_debug', 'Qwen AI Error', error);
        return {
            category: "Uncategorized",
            summary: text.substring(0, 100) + (text.length > 100 ? "..." : ""),
            urgency: "medium"
        };
    }
}

module.exports = { analyzeIssue };

