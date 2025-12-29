// Include this after admin_common.js
let currentIssueId = null;
let issuePage = 1;
const issueLimit = 8;

document.addEventListener('DOMContentLoaded', () => {
    checkAuth(() => {
        loadIssues();
    });

    // Issue Filters
    document.getElementById('issue-search').addEventListener('input', debounce(() => { issuePage = 1; loadIssues(); }, 500));
    document.getElementById('issue-filter-category').addEventListener('change', () => { issuePage = 1; loadIssues(); });
    document.getElementById('issue-filter-status').addEventListener('change', () => { issuePage = 1; loadIssues(); });
    document.getElementById('issue-filter-start').addEventListener('change', () => { issuePage = 1; loadIssues(); });
    document.getElementById('issue-filter-end').addEventListener('change', () => { issuePage = 1; loadIssues(); });
    document.getElementById('issue-sort').addEventListener('change', () => { issuePage = 1; loadIssues(); });

    // Pagination Handlers
    document.getElementById('prev-page').addEventListener('click', () => {
        if (issuePage > 1) {
            issuePage--;
            loadIssues();
        }
    });

    document.getElementById('next-page').addEventListener('click', () => {
        issuePage++;
        loadIssues();
    });

    // Modal Close
    document.getElementById('close-modal').addEventListener('click', closeModal);
    
    // Check for ID in URL to auto-open modal
    const urlParams = new URLSearchParams(window.location.search);
    const id = urlParams.get('id');
    if (id) {
        setTimeout(() => openIssueDetails(parseInt(id)), 1000);
    }
});

async function loadIssues() {
    const search = document.getElementById('issue-search').value;
    const category = document.getElementById('issue-filter-category').value;
    const status = document.getElementById('issue-filter-status').value;
    const start = document.getElementById('issue-filter-start').value;
    const end = document.getElementById('issue-filter-end').value;
    const sort = document.getElementById('issue-sort').value;
    
    const params = new URLSearchParams();
    params.append('page', issuePage);
    params.append('limit', issueLimit);
    if (search) params.append('search', search);
    if (category && category !== 'All') params.append('category', category);
    if (status) params.append('status', status);
    if (start) params.append('start_date', start);
    if (end) params.append('end_date', end);
    if (sort) params.append('sort', sort);

    try {
        const res = await fetch(`${API_BASE_URL}/issues?${params.toString()}`);
        const responseData = await res.json();
        const issues = Array.isArray(responseData) ? responseData : responseData.data;
        const pagination = responseData.pagination || { 
            current_page: issuePage, 
            total_pages: Math.ceil((issues || []).length / issueLimit), 
            total_items: (issues || []).length 
        };

        renderIssuesTable(issues);
        updatePaginationControls(pagination);

    } catch (err) {
        console.error('Error loading issues:', err);
    }
}

function updatePaginationControls(pagination) {
    const prevBtn = document.getElementById('prev-page');
    const nextBtn = document.getElementById('next-page');
    const pageInfo = document.getElementById('page-info');
    const numbersContainer = document.getElementById('pagination-numbers');

    if (prevBtn && nextBtn && pageInfo) {
        prevBtn.disabled = pagination.current_page <= 1;
        nextBtn.disabled = pagination.current_page >= pagination.total_pages;
        pageInfo.textContent = `Page ${pagination.current_page} of ${pagination.total_pages || 1} (${pagination.total_items} total)`;
    }

    if (numbersContainer) {
        numbersContainer.innerHTML = '';
        const totalPages = pagination.total_pages || 1;
        const current = pagination.current_page;
        let startPage = Math.max(1, current - 2);
        let endPage = Math.min(totalPages, startPage + 4);
        if (endPage - startPage < 4) startPage = Math.max(1, endPage - 4);

        for (let i = startPage; i <= endPage; i++) {
            const btn = document.createElement('button');
            btn.textContent = i;
            btn.style.cssText = 'width: 32px; height: 32px; border-radius: 6px; border: 1px solid var(--admin-border); cursor: pointer;';
            if (i === current) {
                btn.style.background = 'var(--admin-primary)'; btn.style.color = 'white'; btn.style.borderColor = 'var(--admin-primary)';
            } else {
                btn.style.background = 'var(--admin-card-bg)'; btn.style.color = 'var(--admin-text)';
            }
            btn.onclick = () => { issuePage = i; loadIssues(); };
            numbersContainer.appendChild(btn);
        }
    }
}

