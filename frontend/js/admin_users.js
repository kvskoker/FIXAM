let groupLeadTomSelect = null;
// Pagination State
let currentPage = 1;

document.addEventListener('DOMContentLoaded', () => {
    checkAuth(() => {
        loadUsers();
        loadGroups();
        loadCategoriesForGroupModal(); // Load categories for group modal
        initEventListeners();
    });
});

function initEventListeners() {
    const auditExport = document.getElementById('btn-export-audit');
    if (auditExport) auditExport.addEventListener('click', exportAuditLog);

    // Tab Switching
    document.querySelectorAll('.tab-item').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab-item').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            
            const target = tab.dataset.tab;
            const panels = {
                users: 'tab-users-content',
                groups: 'tab-groups-content',
                categories: 'tab-categories-content',
                audit: 'tab-audit-content',
                pilot: 'tab-pilot-content',
            };
            Object.entries(panels).forEach(([key, elId]) => {
                const el = document.getElementById(elId);
                if (el) el.classList.toggle('hidden', key !== target);
            });

            if (target === 'users') loadUsers();
            else if (target === 'groups') loadGroups();
            else if (target === 'categories') loadCategoryAdmin();
            else if (target === 'audit') loadAuditLog();
            else if (target === 'pilot') loadPilotSettings();
        });
    });

    // User Search & Filter
    document.getElementById('user-search').addEventListener('input', debounce(() => {
        currentPage = 1;
        loadUsers();
    }, 500));

    document.getElementById('filter-role').addEventListener('change', () => {
        currentPage = 1;
        loadUsers();
    });

    // Modals
    document.getElementById('btn-add-user').addEventListener('click', () => {
        resetUserForm();
        document.getElementById('modal-title').textContent = 'Add New User';
        openModal('user-modal');
    });

    document.getElementById('btn-add-group').addEventListener('click', () => {
        resetGroupForm();
        document.getElementById('group-modal-title').textContent = 'Create Group';
        openModal('group-modal');
    });

    // Password Toggle
    document.getElementById('toggle-user-password').addEventListener('click', function() {
        const passwordInput = document.getElementById('user-password');
        const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
        passwordInput.setAttribute('type', type);
        this.classList.toggle('fa-eye');
        this.classList.toggle('fa-eye-slash');
    });

    // Forms
    document.getElementById('user-form').addEventListener('submit', handleUserSubmit);
    document.getElementById('group-form').addEventListener('submit', handleGroupSubmit);
    document.getElementById('penalty-form').addEventListener('submit', handlePenaltySubmit);
    document.getElementById('btn-save-settings').addEventListener('click', savePilotSettings);

    // Pagination
    document.getElementById('prev-page').addEventListener('click', () => {
        if (currentPage > 1) {
            currentPage--;
            loadUsers();
        }
    });

    document.getElementById('next-page').addEventListener('click', () => {
        currentPage++;
        loadUsers();
    });
}

// ==========================================
// USER FUNCTIONS
// ==========================================

async function loadUsers() {
    const search = document.getElementById('user-search').value;
    const role = document.getElementById('filter-role').value;
    
    let url = `${API_BASE_URL}/admin/users?page=${currentPage}&limit=8`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    if (role !== 'All') url += `&role=${role}`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            // 401 is already handled centrally (back to the login screen); for
            // anything else say so in the table rather than crashing on a body
            // that has no `data` and leaving a blank page.
            renderLoadError('user-list', 7, response.status);
            return;
        }
        const data = await response.json();
        renderUsers(data.data || []);
        updatePagination(data.pagination);
    } catch (err) {
        console.error('Error loading users:', err);
        renderLoadError('user-list', 7);
    }
}

