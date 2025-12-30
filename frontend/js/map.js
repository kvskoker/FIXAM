// Initialize Map
const map = L.map('map').setView([8.417, -11.841], 8);
const API_BASE_URL = window.location.port === '3000' 
    ? `http://${window.location.hostname}:5000/api`
    : '/api';

// Add CARTO Tiles
const isDarkMode = document.body.classList.contains('dark-mode');
const tileUrl = isDarkMode 
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';

L.tileLayer(tileUrl, {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 20
}).addTo(map);

// Add Home Button
L.Control.Home = L.Control.extend({
    onAdd: function(map) {
        const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
        const button = L.DomUtil.create('a', '', container);
        button.innerHTML = '<i class="fa-solid fa-house" style="font-size: 14px;"></i>';
        button.href = '#';
        button.title = 'Back to National View';
        button.style.backgroundColor = 'var(--surface-color, white)';
        button.style.color = 'var(--text-primary, #333)';
        button.style.width = '30px';
        button.style.height = '30px';
        button.style.display = 'flex';
        button.style.alignItems = 'center';
        button.style.justifyContent = 'center';
        button.style.textDecoration = 'none';

        button.onclick = function(e) {
            e.preventDefault();
            map.flyTo([8.417, -11.841], 8);
        };
        return container;
    }
});
new L.Control.Home({ position: 'topleft' }).addTo(map);

