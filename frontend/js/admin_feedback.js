let allFeedback = [];
let currentPage = 1;
const itemsPerPage = 10;
let filteredFeedback = [];

document.addEventListener('DOMContentLoaded', () => {
    // Check Auth
    checkAuth(() => {
        loadFeedback();

        // Event Listeners
        document.getElementById('feedback-search').addEventListener('input', () => { currentPage = 1; filterFeedback(); });
        document.getElementById('filter-type').addEventListener('change', () => { currentPage = 1; filterFeedback(); });
        document.getElementById('filter-status').addEventListener('change', () => { currentPage = 1; filterFeedback(); });
    });
});

async function loadFeedback() {
    try {
        const response = await fetch(`${API_BASE_URL}/admin/feedback`);
        allFeedback = await response.json();
        filterFeedback();
    } catch (err) {
        console.error('Error loading feedback:', err);
    }
}

function filterFeedback() {
    const searchTerm = document.getElementById('feedback-search').value.toLowerCase();
    const typeFilter = document.getElementById('filter-type').value;
    const statusFilter = document.getElementById('filter-status').value;

    filteredFeedback = allFeedback.filter(item => {
        const matchesSearch = (item.user_name && item.user_name.toLowerCase().includes(searchTerm)) || 
                              (item.phone_number && item.phone_number.includes(searchTerm)) ||
                              (item.content && item.content.toLowerCase().includes(searchTerm)) ||
                              (item.transcription && item.transcription.toLowerCase().includes(searchTerm));
        
        const matchesType = typeFilter === 'all' || item.type === typeFilter;
        const matchesStatus = statusFilter === 'all' || item.status === statusFilter;

        return matchesSearch && matchesType && matchesStatus;
    });

    // Pagination Logic
    const totalPages = Math.ceil(filteredFeedback.length / itemsPerPage);
    if (currentPage > totalPages) currentPage = 1;
    if (currentPage < 1) currentPage = 1;
    if (totalPages === 0) currentPage = 1;

    const start = (currentPage - 1) * itemsPerPage;
    const paginatedItems = filteredFeedback.slice(start, start + itemsPerPage);

    renderFeedback(paginatedItems);
    renderPagination(filteredFeedback.length, totalPages);
}

function renderFeedback(feedbackList) {
    const list = document.getElementById('feedback-list');
    list.innerHTML = '';

    if (feedbackList.length === 0) {
        list.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--admin-text-muted);">No feedback found.</td></tr>';
        return;
    }

    feedbackList.forEach(item => {
        const row = document.createElement('tr');
        
        let typeIcon = item.type === 'audio' ? '<i class="fa-solid fa-microphone type-icon"></i>' : '<i class="fa-solid fa-align-left type-icon"></i>';
        let audioPlayer = item.type === 'audio' && item.media_url ? 
            `<audio controls src="${item.media_url}" style="height: 30px; width: 200px;"></audio>` : 
            '<span style="color: var(--admin-text-muted);">-</span>';

        let statusBadge = item.status === 'acknowledged' ? 
            '<span class="status-badge status-acknowledged">Acknowledged</span>' : 
            '<span class="status-badge status-pending">Pending</span>';

        let actionBtn = item.status === 'pending' ? 
            `<button class="btn btn-success" onclick="acknowledgeFeedback(${item.id})" style="font-size: 0.8rem; padding: 0.4rem 0.8rem;">
                <i class="fa-solid fa-check"></i> Acknowledge
            </button>` : 
            '';

        row.innerHTML = `
            <td data-label="User">
                <div style="font-weight: 500;">${item.user_name || 'Unknown'}</div>
                <div style="font-size: 0.85rem; color: var(--admin-text-muted);">${item.phone_number}</div>
            </td>
            <td data-label="Type">${typeIcon} ${item.type.toUpperCase()}</td>
            <td data-label="Feedback/Transcription">
                <div style="max-width: 300px; white-space: pre-wrap;">${item.transcription || item.content || '-'}</div>
            </td>
            <td data-label="Audio">${audioPlayer}</td>
            <td data-label="Date" style="font-size: 0.9rem; color: var(--admin-text-muted);">
                ${new Date(item.created_at).toLocaleString()}
            </td>
            <td data-label="Status">${statusBadge}</td>
            <td data-label="Actions" style="text-align: right;">
                ${actionBtn}
            </td>
        `;
        list.appendChild(row);
    });
}

function renderPagination(totalItems, totalPages) {
    const paginationContainer = document.getElementById('feedback-pagination');
    if (!paginationContainer) return;

    let html = `
        <span id="pagination-info" style="font-size: 0.9rem; color: var(--admin-text-muted);">
            Showing ${(currentPage - 1) * itemsPerPage + 1}-${Math.min(currentPage * itemsPerPage, totalItems)} of ${totalItems} results
        </span>
        <div class="pagination-numbers">
    `;

    // Previous Button
    html += `<button class="page-btn" onclick="changePage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left"></i></button>`;

    // Page Numbers
    for (let i = 1; i <= totalPages; i++) {
        // Show first, last, current, and surrounding pages
        if (i === 1 || i === totalPages || (i >= currentPage - 1 && i <= currentPage + 1)) {
            html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="changePage(${i})">${i}</button>`;
        } else if (i === currentPage - 2 || i === currentPage + 2) {
            html += `<span style="display:flex;align-items:flex-end;padding:0 4px;">...</span>`;
        }
    }

    // Next Button
    html += `<button class="page-btn" onclick="changePage(${currentPage + 1})" ${currentPage === totalPages || totalPages === 0 ? 'disabled' : ''}><i class="fa-solid fa-chevron-right"></i></button>`;

    html += `</div>`;
    paginationContainer.innerHTML = html;
}

window.changePage = function(page) {
    currentPage = page;
    filterFeedback();
    // Scroll to top of table
    document.querySelector('.admin-table-container').scrollIntoView({ behavior: 'smooth' });
};

window.acknowledgeFeedback = async function(id) {
    try {
        const response = await fetch(`${API_BASE_URL}/admin/feedback/${id}/acknowledge`, {
            method: 'POST'
        });

        if (response.ok) {
            loadFeedback(); // Refresh list to get updated status
        } else {
            alert('Failed to acknowledge feedback');
        }
    } catch (err) {
        console.error('Error acknowledging feedback:', err);
    }
};
