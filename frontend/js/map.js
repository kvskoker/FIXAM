// Initialize Map
const map = L.map('map').setView([8.484, -13.23], 14);
const API_BASE_URL = `http://${window.location.hostname}:5000/api`;

// Add OpenStreetMap Tiles
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

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

const markers = {};
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

        const response = await fetch(`${API_BASE_URL}/issues?${params.toString()}`);
        if (!response.ok) throw new Error('Network response was not ok');
        const issues = await response.json();
        renderIssues(issues);
    } catch (error) {
        console.error('Error fetching issues:', error);
        issueList.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--danger-color);">Failed to load issues.</div>';
    }
}

function renderIssues(issues) {
    // Clear existing markers
    Object.values(markers).forEach(marker => map.removeLayer(marker));
    for (const key in markers) delete markers[key];

    issueList.innerHTML = ''; // Clear loading

    issues.forEach(issue => {
        // Add Marker
        const color = getStatusColor(issue.status);
        const marker = L.marker([issue.lat, issue.lng], {
            icon: createIcon(color)
        }).addTo(map);

        // Popup Content
        const popupContent = `
            <div class="popup-content">
                <img src="${issue.image_url || 'https://via.placeholder.com/400'}" class="popup-image" alt="${issue.title}">
                <div class="issue-category" style="display: inline-block; margin-bottom: 0.5rem;">${issue.category}</div>
                <div class="popup-title">${issue.title}</div>
                <div style="font-size: 0.8rem; color: #64748b; margin-bottom: 0.5rem;">Ticket ID: <strong>${issue.ticket_id}</strong></div>
                <div class="popup-desc">${issue.description}</div>
                ${issue.reported_by_name ? `<div style="font-size: 0.85rem; color: #64748b; margin-top: 0.5rem;">Reported by: ${issue.reported_by_name}</div>` : ''}
                <div class="popup-actions">
                    <button class="btn btn-primary" onclick="vote(${issue.id}, 'upvote')">
                        <i class="fa-solid fa-arrow-up"></i> Upvote (${issue.upvotes || 0})
                    </button>
                    <button class="btn btn-outline" onclick="vote(${issue.id}, 'downvote')">
                        <i class="fa-solid fa-arrow-down"></i> Downvote (${issue.downvotes || 0})
                    </button>
                </div>
                <div style="margin-top: 0.5rem;">
                    <button class="btn btn-outline" onclick="viewTracker(${issue.id})" style="width: 100%;">
                        <i class="fa-solid fa-clock-rotate-left"></i> View Issue History
                    </button>
                </div>
            </div>
        `;

        marker.bindPopup(popupContent);
        markers[issue.id] = marker;

        // Add to Sidebar List
        const card = document.createElement('div');
        card.className = 'issue-card';
        card.innerHTML = `
            <div class="issue-header">
                <span class="issue-category">${issue.category}</span>
                <div class="issue-status status-${issue.status}"></div>
            </div>
            <div style="font-size: 0.75rem; color: #94a3b8; margin-bottom: 0.25rem;">#${issue.ticket_id}</div>
            <div class="issue-title">${issue.title}</div>
            <div class="issue-location">
                <i class="fa-solid fa-location-dot"></i> Freetown, SL
            </div>
            ${issue.reported_by_name ? `<div style="font-size: 0.8rem; color: #64748b;">By: ${issue.reported_by_name}</div>` : ''}
            <div class="issue-meta">
                <span>${new Date(issue.reported_on || issue.created_at).toLocaleDateString()}</span>
                <div class="vote-count">
                    <i class="fa-solid fa-arrow-up"></i> ${issue.votes || 0}
                </div>
            </div>
        `;

        card.addEventListener('click', () => {
            map.flyTo([issue.lat, issue.lng], 16);
            marker.openPopup();
            
            // Highlight active card
            document.querySelectorAll('.issue-card').forEach(c => c.style.borderColor = 'var(--border-color)');
            card.style.borderColor = 'var(--primary-color)';
        });

        issueList.appendChild(card);
    });
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
    alert("Voting is currently disabled on the website. Please use our WhatsApp bot to vote.");
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
