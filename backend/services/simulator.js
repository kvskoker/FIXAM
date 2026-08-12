/**
 * Simulator integration.
 *
 * The WhatsApp simulator (see ../../simulator) drives the real FixamHandler with
 * synthetic webhook payloads so the chatbot can be exercised without Meta's API.
 * Two things have to be true for that to be useful:
 *
 *   1. The handler must recognise a simulated payload, so the checks that exist
 *      to keep strangers out of the real bot (phone number ID match, DEV_MODE
 *      maintenance gate) do not silently swallow every simulated message.
 *   2. Messages the backend sends outside the simulator's own process -- the
 *      admin status updates in routes/api.js -- must be mirrored back into the
 *      simulator UI, otherwise "citizen reports, admin updates, citizen is
 *      notified" cannot be tested end to end.
 *
 * Both are strictly development features. `isEnabled()` is the single gate:
 * without SIMULATOR_ENABLED=true, or in production, a payload claiming to be
 * from the simulator is treated as any other unrecognised webhook.
 */

const axios = require('axios');

// Placed in webhook metadata.phone_number_id by the simulator. It deliberately
// is not a valid Meta phone number ID so it can never collide with a real one.
const SIMULATOR_PHONE_NUMBER_ID = 'fixam-simulator';

/**
 * Is simulator support switched on for this process?
 * Never true in production, regardless of SIMULATOR_ENABLED.
 */
function isEnabled() {
    return process.env.SIMULATOR_ENABLED === 'true' && process.env.NODE_ENV !== 'production';
}

/**
 * Does this webhook payload come from the simulator?
 * Always false when simulator support is off, so the normal security checks
 * apply to anything that merely claims to be simulated.
 *
 * @param {object} data - Raw webhook body.
 * @returns {boolean}
 */
function isSimulatedPayload(data) {
    if (!isEnabled()) return false;
    if (!data || typeof data !== 'object') return false;

    if (data.simulator === true) return true;

    const metadata = data.entry?.[0]?.changes?.[0]?.value?.metadata;
    return metadata?.phone_number_id === SIMULATOR_PHONE_NUMBER_ID;
}

/**
 * Base URL of a running simulator, or null when none is configured.
 */
function getUrl() {
    if (!isEnabled()) return null;
    const url = process.env.SIMULATOR_URL || 'http://localhost:4001';
    return url.replace(/\/+$/, '');
}

/**
 * Mirror an outgoing WhatsApp message into the simulator chat window.
 *
 * Used for messages produced outside the simulator's own process (admin status
 * changes, group alerts). Failures are swallowed: the simulator not running is
 * the normal case, and a dev tool must never break a real send path.
 *
 * The return value distinguishes "the simulator owns this number" from "the
 * simulator merely queued it". Only the former suppresses the real send, so a
 * running simulator never intercepts messages meant for a real tester's phone.
 *
 * @param {string} to - Recipient phone number.
 * @param {string} body - Message text.
 * @returns {Promise<boolean>} true when the recipient is a simulated number.
 */
// When no simulator is listening, stop retrying for a while: a group alert
// fans out to every member, and a per-message timeout would be felt.
const UNREACHABLE_BACKOFF_MS = 30000;
let unreachableUntil = 0;

async function forwardMessage(to, body) {
    const url = getUrl();
    if (!url) return false;
    if (Date.now() < unreachableUntil) return false;

    try {
        const res = await axios.post(
            `${url}/simulate/notify`,
            { phone_number: to, message: body, type: 'admin' },
            { timeout: 2000 }
        );
        unreachableUntil = 0;
        return res.data?.accepted === true;
    } catch (err) {
        // Simulator offline, or not listening yet -- nothing to do.
        unreachableUntil = Date.now() + UNREACHABLE_BACKOFF_MS;
        return false;
    }
}

module.exports = {
    SIMULATOR_PHONE_NUMBER_ID,
    isEnabled,
    isSimulatedPayload,
    getUrl,
    forwardMessage,
};
