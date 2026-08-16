// Authoring the questions the bot asks after a report is acknowledged.
//
// An institution writes its own questions and an administrator approves them
// before any citizen sees them. The editor's job is to make a good
// questionnaire easy to write; the server decides what may be saved, so nothing
// here is a security control.

let currentFlow = null;      // { flow, versions }
let editingVersion = null;   // the version open in the editor
let allCategories = [];
let allGroups = [];

const STATE_BADGES = {
    draft:             { label: 'Draft',            colour: 'var(--admin-text-muted)' },
    pending_review:    { label: 'Awaiting approval', colour: 'var(--admin-warning)' },
    changes_requested: { label: 'Changes requested', colour: 'var(--admin-danger)' },
    published:         { label: 'Live',             colour: 'var(--admin-success)' },
    archived:          { label: 'Replaced',         colour: 'var(--admin-text-muted)' }
};

document.addEventListener('DOMContentLoaded', () => {
    checkAuth(async () => {
        await loadCategoriesForFlows();
        loadFlows();
        refreshReviewBadge();

        document.getElementById('btn-new-flow').addEventListener('click', openNewFlowModal);
        document.getElementById('new-flow-form').addEventListener('submit', createFlow);
        document.getElementById('back-to-flows').addEventListener('click', (e) => {
            e.preventDefault();
            showList();
        });
        document.getElementById('btn-add-step').addEventListener('click', () => addStep());
        document.getElementById('btn-save-draft').addEventListener('click', saveDraft);
        document.getElementById('btn-submit-review').addEventListener('click', submitForReview);
        document.getElementById('btn-publish').addEventListener('click', publishVersion);
        document.getElementById('btn-request-changes').addEventListener('click', () => openFlowModal('review-modal'));
        document.getElementById('btn-test-send').addEventListener('click', () => openFlowModal('test-modal'));
        document.getElementById('btn-send-test').addEventListener('click', sendTest);
        document.getElementById('btn-send-review').addEventListener('click', sendReviewNote);
    });
});

function openFlowModal(id) { document.getElementById(id).classList.add('active'); }
function closeFlowModal(id) { document.getElementById(id).classList.remove('active'); }
window.closeFlowModal = closeFlowModal;

/** The count of questionnaires waiting on an administrator. */
async function refreshReviewBadge() {
    if (!isFullAdmin()) return;
    try {
        const res = await fetch(`${API_BASE_URL}/admin/bot-flows/pending-count`);
        if (!res.ok) return;
        const { count } = await res.json();
        const badge = document.getElementById('nav-review-badge');
        if (!badge) return;

        if (count > 0) {
            badge.textContent = count;
            badge.style.display = 'inline-block';
            badge.title = `${count} questionnaire${count === 1 ? '' : 's'} awaiting your approval`;
        } else {
            badge.style.display = 'none';
        }
    } catch (err) { /* the badge is a convenience, not a requirement */ }
}

async function loadCategoriesForFlows() {
    try {
        const [catRes, groupRes] = await Promise.all([
            fetch(`${API_BASE_URL}/categories`),
            fetch(`${API_BASE_URL}/admin/groups`)
        ]);
        if (catRes.ok) allCategories = await catRes.json();
        if (groupRes.ok) allGroups = await groupRes.json();
    } catch (err) {
        console.error('Could not load categories:', err);
    }
}

/** The institution that leads a category, which is who normally asks about it. */
function leadGroupForCategory(categoryName) {
    const lead = allGroups.find((g) => (g.categories || [])
        .some((c) => c.name === categoryName && c.role === 'lead'));
    if (lead) return lead;
    return allGroups.find((g) => (g.categories || []).some((c) => c.name === categoryName)) || null;
}

// ── List ─────────────────────────────────────────────────────────────────────

function showList() {
    document.getElementById('flows-view').style.display = 'block';
    document.getElementById('editor-view').style.display = 'none';
    loadFlows();
    refreshReviewBadge();
}