function renderUsers(users) {
    const list = document.getElementById('user-list');
    list.innerHTML = '';

    if (!Array.isArray(users) || users.length === 0) {
        list.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 2rem; color: var(--admin-text-muted);">No users found</td></tr>';
        return;
    }

    users.forEach(user => {
        const roles = Array.isArray(user.roles) ? user.roles : JSON.parse(user.roles || '[]');
        const groups = Array.isArray(user.groups) ? user.groups : JSON.parse(user.groups || '[]');
        
        const currentUser = JSON.parse(localStorage.getItem('fixam_admin_user'));
        const isSelf = currentUser && currentUser.id == user.id;

        const row = document.createElement('tr');
        row.innerHTML = `
            <td data-label="User">
                <div style="display: flex; align-items: center; gap: 0.75rem; width: 100%;">
                    <div style="width: 32px; height: 32px; border-radius: 50%; background: var(--admin-primary); color: white; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 0.8rem;">
                        ${(user.name || 'U').charAt(0).toUpperCase()}
                    </div>
                    <div style="text-align: left; overflow: hidden; text-overflow: ellipsis;">
                        <div style="font-weight: 500;">${escapeHtml(user.name) || 'Anonymous'} ${isSelf ? '<span style="color: var(--admin-primary); font-size: 0.75rem; margin-left: 0.5rem;">(You)</span>' : ''}${user.pilot_activated ? '<span style="background: rgba(245,158,11,0.15); color: var(--admin-warning); font-size: 0.7rem; padding: 1px 6px; border-radius: 8px; margin-left: 0.5rem; font-weight: 600;">Pilot</span>' : ''}</div>
                    </div>
                </div>
            </td>
            <td data-label="Phone">${escapeHtml(user.phone_number)}</td>
            <td data-label="Roles">
                <div style="display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end;">
                    ${roles.map(r => `<span class="role-badge role-${r.toLowerCase()}">${r}</span>`).join('')}
                </div>
            </td>
            <td data-label="Groups">
                <div style="display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end;">
                    ${groups.map(g => `<span class="group-badge">${g}</span>`).join('') || '<span style="color: var(--admin-text-muted); font-size: 0.8rem;">None</span>'}
                </div>
            </td>
            <td data-label="Status">
                <span class="status-badge ${user.is_disabled ? 'status-disabled' : 'status-active'}">
                    ${user.is_disabled ? 'Disabled' : 'Active'}
                </span>
            </td>
            <td data-label="Joined" style="color: var(--admin-text-muted); font-size: 0.85rem;">
                ${user.created_at ? new Date(user.created_at).toLocaleDateString('en-GB') : 'N/A'}
            </td>
            <td data-label="Points" style="font-weight: 600; color: var(--admin-primary);">
                ${user.points || 0}
            </td>
            <td data-label="Actions" style="text-align: right;" ${isFullAdmin() ? '' : 'data-admin-only'}>
                <div style="display: flex; gap: 0.5rem; justify-content: flex-end;">
                    <button class="action-btn" onclick="editUser(${JSON.stringify(user).replace(/"/g, '&quot;')})" title="Edit User">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    ${!isSelf ? `
                    <button class="action-btn ${user.points > 0 ? 'disabled' : 'delete'}" 
                            onclick="${user.points > 0 ? '' : `deleteUser(${user.id})`}" 
                            title="${user.points > 0 ? 'Cannot delete active user' : 'Delete User'}"
                            ${user.points > 0 ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''}>
                        <i class="fa-solid fa-trash"></i>
                    </button>
                    <button class="action-btn" onclick="penalizeUser(${JSON.stringify(user).replace(/"/g, '&quot;')})" title="Penalize User" style="color: var(--admin-danger); border-color: var(--admin-danger);">
                        <i class="fa-solid fa-gavel"></i>
                    </button>
                    ` : ''}
                </div>
            </td>
        `;
        list.appendChild(row);
    });

    applyRoleVisibilityTo(list);
}

function updatePagination(pagination) {
    const info = document.getElementById('pagination-info');
    const startCount = (pagination.current_page - 1) * pagination.per_page + 1;
    const endCount = Math.min(pagination.current_page * pagination.per_page, pagination.total_items);
    
    info.textContent = `Showing ${pagination.total_items > 0 ? startCount : 0} - ${endCount} of ${pagination.total_items} users`;
    
    document.getElementById('prev-page').disabled = pagination.current_page === 1;
    document.getElementById('next-page').disabled = pagination.current_page >= pagination.total_pages;

    // Numbered Pagination
    const numbersContainer = document.getElementById('pagination-numbers');
    numbersContainer.innerHTML = '';
    
    const maxVisible = 5;
    let startPage = Math.max(1, pagination.current_page - Math.floor(maxVisible / 2));
    let endPage = Math.min(pagination.total_pages, startPage + maxVisible - 1);
    
    if (endPage - startPage + 1 < maxVisible) {
        startPage = Math.max(1, endPage - maxVisible + 1);
    }

    for (let i = startPage; i <= endPage; i++) {
        const btn = document.createElement('button');
        btn.className = `action-btn ${i === pagination.current_page ? 'active' : ''}`;
        btn.style.width = '32px';
        if (i === pagination.current_page) {
            btn.style.background = 'var(--admin-primary)';
            btn.style.color = 'white';
            btn.style.borderColor = 'var(--admin-primary)';
        }
        btn.textContent = i;
        btn.onclick = () => {
            currentPage = i;
            loadUsers();
        };
        numbersContainer.appendChild(btn);
    }
}

async function handleUserSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('edit-user-id').value;
    const name = document.getElementById('user-name').value;
    const phone_number = document.getElementById('user-phone').value;
    const password = document.getElementById('user-password').value;
    const is_disabled = document.getElementById('user-disabled').checked;
    const pilot_activated = document.getElementById('user-pilot-activated').checked;
    
    const roles = Array.from(document.querySelectorAll('#roles-checkboxes input:checked')).map(cb => cb.value);
    const groups = Array.from(document.getElementById('groups-select').selectedOptions).map(opt => opt.value);

    // Get current admin ID from localStorage
    const adminUser = JSON.parse(localStorage.getItem('fixam_admin_user'));
    const admin_id = adminUser ? adminUser.id : null;

    const data = { name, phone_number, password, is_disabled, pilot_activated, roles, groups, admin_id };
    const method = id ? 'PUT' : 'POST';
    const url = id ? `${API_BASE_URL}/admin/users/${id}` : `${API_BASE_URL}/admin/users`;

    try {
        const response = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        if (response.ok) {
            closeModal('user-modal');
            loadUsers();
            loadGroups(); // Refresh groups member count implicitly
        } else {
            const err = await response.json();
            const errorDiv = document.getElementById('user-error');
            errorDiv.textContent = err.error || 'Failed to save user';
            errorDiv.style.display = 'block';
            document.querySelector('#user-modal .modal-content').scrollTop = 0;
        }
    } catch (err) {
        console.error('Error saving user:', err);
    }
}

