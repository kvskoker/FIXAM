const axios = require('axios');
const logger = require('./logger');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });



const LOCAL_AI_URL = 'http://localhost:9000/classify';

const CATEGORY_MAPPING = {
    "Water supply, pipe leak, no water, shortage, dirty water": "Water",
    "Electricity issues, power outage, blackout, voltage, no light": "Electricity",
    "Road damage, potholes, bad road, construction, traffic jam": "Roads",
    "Transportation, bus, taxi, vehicle issues": "Transportation",
    "Drainage, clogged drains, flooding, gutters": "Drainage",
    "Waste management, garbage, trash, rubbish, dumping": "Waste",
    "Housing issues, urban development, building code": "Housing & Urban Development",
    "Telecommunications, phone signal, network issues": "Telecommunications",
    "Internet connectivity, slow internet, no wifi": "Internet",
    "Health services, hospital, clinic, doctor, medicine": "Health Services",
    "Education, school, teachers, students, books": "Education Services",
    "Public safety, crime, theft, police, danger": "Public Safety",
    "Security issues, guards, protection": "Security",
    "Fire hazard, fire outbreak, firefighters": "Fire Services",
    "Social welfare, support, community aid": "Social Welfare",
    "Environmental pollution, smoke, noise, air quality": "Environmental Pollution",
    "Deforestation, cutting trees, land degradation": "Deforestation",
    "Animal control, stray dogs, wild animals": "Animal Control",
    "Public space maintenance, parks, cleaning": "Public Space Maintenance",
    "Disaster management, emergency response": "Disaster Management",
    "Corruption, bribery, fraud, misconduct": "Corruption",
    "Accountability, transparency, government": "Accountability",
    "Local taxation, taxes, fees, rates": "Local Taxation",
    "Streetlights, dark streets, broken lights": "Streetlights",
    "Bridges, culverts, broken bridge": "Bridges or Culverts",
    "Public buildings, government offices, maintenance": "Public Buildings",
    "Sewage, toilet facilities, sanitation": "Sewage or Toilet Facilities",
    "Traffic management, signals, signs, rules": "Traffic Management",
    "Road safety, accidents, speeding": "Road Safety",
    "Youth engagement, activities, programs": "Youth Engagement",
    "Gender-based violence, abuse, harassment": "Gender-Based Violence",
    "Child protection, abuse, welfare": "Child Protection",
    "Disability access, ramps, inclusion": "Disability Access",
    "Market operations, stalls, vendors, prices": "Market Operations",
    "Service access, government services": "Service Access"
};

const CANDIDATE_LABELS = Object.keys(CATEGORY_MAPPING);

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

        let category = "others";

        // Threshold check
        if (bestScore >= 0.80) {
            // Map back to simple category name
            category = CATEGORY_MAPPING[bestLabel] || "others";
        }

        return {
            category: category,
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
