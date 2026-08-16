
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

// Closing a report without fixing it is a public statement, so the reason is
// written the way it would be said to the person who reported it.
const CLOSURE_LABELS = {
    no_longer_present: 'the problem was no longer there when the team attended',
    not_actionable: 'there was not enough to act on',
    not_feasible: 'it cannot be addressed at present'
};

/**
 * Badge showing how far the speech engine trusted its own transcription.
 *
 * Shown next to the transcribed text so a reader can decide, before acting on
 * it, whether to trust the words or play the recording instead. Returns '' when
 * there is no audio or no score -- an absent measurement must not be drawn as
 * "0% confident".
 *
 * Thresholds are a starting point calibrated on English test audio: clear
 * speech scored ~0.69, while a degraded clip that produced a fluent but wrong
 * transcription scored ~0.07. They should be revisited against real voice
 * notes, and especially against Krio, where the model is known to be weak.
 */
function transcriptionConfidenceBadge(issue) {
    if (!issue.audio_url) return '';

    const raw = issue.transcription_confidence;
    if (raw === null || raw === undefined) return '';

    const pct = Math.round(Number(raw) * 100);
    let label, bg, fg, hint;

    if (pct >= 60) {
        label = 'High confidence';
        bg = 'var(--admin-success)'; fg = '#fff';
        hint = 'The speech engine was confident in this transcription.';
    } else if (pct >= 30) {
        label = 'Medium confidence';
        bg = 'var(--admin-warning)'; fg = '#1a202c';
        hint = 'Parts of this transcription may be wrong. Play the audio to check.';
    } else {
        label = 'Low confidence';
        bg = 'var(--admin-danger)'; fg = '#fff';
        hint = 'This transcription is probably unreliable. Listen to the recording instead.';
    }

    return `<span title="${hint} (score ${pct}%)" style="background: ${bg}; color: ${fg}; border-radius: 4px; padding: 1px 7px; font-size: 0.72rem; font-weight: 600; white-space: nowrap; margin-left: 0.4rem;">&#127897; ${label} &middot; ${pct}%</span>`;
}

// Maintenance Mode handled by maintenance.js


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

let activeMarkerIndicator = null;

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
const startDateInput = document.getElementById('start-date');
const endDateInput = document.getElementById('end-date');

// Set default date range: last 6 months and restrict future dates
if (startDateInput && endDateInput) {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    
    // Restrict to current date
    startDateInput.max = todayStr;
    endDateInput.max = todayStr;
    
    // No default values — show ALL issues unless user explicitly filters
    // This avoids timezone mismatches hiding newly-reported issues.
    
    // Ensure end date cannot be before start date
    startDateInput.addEventListener('change', () => {
        endDateInput.min = startDateInput.value;
    });
    endDateInput.addEventListener('change', () => {
        startDateInput.max = endDateInput.value;
    });
}

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
if (startDateInput) startDateInput.addEventListener('change', () => fetchIssues());
if (endDateInput) endDateInput.addEventListener('change', () => fetchIssues());

