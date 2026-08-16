const API_BASE_URL = window.location.port === '3000' 
    ? `http://${window.location.hostname}:5000/api`
    : '/api';

const TOKEN_KEY = 'fixam_admin_token';

function getAdminToken() {
    return localStorage.getItem(TOKEN_KEY);
}

/**
 * Attach the session token to every request.
 *
 * This used to send `X-Admin-Access: true`, which was not authentication --
 * any caller could set that header. The token is signed by the server and
 * verified on every admin endpoint.
 */
const LOGIN_PATH = '/admin/overview';

/** Message to show on the login screen after a session ends unexpectedly. */
function setSessionEndedNotice(message) {
    sessionStorage.setItem('fixam_login_notice', message);
}

/**
 * End the session and return to the login screen.
 *
 * A redirect, not just an overlay toggle: leaving the admin page mounted meant
 * its other in-flight requests kept failing behind the login box, and the user
 * sat looking at a dashboard shell with no data.
 */
function endSession(message) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem('fixam_admin_user');
    if (message) setSessionEndedNotice(message);

    if (window.location.pathname !== LOGIN_PATH) {
        window.location.href = LOGIN_PATH;
    } else if (typeof showLogin === 'function') {
        showLogin();
        showLoginNotice();
    }
}

/** Surface any notice left by a session that ended on another page. */
function showLoginNotice() {
    const notice = sessionStorage.getItem('fixam_login_notice');
    if (!notice) return;
    sessionStorage.removeItem('fixam_login_notice');
    const err = document.getElementById('login-error');
    if (err) {
        err.textContent = notice;
        err.style.display = 'block';
    }
}

/**
 * Attach the session token to every request.
 *
 * This used to send `X-Admin-Access: true`, which was not authentication --
 * any caller could set that header. The token is signed by the server and
 * verified on every admin endpoint.
 */
const originalFetch = window.fetch;
window.fetch = function(url, options = {}) {
    const token = getAdminToken();
    if (token) {
        options.headers = options.headers || {};
        if (options.headers instanceof Headers) {
            options.headers.append('Authorization', `Bearer ${token}`);
        } else {
            options.headers['Authorization'] = `Bearer ${token}`;
        }
    }

    // The login request must be exempt. A 401 there means "wrong password", not
    // "session expired" -- handling it below would overwrite the form's own
    // error and tell someone their session had expired when they had simply
    // mistyped a password.
    const isLoginRequest = String(url).includes('/admin/login');

    return originalFetch(url, options).then((response) => {
        if (response.status === 401 && !isLoginRequest) {
            endSession('Your session has expired. Please sign in again.');
        }
        return response;
    });
};

function checkAuth(callback) {
    // The token is what proves a session; a stored user object alone does not.
    const adminUser = localStorage.getItem('fixam_admin_user');
    if (adminUser && getAdminToken()) {
        showDashboard();
        if (callback) callback();
    } else {
        showLogin();
    }
}

function showLogin() {
    document.getElementById('login-overlay').classList.remove('hidden');
    document.getElementById('admin-container').classList.add('hidden');
    showLoginNotice();
}


/** True when the signed-in user holds the full Admin role. */
function isFullAdmin() {
    try {
        const user = JSON.parse(localStorage.getItem('fixam_admin_user') || '{}');
        const roles = user.roles || (user.role ? [user.role] : []);
        return roles.includes('Admin');
    } catch (err) {
        return false;
    }
}

/**
 * Hide controls an MDA user cannot use.
 *
 * The API refuses these actions regardless, but offering a button that always
 * fails is its own kind of broken -- an officer should see the portal that
 * matches their remit, not a fuller one with dead controls.
 */
/**
 * Make user-supplied text safe to put inside HTML.
 *
 * Report titles, descriptions and addresses are written by citizens over
 * WhatsApp and rendered into admin pages with innerHTML. Without this, a report
 * titled `<img src=x onerror=...>` runs script in the browser of every official
 * who opens the issue list -- a citizen reaching into government machines.
 *
 * Escapes quotes as well as angle brackets, because several of these values are
 * interpolated into attributes (alt, title) where a quote alone breaks out.
 */
function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Show why a table is empty instead of leaving it blank.
 *
 * A failed request used to reach the renderer as `undefined`, which threw and
 * left the page silently empty -- indistinguishable from "no records".
 */
function renderLoadError(elementId, colspan, status) {
    const list = document.getElementById(elementId);
    if (!list) return;
    const message = status === 401
        ? 'Your session has expired. Please sign in again.'
        : status === 403
            ? 'You do not have permission to view this.'
            : 'Could not load this data. Please retry.';
    list.innerHTML = `<tr><td colspan="${colspan}" style="text-align: center; padding: 2rem; color: var(--admin-text-muted);">${message}</td></tr>`;
}

function applyRoleVisibilityTo(root) {
    if (isFullAdmin()) return;
    (root || document).querySelectorAll('[data-admin-only]').forEach((el) => {
        el.style.display = 'none';
    });
}

