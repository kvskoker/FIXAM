const messagesEl = document.getElementById('messages');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const phoneInput = document.getElementById('phoneInput');
const phoneApplyBtn = document.getElementById('phoneApplyBtn');
const statusEl = document.getElementById('status');
const attachBtn = document.getElementById('attachBtn');
const attachMenu = document.getElementById('attachMenu');
const locationModal = document.getElementById('locationModal');
const locLat = document.getElementById('locLat');
const locLng = document.getElementById('locLng');
const adminModal = document.getElementById('adminModal');
const adminIssue = document.getElementById('adminIssue');
const adminStatus = document.getElementById('adminStatus');
const adminNote = document.getElementById('adminNote');
const fileInput = document.getElementById('fileInput');
const audioInput = document.getElementById('audioInput');
const videoInput = document.getElementById('videoInput');
const documentInput = document.getElementById('documentInput');

let isSending = false;

// The number the simulator is actually driving. The input field is only a
// draft until "Use number" is pressed, so that editing it mid-conversation
// cannot silently send the next message as somebody else.
let activePhone = '';

// The country's phone rules, fetched from /config at boot. Defaults are Sierra
// Leone; the server overwrites them when another country is configured.
let phoneDialCode = '232';
let phoneDigits = 11;
let countryName = 'Sierra Leone';

attachBtn.addEventListener('click', () => {
    attachMenu.classList.toggle('open');
    attachBtn.classList.toggle('active');
});

document.addEventListener('click', (e) => {
    if (!attachBtn.contains(e.target) && !attachMenu.contains(e.target)) {
        attachMenu.classList.remove('open');
        attachBtn.classList.remove('active');
    }
});

attachMenu.addEventListener('click', (e) => {
    const action = e.target.dataset.action;
    if (!action) return;
    attachMenu.classList.remove('open');
    attachBtn.classList.remove('active');

    switch (action) {
        case 'image': fileInput.click(); break;
        case 'audio': audioInput.click(); break;
        case 'video': videoInput.click(); break;
        case 'document': documentInput.click(); break;
        case 'location': openLocationModal(); break;
        case 'admin': openAdminModal(); break;
        case 'new-user': simulateNewUser(); break;
        case 'reset': resetConversation(); break;
    }
});

fileInput.addEventListener('change', () => handleFileUpload(fileInput, 'image'));
audioInput.addEventListener('change', () => handleFileUpload(audioInput, 'audio'));
videoInput.addEventListener('change', () => handleFileUpload(videoInput, 'video'));
documentInput.addEventListener('change', () => handleFileUpload(documentInput, 'document'));

messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

function openLocationModal() {
    locationModal.style.display = 'flex';
    locLat.focus();
}

document.getElementById('locCancel').addEventListener('click', () => {
    locationModal.style.display = 'none';
});

document.getElementById('locSend').addEventListener('click', () => {
    locationModal.style.display = 'none';
    sendLocation(parseFloat(locLat.value), parseFloat(locLng.value));
});

locLat.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') locLng.focus();
});
locLng.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        locationModal.style.display = 'none';
        sendLocation(parseFloat(locLat.value), parseFloat(locLng.value));
    }
});

function getPhone() {
    return activePhone;
}

// ── Switching the number being simulated ────────────────────────────────────

/** The country's digits, or null when the text is not a valid number. */
function normalizedDigits(raw) {
    const digits = String(raw || '').replace(/[^\d]/g, '').replace(/^00/, '');
    if (!digits.startsWith(phoneDialCode)) return null;
    if (digits.length !== phoneDigits) return null;
    return digits;
}

/** The human error line for an invalid number, so it is written once. */
function invalidNumberText() {
    return `❌ Invalid number. ${countryName} numbers are ${phoneDigits} digits — "${phoneDialCode}" then ${phoneDigits - phoneDialCode.length} (e.g. ${phoneDialCode}${'0'.repeat(phoneDigits - phoneDialCode.length)}).`;
}

/**
 * Adopt the number in the input field: reload that user's conversation and
 * start notifications from now, so the window shows their chat and nothing
 * else. The server normalises the number and returns the form it used, which
 * keeps the country rules in one place rather than duplicated here.
 */
