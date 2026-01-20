// Maintenance Mode Handler & Admin Access Bypass
(async function() {
    // 1. Check if user is logged in as Admin
    const adminUser = localStorage.getItem('fixam_admin_user');

    if (adminUser) {
        // ADMIN DETECTED: Bypass maintenance mode & inject access header
        console.log("Admin detected. Bypassing maintenance mode.");

        const originalFetch = window.fetch;
        window.fetch = function(url, options = {}) {
            options.headers = options.headers || {};
            // Handle both Headers object and plain object
            if (options.headers instanceof Headers) {
                options.headers.append('X-Admin-Access', 'true');
            } else {
                options.headers['X-Admin-Access'] = 'true';
            }
            return originalFetch(url, options);
        };
        return; // Exit, do not show overlay
    }

    // 2. Not Admin: Check backend configuration
    try {
        const port = window.location.port === '3000' ? ':5000' : '';
        const baseUrl = window.location.protocol + '//' + window.location.hostname + port + '/api';
        
        let config;
        try {
            const res = await fetch(`${baseUrl}/config`);
            config = await res.json();
        } catch (err) {
            console.error("Failed to fetch config, assuming open access or backend down", err);
            return;
        }
        
        if (config.dev_mode) {
             // SHOW MAINTENANCE OVERLAY
             const overlay = document.createElement('div');
             overlay.style.position = 'fixed';
             overlay.style.top = '0';
             overlay.style.left = '0';
             overlay.style.width = '100vw';
             overlay.style.height = '100vh';
             overlay.style.backgroundColor = 'rgba(0,0,0,0.95)';
             overlay.style.zIndex = '999999';
             overlay.style.display = 'flex';
             overlay.style.flexDirection = 'column';
             overlay.style.alignItems = 'center';
             overlay.style.justifyContent = 'center';
             overlay.style.color = 'white';
             overlay.style.textAlign = 'center';
             overlay.style.padding = '20px';
             
             overlay.innerHTML = `
                <div style="max-width: 600px; background: #1f2937; padding: 40px; border-radius: 16px; border: 1px solid #374151; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);">
                    <div style="font-size: 64px; margin-bottom: 24px;">🚧</div>
                    <h1 style="font-size: 32px; font-weight: 800; margin-bottom: 16px; color: #f3f4f6;">Maintenance Mode</h1>
                    <p style="font-size: 18px; line-height: 1.6; color: #d1d5db; margin-bottom: 32px;">${config.maintenance_message}</p>
                    <div style="font-size: 14px; color: #9ca3af;">Expected Return: Hackathon Final Event</div>
                </div>
             `;
             
             if (document.body) {
                document.body.appendChild(overlay);
                document.body.style.overflow = 'hidden';
             } else {
                document.addEventListener('DOMContentLoaded', () => {
                    document.body.appendChild(overlay);
                    document.body.style.overflow = 'hidden';
                });
             }
        }
    } catch(e) {
        console.error("Error checking maintenance config", e);
    }
})();
