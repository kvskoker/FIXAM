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
    if (confirmYes) {
        confirmYes.addEventListener('click', async () => {
            const userId = confirmYes.getAttribute('data-action'); 
            const pendingStatus = confirmYes.getAttribute('data-pending-status');
            const noteInput = document.getElementById('confirm-note-input');
            const noteError = document.getElementById('confirm-note-error');
            const note = noteInput.value.trim();

            // Validation
            if ((pendingStatus === 'fixed' || userId === 'spam') && !note) {
                 // For spam, maybe note is optional? Prompt said "Optional".
                 // But in the code block below, let's keep it optional for spam if the user requested it.
                 // Wait, the prompt said "Optional: Enter a reason". So for spam it is optional.
                 // Only required for 'fixed'.
                 if (userId !== 'spam') {
                    noteError.style.display = 'block';
                    return;
                 }
            }
            // Actually, existing code required note for fixed.
            if (pendingStatus === 'fixed' && !note) {
                noteError.style.display = 'block';
                return;
            }
             
            noteError.style.display = 'none';

            // Show spinner
            const originalText = confirmYes.innerHTML;
            confirmYes.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
            confirmYes.disabled = true;
            document.getElementById('confirm-no-btn').disabled = true;

            if (userId === 'spam') {
                await executeSpamFlag(note);
            } else if (pendingStatus) {
                await executeStatusUpdate(pendingStatus, note);
            }

            // Reset
            confirmYes.innerHTML = originalText;
            confirmYes.disabled = false;
            document.getElementById('confirm-no-btn').disabled = false;
            document.getElementById('status-confirm-overlay').classList.add('hidden');
        });
    }
    }

    if (confirmNo) {
        confirmNo.addEventListener('click', () => {
            document.getElementById('status-confirm-overlay').classList.add('hidden');
            
            // Clean up potentially leftover Spam Modal state
            const yesBtn = document.getElementById('confirm-yes-btn');
            if (yesBtn) {
                 yesBtn.style.background = "var(--admin-primary)";
                 yesBtn.innerText = "Yes, Update";
                 yesBtn.removeAttribute('data-action');
                 document.getElementById('confirm-title').innerText = "Confirm Action";
                 document.getElementById('confirm-title').style.color = "var(--admin-text)";
                 document.getElementById('confirm-message').textContent = "Are you sure you want to proceed?"; // Default placeholder
            }
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
    
    // Admins should see spam
    params.append('include_spam', 'true');

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
    const statusColors = { 'critical': 'var(--admin-danger)', 'progress': 'var(--admin-warning)', 'fixed': 'var(--admin-success)', 'acknowledged': 'var(--admin-primary)', 'spam': 'var(--admin-danger)' };
    issues.forEach(issue => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--admin-border)';
        tr.innerHTML = `
            <td data-label="Issue ID" style="padding: 1rem; font-family: monospace;">${issue.ticket_id || 'N/A'}</td>
            <td data-label="Category" style="padding: 1rem;">${issue.category}</td>
            <td data-label="Title" style="padding: 1rem; font-weight: 500;">${issue.title}</td>
            <td data-label="Location" style="padding: 1rem; color: var(--admin-text-muted);">${issue.address || `${parseFloat(issue.lat).toFixed(4)}, ${parseFloat(issue.lng).toFixed(4)}`}</td>
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
            currentIssueData = issue;
            document.getElementById('modal-ticket').textContent = issue.ticket_id;
            document.getElementById('modal-status').textContent = issue.status;
            document.getElementById('modal-category-badge').textContent = issue.category; // Ensure badge text is updated too
            document.getElementById('modal-title').textContent = issue.title;
            document.getElementById('modal-desc').textContent = issue.description;
            document.getElementById('modal-location').textContent = issue.address || `${issue.lat}, ${issue.lng}`;
            
            // Audio Player
            const descContainer = document.getElementById('modal-desc');
            descContainer.innerHTML = ''; // Clear previous
            if (issue.audio_url) {
                const audioContainer = document.createElement('div');
                audioContainer.style.marginBottom = '1rem';
                audioContainer.innerHTML = `
                    <div style="font-size: 0.8rem; color: var(--admin-text-muted); margin-bottom: 0.5rem;">Voice Report:</div>
                    <audio controls src="${issue.audio_url}" style="width: 100%;"></audio>
                `;
                descContainer.appendChild(audioContainer);
            }
            // Add transcribed text (description)
            const textDiv = document.createElement('div');
            textDiv.textContent = issue.description;
            descContainer.appendChild(textDiv);
            
            // Reverse geocode to get address (if not already present)
            if (!issue.address) {
                fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${issue.lat}&lon=${issue.lng}`)
                    .then(res => res.json())
                    .then(data => {
                        if (data && data.display_name) {
                            document.getElementById('modal-location').textContent = data.display_name;
                        }
                    })
                    .catch(err => console.error('Geocoding error:', err));
            }
            // Media Display Logic
            const imgEl = document.getElementById('modal-image');
            const videoEl = document.getElementById('modal-video');
            const mediaUrl = issue.image_url;
            
            const isVideo = (url) => {
                if (!url) return false;
                return ['.mp4', '.mov', '.webm', '.ogg', '.avi'].some(ext => url.toLowerCase().endsWith(ext));
            };

            if (mediaUrl && isVideo(mediaUrl)) {
                imgEl.style.display = 'none';
                videoEl.src = mediaUrl;
                videoEl.style.display = 'block';
            } else {
                videoEl.style.display = 'none';
                if (videoEl.src) videoEl.pause();
                imgEl.src = mediaUrl || 'https://via.placeholder.com/400x200?text=No+Image';
                imgEl.style.display = 'block';
            }

            const statusEl = document.getElementById('modal-status');
            const statusColors = { 'critical': 'var(--admin-danger)', 'progress': 'var(--admin-warning)', 'fixed': 'var(--admin-success)', 'duplicate': 'var(--admin-warning)', 'spam': 'var(--admin-danger)' };
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
            
            // NEW SPAM LOGIC
            const btnEdit = document.getElementById('btn-edit-details');
            const statusContainer = document.getElementById('status-buttons-container');
            const duplicateSection = document.getElementById('duplicate-management-section');
            const btnSpam = document.getElementById('btn-flag-spam');
            const spamBannerId = 'spam-warning-banner';

             // Remove existing banner if any
            const existingBanner = document.getElementById(spamBannerId);
            if(existingBanner) existingBanner.remove();

            if (issue.status === 'spam') {
                 // Hide controls
                if(btnEdit) btnEdit.parentElement.style.display = 'none'; // Hide the container div
                if(statusContainer) statusContainer.parentElement.style.display = 'none'; // Hide the label and container
                if(duplicateSection) duplicateSection.style.display = 'none';
                if(btnSpam) btnSpam.parentElement.style.display = 'none';

                // Create and insert banner
                 const banner = document.createElement('div');
                banner.id = spamBannerId;
                banner.style.background = 'rgba(239, 68, 68, 0.1)';
                banner.style.border = '1px solid var(--admin-danger)';
                banner.style.color = 'var(--admin-danger)';
                banner.style.padding = '1rem';
                banner.style.borderRadius = '6px';
                banner.style.marginBottom = '2rem';
                banner.style.fontWeight = '500';
                banner.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> This issue has been flagged as SPAM. Management actions are restricted.';
                
                 // Insert before the Edit Details button container (which is now hidden, but we can insert into the parent column)
                 if (btnEdit && btnEdit.parentElement && btnEdit.parentElement.parentNode) {
                     btnEdit.parentElement.parentNode.insertBefore(banner, btnEdit.parentElement);
                 }

            } else {
                // Show controls (Reset visibility)
                 if(btnEdit) btnEdit.parentElement.style.display = 'block';
                 if(statusContainer) statusContainer.parentElement.style.display = 'block';
                 if(duplicateSection) duplicateSection.style.display = 'block';
                 if(btnSpam) btnSpam.parentElement.style.display = 'block';
            }
        }
        const trackerRes = await fetch(`${API_BASE_URL}/issues/${id}/tracker`);
        const trackerLogs = await trackerRes.json();
        
        // Add "Reported" event to timeline start
        if (issue) {
            trackerLogs.unshift({
                created_at: issue.created_at,
                action: 'reported',
                description: 'Issue reported via WhatsApp channel',
                performed_by_name: issue.reported_by_name || 'User' 
            });
        }
        
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

