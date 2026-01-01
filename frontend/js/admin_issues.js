// Include this after admin_common.js
let currentIssueId = null;
let issuePage = 1;
const issueLimit = 8;

document.addEventListener('DOMContentLoaded', () => {
    checkAuth(() => {
        // Initialize filters from URL
        const urlParams = getURLParams();
        if (urlParams.search) document.getElementById('issue-search').value = urlParams.search;
        if (urlParams.category) document.getElementById('issue-filter-category').value = urlParams.category;
        if (urlParams.status) document.getElementById('issue-filter-status').value = urlParams.status;
        if (urlParams.start_date) document.getElementById('issue-filter-start').value = urlParams.start_date;
        if (urlParams.end_date) document.getElementById('issue-filter-end').value = urlParams.end_date;
        if (urlParams.sort) document.getElementById('issue-sort').value = urlParams.sort;
        if (urlParams.page) issuePage = parseInt(urlParams.page);
        
        loadIssues();
    });

    // Issue Filters
    document.getElementById('issue-search').addEventListener('input', debounce(() => { 
        issuePage = 1; 
        syncFiltersToURL();
        loadIssues(); 
    }, 500));

    ['issue-filter-category', 'issue-filter-status', 'issue-filter-start', 'issue-filter-end', 'issue-sort'].forEach(id => {
        document.getElementById(id).addEventListener('change', () => { 
            issuePage = 1; 
            syncFiltersToURL();
            loadIssues(); 
        });
    });

    // Pagination Handlers
    document.getElementById('prev-page').addEventListener('click', () => {
        if (issuePage > 1) {
            issuePage--;
            syncFiltersToURL();
            loadIssues();
        }
    });

    document.getElementById('next-page').addEventListener('click', () => {
        issuePage++;
        syncFiltersToURL();
        loadIssues();
    });

    // Reset Filters
    const resetBtn = document.getElementById('reset-issues-filters');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            document.getElementById('issue-search').value = '';
            document.getElementById('issue-filter-category').value = '';
            document.getElementById('issue-filter-status').value = '';
            document.getElementById('issue-filter-start').value = '';
            document.getElementById('issue-filter-end').value = '';
            document.getElementById('issue-sort').value = 'newest';
            issuePage = 1;
            syncFiltersToURL();
            loadIssues();
        });
    }

    // Modal Close
    const closeModalBtn = document.getElementById('close-modal');
    if (closeModalBtn) closeModalBtn.addEventListener('click', closeModal);

    // Confirmation Modal Handlers
    const confirmYes = document.getElementById('confirm-yes-btn');
    const confirmNo = document.getElementById('confirm-no-btn');
    
    if (confirmYes) {
        confirmYes.addEventListener('click', async () => {
            const pendingStatus = confirmYes.getAttribute('data-pending-status');
            const noteInput = document.getElementById('confirm-note-input');
            const noteError = document.getElementById('confirm-note-error');
            const note = noteInput.value.trim();

            if (pendingStatus === 'fixed' && !note) {
                noteError.style.display = 'block';
                return;
            } else {
                noteError.style.display = 'none';
            }

            if (pendingStatus) {
                // Show spinner
                const originalText = confirmYes.innerHTML;
                confirmYes.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Updating...';
                confirmYes.disabled = true;
                document.getElementById('confirm-no-btn').disabled = true;

                await executeStatusUpdate(pendingStatus, note);
                
                // Reset (though modal closes, good practice)
                confirmYes.innerHTML = originalText;
                confirmYes.disabled = false;
                document.getElementById('confirm-no-btn').disabled = false;
                
                document.getElementById('status-confirm-overlay').classList.add('hidden');
            }
        });
    }

    if (confirmNo) {
        confirmNo.addEventListener('click', () => {
            document.getElementById('status-confirm-overlay').classList.add('hidden');
        });
    }
    
    // Initialize Date Restrictions
    setupDateRestrictions();

    // Check for ID in URL to auto-open modal
    const urlParams = getURLParams();
    if (urlParams.id) {
        setTimeout(() => openIssueDetails(parseInt(urlParams.id)), 1000);
    }
});

function setupDateRestrictions() {
    const startDate = document.getElementById('issue-filter-start');
    const endDate = document.getElementById('issue-filter-end');

    if (startDate && endDate) {
        const today = new Date();

        const startPicker = flatpickr(startDate, {
            dateFormat: "Y-m-d",
            altInput: true,
            altFormat: "d/m/Y",
            maxDate: today,
            onChange: function(selectedDates, dateStr, instance) {
                endPicker.set('minDate', dateStr);
                if (endDate.value && endDate.value < dateStr) {
                    endPicker.setDate(dateStr);
                }
                syncFiltersToURL();
                loadIssues();
            }
        });

        const endPicker = flatpickr(endDate, {
            dateFormat: "Y-m-d",
            altInput: true,
            altFormat: "d/m/Y",
            maxDate: today,
            onChange: function(selectedDates, dateStr, instance) {
                startPicker.set('maxDate', dateStr ? dateStr : today);
                syncFiltersToURL();
                loadIssues();
            }
        });
        
        // Handle initial values if set from URL
        if(startDate.value) startPicker.setDate(startDate.value, false);
        if(endDate.value) endPicker.setDate(endDate.value, false);
    }
}