function editUser(user) {
    resetUserForm();
    document.getElementById('modal-title').textContent = 'Edit User';
    document.getElementById('edit-user-id').value = user.id;
    document.getElementById('user-name').value = user.name || '';
    document.getElementById('user-phone').value = user.phone_number;
    document.getElementById('user-disabled').checked = user.is_disabled;
    document.getElementById('user-pilot-activated').checked = !!user.pilot_activated;
    
    // Hide self-disable group
    const currentUser = JSON.parse(localStorage.getItem('fixam_admin_user'));
    const isSelf = currentUser && currentUser.id == user.id;
    document.getElementById('user-disabled-group').style.display = isSelf ? 'none' : 'block';
    
    const roles = Array.isArray(user.roles) ? user.roles : JSON.parse(user.roles || '[]');
    document.querySelectorAll('#roles-checkboxes input').forEach(cb => {
        cb.checked = roles.includes(cb.value);
        // Prevent self-demotion: disable role checkboxes if editing self
        cb.disabled = isSelf;
    });

    const groups = Array.isArray(user.groups) ? user.groups : JSON.parse(user.groups || '[]');
    
    // Update Tom Select if initialized
    if (groupsTomSelect) {
        groupsTomSelect.clear(); // Clear first
        groupsTomSelect.setValue(groups);
    } else {
        // Fallback or race condition handling (unlikely if loadGroups runs first)
        const select = document.getElementById('groups-select');
        Array.from(select.options).forEach(opt => {
            opt.selected = groups.includes(opt.value);
        });
    }

    openModal('user-modal');
}

async function deleteUser(id) {
    if (!await showConfirm('Are you sure you want to delete this user? This cannot be undone.')) return;

    // Get current admin ID from localStorage
    const adminUser = JSON.parse(localStorage.getItem('fixam_admin_user'));
    const admin_id = adminUser ? adminUser.id : null;

    try {
        const response = await fetch(`${API_BASE_URL}/admin/users/${id}?admin_id=${admin_id}`, { method: 'DELETE' });
        if (response.ok) {
            loadUsers();
        } else {
            const err = await response.json();
            showAlert(err.error || 'Failed to delete user');
        }
    } catch (err) {
        console.error('Error deleting user:', err);
    }
}

function resetUserForm() {
    document.getElementById('user-form').reset();
    document.getElementById('edit-user-id').value = '';
    document.getElementById('user-error').style.display = 'none';
    document.getElementById('user-disabled-group').style.display = 'block';
    document.getElementById('user-pilot-activated').checked = false;
    document.querySelectorAll('#roles-checkboxes input').forEach(cb => {
        cb.checked = cb.value === 'User'; // Default role
        cb.disabled = false;
    });
    
    // Reset password visibility
    const passwordInput = document.getElementById('user-password');
    passwordInput.setAttribute('type', 'password');
    const toggleIcon = document.getElementById('toggle-user-password');
    toggleIcon.classList.remove('fa-eye-slash');
    toggleIcon.classList.add('fa-eye');

    // Clear Tom Select
    if (groupsTomSelect) {
        groupsTomSelect.clear();
    }
}

// ==========================================
// GROUP FUNCTIONS
// ==========================================

// ── Pilot & SLA settings ─────────────────────────────────────────────────────
// Full admin only (the tab is hidden for MDA users). The numbers are read from
// and written to /api/admin/settings, so a change here takes effect in the bot
// and the daily SLA sweep without a deployment.

async function loadPilotSettings() {
    try {
        const res = await fetch(`${API_BASE_URL}/admin/settings`);
        if (!res.ok) return;
        const s = await res.json();

        const toggle = document.getElementById('pilot-mode-toggle');
        const status = document.getElementById('pilot-mode-status');
        if (toggle) toggle.checked = s.pilot_mode === 'true';
        if (status) {
            status.textContent = s.pilot_mode === 'true'
                ? 'Only pilot champions may report.'
                : 'Anyone may report.';
        }

        document.getElementById('sla-acknowledge-hours').value = s.sla_acknowledge_hours || 24;
        document.getElementById('sla-progress-hours').value = s.sla_progress_hours || 72;
        document.getElementById('sla-resolution-days').value = s.sla_resolution_days || 30;
    } catch (err) {
        console.error('Error loading settings:', err);
    }
}

