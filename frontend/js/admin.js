document.addEventListener('DOMContentLoaded', () => {
    checkAuth();
    
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

    // Navigation Handlers
    document.getElementById('nav-overview').addEventListener('click', (e) => switchView(e, 'overview'));
    document.getElementById('nav-issues').addEventListener('click', (e) => switchView(e, 'issues'));

    // Issue Filters
    document.getElementById('issue-search').addEventListener('input', debounce(loadIssues, 500));
    document.getElementById('issue-filter-status').addEventListener('change', loadIssues);

    // Modal Close
    document.getElementById('close-modal').addEventListener('click', closeModal);
    
    // Listen for theme changes to update map
    window.addEventListener('themeChanged', () => {
        if (map) {
            // Re-render the heatmap with new theme
            loadDashboardData();
        }
    });
});

const API_BASE_URL = 'http://localhost:5000/api'; // Adjust if needed
let currentIssueId = null;

function switchView(e, viewName) {
    e.preventDefault();
    
    // Update Nav
    document.querySelectorAll('.admin-nav-item').forEach(el => el.classList.remove('active'));
    e.currentTarget.classList.add('active');

    // Update View
    document.getElementById('view-overview').classList.add('hidden');
    document.getElementById('view-issues').classList.add('hidden');
    
    document.getElementById(`view-${viewName}`).classList.remove('hidden');

    if (viewName === 'issues') {
        loadIssues();
    }
}