function syncFiltersToURL() {
    const searchEl = document.getElementById('issue-search');
    const catEl = document.getElementById('issue-filter-category');
    const statusEl = document.getElementById('issue-filter-status');
    const startEl = document.getElementById('issue-filter-start');
    const endEl = document.getElementById('issue-filter-end');
    const sortEl = document.getElementById('issue-sort');

    if (!searchEl) return; // Not on issues page or not loaded

    const params = {
        search: searchEl.value,
        category: catEl.value,
        status: statusEl.value,
        start_date: startEl.value,
        end_date: endEl.value,
        sort: sortEl.value,
        page: issuePage
    };
    updateURLParams(params);
}

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
            btn.onclick = () => { issuePage = i; syncFiltersToURL(); loadIssues(); };
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
            <td data-label="Issue ID" style="padding: 1rem; font-family: monospace;">${issue.ticket_id || 'N/A'}</td>
            <td data-label="Category" style="padding: 1rem;">${issue.category}</td>
            <td data-label="Title" style="padding: 1rem; font-weight: 500;">${issue.title}</td>
            <td data-label="Location" style="padding: 1rem; color: var(--admin-text-muted);">${parseFloat(issue.lat).toFixed(4)}, ${parseFloat(issue.lng).toFixed(4)}</td>
            <td data-label="Votes" style="padding: 1rem;">${issue.upvotes || 0}</td>
            <td data-label="Status" style="padding: 1rem;"><span style="color: ${statusColors[issue.status] || 'white'}; font-weight: 600; text-transform: capitalize;">${issue.status}</span></td>
            <td data-label="Date" style="padding: 1rem; color: var(--admin-text-muted); font-size: 0.9rem;">${new Date(issue.created_at).toLocaleDateString('en-GB')}</td>
            <td data-label="Action" style="padding: 1rem;"><button onclick="openIssueDetails(${issue.id})" style="background: var(--admin-primary); color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; width: 100%;">Manage</button></td>
        `;
        tbody.appendChild(tr);
    });
}

async function openIssueDetails(id) {
    currentIssueId = id;
    const modal = document.getElementById('issue-modal');
    modal.classList.remove('hidden');
    
    // Update URL with ID
    updateURLParams({ id: id });

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

            const statusEl = document.getElementById('modal-status');
            const statusColors = { 'critical': 'var(--admin-danger)', 'progress': 'var(--admin-warning)', 'fixed': 'var(--admin-success)', 'duplicate': 'var(--admin-warning)' };
            statusEl.style.background = statusColors[issue.status] || 'rgba(255,255,255,0.1)';
            statusEl.style.color = 'white';
            
            if (issue.duplicate_of) {
                // Find parent ticket ID
                const parent = allIssues.find(i => i.id === issue.duplicate_of);
                if (parent) {
                    document.getElementById('modal-desc').innerHTML += `<br><br><div id="duplicate-badge" style="background: rgba(245, 158, 11, 0.1); border: 1px solid var(--admin-warning); padding: 1rem; border-radius: 6px; color: var(--admin-warning); font-weight: 500;">⚠️ This issue is marked as a DUPLICATE of <a href="#" onclick="openIssueDetails(${parent.id}); return false;" style="color: var(--admin-primary); text-decoration: underline;">${parent.ticket_id}</a></div>`;
                }
                
                // Hide link controls, show unlink controls
                document.getElementById('link-duplicate-controls').classList.add('hidden');
                document.getElementById('unlink-duplicate-controls').classList.remove('hidden');
                
                // Disable all status buttons for duplicates
                document.querySelectorAll('.status-btn').forEach(btn => {
                    btn.disabled = true;
                    btn.style.opacity = '0.5';
                    btn.style.cursor = 'not-allowed';
                    btn.title = 'Status is synced from the original issue';
                });
            } else {
                 // Show link controls, hide unlink controls
                document.getElementById('link-duplicate-controls').classList.remove('hidden');
                document.getElementById('unlink-duplicate-controls').classList.add('hidden');
                
                // Reset all button styles first
                document.querySelectorAll('.status-btn').forEach(btn => {
                    btn.disabled = false;
                    btn.style.opacity = '1';
                    btn.style.cursor = 'pointer';
                    btn.style.background = 'var(--admin-card-bg)';
                    btn.style.color = 'var(--admin-text)';
                    btn.title = '';
                });

                // Disable the current status button
                const currentStatusBtn = document.getElementById(`btn-status-${issue.status}`);
                if (currentStatusBtn) {
                    currentStatusBtn.disabled = true;
                    currentStatusBtn.style.opacity = '0.5';
                    currentStatusBtn.style.cursor = 'default';
                    currentStatusBtn.style.background = 'var(--admin-primary)';
                    currentStatusBtn.style.color = 'white';
                    currentStatusBtn.title = 'Already in this status';
                }
            }
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
            <div style="font-size: 0.85rem; color: var(--admin-text-muted); margin-bottom: 0.25rem;">${new Date(log.created_at).toLocaleString('en-GB')}</div>
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

function updateStatus(newStatus) {
    if (!currentIssueId) return;
    
    // Show Custom Confirmation Overlay instead of native alert/confirm
    const overlay = document.getElementById('status-confirm-overlay');
    const messageEl = document.getElementById('confirm-message');
    const yesBtn = document.getElementById('confirm-yes-btn');
    const noteLabel = document.getElementById('confirm-note-label');
    const noteInput = document.getElementById('confirm-note-input');
    const noteError = document.getElementById('confirm-note-error');

    if (overlay && messageEl && yesBtn) {
        const friendlyStatus = newStatus === 'fixed' ? 'Resolved' : (newStatus === 'progress' ? 'In Progress' : 'Acknowledged');
        messageEl.textContent = `Are you sure you want to update the status of this issue to "${friendlyStatus}"?`;
        yesBtn.setAttribute('data-pending-status', newStatus);
        
        // Reset inputs
        noteInput.value = '';
        noteError.style.display = 'none';

        if (newStatus === 'fixed') {
            noteLabel.innerHTML = 'Resolution Note <span style="color: var(--admin-danger);">*</span> (Visible to Public)';
            noteInput.placeholder = 'Please explain how this issue was resolved...';
        } else {
            noteLabel.textContent = 'Internal Note (Optional)';
            noteInput.placeholder = 'Add a note for the log...';
        }

        overlay.classList.remove('hidden');
        setTimeout(() => noteInput.focus(), 100);
    }
}

async function executeStatusUpdate(newStatus, note) {
    const adminUser = JSON.parse(localStorage.getItem('fixam_admin_user'));
    if (!adminUser) return;
    
    try {
        const res = await fetch(`${API_BASE_URL}/admin/issues/${currentIssueId}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                status: newStatus, 
                admin_id: adminUser.id, 
                note: note || `Status updated to ${newStatus} by Admin` 
            })
        });
        const data = await res.json();
        if (data.success) {
            openIssueDetails(currentIssueId);
            loadIssues();
        } else { 
            alert(data.message || 'Failed to update status'); 
        }
    } catch (err) { 
        console.error('Error updating status:', err); 
    }
}

