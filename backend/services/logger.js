const fs = require('fs');
const path = require('path');

class Logger {
    constructor(logDir = path.join(__dirname, '../logs')) {
        this.logDir = logDir;
        this.ensureLogDir();
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

    log(filename, message) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${message}\n`;
        const logPath = this.getLogFilePath(filename);
        
        try {
            fs.appendFileSync(logPath, logMessage);
            console.log(logMessage.trim()); // Also log to console
        } catch (error) {
            console.error('Failed to write to log file:', error);
        }
    }

    logObject(filename, label, obj) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${label}:\n${JSON.stringify(obj, null, 2)}\n`;
        const logPath = this.getLogFilePath(filename);
        
        try {
            fs.appendFileSync(logPath, logMessage);
            console.log(logMessage.trim());
        } catch (error) {
            console.error('Failed to write to log file:', error);
        }
    }

    logError(filename, message, error) {
        const timestamp = new Date().toISOString();
        const errorDetails = error.response ? JSON.stringify(error.response.data, null, 2) : error.message;
        const logMessage = `[${timestamp}] ERROR: ${message}\n${errorDetails}\n`;
        const logPath = this.getLogFilePath(filename);
        
        try {
            fs.appendFileSync(logPath, logMessage);
            console.error(logMessage.trim());
        } catch (err) {
            console.error('Failed to write to log file:', err);
        }
    }
}

module.exports = new Logger();