// Global variable update
let currentIssueData = null;

async function toggleEditMode(show) {
    const viewContainer = document.getElementById('view-mode-container');
    const editContainer = document.getElementById('edit-mode-container');
    
    if (show) {
        if (!currentIssueData) return;
        
        // Populate inputs
        document.getElementById('edit-title').value = currentIssueData.title;
        document.getElementById('edit-description').value = currentIssueData.description;
        
        // Fetch categories dynamically
        try {
            const res = await fetch(`${API_BASE_URL}/categories`);
            const categories = await res.json();
            const categorySelect = document.getElementById('edit-category');
            categorySelect.innerHTML = '';
            
            categories.forEach(cat => {
                const opt = document.createElement('option');
                opt.value = cat.name; // Assuming category object has 'name'
                opt.textContent = cat.name;
                categorySelect.appendChild(opt);
            });
            
             // Set current value
            categorySelect.value = currentIssueData.category;
            
        } catch (err) {
            console.error('Error fetching categories:', err);
             // Fallback existing options if fetch fails (though innerHTML cleared above, so actually we should rely on fetch)
             // If fetch fails, we might leave it empty or show error.
             // Simplest: just alert or ensure backend works.
        }

        viewContainer.classList.add('hidden');
        editContainer.classList.remove('hidden');
    } else {
        viewContainer.classList.remove('hidden');
        editContainer.classList.add('hidden');
    }
}