async function loadFlows() {
    const list = document.getElementById('flow-list');
    try {
        const res = await fetch(`${API_BASE_URL}/admin/bot-flows`);
        if (!res.ok) { renderLoadError('flow-list', 6, res.status); return; }

        const flows = await res.json();
        if (flows.length === 0) {
            // The empty state explains what this page is for. Someone arriving
            // here for the first time has no other way to find out.
            list.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 2.5rem; color: var(--admin-text-muted);">
                <i class="fa-solid fa-comment-dots" style="font-size: 1.75rem; opacity: 0.35; display: block; margin-bottom: 0.75rem;"></i>
                No questionnaires yet.<br>
                <span style="font-size: 0.87rem;">Reports in your categories are handled with the usual three questions.
                Add a questionnaire if your team needs more detail before it can act.</span>
            </td></tr>`;
            return;
        }

        list.innerHTML = flows.map((flow) => {
            const pending = parseInt(flow.awaiting_review, 10) > 0;
            const drafts = parseInt(flow.drafts, 10) > 0;

            const status = flow.live_version
                ? `<span style="color: var(--admin-success); font-weight: 600;">v${flow.live_version} live</span>`
                : '<span style="color: var(--admin-text-muted);">not live yet</span>';

            const note = pending
                ? '<div style="font-size: 0.75rem; color: var(--admin-warning);">awaiting approval</div>'
                : (drafts ? '<div style="font-size: 0.75rem; color: var(--admin-text-muted);">draft in progress</div>' : '');

            const sent = parseInt(flow.times_sent, 10);
            const done = parseInt(flow.times_completed, 10);
            // A completion rate is the honest measure of whether a questionnaire
            // is a reasonable thing to ask. It is shown whether or not it flatters.
            const rate = sent > 0
                ? `${done}/${sent} <span style="color: var(--admin-text-muted);">(${Math.round((done / sent) * 100)}%)</span>`
                : '<span style="color: var(--admin-text-muted);">not sent yet</span>';

            const off = flow.status !== 'active';

            // A switched-off questionnaire is still listed -- it is a thing you
            // may want to switch back on -- but it should not read as live.
            const stateCell = off
                ? `<span style="color: var(--admin-text-muted); font-weight: 600;">Stopped</span>
                   <div style="font-size: 0.75rem; color: var(--admin-text-muted);">not being asked</div>`
                : `${status}${note}`;

            // Deleting is only offered where nothing would be lost by it.
            const everUsed = sent > 0;

            return `<tr style="${off ? 'opacity: 0.62;' : ''}">
                <td data-label="Questionnaire"><strong>${flow.name}</strong>
                    ${flow.description ? `<div style="font-size: 0.78rem; color: var(--admin-text-muted);">${flow.description}</div>` : ''}</td>
                <td data-label="Applies to">${flow.category}</td>
                <td data-label="Institution">${flow.group_name || '—'}</td>
                <td data-label="Live version">${stateCell}</td>
                <td data-label="Sent / answered">${rate}</td>
                <td data-label="Actions" style="text-align: right; white-space: nowrap;">
                    <button class="action-btn" onclick="openFlow(${flow.id})" title="Open">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    ${off
                        ? `<button class="action-btn" onclick="setFlowStatus(${flow.id}, 'active')"
                                   title="Start asking these questions again" data-admin-only>
                             <i class="fa-solid fa-play"></i>
                           </button>`
                        : `<button class="action-btn" onclick="setFlowStatus(${flow.id}, 'inactive')"
                                   title="Stop asking these questions">
                             <i class="fa-solid fa-pause"></i>
                           </button>`}
                    <button class="action-btn ${everUsed ? '' : 'delete'}"
                            onclick="deleteFlow(${flow.id}, ${JSON.stringify(flow.name).replace(/"/g, '&quot;')}, ${sent})"
                            title="${everUsed ? 'Answered by citizens — deactivate instead' : 'Delete'}"
                            data-admin-only ${everUsed ? 'style="opacity: 0.4;"' : ''}>
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </td>
            </tr>`;
        }).join('');

        applyRoleVisibilityTo(list);
    } catch (err) {
        console.error('Error loading questionnaires:', err);
        renderLoadError('flow-list', 6);
    }
}

/**
 * Stop or resume a questionnaire.
 *
 * Stopping is the answer to "these questions are wrong" far more often than
 * deleting is: it takes effect immediately, and everything already collected
 * stays attached to the reports it belongs to.
 */
window.setFlowStatus = async function (flowId, status) {
    const stopping = status === 'inactive';
    const question = stopping
        ? 'Stop asking these questions?\n\nCitizens will no longer receive them after an acknowledgement. '
          + 'Answers already given stay on their reports, and anyone part-way through will finish.'
        : 'Start asking these questions again?';

    if (!confirm(question)) return;

    try {
        const res = await fetch(`${API_BASE_URL}/admin/bot-flows/${flowId}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        });
        const data = await res.json();
        alert(data.message || 'Could not change the status.');
        if (res.ok) loadFlows();
    } catch (err) {
        alert('Connection error.');
    }
};

