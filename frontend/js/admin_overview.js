// Include this after admin_common.js
document.addEventListener('DOMContentLoaded', () => {
    checkAuth(() => {
        // Initialize filters from URL
        const urlParams = getURLParams();
        if (urlParams.category) document.getElementById('global-category-filter').value = urlParams.category;
        if (urlParams.start_date) document.getElementById('global-date-start').value = urlParams.start_date;
        if (urlParams.end_date) document.getElementById('global-date-end').value = urlParams.end_date;
        
        loadDashboardData();
    });

    // Global Dashboard Filters
    const filters = ['global-category-filter', 'global-date-start', 'global-date-end'];
    filters.forEach(id => {
        document.getElementById(id).addEventListener('change', () => {
            const category = document.getElementById('global-category-filter').value;
            const start_date = document.getElementById('global-date-start').value;
            const end_date = document.getElementById('global-date-end').value;
            
            updateURLParams({ category, start_date, end_date });
            loadDashboardData();
        });
    });

    const resetFiltersBtn = document.getElementById('reset-filters');
    if (resetFiltersBtn) {
        resetFiltersBtn.addEventListener('click', () => {
            document.getElementById('global-category-filter').value = 'All';
            if (window.resetDateFilters) window.resetDateFilters();
            
            updateURLParams({ category: null, start_date: null, end_date: null });
            loadDashboardData();
        });
    }

    // Initialize Date Restrictions
    setupDateRestrictions();

    // Listen for theme changes to update map
    window.addEventListener('themeChanged', () => {
        if (map) {
            loadDashboardData();
        }
    });
});

async function loadDashboardData() {
    try {
        const category = document.getElementById('global-category-filter').value;
        const start = document.getElementById('global-date-start').value;
        const end = document.getElementById('global-date-end').value;

        const params = new URLSearchParams();
        if (category && category !== 'All') params.append('category', category);
        if (start) params.append('start_date', start);
        if (end) params.append('end_date', end);

        const res = await fetch(`${API_BASE_URL}/issues?${params.toString()}&limit=10000`);
        const responseData = await res.json();
        const issues = Array.isArray(responseData) ? responseData : (responseData.data || []);

        calculateAndDisplayStats(issues);
        renderCategoryChart(issues);
        renderHeatmap(issues);
        
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
    document.getElementById('reports-trend').textContent = (total > 0 ? '+12%' : '0%');
}

let map;
let markers;

function renderHeatmap(issues) {
    const isDarkMode = document.body.classList.contains('dark-mode');
    
    if (!map) {
        map = L.map('map-heatmap').setView([8.417, -11.841], 7); 
        
        const tileUrl = isDarkMode 
            ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
            : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
        
        L.tileLayer(tileUrl, {
            attribution: '&copy; OpenStreetMap &copy; CARTO',
            subdomains: 'abcd',
            maxZoom: 20
        }).addTo(map);

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
                    map.flyTo([8.417, -11.841], 7);
                };
                return container;
            }
        });
        map.addControl(new HomeControl());
    }

    if (markers) {
        map.removeLayer(markers);
    }

    const colors = {
        fixed: { r: 34, g: 197, b: 94 },
        progress: { r: 245, g: 158, b: 11 },
        pending: { r: 239, g: 68, b: 68 }
    };

    const getStatusType = (status) => {
        if (status === 'fixed') return 'fixed';
        if (status === 'progress') return 'progress';
        return 'pending';
    };

    markers = L.markerClusterGroup({
        maxClusterRadius: 60,
        iconCreateFunction: function (cluster) {
            const children = cluster.getAllChildMarkers();
            let counts = { fixed: 0, progress: 0, pending: 0 };
            children.forEach(m => counts[getStatusType(m.options.status)]++);
            const total = children.length;
            const r = Math.round((counts.fixed * colors.fixed.r + counts.progress * colors.progress.r + counts.pending * colors.pending.r) / total);
            const g = Math.round((counts.fixed * colors.fixed.g + counts.progress * colors.progress.g + counts.pending * colors.pending.g) / total);
            const b = Math.round((counts.fixed * colors.fixed.b + counts.progress * colors.progress.b + counts.pending * colors.pending.b) / total);
            const color = `rgb(${r}, ${g}, ${b})`;
            const size = Math.min(40 + (total * 2), 80);

            return L.divIcon({
                html: `<div style="background: ${color}; width: ${size}px; height: ${size}px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; box-shadow: 0 0 15px rgba(0,0,0,0.3); border: 3px solid rgba(255,255,255,0.5);">${total}</div>`,
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
            status: issue.status
        });

        marker.bindPopup(`
            <div style="font-family: 'Inter', sans-serif;">
                <b style="color: ${color}">${issue.category}</b><br>
                <b>${issue.title}</b><br>
                Status: <span style="text-transform: capitalize; font-weight: 600; color: ${color}">${issue.status}</span><br>
                <a href="/admin/issues?id=${issue.id}" style="display: block; text-align: center; margin-top: 8px; background: var(--admin-primary); color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; width: 100%; text-decoration: none;">View in Issues</a>
            </div>
        `);
        markers.addLayer(marker);
    });

    map.addLayer(markers);
}

