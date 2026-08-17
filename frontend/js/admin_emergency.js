// Emergency coordination centre.
//
// Shows critical open reports, unscoped, with search, category filter, sort and
// pagination. Auto-refreshes and keeps the current filters and page, so a new
// emergency is visible without the officer losing their place.

let lastEmergencyTotal = null;
let refreshTimer = null;

const PAGE_SIZE = 20;
const emergencyState = {
    page: 1,
    search: '',
    category: '',
    sort: 'newest',
};

document.addEventListener('DOMContentLoaded', () => {
    checkAuth(async () => {
        await loadEmergencyCategories();
        wireEmergencyControls();

        await loadEmergencies();
        refreshTimer = setInterval(loadEmergencies, 15000);
    });
});

async function loadEmergencyCategories() {
    const select = document.getElementById('emergency-filter-category');
    if (!select) return;
    try {
        const res = await fetch(`${API_BASE_URL}/categories`);
        if (!res.ok) return;
        const categories = await res.json();
        (Array.isArray(categories) ? categories : []).forEach((cat) => {
            const opt = document.createElement('option');
            opt.value = cat.name;
            opt.textContent = cat.name;
            select.appendChild(opt);
        });
    } catch (err) {
        console.error('Error loading categories:', err);
    }
}

function wireEmergencyControls() {
    const search = document.getElementById('emergency-search');
    if (search) {
        search.addEventListener('input', debounce(() => {
            emergencyState.search = search.value.trim();
            emergencyState.page = 1;
            loadEmergencies();
        }, 300));
    }

    const category = document.getElementById('emergency-filter-category');
    if (category) {
        category.addEventListener('change', () => {
            emergencyState.category = category.value;
            emergencyState.page = 1;
            loadEmergencies();
        });
    }

    const sort = document.getElementById('emergency-sort');
    if (sort) {
        sort.addEventListener('change', () => {
            emergencyState.sort = sort.value;
            emergencyState.page = 1;
            loadEmergencies();
        });
    }

    const prev = document.getElementById('emergency-prev');
    if (prev) prev.addEventListener('click', () => {
        if (emergencyState.page > 1) {
            emergencyState.page--;
            loadEmergencies();
        }
    });

    const next = document.getElementById('emergency-next');
    if (next) next.addEventListener('click', () => {
        emergencyState.page++;
        loadEmergencies();
    });
}

async function loadEmergencies() {
    const params = new URLSearchParams();
    params.append('page', emergencyState.page);
    params.append('limit', PAGE_SIZE);
    if (emergencyState.search) params.append('search', emergencyState.search);
    if (emergencyState.category) params.append('category', emergencyState.category);
    if (emergencyState.sort) params.append('sort', emergencyState.sort);

    try {
        const res = await fetch(`${API_BASE_URL}/admin/emergency/issues?${params.toString()}`);
        if (!res.ok) {
            renderLoadError('emergency-list', 7, res.status);
            return;
        }
        const payload = await res.json();
        let issues = Array.isArray(payload) ? payload : (payload.data || []);
        let pagination = payload.pagination || null;

        // Fallback for an older backend that returns the whole list unpaginated:
        // page it here so the controls still work rather than showing nothing.
        if (!pagination) {
            const total = issues.length;
            const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
            const page = Math.min(emergencyState.page, totalPages);
            emergencyState.page = page;
            pagination = {
                current_page: page,
                per_page: PAGE_SIZE,
                total_items: total,
                total_pages: totalPages,
            };
            issues = issues.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
        }

        renderEmergencies(issues);
        renderPagination(pagination);
        updateBadge(pagination.total_items);

        const note = document.getElementById('emergency-refresh-note');
        if (note) note.textContent = `Updated ${new Date().toLocaleTimeString('en-GB')}`;
    } catch (err) {
        console.error('Error loading emergencies:', err);
    }
}

