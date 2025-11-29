// Priority List
const priorityList = document.getElementById('priority-list');
const API_BASE_URL = window.location.port === '3000' 
    ? `http://${window.location.hostname}:5000/api`
    : '/api';

async function fetchDashboardData() {
    try {
        const [issuesRes, statsRes, categoriesRes] = await Promise.all([
            fetch(`${API_BASE_URL}/issues`),
            fetch(`${API_BASE_URL}/stats`),
            fetch(`${API_BASE_URL}/categories`)
        ]);

        if (!issuesRes.ok || !statsRes.ok || !categoriesRes.ok) throw new Error('Network response was not ok');

        const issues = await issuesRes.json();
        const stats = await statsRes.json();
        const categories = await categoriesRes.json();
        
        renderStats(stats);
        renderPriorityList(issues);
        renderCharts(issues, categories);
    } catch (error) {
        console.error('Error fetching dashboard data:', error);
        priorityList.innerHTML = '<div style="color: var(--danger-color);">Failed to load data.</div>';
    }
}

function renderStats(stats) {
    document.getElementById('stat-total-week').textContent = stats.total_reports_week.toLocaleString();
    
    const changeEl = document.getElementById('stat-total-week-change');
    const isPositive = stats.reports_change_pct >= 0;
    changeEl.innerHTML = `
        <i class="fa-solid fa-arrow-trend-${isPositive ? 'up' : 'down'}"></i> 
        ${isPositive ? '+' : ''}${stats.reports_change_pct}% from last week
    `;
    changeEl.style.color = isPositive ? 'var(--success-color)' : 'var(--danger-color)';

    document.getElementById('stat-resolved').textContent = stats.resolved_issues.toLocaleString();
    document.getElementById('stat-resolution-rate').innerHTML = `
        <i class="fa-solid fa-check"></i> ${stats.resolution_rate}% Resolution Rate
    `;

    document.getElementById('stat-critical').textContent = stats.critical_pending.toLocaleString();
}

function renderPriorityList(issues) {
    const criticalIssues = issues.filter(i => i.status === 'critical').slice(0, 3);

    criticalIssues.forEach(issue => {
        const item = document.createElement('div');
        item.className = 'issue-card';
        item.style.borderLeft = '4px solid var(--danger-color)';
        item.innerHTML = `
            <div class="issue-title" style="font-size: 0.9rem;">${issue.title}</div>
            <div class="issue-meta">
                <span style="color: var(--danger-color); font-weight: 600;">Critical</span>
                <div class="vote-count">${issue.votes} votes</div>
            </div>
        `;
        priorityList.appendChild(item);
    });
}

function renderCharts(issues, categoriesList) {
    // Map categories to colors
    const categoryColors = {};
    categoriesList.forEach(cat => {
        categoryColors[cat.name] = cat.color || '#64748b';
    });

    // Calculate Category Data
    const categoryCounts = {};
    // Initialize with 0 for all known categories
    categoriesList.forEach(cat => categoryCounts[cat.name] = 0);
    
    issues.forEach(i => {
        // If issue has a category not in our list, add it (fallback)
        if (!categoryCounts.hasOwnProperty(i.category)) {
            categoryCounts[i.category] = 0;
            categoryColors[i.category] = '#64748b'; // Default color
        }
        categoryCounts[i.category]++;
    });

    const ctxCategory = document.getElementById('categoryChart').getContext('2d');
    new Chart(ctxCategory, {
        type: 'doughnut',
        data: {
            labels: Object.keys(categoryCounts),
            datasets: [{
                data: Object.values(categoryCounts),
                backgroundColor: Object.keys(categoryCounts).map(cat => categoryColors[cat]),
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'right'
                }
            }
        }
    });

    // Sentiment Chart (Dummy Data for now as backend doesn't provide sentiment yet)
    const ctxSentiment = document.getElementById('sentimentChart').getContext('2d');
    new Chart(ctxSentiment, {
        type: 'bar',
        data: {
            labels: ['Angry', 'Frustrated', 'Neutral', 'Hopeful', 'Happy'],
            datasets: [{
                label: 'Sentiment Score',
                data: [65, 45, 30, 20, 10],
                backgroundColor: [
                    '#ef4444',
                    '#f97316',
                    '#64748b',
                    '#3b82f6',
                    '#22c55e'
                ],
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    grid: {
                        display: false
                    }
                },
                x: {
                    grid: {
                        display: false
                    }
                }
            },
            plugins: {
                legend: {
                    display: false
                }
            }
        }
    });
}

// Initial Fetch
fetchDashboardData();
