const axios = require('axios');
const logger = require('./logger');
const path = require('path');
const db = require('../db');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const LOCAL_AI_URL = 'http://localhost:8000/analyze-issue';

/**
 * Analyze text using Qwen AI to categorize, summarize, and determine urgency.
 * @param {string} text - The user's description of the issue.
 * @returns {Promise<Object>} - { category, summary, urgency }
 */
async function analyzeIssue(text) {
    logger.log('ai_debug', `Analyzing issue with Qwen AI. Text length: ${text.length}`);

    try {
        let categoriesList;
        try {
            const result = await db.query('SELECT name FROM categories');
            categoriesList = result.rows.map(row => row.name).join(', ');
        } catch (err) {
            logger.logError('ai_debug', 'Error fetching categories', err);
            categoriesList = "Uncategorized";
        }

        const requestBody = {
            description: text,
            categories: categoriesList
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