async function savePilotSettings() {
    const payload = {
        pilot_mode: document.getElementById('pilot-mode-toggle').checked ? 'true' : 'false',
        sla_acknowledge_hours: document.getElementById('sla-acknowledge-hours').value,
        sla_progress_hours: document.getElementById('sla-progress-hours').value,
        sla_resolution_days: document.getElementById('sla-resolution-days').value,
    };

    const saved = document.getElementById('settings-saved');
    try {
        const res = await fetch(`${API_BASE_URL}/admin/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (res.ok) {
            saved.style.display = 'inline';
            setTimeout(() => { saved.style.display = 'none'; }, 3000);
            loadPilotSettings();
        } else {
            showAlert('Could not save settings.');
        }
    } catch (err) {
        console.error('Error saving settings:', err);
        showAlert('Connection error while saving settings.');
    }
}



async function loadGroups() {
    try {
        const response = await fetch(`${API_BASE_URL}/admin/groups`);
        if (!response.ok) {
            renderLoadError('group-list', 5, response.status);
            return;
        }
        const groups = await response.json();
        const list = Array.isArray(groups) ? groups : [];
        renderGroups(list);
        populateGroupsCheckboxes(list);
    } catch (err) {
        console.error('Error loading groups:', err);
        renderLoadError('group-list', 5);
    }
}

function renderGroups(groups) {
    const list = document.getElementById('group-list');
    list.innerHTML = '';

    (Array.isArray(groups) ? groups : []).forEach(group => {
        const categories = Array.isArray(group.categories) ? group.categories : JSON.parse(group.categories || '[]');
        const categoriesHtml = categories.length > 0
            ? categories.map(c => `<span class="badge" style="background: rgba(37, 99, 235, 0.1); color: var(--admin-primary); border: 1px solid rgba(37, 99, 235, 0.2); margin-right: 6px; padding: 3px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; display: inline-block; margin-bottom: 4px;">${escapeHtml(c.name)}</span>`).join('')
            : '<span style="color: var(--admin-text-muted); font-style: italic;">None</span>';

        const row = document.createElement('tr');
        row.innerHTML = `
            <td data-label="Group Name" style="font-weight: 600; color: var(--admin-primary);">${escapeHtml(group.name)}</td>
            <td data-label="Description">${group.description || '<span style="color: var(--admin-text-muted);">No description</span>'}</td>
            <td data-label="Assigned Categories">${categoriesHtml}</td>
            <td data-label="Members">
                <div style="font-size: 0.9rem;">
                    <i class="fa-solid fa-users" style="margin-right: 0.5rem; color: var(--admin-text-muted);"></i>
                    ${group.member_count} members
                </div>
            </td>
            <td data-label="Created" style="color: var(--admin-text-muted); font-size: 0.85rem;">
                ${new Date(group.created_at).toLocaleDateString('en-GB')}
            </td>
            <td data-label="Actions" style="text-align: right;" ${isFullAdmin() ? '' : 'data-admin-only'}>
                <div style="display: flex; gap: 0.5rem; justify-content: flex-end;">
                    <button class="action-btn" onclick="editGroup(${JSON.stringify(group).replace(/"/g, '&quot;')})" title="Edit Group">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="action-btn delete" 
                            onclick="deleteGroup(${group.id})" 
                            title="${parseInt(group.member_count) > 0 ? 'Cannot delete group with assigned members' : 'Delete Group'}"
                            ${parseInt(group.member_count) > 0 ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''}>
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </td>
        `;
        list.appendChild(row);
    });

    applyRoleVisibilityTo(list);
}

// Tom Select Instance
let groupsTomSelect;

function populateGroupsCheckboxes(groups) {
    const select = document.getElementById('groups-select');
    
    // Destroy existing instance to cleanly update options
    if (groupsTomSelect) {
        groupsTomSelect.destroy();
        groupsTomSelect = null;
    }

    select.innerHTML = '';
    groups.forEach(group => {
        const opt = document.createElement('option');
        opt.value = group.name;
        opt.textContent = group.name;
        select.appendChild(opt);
    });

    // Initialize Tom Select
    groupsTomSelect = new TomSelect('#groups-select', {
        plugins: ['remove_button'],
        create: false,
        placeholder: 'Select groups...',
        maxItems: null,
        valueField: 'value',
        labelField: 'text',
        searchField: 'text',
        onInitialize: function() {
            // Fix for sometimes width 0 issue
            this.wrapper.style.width = '100%';
        }
    });
}
// Removed handleGroupSubmit as it was not part of the target block
// Removed editGroup as it was not part of the target block
// Removed deleteGroup as it was not part of the target block
// Removed resetGroupForm as it was not part of the target block


async function handleGroupSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('edit-group-id').value;
    const name = document.getElementById('group-name').value;
    const description = document.getElementById('group-desc').value;
    
    const categories = groupCategoriesTomSelect ? groupCategoriesTomSelect.getValue() : [];
    const leadCategories = groupLeadTomSelect ? groupLeadTomSelect.getValue() : [];
    const isDefault = document.getElementById('group-is-default').checked;

    const method = id ? 'PUT' : 'POST';
    const url = id ? `${API_BASE_URL}/admin/groups/${id}` : `${API_BASE_URL}/admin/groups`;

    try {
        const response = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description, categories, lead_categories: leadCategories, is_default: isDefault })
        });

        if (response.ok) {
            closeModal('group-modal');
            loadGroups();
        } else {
            const err = await response.json();
            const errorDiv = document.getElementById('group-error');
            errorDiv.textContent = err.error || 'Failed to save group';
            errorDiv.style.display = 'block';
        }
    } catch (err) {
        console.error('Error saving group:', err);
    }
}

function editGroup(group) {
    resetGroupForm();
    document.getElementById('group-modal-title').textContent = 'Edit Group';
    document.getElementById('edit-group-id').value = group.id;
    document.getElementById('group-name').value = group.name;
    document.getElementById('group-desc').value = group.description || '';
    
    // Set Categories
    if (groupCategoriesTomSelect) {
        const categories = Array.isArray(group.categories) ? group.categories : JSON.parse(group.categories || '[]');
        // API now returns objects {id, name}, extract IDs for select value
        const categoryIds = categories.map(c => c.id);
        groupCategoriesTomSelect.setValue(categoryIds);

        if (groupLeadTomSelect) {
            groupLeadTomSelect.setValue(categories.filter(c => c.role === 'lead').map(c => c.id));
        }
    }

    document.getElementById('group-is-default').checked = !!group.is_default;

    openModal('group-modal');
}

async function deleteGroup(id) {
    if (!await showConfirm('Are you sure you want to delete this group?')) return;

    try {
        const response = await fetch(`${API_BASE_URL}/admin/groups/${id}`, { method: 'DELETE' });
        if (response.ok) {
            loadGroups();
        } else {
            const err = await response.json();
            showAlert(err.error || 'Failed to delete group');
        }
    } catch (err) {
        console.error('Error deleting group:', err);
    }
}

let groupCategoriesTomSelect;

async function loadCategoriesForGroupModal() {
    try {
        const response = await fetch(`${API_BASE_URL}/categories`);
        const categories = await response.json();
        
        const select = document.getElementById('group-categories-select');
        select.innerHTML = '';
        categories.forEach(cat => {
            const opt = document.createElement('option');
            opt.value = cat.id; // Send ID to backend
            opt.textContent = cat.name;
            select.appendChild(opt);
        });

        if (groupCategoriesTomSelect) {
            groupCategoriesTomSelect.destroy();
        }

        groupCategoriesTomSelect = new TomSelect('#group-categories-select', {
            plugins: ['remove_button'],
            create: false,
            placeholder: 'Select categories...',
            maxItems: null,
            valueField: 'value',
            labelField: 'text',
            searchField: 'text',
            onInitialize: function() {
                this.wrapper.style.width = '100%';
            }
        });

        // Lead picker, populated from the same category list. A group can be
        // assigned many categories but lead only some of them.
        const leadSelect = document.getElementById('group-lead-select');
        leadSelect.innerHTML = '';
        categories.forEach(cat => {
            const opt = document.createElement('option');
            opt.value = cat.id;
            opt.textContent = cat.name;
            leadSelect.appendChild(opt);
        });

        if (groupLeadTomSelect) groupLeadTomSelect.destroy();
        groupLeadTomSelect = new TomSelect('#group-lead-select', {
            plugins: ['remove_button'],
            create: false,
            placeholder: 'Categories this group is accountable for...',
            maxItems: null,
            valueField: 'value',
            labelField: 'text',
            searchField: 'text',
            onInitialize: function() {
                this.wrapper.style.width = '100%';
            }
        });

    } catch (err) {
        console.error('Error loading categories:', err);
    }
}

function resetGroupForm() {
    document.getElementById('group-form').reset();
    document.getElementById('edit-group-id').value = '';
    document.getElementById('group-error').style.display = 'none';
    if (groupCategoriesTomSelect) {
        groupCategoriesTomSelect.clear();
    }
    if (groupLeadTomSelect) {
        groupLeadTomSelect.clear();
    }
    document.getElementById('group-is-default').checked = false;
}


// ==========================================
// UTILITY FUNCTIONS
// ==========================================

function openModal(id) {
    document.getElementById(id).classList.add('active');
}

function closeModal(id) {
    document.getElementById(id).classList.remove('active');
}

// Shared closeModal for onclick
window.closeModal = closeModal;
// ==========================================
// PENALTY FUNCTIONS
// ==========================================


function penalizeUser(user) {
    document.getElementById('penalty-form').reset();
    document.getElementById('penalty-user-id').value = user.id;
    document.getElementById('penalty-user-name').textContent = user.name || 'User';
    
    // Reset message box style
    const msgDiv = document.getElementById('penalty-error');
    msgDiv.style.display = 'none';
    msgDiv.style.background = 'rgba(239, 68, 68, 0.1)';
    msgDiv.style.color = 'var(--admin-danger)';
    
    openModal('penalty-modal');
}

async function handlePenaltySubmit(e) {
    e.preventDefault();
    const id = document.getElementById('penalty-user-id').value;
    const amount = document.getElementById('penalty-amount').value;
    const reason = document.getElementById('penalty-reason').value;

    const msgDiv = document.getElementById('penalty-error');



    try {
        const response = await fetch(`${API_BASE_URL}/admin/users/${id}/penalize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount, reason })
        });

        if (response.ok) {
            // Show success message
            msgDiv.textContent = 'User penalized successfully.';
            msgDiv.style.background = 'rgba(34, 197, 94, 0.1)'; // Green background
            msgDiv.style.color = 'var(--admin-success)'; // Green text
            msgDiv.style.display = 'block';

            // Close modal after delay
            setTimeout(() => {
                closeModal('penalty-modal');
                loadUsers();
            }, 1500);
        } else {
            const err = await response.json();
            msgDiv.textContent = err.message || 'Failed to penalize user';
            msgDiv.style.background = 'rgba(239, 68, 68, 0.1)'; // Red background
            msgDiv.style.color = 'var(--admin-danger)'; // Red text
            msgDiv.style.display = 'block';
        }
    } catch (err) {
        console.error('Error penalizing user:', err);
    }
}

