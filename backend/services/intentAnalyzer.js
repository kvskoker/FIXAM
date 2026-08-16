/**
 * localized intent analysis using Regex and Keyword matching.
 * This replaces the AI-based intent analysis for faster and more robust control over specific commands.
 */

const PATTERNS = {
    // 1. Vote Issue
    vote_issue: {
        keywords: ['vote', 'upvote', 'downvote', 'support', 'approve', 'reject', 'like', 'dislike'],
        // Stronger match if it contains a ticket ID
        require_either: ['vote', 'upvote', 'downvote', 'support', 'FIX-'],
        regex_ticket: /(FIX-[A-Z0-9]{6})/i,
        regex_upvote: /\b(upvote|up-vote|up\s+vote|support|like|approve)\b/i,
        regex_downvote: /\b(downvote|down-vote|down\s+vote|reject|dislike)\b/i
    },

    // 2. Report Issue
    report_issue: {
        keywords: ['report', 'complain', 'bad', 'broken', 'leak', 'hole', 'dirty', 'trash', 'pothole', 'damage', 'fix', 'issue', 'problem'],
        regex: /\b(report|complain|bad|broken|leak|pothole)\b/i // generic 'issue'/'problem' removed from strong regex
    },

    // 3. View Trending
    view_trending: {
        keywords: ['trending', 'trend', 'popular', 'hot', 'top', 'happening'],
        regex: /\b(trending|popular)\b/i,
        regex_location: /\b(?:in|at|near|around)\s+([a-zA-Z\s]+)/i 
    },

    // 4. View Points
    view_points: {
        keywords: ['point', 'score', 'rank', 'leaderboard', 'level', 'badge', 'profile', 'me'],
        regex: /\b(point|score|rank|leaderboard)\b/i
    },

    // 5. Provide Feedback
    provide_feedback: {
        keywords: ['feedback', 'suggest', 'comment', 'opinion', 'idea', 'review'],
        regex: /\b(feedback|suggestion)\b/i
    },

    // 6. Get Help
    get_help: {
        keywords: ['help', 'support', 'guide', 'info', 'what', 'how', 'assist', 'queries'],
        regex: /\b(help|support|guide|assist)\b/i,
        regex_question: /^(how|what|where|can i|do i|please)\b/i
    },

    // 7. Cancel
    cancel: {
        keywords: ['cancel', 'stop', 'quit', 'exit', 'menu', 'reset'],
        regex: /\b(cancel|stop|quit|exit)\b/i
    }
};

/**
 * Analyzes the user's text to determine intent and extract entities.
 * @param {string} text - The user input text.
 * @returns {Object} - { intent: string, entities: Object }
 */
function analyzeIntentLocal(text) {
    if (!text || typeof text !== 'string') {
        return { intent: 'unknown', entities: {} };
    }

    const cleanText = text.trim();
    
    // Default result
    const result = {
        intent: 'unknown',
        entities: {}
    };

    // --- Priority 1: Check for Ticket ID (Strong Indicator of Voting) ---
    const ticketMatch = cleanText.match(PATTERNS.vote_issue.regex_ticket);
    
    if (ticketMatch) {
        result.intent = 'vote_issue';
        result.entities.ticket_id = ticketMatch[1].toUpperCase();

        // Check for vote type
        if (PATTERNS.vote_issue.regex_upvote.test(cleanText)) {
            result.entities.vote_type = 'upvote';
        } else if (PATTERNS.vote_issue.regex_downvote.test(cleanText)) {
            result.entities.vote_type = 'downvote';
        }
        
        return result; 
    }

    // --- Priority 2: Check for Keywords if no Ticket ID found ---
    let highestScore = 0;
    let bestIntent = 'unknown';

    for (const [intentKey, pattern] of Object.entries(PATTERNS)) {
        let score = 0;
        const lowerText = cleanText.toLowerCase();

        // Check regex (Higher weight)
        if (pattern.regex && pattern.regex.test(cleanText)) {
            score += 10;
        }

        // Check question form for get_help (Medium High weight)
        if (intentKey === 'get_help' && pattern.regex_question && pattern.regex_question.test(cleanText)) {
             score += 15; // Questions are usually asking for help/info
        }

        // Check keywords (Lower weight)
        const matchCount = pattern.keywords.filter(k => lowerText.includes(k)).length;
        score += matchCount * 2;

        if (score > highestScore) {
            highestScore = score;
            bestIntent = intentKey;
        }
    }

    // Threshold for accepting an intent (avoid random matches on common words if needed)
    if (highestScore >= 2) {
        result.intent = bestIntent;
    }

    // --- Entity Extraction based on determined intent ---
    if (result.intent === 'vote_issue') {
        // We already checked ticket ID above, but lets check keywords again just in case
        if (PATTERNS.vote_issue.regex_upvote.test(cleanText)) result.entities.vote_type = 'upvote';
        if (PATTERNS.vote_issue.regex_downvote.test(cleanText)) result.entities.vote_type = 'downvote';
    } 
    else if (result.intent === 'view_trending') {
        const locMatch = cleanText.match(PATTERNS.view_trending.regex_location);
        if (locMatch) {
            result.entities.location = locMatch[1];
        } else {
             // Fallback: Check if common Sierra Leone locations are mentioned
             const commonLocs = ['Freetown', 'Bo', 'Kenema', 'Makeni', 'Koidu', 'Waterloo', 'Lumley', 'Kissy', 'Wellington'];
             for (const loc of commonLocs) {
                 if (cleanText.toLowerCase().includes(loc.toLowerCase())) {
                     result.entities.location = loc;
                     break;
                 }
             }
        }
    }
    else if (result.intent === 'provide_feedback') {
        // Everything after the keyword 'feedback' could be the feedback
        // But simpler: just treat the whole text as feedback if it's long enough
        if (cleanText.length > 10) {
            result.entities.feedback_text = cleanText;
        }
    }
    else if (result.intent === 'registration') {
        // Simple name extraction? Usually harder with regex.
        // "My name is John"
        const nameMatch = cleanText.match(/name\s+is\s+([a-zA-Z\s]+)/i);
        if (nameMatch) {
            result.entities.name = nameMatch[1].trim();
        }
    }

    return result;
}

module.exports = { analyzeIntentLocal };