// Listen for theme changes to update map
window.addEventListener('themeChanged', () => {
    const isDark = document.body.classList.contains('dark-mode');
    map.eachLayer(layer => {
        if (layer instanceof L.TileLayer) {
            map.removeLayer(layer);
        }
    });
    
    const newTileUrl = isDark 
        ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
        : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
    
    L.tileLayer(newTileUrl, {
        attribution: '&copy; OpenStreetMap &copy; CARTO',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(map);
});

// Icons
const createIcon = (color) => {
    return L.divIcon({
        className: 'custom-pin',
        html: `<div style="background-color: ${color}; width: 20px; height: 20px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 5px rgba(0,0,0,0.3);"></div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10],
        popupAnchor: [0, -10]
    });
};

// Helper to get status color
function getStatusColor(status) {
    switch(status) {
        case 'critical': return '#ef4444';
        case 'progress': return '#f59e0b';
        case 'fixed': return '#22c55e';
        default: return '#64748b';
    }
}

// Smart Cluster Logic
let clusterGroup;
const markers = {};

const colors = {
    fixed: { r: 34, g: 197, b: 94 }, // Green
    progress: { r: 245, g: 158, b: 11 }, // Orange
    pending: { r: 239, g: 68, b: 68 } // Red
};

const getStatusType = (status) => {
    if (status === 'fixed') return 'fixed';
    if (status === 'progress') return 'progress';
    return 'pending';
};
const issueList = document.getElementById('issue-list');
const searchInput = document.getElementById('search-input');
const categoryFilter = document.getElementById('category-filter');
const statusFilter = document.getElementById('status-filter');
const sortFilter = document.getElementById('sort-filter');

// Debounce helper
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// Event Listeners
if (searchInput) searchInput.addEventListener('input', debounce(() => fetchIssues(), 500));
if (categoryFilter) categoryFilter.addEventListener('change', () => fetchIssues());
if (statusFilter) statusFilter.addEventListener('change', () => fetchIssues());
if (sortFilter) sortFilter.addEventListener('change', () => fetchIssues());

// Fetch Data from API
async function fetchIssues() {
    try {
        const params = new URLSearchParams();
        if (searchInput && searchInput.value) params.append('search', searchInput.value);
        if (categoryFilter && categoryFilter.value) params.append('category', categoryFilter.value);
        if (statusFilter && statusFilter.value) params.append('status', statusFilter.value);
        if (sortFilter && sortFilter.value) params.append('sort', sortFilter.value);

        // Check for ticket param in URL
        const urlParams = new URLSearchParams(window.location.search);
        const ticketId = urlParams.get('ticket');
        if (ticketId) params.append('ticket', ticketId);

        // Fetch all issues for the map (bypass pagination)
        params.append('limit', '10000');

        const response = await fetch(`${API_BASE_URL}/issues?${params.toString()}`);
        if (!response.ok) throw new Error('Network response was not ok');
        const responseData = await response.json();
        // Handle both old (array) and new (object) structures
        const issues = Array.isArray(responseData) ? responseData : (responseData.data || []);
        renderIssues(issues);
    } catch (error) {
        console.error('Error fetching issues:', error);
        issueList.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--danger-color);">Failed to load issues.</div>';
    }
}

// Helper to check if url is video
function isVideo(url) {
    if (!url) return false;
    const videoExtensions = ['.mp4', '.webm', '.ogg', '.mov'];
    return videoExtensions.some(ext => url.toLowerCase().endsWith(ext));
}

// Global function to play video
window.playVideo = function(container) {
    const video = container.querySelector('video');
    const playBtn = container.querySelector('.play-button');
    
    if (video.paused) {
        video.play();
        video.controls = true;
        playBtn.style.display = 'none';
    } else {
        video.pause();
        // We leave controls enabled so user can use them
        playBtn.style.display = 'flex';
    }
};

// Global function to expand video
window.expandVideo = function(container, event) {
    if (event) event.stopPropagation();
    const video = container.querySelector('video');
    if (video.requestFullscreen) {
        video.requestFullscreen();
    } else if (video.webkitRequestFullscreen) { /* Safari */
        video.webkitRequestFullscreen();
    } else if (video.msRequestFullscreen) { /* IE11 */
        video.msRequestFullscreen();
    }
};

function renderIssues(issues) {
    // Clear existing
    if (clusterGroup) {
        map.removeLayer(clusterGroup);
    }
    for (const key in markers) delete markers[key];
    
    clusterGroup = L.markerClusterGroup({
        maxClusterRadius: 50,
        iconCreateFunction: function (cluster) {
            const children = cluster.getAllChildMarkers();
            let counts = { fixed: 0, progress: 0, pending: 0 };
            
            children.forEach(m => {
                counts[getStatusType(m.options.status)]++;
            });

            const total = children.length;
            const r = Math.round((counts.fixed * colors.fixed.r + counts.progress * colors.progress.r + counts.pending * colors.pending.r) / total);
            const g = Math.round((counts.fixed * colors.fixed.g + counts.progress * colors.progress.g + counts.pending * colors.pending.g) / total);
            const b = Math.round((counts.fixed * colors.fixed.b + counts.progress * colors.progress.b + counts.pending * colors.pending.b) / total);
            
            const color = `rgb(${r}, ${g}, ${b})`;
            const size = Math.min(36 + (total * 1.5), 70);

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
                    box-shadow: 0 0 10px rgba(0,0,0,0.2);
                    border: 2px solid rgba(255,255,255,0.4);
                ">${total}</div>`,
                className: 'custom-cluster-icon',
                iconSize: L.point(size, size)
            });
        }
    });

    issueList.innerHTML = ''; // Clear loading

    issues.forEach(issue => {
        if (!issue.lat || !issue.lng) return;

        const statusType = getStatusType(issue.status);
        const color = `rgb(${colors[statusType].r}, ${colors[statusType].g}, ${colors[statusType].b})`;

        // Add Marker
        const marker = L.circleMarker([issue.lat, issue.lng], {
            radius: 8,
            fillColor: color,
            color: '#fff',
            weight: 2,
            opacity: 1,
            fillOpacity: 0.8,
            status: issue.status
        });

        // Popup Content
        let mediaContent = '';
        if (isVideo(issue.image_url)) {
            mediaContent = `
                <div class="video-container" style="position: relative; width: 100%; height: 150px; margin-bottom: 0.5rem; border-radius: 0.5rem; overflow: hidden; background: #000;">
                    <video src="${issue.image_url}" style="width: 100%; height: 100%; object-fit: cover;" preload="metadata" onclick="playVideo(this.parentElement)"></video>
                    <div class="play-button" onclick="playVideo(this.parentElement)" style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 40px; height: 40px; background: rgba(0,0,0,0.6); border-radius: 50%; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(2px); cursor: pointer; z-index: 10;">
                        <i class="fa-solid fa-play" style="color: white; font-size: 16px; margin-left: 2px;"></i>
                    </div>
                </div>
            `;
        } else {
            mediaContent = `<img src="${issue.image_url || 'https://via.placeholder.com/400'}" class="popup-image" alt="${issue.title}" style="width: 100%; height: 120px; object-fit: cover; border-radius: 8px; margin-bottom: 8px;">`;
        }

        const popupContent = `
            <div class="popup-content" style="min-width: 280px; padding: 5px;">
                ${mediaContent}
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                     <div style="font-size: 0.7rem; font-weight: 650; color: ${color}; text-transform: uppercase;">${issue.category}</div>
                     <span style="background: rgba(${colors[statusType].r}, ${colors[statusType].g}, ${colors[statusType].b}, 0.15); color: ${color}; padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: 600; text-transform: capitalize;">${issue.status}</span>
                </div>
                <div class="popup-title" style="font-weight: 700; font-size: 1.1rem; margin-bottom: 10px; color: var(--text-primary);">${issue.title}</div>
                
                <div style="display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; font-size: 0.85rem; margin-bottom: 15px; color: var(--text-secondary);">
                    <div style="font-weight: 500;">Issue ID:</div>
                    <div style="color: var(--text-primary); font-family: monospace; font-weight: 600;">#${issue.ticket_id}</div>
                    
                    <div style="font-weight: 500;">Reported:</div>
                    <div style="color: var(--text-primary);">${new Date(issue.reported_on || issue.created_at).toLocaleDateString()}</div>
                    
                    <div style="font-weight: 500;">By:</div>
                    <div style="color: var(--text-primary);">${issue.reported_by_name || 'Anonymous citizen'}</div>
                    
                    <div style="font-weight: 500;">Location:</div>
                    <div style="color: var(--text-primary); font-size: 0.8rem;"><i class="fa-solid fa-location-dot" style="margin-right: 4px; opacity: 0.7;"></i>Freetown, SL (${parseFloat(issue.lat).toFixed(4)}, ${parseFloat(issue.lng).toFixed(4)})</div>
                </div>

                <div class="popup-desc" style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 15px; line-height: 1.4; border-top: 1px solid var(--border-color); padding-top: 8px;">${issue.description}</div>
                
                <button class="btn btn-primary" onclick="viewTracker(${issue.id})" style="width: 100%; font-size: 0.85rem; padding: 10px; display: flex; align-items: center; justify-content: center; gap: 8px; border-radius: 8px;">
                    <i class="fa-solid fa-clock-rotate-left"></i> View Full Activity History
                </button>
            </div>
        `;

        marker.bindPopup(popupContent);
        
        // Add zoom and open popup on marker click
        marker.on('click', (e) => {
            map.flyTo(e.latlng, 16);
            // Small timeout ensures the popup opens after the animation starts/settles
            setTimeout(() => {
                marker.openPopup();
            }, 300);
        });

        markers[issue.id] = marker;
        clusterGroup.addLayer(marker);

        // Add to Sidebar List
        const card = document.createElement('div');
        card.className = 'issue-card';
        card.innerHTML = `
            <div class="issue-header">
                <span class="issue-category">${issue.category}</span>
                <div class="issue-status status-${issue.status}"></div>
            </div>
            <div style="font-size: 0.75rem; color: #94a3b8; margin-bottom: 0.25rem;">#${issue.ticket_id}</div>
            <div class="issue-title" style="font-weight: 600;">${issue.title}</div>
            <div class="issue-location">
                <i class="fa-solid fa-location-dot"></i> Freetown, SL
            </div>
            <div class="issue-meta">
                <span>${new Date(issue.reported_on || issue.created_at).toLocaleDateString()}</span>
                <div class="vote-count">
                    <i class="fa-solid fa-arrow-up"></i> ${issue.upvotes || 0}
                </div>
            </div>
        `;

        card.addEventListener('click', () => {
            map.flyTo([issue.lat, issue.lng], 16);
            setTimeout(() => {
                marker.openPopup();
            }, 300);
            
            document.querySelectorAll('.issue-card').forEach(c => c.style.borderColor = 'var(--border-color)');
            card.style.borderColor = 'var(--primary-color)';
        });

        issueList.appendChild(card);
    });

    map.addLayer(clusterGroup);

    // Auto-open popup if ticket param exists
    const urlParams = new URLSearchParams(window.location.search);
    const ticketId = urlParams.get('ticket');
    if (ticketId && issues.length > 0) {
        // Find the marker for this ticket
        const issue = issues.find(i => i.ticket_id === ticketId);
        if (issue && markers[issue.id]) {
            map.flyTo([issue.lat, issue.lng], 16);
            markers[issue.id].openPopup();
        }
    }
}