window.penalizeUser = penalizeUser;

// ── Category management ──────────────────────────────────────────────────────
//
// Categories decide how a report is classified and which MDA is alerted, so the
// table shows both sides of that: which MDAs a category routes to, and how many
// reports already use it. The second number is what makes a delete safe or not.

let allCategoriesCache = [];

async function loadCategoryAdmin() {
    try {
        const [catRes, groupRes, issueRes] = await Promise.all([
            fetch(`${API_BASE_URL}/categories`),
            fetch(`${API_BASE_URL}/admin/groups`),
            fetch(`${API_BASE_URL}/issues?limit=10000&include_spam=true`)
        ]);

        if (!catRes.ok) {
            renderLoadError('category-list', 4, catRes.status);
            return;
        }

        const categories = await catRes.json();
        const groups = groupRes.ok ? await groupRes.json() : [];
        const issuePayload = issueRes.ok ? await issueRes.json() : { data: [] };
        const issues = issuePayload.data || issuePayload.issues || [];

        // Count reports per category so an admin can see what a delete affects.
        const usage = {};
        issues.forEach((i) => {
            if (i.category) usage[i.category] = (usage[i.category] || 0) + 1;
        });

        // Invert the group mapping: the API gives categories per group.
        const mdasByCategory = {};
        (Array.isArray(groups) ? groups : []).forEach((g) => {
            const cats = Array.isArray(g.categories) ? g.categories : [];
            cats.forEach((c) => {
                if (!mdasByCategory[c.id]) mdasByCategory[c.id] = [];
                mdasByCategory[c.id].push({ name: g.name, role: c.role });
            });
        });

        allCategoriesCache = categories;

        // /api/categories is public -- the bot and the civic map both need the
        // full list -- so an MDA's view is narrowed here, using the groups
        // response, which the API has already scoped to their institution.
        const visible = isFullAdmin()
            ? categories
            : categories.filter((c) => (mdasByCategory[c.id] || []).length > 0);

        // Decorate once, then search/filter/sort/paginate off this in the
        // browser rather than re-fetching for every keystroke.
        categoryView.rows = visible.map((cat) => ({
            ...cat,
            mdas: mdasByCategory[cat.id] || [],
            reportCount: usage[cat.name] || 0,
        }));
        applyCategoryView();
    } catch (err) {
        console.error('Error loading categories:', err);
        renderLoadError('category-list', 4);
    }
}