window.deleteFlow = async function (flowId, name, timesSent) {
    if (timesSent > 0) {
        // The server refuses this too; saying so here saves a pointless round
        // trip and explains the alternative in the same breath.
        alert(`"${name}" has been sent to ${timesSent} citizen(s) and their answers are attached to reports.\n\n`
            + 'Stop it instead — it will stop asking, and the answers already given stay where they are.');
        return;
    }
    if (!confirm(`Delete "${name}"? It has never been answered, so nothing is lost.`)) return;

    try {
        const res = await fetch(`${API_BASE_URL}/admin/bot-flows/${flowId}`, { method: 'DELETE' });
        const data = await res.json();
        alert(data.message || 'Could not delete it.');
        if (res.ok) loadFlows();
    } catch (err) {
        alert('Connection error.');
    }
};

// ── New questionnaire ────────────────────────────────────────────────────────

function openNewFlowModal() {
    document.getElementById('new-flow-form').reset();
    document.getElementById('new-flow-error').style.display = 'none';

    // An MDA may only attach questions to categories it is responsible for, so
    // offering it others would only produce a refusal.
    const select = document.getElementById('new-flow-category');
    select.innerHTML = allCategories
        .map((c) => `<option value="${c.name}">${c.name}</option>`)
        .join('');

    // An administrator can create on behalf of any institution, so they have to
    // say which. Left unasked, the questionnaire belonged to nobody: the citizen
    // was told "the responsible team" wanted the details, and the institution
    // that actually needed them could not see or edit its own questions.
    const groupGroup = document.getElementById('new-flow-institution-group');
    if (isFullAdmin()) {
        const groupSelect = document.getElementById('new-flow-group');
        groupSelect.innerHTML = allGroups
            .map((g) => `<option value="${g.id}">${g.name}</option>`)
            .join('');
        groupGroup.style.display = 'block';

        // Default to whoever leads the chosen category, and follow it if the
        // category changes -- that is the right answer nearly every time.
        const syncInstitution = () => {
            const lead = leadGroupForCategory(select.value);
            if (lead) groupSelect.value = lead.id;
        };
        select.onchange = syncInstitution;
        syncInstitution();
    } else {
        groupGroup.style.display = 'none';
    }

    openFlowModal('new-flow-modal');
}

async function createFlow(e) {
    e.preventDefault();
    const name = document.getElementById('new-flow-name').value.trim();
    const category = document.getElementById('new-flow-category').value;
    const description = document.getElementById('new-flow-description').value.trim();
    const error = document.getElementById('new-flow-error');

    // The key is derived rather than asked for: it is a machine identifier and
    // nobody authoring questions should have to think about it.
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 55)
        || `flow_${Date.now()}`;

    try {
        const res = await fetch(`${API_BASE_URL}/admin/bot-flows`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                key, name, category, description,
                group_id: isFullAdmin()
                    ? parseInt(document.getElementById('new-flow-group').value, 10)
                    : undefined
            })
        });
        const data = await res.json();

        if (res.ok && data.id) {
            closeFlowModal('new-flow-modal');
            openFlow(data.id);
        } else {
            error.textContent = data.message || 'Could not create the questionnaire.';
            error.style.display = 'block';
        }
    } catch (err) {
        error.textContent = 'Connection error.';
        error.style.display = 'block';
    }
}

