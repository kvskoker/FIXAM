const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// How long a log file is kept before the sweep removes it. Logs are for
// diagnosing what happened this week, not a second copy of the database, so
// this is deliberately shorter than the 90 days message history is kept for.
const RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS || 30);

// Phone numbers are pseudonymised rather than blanked. A support case is
// usually "this person's report went wrong" -- you have to be able to follow one
// conversation through the file to answer it. A stable tag does that; the raw
// number does it *and* turns every log file into a contact list.
//
// Keyed with the same secret as the rest of the platform, so the tag cannot be
// reversed by anyone who only has the log file.
const PSEUDONYM_SECRET = process.env.SESSION_SECRET || process.env.OTP_SECRET || 'fixam-log-pseudonym';

/**
 * The configured country's calling code, read lazily so the logger works even
 * when it is required before the environment is loaded. A local "0…" number is
 * normalised to this prefix, so the same person written "076…" and "23276…"
 * ends up with one tag.
 */
let _dialCode = null;
function dialCode() {
    if (_dialCode === null) {
        try {
            _dialCode = require('./countries').getServiceArea().dialCode;
        } catch (err) {
            _dialCode = '232';
        }
    }
    return _dialCode;
}

/**
 * Logs carry numbers typed in local format, with a country code, and embedded
 * in JSON. The pattern is deliberately broad: over-tagging a long digit string
 * is harmless, letting a real number through is not.
 */
const PHONE_PATTERN = /(?:\+\d{1,4}|0)?[0-9]{8,14}/g;

function pseudonym(value) {
    return 'p:' + crypto.createHmac('sha256', PSEUDONYM_SECRET)
        .update(String(value))
        .digest('hex')
        .slice(0, 10);
}

/**
 * Replace anything that looks like a phone number with its stable tag.
 *
 * Timestamps, coordinates and IDs are left alone -- they are matched only if
 * they are a bare run of 8+ digits, which those are not once formatted.
 */
function redact(text) {
    return String(text).replace(PHONE_PATTERN, (match) => {
        // Digits only, so the same number written +23276..., 23276... and
        // 076... all reduce to one tag and a conversation stays followable.
        const digits = match.replace(/\D/g, '');
        if (digits.length < 8) return match;
        return pseudonym(digits.replace(/^0/, dialCode()));
    });
}

/**
 * Split a log file into whole entries.
 *
 * An entry starts at a `[timestamp]` at the beginning of a line and runs until
 * the next one, so a logged JSON object counts as one thing. Purging by *line*
 * looked right and was not: it removed the line holding the phone number and
 * left the rest of the object behind, so the citizen's message survived an
 * erasure that reported success.
 */
