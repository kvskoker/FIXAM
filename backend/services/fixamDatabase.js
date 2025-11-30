class FixamDatabase {
    constructor(db, debugLog) {
        this.db = db;
        this.debugLog = debugLog || console.log;
    }

    // Get user by phone number
    async getUser(phoneNumber) {
        const sql = "SELECT * FROM users WHERE phone_number = $1";
        try {
            const result = await this.db.query(sql, [phoneNumber]);
            return result.rows.length > 0 ? result.rows[0] : null;
        } catch (error) {
            this.debugLog('Error fetching user', { error: error.message, phoneNumber });
            return null;
        }
    }

    // Register user
    async registerUser(phoneNumber, name) {
        const sql = "INSERT INTO users (phone_number, name) VALUES ($1, $2) ON CONFLICT (phone_number) DO UPDATE SET name = COALESCE(EXCLUDED.name, users.name) RETURNING id";
        try {
            await this.db.query(sql, [phoneNumber, name]);
            this.debugLog(`User registered/updated: ${phoneNumber}`, { name });
            return true;
        } catch (error) {
            this.debugLog('Error registering user', { error: error.message, phoneNumber });
            return false;
        }
    }

    // Update user name
    async updateUserName(phoneNumber, name) {
        const sql = "UPDATE users SET name = $1 WHERE phone_number = $2";
        try {
            await this.db.query(sql, [name, phoneNumber]);
            this.debugLog(`User name updated: ${phoneNumber}`, { name });
            return true;
        } catch (error) {
            this.debugLog('Error updating user name', { error: error.message, phoneNumber });
            return false;
        }
    }

    // Get conversation state
    async getConversationState(phoneNumber) {
        const sql = "SELECT * FROM conversation_state WHERE phone_number = $1";
        try {
            const result = await this.db.query(sql, [phoneNumber]);
            if (result.rows.length > 0) {
                return result.rows[0];
            }
            return null;
        } catch (error) {
            this.debugLog('Error fetching conversation state', { error: error.message, phoneNumber });
            return null;
        }
    }

    // Initialize conversation state
    async initializeConversationState(phoneNumber) {
        const sql = "INSERT INTO conversation_state (phone_number, current_step) VALUES ($1, 'awaiting_category') ON CONFLICT (phone_number) DO UPDATE SET current_step = 'awaiting_category', last_updated = CURRENT_TIMESTAMP";
        try {
            await this.db.query(sql, [phoneNumber]);
            this.debugLog(`Conversation state initialized for ${phoneNumber}`);
            return true;
        } catch (error) {
            this.debugLog('Error initializing conversation state', { error: error.message, phoneNumber });
            return false;
        }
    }

    // Update conversation state
    async updateConversationState(phoneNumber, updates) {
        const fields = [];
        const values = [];
        let paramCount = 1;

        if (updates.current_step !== undefined) {
            fields.push(`current_step = $${paramCount++}`);
            values.push(updates.current_step);
        }
        if (updates.data !== undefined) {
            // Merge existing data with new data if possible, or just overwrite
            // For simplicity, we'll fetch existing, merge, and update, or just update if we trust the caller
            // But here we'll assume the caller passes the full data object or we use jsonb_set for partial updates
            // Let's just overwrite for now as it's easier to manage in the handler
            fields.push(`data = $${paramCount++}`);
            values.push(updates.data);
        }

        if (fields.length === 0) return false;

        values.push(phoneNumber);
        const sql = `UPDATE conversation_state SET ${fields.join(', ')}, last_updated = CURRENT_TIMESTAMP WHERE phone_number = $${paramCount}`;

        try {
            await this.db.query(sql, values);
            this.debugLog(`Conversation state updated for ${phoneNumber}`, updates);
            return true;
        } catch (error) {
            this.debugLog('Error updating conversation state', { error: error.message, phoneNumber });
            return false;
        }
    }

    // Reset conversation state
    async resetConversationState(phoneNumber) {
        const sql = "DELETE FROM conversation_state WHERE phone_number = $1";
        try {
            await this.db.query(sql, [phoneNumber]);
            this.debugLog(`Conversation state reset for ${phoneNumber}`);
            return true;
        } catch (error) {
            this.debugLog('Error resetting conversation state', { error: error.message, phoneNumber });
            return false;
        }
    }

    // Create Issue
    async createIssue(issueData) {
        const sql = `
            INSERT INTO issues (ticket_id, title, category, lat, lng, description, image_url, reported_by, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'critical')
            RETURNING *
        `;
        const values = [
            issueData.ticket_id,
            issueData.title,
            issueData.category,
            issueData.lat,
            issueData.lng,
            issueData.description,
            issueData.image_url,
            issueData.reported_by
        ];

        try {
            const result = await this.db.query(sql, values);
            return result.rows[0];
        } catch (error) {
            this.debugLog('Error creating issue', { error: error.message });
            return null;
        }
    }

    // Get Issue by Ticket ID
    async getIssueByTicketId(ticketId) {
        const sql = "SELECT * FROM issues WHERE ticket_id = $1";
        try {
            const result = await this.db.query(sql, [ticketId]);
            return result.rows.length > 0 ? result.rows[0] : null;
        } catch (error) {
            this.debugLog('Error fetching issue', { error: error.message, ticketId });
            return null;
        }
    }

    // Vote on Issue
    async voteIssue(issueId, userId, voteType) {
        const sql = `
            INSERT INTO votes (issue_id, user_id, vote_type)
            VALUES ($1, $2, $3)
            ON CONFLICT (issue_id, user_id)
            DO UPDATE SET vote_type = $3, created_at = CURRENT_TIMESTAMP
        `;
        try {
            await this.db.query(sql, [issueId, userId, voteType]);
            return true;
        } catch (error) {
            this.debugLog('Error voting on issue', { error: error.message });
            return false;
        }
    }

    // Check if user has voted on issue
    async checkUserVote(issueId, userId) {
        const sql = "SELECT * FROM votes WHERE issue_id = $1 AND user_id = $2";
        try {
            const result = await this.db.query(sql, [issueId, userId]);
            return result.rows.length > 0 ? result.rows[0] : null;
        } catch (error) {
            this.debugLog('Error checking user vote', { error: error.message });
            return null;
        }
    }

    // Log Message
    async logMessage(data) {
        const sql = `
            INSERT INTO message_logs (phone_number, direction, message_type, message_body)
            VALUES ($1, $2, $3, $4)
            RETURNING id
        `;
        try {
            const result = await this.db.query(sql, [
                data.conversationId,
                data.direction,
                data.messageType,
                data.messageBody
            ]);
            return result.rows[0].id;
        } catch (error) {
            this.debugLog('Error logging message', { error: error.message });
            return null;
        }
    }
}

module.exports = FixamDatabase;