// ── Category list: search, filter, sort, paginate ────────────────────────────
//
// Done in the browser rather than the API: the whole list is small (tens of
// rows, not thousands) and is already fetched to compute MDA assignments and
// report counts. Paging server-side would mean three round trips per keystroke
// for no benefit at this size. Revisit if the list ever grows into the hundreds.

const CATEGORY_PAGE_SIZE = 10;

let categoryView = {
    rows: [],          // decorated categories: {...cat, mdas, reportCount}
    search: '',
    filter: 'all',
    sort: 'name',
    page: 1,
};

function applyCategoryView() {
    const term = categoryView.search.trim().toLowerCase();

    let rows = categoryView.rows.filter((row) => {
        if (term) {
            const haystack = `${row.name} ${row.mdas.map((m) => m.name).join(' ')}`.toLowerCase();
            if (!haystack.includes(term)) return false;
        }
        switch (categoryView.filter) {
            case 'assigned':   return row.mdas.length > 0;
            case 'unassigned': return row.mdas.length === 0;
            case 'in_use':     return row.reportCount > 0;
            case 'unused':     return row.reportCount === 0;
            default:           return true;
        }
    });

    rows = rows.slice().sort((a, b) => {
        if (categoryView.sort === 'reports') return b.reportCount - a.reportCount || a.name.localeCompare(b.name);
        if (categoryView.sort === 'unassigned_first') {
            const diff = (a.mdas.length === 0 ? 0 : 1) - (b.mdas.length === 0 ? 0 : 1);
            return diff || a.name.localeCompare(b.name);
        }
        return a.name.localeCompare(b.name);
    });

    const totalPages = Math.max(1, Math.ceil(rows.length / CATEGORY_PAGE_SIZE));
    // A filter that shrinks the list can leave the current page past the end.
    if (categoryView.page > totalPages) categoryView.page = totalPages;

    const start = (categoryView.page - 1) * CATEGORY_PAGE_SIZE;
    const pageRows = rows.slice(start, start + CATEGORY_PAGE_SIZE);

    renderCategoryRows(pageRows, rows.length === 0);
    renderCategoryPagination(rows.length, totalPages, start, pageRows.length);
}

function renderCategoryPagination(total, totalPages, start, shown) {
    const info = document.getElementById('category-pagination-info');
    const numbers = document.getElementById('category-pagination-numbers');
    const prev = document.getElementById('category-prev-page');
    const next = document.getElementById('category-next-page');
    if (!info || !numbers) return;

    info.textContent = total === 0
        ? 'No categories match'
        : `Showing ${start + 1}–${start + shown} of ${total} categor${total === 1 ? 'y' : 'ies'}`;

    numbers.innerHTML = '';
    for (let p = 1; p <= totalPages; p++) {
        const btn = document.createElement('button');
        btn.className = 'action-btn';
        btn.textContent = p;
        if (p === categoryView.page) {
            btn.style.background = 'var(--admin-primary)';
            btn.style.color = '#fff';
        }
        btn.addEventListener('click', () => {
            categoryView.page = p;
            applyCategoryView();
        });
        numbers.appendChild(btn);
    }

    if (prev) prev.disabled = categoryView.page <= 1;
    if (next) next.disabled = categoryView.page >= totalPages;
    [prev, next].forEach((b) => { if (b) b.style.opacity = b.disabled ? '0.4' : '1'; });
}