async function switchToPhone(raw) {
    const requested = String(raw || '').trim();
    if (!requested) return;

    const digits = normalizedDigits(requested);
    if (!digits) {
        addMessage(invalidNumberText(), 'incoming');
        return;
    }

    phoneApplyBtn.disabled = true;
    try {
        const res = await fetch('/simulate/history?phone=' + encodeURIComponent(requested));
        const data = await res.json();

        activePhone = data.phone || requested;
        phoneInput.value = activePhone;

        clearMessages();
        renderHistory(data.messages || []);

        // Anything already delivered to this number belongs to the history we
        // just drew (or to a session before this one); poll from here.
        await primeNotificationCursor();
    } catch (err) {
        addMessage('❌ Could not load history for ' + requested + ': ' + err.message, 'incoming');
    } finally {
        phoneApplyBtn.disabled = false;
        updatePhoneButton();
    }
}

/**
 * Reflect whether the typed number differs from the one in use, and keep the
 * button disabled until it is a valid number for the configured country.
 */
function updatePhoneButton() {
    const typed = phoneInput.value.trim();
    const digits = normalizedDigits(typed);

    if (!digits) {
        phoneApplyBtn.disabled = true;
        phoneApplyBtn.classList.remove('pending');
        phoneApplyBtn.textContent = typed ? 'Invalid number' : 'Use number';
        phoneApplyBtn.title = typed
            ? `${countryName} numbers are ${phoneDigits} digits — "${phoneDialCode}" then ${phoneDigits - phoneDialCode.length}.`
            : 'Enter a number to simulate';
        return;
    }

    const pending = digits !== activePhone;
    phoneApplyBtn.disabled = false;
    phoneApplyBtn.classList.toggle('pending', pending);
    phoneApplyBtn.textContent = pending ? 'Change number' : 'Use number';
    phoneApplyBtn.title = pending
        ? 'Switch the simulator to ' + digits
        : 'Reload the conversation for ' + (activePhone || 'this number');
}

phoneApplyBtn.addEventListener('click', () => switchToPhone(phoneInput.value));
phoneInput.addEventListener('input', updatePhoneButton);
phoneInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        switchToPhone(phoneInput.value);
    }
});

function clearMessages() {
    messagesEl.innerHTML =
        '<div class="empty-state">'
        + '<div class="empty-icon">💬</div>'
        + '<div>No messages yet for ' + escapeHtml(activePhone) + '</div>'
        + '<div class="empty-hint">Type a message or use the + button to upload images, audio, or share location</div>'
        + '</div>';
}

/**
 * Draw stored messages. `direction` in the log is the bot's view of the world,
 * so an "incoming" row is what the citizen typed and belongs on the right.
 */
function renderHistory(messages) {
    for (const m of messages) {
        const mine = m.direction === 'incoming';
        let body = m.message_body || '';
        if (m.message_type && m.message_type !== 'text' && body === m.message_type) {
            const icons = { image: '🖼', video: '🎥', audio: '🎙', voice: '🎙', location: '📍' };
            body = (icons[m.message_type] || '📎') + ' ' + m.message_type;
        }
        addMessage(body, mine ? 'outgoing' : 'incoming', formatTime(m.created_at));
    }
}

function addMessage(text, direction, meta) {
    const empty = messagesEl.querySelector('.empty-state');
    if (empty) empty.remove();

    const div = document.createElement('div');
    div.className = 'message ' + direction;
    div.innerHTML = formatWhatsAppText(text);
    div.style.whiteSpace = 'pre-wrap';

    if (meta) {
        const metaDiv = document.createElement('div');
        metaDiv.className = 'message-meta';
        metaDiv.textContent = meta;
        div.appendChild(metaDiv);
    }

    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function formatWhatsAppText(text) {
    return escapeHtml(text)
        .replace(/\*(.+?)\*/g, '<strong>$1</strong>')
        .replace(/_(.+?)_/g, '<em>$1</em>')
        .replace(/~(.+?)~/g, '<del>$1</del>')
        .replace(/\n/g, '<br>');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function addTyping() {
    const empty = messagesEl.querySelector('.empty-state');
    if (empty) empty.remove();

    const div = document.createElement('div');
    div.className = 'typing';
    div.id = 'typing-indicator';
    div.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function removeTyping() {
    const el = document.getElementById('typing-indicator');
    if (el) el.remove();
}

async function handleFileUpload(inputElement, mediaType) {
    const file = inputElement.files[0];
    if (!file) { inputElement.value = ''; return; }

    if (isSending) { inputElement.value = ''; return; }
    isSending = true;
    sendBtn.disabled = true;

    const labels = { image: 'Photo', audio: 'Voice Note', video: 'Video', document: 'Document' };
    const label = labels[mediaType] || mediaType;
    addMessage('\uD83D\uDCCE Uploading ' + label + ': ' + file.name + '...', 'outgoing');

    try {
        const formData = new FormData();
        formData.append('file', file);

        const uploadRes = await fetch('/simulate/upload', { method: 'POST', body: formData });
        const uploadData = await uploadRes.json();

        if (!uploadData.success) {
            addMessage('\u274C Upload failed: ' + (uploadData.error || 'unknown'), 'incoming');
            isSending = false;
            sendBtn.disabled = false;
            inputElement.value = '';
            return;
        }

        addMessage('\u2705 Uploaded: ' + file.name, 'outgoing');
        const typingEl = document.getElementById('typing-indicator') || addTyping();

        const simRes = await fetch('/simulate/media', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                phone_number: getPhone(),
                media_id: uploadData.media_id,
                media_type: mediaType === 'audio' ? 'audio' : mediaType,
            }),
        });
        const simData = await simRes.json();
        removeTyping();
        handleResponses(simData);
    } catch (err) {
        removeTyping();
        addMessage('Network error: ' + err.message, 'incoming');
    } finally {
        isSending = false;
        sendBtn.disabled = false;
        inputElement.value = '';
    }
}

