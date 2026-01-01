// Theme Management
function initTheme() {
    const savedTheme = localStorage.getItem('theme');
    const toggleBtn = document.getElementById('theme-toggle');
    const adminToggleBtn = document.getElementById('theme-toggle-admin');
    const icon = toggleBtn ? toggleBtn.querySelector('i') : null;
    const adminIcon = adminToggleBtn ? adminToggleBtn.querySelector('i') : null;

    // Apply saved theme
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-mode');
        if (icon) icon.className = 'fa-solid fa-sun';
        if (adminIcon) adminIcon.className = 'fa-solid fa-sun';
    } else {
        document.body.classList.remove('dark-mode');
        if (icon) icon.className = 'fa-solid fa-moon';
        if (adminIcon) adminIcon.className = 'fa-solid fa-moon';
    }

    // Regular toggle button handler
    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            document.body.classList.toggle('dark-mode');
            const isDark = document.body.classList.contains('dark-mode');
            localStorage.setItem('theme', isDark ? 'dark' : 'light');
            
            if (icon) {
                icon.className = isDark ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
            }
            // Dispatch event for map to update
            window.dispatchEvent(new CustomEvent('themeChanged', { detail: { isDark } }));
        });
    }

    // Admin toggle button handler
    if (adminToggleBtn) {
        adminToggleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            document.body.classList.toggle('dark-mode');
            const isDark = document.body.classList.contains('dark-mode');
            localStorage.setItem('theme', isDark ? 'dark' : 'light');
            
            const icon = adminToggleBtn.querySelector('i');
            if (icon) {
                icon.className = isDark ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
            }
            
            // Dispatch custom event for admin page to update map
            window.dispatchEvent(new CustomEvent('themeChanged', { detail: { isDark } }));
        });
    }
}

// Initialize on load
document.addEventListener('DOMContentLoaded', initTheme);
