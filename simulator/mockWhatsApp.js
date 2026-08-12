const EventEmitter = require('events');
const fs = require('fs');

/**
 * Stand-in for backend/services/whatsappService. The handler only ever calls
 * sendMessage() and downloadMedia() on it, so nothing reaches Meta's API.
 */
class MockWhatsAppService extends EventEmitter {
    /**
     * @param {object} [options]
     * @param {string} [options.knownPhonesFile] - Where to remember which numbers
     *   belong to the simulator. This has to survive a restart: the backend asks
     *   before deciding whether a message may go out over the real WhatsApp API,
     *   and a number that has been simulated once must never be answered "no".
     * @param {string[]} [options.seedPhones] - Numbers to treat as simulated from
     *   the start, e.g. the configured default.
     */
    constructor(options = {}) {
        super();
        this.pendingResponses = [];
        this.messageLog = [];
        this.currentPhone = null;
        this._mediaRegistry = new Map();
        this._notifications = new Map();
        this._knownPhonesFile = options.knownPhonesFile || null;
        this._knownPhones = new Set(this._loadKnownPhones());
        (options.seedPhones || []).filter(Boolean).forEach((p) => this._rememberPhone(p));
    }

    _loadKnownPhones() {
        if (!this._knownPhonesFile || !fs.existsSync(this._knownPhonesFile)) return [];
        try {
            const parsed = JSON.parse(fs.readFileSync(this._knownPhonesFile, 'utf8'));
            return Array.isArray(parsed) ? parsed : [];
        } catch (err) {
            console.warn(`  [sim] Could not read ${this._knownPhonesFile}: ${err.message}`);
            return [];
        }
    }

    _rememberPhone(phoneNumber) {
        if (this._knownPhones.has(phoneNumber)) return;
        this._knownPhones.add(phoneNumber);
        if (!this._knownPhonesFile) return;
        try {
            fs.writeFileSync(this._knownPhonesFile, JSON.stringify([...this._knownPhones], null, 2));
        } catch (err) {
            console.warn(`  [sim] Could not persist known phone numbers: ${err.message}`);
        }
    }

    /**
     * Begin collecting the bot's replies to one incoming message.
     * @param {string} phoneNumber - Who sent it; replies to anyone else are
     *   treated as side-channel alerts rather than part of this conversation.
     */
    startCapture(phoneNumber) {
        this.pendingResponses = [];
        this.currentPhone = phoneNumber || null;
        if (phoneNumber) this._rememberPhone(phoneNumber);
    }

    getResponses() {
        return [...this.pendingResponses];
    }

    /** Has this number ever been used in this simulator session? */
    isKnownPhone(phoneNumber) {
        return this._knownPhones.has(phoneNumber);
    }

    registerFile(id, buffer, mimeType) {
        this._mediaRegistry.set(id, { buffer, mimeType });
    }

    pushNotification(phoneNumber, body, type = 'system') {
        const notification = {
            id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            body,
            type,
            timestamp: new Date().toISOString(),
        };
        if (!this._notifications.has(phoneNumber)) {
            this._notifications.set(phoneNumber, []);
        }
        this._notifications.get(phoneNumber).push(notification);
        this.emit('notification', { phoneNumber, notification });
    }

    getNotifications(phoneNumber, since) {
        const all = this._notifications.get(phoneNumber) || [];
        if (!since) return all;
        const sinceDate = new Date(since);
        return all.filter((n) => new Date(n.timestamp) > sinceDate);
    }

    /**
     * Timestamp of the most recent notification held for a number, or null.
     *
     * Notifications live in memory for the life of the process, so a page that
     * starts polling from nothing replays every one of them. The browser reads
     * this first and polls from there, which keeps a refresh quiet without
     * discarding anything -- a different tab, or a reload after new activity,
     * still sees whatever arrived after its own cursor.
     */
    getLatestNotificationTimestamp(phoneNumber) {
        const all = this._notifications.get(phoneNumber) || [];
        return all.length > 0 ? all[all.length - 1].timestamp : null;
    }

    async sendMessage(to, body) {
        const msg = {
            to,
            body,
            direction: 'outgoing',
            timestamp: new Date().toISOString(),
        };
        this.messageLog.push(msg);

        if (this.currentPhone && to !== this.currentPhone) {
            // A group alert or a notification aimed at someone else in the same
            // turn. Queue it against that number so it appears if the tester
            // switches to it, instead of leaking into the current chat.
            this.pushNotification(to, body, 'alert');
        } else {
            this.pendingResponses.push(msg);
        }

        this.emit('message', msg);
    }

    async downloadMedia(mediaId) {
        if (this._mediaRegistry.has(mediaId)) {
            const entry = this._mediaRegistry.get(mediaId);
            this._mediaRegistry.delete(mediaId);
            return { buffer: entry.buffer, mimeType: entry.mimeType };
        }
        return null;
    }
}

module.exports = MockWhatsAppService;