// User Location (Dummy)
function locateUser() {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(position => {
            const { latitude, longitude } = position.coords;
            map.flyTo([8.484, -13.23], 15);
            L.marker([8.484, -13.23], {
                icon: L.divIcon({
                    html: '<div style="color: var(--primary-color); font-size: 24px;"><i class="fa-solid fa-location-crosshairs"></i></div>',
                    className: 'user-loc-icon'
                })
            }).addTo(map).bindPopup("You are here").openPopup();
        });
    } else {
        alert("Geolocation is not supported by this browser.");
    }
}



async function vote(issueId, voteType) {
    // Voting is temporarily disabled on the frontend
    alert("Voting is currently disabled on the website. Please use our WhatsApp channel to vote.");
    return;

    /*
    // For demo purposes, we'll use a dummy phone number
    // In production, this would come from user authentication
    const userPhone = prompt("Enter your phone number to vote (e.g., 23276123456):");
    
    if (!userPhone) return;

    try {
        const response = await fetch(`http://localhost:5000/api/issues/${issueId}/vote`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                user_phone: userPhone,
                vote_type: voteType
            })
        });

        const result = await response.json();
        
        if (response.ok) {
            alert(`${voteType === 'upvote' ? 'Upvote' : 'Downvote'} recorded successfully!`);
            // Refresh the issues to show updated vote counts
            fetchIssues();
        } else {
            alert(`Error: ${result.error}`);
        }
    } catch (error) {
        console.error('Error voting:', error);
        alert('Failed to record vote. Please try again.');
    }
    */
}