let categoryChart;
function renderCategoryChart(issues) {
    const el = document.getElementById('categoryChart');
    if (!el) return;
    const ctx = el.getContext('2d');
    const categoryCounts = {};
    issues.forEach(i => {
        const cat = i.category || 'Uncategorized';
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    });
    const labels = Object.keys(categoryCounts);
    const data = Object.values(categoryCounts);
    if (categoryChart) categoryChart.destroy();
    categoryChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: data,
                backgroundColor: ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'right', labels: { color: '#94a3b8' } }
            }
        }
    });
}

function generateMockInsights(stats, issues) {
    const insights = [];
    const total = issues.length;
    const critical = issues.filter(i => i.status === 'critical').length;
    const resolved = issues.filter(i => i.status === 'fixed').length;
    let sentiment = 'Neutral', sentimentDesc = 'Balanced feedback from community reports.', sentimentType = 'info';

    if (total > 0) {
        if (critical / total > 0.3) {
            sentiment = 'Negative';
            sentimentDesc = 'High volume of critical issues is impacting public sentiment.';
            sentimentType = 'critical';
        } else if (resolved / total > 0.5) {
            sentiment = 'Positive';
            sentimentDesc = 'High resolution rates are driving positive community feedback.';
            sentimentType = 'success';
        }
    }

    insights.push({ type: sentimentType, icon: 'fa-face-smile', title: `Citizen Sentiment: ${sentiment}`, description: sentimentDesc });
    if (stats.critical_pending > 0) {
        insights.push({ type: 'critical', icon: 'fa-triangle-exclamation', title: 'Critical Issues Detected', description: `${stats.critical_pending} critical issues require immediate attention.` });
    }
    const categoryCounts = {};
    issues.forEach(i => { const cat = i.category || 'Uncategorized'; categoryCounts[cat] = (categoryCounts[cat] || 0) + 1; });
    const topCategory = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0];
    if (topCategory) {
        insights.push({ type: 'warning', icon: 'fa-chart-line', title: `${topCategory[0]} Issues Trending`, description: `${topCategory[1]} reports in the ${topCategory[0]} category this week.` });
    }
    return insights;
}

function renderInsights(insights) {
    const container = document.getElementById('insight-container');
    if (!container) return;
    container.innerHTML = '';
    insights.forEach(insight => {
        const card = document.createElement('div');
        card.className = `insight-card ${insight.type}`;
        card.innerHTML = `
            <div class="insight-title"><i class="fa-solid ${insight.icon}"></i> ${insight.title}</div>
            <div class="insight-desc">${insight.description}</div>
        `;
        container.appendChild(card);
    });
}

function setupDateRestrictions() {
    const startDate = document.getElementById('global-date-start');
    const endDate = document.getElementById('global-date-end');
    
    if (startDate && endDate) {
        const today = new Date();

        const startPicker = flatpickr(startDate, {
            dateFormat: "Y-m-d",
            altInput: true,
            altFormat: "d/m/Y",
            maxDate: today,
            onChange: function(selectedDates, dateStr, instance) {
                endPicker.set('minDate', dateStr);
                if (endDate.value && endDate.value < dateStr) {
                    endPicker.setDate(dateStr);
                }
                updateURLParams({ start_date: dateStr, end_date: endDate.value });
                loadDashboardData();
            }
        });

        const endPicker = flatpickr(endDate, {
            dateFormat: "Y-m-d",
            altInput: true,
            altFormat: "d/m/Y",
            maxDate: today,
            onChange: function(selectedDates, dateStr, instance) {
                startPicker.set('maxDate', dateStr ? dateStr : today);
                updateURLParams({ start_date: startDate.value, end_date: dateStr });
                loadDashboardData();
            }
        });

        // Handle initial values from URL
        if(startDate.value) startPicker.setDate(startDate.value, false);
        if(endDate.value) endPicker.setDate(endDate.value, false);
        
        // Expose to window for reset
        window.resetDateFilters = () => {
             startPicker.clear();
             endPicker.clear();
        };
    }
}
