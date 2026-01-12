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

const LOCAL_AI_INTENT_URL = 'http://localhost:8000/analyze-intent';

/**
 * Analyze text using Python AI Service (Embeddings) to determine intent.
 * @param {string} text - The user's input text.
 * @returns {Promise<Object>} - { intent, entities }
 */
async function analyzeIntent(text) {
    logger.log('ai_debug', `Analyzing intent via Python Service. Text length: ${text.length}`);

    try {
        const requestBody = {
            text: text
        };

        const response = await axios.post(LOCAL_AI_INTENT_URL, requestBody, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 5000 // Fast timeout
        });

        logger.logObject('ai_debug', 'AI Intent Response', response.data);
        return response.data;
    } catch (error) {
        logger.logError('ai_debug', 'AI Intent Error', error);
        return { intent: "unknown", entities: {} };
    }
}

module.exports = { analyzeIssue, analyzeIntent };

