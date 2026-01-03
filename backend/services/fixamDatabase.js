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
            const result = await this.db.query(sql, [phoneNumber, name]);
            this.debugLog(`User registered/updated: ${phoneNumber}`, { name });
            return result.rows[0].id;
        } catch (error) {
            this.debugLog('Error registering user', { error: error.message, phoneNumber });
            return null;
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
            INSERT INTO issues (ticket_id, title, category, lat, lng, description, image_url, audio_url, reported_by, status, duplicate_of)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
            issueData.audio_url || null,
            issueData.reported_by,
            issueData.status || 'critical',
            issueData.duplicate_of || null
        ];

        try {
            const result = await this.db.query(sql, values);
            const issue = result.rows[0];
            
            // Gamification: Award 10 points for reporting
            if (issue.reported_by) {
                // Don't await strictly to avoid blocking response? 
                // Better to await to ensure consistency or handle error quietly. 
                // But since we have a try-catch block, awaiting is fine.
                await this.addPoints(issue.reported_by, 10, 'report_created', issue.id);
            }
            return issue;
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
            this.debugLog('Error fetching issue by ticketId', { error: error.message, ticketId });
            return null;
        }
    }

    // Get Issue by ID
    async getIssueById(id) {
        const sql = "SELECT * FROM issues WHERE id = $1";
        try {
            const result = await this.db.query(sql, [id]);
            return result.rows.length > 0 ? result.rows[0] : null;
        } catch (error) {
            this.debugLog('Error fetching issue by ID', { error: error.message, id });
            return null;
        }
    }

    // Find potential duplicates within radius (in meters) and timeframe (days)
    async findPotentialDuplicates(lat, lng, radiusMeters, category = null, days = 30) {
        // Haversine formula in SQL
        let sql = `
            SELECT i.*, 
                   (6371000 * acos(cos(radians($1)) * cos(radians(lat)) * cos(radians(lng) - radians($2)) + sin(radians($1)) * sin(radians(lat)))) AS distance
            FROM issues i
            WHERE i.created_at >= CURRENT_TIMESTAMP - INTERVAL '${days} days'
            AND i.status != 'fixed'
            AND i.duplicate_of IS NULL
        `;
        
        const values = [lat, lng, radiusMeters];
        let paramCount = 4;

        if (category) {
            sql += ` AND i.category = $${paramCount++}`;
            values.push(category);
        }

        sql += ` AND (6371000 * acos(cos(radians($1)) * cos(radians(lat)) * cos(radians(lng) - radians($2)) + sin(radians($1)) * sin(radians(lat)))) <= $3`;
        sql += ` ORDER BY distance ASC LIMIT 3`;

        try {
            const result = await this.db.query(sql, values);
            return result.rows;
        } catch (error) {
            this.debugLog('Error finding potential duplicates', { error: error.message, lat, lng });
            return [];
        }
    }

    // Mark issue as duplicate
    async markIssueAsDuplicate(issueId, duplicateOfId) {
        const sql = "UPDATE issues SET duplicate_of = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2";
        try {
            await this.db.query(sql, [duplicateOfId, issueId]);
            return true;
        } catch (error) {
            this.debugLog('Error marking issue as duplicate', { error: error.message, issueId, duplicateOfId });
            return false;
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
            
            // Gamification: Award 1 point to the reporter if it's an upvote
            if (voteType === 'upvote') {
                const issue = await this.getIssueById(issueId);
                if (issue && issue.reported_by && issue.reported_by !== userId) {
                     // Prevent self-voting points farming if desired, though self-voting isn't explicitly blocked logic-wise
                     await this.addPoints(issue.reported_by, 1, 'issue_upvoted', issueId);
                }
            }
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

    // Get daily issue count for a user
    async getDailyIssueCount(userId) {
        const sql = "SELECT COUNT(*) FROM issues WHERE reported_by = $1 AND created_at >= CURRENT_DATE";
        try {
            const result = await this.db.query(sql, [userId]);
            return parseInt(result.rows[0].count);
        } catch (error) {
            this.debugLog('Error counting daily issues', { error: error.message, userId });
            return 0;
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
    // Get groups for a category
    async getGroupsForCategory(categoryName) {
        const sql = `
            SELECT g.* 
            FROM groups g 
            JOIN category_groups cg ON g.id = cg.group_id 
            JOIN categories c ON cg.category_id = c.id 
            WHERE c.name = $1
        `;
        try {
            const result = await this.db.query(sql, [categoryName]);
            return result.rows;
        } catch (error) {
            this.debugLog('Error fetching groups for category', { error: error.message, categoryName });
            return [];
        }
    }

    // Get group members by group name
    async getGroupMembers(groupName) {
        const sql = `
            SELECT u.phone_number, u.name 
            FROM users u 
            JOIN user_groups ug ON u.id = ug.user_id 
            JOIN groups g ON ug.group_id = g.id 
            WHERE g.name = $1 AND u.is_disabled = FALSE
        `;
        try {
            const result = await this.db.query(sql, [groupName]);
            return result.rows;
        } catch (error) {
            this.debugLog('Error fetching group members', { error: error.message, groupName });
            return [];
        }
    }
    // Add Points to User
    async addPoints(userId, amount, actionType, relatedIssueId = null) {
        if (!userId) return false;
        
        const client = await this.db.connect();
        try {
            await client.query('BEGIN');
            
            // Update user points
            await client.query('UPDATE users SET points = points + $1 WHERE id = $2', [amount, userId]);
            
            // Log transaction
            await client.query(
                'INSERT INTO user_point_logs (user_id, amount, action_type, related_issue_id) VALUES ($1, $2, $3, $4)', 
                [userId, amount, actionType, relatedIssueId]
            );
            
            await client.query('COMMIT');
            this.debugLog(`Added ${amount} points to user ${userId} for ${actionType}`);
            return true;
        } catch (error) {
            await client.query('ROLLBACK');
            this.debugLog('Error adding points', { error: error.message, userId, amount });
            return false;
        } finally {
            client.release();
        }
    }

    // Get Leaderboard (Top 5)
    async getLeaderboard(limit = 5) {
        const sql = "SELECT name, points FROM users WHERE points > 0 ORDER BY points DESC LIMIT $1";
        try {
            const result = await this.db.query(sql, [limit]);
            return result.rows;
        } catch (error) {
            this.debugLog('Error fetching leaderboard', { error: error.message });
            return [];
        }
    }
}

module.exports = FixamDatabase;