// Fetch Data from API
async function fetchIssues() {
    try {
        const params = new URLSearchParams();
        if (searchInput && searchInput.value) params.append('search', searchInput.value);
        if (categoryFilter && categoryFilter.value) params.append('category', categoryFilter.value);
        if (statusFilter && statusFilter.value) params.append('status', statusFilter.value);
        if (sortFilter && sortFilter.value) params.append('sort', sortFilter.value);
        if (startDateInput && startDateInput.value) params.append('start_date', startDateInput.value);
        if (endDateInput && endDateInput.value) params.append('end_date', endDateInput.value);

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
/**
 * Is this report's evidence a video?
 *
 * The type recorded when the file was stored is the authority; the extension is
 * only a fallback for files saved before that was captured. Guessing from the
 * name alone missed anything the extension list did not anticipate -- a
 * Matroska video was rendered into an <img>, which simply failed, so the report
 * appeared to have no evidence at all.
 *
 * Accepts either an issue or a bare URL, because the map calls it from places
 * that only have one or the other.
 */
function isVideo(issueOrUrl) {
    if (!issueOrUrl) return false;

    if (typeof issueOrUrl === 'object') {
        const mime = (issueOrUrl.image_mime_type || '').toLowerCase();
        if (mime) return mime.startsWith('video/');
        return isVideo(issueOrUrl.image_url);
    }

    return /\.(mp4|webm|ogg|mov|mkv|m4v|avi|3gp)$/i.test(issueOrUrl);
}

/** Markup for a report with no evidence attached, or evidence that failed. */
function noMediaBlock(height) {
    return `<div style="width: 100%; height: ${height}; display: flex; flex-direction: column;
                 align-items: center; justify-content: center; gap: 6px; background: var(--background-color);
                 border: 1px dashed var(--border-color); border-radius: 8px; margin-bottom: 8px;
                 color: var(--text-secondary); font-size: 0.78rem;">
                <i class="fa-regular fa-image" style="opacity: 0.4; font-size: 1.4rem;"></i>
                <span>No photo or video</span>
            </div>`;
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

// Global function to show specific issue page in a popup
window.showIssuePage = function(locKey, targetIndex, total, issueId) {
    for(let i = 0; i < total; i++) {
        const el = document.getElementById(`issue-page-${locKey}-${i}`);
        if(el) {
            el.style.display = (i === targetIndex) ? 'block' : 'none';
        }
    }
    if (issueId) {
        viewTracker(issueId);
    }
};

// Helper: Format address (Max 3 levels)
function formatAddress(address) {
    if (!address) return null;
    const parts = address.split(',').map(p => p.trim());
    if (parts.length > 3) {
        return parts.slice(0, 3).join(', ');
    }
    return address;
}

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

    // Group issues by coordinates
    const locationGroups = {};
    window.issueMap = {};
    issues.forEach(issue => {
        window.issueMap[issue.id] = issue;
        if (!issue.lat || !issue.lng) return;
        const lat = parseFloat(issue.lat).toFixed(6);
        const lng = parseFloat(issue.lng).toFixed(6);
        const locKey = `${lat}_${lng}`;
        
        if (!locationGroups[locKey]) locationGroups[locKey] = [];
        locationGroups[locKey].push(issue);
    });

    Object.keys(locationGroups).forEach(locKey => {
        const locationIssues = locationGroups[locKey];
        const firstIssue = locationIssues[0];
        const statusType = getStatusType(firstIssue.status);
        const color = `rgb(${colors[statusType].r}, ${colors[statusType].g}, ${colors[statusType].b})`;

        // Add Marker
        const marker = L.circleMarker([firstIssue.lat, firstIssue.lng], {
            radius: 8,
            fillColor: color,
            color: '#fff',
            weight: 2,
            opacity: 1,
            fillOpacity: 0.8,
            status: firstIssue.status
        });

        const safeLocKey = locKey.replace(/\./g, '_').replace(/-/g, 'm');

        let allPopupsContent = locationIssues.map((issue, index) => {
            const currentStatusType = getStatusType(issue.status);
            const currentColor = `rgb(${colors[currentStatusType].r}, ${colors[currentStatusType].g}, ${colors[currentStatusType].b})`;
            
            let mediaContent = '';
            if (isVideo(issue)) {
                mediaContent = `
                    <div class="video-container" style="position: relative; width: 100%; height: 150px; margin-bottom: 0.5rem; border-radius: 0.5rem; overflow: hidden; background: #000;">
                        <video src="${issue.image_url}" style="width: 100%; height: 100%; object-fit: cover;" preload="metadata" onclick="playVideo(this.parentElement)"></video>
                        <div class="play-button" onclick="playVideo(this.parentElement)" style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 40px; height: 40px; background: rgba(0,0,0,0.6); border-radius: 50%; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(2px); cursor: pointer; z-index: 10;">
                            <i class="fa-solid fa-play" style="color: white; font-size: 16px; margin-left: 2px;"></i>
                        </div>
                    </div>
                `;
            } else {
                mediaContent = issue.image_url
                    ? `<img src="${issue.image_url}" class="popup-image" alt="${escapeHtml(issue.title)}"
                           style="width: 100%; height: 120px; object-fit: cover; border-radius: 8px; margin-bottom: 8px;"
                           onerror="this.outerHTML = noMediaBlock('120px')">`
                    : noMediaBlock('120px');
            }

            let audioContent = '';
            if (issue.audio_url) {
                audioContent = `
                    <div style="margin-bottom: 10px;">
                        <div style="font-size: 0.75rem; color: var(--text-secondary); margin-bottom: 4px;">Voice Report:</div>
                        <audio controls src="${issue.audio_url}" style="width: 100%; height: 32px; border-radius: 4px;"></audio>
                    </div>
                `;
            }

            const paginationHtml = locationIssues.length > 1 ? `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 10px; border-top: 1px solid var(--border-color); padding-top: 10px;">
                    <button class="btn btn-sm" style="padding: 4px 8px; font-size: 0.8rem; border-radius:4px; border:1px solid #ccc; background:var(--surface-color); color:var(--text-primary); cursor:pointer;" onclick="event.stopPropagation(); window.showIssuePage('${safeLocKey}', ${index - 1}, ${locationIssues.length}, ${index > 0 ? locationIssues[index-1].id : 'null'})" ${index === 0 ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''}>Previous</button>
                    <span style="font-size: 0.8rem; font-weight: bold; color: var(--text-primary);">${index + 1} of ${locationIssues.length}</span>
                    <button class="btn btn-sm" style="padding: 4px 8px; font-size: 0.8rem; border-radius:4px; border:1px solid #ccc; background:var(--surface-color); color:var(--text-primary); cursor:pointer;" onclick="event.stopPropagation(); window.showIssuePage('${safeLocKey}', ${index + 1}, ${locationIssues.length}, ${index < locationIssues.length - 1 ? locationIssues[index+1].id : 'null'})" ${index === locationIssues.length - 1 ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''}>Next</button>
                </div>
            ` : '';

            return `
                <div id="issue-page-${safeLocKey}-${index}" style="display: ${index === 0 ? 'block' : 'none'};">
                    <div class="popup-content" style="min-width: 250px; padding: 5px;">
                        ${mediaContent}
                        ${audioContent}
                        
                        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                             <div style="font-size: 0.7rem; font-weight: 650; color: ${currentColor}; text-transform: uppercase;">${escapeHtml(issue.category)}</div>
                             <span style="background: rgba(${colors[currentStatusType].r}, ${colors[currentStatusType].g}, ${colors[currentStatusType].b}, 0.15); color: ${currentColor}; padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: 600; text-transform: capitalize;">${issue.status}</span>
                        </div>
                        <div class="popup-title" style="font-weight: 700; font-size: 1.1rem; margin-bottom: 12px; color: var(--text-primary); line-height: 1.3;">${escapeHtml(issue.title)}</div>
                        
                        <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 15px; display: flex; align-items: center; justify-content: space-between;">
                            <span style="font-weight: 500;">Issue ID:</span>
                            <span style="color: var(--text-primary); font-family: monospace; font-weight: 600;">#${escapeHtml(issue.ticket_id)}</span>
                        </div>

                        ${paginationHtml}
                    </div>
                </div>
            `;
        }).join('');

        marker.bindPopup(`<div>${allPopupsContent}</div>`, {
            autoPan: true,
            autoPanPaddingTopLeft: L.point(10, 20),
            autoPanPaddingBottomRight: L.point(10, 20),
            closeButton: true,
            minWidth: 260,
            maxWidth: 260
        });
        
        // Add zoom and open popup on marker click
        marker.on('click', (e) => {
            L.DomEvent.stopPropagation(e); // Prevent map click handler from triggering
            viewTracker(locationIssues[0].id);
            marker.openPopup();
            map.setView(e.latlng, 16, { animate: true, duration: 1.5 });
        });

        clusterGroup.addLayer(marker);

        locationIssues.forEach((issue, index) => {
            markers[issue.id] = marker;

            // Add to Sidebar List
            const card = document.createElement('div');
            card.className = 'issue-card';
            card.innerHTML = `
                <div class="issue-header">
                    <span class="issue-category">${escapeHtml(issue.category)}</span>
                    <div class="issue-status status-${issue.status}"></div>
                </div>
                <div style="font-size: 0.75rem; color: #94a3b8; margin-bottom: 0.25rem;">#${escapeHtml(issue.ticket_id)}</div>
                <div class="issue-title" style="font-weight: 600;">${escapeHtml(issue.title)}</div>
                <div class="issue-location">
                    <i class="fa-solid fa-location-dot"></i> ${formatAddress(issue.address) || 'Freetown, SL'}
                </div>            
                <div class="issue-meta">
                    <span>${new Date(issue.reported_on || issue.created_at).toLocaleDateString('en-GB')}</span>
                    <div class="vote-count">
                        <i class="fa-solid fa-arrow-up"></i> ${issue.upvotes || 0}
                    </div>
                </div>
            `;

            card.addEventListener('click', () => {
                viewTracker(issue.id);
                clusterGroup.zoomToShowLayer(marker, () => {
                    marker.openPopup();
                    map.setView([issue.lat, issue.lng], 16, { animate: true, duration: 1.5 });
                    if (locationIssues.length > 1) {
                        window.showIssuePage(safeLocKey, index, locationIssues.length, issue.id);
                    }
                });
                
                document.querySelectorAll('.issue-card').forEach(c => c.style.borderColor = 'var(--border-color)');
                card.style.borderColor = 'var(--primary-color)';
            });

            issueList.appendChild(card);
        });
    });

    map.addLayer(clusterGroup);

    // Auto-open popup if ticket param exists
    const urlParams = new URLSearchParams(window.location.search);
    const ticketId = urlParams.get('ticket');
    if (ticketId && issues.length > 0) {
        // Find the marker for this ticket
        const issue = issues.find(i => i.ticket_id === ticketId);
        if (issue && markers[issue.id]) {
            viewTracker(issue.id);
            clusterGroup.zoomToShowLayer(markers[issue.id], () => {
                markers[issue.id].openPopup();
                map.setView([issue.lat, issue.lng], 16, { animate: true, duration: 1.5 });
            });
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
        const response = await fetch(`${API_BASE_URL}/issues/${issueId}/vote`, {
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

// Close tracker panel
window.closeTrackerPanel = function() {
    const historyPanel = document.getElementById('issue-details-panel');
    if (historyPanel) {
        historyPanel.style.display = 'none';
        setTimeout(() => map.invalidateSize(), 50);
    }
}

async function viewTracker(issueId) {
    try {
        const response = await fetch(`${API_BASE_URL}/issues/${issueId}/tracker`);
        const trackerLogs = await response.json();

        if (!response.ok) {
            alert('Failed to load issue history');
            return;
        }

        const panel = document.getElementById('issue-details-panel');
        const contentDiv = document.getElementById('issue-details-content');
        
        if (!panel || !contentDiv) return;

        const issue = window.issueMap[issueId];

        // Indicate active marker with Pin Drop + Wave
        if (activeMarkerIndicator) {
            map.removeLayer(activeMarkerIndicator);
            activeMarkerIndicator = null;
        }

        if (issue && issue.lat && issue.lng) {
            activeMarkerIndicator = L.marker([issue.lat, issue.lng], {
                icon: L.divIcon({
                    className: '',
                    html: `
                        <div class="active-marker-wrapper">
                            <div class="active-marker-wave"></div>
                        </div>
                    `,
                    iconSize: [40, 40],
                    iconAnchor: [20, 20]
                }),
                interactive: false,
                zIndexOffset: 1000
            }).addTo(map);
        }

        let detailsHTML = '';
        if (issue) {
            detailsHTML += `
                <div class="issue-details-grid">
                    
                    <!-- Left Column: Details & History -->
                    <div class="details-col-left">
                        <div>
                            <div style="display: flex; gap: 0.75rem; align-items: center; margin-bottom: 0.75rem;">
                                <span style="font-size: 0.7rem; font-weight: 700; text-transform: uppercase; color: var(--text-secondary); letter-spacing: 0.5px;">${escapeHtml(issue.category)}</span>
                                <span style="padding: 3px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: 600; text-transform: capitalize; background: rgba(0,0,0,0.05); color: var(--text-primary); border: 1px solid var(--border-color);">${issue.status}</span>
                            </div>
                            <h2 style="margin: 0 0 1rem 0; color: var(--text-primary); font-size: 1.75rem; line-height: 1.2; font-weight: 700;">${escapeHtml(issue.title)}</h2>
                            <div style="font-size: 1rem; color: var(--text-secondary); line-height: 1.6; margin-bottom: 1.5rem;">
                                ${escapeHtml(issue.description)}${transcriptionConfidenceBadge(issue)}
                            </div>
                        </div>

                        <!-- Info Card -->
                        <div style="background: var(--background-color); padding: 1.25rem; border-radius: 12px; border: 1px solid var(--border-color); display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px;">
                            <div>
                                <div style="font-size: 0.75rem; color: var(--text-secondary); margin-bottom: 4px; font-weight: 600; text-transform: uppercase;">Issue ID</div>
                                <div style="color: var(--text-primary); font-family: monospace; font-weight: 700; font-size: 1.1rem;">#${escapeHtml(issue.ticket_id)}</div>
                            </div>
                            <div>
                                <div style="font-size: 0.75rem; color: var(--text-secondary); margin-bottom: 4px; font-weight: 600; text-transform: uppercase;">Reported On</div>
                                <div style="color: var(--text-primary); font-weight: 600;">${new Date(issue.reported_on || issue.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
                            </div>
                            <div>
                                <div style="font-size: 0.75rem; color: var(--text-secondary); margin-bottom: 4px; font-weight: 600; text-transform: uppercase;">Reported By</div>
                                <div style="color: var(--text-primary); font-weight: 600;">${issue.reported_by_name || 'Anonymous citizen'}</div>
                            </div>
                            <div>
                                <div style="font-size: 0.75rem; color: var(--text-secondary); margin-bottom: 4px; font-weight: 600; text-transform: uppercase;">Address</div>
                                <div style="color: var(--text-primary); font-weight: 600; font-size: 0.85rem; line-height: 1.3;">${formatAddress(issue.address) || 'Location not specified'}</div>
                            </div>
                            <div>
                                <div style="font-size: 0.75rem; color: var(--text-secondary); margin-bottom: 4px; font-weight: 600; text-transform: uppercase;">Community Support</div>
                                <div style="display: flex; gap: 15px; align-items: center;">
                                    <div title="Upvotes" style="color: var(--admin-success); font-weight: 700; display: flex; align-items: center; gap: 4px;">
                                        <i class="fa-solid fa-arrow-up"></i> ${issue.upvotes || 0}
                                    </div>
                                    <div title="Downvotes" style="color: var(--danger-color); font-weight: 700; display: flex; align-items: center; gap: 4px;">
                                        <i class="fa-solid fa-arrow-down"></i> ${issue.downvotes || 0}
                                    </div>
                                </div>
                            </div>
                        </div>

                        ${issue.status === 'fixed' && issue.resolution_note ? `
                            <div style="background: rgba(34, 197, 94, 0.05); border: 1px solid rgba(34, 197, 94, 0.2); border-radius: 12px; padding: 1.25rem;">
                                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
                                    <div style="color: var(--admin-success); font-weight: 700; font-size: 0.75rem; text-transform: uppercase; display: flex; align-items: center; gap: 6px;">
                                        <i class="fa-solid fa-circle-check"></i> Resolution Note
                                    </div>
                                    <div title="Citizen Endorsements" style="background: #22c55e; color: white; padding: 2px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: 700; display: flex; align-items: center; gap: 6px;">
                                        <i class="fa-solid fa-thumbs-up"></i> ${issue.endorsements || 0} Endorsed
                                    </div>
                                </div>
                                <div style="color: var(--text-primary); font-size: 0.95rem; line-height: 1.5;">${escapeHtml(issue.resolution_note)}</div>
                            </div>
                        ` : ''}

                        ${issue.closed_at && issue.closure_reason !== 'resolved'
                          && issue.closure_reason !== 'duplicate' && issue.closure_reason !== 'spam'
                          && issue.closure_note ? `
                            <div style="background: rgba(245, 158, 11, 0.05); border: 1px solid rgba(245, 158, 11, 0.25); border-radius: 12px; padding: 1.25rem;">
                                <div style="color: var(--admin-warning); font-weight: 700; font-size: 0.75rem; text-transform: uppercase; display: flex; align-items: center; gap: 6px; margin-bottom: 6px;">
                                    <i class="fa-solid fa-folder-closed"></i>
                                    Closed without a repair · ${CLOSURE_LABELS[issue.closure_reason] || 'reason not recorded'}
                                </div>
                                <div style="color: var(--text-primary); font-size: 0.95rem; line-height: 1.5;">${escapeHtml(issue.closure_note)}</div>
                            </div>
                        ` : ''}

                        <!-- Activity History -->
                        <div style="margin-top: 1rem;">
                            <h3 style="margin: 0 0 1.25rem 0; color: var(--text-primary); font-size: 1.1rem; font-weight: 700; display: flex; align-items: center; gap: 10px;">
                                <i class="fa-solid fa-timeline" style="color: var(--admin-primary);"></i> Activity History
                            </h3>
                            ${trackerLogs.length === 0 ? '<p style="color: var(--text-secondary); font-style: italic;">No history available yet.</p>' : `
                            <div style="position: relative; padding-left: 1.5rem; border-left: 2px solid var(--border-color); margin-left: 5px;">
                                ${trackerLogs.map((log, index) => {
                                    return `
                                        <div style="position: relative; padding-bottom: 1.5rem; padding-left: 1rem;">
                                            <div style="position: absolute; left: -1.9rem; top: 4px; width: 10px; height: 10px; border-radius: 50%; background: var(--admin-primary); border: 2px solid var(--surface-color);"></div>
                                            <div style="font-weight: 600; color: var(--text-primary); font-size: 0.9rem; text-transform: capitalize;">${log.action.replace('_', ' ')}</div>
                                            <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 2px;">${log.description || 'No description'}</div>
                                            <div style="font-size: 0.75rem; color: var(--text-secondary); opacity: 0.6; margin-top: 4px; font-weight: 500;">
                                                <i class="fa-regular fa-clock" style="margin-right: 4px;"></i> ${new Date(log.created_at).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}
                                            </div>
                                        </div>
                                    `;
                                }).join('')}
                            </div>`}
                        </div>
                    </div>

                    <!-- Right Column: Media Attachment -->
                    <div class="details-col-right">
                         <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                            <h3 style="margin: 0; color: var(--text-primary); font-size: 1.1rem; font-weight: 700; display: flex; align-items: center; gap: 10px;">
                                <i class="fa-solid fa-camera" style="color: var(--admin-primary);"></i> Media Evidence
                            </h3>
                            ${issue.image_url ? `
                                <button onclick="window.fullScreenMedia('${issue.image_url}', ${isVideo(issue)})" style="background: var(--admin-primary); border: none; color: white; padding: 6px 14px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 8px; font-size: 0.85rem; font-weight: 600; transition: opacity 0.2s;">
                                    <i class="fa-solid fa-expand"></i> Open Full Screen
                                </button>
                            ` : ''}
                        </div>
                        ${issue.image_url ? `
                            <div style="position: relative; width: 100%; border-radius: 12px; overflow: hidden; border: 1px solid var(--border-color);">
                                ${isVideo(issue) ? `
                                    <video src="${issue.image_url}" style="width: 100%; height: auto; display: block;"
                                           controls playsinline preload="metadata"></video>
                                ` : `
                                    <img src="${issue.image_url}" style="width: 100%; height: auto; display: block; cursor: zoom-in;"
                                         alt="Issue evidence" onclick="window.fullScreenMedia('${issue.image_url}', ${isVideo(issue)})">
                                `}
                            </div>
                        ` : `
                            <div style="flex: 1; background: var(--background-color); border: 2px dashed var(--border-color); border-radius: 12px; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--text-secondary); min-height: 350px;">
                                <i class="fa-solid fa-image-slash" style="font-size: 3rem; margin-bottom: 1rem; opacity: 0.3;"></i>
                                <span>No media evidence attached</span>
                            </div>
                        `}
                    </div>
                </div>
            `;
        }

        contentDiv.innerHTML = detailsHTML;
        panel.style.display = 'block';
        
        // Let leaflet know the map container changed size
        setTimeout(() => {
            map.invalidateSize();
        }, 50);

    } catch (error) {
        console.error('Error fetching tracker logs:', error);
        alert('Failed to load issue history');
    }
}

window.fullScreenMedia = function(url, isVideoMedia) {
    const modal = document.createElement('div');
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.95);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
        cursor: pointer;
    `;
    
    // The caller knows the recorded type; fall back to the name only when it
    // was not told.
    if (isVideoMedia === undefined ? isVideo(url) : isVideoMedia) {
        const video = document.createElement('video');
        video.src = url;
        video.controls = true;
        video.autoplay = true;
        video.style.maxWidth = '95%';
        video.style.maxHeight = '95%';
        modal.appendChild(video);
    } else {
        const img = document.createElement('img');
        img.src = url;
        img.style.maxWidth = '95%';
        img.style.maxHeight = '95%';
        img.style.objectFit = 'contain';
        modal.appendChild(img);
    }
    
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '&times;';
    closeBtn.style.cssText = `
        position: absolute;
        top: 20px;
        right: 30px;
        background: none;
        border: none;
        color: white;
        font-size: 3rem;
        cursor: pointer;
    `;
    modal.appendChild(closeBtn);
    
    modal.onclick = () => modal.remove();
    document.body.appendChild(modal);
}


// Initial Fetch
fetchIssues();