function renderIssuesTable(issues) {
    const tbody = document.getElementById('issues-table-body');
    tbody.innerHTML = '';
    if (!issues || issues.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="padding: 2rem; text-align: center; color: var(--admin-text-muted);">No issues found</td></tr>';
        return;
    }
    const statusColors = { 'critical': 'var(--admin-danger)', 'progress': 'var(--admin-warning)', 'fixed': 'var(--admin-success)', 'acknowledged': 'var(--admin-primary)' };
    issues.forEach(issue => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--admin-border)';
        tr.innerHTML = `
            <td style="padding: 1rem; font-family: monospace;">${issue.ticket_id || 'N/A'}</td>
            <td style="padding: 1rem;">${issue.category}</td>
            <td style="padding: 1rem; font-weight: 500;">${issue.title}</td>
            <td style="padding: 1rem; color: var(--admin-text-muted);">${issue.lat}, ${issue.lng}</td>
            <td style="padding: 1rem;">${issue.upvotes || 0}</td>
            <td style="padding: 1rem;"><span style="color: ${statusColors[issue.status] || 'white'}; font-weight: 600; text-transform: capitalize;">${issue.status}</span></td>
            <td style="padding: 1rem; color: var(--admin-text-muted); font-size: 0.9rem;">${new Date(issue.created_at).toLocaleDateString()}</td>
            <td style="padding: 1rem;"><button onclick="openIssueDetails(${issue.id})" style="background: var(--admin-primary); color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer;">Manage</button></td>
        `;
        tbody.appendChild(tr);
    });
}

async function openIssueDetails(id) {
    currentIssueId = id;
    const modal = document.getElementById('issue-modal');
    modal.classList.remove('hidden');
    try {
        const allRes = await fetch(`${API_BASE_URL}/issues?limit=10000`);
        const responseData = await allRes.json();
        const allIssues = Array.isArray(responseData) ? responseData : responseData.data;
        const issue = allIssues.find(i => i.id === id);
        if (issue) {
            document.getElementById('modal-ticket').textContent = issue.ticket_id;
            document.getElementById('modal-status').textContent = issue.status;
            document.getElementById('modal-title').textContent = issue.title;
            document.getElementById('modal-desc').textContent = issue.description;
            document.getElementById('modal-location').textContent = `${issue.lat}, ${issue.lng}`;
            document.getElementById('modal-image').src = issue.image_url || 'https://via.placeholder.com/400x200?text=No+Image';
        }
        const trackerRes = await fetch(`${API_BASE_URL}/issues/${id}/tracker`);
        const trackerLogs = await trackerRes.json();
        renderTimeline(trackerLogs);
    } catch (err) { console.error('Error opening details:', err); }
}

function renderTimeline(logs) {
    const container = document.getElementById('modal-timeline');
    container.innerHTML = '';
    logs.forEach(log => {
        const item = document.createElement('div');
        item.style.cssText = 'margin-bottom: 1.5rem; position: relative;';
        item.innerHTML = `
            <div style="position: absolute; left: -1.35rem; top: 0; width: 12px; height: 12px; background: var(--admin-primary); border-radius: 50%; border: 2px solid var(--admin-card-bg);"></div>
            <div style="font-size: 0.85rem; color: var(--admin-text-muted); margin-bottom: 0.25rem;">${new Date(log.created_at).toLocaleString()}</div>
            <div style="font-weight: 600; margin-bottom: 0.25rem; text-transform: capitalize;">${log.action.replace('_', ' ')}</div>
            <div style="font-size: 0.9rem; color: var(--admin-text-muted);">${log.description}</div>
            ${log.performed_by_name ? `<div style="font-size: 0.8rem; color: var(--admin-primary); margin-top: 0.25rem;">By: ${log.performed_by_name}</div>` : ''}
        `;
        container.appendChild(item);
    });
}

function closeModal() {
    document.getElementById('issue-modal').classList.add('hidden');
    currentIssueId = null;
    // Clear URL param if present
    const url = new URL(window.location);
    url.searchParams.delete('id');
    window.history.replaceState({}, '', url);
}

async function updateStatus(newStatus) {
    if (!currentIssueId) return;
    const adminUser = JSON.parse(localStorage.getItem('fixam_admin_user'));
    if (!adminUser) return;
    try {
        const res = await fetch(`${API_BASE_URL}/admin/issues/${currentIssueId}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus, admin_id: adminUser.id, note: `Status updated to ${newStatus} by Admin` })
        });
        const data = await res.json();
        if (data.success) {
            openIssueDetails(currentIssueId);
            loadIssues();
        } else { alert('Failed to update status'); }
    } catch (err) { console.error('Error updating status:', err); }
}