function splitRecords(contents) {
    const records = [];
    let current = '';
    for (const line of contents.split(/(?<=\n)/)) {
        if (/^\[\d{4}-\d{2}-\d{2}T/.test(line) && current) {
            records.push(current);
            current = line;
        } else {
            current += line;
        }
    }
    if (current) records.push(current);
    return records;
}

class Logger {
    constructor(logDir = path.join(__dirname, '../logs')) {
        this.logDir = logDir;
        this.ensureLogDir();

        // Writes are queued and flushed off the event loop. appendFileSync on
        // every inbound message meant the server stopped serving requests while
        // the disk caught up -- under load that is the whole process blocked on
        // logging, which is the one thing logging must never cost.
        this.queue = [];
        this.flushing = null;
    }

    ensureLogDir() {
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }

    getLogFilePath(filename) {
        const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        return path.join(this.logDir, `${filename}_${date}.log`);
    }

    /** Queue a line and return immediately. */
    write(logPath, logMessage) {
        this.queue.push({ logPath, logMessage });
        this.flush();
    }

    /**
     * Drain the queue. Returns the in-flight drain if one is already running,
     * so `await flush()` genuinely means "everything queued is now on disk" --
     * returning early would make the purge below read a file that is still
     * missing the lines it is meant to remove.
     */
    flush() {
        if (this.flushing) return this.flushing;
        this.flushing = this.drain().finally(() => { this.flushing = null; });
        return this.flushing;
    }

    async drain() {
        while (this.queue.length > 0) {
            // Drained in one pass per file so a busy minute costs a handful of
            // appends rather than one per line.
            const batch = this.queue;
            this.queue = [];
            const byFile = new Map();
            for (const { logPath, logMessage } of batch) {
                byFile.set(logPath, (byFile.get(logPath) || '') + logMessage);
            }
            for (const [logPath, chunk] of byFile) {
                try {
                    await fsp.appendFile(logPath, chunk);
                } catch (error) {
                    console.error('Failed to write to log file:', error);
                }
            }
        }
    }

    log(filename, message) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${redact(message)}\n`;
        console.log(logMessage.trim());
        this.write(this.getLogFilePath(filename), logMessage);
    }

    logObject(filename, label, obj) {
        const timestamp = new Date().toISOString();
        const body = redact(JSON.stringify(obj, null, 2));
        const logMessage = `[${timestamp}] ${redact(label)}:\n${body}\n`;
        console.log(logMessage.trim());
        this.write(this.getLogFilePath(filename), logMessage);
    }

    logError(filename, message, error) {
        const timestamp = new Date().toISOString();
        const errorDetails = error.response
            ? JSON.stringify(error.response.data, null, 2)
            : error.message;
        const logMessage = `[${timestamp}] ERROR: ${redact(message)}\n${redact(errorDetails)}\n`;
        console.error(logMessage.trim());
        this.write(this.getLogFilePath(filename), logMessage);
    }

    /**
     * Delete log files older than the retention period.
     *
     * Files are already one-per-day, so rotation is just removal -- there is no
     * live handle to reopen and nothing to rename.
     */
    async purgeExpired(retentionDays = RETENTION_DAYS) {
        const cutoff = Date.now() - retentionDays * 86400000;
        let removed = 0;
        try {
            const entries = await fsp.readdir(this.logDir);
            for (const entry of entries) {
                if (!entry.endsWith('.log')) continue;
                const full = path.join(this.logDir, entry);
                try {
                    const stat = await fsp.stat(full);
                    if (stat.mtimeMs < cutoff) {
                        await fsp.unlink(full);
                        removed++;
                    }
                } catch {
                    // Vanished between listing and stat -- nothing to do.
                }
            }
        } catch (error) {
            console.error('Log purge failed:', error.message);
        }
        return removed;
    }

    /**
     * Remove every line belonging to one person, for "delete my data".
     *
     * The promise made to the citizen is that their data is erased, and until
     * now that was true of the database and false of the disk. Lines are matched
     * on the pseudonym, which is what the number was replaced with on the way in.
     */
    async purgeSubject(phoneNumber) {
        await this.flush();

        const digits = String(phoneNumber).replace(/\D/g, '').replace(/^0/, dialCode());
        const tag = pseudonym(digits);
        // Also matched raw, in case the file predates redaction.
        const raw = String(phoneNumber).replace(/\D/g, '');
        let removed = 0;

        let entries = [];
        try {
            entries = await fsp.readdir(this.logDir);
        } catch (error) {
            console.error('Log purge failed:', error.message);
            return 0;
        }

        for (const entry of entries) {
            if (!entry.endsWith('.log')) continue;
            const full = path.join(this.logDir, entry);
            try {
                const contents = await fsp.readFile(full, 'utf8');
                if (!contents.includes(tag) && !(raw.length >= 8 && contents.includes(raw))) {
                    continue;
                }

                const kept = splitRecords(contents).filter((record) => {
                    const hit = record.includes(tag)
                        || (raw.length >= 8 && record.includes(raw));
                    if (hit) removed++;
                    return !hit;
                });
                await fsp.writeFile(full, kept.join(''));
            } catch (error) {
                console.error(`Log purge failed for ${entry}:`, error.message);
            }
        }

        return removed;
    }
}

const logger = new Logger();

module.exports = logger;
module.exports.redact = redact;
module.exports.pseudonym = pseudonym;
module.exports.Logger = Logger; // for tests against a throwaway directory