// ── Editor ───────────────────────────────────────────────────────────────────

window.openFlow = async function (flowId) {
    try {
        const res = await fetch(`${API_BASE_URL}/admin/bot-flows/${flowId}`);
        if (!res.ok) { alert('Could not open that questionnaire.'); return; }

        currentFlow = await res.json();

        // Opening is not editing. If work is already in progress it continues;
        // otherwise the live version is shown as it stands and a draft is only
        // created when someone actually asks to change something. Creating one
        // on every visit left "draft in progress" against questionnaires nobody
        // had touched.
        editingVersion = currentFlow.versions.find(
            (v) => ['draft', 'changes_requested', 'pending_review'].includes(v.state)
        ) || currentFlow.versions.find((v) => v.state === 'published')
          || currentFlow.versions[0]
          || null;

        if (editingVersion) {
            renderEditor();
        } else if (!(await createDraftVersion(flowId))) {
            return;
        }

        document.getElementById('flows-view').style.display = 'none';
        document.getElementById('editor-view').style.display = 'block';
        window.scrollTo(0, 0);
    } catch (err) {
        console.error(err);
        alert('Could not open that questionnaire.');
    }
};

/**
 * Create a draft, seeded from whatever is live, and open it.
 *
 * Named differently from the `startNewDraft` exposed on window below. A
 * top-level function in a classic script is already a property of window, so a
 * wrapper of the same name replaces it -- and then calls itself, forever. That
 * is what "Could not open that questionnaire" was: a stack overflow on any flow
 * with no versions yet, which is every newly created one.
 *
 * Returns true when a draft is open and rendered.
 */
