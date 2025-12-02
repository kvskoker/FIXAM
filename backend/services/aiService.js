const axios = require('axios');
const logger = require('./logger');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });



const LOCAL_AI_URL = 'http://localhost:9000/classify';

const CANDIDATE_LABELS = [
    "Water", "Electricity", "Roads", "Transportation", "Drainage", "Waste", "Housing & Urban Development", "Telecommunications", "Internet", "Health Services", "Education Services", "Public Safety", "Security", "Fire Services", "Social Welfare", "Environmental Pollution", "Deforestation", "Animal Control", "Public Space Maintenance", "Disaster Management", "Corruption", "Accountability", "Local Taxation", "Streetlights", "Bridges or Culverts", "Public Buildings", "Sewage or Toilet Facilities", "Traffic Management", "Road Safety", "Youth Engagement", "Gender-Based Violence", "Child Protection", "Disability Access", "Market Operations", "Service Access"
];

/**
 * Analyze text using Local AI to categorize.
 * @param {string} text - The user's description of the issue.
 * @returns {Promise<Object>} - { category, summary, urgency }
 */
async function analyzeIssue(text) {
    // logger.log('ai_debug', `Analyzing issue with Local AI. Text length: ${text.length}`);

    try {
        const requestBody = {
            text: text,
            candidate_labels: CANDIDATE_LABELS
        };

        // logger.logObject('ai_debug', 'Request Body', requestBody);

        const response = await axios.post(LOCAL_AI_URL, requestBody, {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        // logger.logObject('ai_debug', 'Local AI Response', response.data);

        let bestLabel = response.data.best_label;
        const bestScore = response.data.score;

        // Threshold check
        if (bestScore < 0.80) {
            bestLabel = "others";
        }

        return {
            category: bestLabel,
            summary: text.substring(0, 100) + (text.length > 100 ? "..." : ""),
            urgency: "medium" // Default urgency as local model only classifies
        };
    } catch (error) {
        logger.logError('ai_debug', 'Local AI Error', error);
        return {
            category: "Uncategorized",
            summary: "Could not analyze text.",
            urgency: "medium"
        };
    }
}

module.exports = { analyzeIssue };
