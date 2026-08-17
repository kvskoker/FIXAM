let allFeedback = [];
let currentPage = 1;
const itemsPerPage = 10;
let filteredFeedback = [];

document.addEventListener('DOMContentLoaded', () => {
    // Check Auth
    checkAuth(() => {
        loadFeedback();

        // Event Listeners
        document.getElementById('feedback-search').addEventListener('input', () => { currentPage = 1; filterFeedback(); });
        document.getElementById('filter-type').addEventListener('change', () => { currentPage = 1; filterFeedback(); });
        document.getElementById('filter-status').addEventListener('change', () => { currentPage = 1; filterFeedback(); });
        document.getElementById('filter-routing').addEventListener('change', () => { currentPage = 1; filterFeedback(); });

        // Only a full Admin can re-route, so only they need the category list.
        if (isFullAdmin()) {
            loadRoutingCategories();
            document.getElementById('btn-classify-feedback').addEventListener('click', classifyPendingFeedback);
            document.getElementById('routing-scope').addEventListener('change', toggleRoutingCategory);
            document.getElementById('routing-form').addEventListener('submit', submitRouting);
        }
    });
});

let routingCategories = [];

async function loadRoutingCategories() {
    try {
        const res = await fetch(`${API_BASE_URL}/categories`);
        if (!res.ok) return;
        routingCategories = await res.json();
        const select = document.getElementById('routing-category');
        select.innerHTML = routingCategories
            .map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`)
            .join('');
    } catch (err) {
        console.error('Could not load categories for routing:', err);
    }
}

function toggleRoutingCategory() {
    const scope = document.getElementById('routing-scope').value;
    document.getElementById('routing-category-group').style.display =
        scope === 'service' ? 'block' : 'none';
}

window.openRoutingModal = function (id) {
    const item = allFeedback.find((f) => f.id === id);
    if (!item) return;

    document.getElementById('routing-feedback-id').value = id;
    document.getElementById('routing-preview').textContent =
        item.transcription || item.content || '(no text)';
    document.getElementById('routing-scope').value =
        (item.scope === 'service' || item.scope === 'suggested') ? 'service'
            : (item.scope === 'platform' ? 'platform' : 'unclassified');
    if (item.category) document.getElementById('routing-category').value = item.category;
    document.getElementById('routing-error').style.display = 'none';
    toggleRoutingCategory();
    openModal('routing-modal');
};

async function submitRouting(e) {
    e.preventDefault();
    const id = document.getElementById('routing-feedback-id').value;
    const scope = document.getElementById('routing-scope').value;
    const category = document.getElementById('routing-category').value;
    const errorEl = document.getElementById('routing-error');

    try {
        const res = await fetch(`${API_BASE_URL}/admin/feedback/${id}/routing`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scope, category: scope === 'service' ? category : null })
        });
        const data = await res.json();

        if (res.ok && data.success) {
            closeModal('routing-modal');
            loadFeedback();
        } else {
            errorEl.textContent = data.message || 'Could not save the routing.';
            errorEl.style.display = 'block';
        }
    } catch (err) {
        errorEl.textContent = 'Connection error.';
        errorEl.style.display = 'block';
    }
}

async function classifyPendingFeedback() {
    const btn = document.getElementById('btn-classify-feedback');
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Routing...';

    try {
        const res = await fetch(`${API_BASE_URL}/admin/feedback/classify`, { method: 'POST' });
        const data = await res.json();
        if (res.ok && data.success) {
            // The counts matter: anything left needing review is work for a
            // person, and saying so is more useful than "done".
            showAlert(`Examined ${data.examined} item(s).

`
                + `Filed as platform feedback: ${data.routed}
`
                + `Suggested for an MDA — confirm to send: ${data.suggested || 0}
`
                + `Too unclear to classify: ${data.needs_review}`
                + (data.failed ? `
Could not be reached: ${data.failed}` : ''));
            loadFeedback();
        } else {
            showAlert(data.message || 'Could not classify the pending feedback.');
        }
    } catch (err) {
        showAlert('Connection error while classifying feedback.');
    } finally {
        btn.disabled = false;
        btn.innerHTML = original;
    }
}

async function loadFeedback() {
    try {
        const response = await fetch(`${API_BASE_URL}/admin/feedback`);
        if (!response.ok) {
            // 401 is handled centrally; anything else must not leave the caller
            // iterating over an error object.
            console.error('Feedback request failed:', response.status);
            allFeedback = [];
            filterFeedback();
            return;
        }
        const data = await response.json();
        allFeedback = Array.isArray(data) ? data : [];
        filterFeedback();
    } catch (err) {
        console.error('Error loading feedback:', err);
        allFeedback = [];
        filterFeedback();
    }
}

function filterFeedback() {
    const searchTerm = document.getElementById('feedback-search').value.toLowerCase();
    const typeFilter = document.getElementById('filter-type').value;
    const statusFilter = document.getElementById('filter-status').value;
    const routingFilter = document.getElementById('filter-routing').value;

    filteredFeedback = allFeedback.filter(item => {
        const matchesSearch = (item.user_name && item.user_name.toLowerCase().includes(searchTerm)) || 
                              (item.phone_number && item.phone_number.includes(searchTerm)) ||
                              (item.content && item.content.toLowerCase().includes(searchTerm)) ||
                              (item.transcription && item.transcription.toLowerCase().includes(searchTerm));
        
        const matchesType = typeFilter === 'all' || item.type === typeFilter;
        const matchesStatus = statusFilter === 'all' || item.status === statusFilter;

        const routing = item.scope || 'unclassified';
        const matchesRouting = routingFilter === 'all' || routing === routingFilter;

        return matchesSearch && matchesType && matchesStatus && matchesRouting;
    });

    // Pagination Logic
    const totalPages = Math.ceil(filteredFeedback.length / itemsPerPage);
    if (currentPage > totalPages) currentPage = 1;
    if (currentPage < 1) currentPage = 1;
    if (totalPages === 0) currentPage = 1;

    const start = (currentPage - 1) * itemsPerPage;
    const paginatedItems = filteredFeedback.slice(start, start + itemsPerPage);

    renderFeedback(paginatedItems);
    renderPagination(filteredFeedback.length, totalPages);
}

function renderFeedback(feedbackList) {
    const list = document.getElementById('feedback-list');
    list.innerHTML = '';

    if (feedbackList.length === 0) {
        list.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--admin-text-muted);">No feedback found.</td></tr>';
        return;
    }

    feedbackList.forEach(item => {
        const row = document.createElement('tr');
        
        let typeIcon = item.type === 'audio' ? '<i class="fa-solid fa-microphone type-icon"></i>' : '<i class="fa-solid fa-align-left type-icon"></i>';
        let audioPlayer = item.type === 'audio' && item.media_url ? 
            `<audio controls src="${item.media_url}" style="height: 30px; width: 200px;"></audio>` : 
            '<span style="color: var(--admin-text-muted);">-</span>';

        let statusBadge = item.status === 'acknowledged' ? 
            '<span class="status-badge status-acknowledged">Acknowledged</span>' : 
            '<span class="status-badge status-pending">Pending</span>';

        // One badge and at most one short hint, instead of the sentence stacked
        // under a sentence that used to make this column unreadable. The long
        // explanations live in the tooltip and in the routing modal.
        const routingCell = (() => {
            let badge;
            if (item.scope === 'platform') {
                badge = '<span class="status-badge" style="background: rgba(99,102,241,0.12); color:#6366f1; border:1px solid rgba(99,102,241,0.3);">MoCTI / DSTI</span>';
            } else if (item.scope === 'service' && item.routed_group_name) {
                badge = `<span class="status-badge" style="background: rgba(37,99,235,0.1); color: var(--admin-primary); border:1px solid rgba(37,99,235,0.25);">${escapeHtml(item.routed_group_name)}</span>`;
            } else if (item.scope === 'suggested') {
                badge = `<span class="status-badge" style="background: rgba(245,158,11,0.12); color: var(--admin-warning); border:1px dashed rgba(245,158,11,0.5);">${escapeHtml(item.category || 'Uncategorised')} <span style="opacity:0.6;">· suggested</span></span>`;
            } else {
                badge = '<span class="status-badge" style="background: rgba(245,158,11,0.12); color: var(--admin-warning); border:1px solid rgba(245,158,11,0.3);">Needs routing</span>';
            }

            const pct = item.routing_confidence != null ? ` · ${Math.round(item.routing_confidence * 100)}%` : '';
            let hint = '';
            if (item.routing_source === 'ai_suggested') {
                hint = `<span title="AI suggestion — confirm before it reaches the MDA" style="font-size:0.72rem; color: var(--admin-text-muted);"><i class="fa-solid fa-wand-magic-sparkles"></i> AI${pct}</span>`;
            } else if (item.routing_source === 'ai') {
                hint = `<span title="Classified automatically" style="font-size:0.72rem; color: var(--admin-text-muted);"><i class="fa-solid fa-wand-magic-sparkles"></i> AI${pct}</span>`;
            } else if (item.routing_source === 'admin') {
                hint = '<span title="Set by an admin" style="font-size:0.72rem; color: var(--admin-text-muted);"><i class="fa-solid fa-user-check"></i> admin</span>';
            }

            return `<div style="display:flex; flex-direction:column; align-items:flex-start; gap:4px;">${badge}${hint ? `<div>${hint}</div>` : ''}</div>`;
        })();

        const routeBtn = `<button class="action-btn" data-admin-only onclick="openRoutingModal(${item.id})" title="Change routing" style="margin-right: 0.4rem;">
                <i class="fa-solid fa-route"></i>
            </button>`;

        let actionBtn = item.status === 'pending' ? 
            `<button class="btn btn-success" onclick="acknowledgeFeedback(${item.id})" style="font-size: 0.8rem; padding: 0.4rem 0.8rem;">
                <i class="fa-solid fa-check"></i> Acknowledge
            </button>` : 
            '';

        row.innerHTML = `
            <td data-label="User">
                <div style="font-weight: 500;">${item.user_name || 'Unknown'}</div>
                <div style="font-size: 0.85rem; color: var(--admin-text-muted);">${escapeHtml(item.phone_number)}</div>
            </td>
            <td data-label="Type">${typeIcon} ${item.type.toUpperCase()}</td>
            <td data-label="Feedback/Transcription">
                <div style="max-width: 300px; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;">${item.transcription || item.content || '-'}</div>
            </td>
            <td data-label="Audio">${audioPlayer}</td>
            <td data-label="Date" style="font-size: 0.9rem; color: var(--admin-text-muted); white-space: nowrap;">
                ${new Date(item.created_at).toLocaleString()}
            </td>
            <td data-label="Routed To">${routingCell}</td>
            <td data-label="Status">${statusBadge}</td>
            <td data-label="Actions" style="text-align: right; white-space: nowrap;">
                ${routeBtn}${actionBtn}
            </td>
        `;
        list.appendChild(row);
    });

    applyRoleVisibilityTo(list);
}

function renderPagination(totalItems, totalPages) {
    const paginationContainer = document.getElementById('feedback-pagination');
    if (!paginationContainer) return;

    let html = `
        <span id="pagination-info" style="font-size: 0.9rem; color: var(--admin-text-muted);">
            Showing ${(currentPage - 1) * itemsPerPage + 1}-${Math.min(currentPage * itemsPerPage, totalItems)} of ${totalItems} results
        </span>
        <div class="pagination-numbers">
    `;

    // Previous Button
    html += `<button class="page-btn" onclick="changePage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left"></i></button>`;

    // Page Numbers
    for (let i = 1; i <= totalPages; i++) {
        // Show first, last, current, and surrounding pages
        if (i === 1 || i === totalPages || (i >= currentPage - 1 && i <= currentPage + 1)) {
            html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="changePage(${i})">${i}</button>`;
        } else if (i === currentPage - 2 || i === currentPage + 2) {
            html += `<span style="display:flex;align-items:flex-end;padding:0 4px;">...</span>`;
        }
    }

    // Next Button
    html += `<button class="page-btn" onclick="changePage(${currentPage + 1})" ${currentPage === totalPages || totalPages === 0 ? 'disabled' : ''}><i class="fa-solid fa-chevron-right"></i></button>`;

    html += `</div>`;
    paginationContainer.innerHTML = html;
}

window.changePage = function(page) {
    currentPage = page;
    filterFeedback();
    // Scroll to top of table
    document.querySelector('.admin-table-container').scrollIntoView({ behavior: 'smooth' });
};

window.acknowledgeFeedback = async function(id) {
    try {
        const response = await fetch(`${API_BASE_URL}/admin/feedback/${id}/acknowledge`, {
            method: 'POST'
        });

        if (response.ok) {
            loadFeedback(); // Refresh list to get updated status
        } else {
            showAlert('Failed to acknowledge feedback');
        }
    } catch (err) {
        console.error('Error acknowledging feedback:', err);
    }
};