async function createDraftVersion(flowId) {
    const created = await fetch(`${API_BASE_URL}/admin/bot-flows/${flowId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });
    const body = await created.json();
    if (!created.ok) {
        alert(body.message || 'Could not start a draft.');
        return false;
    }

    const refreshed = await fetch(`${API_BASE_URL}/admin/bot-flows/${flowId}`);
    currentFlow = await refreshed.json();
    editingVersion = currentFlow.versions.find((v) => v.id === body.id);
    renderEditor();
    return true;
}

window.startNewDraft = () => createDraftVersion(currentFlow.flow.id);

function renderEditor() {
    const { flow } = currentFlow;
    const version = editingVersion;
    const definition = version.definition || { steps: [] };

    document.getElementById('editor-title').textContent = flow.name;
    document.getElementById('editor-subtitle').textContent =
        `${flow.category} · ${flow.group_name || 'Platform'} · editing version ${version.version_number}`;

    const badge = STATE_BADGES[version.state] || { label: version.state, colour: 'var(--admin-text-muted)' };
    document.getElementById('editor-state-badge').innerHTML =
        `<span style="color: ${badge.colour}; font-weight: 700; font-size: 0.85rem;">${badge.label}</span>`;

    // A returned questionnaire shows the reviewer's note above everything else:
    // it is the reason the author is here.
    const noteBox = document.getElementById('editor-review-note');
    if (version.state === 'changes_requested' && version.review_note) {
        noteBox.innerHTML = `<strong>Changes requested by ${version.reviewed_by_name || 'an administrator'}:</strong><br>${version.review_note}`;
        noteBox.style.display = 'block';
    } else {
        noteBox.style.display = 'none';
    }

    document.getElementById('flow-intro').value = (definition.intro && definition.intro.en) || '';
    document.getElementById('flow-outro').value = (definition.outro && definition.outro.en) || '';
    document.getElementById('flow-change-note').value = version.change_note || '';

    const container = document.getElementById('steps-container');
    container.innerHTML = '';
    (definition.steps || []).forEach((step) => addStep(step));

    const isLive = version.state === 'published' || version.state === 'archived';
    const locked = version.state === 'pending_review' || isLive;
    const admin = isFullAdmin();

    document.getElementById('btn-save-draft').style.display = locked ? 'none' : 'inline-flex';
    document.getElementById('btn-add-step').style.display = locked ? 'none' : 'inline-flex';
    document.getElementById('btn-new-draft').style.display = isLive ? 'inline-flex' : 'none';
    document.getElementById('btn-submit-review').style.display =
        (!locked && !admin) ? 'inline-flex' : 'none';
    document.getElementById('btn-publish').style.display =
        (admin && !isLive) ? 'inline-flex' : 'none';
    document.getElementById('btn-request-changes').style.display =
        (admin && version.state === 'pending_review') ? 'inline-flex' : 'none';

    container.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = locked; });
    document.getElementById('flow-intro').disabled = locked;
    document.getElementById('flow-outro').disabled = locked;

    renderVersions();
}

function addStep(step) {
    const container = document.getElementById('steps-container');
    const index = container.children.length;
    const data = step || { type: 'text', prompt: { en: '' }, skippable: true };

    const card = document.createElement('div');
    card.className = 'flow-step';
    card.style.cssText = 'border: 1px solid var(--admin-border); border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem;';
    card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
            <strong style="font-size: 0.9rem;">Question <span class="step-number">${index + 1}</span></strong>
            <button type="button" class="action-btn" title="Remove" onclick="removeStep(this)">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>

        <div class="form-group" style="margin-bottom: 0.75rem;">
            <label style="font-size: 0.82rem;">Question</label>
            <input type="text" class="form-control step-prompt" maxlength="500"
                   value="${(data.prompt && data.prompt.en) || ''}"
                   placeholder="e.g. What is your meter number?">
        </div>

        <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
            <div class="form-group" style="flex: 1; min-width: 150px; margin-bottom: 0.75rem;">
                <label style="font-size: 0.82rem;">Answer type</label>
                <select class="form-control step-type" onchange="onStepTypeChange(this)">
                    <option value="text" ${data.type === 'text' ? 'selected' : ''}>Free text</option>
                    <option value="number" ${data.type === 'number' ? 'selected' : ''}>Number</option>
                    <option value="choice" ${data.type === 'choice' ? 'selected' : ''}>Choose from options</option>
                </select>
            </div>
            <div class="form-group" style="flex: 1; min-width: 150px; margin-bottom: 0.75rem;">
                <label style="font-size: 0.82rem;">Can it be skipped?</label>
                <select class="form-control step-skippable">
                    <option value="true" ${data.skippable !== false ? 'selected' : ''}>Yes — recommended</option>
                    <option value="false" ${data.skippable === false ? 'selected' : ''}>No, it is required</option>
                </select>
            </div>
        </div>

        <div class="form-group step-options-group" style="display: ${data.type === 'choice' ? 'block' : 'none'}; margin-bottom: 0.75rem;">
            <label style="font-size: 0.82rem;">Options, one per line</label>
            <textarea class="form-control step-options" rows="3"
                      placeholder="The whole street&#10;Only my house&#10;I am not sure">${
                          (data.options || []).map((o) => (o.label && o.label.en) || '').join('\n')
                      }</textarea>
        </div>

        <details style="font-size: 0.85rem;">
            <summary style="cursor: pointer; color: var(--admin-text-muted);">Extra settings</summary>
            <div class="form-group" style="margin-top: 0.75rem; margin-bottom: 0.75rem;">
                <label style="font-size: 0.82rem;">Helper text shown under the question</label>
                <input type="text" class="form-control step-help" maxlength="300"
                       value="${(data.help && data.help.en) || ''}"
                       placeholder="e.g. The 11 digits on the front of the meter.">
            </div>
            <div class="form-group" style="margin-bottom: 0.75rem;">
                <label style="font-size: 0.82rem;">Accepted format (regular expression)</label>
                <input type="text" class="form-control step-pattern"
                       value="${(data.validation && data.validation.pattern) || ''}"
                       placeholder="e.g. ^[0-9]{11}$">
            </div>
            <div class="form-group">
                <label style="font-size: 0.82rem;">What to say when the answer does not fit</label>
                <input type="text" class="form-control step-error" maxlength="300"
                       value="${(data.validation && data.validation.error && data.validation.error.en) || ''}"
                       placeholder="e.g. A meter number is 11 digits.">
            </div>
        </details>`;

    // The stored key is kept on the element so editing a question does not
    // orphan answers already collected under its old key.
    card.dataset.key = data.key || '';
    container.appendChild(card);
    renumberSteps();
}
window.addStep = addStep;

window.removeStep = function (button) {
    button.closest('.flow-step').remove();
    renumberSteps();
};

window.onStepTypeChange = function (select) {
    const card = select.closest('.flow-step');
    card.querySelector('.step-options-group').style.display =
        select.value === 'choice' ? 'block' : 'none';
};

function renumberSteps() {
    document.querySelectorAll('#steps-container .flow-step').forEach((card, i) => {
        card.querySelector('.step-number').textContent = i + 1;
    });
}

/** Turn the form back into a definition. */
function collectDefinition() {
    const steps = [...document.querySelectorAll('#steps-container .flow-step')].map((card, index) => {
        const prompt = card.querySelector('.step-prompt').value.trim();
        const type = card.querySelector('.step-type').value;
        const help = card.querySelector('.step-help').value.trim();
        const pattern = card.querySelector('.step-pattern').value.trim();
        const errorText = card.querySelector('.step-error').value.trim();

        // Keep the key a question already had; derive one for a new question so
        // the author never has to invent a machine name.
        const key = card.dataset.key
            || prompt.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
            || `question_${index + 1}`;
        card.dataset.key = key;

        const step = { key, type, prompt: { en: prompt }, skippable: card.querySelector('.step-skippable').value === 'true' };

        if (help) step.help = { en: help };

        if (type === 'choice') {
            step.options = card.querySelector('.step-options').value
                .split('\n').map((line) => line.trim()).filter(Boolean)
                .map((label) => ({
                    value: label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30),
                    label: { en: label }
                }));
        }

        if (pattern) {
            step.validation = { pattern };
            if (errorText) step.validation.error = { en: errorText };
        }

        return step;
    });

    const definition = { steps };
    const intro = document.getElementById('flow-intro').value.trim();
    const outro = document.getElementById('flow-outro').value.trim();
    if (intro) definition.intro = { en: intro };
    if (outro) definition.outro = { en: outro };
    return definition;
}