function renderCategoryRows(rows, noMatches) {
    const list = document.getElementById('category-list');
    list.innerHTML = '';

    if (noMatches) {
        list.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:2rem; color:var(--admin-text-muted);">No categories match your search or filter</td></tr>';
        return;
    }

    rows.forEach((cat) => {
        // An unmapped category is not broken -- default recipients cover it --
        // but it is configuration still to do, so it is called out.
        const mdaHtml = cat.mdas.length
            ? cat.mdas.map((m) => `<span style="background: rgba(37,99,235,0.1); color: var(--admin-primary); border:1px solid rgba(37,99,235,0.2); padding:3px 8px; border-radius:12px; font-size:0.75rem; font-weight:600; margin-right:6px; display:inline-block;">${escapeHtml(m.name)}${m.role === 'lead' ? ' · lead' : ''}</span>`).join('')
            : '<span style="color: var(--admin-warning); font-size: 0.8rem;">Not assigned — goes to default recipients</span>';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td data-label="Category">
                <span style="display:inline-flex; align-items:center; gap:8px;">
                    <i class="fa-solid ${cat.icon || 'fa-tag'}" style="color: ${cat.color || '#64748b'};"></i>
                    <strong>${escapeHtml(cat.name)}</strong>
                </span>
            </td>
            <td data-label="Assigned MDAs">${mdaHtml}</td>
            <td data-label="Reports">${cat.reportCount}</td>
            <td data-label="Actions" style="text-align: right;" ${isFullAdmin() ? '' : 'data-admin-only'}>
                <button class="action-btn" title="Edit" onclick='editCategory(${JSON.stringify({ id: cat.id, name: cat.name, icon: cat.icon, color: cat.color, examples: cat.examples }).replace(/'/g, "&#39;")})'>
                    <i class="fa-solid fa-pen"></i>
                </button>
                <button class="action-btn" title="${cat.reportCount > 0 ? 'In use by ' + cat.reportCount + ' report(s)' : 'Delete'}"
                        onclick="deleteCategory(${cat.id}, '${String(cat.name).replace(/'/g, "\\'")}', ${cat.reportCount})"
                        ${cat.reportCount > 0 ? 'style="opacity:0.4;"' : ''}>
                    <i class="fa-solid fa-trash"></i>
                </button>
            </td>`;
        list.appendChild(tr);
    });

    applyRoleVisibilityTo(list);
}

function openCategoryModal() {
    document.getElementById('category-form').reset();
    document.getElementById('edit-category-id').value = '';
    document.getElementById('category-modal-title').textContent = 'Create Category';
    document.getElementById('category-icon').value = 'fa-tag';
    document.getElementById('category-color').value = '#64748b';
    document.getElementById('category-examples').value = '';
    document.getElementById('category-error').style.display = 'none';
    openModal('category-modal');
}

function editCategory(cat) {
    document.getElementById('category-form').reset();
    document.getElementById('edit-category-id').value = cat.id;
    document.getElementById('category-modal-title').textContent = 'Edit Category';
    document.getElementById('category-name').value = cat.name;
    document.getElementById('category-icon').value = cat.icon || 'fa-tag';
    document.getElementById('category-color').value = cat.color || '#64748b';
    document.getElementById('category-examples').value = cat.examples || '';
    document.getElementById('category-error').style.display = 'none';
    openModal('category-modal');
}

async function handleCategorySubmit(e) {
    e.preventDefault();
    const id = document.getElementById('edit-category-id').value;
    const name = document.getElementById('category-name').value.trim();
    const icon = document.getElementById('category-icon').value.trim();
    const color = document.getElementById('category-color').value;
    const examples = document.getElementById('category-examples').value;
    const errorEl = document.getElementById('category-error');

    try {
        const response = await fetch(
            id ? `${API_BASE_URL}/admin/categories/${id}` : `${API_BASE_URL}/admin/categories`,
            {
                method: id ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, icon, color, examples })
            }
        );
        const data = await response.json();

        if (response.ok && data.success) {
            closeModal('category-modal');
            // The classifier reload can fail independently of the save; if it
            // did, the category exists but nothing will be assigned to it yet.
            if (data.classifier_updated === false) {
                showAlert('Category saved, but the AI service could not be refreshed. '
                    + 'It will pick up the change on its next restart.');
            }
            loadCategoryAdmin();
        } else {
            errorEl.textContent = data.error || 'Failed to save category';
            errorEl.style.display = 'block';
        }
    } catch (err) {
        errorEl.textContent = 'Connection error';
        errorEl.style.display = 'block';
    }
}

async function deleteCategory(id, name, count) {
    if (count > 0) {
        showAlert(`"${name}" is used by ${count} report(s). Reassign those reports before deleting it.`);
        return;
    }
    if (!await showConfirm(`Delete the category "${name}"? This also removes its MDA assignments.`)) return;

    try {
        const response = await fetch(`${API_BASE_URL}/admin/categories/${id}`, { method: 'DELETE' });
        const data = await response.json();
        if (response.ok && data.success) {
            loadCategoryAdmin();
        } else {
            showAlert(data.error || 'Could not delete the category.');
        }
    } catch (err) {
        showAlert('Connection error while deleting the category.');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const addBtn = document.getElementById('btn-add-category');
    if (addBtn) addBtn.addEventListener('click', openCategoryModal);

    const form = document.getElementById('category-form');
    if (form) form.addEventListener('submit', handleCategorySubmit);

    const search = document.getElementById('category-search');
    if (search) {
        search.addEventListener('input', debounce(() => {
            categoryView.search = search.value;
            categoryView.page = 1;   // a new search starts at the beginning
            applyCategoryView();
        }, 250));
    }

    ['category-filter-assignment', 'category-sort'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', () => {
            categoryView.filter = document.getElementById('category-filter-assignment').value;
            categoryView.sort = document.getElementById('category-sort').value;
            categoryView.page = 1;
            applyCategoryView();
        });
    });

    const reset = document.getElementById('category-reset-filters');
    if (reset) {
        reset.addEventListener('click', () => {
            document.getElementById('category-search').value = '';
            document.getElementById('category-filter-assignment').value = 'all';
            document.getElementById('category-sort').value = 'name';
            categoryView = { ...categoryView, search: '', filter: 'all', sort: 'name', page: 1 };
            applyCategoryView();
        });
    }

    const prev = document.getElementById('category-prev-page');
    if (prev) prev.addEventListener('click', () => {
        if (categoryView.page > 1) { categoryView.page--; applyCategoryView(); }
    });

    const next = document.getElementById('category-next-page');
    if (next) next.addEventListener('click', () => {
        categoryView.page++; applyCategoryView();
    });
});


// ── Administrative audit log ─────────────────────────────────────────────────
//
// Separate from a report's own timeline, which records what happened to that
// report. This records what happened to the platform: who was given an account,
// whose role changed, which MDA had its categories altered, who signed in, who
// exported data. Those are the actions that decide who can see what.

const AUDIT_ACTION_LABELS = {
    'user.create': 'Account created',
    'user.update': 'Account changed',
    'user.delete': 'Account deleted',
    'group.create': 'MDA created',
    'group.update': 'MDA changed',
    'group.delete': 'MDA deleted',
    'category.create': 'Category created',
    'category.update': 'Category changed',
    'category.delete': 'Category deleted',
    'auth.login': 'Signed in',
    'auth.login_failed': 'Sign-in refused',
    'export.issues': 'Reports exported',
    'export.audit': 'Audit log exported',
    'export.refused': 'Export refused'
};

async function loadAuditLog() {
    const list = document.getElementById('audit-list');
    if (!list) return;

    try {
        const res = await fetch(`${API_BASE_URL}/admin/audit?limit=200`);
        if (!res.ok) {
            renderLoadError('audit-list', 5, res.status);
            return;
        }

        const entries = await res.json();
        list.innerHTML = '';

        if (!Array.isArray(entries) || entries.length === 0) {
            list.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:2rem; color:var(--admin-text-muted);">No administrative activity recorded yet</td></tr>';
            return;
        }

        entries.forEach((entry) => {
            // Refusals and deletions are the entries someone scanning this page
            // is looking for, so they are the ones that catch the eye.
            const refused = entry.action === 'auth.login_failed'
                || entry.action === 'export.refused'
                || (entry.detail || '').startsWith('REFUSED');
            const destructive = entry.action.endsWith('.delete');
            const colour = refused ? 'var(--admin-danger)'
                : destructive ? 'var(--admin-warning)'
                : 'var(--admin-text)';

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td data-label="When" style="white-space: nowrap; color: var(--admin-text-muted); font-size: 0.85rem;">
                    ${new Date(entry.created_at).toLocaleString('en-GB')}
                </td>
                <td data-label="Who">${entry.actor_name ? escapeHtml(entry.actor_name) : '<span style="color: var(--admin-text-muted);">unauthenticated</span>'}</td>
                <td data-label="Action" style="color: ${colour}; font-weight: 600;">
                    ${AUDIT_ACTION_LABELS[entry.action] || entry.action}
                </td>
                <td data-label="Target">${entry.target_label ? escapeHtml(entry.target_label) : (entry.target_id ? `#${escapeHtml(entry.target_id)}` : '—')}</td>
                <td data-label="Detail" style="color: var(--admin-text-muted); font-size: 0.85rem; max-width: 380px;">
                    ${escapeHtml(entry.detail) || '—'}
                </td>`;
            list.appendChild(tr);
        });
    } catch (err) {
        console.error('Error loading audit log:', err);
        renderLoadError('audit-list', 5);
    }
}

async function exportAuditLog() {
    try {
        const res = await fetch(`${API_BASE_URL}/admin/export/audit.csv`);
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            showAlert(body.message || `Export failed (${res.status}).`);
            return;
        }
        const blob = await res.blob();
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `fixam-audit-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(link.href);
    } catch (err) {
        showAlert('Connection error while exporting the audit log.');
    }
}
