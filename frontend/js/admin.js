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
    
    // Global Dashboard Filters
    const applyFiltersBtn = document.getElementById('apply-filters');
    if (applyFiltersBtn) {
        applyFiltersBtn.addEventListener('click', loadDashboardData);
    }

    const resetFiltersBtn = document.getElementById('reset-filters');
    if (resetFiltersBtn) {
        resetFiltersBtn.addEventListener('click', () => {
            document.getElementById('global-category-filter').value = 'All';
            document.getElementById('global-date-start').value = '';
            document.getElementById('global-date-end').value = '';
            loadDashboardData();
        });
    }

    // Initialize Date Restrictions
    setupDateRestrictions();

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
let issuePage = 1;
const issueLimit = 8;

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
    
    // Display Admin Info
    const adminUser = JSON.parse(localStorage.getItem('fixam_admin_user'));
    if (adminUser) {
        document.querySelectorAll('.admin-user-display, #admin-info').forEach(el => {
            el.innerHTML = `
                <div style="text-align: right;">
                    <div style="font-weight: 600;">${adminUser.name || 'Admin'}</div>
                    <div style="font-size: 0.75rem; color: var(--admin-text-muted);">Role: ${adminUser.role || 'Administrator'}</div>
                </div>
            `;
        });
    }
    
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
        const category = document.getElementById('global-category-filter').value;
        const start = document.getElementById('global-date-start').value;
        const end = document.getElementById('global-date-end').value;

        const params = new URLSearchParams();
        if (category && category !== 'All') params.append('category', category);
        if (start) params.append('start_date', start);
        if (end) params.append('end_date', end);

        // Fetch Issues for all dashboard visualizations
        // Fix: Use a high limit to get all data for stats/charts, bypassing default pagination
        const res = await fetch(`${API_BASE_URL}/issues?${params.toString()}&limit=10000`);
        const responseData = await res.json();
        const issues = Array.isArray(responseData) ? responseData : (responseData.data || []);

        // Recalculate Stats locally from filtered issues
        calculateAndDisplayStats(issues);
        
        // Render Charts & Map
        renderCategoryChart(issues);
        renderHeatmap(issues);
        
        // Generate insights based on the filtered data
        const stats = {
            critical_pending: issues.filter(i => i.status === 'critical').length,
            resolution_rate: issues.length > 0 ? Math.round((issues.filter(i => i.status === 'fixed').length / issues.length) * 100) : 0
        };
        const insights = generateMockInsights(stats, issues);
        renderInsights(insights);

    } catch (err) {
        console.error('Error loading dashboard data:', err);
    }
}