function showProblems(errors, warnings) {
    const problems = document.getElementById('editor-problems');
    const warns = document.getElementById('editor-warnings');

    if (errors && errors.length) {
        problems.innerHTML = '<strong>These must be fixed:</strong><ul style="margin: 0.5rem 0 0 1.1rem;">'
            + errors.map((e) => `<li>${e}</li>`).join('') + '</ul>';
        problems.style.display = 'block';
    } else {
        problems.style.display = 'none';
    }

    if (warnings && warnings.length) {
        warns.innerHTML = '<strong>Worth a look:</strong><ul style="margin: 0.5rem 0 0 1.1rem;">'
            + warnings.map((w) => `<li>${w}</li>`).join('') + '</ul>';
        warns.style.display = 'block';
    } else {
        warns.style.display = 'none';
    }
}

async function saveDraft() {
    try {
        const res = await fetch(`${API_BASE_URL}/admin/bot-flow-versions/${editingVersion.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                definition: collectDefinition(),
                change_note: document.getElementById('flow-change-note').value.trim()
            })
        });
        const data = await res.json();

        if (!res.ok) { showProblems(data.errors, data.warnings); return false; }

        showProblems(null, data.warnings);
        editingVersion.definition = data.version.definition;
        editingVersion.state = data.version.state;
        return true;
    } catch (err) {
        alert('Connection error while saving.');
        return false;
    }
}

async function submitForReview() {
    if (!(await saveDraft())) return;
    if (!confirm('Send this to MoCTI/DSTI for approval? You will not be able to edit it while they review it.')) return;

    const res = await fetch(`${API_BASE_URL}/admin/bot-flow-versions/${editingVersion.id}/submit`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) { alert(data.message); showList(); } else { showProblems(data.errors); alert(data.message); }
}

async function publishVersion() {
    if (editingVersion.state !== 'pending_review' && !(await saveDraft())) return;
    if (!confirm('Publish this? Citizens will start receiving these questions.')) return;

    const res = await fetch(`${API_BASE_URL}/admin/bot-flow-versions/${editingVersion.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });
    const data = await res.json();
    if (res.ok) { alert(data.message); showList(); } else { showProblems(data.errors); alert(data.message); }
}

async function sendReviewNote() {
    const note = document.getElementById('review-note').value.trim();
    const error = document.getElementById('review-error');

    const res = await fetch(`${API_BASE_URL}/admin/bot-flow-versions/${editingVersion.id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note })
    });
    const data = await res.json();

    if (res.ok) {
        closeFlowModal('review-modal');
        alert(data.message);
        showList();
    } else {
        error.textContent = data.message;
        error.style.display = 'block';
    }
}

async function sendTest() {
    const phone = document.getElementById('test-phone').value.trim();
    const error = document.getElementById('test-error');

    // Saved first, so the test exercises what is on screen rather than whatever
    // was last written to the database.
    if (editingVersion.state !== 'published' && editingVersion.state !== 'pending_review') {
        if (!(await saveDraft())) { closeFlowModal('test-modal'); return; }
    }

    const res = await fetch(`${API_BASE_URL}/admin/bot-flow-versions/${editingVersion.id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
    });
    const data = await res.json();

    if (res.ok) {
        closeFlowModal('test-modal');
        alert(data.message);
    } else {
        error.textContent = data.message || (data.errors || []).join(' ');
        error.style.display = 'block';
    }
}

function renderVersions() {
    const list = document.getElementById('version-list');
    list.innerHTML = currentFlow.versions.map((v) => {
        const badge = STATE_BADGES[v.state] || { label: v.state, colour: 'var(--admin-text-muted)' };

        const who = v.published_at ? `published ${new Date(v.published_at).toLocaleDateString('en-GB')}`
            : v.reviewed_at ? `reviewed by ${v.reviewed_by_name || '—'}`
            : v.submitted_at ? `submitted by ${v.submitted_by_name || '—'}`
            : `created by ${v.created_by_name || '—'}`;

        // Only an archived version can be restored, and only by an
        // administrator: bringing back old questions is a publication decision.
        const canRollback = isFullAdmin() && v.state === 'archived';

        return `<tr>
            <td data-label="Version">v${v.version_number}</td>
            <td data-label="State"><span style="color: ${badge.colour}; font-weight: 600;">${badge.label}</span></td>
            <td data-label="Change" style="font-size: 0.85rem;">${v.change_note || '—'}
                ${v.review_note ? `<div style="color: var(--admin-text-muted); font-style: italic;">“${v.review_note}”</div>` : ''}</td>
            <td data-label="Who" style="font-size: 0.82rem; color: var(--admin-text-muted);">${who}</td>
            <td data-label="Actions" style="text-align: right;">
                ${canRollback ? `<button class="action-btn" title="Make this live again" onclick="rollbackVersion(${v.id}, ${v.version_number})">
                    <i class="fa-solid fa-clock-rotate-left"></i>
                </button>` : ''}
            </td>
        </tr>`;
    }).join('');
}

window.rollbackVersion = async function (versionId, versionNumber) {
    if (!confirm(`Make version ${versionNumber} live again? It is restored as a new version, so the history stays intact.`)) return;

    const res = await fetch(`${API_BASE_URL}/admin/bot-flow-versions/${versionId}/rollback`, { method: 'POST' });
    const data = await res.json();
    alert(data.message || 'Could not restore that version.');
    if (res.ok) openFlow(currentFlow.flow.id);
};
