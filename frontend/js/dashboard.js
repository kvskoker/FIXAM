// Priority List
const priorityList = document.getElementById('priority-list');
const API_BASE_URL = window.location.port === '3000' 
    ? `http://${window.location.hostname}:5000/api`
    : '/api';

async function fetchDashboardData() {
    try {
        const response = await fetch(`${API_BASE_URL}/issues`);
        if (!response.ok) throw new Error('Network response was not ok');
        const issues = await response.json();
        
        renderPriorityList(issues);
        renderCharts(issues);
    } catch (error) {
        console.error('Error fetching dashboard data:', error);
        priorityList.innerHTML = '<div style="color: var(--danger-color);">Failed to load data.</div>';
    }
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

function renderCharts(issues) {
    // Calculate Category Data
    const categories = {};
    issues.forEach(i => {
        categories[i.category] = (categories[i.category] || 0) + 1;
    });

    const ctxCategory = document.getElementById('categoryChart').getContext('2d');
    new Chart(ctxCategory, {
        type: 'doughnut',
        data: {
            labels: Object.keys(categories),
            datasets: [{
                data: Object.values(categories),
                backgroundColor: [
                    '#3b82f6', // Blue
                    '#f59e0b', // Amber
                    '#ef4444', // Red
                    '#eab308', // Yellow
                    '#22c55e', // Green
                    '#64748b'  // Slate
                ],
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