function applyRoleVisibility() {
    if (isFullAdmin()) return;

    ['btn-add-user', 'btn-add-group', 'btn-add-category'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });

    applyRoleVisibilityTo(document);

    // Say why the view is narrower, rather than leaving it looking incomplete.
    const main = document.querySelector('.admin-main');
    if (main && !document.getElementById('mda-scope-banner')) {
        const user = JSON.parse(localStorage.getItem('fixam_admin_user') || '{}');
        const banner = document.createElement('div');
        banner.id = 'mda-scope-banner';
        banner.style.cssText = 'background: rgba(37,99,235,0.08); border: 1px solid rgba(37,99,235,0.25); color: var(--admin-text); padding: 0.6rem 1rem; border-radius: 6px; margin-bottom: 1rem; font-size: 0.88rem;';
        banner.innerHTML = `<i class="fa-solid fa-circle-info" style="color: var(--admin-primary);"></i>
            You are signed in as <strong>${user.name || 'an MDA user'}</strong>. You can see and manage
            reports in the categories assigned to your institution.`;
        main.insertBefore(banner, main.firstChild);
    }
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

        applyRoleVisibility();

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

/**
 * Reveal the second-factor field, and say how to get a code.
 *
 * Built here rather than in the markup because five pages carry the sign-in
 * form; one place to change beats five places to forget.
 */
async function showOtpStep(message) {
    let wrapper = document.getElementById('otp-step');

    if (!wrapper) {
        const form = document.getElementById('login-form');
        const submit = form.querySelector('button[type="submit"]');

        wrapper = document.createElement('div');
        wrapper.id = 'otp-step';
        wrapper.style.cssText = 'text-align: left; margin-top: 0.5rem;';

        // The number is fetched rather than hardcoded: a deployment that
        // changes its WhatsApp number should not need a code change to keep
        // its own sign-in instructions accurate.
        let botNumber = '';
        try {
            const res = await fetch(`${API_BASE_URL}/config`);
            if (res.ok) botNumber = (await res.json())?.instance?.bot_number || '';
        } catch (err) { /* the instructions still make sense without it */ }

        const target = botNumber
            ? `<a href="https://wa.me/${botNumber}?text=LOGIN" target="_blank" rel="noopener" style="color: var(--admin-primary); font-weight: 600;">+${botNumber}</a>`
            : 'the FIXAM WhatsApp number';

        wrapper.innerHTML = `
            <div style="background: rgba(37,99,235,0.08); border: 1px solid rgba(37,99,235,0.25);
                        border-radius: 8px; padding: 0.75rem 0.9rem; margin-bottom: 0.75rem; font-size: 0.85rem;">
                <i class="fa-brands fa-whatsapp" style="color: #25D366;"></i>
                Send <strong>LOGIN</strong> to ${target} and it will reply with a 6-digit code.
            </div>
            <input type="text" id="admin-otp" placeholder="6-digit code" inputmode="numeric"
                   autocomplete="one-time-code" maxlength="6"
                   style="width: 100%; letter-spacing: 0.3em; text-align: center; font-size: 1.1rem;">`;

        form.insertBefore(wrapper, submit);
        submit.textContent = 'Verify and Sign In';
    }

    const field = document.getElementById('admin-otp');
    field.value = '';
    field.focus();

    if (message) {
        const errorMsg = document.getElementById('login-error');
        errorMsg.textContent = message;
        errorMsg.style.display = 'block';
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const phone = document.getElementById('admin-phone').value;
    const password = document.getElementById('admin-password').value;
    const otpField = document.getElementById('admin-otp');
    const otp = otpField ? otpField.value.trim() : '';
    const errorMsg = document.getElementById('login-error');

    try {
        const response = await fetch(`${API_BASE_URL}/admin/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, password, otp })
        });

        const data = await response.json();

        // The password was right and a code is needed. Not a failure -- it is
        // the next step, so it reads as an instruction rather than an error.
        if (!data.success && data.requires_otp) {
            await showOtpStep(data.message);
            return;
        }

        if (response.ok && data.success) {
            localStorage.setItem('fixam_admin_user', JSON.stringify(data.user));
            if (data.token) localStorage.setItem(TOKEN_KEY, data.token);
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
    endSession();
    // endSession only redirects when leaving another page; on the login page
    // itself it just shows the form, so force it for an explicit sign-out.
    if (window.location.pathname === LOGIN_PATH) location.reload();
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

    // Password Toggle Handler
    const togglePassword = document.getElementById('toggle-password');
    const adminPassword = document.getElementById('admin-password');
    if (togglePassword && adminPassword) {
        togglePassword.addEventListener('click', () => {
            const type = adminPassword.getAttribute('type') === 'password' ? 'text' : 'password';
            adminPassword.setAttribute('type', type);
            // Toggle the eye/eye-slash icon
            togglePassword.classList.toggle('fa-eye');
            togglePassword.classList.toggle('fa-eye-slash');
        });
    }
});