async function markAsDuplicate() {
    if (!currentIssueId) return;
    const parentTicketId = document.getElementById('duplicate-ticket-input').value.trim().toUpperCase();
    if (!parentTicketId) return alert('Please enter a parent Ticket ID');

    const adminUser = JSON.parse(localStorage.getItem('fixam_admin_user'));
    
    try {
        // First find the parent issue ID by Ticket ID
        const searchRes = await fetch(`${API_BASE_URL}/issues?ticket=${parentTicketId}`);
        const searchData = await searchRes.json();
        const parentIssues = Array.isArray(searchData) ? searchData : searchData.data;
        
        if (!parentIssues || parentIssues.length === 0) {
            return alert('Parent Issue not found. Please check the Ticket ID.');
        }
        
        const parentIssue = parentIssues[0];
        
        if (parentIssue.id === currentIssueId) {
            return alert('An issue cannot be a duplicate of itself.');
        }

        const res = await fetch(`${API_BASE_URL}/admin/issues/${currentIssueId}/mark-duplicate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                original_issue_id: parentIssue.id, 
                admin_id: adminUser?.id,
                note: `Marked as duplicate of ${parentTicketId} by Admin`
            })
        });
        
        const data = await res.json();
        if (data.success) {
            document.getElementById('duplicate-ticket-input').value = '';
            openIssueDetails(currentIssueId);
            loadIssues();
        } else {
            alert(data.message || 'Failed to mark as duplicate');
        }
    } catch (err) {
        console.error('Error marking as duplicate:', err);
    }
}

async function unlinkDuplicate() {
    if (!currentIssueId || !confirm('Are you sure you want to unlink this issue? It will become a unique issue again.')) return;
    
    const adminUser = JSON.parse(localStorage.getItem('fixam_admin_user'));
    
    try {
        const res = await fetch(`${API_BASE_URL}/admin/issues/${currentIssueId}/unlink-duplicate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                admin_id: adminUser?.id,
                note: `Unlinked from parent issue by Admin`
            })
        });
        
        const data = await res.json();
        if (data.success) {
            openIssueDetails(currentIssueId);
            loadIssues();
        } else {
            alert(data.message || 'Failed to unlink duplicate');
        }
    } catch (err) {
        console.error('Error unlinking duplicate:', err);
    }
}
