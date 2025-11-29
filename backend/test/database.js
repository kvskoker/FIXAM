// fenam-database.js
// Database service specifically for FENAM operations

class FenamDatabase {
  constructor(pool, debugLog) {
    this.pool = pool;
    this.debugLog = debugLog;
  }

  // Register or get user
  async registerUser(phoneNumber, name = null) {
    const sql = "INSERT INTO fenam_users (phone_number, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = COALESCE(VALUES(name), name)";
    try {
      await this.pool.query(sql, [phoneNumber, name]);
      this.debugLog(`FENAM user registered/updated: ${phoneNumber}`, { name });
      return true;
    } catch (error) {
      this.debugLog('Error registering FENAM user', { error: error.message, phoneNumber });
      return false;
    }
  }

  // Update user name
  async updateUserName(phoneNumber, name) {
    const sql = "UPDATE fenam_users SET name = ? WHERE phone_number = ?";
    try {
      await this.pool.query(sql, [name, phoneNumber]);
      this.debugLog(`FENAM user name updated: ${phoneNumber}`, { name });
      return true;
    } catch (error) {
      this.debugLog('Error updating FENAM user name', { error: error.message, phoneNumber });
      return false;
    }
  }

  // Get user by phone number
  async getUser(phoneNumber) {
    const sql = "SELECT * FROM fenam_users WHERE phone_number = ?";
    try {
      const [rows] = await this.pool.query(sql, [phoneNumber]);
      return rows.length > 0 ? rows[0] : null;
    } catch (error) {
      this.debugLog('Error fetching FENAM user', { error: error.message, phoneNumber });
      return null;
    }
  }

  // Get or create conversation state
  async getConversationState(phoneNumber) {
    const sql = "SELECT * FROM fenam_conversation_state WHERE phone_number = ?";
    try {
      const [rows] = await this.pool.query(sql, [phoneNumber]);
      if (rows.length > 0) {
        // Parse JSON fields
        const state = rows[0];
        if (state.pending_addresses) {
          state.pending_addresses = JSON.parse(state.pending_addresses);
        }
        if (state.provider_list) {
          state.provider_list = JSON.parse(state.provider_list);
        }
        return state;
      }
      return null;
    } catch (error) {
      this.debugLog('Error fetching conversation state', { error: error.message, phoneNumber });
      return null;
    }
  }

  // Initialize conversation state for new user
  async initializeConversationState(phoneNumber) {
    const sql = "INSERT INTO fenam_conversation_state (phone_number, current_step) VALUES (?, 'awaiting_location') ON DUPLICATE KEY UPDATE current_step = 'awaiting_location', last_updated = NOW()";
    try {
      await this.pool.query(sql, [phoneNumber]);
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

    // Build dynamic SQL based on what fields are being updated
    if (updates.current_step !== undefined) {
      fields.push('current_step = ?');
      values.push(updates.current_step);
    }
    if (updates.user_latitude !== undefined) {
      fields.push('user_latitude = ?');
      values.push(updates.user_latitude);
    }
    if (updates.user_longitude !== undefined) {
      fields.push('user_longitude = ?');
      values.push(updates.user_longitude);
    }
    if (updates.user_address !== undefined) {
      fields.push('user_address = ?');
      values.push(updates.user_address);
    }
    if (updates.service_type !== undefined) {
      fields.push('service_type = ?');
      values.push(updates.service_type);
    }
    if (updates.pending_addresses !== undefined) {
      fields.push('pending_addresses = ?');
      values.push(JSON.stringify(updates.pending_addresses));
    }
    if (updates.provider_list !== undefined) {
      fields.push('provider_list = ?');
      values.push(JSON.stringify(updates.provider_list));
    }

    if (fields.length === 0) {
      this.debugLog('No fields to update in conversation state');
      return false;
    }

    values.push(phoneNumber);
    const sql = `UPDATE fenam_conversation_state SET ${fields.join(', ')} WHERE phone_number = ?`;

    try {
      await this.pool.query(sql, values);
      this.debugLog(`Conversation state updated for ${phoneNumber}`, updates);
      return true;
    } catch (error) {
      this.debugLog('Error updating conversation state', { error: error.message, phoneNumber });
      return false;
    }
  }

  // Reset conversation state (for starting over) - preserves location
  async resetConversationState(phoneNumber, preserveLocation = true) {
    let sql;
    if (preserveLocation) {
      // Keep location data, reset everything else
      sql = "UPDATE fenam_conversation_state SET current_step = 'awaiting_service_type', service_type = NULL, pending_addresses = NULL, provider_list = NULL WHERE phone_number = ?";
    } else {
      // Reset everything including location
      sql = "UPDATE fenam_conversation_state SET current_step = 'awaiting_location', user_latitude = NULL, user_longitude = NULL, user_address = NULL, service_type = NULL, pending_addresses = NULL, provider_list = NULL WHERE phone_number = ?";
    }
    try {
      await this.pool.query(sql, [phoneNumber]);
      this.debugLog(`Conversation state reset for ${phoneNumber}`, { preserveLocation });
      return true;
    } catch (error) {
      this.debugLog('Error resetting conversation state', { error: error.message, phoneNumber });
      return false;
    }
  }
}

module.exports = FenamDatabase;