async function saveIssueDetails() {
    if (!currentIssueId) return;
    
    const title = document.getElementById('edit-title').value.trim();
    const description = document.getElementById('edit-description').value.trim();
    const category = document.getElementById('edit-category').value;
    
    if (!title || !description || !category) {
        alert('All fields are required.');
        return;
    }

    const adminUser = JSON.parse(localStorage.getItem('fixam_admin_user'));
    
    try {
        const res = await fetch(`${API_BASE_URL}/admin/issues/${currentIssueId}/details`, {
             method: 'PUT',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ 
                 title, 
                 description, 
                 category, 
                 admin_id: adminUser?.id 
             })
        });
        
        const data = await res.json();
        
        if (data.success) {
            toggleEditMode(false);
            openIssueDetails(currentIssueId); // Reload details
            loadIssues(); // Refresh list background
        } else {
            alert(data.message || 'Failed to update issue');
        }
    } catch (err) {
        console.error('Error saving issue details:', err);
        alert('An error occurred while saving.');
    }
}

async function flagAsSpam() {
    if (!currentIssueId) return;
    
    // Use the status confirmation overlay
    const overlay = document.getElementById('status-confirm-overlay');
    const messageEl = document.getElementById('confirm-message');
    const yesBtn = document.getElementById('confirm-yes-btn');
    const noteLabel = document.getElementById('confirm-note-label');
    const noteInput = document.getElementById('confirm-note-input');
    const noteError = document.getElementById('confirm-note-error');

    if (overlay && messageEl && yesBtn) {
        document.getElementById('confirm-title').innerText = "⚠️ Flag as SPAM";
        document.getElementById('confirm-title').style.color = "var(--admin-danger)";
        
        messageEl.innerHTML = `Are you sure you want to flag this issue as <strong>SPAM</strong>?<br><br>
        <div style="text-align: left; font-size: 0.85rem; background: rgba(239, 68, 68, 0.1); padding: 0.75rem; border-radius: 6px; color: var(--admin-danger);">
            <strong>This action will:</strong>
            <ul style="margin: 0; padding-left: 1.25rem; margin-top: 0.25rem;">
                <li>Hide the issue from public view.</li>
                <li>Remove it from trending lists.</li>
                <li>Send a warning to the reporter.</li>
                <li>Deduct 5 points from the reporter.</li>
            </ul>
        </div>`;
        
        yesBtn.setAttribute('data-action', 'spam');
        yesBtn.removeAttribute('data-pending-status'); // Ensure no collision
        yesBtn.innerText = "Yes, Flag as SPAM";
        yesBtn.style.background = "var(--admin-danger)";

        noteLabel.textContent = "Reason (Internal Note - Optional)";
        noteInput.value = "";
        noteInput.placeholder = "e.g. Violates community guidelines, Abusive content...";
        noteError.style.display = 'none';

        overlay.classList.remove('hidden');
    }
}

async function executeSpamFlag(reason) {
     const adminUser = JSON.parse(localStorage.getItem('fixam_admin_user'));
     
     try {
        const res = await fetch(`${API_BASE_URL}/admin/issues/${currentIssueId}/spam`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                reason: reason, 
                admin_id: adminUser?.id 
            })
        });

        const data = await res.json();

        if (data.success) {
            // Restore button style for next use
             const yesBtn = document.getElementById('confirm-yes-btn');
             if (yesBtn) {
                 yesBtn.style.background = "var(--admin-primary)";
                 yesBtn.innerText = "Yes, Update";
                 yesBtn.removeAttribute('data-action');
                 document.getElementById('confirm-title').innerText = "Confirm Action";
                 document.getElementById('confirm-title').style.color = "var(--admin-text)";
             }
             
            closeModal();
            loadIssues();
            
            // Optional: Show success toast/alert
            // alert('Issue flagged as SPAM.'); // User asked for modal, but a success feedback is fine. 
        } else {
            alert(data.message || 'Failed to flag as spam');
        }
    } catch (err) {
        console.error('Error flagging spam:', err);
        alert('An error occurred.');
    }
}
