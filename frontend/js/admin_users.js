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
    // Tab Switching
    document.querySelectorAll('.tab-item').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab-item').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            
            const target = tab.dataset.tab;
            if (target === 'users') {
                document.getElementById('tab-users-content').classList.remove('hidden');
                document.getElementById('tab-groups-content').classList.add('hidden');
                loadUsers();
            } else {
                document.getElementById('tab-users-content').classList.add('hidden');
                document.getElementById('tab-groups-content').classList.remove('hidden');
                loadGroups();
            }
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
        const data = await response.json();
        renderUsers(data.data);
        updatePagination(data.pagination);
    } catch (err) {
        console.error('Error loading users:', err);
    }
}

function renderUsers(users) {
    const list = document.getElementById('user-list');
    list.innerHTML = '';

    if (users.length === 0) {
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
                        <div style="font-weight: 500;">${user.name || 'Anonymous'} ${isSelf ? '<span style="color: var(--admin-primary); font-size: 0.75rem; margin-left: 0.5rem;">(You)</span>' : ''}</div>
                    </div>
                </div>
            </td>
            <td data-label="Phone">${user.phone_number}</td>
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
            <td data-label="Actions" style="text-align: right;">
                <div style="display: flex; gap: 0.5rem; justify-content: flex-end;">
                    <button class="action-btn" onclick="editUser(${JSON.stringify(user).replace(/"/g, '&quot;')})" title="Edit User">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    ${!isSelf ? `
                    <button class="action-btn delete" onclick="deleteUser(${user.id})" title="Delete User">
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
    
    const roles = Array.from(document.querySelectorAll('#roles-checkboxes input:checked')).map(cb => cb.value);
    const groups = Array.from(document.getElementById('groups-select').selectedOptions).map(opt => opt.value);

    // Get current admin ID from localStorage
    const adminUser = JSON.parse(localStorage.getItem('fixam_admin_user'));
    const admin_id = adminUser ? adminUser.id : null;

    const data = { name, phone_number, password, is_disabled, roles, groups, admin_id };
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
    if (!confirm('Are you sure you want to delete this user? This cannot be undone.')) return;

    // Get current admin ID from localStorage
    const adminUser = JSON.parse(localStorage.getItem('fixam_admin_user'));
    const admin_id = adminUser ? adminUser.id : null;

    try {
        const response = await fetch(`${API_BASE_URL}/admin/users/${id}?admin_id=${admin_id}`, { method: 'DELETE' });
        if (response.ok) {
            loadUsers();
        } else {
            const err = await response.json();
            alert(err.error || 'Failed to delete user');
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

async function loadGroups() {
    try {
        const response = await fetch(`${API_BASE_URL}/admin/groups`);
        const groups = await response.json();
        renderGroups(groups);
        populateGroupsCheckboxes(groups);
    } catch (err) {
        console.error('Error loading groups:', err);
    }
}

function renderGroups(groups) {
    const list = document.getElementById('group-list');
    list.innerHTML = '';

    groups.forEach(group => {
        const categories = Array.isArray(group.categories) ? group.categories : JSON.parse(group.categories || '[]');
        const categoriesHtml = categories.length > 0
            ? categories.map(c => `<span class="badge" style="background: rgba(37, 99, 235, 0.1); color: var(--admin-primary); border: 1px solid rgba(37, 99, 235, 0.2); margin-right: 6px; padding: 3px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; display: inline-block; margin-bottom: 4px;">${c.name}</span>`).join('')
            : '<span style="color: var(--admin-text-muted); font-style: italic;">None</span>';

        const row = document.createElement('tr');
        row.innerHTML = `
            <td data-label="Group Name" style="font-weight: 600; color: var(--admin-primary);">${group.name}</td>
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
            <td data-label="Actions" style="text-align: right;">
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

    const method = id ? 'PUT' : 'POST';
    const url = id ? `${API_BASE_URL}/admin/groups/${id}` : `${API_BASE_URL}/admin/groups`;

    try {
        const response = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description, categories })
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
    }
    
    openModal('group-modal');
}

async function deleteGroup(id) {
    if (!confirm('Are you sure you want to delete this group?')) return;

    try {
        const response = await fetch(`${API_BASE_URL}/admin/groups/${id}`, { method: 'DELETE' });
        if (response.ok) {
            loadGroups();
        } else {
            const err = await response.json();
            alert(err.error || 'Failed to delete group');
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