async function sendMessage(textOverride) {
    if (isSending) return;
    const text = textOverride || messageInput.value.trim();
    if (!text) return;

    isSending = true;
    sendBtn.disabled = true;
    addMessage(text, 'outgoing');
    const typingEl = document.getElementById('typing-indicator') || addTyping();

    try {
        const res = await fetch('/simulate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                phone_number: getPhone(),
                message: text,
                message_type: 'text',
            }),
        });
        const data = await res.json();
        removeTyping();
        handleResponses(data);
    } catch (err) {
        removeTyping();
        addMessage('Network error: ' + err.message, 'incoming');
    } finally {
        isSending = false;
        sendBtn.disabled = false;
        messageInput.value = '';
        messageInput.focus();
    }
}

function handleResponses(data) {
    if (!data.success) {
        addMessage('\u274C ' + (data.error || 'Unknown error'), 'incoming');
        if (data.responses && data.responses.length > 0) {
            data.responses.forEach((r) => addMessage(r.body, 'incoming', formatTime(r.timestamp)));
        }
        return;
    }
    if (!data.responses || data.responses.length === 0) {
        addMessage('(no response)', 'incoming');
        return;
    }
    data.responses.forEach((r, i) => {
        addMessage(r.body, 'incoming', i === 0 ? formatTime(r.timestamp) : '');
    });
}

function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function sendLocation(lat, lng) {
    if (isSending) return;
    isSending = true;
    sendBtn.disabled = true;
    addMessage('\uD83D\uDCCD Location: ' + lat.toFixed(4) + ', ' + lng.toFixed(4), 'outgoing');
    const typingEl = document.getElementById('typing-indicator') || addTyping();

    try {
        const res = await fetch('/simulate/location', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone_number: getPhone(), latitude: lat, longitude: lng }),
        });
        const data = await res.json();
        removeTyping();
        handleResponses(data);
    } catch (err) {
        removeTyping();
        addMessage('Network error: ' + err.message, 'incoming');
    } finally {
        isSending = false;
        sendBtn.disabled = false;
    }
}

async function simulateNewUser() {
    const newPhone = '232' + Math.floor(70000000 + Math.random() * 30000000);
    phoneInput.value = newPhone;
    await switchToPhone(newPhone);
    addMessage('\uD83D\uDD04 New user: ' + newPhone, 'incoming');
    messageInput.value = 'hi';
    messageInput.focus();
}

async function resetConversation() {
    try {
        const res = await fetch('/simulate/reset-state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone_number: getPhone() }),
        });
        const data = await res.json();
        if (data.success) {
            addMessage('\uD83E\uDDF9 Conversation state cleared for ' + getPhone() + '. Say "Hi" to start again.', 'incoming');
        } else {
            addMessage('\u274C Reset failed: ' + (data.error || 'unknown'), 'incoming');
        }
    } catch (err) {
        addMessage('Network error: ' + err.message, 'incoming');
    }
}

let lastNotificationTs = null;
let knownNotificationIds = new Set();

/**
 * Start polling from the newest notification the server already holds.
 *
 * Without this a refresh re-renders every notification ever pushed to the
 * number -- the admin updates and bonus-point messages reappear as though they
 * had just arrived.
 */