function ageOf(createdAt) {
    if (!createdAt) return '—';
    const mins = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}D`;
    return `${Math.floor(days / 7)}W`;
}

/**
 * The centre's one action, by status. "Acknowledge" dispatches a freshly
 * reported emergency; "Start Work" moves an acknowledged one along. Reports
 * already in progress show their state rather than a button that would fail.
 */
function actionCell(issue) {
    const base = 'style="font-size: 0.8rem; padding: 0.4rem 0.8rem;"';
    if (issue.status === 'reported') {
        return `<button class="btn btn-primary" onclick="advanceEmergency(${issue.id}, 'acknowledged')" ${base}>Acknowledge</button>`;
    }
    if (issue.status === 'acknowledged') {
        return `<button class="btn btn-primary" onclick="advanceEmergency(${issue.id}, 'progress')" ${base}>Start Work</button>`;
    }
    return '<span class="status-badge status-pending" style="font-size: 0.75rem;">In progress</span>';
}

function renderEmergencies(issues) {
    const list = document.getElementById('emergency-list');
    if (!list) return;

    if (!Array.isArray(issues) || issues.length === 0) {
        list.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 3rem; color: var(--admin-text-muted);"><i class="fa-solid fa-circle-check" style="font-size: 1.75rem; opacity: 0.35; display: block; margin-bottom: 0.75rem;"></i>No open critical reports.</td></tr>';
        return;
    }

    list.innerHTML = issues.map((issue) => `
        <tr>
            <td data-label="Ticket" style="font-family: monospace; font-weight: 600; white-space: nowrap;">
                <a href="/admin/issue?id=${issue.id}" style="color: var(--admin-primary);">#${escapeHtml(issue.ticket_id)}</a>
            </td>
            <td data-label="Issue" style="font-weight: 500;">${escapeHtml(issue.title)}</td>
            <td data-label="Category">${escapeHtml(issue.category || 'Uncategorized')}</td>
            <td data-label="Location" style="color: var(--admin-text-muted); font-size: 0.85rem;">${escapeHtml(issue.address || 'Not pinpointed')}</td>
            <td data-label="Reported" style="white-space: nowrap; color: var(--admin-text-muted); font-size: 0.85rem;">${new Date(issue.created_at).toLocaleString('en-GB')}</td>
            <td data-label="Age" style="color: var(--admin-danger); font-weight: 600;">${ageOf(issue.created_at)}</td>
            <td data-label="Action" style="text-align: right;">${actionCell(issue)}</td>
        </tr>
    `).join('');
}

function renderPagination(pagination) {
    const info = document.getElementById('emergency-pagination-info');
    const prev = document.getElementById('emergency-prev');
    const next = document.getElementById('emergency-next');
    if (!info || !prev || !next) return;

    if (!pagination) {
        info.textContent = '';
        prev.disabled = true;
        next.disabled = true;
        return;
    }

    const start = (pagination.current_page - 1) * pagination.per_page + 1;
    const end = Math.min(pagination.current_page * pagination.per_page, pagination.total_items);

    info.textContent = pagination.total_items === 0
        ? 'No critical reports'
        : `Showing ${start}–${end} of ${pagination.total_items}`;

    prev.disabled = pagination.current_page <= 1;
    next.disabled = pagination.current_page >= pagination.total_pages;
    prev.style.opacity = prev.disabled ? '0.4' : '1';
    next.style.opacity = next.disabled ? '0.4' : '1';
}

function updateBadge(total) {
    const badge = document.getElementById('nav-emergency-badge');
    if (badge) {
        badge.textContent = total;
        badge.style.display = total > 0 ? 'inline-block' : 'none';
    }

    if (lastEmergencyTotal !== null && total > lastEmergencyTotal) {
        const banner = document.getElementById('emergency-banner');
        const text = document.getElementById('emergency-banner-text');
        if (banner && text) {
            text.textContent = `${total - lastEmergencyTotal} new critical report${total - lastEmergencyTotal === 1 ? '' : 's'} arrived.`;
            banner.style.display = 'block';
            setTimeout(() => { banner.style.display = 'none'; }, 8000);
        }
    }
    lastEmergencyTotal = total;
}

window.advanceEmergency = async function (id, status) {
    const prompt = status === 'acknowledged'
        ? 'Acknowledge this emergency and dispatch it? The owning MDA and the reporter will be notified.'
        : 'Mark this emergency as in progress? The reporter will be notified.';

    if (!await showConfirm(prompt)) return;

    try {
        const res = await fetch(`${API_BASE_URL}/admin/issues/${id}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                status,
                note: status === 'acknowledged'
                    ? 'Acknowledged from the emergency coordination centre'
                    : 'Work started from the emergency coordination centre'
            })
        });
        const data = await res.json();
        if (res.ok && data.success) {
            loadEmergencies();
        } else {
            showAlert(data.message || 'Could not update the report.');
        }
    } catch (err) {
        showAlert('Connection error while updating the report.');
    }
};