function calculateAndDisplayStats(issues) {
    const total = issues.length;
    const resolved = issues.filter(i => i.status === 'fixed').length;
    const inProgress = issues.filter(i => i.status === 'progress').length;
    const critical = issues.filter(i => i.status === 'critical').length;
    const resolutionRate = total > 0 ? Math.round((resolved / total) * 100) : 0;

    document.getElementById('total-reports').textContent = total;
    document.getElementById('resolved-issues').textContent = resolved;
    document.getElementById('in-progress-issues').textContent = inProgress;
    document.getElementById('critical-pending').textContent = critical;
    document.getElementById('resolution-rate').textContent = `${resolutionRate}%`;
    
    // Trend is hard to calculate without full history, so we'll mock it based on total
    document.getElementById('reports-trend').textContent = (total > 0 ? '+12%' : '0%');
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
let markers;

function renderHeatmap(issues) {
    const isDarkMode = document.body.classList.contains('dark-mode');
    
    if (!map) {
        map = L.map('map-heatmap').setView([8.417, -11.841], 8); // Center of Sierra Leone
        
        const tileUrl = isDarkMode 
            ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
            : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
        
        L.tileLayer(tileUrl, {
            attribution: '&copy; OpenStreetMap &copy; CARTO',
            subdomains: 'abcd',
            maxZoom: 20
        }).addTo(map);

        // Add Home Button
        const HomeControl = L.Control.extend({
            options: { position: 'topleft' },
            onAdd: function(map) {
                const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
                const button = L.DomUtil.create('a', '', container);
                button.innerHTML = '<i class="fa-solid fa-house" style="font-size: 14px;"></i>';
                button.href = '#';
                button.title = 'Back to National View';
                button.style.backgroundColor = isDarkMode ? '#1e293b' : 'white';
                button.style.color = isDarkMode ? '#f1f5f9' : '#334155';
                button.style.width = '30px';
                button.style.height = '30px';
                button.style.display = 'flex';
                button.style.alignItems = 'center';
                button.style.justifyContent = 'center';
                button.style.textDecoration = 'none';
                button.style.border = 'none';

                button.onclick = function(e) {
                    e.preventDefault();
                    map.flyTo([8.417, -11.841], 8);
                };
                return container;
            }
        });
        map.addControl(new HomeControl());
    }

    if (markers) {
        map.removeLayer(markers);
    }

    // Status Colors
    const colors = {
        fixed: { r: 34, g: 197, b: 94 }, // Green
        progress: { r: 245, g: 158, b: 11 }, // Orange
        pending: { r: 239, g: 68, b: 68 } // Red
    };

    const getStatusType = (status) => {
        if (status === 'fixed') return 'fixed';
        if (status === 'progress') return 'progress';
        return 'pending'; // critical or acknowledged
    };

    markers = L.markerClusterGroup({
        maxClusterRadius: 60,
        iconCreateFunction: function (cluster) {
            const children = cluster.getAllChildMarkers();
            let counts = { fixed: 0, progress: 0, pending: 0 };
            
            children.forEach(m => {
                counts[getStatusType(m.options.status)]++;
            });

            const total = children.length;
            
            // Weighted Average Color
            const r = Math.round((counts.fixed * colors.fixed.r + counts.progress * colors.progress.r + counts.pending * colors.pending.r) / total);
            const g = Math.round((counts.fixed * colors.fixed.g + counts.progress * colors.progress.g + counts.pending * colors.pending.g) / total);
            const b = Math.round((counts.fixed * colors.fixed.b + counts.progress * colors.progress.b + counts.pending * colors.pending.b) / total);
            
            const color = `rgb(${r}, ${g}, ${b})`;
            const size = Math.min(40 + (total * 2), 80);

            return L.divIcon({
                html: `<div style="
                    background: ${color}; 
                    width: ${size}px; 
                    height: ${size}px; 
                    border-radius: 50%; 
                    display: flex; 
                    align-items: center; 
                    justify-content: center; 
                    color: white; 
                    font-weight: bold; 
                    box-shadow: 0 0 15px rgba(0,0,0,0.3);
                    border: 3px solid rgba(255,255,255,0.5);
                    transition: all 0.3s ease;
                ">${total}</div>`,
                className: 'custom-cluster-icon',
                iconSize: L.point(size, size)
            });
        }
    });

    issues.forEach(issue => {
        if (!issue.lat || !issue.lng) return;

        const statusType = getStatusType(issue.status);
        const color = `rgb(${colors[statusType].r}, ${colors[statusType].g}, ${colors[statusType].b})`;

        const marker = L.circleMarker([parseFloat(issue.lat), parseFloat(issue.lng)], {
            radius: 8,
            fillColor: color,
            color: '#fff',
            weight: 2,
            opacity: 1,
            fillOpacity: 0.8,
            status: issue.status // Store for cluster logic
        });

        marker.bindPopup(`
            <div style="font-family: 'Inter', sans-serif;">
                <b style="color: ${color}">${issue.category}</b><br>
                <b>${issue.title}</b><br>
                Status: <span style="text-transform: capitalize; font-weight: 600; color: ${color}">${issue.status}</span><br>
                <button onclick="openIssueDetails(${issue.id})" style="margin-top: 8px; background: var(--admin-primary); color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; width: 100%;">Details</button>
            </div>
        `);

        markers.addLayer(marker);
    });

    map.addLayer(markers);
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
    const category = document.getElementById('issue-filter-category').value;
    const status = document.getElementById('issue-filter-status').value;
    const start = document.getElementById('issue-filter-start').value;
    const end = document.getElementById('issue-filter-end').value;
    const sort = document.getElementById('issue-sort').value;
    
    // Construct URL Params
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
        
        // Handle both old (array) and new (object with pagination) API responses gracefully
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
        
        // Simple logic: Show first, last, and neighbors of current
        // For simplicity: Show up to 5 buttons
        let startPage = Math.max(1, current - 2);
        let endPage = Math.min(totalPages, startPage + 4);
        
        if (endPage - startPage < 4) {
            startPage = Math.max(1, endPage - 4);
        }

        for (let i = startPage; i <= endPage; i++) {
            const btn = document.createElement('button');
            btn.textContent = i;
            btn.style.width = '32px';
            btn.style.height = '32px';
            btn.style.borderRadius = '6px';
            btn.style.border = '1px solid var(--admin-border)';
            btn.style.cursor = 'pointer';
            
            if (i === current) {
                btn.style.background = 'var(--admin-primary)';
                btn.style.color = 'white';
                btn.style.borderColor = 'var(--admin-primary)';
            } else {
                btn.style.background = 'var(--admin-card-bg)';
                btn.style.color = 'var(--admin-text)';
            }
            
            btn.onclick = () => {
                issuePage = i;
                loadIssues();
            };
            
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

    // Citizen Sentiment - Calculated First
    // Logic: If critical > 30% of total -> Negative. If resolution > 50% -> Positive. Else Neutral.
    const total = issues.length;
    const critical = issues.filter(i => i.status === 'critical').length;
    const resolved = issues.filter(i => i.status === 'fixed').length;
    let sentiment = 'Neutral';
    let sentimentDesc = 'Balanced feedback from community reports.';
    let sentimentType = 'info';

    if (total > 0) {
        if (critical / total > 0.3) {
            sentiment = 'Negative';
            sentimentDesc = 'High volume of critical issues is impacting public sentiment.';
            sentimentType = 'critical'; // Red border
        } else if (resolved / total > 0.5) {
            sentiment = 'Positive';
            sentimentDesc = 'High resolution rates are driving positive community feedback.';
            sentimentType = 'success'; // Green border
        }
    }

    insights.push({
        type: sentimentType,
        icon: 'fa-face-smile',
        title: `Citizen Sentiment: ${sentiment}`,
        description: sentimentDesc
    });
    
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

function setupDateRestrictions() {
    const startDate = document.getElementById('global-date-start');
    const endDate = document.getElementById('global-date-end');

    if (startDate && endDate) {
        // Set max date to today for both
        const today = new Date().toISOString().split('T')[0];
        startDate.max = today;
        endDate.max = today;

        // When start date changes
        startDate.addEventListener('change', () => {
            // End date min cannot be less than start date
            endDate.min = startDate.value;
            
            // If end date is now invalid (less than start), clear it
            if (endDate.value && endDate.value < startDate.value) {
                endDate.value = startDate.value;
            }
        });

        // When end date changes
        endDate.addEventListener('change', () => {
             // If validation somehow fails
             if (endDate.value < startDate.value) {
                 endDate.value = startDate.value;
             }
        });
    }
}

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