async function primeNotificationCursor() {
    knownNotificationIds = new Set();
    lastNotificationTs = null;
    try {
        const res = await fetch('/simulate/notifications/cursor?phone=' + encodeURIComponent(getPhone()));
        const data = await res.json();
        lastNotificationTs = data.last_timestamp || null;
    } catch (_) {
        // Leaving the cursor null only risks replaying; it never drops a message.
    }
}

async function pollNotifications() {
    const phone = getPhone();
    if (!phone) return;

    try {
        const params = new URLSearchParams({ phone });
        if (lastNotificationTs) params.set('since', lastNotificationTs);

        const res = await fetch('/simulate/notifications?' + params.toString());
        const data = await res.json();

        // A switch may have landed while this was in flight; those notifications
        // belong to the previous number's window, not this one.
        if (phone !== getPhone()) return;

        if (data.notifications && data.notifications.length > 0) {
            for (const n of data.notifications) {
                if (!knownNotificationIds.has(n.id)) {
                    knownNotificationIds.add(n.id);
                    const prefixes = { admin: '\uD83D\uDEE0 ', alert: '\uD83D\uDCE2 ' };
                    addMessage((prefixes[n.type] || '\uD83D\uDD14 ') + n.body, 'incoming', formatTime(n.timestamp));
                }
            }
            lastNotificationTs = data.last_timestamp;
        }
    } catch (_) {}
}

// \u2500\u2500 Admin side: change an issue's status and watch the citizen get notified \u2500\u2500

async function openAdminModal() {
    adminIssue.innerHTML = '<option value="">Loading\u2026</option>';
    adminModal.style.display = 'flex';

    try {
        const res = await fetch('/simulate/issues?phone=' + encodeURIComponent(getPhone()));
        const data = await res.json();

        if (!data.issues || data.issues.length === 0) {
            adminIssue.innerHTML = '<option value="">No issues reported by this number yet</option>';
            return;
        }

        adminIssue.innerHTML = data.issues
            .map((i) => `<option value="${i.ticket_id}">${i.ticket_id} \u2014 ${i.title} (${i.status})</option>`)
            .join('');
    } catch (err) {
        adminIssue.innerHTML = '<option value="">Failed to load issues</option>';
    }
}

document.getElementById('adminCancel').addEventListener('click', () => {
    adminModal.style.display = 'none';
});

document.getElementById('adminSend').addEventListener('click', async () => {
    const ticketId = adminIssue.value;
    if (!ticketId) return;

    adminModal.style.display = 'none';
    const status = adminStatus.value;
    const note = adminNote.value.trim();
    adminNote.value = '';

    addMessage('\uD83D\uDEE0 Admin sets ' + ticketId + ' to "' + status + '"\u2026', 'outgoing');

    try {
        const res = await fetch('/simulate/admin-update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticket_id: ticketId, status, note: note || null }),
        });
        const data = await res.json();
        if (!data.success) {
            addMessage('\u274C ' + (data.error || 'Update failed'), 'incoming');
            return;
        }
        // The citizen-facing notification arrives through the backend's WhatsApp
        // send path, which the simulator picks up in pollNotifications().
        pollNotifications();
    } catch (err) {
        addMessage('Network error: ' + err.message, 'incoming');
    }
});

async function checkStatus() {
    try {
        const res = await fetch('/status');
        const data = await res.json();
        const dbOk = data.database === 'connected';
        // Amber also covers "DB fine, but the bot will reject simulated messages"
        // -- otherwise that misconfiguration only shows up as odd replies.
        statusEl.style.color = dbOk && data.simulatorRecognised ? '#4caf50' : '#ff9800';
        statusEl.title = 'DB: ' + (dbOk ? 'Connected' : 'Disconnected')
            + ' | Bot recognises simulator: ' + (data.simulatorRecognised ? 'yes' : 'no (set SIMULATOR_ENABLED=true)');
    } catch (e) {
        statusEl.style.color = '#f44336';
    }
}

checkStatus();
setInterval(checkStatus, 10000);

(async function boot() {
    let defaultPhone = '23272123456';
    try {
        const cfg = await (await fetch('/config')).json();
        if (cfg.defaultPhone) defaultPhone = cfg.defaultPhone;
        if (cfg.phoneDialCode) phoneDialCode = cfg.phoneDialCode;
        if (cfg.phoneDigits) phoneDigits = cfg.phoneDigits;
        if (cfg.countryName) countryName = cfg.countryName;
    } catch (_) {}

    // Loads history and sets the notification cursor before polling starts.
    await switchToPhone(defaultPhone);
    setInterval(pollNotifications, 5000);
})();
