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

    // Get User Roles
    async getUserRoles(phoneNumber) {
        const sql = `
            SELECT r.name 
            FROM roles r
            JOIN user_roles ur ON r.id = ur.role_id
            JOIN users u ON ur.user_id = u.id
            WHERE u.phone_number = $1
        `;
        try {
            const result = await this.db.query(sql, [phoneNumber]);
            return result.rows.map(row => row.name);
        } catch (error) {
            this.debugLog('Error fetching user roles', { error: error.message, phoneNumber });
            return [];
        }
    }

    // Register user — only called AFTER consent is confirmed
    async registerUser(phoneNumber, name) {
        const sql = "INSERT INTO users (phone_number, name, consent_given, consent_timestamp) VALUES ($1, $2, TRUE, CURRENT_TIMESTAMP) ON CONFLICT (phone_number) DO UPDATE SET name = COALESCE(EXCLUDED.name, users.name) RETURNING id";
        try {
            const result = await this.db.query(sql, [phoneNumber, name]);
            this.debugLog(`User registered/updated: ${phoneNumber}`, { name });
            return result.rows[0].id;
        } catch (error) {
            this.debugLog('Error registering user', { error: error.message, phoneNumber });
            return null;
        }
    }

    // ── DPG FIX: PENDING CONSENT ─────────────────────────────────────────────

    // Store a new visitor who has not yet consented (do NOT add to users table yet)
    async setPendingConsent(phoneNumber, name, firstMessage) {
        const sql = "INSERT INTO pending_consent (phone_number, name, first_message) VALUES ($1, $2, $3) ON CONFLICT (phone_number) DO UPDATE SET name = $2, sent_at = CURRENT_TIMESTAMP";
        try {
            await this.db.query(sql, [phoneNumber, name, firstMessage]);
            return true;
        } catch (error) {
            this.debugLog('Error setting pending consent', { error: error.message, phoneNumber });
            return false;
        }
    }

    // Check if a phone number is waiting for consent
    async getPendingConsent(phoneNumber) {
        const sql = "SELECT * FROM pending_consent WHERE phone_number = $1";
        try {
            const result = await this.db.query(sql, [phoneNumber]);
            return result.rows.length > 0 ? result.rows[0] : null;
        } catch (error) {
            this.debugLog('Error getting pending consent', { error: error.message, phoneNumber });
            return null;
        }
    }

    // Remove from pending after consent given or user opted out
    async clearPendingConsent(phoneNumber) {
        const sql = "DELETE FROM pending_consent WHERE phone_number = $1";
        try {
            await this.db.query(sql, [phoneNumber]);
            return true;
        } catch (error) {
            this.debugLog('Error clearing pending consent', { error: error.message, phoneNumber });
            return false;
        }
    }

    // ── DPG FIX: DATA DELETION (Right to Erasure) ────────────────────────────

    // Delete a user and ALL their data. Triggered by "DELETE MY DATA" WhatsApp message.
    async deleteUser(phoneNumber) {
        const client = await this.db.connect();
        try {
            await client.query('BEGIN');

            // Get user id first
            const userResult = await client.query('SELECT id FROM users WHERE phone_number = $1', [phoneNumber]);
            if (userResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return false;
            }
            const userId = userResult.rows[0].id;

            // Delete in dependency order (child records first)
            await client.query('DELETE FROM endorsements WHERE user_id = $1', [userId]);
            await client.query('DELETE FROM votes WHERE user_id = $1', [userId]);
            await client.query('DELETE FROM user_point_logs WHERE user_id = $1', [userId]);
            await client.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
            await client.query('DELETE FROM user_groups WHERE user_id = $1', [userId]);
            await client.query('DELETE FROM feedback WHERE user_id = $1', [userId]);
            await client.query('DELETE FROM conversation_state WHERE phone_number = $1', [phoneNumber]);
            await client.query('DELETE FROM message_logs WHERE phone_number = $1', [phoneNumber]);
            await client.query('DELETE FROM pending_consent WHERE phone_number = $1', [phoneNumber]);

            // Anonymize issues instead of deleting (preserve civic data, remove PII linkage)
            await client.query('UPDATE issues SET reported_by = NULL WHERE reported_by = $1', [userId]);

            // Delete user
            await client.query('DELETE FROM users WHERE id = $1', [userId]);

            await client.query('COMMIT');
            this.debugLog(`User deleted: ${phoneNumber}`);
            return true;
        } catch (error) {
            await client.query('ROLLBACK');
            this.debugLog('Error deleting user', { error: error.message, phoneNumber });
            return false;
        } finally {
            client.release();
        }
    }

    // ── DPG FIX: DATA EXPORT (Data Portability) ──────────────────────────────

    // Return all personal data held about a user as a JSON object.
    async getUserData(phoneNumber) {
        try {
            const [userResult, issuesResult, votesResult, pointsResult, logsResult] = await Promise.all([
                this.db.query('SELECT id, phone_number, name, consent_given, consent_timestamp, points, created_at FROM users WHERE phone_number = $1', [phoneNumber]),
                this.db.query('SELECT ticket_id, title, category, description, status, urgency, address, created_at FROM issues WHERE reported_by = (SELECT id FROM users WHERE phone_number = $1)', [phoneNumber]),
                this.db.query('SELECT i.ticket_id, v.vote_type, v.created_at FROM votes v JOIN issues i ON v.issue_id = i.id WHERE v.user_id = (SELECT id FROM users WHERE phone_number = $1)', [phoneNumber]),
                this.db.query('SELECT amount, action_type, created_at FROM user_point_logs WHERE user_id = (SELECT id FROM users WHERE phone_number = $1)', [phoneNumber]),
                this.db.query('SELECT direction, message_type, message_body, created_at FROM message_logs WHERE phone_number = $1 ORDER BY created_at DESC LIMIT 100', [phoneNumber]),
            ]);

            return {
                profile: userResult.rows[0] || null,
                issues_reported: issuesResult.rows,
                votes_cast: votesResult.rows,
                points_history: pointsResult.rows,
                recent_messages: logsResult.rows,
                exported_at: new Date().toISOString(),
            };
        } catch (error) {
            this.debugLog('Error exporting user data', { error: error.message, phoneNumber });
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
            INSERT INTO issues (ticket_id, title, category, lat, lng, description, image_url, audio_url, reported_by, status, duplicate_of, urgency, address,
                                district, city, ward, constituency, location_source)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
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
            issueData.duplicate_of || null,
            issueData.urgency || 'medium',
            issueData.address || null,
            issueData.district || null,
            issueData.city || null,
            issueData.ward || null,
            issueData.constituency || null,
            issueData.location_source || 'geocoded'
        ];

        try {
            const result = await this.db.query(sql, values);
            const issue = result.rows[0];
            
            if (issue.reported_by) {
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
        if (!ticketId) return null;
        
        let normalizedId = ticketId.toUpperCase().trim();
        if (!normalizedId.startsWith('FIX-')) {
            normalizedId = `FIX-${normalizedId}`;
        }

        const sql = "SELECT * FROM issues WHERE ticket_id = $1";
        try {
            const result = await this.db.query(sql, [normalizedId]);
            return result.rows.length > 0 ? result.rows[0] : null;
        } catch (error) {
            this.debugLog('Error fetching issue by ticketId', { error: error.message, ticketId: normalizedId });
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
    /**
     * Open reports near a point within the last `days`.
     *
     * `category` ranks rather than filters. Category comes from an AI
     * classification of free text, so the same problem described twice can land
     * in different buckets (or in "Uncategorized" whenever the AI service is
     * briefly unavailable) -- filtering on it means the obvious duplicate is
     * never shown. Same-category matches are listed first and the caller shows
     * each one's category so the citizen can judge.
     */
    async findPotentialDuplicates(lat, lng, radiusMeters, category = null, days = 7) {
        if (lat == null || lng == null) return [];

        const windowDays = Number.isFinite(Number(days)) ? Math.floor(Number(days)) : 7;

        const distanceExpr = `(6371000 * acos(LEAST(1, GREATEST(-1,
            cos(radians($1)) * cos(radians(lat)) * cos(radians(lng) - radians($2))
            + sin(radians($1)) * sin(radians(lat))
        ))))`;

        // LEAST/GREATEST clamp guards acos: for two points that are effectively
        // identical the expression can round just past 1.0 and Postgres then
        // raises "input is out of range", losing the very match we are after.
        const sql = `
            SELECT i.*, ${distanceExpr} AS distance
            FROM issues i
            WHERE i.created_at >= CURRENT_TIMESTAMP - ($4 || ' days')::interval
              AND i.status NOT IN ('fixed', 'spam')
              AND i.duplicate_of IS NULL
              AND i.lat IS NOT NULL AND i.lng IS NOT NULL
              AND ${distanceExpr} <= $3
            ORDER BY (i.category IS DISTINCT FROM $5) ASC, distance ASC
            LIMIT 3
        `;

        try {
            const result = await this.db.query(sql, [lat, lng, radiusMeters, windowDays, category]);
            return result.rows;
        } catch (error) {
            this.debugLog('Error finding potential duplicates', { error: error.message, lat, lng });
            return [];
        }
    }

    // Get Trending Issues within radius
    async getTrendingIssues(lat, lng, radiusMeters = 5000, limit = 5) {
        const sql = `
            SELECT i.*, 
                   (6371000 * acos(cos(radians($1)) * cos(radians(lat)) * cos(radians(lng) - radians($2)) + sin(radians($1)) * sin(radians(lat)))) AS distance,
                   COALESCE(vote_counts.upvotes, 0) as upvote_count
            FROM issues i
            LEFT JOIN (
                SELECT issue_id, COUNT(*) as upvotes 
                FROM votes 
                WHERE vote_type = 'upvote' 
                GROUP BY issue_id
            ) vote_counts ON i.id = vote_counts.issue_id
            WHERE i.status NOT IN ('fixed', 'spam')
            AND i.duplicate_of IS NULL
            AND (6371000 * acos(cos(radians($1)) * cos(radians(lat)) * cos(radians(lng) - radians($2)) + sin(radians($1)) * sin(radians(lat)))) <= $3
            ORDER BY upvote_count DESC, distance ASC
            LIMIT $4
        `;

        try {
            const result = await this.db.query(sql, [lat, lng, radiusMeters, limit]);
            
            if (result.rows.length === 0) {
                this.debugLog(`No local trending found for ${lat}, ${lng} at ${radiusMeters}m. Falling back to Global.`);
                const globalSql = `
                    SELECT i.*, 
                           COALESCE(vote_counts.upvotes, 0) as upvote_count
                    FROM issues i
                    LEFT JOIN (
                        SELECT issue_id, COUNT(*) as upvotes 
                        FROM votes 
                        WHERE vote_type = 'upvote' 
                        GROUP BY issue_id
                    ) vote_counts ON i.id = vote_counts.issue_id
                    WHERE i.status NOT IN ('fixed', 'spam')
                    AND i.duplicate_of IS NULL
                    ORDER BY upvote_count DESC, i.created_at DESC
                    LIMIT $1
                `;
                const globalResult = await this.db.query(globalSql, [limit]);
                return globalResult.rows.map(row => ({ ...row, is_global: true }));
            }

            return result.rows;
        } catch (error) {
            this.debugLog('Error fetching trending issues', { error: error.message, lat, lng });
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
            
            const issue = await this.getIssueById(issueId);
            if (issue && issue.reported_by && issue.reported_by !== userId) {
                if (voteType === 'upvote') {
                    await this.addPoints(issue.reported_by, 1, 'issue_upvoted', issueId);
                } else if (voteType === 'downvote') {
                    await this.addPoints(issue.reported_by, -2, 'issue_downvoted', issueId);
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
            await client.query('UPDATE users SET points = GREATEST(0, points + $1) WHERE id = $2', [amount, userId]);
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

    // Create Feedback
    async createFeedback(userId, type, content, mediaUrl = null, transcription = null) {
        const sql = `
            INSERT INTO feedback (user_id, type, content, media_url, transcription, status)
            VALUES ($1, $2, $3, $4, $5, 'pending')
            RETURNING id
        `;
        try {
            const result = await this.db.query(sql, [userId, type, content, mediaUrl, transcription]);
            return result.rows[0].id;
        } catch (error) {
            this.debugLog('Error creating feedback', error);
            return null;
        }
    }

    // Get All Feedback
    async getFeedback() {
        const sql = `
            SELECT f.*, u.name as user_name, u.phone_number
            FROM feedback f
            JOIN users u ON f.user_id = u.id
            ORDER BY f.created_at DESC
        `;
        try {
            const result = await this.db.query(sql);
            return result.rows;
        } catch (error) {
            this.debugLog('Error fetching feedback', error);
            return [];
        }
    }

    // Acknowledge Feedback
    async acknowledgeFeedback(id) {
        const sql = "UPDATE feedback SET status = 'acknowledged' WHERE id = $1 RETURNING id";
        try {
            const result = await this.db.query(sql, [id]);
            return result.rows.length > 0;
        } catch (error) {
            this.debugLog('Error acknowledging feedback', error);
            return false;
        }
    }

    // Endorse Resolution
    async endorseIssue(issueId, userId) {
        const sql = "INSERT INTO endorsements (issue_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id";
        try {
            const result = await this.db.query(sql, [issueId, userId]);
            if (result.rows.length > 0) {
                await this.addPoints(userId, 5, 'issue_endorsed', issueId);
            }
            return result.rows.length > 0;
        } catch (error) {
            this.debugLog('Error endorsing issue', error);
            return false;
        }
    }

    // Check if user has endorsed an issue
    async checkUserEndorsement(issueId, userId) {
        const sql = "SELECT * FROM endorsements WHERE issue_id = $1 AND user_id = $2";
        try {
            const result = await this.db.query(sql, [issueId, userId]);
            return result.rows.length > 0;
        } catch (error) {
            this.debugLog('Error checking user endorsement', error);
            return false;
        }
    }

    // Get endorsement count for an issue
    async getEndorsementCount(issueId) {
        const sql = "SELECT COUNT(*) FROM endorsements WHERE issue_id = $1";
        try {
            const result = await this.db.query(sql, [issueId]);
            return parseInt(result.rows[0].count);
        } catch (error) {
            this.debugLog('Error getting endorsement count', error);
            return 0;
        }
    }
}

module.exports = FixamDatabase;
