const fs = require('fs');
const { Pool } = require('pg');
require('../loadEnv');

/**
 * Database connection.
 *
 * TLS is opt-in through DB_SSL, because it has to match how the server was
 * started: asking for an encrypted connection from a server that does not offer
 * one fails outright, and silently accepting either would defeat the point of
 * having asked.
 *
 * DB_SSL_CA points at the certificate authority when one is available. Without
 * it the connection is still encrypted but the server's identity is not
 * verified -- which is the honest position for the self-signed certificate the
 * bundled Postgres image generates, and is why a real deployment should supply
 * a CA rather than rely on the default.
 */
function sslConfig() {
    const enabled = String(process.env.DB_SSL || '').toLowerCase() === 'true';
    if (!enabled) return false;

    const caPath = process.env.DB_SSL_CA;
    if (caPath && fs.existsSync(caPath)) {
        return { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
    }

    if (caPath) {
        console.warn(`DB_SSL_CA is set to ${caPath} but no file is there; `
            + 'connecting encrypted without verifying the server certificate.');
    }
    return { rejectUnauthorized: false };
}

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: sslConfig(),
});

/**
 * An idle connection dropping is not a reason to stop serving.
 *
 * node-postgres emits 'error' on pooled clients that fail while idle -- most
 * often because the database restarted underneath them. Unhandled, that event
 * throws and takes the whole process down: a routine database restart killed
 * the simulator outright and it stayed dead. The pool discards the broken
 * client and makes a new one on the next query, so the right response is to
 * note it and carry on.
 */
pool.on('error', (err) => {
    console.error('Idle database client error (the pool will reconnect):', err.message);
});

module.exports = pool;