function checkAuth() {
    const adminUser = localStorage.getItem('fixam_admin_user');
    if (adminUser) {
        showDashboard();
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
    loadDashboardData();
}

async function handleLogin(e) {
    e.preventDefault();
    const phone = document.getElementById('admin-phone').value;
    const password = document.getElementById('admin-password').value;
    const errorMsg = document.getElementById('login-error');

    // Simple validation as requested: phone number as username and password
    // In a real app, this should be a proper auth request to backend
    // For this task, we'll verify with backend if the user exists and is an admin (or just verify credentials)
    
    try {
        const response = await fetch(`${API_BASE_URL}/admin/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, password })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            localStorage.setItem('fixam_admin_user', JSON.stringify(data.user));
            showDashboard();
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
    e.preventDefault();
    localStorage.removeItem('fixam_admin_user');
    showLogin();
}

async function loadDashboardData() {
    try {
        // Fetch Stats
        const statsRes = await fetch(`${API_BASE_URL}/admin/stats`);
        const stats = await statsRes.json();
        
        updateStats(stats);
        
        // Fetch Categories for Chart
        const catRes = await fetch(`${API_BASE_URL}/issues`); // Reusing existing endpoint for now, or create specific stats one
        const issues = await catRes.json();
        
        renderCategoryChart(issues);
        renderHeatmap(issues);
        
        // Fetch Insights (Mocked for now or from backend)
        const insights = generateMockInsights(stats, issues);
        renderInsights(insights);

    } catch (err) {
        console.error('Error loading dashboard data:', err);
    }
}

function updateStats(stats) {
    document.getElementById('total-reports').textContent = stats.total_reports_week || 0;
    document.getElementById('reports-trend').textContent = (stats.reports_change_pct || 0) + '%';
    
    document.getElementById('resolved-issues').textContent = stats.resolved_issues || 0;
    document.getElementById('resolution-rate').textContent = (stats.resolution_rate || 0) + '%';
    
    document.getElementById('critical-pending').textContent = stats.critical_pending || 0;
    
    // Mock Sentiment for now if not in stats
    document.getElementById('sentiment-score').textContent = stats.sentiment_score || 'Neutral';
}

let map;
let heatLayer;

function renderHeatmap(issues) {
    const isDarkMode = document.body.classList.contains('dark-mode');
    
    if (!map) {
        map = L.map('map-heatmap').setView([8.4657, -13.2317], 13); // Freetown
        
        // Add tile layer based on theme
        const tileUrl = isDarkMode 
            ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
            : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
        
        L.tileLayer(tileUrl, {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
            subdomains: 'abcd',
            maxZoom: 20
        }).addTo(map);
    } else {
        // Update tile layer when theme changes
        map.eachLayer(layer => {
            if (layer instanceof L.TileLayer) {
                map.removeLayer(layer);
            }
        });
        
        const tileUrl = isDarkMode 
            ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
            : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
        
        L.tileLayer(tileUrl, {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
            subdomains: 'abcd',
            maxZoom: 20
        }).addTo(map);
    }

    // Prepare heatmap data: [lat, lng, intensity]
    // Intensity can be based on upvotes
    const heatData = issues
        .filter(i => i.latitude && i.longitude)
        .map(i => [
            parseFloat(i.latitude), 
            parseFloat(i.longitude), 
            Math.min((i.upvotes || 0) / 10, 1) // Normalize intensity
        ]);

    if (heatLayer) {
        map.removeLayer(heatLayer);
    }

    if (heatData.length > 0) {
        heatLayer = L.heatLayer(heatData, {
            radius: 25,
            blur: 15,
            maxZoom: 17,
        }).addTo(map);
    }
    
    // Invalidate size to fix any rendering issues
    setTimeout(() => {
        if (map) map.invalidateSize();
    }, 100);
}

let categoryChart;

function renderCategoryChart(issues) {
    const ctx = document.getElementById('categoryChart').getContext('2d');
    
    // Process data
    const categoryCounts = {};
    issues.forEach(i => {
        const cat = i.category || 'Uncategorized';
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    });

    const labels = Object.keys(categoryCounts);
    const data = Object.values(categoryCounts);

    if (categoryChart) {
        categoryChart.destroy();
    }

    categoryChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: data,
                backgroundColor: [
                    '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'
                ],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'right',
                    labels: {
                        color: '#94a3b8'
                    }
                }
            }
        }
    });
}

// ==========================================
// ISSUE MANAGEMENT
// ==========================================

async function loadIssues() {
    const search = document.getElementById('issue-search').value;
    const status = document.getElementById('issue-filter-status').value;
    
    let url = `${API_BASE_URL}/issues?sort=newest`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    if (status) url += `&status=${status}`;

    try {
        const res = await fetch(url);
        const issues = await res.json();
        renderIssuesTable(issues);
    } catch (err) {
        console.error('Error loading issues:', err);
    }
}

function renderIssuesTable(issues) {
    const tbody = document.getElementById('issues-table-body');
    tbody.innerHTML = '';

    issues.forEach(issue => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--admin-border)';
        
        const statusColors = {
            'critical': 'var(--admin-danger)',
            'progress': 'var(--admin-warning)',
            'fixed': 'var(--admin-success)',
            'acknowledged': 'var(--admin-primary)'
        };

        tr.innerHTML = `
            <td style="padding: 1rem; font-family: monospace;">${issue.ticket_id || 'N/A'}</td>
            <td style="padding: 1rem;">${issue.category}</td>
            <td style="padding: 1rem; font-weight: 500;">${issue.title}</td>
            <td style="padding: 1rem; color: var(--admin-text-muted);">${issue.lat}, ${issue.lng}</td>
            <td style="padding: 1rem;">${issue.upvotes || 0}</td>
            <td style="padding: 1rem;">
                <span style="color: ${statusColors[issue.status] || 'white'}; font-weight: 600; text-transform: capitalize;">
                    ${issue.status}
                </span>
            </td>
            <td style="padding: 1rem; color: var(--admin-text-muted); font-size: 0.9rem;">
                ${new Date(issue.created_at).toLocaleDateString()}
            </td>
            <td style="padding: 1rem;">
                <button onclick="openIssueDetails(${issue.id})" style="background: var(--admin-primary); color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer;">
                    Manage
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

async function openIssueDetails(id) {
    currentIssueId = id;
    const modal = document.getElementById('issue-modal');
    modal.classList.remove('hidden');

    try {
        // Fetch Issue Details (re-using list endpoint or could be specific)
        // Since we have the ID, we can find it in the list if we stored it, or fetch fresh.
        // For simplicity, let's fetch the specific issue details if we had an endpoint, 
        // but since we don't have a single issue endpoint, we'll filter from the list or just use the row data if passed.
        // Better: Fetch tracker history which is separate.
        
        // 1. Get Issue Data (We'll fetch all and find one for now, or add GET /issues/:id later)
        const res = await fetch(`${API_BASE_URL}/issues?ticket=${id}`); // Wait, ID is int, ticket is string. 
        // Let's just fetch all and find. Not efficient but works for prototype.
        const allRes = await fetch(`${API_BASE_URL}/issues`);
        const allIssues = await allRes.json();
        const issue = allIssues.find(i => i.id === id);

        if (issue) {
            document.getElementById('modal-ticket').textContent = issue.ticket_id;
            document.getElementById('modal-status').textContent = issue.status;
            document.getElementById('modal-title').textContent = issue.title;
            document.getElementById('modal-desc').textContent = issue.description;
            document.getElementById('modal-location').textContent = `${issue.lat}, ${issue.lng}`;
            document.getElementById('modal-image').src = issue.image_url || 'https://via.placeholder.com/400x200?text=No+Image';
        }

        // 2. Fetch Tracker History
        const trackerRes = await fetch(`${API_BASE_URL}/issues/${id}/tracker`);
        const trackerLogs = await trackerRes.json();
        renderTimeline(trackerLogs);

    } catch (err) {
        console.error('Error opening details:', err);
    }
}

function renderTimeline(logs) {
    const container = document.getElementById('modal-timeline');
    container.innerHTML = '';

    logs.forEach(log => {
        const item = document.createElement('div');
        item.style.marginBottom = '1.5rem';
        item.style.position = 'relative';
        
        item.innerHTML = `
            <div style="position: absolute; left: -1.35rem; top: 0; width: 12px; height: 12px; background: var(--admin-primary); border-radius: 50%; border: 2px solid var(--admin-card-bg);"></div>
            <div style="font-size: 0.85rem; color: var(--admin-text-muted); margin-bottom: 0.25rem;">
                ${new Date(log.created_at).toLocaleString()}
            </div>
            <div style="font-weight: 600; margin-bottom: 0.25rem; text-transform: capitalize;">
                ${log.action.replace('_', ' ')}
            </div>
            <div style="font-size: 0.9rem; color: var(--admin-text-muted);">
                ${log.description}
            </div>
            ${log.performed_by_name ? `<div style="font-size: 0.8rem; color: var(--admin-primary); margin-top: 0.25rem;">By: ${log.performed_by_name}</div>` : ''}
        `;
        container.appendChild(item);
    });
}

function closeModal() {
    document.getElementById('issue-modal').classList.add('hidden');
    currentIssueId = null;
}

async function updateStatus(newStatus) {
    if (!currentIssueId) return;

    const adminUser = JSON.parse(localStorage.getItem('fixam_admin_user'));
    if (!adminUser) return;

    try {
        const res = await fetch(`${API_BASE_URL}/admin/issues/${currentIssueId}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                status: newStatus,
                admin_id: adminUser.id,
                note: `Status updated to ${newStatus} by Admin`
            })
        });

        const data = await res.json();
        if (data.success) {
            // Refresh Modal Details
            openIssueDetails(currentIssueId);
            // Refresh List
            loadIssues();
        } else {
            alert('Failed to update status');
        }
    } catch (err) {
        console.error('Error updating status:', err);
    }
}

// ==========================================
// AI INSIGHTS
// ==========================================

function generateMockInsights(stats, issues) {
    const insights = [];
    
    // Critical areas insight
    const criticalCount = stats.critical_pending || 0;
    if (criticalCount > 0) {
        insights.push({
            type: 'critical',
            icon: 'fa-triangle-exclamation',
            title: 'Critical Issues Detected',
            description: `${criticalCount} critical issues require immediate attention. Priority areas include water infrastructure and road safety.`
        });
    }
    
    // Trending categories
    const categoryCounts = {};
    issues.forEach(i => {
        const cat = i.category || 'Uncategorized';
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    });
    
    const topCategory = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0];
    if (topCategory) {
        insights.push({
            type: 'warning',
            icon: 'fa-chart-line',
            title: `${topCategory[0]} Issues Trending`,
            description: `${topCategory[1]} reports in the ${topCategory[0]} category this week. Consider allocating additional resources.`
        });
    }
    
    // Positive sentiment
    const resolutionRate = stats.resolution_rate || 0;
    if (resolutionRate > 70) {
        insights.push({
            type: 'info',
            icon: 'fa-thumbs-up',
            title: 'High Resolution Rate',
            description: `${resolutionRate}% of issues resolved this month. Citizen satisfaction is improving.`
        });
    } else if (insights.length < 3) {
        insights.push({
            type: 'info',
            icon: 'fa-lightbulb',
            title: 'AI Recommendation',
            description: 'Consider implementing preventive maintenance in high-traffic areas to reduce future reports.'
        });
    }
    
    return insights;
}

function renderInsights(insights) {
    const container = document.getElementById('insight-container');
    container.innerHTML = '';
    
    insights.forEach(insight => {
        const card = document.createElement('div');
        card.className = `insight-card ${insight.type}`;
        
        card.innerHTML = `
            <div class="insight-title">
                <i class="fa-solid ${insight.icon}"></i>
                ${insight.title}
            </div>
            <div class="insight-desc">
                ${insight.description}
            </div>
        `;
        
        container.appendChild(card);
    });
}

// ==========================================
// UTILITIES
// ==========================================

// Utility
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
