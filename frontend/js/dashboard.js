// Priority List
const priorityList = document.getElementById('priority-list');
const categoryFilter = document.getElementById('dashboard-category-filter');
const startDateInput = document.getElementById('dashboard-start-date');
const endDateInput = document.getElementById('dashboard-end-date');
let allIssues = [];
let allCategories = [];
let categoryChart = null;
let trendsChart = null;
const API_BASE_URL = window.location.port === '3000' 
    ? `http://${window.location.hostname}:5000/api`
    : '/api';

async function fetchDashboardData() {
    try {
        const start = startDateInput.value;
        const end = endDateInput.value;
        const dateParams = (start || end) ? `&start_date=${start}&end_date=${end}` : '';
        const dateParamsQ = (start || end) ? `?start_date=${start}&end_date=${end}` : '';

        const [issuesRes, statsRes, categoriesRes, trendsRes] = await Promise.all([
            fetch(`${API_BASE_URL}/issues?limit=10000${dateParams}`),
            fetch(`${API_BASE_URL}/stats${dateParamsQ}`),
            fetch(`${API_BASE_URL}/categories`),
            fetch(`${API_BASE_URL}/stats/trends${dateParamsQ}`)
        ]);

        if (!issuesRes.ok || !statsRes.ok || !categoriesRes.ok || !trendsRes.ok) throw new Error('Network response was not ok');

        const issuesData = await issuesRes.json();
        allIssues = Array.isArray(issuesData) ? issuesData : (issuesData.data || []);
        const stats = await statsRes.json();
        const trends = await trendsRes.json();
        allCategories = await categoriesRes.json();
        
        populateCategoryFilter(allCategories);
        renderStats(stats);
        renderTrendsChart(trends);
        renderDashboardContent();
    } catch (error) {
        console.error('Error fetching dashboard data:', error);
        priorityList.innerHTML = '<div style="color: var(--danger-color);">Failed to load data.</div>';
    }
}

function renderStats(stats) {
    const totalLabel = stats.is_custom_range ? 'Total Reports (Selected Range)' : 'Total Reports (This Week)';
    document.querySelector('.stat-card:nth-child(1) .stat-label').textContent = totalLabel;
    document.getElementById('stat-total-week').textContent = stats.total_reports_week.toLocaleString();
    
    const changeEl = document.getElementById('stat-total-week-change');
    if (stats.is_custom_range) {
        changeEl.innerHTML = '<i class="fa-solid fa-calendar"></i> Filtering by custom range';
        changeEl.style.color = 'var(--text-secondary)';
    } else {
        const isPositive = stats.reports_change_pct >= 0;
        changeEl.innerHTML = `
            <i class="fa-solid fa-arrow-trend-${isPositive ? 'up' : 'down'}"></i> 
            ${isPositive ? '+' : ''}${stats.reports_change_pct}% from last week
        `;
        changeEl.style.color = isPositive ? 'var(--success-color)' : 'var(--danger-color)';
    }

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

function populateCategoryFilter(categories) {
    if (!categoryFilter) return;
    categories.forEach(cat => {
        const option = document.createElement('option');
        option.value = cat.name;
        option.textContent = cat.name;
        categoryFilter.appendChild(option);
    });

    categoryFilter.addEventListener('change', () => {
        renderDashboardContent();
    });
}

function renderDashboardContent() {
    const selectedCategory = categoryFilter ? categoryFilter.value : '';
    
    // Filter issues
    const filteredIssues = selectedCategory 
        ? allIssues.filter(i => i.category === selectedCategory)
        : allIssues;

    renderPriorityList(filteredIssues);
    renderCharts(filteredIssues, allCategories);
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
    
    if (categoryChart) {
        categoryChart.destroy();
    }

    categoryChart = new Chart(ctxCategory, {
        type: 'bar',
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
                    display: false
                }
            },
            layout: {
                padding: {
                    bottom: 10
                }
            },
            scales: {
                x: {
                    ticks: {
                        font: {
                            size: 11
                        }
                    }
                },
                y: {
                    beginAtZero: true,
                    ticks: {
                        stepSize: 1
                    }
                }
            }
        }
    });
}

function renderTrendsChart(trends) {
    const chartEl = document.getElementById('trendsChart');
    if (!chartEl) return;
    const ctxTrends = chartEl.getContext('2d');
    
    if (trendsChart) {
        trendsChart.destroy();
    }

    // Merge data by date
    const allDates = [...new Set([
        ...trends.reports.map(r => r.date),
        ...trends.resolutions.map(r => r.date)
    ])].sort();

    const reportsData = allDates.map(date => {
        const item = trends.reports.find(r => r.date === date);
        return item ? parseInt(item.count) : 0;
    });

    const resolutionsData = allDates.map(date => {
        const item = trends.resolutions.find(r => r.date === date);
        return item ? parseInt(item.count) : 0;
    });

    trendsChart = new Chart(ctxTrends, {
        type: 'line',
        data: {
            labels: allDates.map(d => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })),
            datasets: [
                {
                    label: 'Issues Reported',
                    data: reportsData,
                    borderColor: '#3b82f6',
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 4,
                    pointHoverRadius: 6
                },
                {
                    label: 'Issues Resolved',
                    data: resolutionsData,
                    borderColor: '#22c55e',
                    backgroundColor: 'rgba(34, 197, 94, 0.1)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 4,
                    pointHoverRadius: 6
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        usePointStyle: true,
                        padding: 20,
                        font: {
                            family: 'Inter',
                            size: 12
                        }
                    }
                },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    padding: 12,
                    backgroundColor: 'rgba(255, 255, 255, 0.9)',
                    titleColor: '#1e293b',
                    bodyColor: '#475569',
                    borderColor: '#e2e8f0',
                    borderWidth: 1
                }
            },
            layout: {
                padding: {
                    bottom: 10
                }
            },
            scales: {
                x: {
                    grid: {
                        display: false
                    },
                    ticks: {
                        font: {
                            size: 11
                        }
                    }
                },
                y: {
                    beginAtZero: true,
                    ticks: {
                        stepSize: 1,
                        precision: 0
                    },
                    grid: {
                        borderDash: [5, 5]
                    }
                }
            }
        }
    });
}

// Initial Fetch
fetchDashboardData();

// Date Filter Listeners
startDateInput.addEventListener('change', fetchDashboardData);
endDateInput.addEventListener('change', fetchDashboardData);
