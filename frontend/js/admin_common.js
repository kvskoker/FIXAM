const API_BASE_URL = window.location.port === '3000' 
    ? `http://${window.location.hostname}:5000/api`
    : '/api';

function checkAuth(callback) {
    const adminUser = localStorage.getItem('fixam_admin_user');
    if (adminUser) {
        showDashboard();
        if (callback) callback();
    } else {
        showLogin();
    }
}

function showLogin() {
    document.getElementById('login-overlay').classList.remove('hidden');
    document.getElementById('admin-container').classList.add('hidden');
}

function showDashboard() {
    document.getElementById('login-overlay').classList.add('hidden');
    document.getElementById('admin-container').classList.remove('hidden');
    
    // Display Admin Info
    const adminUser = JSON.parse(localStorage.getItem('fixam_admin_user'));
    if (adminUser) {
        // Role priority: Admin > Operations > User
        let displayRole = 'User';
        const roles = adminUser.roles || [adminUser.role];
        
        if (roles.includes('Admin')) {
            displayRole = 'Admin';
        } else if (roles.includes('Operation')) {
            displayRole = 'Operations';
        } else if (roles.includes('User')) {
            displayRole = 'User';
        } else {
            displayRole = roles[0] || 'Administrator';
        }

        document.querySelectorAll('.admin-user-display, #admin-info').forEach(el => {
            el.innerHTML = `
                <div style="text-align: right;">
                    <div style="font-weight: 600;">${adminUser.name || 'Admin'}</div>
                    <div style="font-size: 0.75rem; color: var(--admin-text-muted);">Role: ${displayRole}</div>
                </div>
            `;
        });
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const phone = document.getElementById('admin-phone').value;
    const password = document.getElementById('admin-password').value;
    const errorMsg = document.getElementById('login-error');

    try {
        const response = await fetch(`${API_BASE_URL}/admin/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, password })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            localStorage.setItem('fixam_admin_user', JSON.stringify(data.user));
            location.reload(); // Reload to trigger checkAuth and data loading
        } else {
            errorMsg.textContent = data.message || 'Invalid credentials';
            errorMsg.style.display = 'block';
        }
    } catch (err) {
        console.error('Login error:', err);
        errorMsg.textContent = 'Connection error';
        errorMsg.style.display = 'block';
    }
}

function handleLogout(e) {
    if (e) e.preventDefault();
    localStorage.removeItem('fixam_admin_user');
    location.href = '/admin/overview'; // Redirect to overview (which will show login)
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

function updateURLParams(params) {
    const url = new URL(window.location);
    Object.keys(params).forEach(key => {
        if (params[key] && params[key] !== 'All' && params[key] !== '') {
            url.searchParams.set(key, params[key]);
        } else {
            url.searchParams.delete(key);
        }
    });
    window.history.replaceState({}, '', url);
}

function getURLParams() {
    const params = new URLSearchParams(window.location.search);
    const result = {};
    for (const [key, value] of params.entries()) {
        result[key] = value;
    }
    return result;
}

// Common Event Listeners
document.addEventListener('DOMContentLoaded', () => {
    // Login Form Handler
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', handleLogin);
    }

    // Logout Handler
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', handleLogout);
    }
});
