const axios = require('axios');
const logger = require('./logger');
const path = require('path');
const db = require('../db');
const TaskQueue = require('../utils/taskQueue');
const FormData = require('form-data');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Configuration
const LOCAL_AI_URL = 'http://localhost:8000';
const AI_TIMEOUT = 60000; // 60 seconds

// Queue for heavy AI tasks (transcription, image analysis) - Max 1 at a time to prevent CPU choking
const heavyTaskQueue = new TaskQueue(1);

// Queue for light AI tasks (text analysis) - Max 3 at a time
const lightTaskQueue = new TaskQueue(3);

/**
 * Analyze text using Qwen AI to categorize, summarize, and determine urgency.
 * Uses Light Queue.
 */
async function analyzeIssue(text) {
    return lightTaskQueue.add(async () => {
        logger.log('ai_debug', `Analyzing issue with Qwen AI. Text length: ${text.length}`);
        
        try {
            let categoriesList;
            try {
                const result = await db.query('SELECT name FROM categories');
                categoriesList = result.rows.map(row => row.name).join(', ');
            } catch (err) {
                categoriesList = "Uncategorized";
            }

            const response = await axios.post(`${LOCAL_AI_URL}/analyze-issue`, {
                description: text,
                categories: categoriesList
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: AI_TIMEOUT
            });

            const { summary, category, urgency } = response.data;
            return {
                category: category || "Uncategorized",
                summary: summary || text.substring(0, 100) + (text.length > 100 ? "..." : ""),
                urgency: urgency || "medium"
            };
        } catch (error) {
            logger.logError('ai_debug', 'Qwen AI Error', error);
            // Graceful fallback
            return {
                category: "Uncategorized",
                summary: text.substring(0, 100) + (text.length > 100 ? "..." : ""),
                urgency: "medium"
            };
        }
    });
}

/**
 * Analyze text using Python AI Service (Embeddings) to determine intent.
 * Uses Light Queue.
 */
async function analyzeIntent(text) {
    return lightTaskQueue.add(async () => {
        try {
            const response = await axios.post(`${LOCAL_AI_URL}/analyze-intent`, { text }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 5000 // Fast timeout for intent
            });
            return response.data;
        } catch (error) {
            logger.logError('ai_debug', 'AI Intent Error', error);
            return { intent: "unknown", entities: {} };
        }
    });
}

/**
 * Check Media Duration.
 * Uses Light Queue.
 */
async function checkDuration(buffer, filename, contentType) {
    return lightTaskQueue.add(async () => {
        try {
            const formData = new FormData();
            formData.append('file', buffer, { filename, contentType });
            
            const response = await axios.post(`${LOCAL_AI_URL}/check-duration`, formData, {
                headers: { ...formData.getHeaders() },
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                timeout: 10000
            });
            return response.data.duration;
        } catch (error) {
            logger.logError('ai_debug', 'Duration check failed', error);
            return 0; // Fail open
        }
    });
}

/**
 * Classify Image (Safety Check).
 * Uses Heavy Queue.
 */
async function classifyImage(buffer, contentType) {
    return heavyTaskQueue.add(async () => {
        try {
            const formData = new FormData();
            formData.append('image', buffer, { filename: 'image.jpg', contentType });
            
            const response = await axios.post(`${LOCAL_AI_URL}/classify-image`, formData, {
                headers: { ...formData.getHeaders() },
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                timeout: AI_TIMEOUT
            });
            return response.data;
        } catch (error) {
            logger.logError('ai_debug', 'Image classification failed', error);
            return null; // Fail open
        }
    });
}

/**
 * Transcribe Audio (Whisper).
 * Uses Heavy Queue.
 */
async function transcribeAudio(buffer, filename, contentType) {
    return heavyTaskQueue.add(async () => {
        try {
            const formData = new FormData();
            formData.append('file', buffer, { filename, contentType });
            
            const response = await axios.post(`${LOCAL_AI_URL}/transcribe`, formData, {
                headers: { ...formData.getHeaders() },
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                timeout: AI_TIMEOUT * 2 // Give Whisper more time (2 mins)
            });
            return response.data.text;
        } catch (error) {
            logger.logError('ai_debug', 'Transcription failed', error);
            return ""; // Fallback to empty string
        }
    });
}

module.exports = { 
    analyzeIssue, 
    analyzeIntent,
    checkDuration,
    classifyImage,
    transcribeAudio
};