async function viewTracker(issueId) {
    try {
        const response = await fetch(`${API_BASE_URL}/issues/${issueId}/tracker`);
        const trackerLogs = await response.json();

        if (!response.ok) {
            alert('Failed to load issue history');
            return;
        }

        // Create modal to display tracker logs
        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.7);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
        `;

        const modalContent = document.createElement('div');
        modalContent.style.cssText = `
            background: white;
            padding: 2rem;
            border-radius: 12px;
            max-width: 600px;
            max-height: 80vh;
            overflow-y: auto;
            box-shadow: 0 10px 40px rgba(0,0,0,0.3);
        `;

        let trackerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
                <h2 style="margin: 0; color: var(--text-color);">Issue History</h2>
                <button onclick="this.closest('[style*=fixed]').remove()" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #64748b;">&times;</button>
            </div>
        `;

        if (trackerLogs.length === 0) {
            trackerHTML += '<p style="color: #64748b;">No history available for this issue.</p>';
        } else {
            trackerHTML += '<div style="position: relative; padding-left: 2rem;">';
            
            trackerLogs.forEach((log, index) => {
                const isLast = index === trackerLogs.length - 1;
                trackerHTML += `
                    <div style="position: relative; padding-bottom: ${isLast ? '0' : '1.5rem'};">
                        <div style="position: absolute; left: -2rem; top: 0; width: 12px; height: 12px; border-radius: 50%; background: var(--primary-color); border: 3px solid white; box-shadow: 0 0 0 2px var(--primary-color);"></div>
                        ${!isLast ? '<div style="position: absolute; left: -1.44rem; top: 12px; width: 2px; height: calc(100% - 12px); background: #e2e8f0;"></div>' : ''}
                        <div>
                            <div style="font-weight: 600; color: var(--text-color); text-transform: capitalize;">${log.action.replace('_', ' ')}</div>
                            <div style="font-size: 0.9rem; color: #64748b; margin-top: 0.25rem;">${log.description || 'No description'}</div>
                            ${log.performed_by_name ? `<div style="font-size: 0.85rem; color: #94a3b8; margin-top: 0.25rem;">By: ${log.performed_by_name}</div>` : ''}
                            <div style="font-size: 0.8rem; color: #cbd5e1; margin-top: 0.25rem;">${new Date(log.created_at).toLocaleString()}</div>
                        </div>
                    </div>
                `;
            });
            
            trackerHTML += '</div>';
        }

        modalContent.innerHTML = trackerHTML;
        modal.appendChild(modalContent);
        document.body.appendChild(modal);

        // Close on background click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    } catch (error) {
        console.error('Error fetching tracker logs:', error);
        alert('Failed to load issue history');
    }
}

// Initial Fetch
fetchIssues();
