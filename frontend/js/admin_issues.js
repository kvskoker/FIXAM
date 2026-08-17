// Include this after admin_common.js
let currentIssueId = null;
let issuePage = 1;
const issueLimit = 8;

/**
 * Two pages share this script: the report list, and the single-report page it
 * links to. Which one is running is decided by what is in the document rather
 * than by the URL, so the branch cannot drift out of step with the markup.
 *
 * Kept as one file rather than split in two because the two views share most of
 * their rendering -- location formatting, evidence flags, lifecycle badges --
 * and duplicating those to separate the entry points would be the more
 * expensive mistake.
 */
const isDetailPage = () => !!document.getElementById('issue-detail-card');

document.addEventListener('DOMContentLoaded', () => {
    if (isDetailPage()) {
        initIssueDetailPage();
        return;
    }

    checkAuth(async () => {
        // Load categories first
        await loadCategories();

        // Initialize filters from URL
        const urlParams = getURLParams();
        if (urlParams.search) document.getElementById('issue-search').value = urlParams.search;
        if (urlParams.category) document.getElementById('issue-filter-category').value = urlParams.category;
        if (urlParams.status) document.getElementById('issue-filter-status').value = urlParams.status;
        if (urlParams.urgency) document.getElementById('issue-filter-urgency').value = urlParams.urgency;
        if (urlParams.start_date) document.getElementById('issue-filter-start').value = urlParams.start_date;
        if (urlParams.end_date) document.getElementById('issue-filter-end').value = urlParams.end_date;
        if (urlParams.sort) document.getElementById('issue-sort').value = urlParams.sort;
        if (urlParams.page) issuePage = parseInt(urlParams.page);
        
        loadIssues();
    });

    // Issue Filters
    document.getElementById('issue-search').addEventListener('input', debounce(() => { 
        issuePage = 1; 
        syncFiltersToURL();
        loadIssues(); 
    }, 500));

    const exportBtn = document.getElementById('btn-export-issues');
    if (exportBtn) exportBtn.addEventListener('click', openExportModal);

    ['issue-filter-category', 'issue-filter-state', 'issue-filter-status', 'issue-filter-urgency', 'issue-filter-start', 'issue-filter-end', 'issue-sort'].forEach(id => {
        document.getElementById(id).addEventListener('change', () => { 
            issuePage = 1; 
            syncFiltersToURL();
            loadIssues(); 
        });
    });

    // Pagination Handlers
    document.getElementById('prev-page').addEventListener('click', () => {
        if (issuePage > 1) {
            issuePage--;
            syncFiltersToURL();
            loadIssues();
        }
    });

    document.getElementById('next-page').addEventListener('click', () => {
        issuePage++;
        syncFiltersToURL();
        loadIssues();
    });

    // Reset Filters
    const resetBtn = document.getElementById('reset-issues-filters');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            document.getElementById('issue-search').value = '';
            document.getElementById('issue-filter-category').value = '';
            document.getElementById('issue-filter-status').value = '';
            document.getElementById('issue-filter-urgency').value = '';
            document.getElementById('issue-filter-state').value = 'open';
            document.getElementById('issue-filter-start').value = '';
            document.getElementById('issue-filter-end').value = '';
            document.getElementById('issue-sort').value = 'newest';
            issuePage = 1;
            syncFiltersToURL();
            loadIssues();
        });
    }

    // Modal Close
    const closeModalBtn = document.getElementById('close-modal');
    if (closeModalBtn) closeModalBtn.addEventListener('click', closeIssueModal);

    // Confirmation Modal Handlers
    const confirmYes = document.getElementById('confirm-yes-btn');
    const confirmNo = document.getElementById('confirm-no-btn');
    
    if (confirmYes) {
    if (confirmYes) {
        confirmYes.addEventListener('click', async () => {
            const userId = confirmYes.getAttribute('data-action'); 
            const pendingStatus = confirmYes.getAttribute('data-pending-status');
            const noteInput = document.getElementById('confirm-note-input');
            const noteError = document.getElementById('confirm-note-error');
            const note = noteInput.value.trim();

            // Validation
            if ((pendingStatus === 'fixed' || userId === 'spam') && !note) {                 
                 if (userId !== 'spam') {
                    noteError.style.display = 'block';
                    return;
                 }
            }
            // Actually, existing code required note for fixed.
            if (pendingStatus === 'fixed' && !note) {
                noteError.style.display = 'block';
                return;
            }
             
            noteError.style.display = 'none';

            // Show spinner
            const originalText = confirmYes.innerHTML;
            confirmYes.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
            confirmYes.disabled = true;
            document.getElementById('confirm-no-btn').disabled = true;

            if (userId === 'spam') {
                await executeSpamFlag(note);
            } else if (pendingStatus) {
                await executeStatusUpdate(pendingStatus, note);
            }

            // Reset
            confirmYes.innerHTML = originalText;
            confirmYes.disabled = false;
            document.getElementById('confirm-no-btn').disabled = false;
            document.getElementById('status-confirm-overlay').classList.add('hidden');
        });
    }
    }

    if (confirmNo) {
        confirmNo.addEventListener('click', () => {
            document.getElementById('status-confirm-overlay').classList.add('hidden');
            
            // Clean up potentially leftover Spam Modal state
            const yesBtn = document.getElementById('confirm-yes-btn');
            if (yesBtn) {
                 yesBtn.style.background = "var(--admin-primary)";
                 yesBtn.innerText = "Yes, Update";
                 yesBtn.removeAttribute('data-action');
                 document.getElementById('confirm-title').innerText = "Confirm Action";
                 document.getElementById('confirm-title').style.color = "var(--admin-text)";
                 document.getElementById('confirm-message').textContent = "Are you sure you want to proceed?"; // Default placeholder
            }
        });
    }
    
    // Initialize Date Restrictions
    setupDateRestrictions();

    // Check for ID in URL to auto-open modal
    // Check for ID in URL to auto-open modal
    const urlParams = getURLParams();
    if (urlParams.id) {
        setTimeout(() => openIssueDetails(parseInt(urlParams.id)), 1000);
    }
});

async function loadCategories() {
    try {
        const res = await fetch(`${API_BASE_URL}/categories`);
        const categories = await res.json();
        const select = document.getElementById('issue-filter-category');
        // The list page owns this element; the single-report page does not.
        if (!select) return;

        // Reset to default
        select.innerHTML = '<option value="">All Categories</option>';
        
        categories.forEach(cat => {
            const opt = document.createElement('option');
            opt.value = cat.name;
            opt.textContent = cat.name;
            select.appendChild(opt);
        });
    } catch (err) {
        console.error('Error loading categories:', err);
    }
}

function setupDateRestrictions() {
    const startDate = document.getElementById('issue-filter-start');
    const endDate = document.getElementById('issue-filter-end');

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
                syncFiltersToURL();
                loadIssues();
            }
        });

        const endPicker = flatpickr(endDate, {
            dateFormat: "Y-m-d",
            altInput: true,
            altFormat: "d/m/Y",
            maxDate: today,
            onChange: function(selectedDates, dateStr, instance) {
                startPicker.set('maxDate', dateStr ? dateStr : today);
                syncFiltersToURL();
                loadIssues();
            }
        });
        
        // Handle initial values if set from URL
        if(startDate.value) startPicker.setDate(startDate.value, false);
        if(endDate.value) endPicker.setDate(endDate.value, false);
    }
}

function syncFiltersToURL() {
    const searchEl = document.getElementById('issue-search');
    const catEl = document.getElementById('issue-filter-category');
    const statusEl = document.getElementById('issue-filter-status');
    const urgencyEl = document.getElementById('issue-filter-urgency');
    const startEl = document.getElementById('issue-filter-start');
    const endEl = document.getElementById('issue-filter-end');
    const sortEl = document.getElementById('issue-sort');

    if (!searchEl) return; // Not on issues page or not loaded

    const params = {
        search: searchEl.value,
        category: catEl.value,
        status: statusEl.value,
        urgency: urgencyEl.value,
        start_date: startEl.value,
        end_date: endEl.value,
        sort: sortEl.value,
        page: issuePage
    };
    updateURLParams(params);
}

/**
 * Choosing what leaves the platform.
 *
 * An export is the point at which data stops being governed by the system that
 * holds it -- it becomes a file on a laptop. Name and phone are offered
 * separately because they are not the same disclosure: a list of names is a
 * weaker thing to hold than a list of numbers that reach people.
 *
 * The checkboxes are a convenience, not the control. The server decides what a
 * given account may export and refuses anything else, so a modified page gains
 * nothing.
 */
function openExportModal() {
    const fullAdmin = isFullAdmin();
    const nameBox = document.getElementById('export-include-name');
    const phoneBox = document.getElementById('export-include-phone');

    nameBox.checked = false;
    phoneBox.checked = false;
    nameBox.disabled = !fullAdmin;
    phoneBox.disabled = !fullAdmin;

    // Say what the file will contain before it is asked for, so the count is
    // not a surprise and a stray filter is noticed here rather than afterwards.
    const scopeText = document.getElementById('export-scope-text');
    const filters = describeActiveFilters();
    scopeText.innerHTML = isFullAdmin()
        ? `Exports <strong>all reports</strong>${filters}.`
        : `Exports <strong>reports in your institution's categories</strong>${filters}.`;

    document.getElementById('export-restricted-note').style.display = fullAdmin ? 'none' : 'block';
    ['export-name-row', 'export-phone-row'].forEach((id) => {
        const row = document.getElementById(id);
        row.style.opacity = fullAdmin ? '1' : '0.5';
        row.style.cursor = fullAdmin ? 'pointer' : 'not-allowed';
    });

    updateExportWarning();
    nameBox.onchange = updateExportWarning;
    phoneBox.onchange = updateExportWarning;

    document.getElementById('export-modal').classList.add('active');
}

/** The filters currently narrowing the list, in words rather than query terms. */
function describeActiveFilters() {
    const parts = [];
    const category = document.getElementById('issue-filter-category').value;
    const state = document.getElementById('issue-filter-state').value;
    const status = document.getElementById('issue-filter-status').value;
    const urgency = document.getElementById('issue-filter-urgency').value;
    const search = document.getElementById('issue-search').value.trim();

    if (category) parts.push(`category "${category}"`);
    if (state === 'open') parts.push('open only');
    else if (state === 'closed') parts.push('closed only');
    else if (state === 'disputed') parts.push('disputed resolutions only');
    if (status) parts.push(`status "${status}"`);
    if (urgency) parts.push(`urgency "${urgency}"`);
    if (search) parts.push(`matching "${search}"`);

    return parts.length ? `, filtered to ${parts.join(', ')}` : '';
}

function updateExportWarning() {
    const name = document.getElementById('export-include-name').checked;
    const phone = document.getElementById('export-include-phone').checked;
    const warning = document.getElementById('export-personal-warning');
    const text = document.getElementById('export-personal-warning-text');

    if (!name && !phone) {
        warning.style.display = 'none';
        return;
    }

    const what = name && phone ? 'names and phone numbers'
        : name ? 'names'
        : 'phone numbers';
    text.textContent = `This export will contain citizens' ${what}.`;
    warning.style.display = 'block';
}

function closeExportModal() {
    document.getElementById('export-modal').classList.remove('active');
}

async function runExport() {
    const name = document.getElementById('export-include-name').checked;
    const phone = document.getElementById('export-include-phone').checked;
    const btn = document.getElementById('export-confirm-btn');
    const original = btn.innerHTML;

    const params = new URLSearchParams();
    if (name) params.append('include_name', 'true');
    if (phone) params.append('include_phone', 'true');

    // The modal has just told the admin the file will be "filtered to category
    // X, status Y". It has to actually be: the filters were being described but
    // not sent, so an MDA narrowing to one category still downloaded every
    // report it could see, and had no way to notice from the file itself.
    const carry = {
        search: 'issue-search',
        category: 'issue-filter-category',
        status: 'issue-filter-status',
        urgency: 'issue-filter-urgency',
        state: 'issue-filter-state'
    };
    Object.entries(carry).forEach(([param, id]) => {
        const value = document.getElementById(id)?.value.trim();
        if (value && value !== 'All') params.append(param, value);
    });

    const query = params.toString();

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Preparing…';

    try {
        // Fetched rather than linked, so the session token travels with it and a
        // refusal arrives as a message instead of a downloaded error page.
        const res = await fetch(`${API_BASE_URL}/admin/export/issues.csv${query ? '?' + query : ''}`);
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            showAlert(body.message || `Export failed (${res.status}).`);
            return;
        }

        const blob = await res.blob();
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `fixam-reports-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(link.href);
        closeExportModal();
    } catch (err) {
        showAlert('Connection error while exporting.');
    } finally {
        btn.disabled = false;
        btn.innerHTML = original;
    }
}

async function loadIssues() {
    // The list page owns these filters; the single-report page has none of
    // them, so guard rather than crash on a missing element.
    const searchEl = document.getElementById('issue-search');
    if (!searchEl) return;

    const search = searchEl.value;
    const category = document.getElementById('issue-filter-category').value;
    const status = document.getElementById('issue-filter-status').value;
    const urgency = document.getElementById('issue-filter-urgency').value;
    const state = document.getElementById('issue-filter-state').value;
    const start = document.getElementById('issue-filter-start').value;
    const end = document.getElementById('issue-filter-end').value;
    const sort = document.getElementById('issue-sort').value;
    
    const params = new URLSearchParams();
    params.append('page', issuePage);
    params.append('limit', issueLimit);
    if (search) params.append('search', search);
    if (category && category !== 'All') params.append('category', category);
    if (status) params.append('status', status);
    if (urgency) params.append('urgency', urgency);
    if (state) params.append('state', state);
    if (start) params.append('start_date', start);
    if (end) params.append('end_date', end);
    if (sort) params.append('sort', sort);
    
    // Admins should see spam
    params.append('include_spam', 'true');

    try {
        const res = await fetch(`${API_BASE_URL}/issues?${params.toString()}`);
        const responseData = await res.json();
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
        let startPage = Math.max(1, current - 2);
        let endPage = Math.min(totalPages, startPage + 4);
        if (endPage - startPage < 4) startPage = Math.max(1, endPage - 4);

        for (let i = startPage; i <= endPage; i++) {
            const btn = document.createElement('button');
            btn.textContent = i;
            btn.style.cssText = 'width: 32px; height: 32px; border-radius: 6px; border: 1px solid var(--admin-border); cursor: pointer;';
            if (i === current) {
                btn.style.background = 'var(--admin-primary)'; btn.style.color = 'white'; btn.style.borderColor = 'var(--admin-primary)';
            } else {
                btn.style.background = 'var(--admin-card-bg)'; btn.style.color = 'var(--admin-text)';
            }
            btn.onclick = () => { issuePage = i; syncFiltersToURL(); loadIssues(); };
            numbersContainer.appendChild(btn);
        }
    }
}

/**
 * Location as an admin needs to read it.
 *
 * A report whose address could not be geocoded has no coordinates, so it never
 * appears on the map -- it has to be visibly flagged here or it is invisible
 * work. `detailed` adds the administrative area and is used in the modal.
 */
function formatIssueLocation(issue, { detailed = false } = {}) {
    const hasPoint = issue.lat !== null && issue.lat !== undefined
        && issue.lng !== null && issue.lng !== undefined;

    let text = issue.address
        || (hasPoint ? `${parseFloat(issue.lat).toFixed(4)}, ${parseFloat(issue.lng).toFixed(4)}` : 'No location given');

    if (detailed) {
        const area = [issue.ward, issue.city, issue.district].filter(Boolean).join(', ');
        if (area) text += `<br><span style="color: var(--admin-text-muted); font-size: 0.85rem;">${area}</span>`;
    }

    if (issue.location_source === 'unresolved' || !hasPoint) {
        text += ` <span title="Address could not be placed on the map — needs an admin to pinpoint it" style="background: var(--admin-warning); color: #1a202c; border-radius: 4px; padding: 1px 6px; font-size: 0.75rem; font-weight: 600; white-space: nowrap;">NOT ON MAP</span>`;
    } else if (detailed && issue.location_source === 'gps') {
        text += ` <span title="Citizen shared a GPS pin" style="color: var(--admin-success); font-size: 0.75rem; font-weight: 600;">GPS</span>`;
    }

    return text;
}

/**
 * Provenance badges for an evidence photo.
 *
 * Neither of these is a verdict — the platform does not judge whether an image
 * is adequate evidence. They are facts an admin needs before deciding to mark a
 * report as spam.
 */
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

function formatEvidenceFlags(issue, { detailed = false } = {}) {
    const flags = [];
    const badge = (bg, fg, text, title) =>
        `<span title="${title}" style="background: ${bg}; color: ${fg}; border-radius: 4px; padding: 1px 6px; font-size: 0.75rem; font-weight: 600; white-space: nowrap;">${text}</span>`;

    if (issue.image_reused_from) {
        flags.push(badge('var(--admin-warning)', '#1a202c', 'REUSED PHOTO',
            'This exact photo was already submitted on an earlier report'));
    }

    if (issue.image_forwarded === true) {
        flags.push(badge('var(--admin-primary)', '#fff', 'FORWARDED',
            'Sent as a forwarded WhatsApp message — the reporter did not take this photo in the moment'));
    }

    if (!flags.length) return '';

    // In the modal the admin is deciding, not scanning, so spell out what the
    // badge means and which report the photo came from.
    if (detailed) {
        const notes = [];
        if (issue.image_reused_from) {
            notes.push(`This photo was already used on issue #${issue.image_reused_from}.`);
        }
        if (issue.image_forwarded === true) {
            notes.push('The photo was forwarded rather than taken by the reporter.');
        }
        return flags.join(' ')
            + `<div style="margin-top: 0.4rem; font-size: 0.85rem; color: var(--admin-text-muted);">${notes.join(' ')}</div>`;
    }

    return flags.join(' ');
}


/**
 * Lets an admin place a report that the geocoder could not.
 *
 * Only offered when there are no coordinates: those reports exist, hold a real
 * description and photo, and are invisible on the map until somebody positions
 * them. Local staff usually know exactly where "behind the big cotton tree at
 * Mile 91 junction" is.
 */
function renderLocationFixer(issue) {
    const host = document.getElementById('modal-evidence-flags');
    if (!host) return;

    const hasPoint = issue.lat !== null && issue.lat !== undefined
        && issue.lng !== null && issue.lng !== undefined;
    if (hasPoint) return;

    const box = document.createElement('div');
    box.style.cssText = 'margin-top: 0.75rem; padding: 0.75rem; border: 1px solid var(--admin-border); border-radius: 6px;';
    box.innerHTML = `
        <div style="font-size: 0.85rem; color: var(--admin-text-muted); margin-bottom: 0.5rem;">
            This report has no map position, so it does not appear on the map. The citizen described it as:
            <em>${issue.address ? escapeHtml(issue.address) : 'no address given'}</em>
        </div>
        <button id="open-location-picker" style="background: var(--admin-primary); color: #fff; border: none; padding: 7px 14px; border-radius: 4px; cursor: pointer;">
            <i class="fa-solid fa-map-location-dot"></i> Set location on map
        </button>`;
    host.appendChild(box);

    document.getElementById('open-location-picker')
        .addEventListener('click', () => openLocationPicker(issue));
}

// ── Manual location placement ────────────────────────────────────────────────

let lpMap = null;
let lpMarker = null;
let lpIssue = null;
let lpArea = null;

/** Bounds of the served country, from /api/config so there is one source. */
async function getServiceArea() {
    if (lpArea) return lpArea;
    const res = await fetch(`${API_BASE_URL}/config`);
    const cfg = await res.json();
    lpArea = cfg.instance && cfg.instance.service_area;
    return lpArea;
}

function lpWithinArea(lat, lng) {
    if (!lpArea) return true;
    return lat >= lpArea.minLat && lat <= lpArea.maxLat
        && lng >= lpArea.minLng && lng <= lpArea.maxLng;
}

function lpSetPoint(lat, lng, { moveMap = false } = {}) {
    document.getElementById('lp-lat').value = lat.toFixed(6);
    document.getElementById('lp-lng').value = lng.toFixed(6);

    if (!lpMarker) {
        lpMarker = L.marker([lat, lng], { draggable: true }).addTo(lpMap);
        lpMarker.on('dragend', () => {
            const pos = lpMarker.getLatLng();
            lpSetPoint(pos.lat, pos.lng);
        });
    } else {
        lpMarker.setLatLng([lat, lng]);
    }

    if (moveMap) lpMap.setView([lat, lng], Math.max(lpMap.getZoom(), 14));

    const msg = document.getElementById('lp-msg');
    if (!lpWithinArea(lat, lng)) {
        msg.style.color = 'var(--admin-danger)';
        msg.textContent = `That point is outside ${lpArea ? lpArea.name : 'the served area'}. The bot refuses these, so it cannot be saved.`;
    } else {
        msg.style.color = 'var(--admin-text-muted)';
        msg.textContent = 'Click the map or drag the pin to adjust.';
    }
}

async function openLocationPicker(issue) {
    lpIssue = issue;
    document.getElementById('location-picker-overlay').classList.remove('hidden');

    document.getElementById('lp-context').innerHTML =
        `<strong>${escapeHtml(issue.ticket_id)}</strong> — ${String(issue.title || '').replace(/</g, '&lt;')}<br>`
        + `Reported as: <em>${issue.address ? escapeHtml(issue.address) : 'no address given'}</em>`;

    const area = await getServiceArea();

    if (!lpMap) {
        lpMap = L.map('lp-map');
        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19,
        }).addTo(lpMap);

        lpMap.on('click', (e) => lpSetPoint(e.latlng.lat, e.latlng.lng));

        // Typing coordinates moves the pin, so both stay in step.
        ['lp-lat', 'lp-lng'].forEach((id) => {
            document.getElementById(id).addEventListener('change', () => {
                const lat = parseFloat(document.getElementById('lp-lat').value);
                const lng = parseFloat(document.getElementById('lp-lng').value);
                if (Number.isFinite(lat) && Number.isFinite(lng)) {
                    lpSetPoint(lat, lng, { moveMap: true });
                }
            });
        });
    }

    if (area) {
        const bounds = L.latLngBounds([area.minLat, area.minLng], [area.maxLat, area.maxLng]);
        // Keep the admin inside the country the bot serves: panning away from it
        // only invites placing a report somewhere that would be rejected.
        lpMap.setMaxBounds(bounds.pad(0.15));
        lpMap.fitBounds(bounds);
    } else {
        lpMap.setView([0, 0], 2);
    }

    if (lpMarker) { lpMap.removeLayer(lpMarker); lpMarker = null; }
    document.getElementById('lp-lat').value = '';
    document.getElementById('lp-lng').value = '';
    const msg = document.getElementById('lp-msg');
    msg.textContent = 'Click the map to place the report, or type coordinates below.';
    msg.style.color = 'var(--admin-text-muted)';

    // Leaflet measures its container on creation, and that container is
    // zero-sized until the overlay is shown -- without this the tiles are blank.
    setTimeout(() => lpMap.invalidateSize(), 60);
}

function closeLocationPicker() {
    document.getElementById('location-picker-overlay').classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
    const cancel = document.getElementById('lp-cancel');
    if (cancel) cancel.addEventListener('click', closeLocationPicker);

    const save = document.getElementById('lp-save');
    if (save) save.addEventListener('click', saveLocationPicker);
});

async function saveLocationPicker() {
    const msg = document.getElementById('lp-msg');
    const lat = parseFloat(document.getElementById('lp-lat').value);
    const lng = parseFloat(document.getElementById('lp-lng').value);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        msg.style.color = 'var(--admin-danger)';
        msg.textContent = 'Click the map or enter both coordinates first.';
        return;
    }

    if (!lpWithinArea(lat, lng)) {
        msg.style.color = 'var(--admin-danger)';
        msg.textContent = `That point is outside ${lpArea ? lpArea.name : 'the served area'}.`;
        return;
    }

    msg.style.color = 'var(--admin-text-muted)';
    msg.textContent = 'Saving...';

    try {
        const admin = JSON.parse(localStorage.getItem('fixam_admin_user') || '{}');
        const res = await fetch(`${API_BASE_URL}/admin/issues/${lpIssue.id}/location`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat, lng, admin_id: admin.id || null })
        });
        const data = await res.json();

        if (data.success) {
            msg.style.color = 'var(--admin-success)';
            msg.textContent = 'Location saved.';
            setTimeout(() => { closeLocationPicker(); closeIssueModal(); loadIssues(); }, 700);
        } else {
            msg.style.color = 'var(--admin-danger)';
            msg.textContent = data.message || 'Could not save the location.';
        }
    } catch (err) {
        msg.style.color = 'var(--admin-danger)';
        msg.textContent = 'Network error: ' + err.message;
    }
}

/**
 * Whether a report is still someone's work, and whether anyone has disputed
 * its resolution.
 *
 * Status alone does not say either. A disputed resolution in particular had no
 * presence in the portal at all -- it fired a WhatsApp alert and wrote to the
 * audit log, both of which can be missed by the person who needs to act.
 */
function formatLifecycleFlags(issue) {
    let html = '';

    if (issue.closed_at) {
        const label = issue.closure_reason === 'resolved' ? 'Closed · resolved'
            : issue.closure_reason === 'duplicate' ? 'Closed · duplicate'
            : issue.closure_reason === 'spam' ? 'Closed · spam'
            : 'Closed · not resolved';
        const colour = issue.closure_reason === 'resolved' ? 'var(--admin-success)' : 'var(--admin-text-muted)';
        html += `<div style="font-size: 0.72rem; color: ${colour}; margin-top: 3px;"><i class="fa-solid fa-folder-closed"></i> ${label}</div>`;
    } else {
        html += '<div style="font-size: 0.72rem; color: var(--admin-text-muted); margin-top: 3px;"><i class="fa-solid fa-folder-open"></i> Open</div>';
    }

    if (issue.dispute_count > 0) {
        html += `<div style="font-size: 0.72rem; color: var(--admin-danger); margin-top: 3px; font-weight: 600;"><i class="fa-solid fa-triangle-exclamation"></i> Citizen says not fixed${issue.dispute_count > 1 ? ` (${issue.dispute_count})` : ''}</div>`;
    }

    return html;
}

/**
 * Urgency is how bad the problem is. Status is how far the work has got. The
 * portal used to show only status, and status started life as the word
 * "critical" -- so a report the AI had judged *low* urgency was displayed to
 * staff as critical, while the citizen who sent it had been told low. Same
 * report, two contradictory answers, and no way to tell which was meant.
 *
 * Showing urgency in its own column is what makes the two readable as separate
 * facts. The wording matches what the citizen sees over WhatsApp.
 */
function formatUrgency(urgency) {
    const badges = {
        critical: { label: 'Critical', color: 'var(--admin-danger)' },
        high: { label: 'High', color: 'var(--admin-warning)' },
        medium: { label: 'Medium', color: 'var(--admin-text-muted)' },
        low: { label: 'Low', color: 'var(--admin-text-muted)' }
    };
    const badge = badges[urgency];
    if (!badge) return '<span style="color: var(--admin-text-muted);">—</span>';
    return `<span style="color: ${badge.color}; font-weight: 600;">${badge.label}</span>`;
}

function renderIssuesTable(issues) {
    const tbody = document.getElementById('issues-table-body');
    tbody.innerHTML = '';
    if (!issues || issues.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="padding: 2rem; text-align: center; color: var(--admin-text-muted);">No issues found</td></tr>';
        return;
    }
    const statusColors = { 'reported': 'var(--admin-text-muted)', 'progress': 'var(--admin-warning)', 'fixed': 'var(--admin-success)', 'acknowledged': 'var(--admin-primary)', 'spam': 'var(--admin-danger)' };
    issues.forEach(issue => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--admin-border)';
        tr.innerHTML = `
            <td data-label="Issue ID" style="padding: 1rem; font-family: monospace;">${escapeHtml(issue.ticket_id) || 'N/A'}</td>
            <td data-label="Category" style="padding: 1rem;">${escapeHtml(issue.category)}</td>
            <td data-label="Title" style="padding: 1rem; font-weight: 500;">${escapeHtml(issue.title)} ${formatEvidenceFlags(issue)}</td>
            <td data-label="Location" style="padding: 1rem; color: var(--admin-text-muted);">${formatIssueLocation(issue)}</td>
            <td data-label="Votes" style="padding: 1rem;">${issue.upvotes || 0}</td>
            <td data-label="Urgency" style="padding: 1rem;">${formatUrgency(issue.urgency)}</td>
            <td data-label="Status" style="padding: 1rem;">
                <span style="color: ${statusColors[issue.status] || 'white'}; font-weight: 600; text-transform: capitalize;">${issue.status}</span>
                ${formatLifecycleFlags(issue)}
            </td>
            <td data-label="Date" style="padding: 1rem; color: var(--admin-text-muted); font-size: 0.9rem;">${new Date(issue.created_at).toLocaleDateString('en-GB')}</td>
            <td data-label="Action" style="padding: 1rem;"><button onclick="manageIssue(${issue.id})" style="background: var(--admin-primary); color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; width: 100%;">Manage</button></td>
        `;
        tbody.appendChild(tr);
    });
}

/**
 * Show where the report stands in its lifecycle, and offer the one action that
 * makes sense from there. Closing and reopening are mutually exclusive, so
 * showing both would only invite the one that will be refused.
 */
function renderClosurePanel(issue) {
    const line = document.getElementById('closure-state-line');
    const closeControls = document.getElementById('close-controls');
    const reopenControls = document.getElementById('reopen-controls');
    const statusButtons = document.getElementById('status-buttons-container');
    if (!line) return;

    const disputeLine = issue.dispute_count > 0
        ? `<div style="color: var(--admin-danger); font-weight: 600; margin-top: 4px;">
             <i class="fa-solid fa-triangle-exclamation"></i>
             A citizen says this is not actually fixed${issue.dispute_count > 1 ? ` (${issue.dispute_count} reports)` : ''}.
           </div>`
        : '';

    if (issue.closed_at) {
        const reasons = {
            resolved: 'Resolved',
            no_longer_present: 'No longer present when attended',
            not_actionable: 'Not enough to act on',
            not_feasible: 'Cannot be addressed at present',
            duplicate: 'Merged into another report',
            spam: 'Flagged as spam'
        };
        line.innerHTML = `<strong>Closed</strong> on ${new Date(issue.closed_at).toLocaleDateString('en-GB')}
            — ${reasons[issue.closure_reason] || issue.closure_reason || 'no reason recorded'}
            ${issue.closure_note ? `<div style="margin-top: 4px; font-style: italic;">"${escapeHtml(issue.closure_note)}"</div>` : ''}
            ${disputeLine}`;
        closeControls.style.display = 'none';
        reopenControls.style.display = 'block';
        // A closed report takes no status changes; the server refuses them too.
        if (statusButtons) statusButtons.style.opacity = '0.4';
        statusButtons?.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    } else {
        line.innerHTML = `<strong>Open</strong> — still this institution's work.${disputeLine}`;
        closeControls.style.display = 'block';
        reopenControls.style.display = 'none';
        document.getElementById('closure-reason').value = '';
        document.getElementById('closure-note').value = '';
        // Deliberately does not re-enable anything. This runs after the
        // duplicate and spam branches, which have already decided what an open
        // report should allow -- including keeping the current status disabled.
        if (statusButtons) statusButtons.style.opacity = '1';
    }
}

async function closeIssueReport() {
    if (!currentIssueId) return;
    const reason = document.getElementById('closure-reason').value;
    const note = document.getElementById('closure-note').value.trim();

    if (!reason) { showAlert('Choose why this report is being closed.'); return; }
    if (!note) {
        showAlert('Please explain why nothing further will happen. This is sent to the citizen and shown publicly.');
        return;
    }
    if (!await showConfirm('Close this report without resolving it? The citizen will be told, with your explanation.')) return;

    try {
        const res = await fetch(`${API_BASE_URL}/admin/issues/${currentIssueId}/close`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason, note })
        });
        const data = await res.json();
        if (res.ok && data.success) {
            openIssueDetails(currentIssueId);
            loadIssues();
        } else {
            showAlert(data.message || 'Could not close the report.');
        }
    } catch (err) {
        showAlert('Connection error while closing the report.');
    }
}

async function reopenIssueReport() {
    if (!currentIssueId) return;
    const note = document.getElementById('reopen-note').value.trim();
    if (!note) { showAlert('Please say why this report is being reopened.'); return; }

    try {
        const res = await fetch(`${API_BASE_URL}/admin/issues/${currentIssueId}/reopen`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note })
        });
        const data = await res.json();
        if (res.ok && data.success) {
            document.getElementById('reopen-note').value = '';
            openIssueDetails(currentIssueId);
            loadIssues();
        } else {
            showAlert(data.message || 'Could not reopen the report.');
        }
    } catch (err) {
        showAlert('Connection error while reopening the report.');
    }
}

/**
 * Who reported this, and how to reach them.
 *
 * An officer who cannot call the reporter back cannot ask which junction, or
 * whether the problem has recurred -- so the responsible institution gets the
 * contact details for its own reports. The server decides whether to send them;
 * if it did not, this says so rather than rendering an empty field that looks
 * like missing data.
 */
function renderReporter(issue) {
    const el = document.getElementById('modal-reporter');
    if (!el) return;

    if (!issue.reported_by_name) {
        el.innerHTML = '<span style="font-style: italic;">Anonymous — the reporter deleted their account</span>';
        return;
    }

    const phone = issue.reported_by_phone
        ? `<a href="https://wa.me/${escapeHtml(issue.reported_by_phone)}" target="_blank" rel="noopener"
              style="color: var(--admin-primary); text-decoration: none; display: inline-flex; align-items: center; gap: 6px;">
             <i class="fa-brands fa-whatsapp"></i> ${escapeHtml(issue.reported_by_phone)}
           </a>`
        : '<span style="font-style: italic; font-size: 0.85rem;">Contact details are not available to your role</span>';

    el.innerHTML = `
        <div style="font-weight: 600; color: var(--admin-text); margin-bottom: 4px;">
            <i class="fa-solid fa-user" style="margin-right: 6px;"></i>${escapeHtml(issue.reported_by_name)}
        </div>
        <div>${phone}</div>`;
}

/**
 * Show the evidence attached to a report.
 *
 * What the file *is* comes from the type recorded when it was stored, not from
 * its name. The extension used to be the only signal, and a video that arrived
 * without a declared type was written as `.bin` -- so it was rendered as an
 * image, failed, and the browser offered it as a download instead of playing
 * it. The extension is still consulted as a fallback, for files stored before
 * the type was being recorded.
 */
/**
 * Full-screen view of a report's evidence.
 *
 * Photographs of infrastructure are the thing being judged -- whether a drain is
 * really blocked, whether a repair holds -- and a 200px thumbnail in a column is
 * not enough to judge from. Built on demand rather than kept in the markup so
 * there is no hidden overlay sitting over every page waiting to be triggered.
 */
function openMediaViewer(url, isVideoMedia) {
    const existing = document.getElementById('media-viewer');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'media-viewer';
    overlay.style.cssText = `position: fixed; inset: 0; background: rgba(0,0,0,0.94);
        display: flex; align-items: center; justify-content: center; z-index: 20000; padding: 2rem;`;

    const media = document.createElement(isVideoMedia ? 'video' : 'img');
    media.src = url;
    media.style.cssText = 'max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 4px;';
    if (isVideoMedia) {
        media.controls = true;
        media.autoplay = true;
        media.playsInline = true;
    } else {
        media.alt = 'Report evidence';
    }
    // Clicking the picture itself should not dismiss the thing you opened.
    media.addEventListener('click', (e) => e.stopPropagation());

    const close = document.createElement('button');
    close.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    close.setAttribute('aria-label', 'Close');
    close.style.cssText = `position: absolute; top: 1.25rem; right: 1.5rem; background: rgba(255,255,255,0.12);
        border: none; color: #fff; width: 42px; height: 42px; border-radius: 50%; font-size: 1.2rem;
        cursor: pointer; display: flex; align-items: center; justify-content: center;`;

    const hint = document.createElement('div');
    hint.textContent = 'Click anywhere or press Esc to close';
    hint.style.cssText = `position: absolute; bottom: 1.25rem; left: 50%; transform: translateX(-50%);
        color: rgba(255,255,255,0.55); font-size: 0.8rem;`;

    const dismiss = () => {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
    };
    const onKey = (e) => { if (e.key === 'Escape') dismiss(); };

    overlay.addEventListener('click', dismiss);
    close.addEventListener('click', dismiss);
    document.addEventListener('keydown', onKey);

    overlay.append(media, close, hint);
    document.body.appendChild(overlay);
}

function renderIssueMedia(issue) {
    const imgEl = document.getElementById('modal-image');
    const videoEl = document.getElementById('modal-video');
    const emptyEl = document.getElementById('modal-media-empty');
    const expandBtn = document.getElementById('media-expand');
    if (!imgEl || !videoEl) return;

    // Reset first: this runs again after every status change, and a stale
    // control left over from the previous render would be worse than none.
    if (expandBtn) expandBtn.style.display = 'none';

    const url = issue.image_url;
    const mime = (issue.image_mime_type || '').toLowerCase();

    const looksLikeVideo = mime.startsWith('video/')
        || (!mime && /\.(mp4|mov|webm|mkv|avi|m4v|3gp)$/i.test(url || ''));

    // Nothing attached. Say so plainly rather than showing a broken frame or
    // pulling a placeholder image from an outside service.
    if (!url) {
        imgEl.style.display = 'none';
        videoEl.style.display = 'none';
        if (emptyEl) {
            emptyEl.textContent = 'No photo or video was attached to this report.';
            emptyEl.style.display = 'block';
        }
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    if (looksLikeVideo) {
        imgEl.style.display = 'none';
        imgEl.removeAttribute('src');

        // `metadata` fetches enough for the first frame and the duration without
        // pulling a whole video down for a report nobody opens.
        videoEl.preload = 'metadata';
        videoEl.controls = true;
        videoEl.playsInline = true;
        if (videoEl.getAttribute('src') !== url) videoEl.setAttribute('src', url);
        videoEl.style.display = 'block';

        const expand = document.getElementById('media-expand');
        if (expand) {
            expand.style.display = 'inline-flex';
            expand.onclick = () => openMediaViewer(url, true);
        }

        videoEl.onerror = () => {
            videoEl.style.display = 'none';
            if (emptyEl) {
                emptyEl.innerHTML = 'This video cannot be played in the browser. '
                    + `<a href="${url}" target="_blank" rel="noopener" style="color: var(--admin-primary);">Open the file directly</a>.`;
                emptyEl.style.display = 'block';
            }
        };
        return;
    }

    videoEl.pause();
    videoEl.style.display = 'none';
    videoEl.removeAttribute('src');

    imgEl.src = url;
    imgEl.style.display = 'block';
    imgEl.style.cursor = 'zoom-in';
    imgEl.title = 'Click to view full screen';
    imgEl.onclick = () => openMediaViewer(url, false);
    imgEl.onerror = () => {
        imgEl.style.display = 'none';
        if (emptyEl) {
            emptyEl.textContent = 'The attached file could not be displayed.';
            emptyEl.style.display = 'block';
        }
    };
}

/**
 * Name the report in the page heading.
 *
 * The subheading is seeded with "Loading…" in the markup, which is accurate for
 * the moment before the fetch returns and wrong for every moment after it.
 */
function setDetailPageHeading(issue) {
    const heading = document.getElementById('page-heading');
    const sub = document.getElementById('page-subheading');
    if (heading) heading.textContent = `Report ${escapeHtml(issue.ticket_id)}`;
    if (sub) {
        const reported = new Date(issue.created_at).toLocaleDateString('en-GB', {
            day: 'numeric', month: 'long', year: 'numeric'
        });
        sub.textContent = `${escapeHtml(issue.category)} · reported ${reported}`;
    }
    document.title = `FIXAM - ${escapeHtml(issue.ticket_id)}`;
}

async function openIssueDetails(id) {
    currentIssueId = id;
    const modal = document.getElementById('issue-modal');
    if (modal) {
        modal.classList.remove('hidden');
        updateURLParams({ id: id });
    }

    try {
        const allRes = await fetch(`${API_BASE_URL}/issues?limit=10000`);
        const responseData = await allRes.json();
        const allIssues = Array.isArray(responseData) ? responseData : responseData.data;
        const issue = allIssues.find(i => i.id === id);

        // Not in the caller's scope, or not there at all. On the report page
        // this must say so: leaving the page's placeholder markup on screen
        // shows a report that does not exist, with a ticket number that is
        // simply the default in the HTML.
        if (!issue && isDetailPage()) {
            showIssueUnavailable();
            return;
        }

        if (issue) {
            currentIssueData = issue;
            document.getElementById('modal-ticket').textContent = issue.ticket_id;
            document.getElementById('modal-status').textContent = issue.status;
            document.getElementById('modal-category-badge').textContent = issue.category; // Ensure badge text is updated too
            document.getElementById('modal-title').textContent = issue.title;
            document.getElementById('modal-desc').textContent = issue.description;
            document.getElementById('modal-location').innerHTML = formatIssueLocation(issue, { detailed: true });
            renderReporter(issue);
            setDetailPageHeading(issue);
            // Provenance belongs where the admin actually decides, not only
            // in the list view they scrolled past to get here.
            const flagsEl = document.getElementById('modal-evidence-flags');
            if (flagsEl) flagsEl.innerHTML = formatEvidenceFlags(issue, { detailed: true });
            renderLocationFixer(issue);
            
            // Audio Player
            const descContainer = document.getElementById('modal-desc');
            descContainer.innerHTML = ''; // Clear previous
            if (issue.audio_url) {
                const audioContainer = document.createElement('div');
                audioContainer.style.marginBottom = '1rem';
                audioContainer.innerHTML = `
                    <div style="font-size: 0.8rem; color: var(--admin-text-muted); margin-bottom: 0.5rem;">Voice Report:</div>
                    <audio controls src="${issue.audio_url}" style="width: 100%;"></audio>
                `;
                descContainer.appendChild(audioContainer);
            }

            // Transcribed text, with its confidence badge attached to the words
            // themselves rather than to the player: the reader is judging the
            // text, so the warning belongs where their eye already is.
            const textDiv = document.createElement('div');
            textDiv.textContent = issue.description;
            const badge = transcriptionConfidenceBadge(issue);
            if (badge) {
                const label = document.createElement('div');
                label.style.cssText = 'font-size: 0.8rem; color: var(--admin-text-muted); margin-bottom: 0.35rem;';
                label.innerHTML = `Transcribed text:${badge}`;
                descContainer.appendChild(label);
            }
            descContainer.appendChild(textDiv);
            
            // Reverse geocode to get address (if not already present)
            if (!issue.address) {
                fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${issue.lat}&lon=${issue.lng}`)
                    .then(res => res.json())
                    .then(data => {
                        if (data && data.display_name) {
                            document.getElementById('modal-location').textContent = data.display_name;
                        }
                    })
                    .catch(err => console.error('Geocoding error:', err));
            }
            renderIssueMedia(issue);

            const statusEl = document.getElementById('modal-status');
            const statusColors = { 'reported': 'var(--admin-text-muted)', 'progress': 'var(--admin-warning)', 'fixed': 'var(--admin-success)', 'duplicate': 'var(--admin-warning)', 'spam': 'var(--admin-danger)' };
            statusEl.style.background = statusColors[issue.status] || 'rgba(255,255,255,0.1)';
            statusEl.style.color = 'white';

            // Shown beside the status, never merged into it. Staff acting on
            // this report need to see the same urgency the citizen was told.
            const urgencyEl = document.getElementById('modal-urgency');
            if (urgencyEl) {
                urgencyEl.innerHTML = issue.urgency
                    ? `Urgency: ${formatUrgency(issue.urgency)}`
                    : 'Urgency: not set';
            }
            
            if (issue.duplicate_of) {
                // Find parent ticket ID
                const parent = allIssues.find(i => i.id === issue.duplicate_of);
                if (parent) {
                    document.getElementById('modal-desc').innerHTML += `<br><br><div id="duplicate-badge" style="background: rgba(245, 158, 11, 0.1); border: 1px solid var(--admin-warning); padding: 1rem; border-radius: 6px; color: var(--admin-warning); font-weight: 500;">⚠️ This issue is marked as a DUPLICATE of <a href="#" onclick="openIssueDetails(${parent.id}); return false;" style="color: var(--admin-primary); text-decoration: underline;">${parent.ticket_id}</a></div>`;
                }
                
                // Hide link controls, show unlink controls
                document.getElementById('link-duplicate-controls').classList.add('hidden');
                document.getElementById('unlink-duplicate-controls').classList.remove('hidden');
                
                // Disable all status buttons for duplicates
                document.querySelectorAll('.status-btn').forEach(btn => {
                    btn.disabled = true;
                    btn.style.opacity = '0.5';
                    btn.style.cursor = 'not-allowed';
                    btn.title = 'Status is synced from the original issue';
                });
            } else {
                 // Show link controls, hide unlink controls
                document.getElementById('link-duplicate-controls').classList.remove('hidden');
                document.getElementById('unlink-duplicate-controls').classList.add('hidden');
                
                // Reset all button styles first
                document.querySelectorAll('.status-btn').forEach(btn => {
                    btn.disabled = false;
                    btn.style.opacity = '1';
                    btn.style.cursor = 'pointer';
                    btn.style.background = 'var(--admin-card-bg)';
                    btn.style.color = 'var(--admin-text)';
                    btn.title = '';
                });

                // Disable the current status button
                const currentStatusBtn = document.getElementById(`btn-status-${issue.status}`);
                if (currentStatusBtn) {
                    currentStatusBtn.disabled = true;
                    currentStatusBtn.style.opacity = '0.5';
                    currentStatusBtn.style.cursor = 'default';
                    currentStatusBtn.style.background = 'var(--admin-primary)';
                    currentStatusBtn.style.color = 'white';
                    currentStatusBtn.title = 'Already in this status';
                }
            }
            
            // NEW SPAM LOGIC
            const btnEdit = document.getElementById('btn-edit-details');
            const statusContainer = document.getElementById('status-buttons-container');
            const duplicateSection = document.getElementById('duplicate-management-section');
            const btnSpam = document.getElementById('btn-flag-spam');
            const spamBannerId = 'spam-warning-banner';

             // Remove existing banner if any
            const existingBanner = document.getElementById(spamBannerId);
            if(existingBanner) existingBanner.remove();

            if (issue.status === 'spam') {
                 // Hide controls
                if(btnEdit) btnEdit.parentElement.style.display = 'none'; // Hide the container div
                if(statusContainer) statusContainer.parentElement.style.display = 'none'; // Hide the label and container
                if(duplicateSection) duplicateSection.style.display = 'none';
                if(btnSpam) btnSpam.parentElement.style.display = 'none';

                // Create and insert banner
                 const banner = document.createElement('div');
                banner.id = spamBannerId;
                banner.style.background = 'rgba(239, 68, 68, 0.1)';
                banner.style.border = '1px solid var(--admin-danger)';
                banner.style.color = 'var(--admin-danger)';
                banner.style.padding = '1rem';
                banner.style.borderRadius = '6px';
                banner.style.marginBottom = '2rem';
                banner.style.fontWeight = '500';
                banner.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> This issue has been flagged as SPAM. Management actions are restricted.';
                
                 // Insert before the Edit Details button container (which is now hidden, but we can insert into the parent column)
                 if (btnEdit && btnEdit.parentElement && btnEdit.parentElement.parentNode) {
                     btnEdit.parentElement.parentNode.insertBefore(banner, btnEdit.parentElement);
                 }

            } else {
                // Show controls (Reset visibility)
                 if(btnEdit) btnEdit.parentElement.style.display = 'block';
                 if(statusContainer) statusContainer.parentElement.style.display = 'block';
                 if(duplicateSection) duplicateSection.style.display = 'block';
                 if(btnSpam) btnSpam.parentElement.style.display = 'block';
            }

            // Last, deliberately: the duplicate and spam branches above both
            // reset the status buttons, so anything the lifecycle state needs
            // to disable has to be applied after them.
            renderClosurePanel(issue);
        }
        loadQuestionnaires(id);

        const trackerRes = await fetch(`${API_BASE_URL}/issues/${id}/tracker`);
        const trackerLogs = await trackerRes.json();
        
        // Add "Reported" event to timeline start
        if (issue) {
            trackerLogs.unshift({
                created_at: issue.created_at,
                action: 'reported',
                description: 'Issue reported via WhatsApp channel',
                performed_by_name: issue.reported_by_name || 'User' 
            });
        }
        
        renderTimeline(trackerLogs);
    } catch (err) { console.error('Error opening details:', err); }
}

function renderTimeline(logs) {
    const container = document.getElementById('modal-timeline');
    container.innerHTML = '';
    logs.forEach(log => {
        const item = document.createElement('div');
        item.style.cssText = 'margin-bottom: 1.5rem; position: relative;';
        item.innerHTML = `
            <div style="position: absolute; left: -1.35rem; top: 0; width: 12px; height: 12px; background: var(--admin-primary); border-radius: 50%; border: 2px solid var(--admin-card-bg);"></div>
            <div style="font-size: 0.85rem; color: var(--admin-text-muted); margin-bottom: 0.25rem;">${new Date(log.created_at).toLocaleString('en-GB')}</div>
            <div style="font-weight: 600; margin-bottom: 0.25rem; text-transform: capitalize;">${escapeHtml(log.action.replace('_', ' '))}</div>
            <div style="font-size: 0.9rem; color: var(--admin-text-muted);">${escapeHtml(log.description)}</div>
            ${log.performed_by_name ? `<div style="font-size: 0.8rem; color: var(--admin-primary); margin-top: 0.25rem;">By: ${escapeHtml(log.performed_by_name)}</div>` : ''}
        `;
        container.appendChild(item);
    });
}

function closeIssueModal() {
    // On the report page, closing means going back to the list.
    if (isDetailPage()) {
        window.location.href = backToIssueList();
        return;
    }
    document.getElementById('issue-modal').classList.add('hidden');
    currentIssueId = null;
    // Clear URL param if present
    const url = new URL(window.location);
    url.searchParams.delete('id');
    window.history.replaceState({}, '', url);
}

function updateStatus(newStatus) {
    if (!currentIssueId) return;
    
    // Show Custom Confirmation Overlay instead of native alert/confirm
    const overlay = document.getElementById('status-confirm-overlay');
    const messageEl = document.getElementById('confirm-message');
    const yesBtn = document.getElementById('confirm-yes-btn');
    const noteLabel = document.getElementById('confirm-note-label');
    const noteInput = document.getElementById('confirm-note-input');
    const noteError = document.getElementById('confirm-note-error');

    if (overlay && messageEl && yesBtn) {
        const friendlyStatus = newStatus === 'fixed' ? 'Resolved' : (newStatus === 'progress' ? 'In Progress' : 'Acknowledged');
        messageEl.textContent = `Are you sure you want to update the status of this issue to "${friendlyStatus}"?`;
        yesBtn.setAttribute('data-pending-status', newStatus);
        
        // Reset inputs
        noteInput.value = '';
        noteError.style.display = 'none';

        if (newStatus === 'fixed') {
            noteLabel.innerHTML = 'Resolution Note <span style="color: var(--admin-danger);">*</span> (Visible to Public)';
            noteInput.placeholder = 'Please explain how this issue was resolved...';
        } else {
            noteLabel.textContent = 'Internal Note (Optional)';
            noteInput.placeholder = 'Add a note for the log...';
        }

        overlay.classList.remove('hidden');
        setTimeout(() => noteInput.focus(), 100);
    }
}

async function executeStatusUpdate(newStatus, note) {
    const adminUser = JSON.parse(localStorage.getItem('fixam_admin_user'));
    if (!adminUser) return;
    
    try {
        const res = await fetch(`${API_BASE_URL}/admin/issues/${currentIssueId}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                status: newStatus, 
                admin_id: adminUser.id, 
                note: note || `Status updated to ${newStatus} by Admin` 
            })
        });
        const data = await res.json();
        if (data.success) {
            openIssueDetails(currentIssueId);
            loadIssues();
        } else { 
            showAlert(data.message || 'Failed to update status'); 
        }
    } catch (err) { 
        console.error('Error updating status:', err); 
    }
}

async function markAsDuplicate() {
    if (!currentIssueId) return;
    const parentTicketId = document.getElementById('duplicate-ticket-input').value.trim().toUpperCase();
    if (!parentTicketId) return showAlert('Please enter a parent Ticket ID');

    const adminUser = JSON.parse(localStorage.getItem('fixam_admin_user'));
    
    try {
        // First find the parent issue ID by Ticket ID
        const searchRes = await fetch(`${API_BASE_URL}/issues?ticket=${parentTicketId}`);
        const searchData = await searchRes.json();
        const parentIssues = Array.isArray(searchData) ? searchData : searchData.data;
        
        if (!parentIssues || parentIssues.length === 0) {
            return showAlert('Parent Issue not found. Please check the Ticket ID.');
        }
        
        const parentIssue = parentIssues[0];
        
        if (parentIssue.id === currentIssueId) {
            return showAlert('An issue cannot be a duplicate of itself.');
        }

        const res = await fetch(`${API_BASE_URL}/admin/issues/${currentIssueId}/mark-duplicate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                original_issue_id: parentIssue.id, 
                admin_id: adminUser?.id,
                note: `Marked as duplicate of ${parentTicketId} by Admin`
            })
        });
        
        const data = await res.json();
        if (data.success) {
            document.getElementById('duplicate-ticket-input').value = '';
            openIssueDetails(currentIssueId);
            loadIssues();
        } else {
            showAlert(data.message || 'Failed to mark as duplicate');
        }
    } catch (err) {
        console.error('Error marking as duplicate:', err);
    }
}

async function unlinkDuplicate() {
    if (!currentIssueId || !await showConfirm('Are you sure you want to unlink this issue? It will become a unique issue again.')) return;
    
    const adminUser = JSON.parse(localStorage.getItem('fixam_admin_user'));
    
    try {
        const res = await fetch(`${API_BASE_URL}/admin/issues/${currentIssueId}/unlink-duplicate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                admin_id: adminUser?.id,
                note: `Unlinked from parent issue by Admin`
            })
        });
        
        const data = await res.json();
        if (data.success) {
            openIssueDetails(currentIssueId);
            loadIssues();
        } else {
            showAlert(data.message || 'Failed to unlink duplicate');
        }
    } catch (err) {
        console.error('Error unlinking duplicate:', err);
    }
}

// Global variable update
let currentIssueData = null;

async function toggleEditMode(show) {
    const viewContainer = document.getElementById('view-mode-container');
    const editContainer = document.getElementById('edit-mode-container');
    
    if (show) {
        if (!currentIssueData) return;
        
        // Populate inputs
        document.getElementById('edit-title').value = currentIssueData.title;
        document.getElementById('edit-description').value = currentIssueData.description;
        document.getElementById('edit-urgency').value = currentIssueData.urgency || 'medium';
        
        // Fetch categories dynamically
        try {
            const res = await fetch(`${API_BASE_URL}/categories`);
            const categories = await res.json();
            const categorySelect = document.getElementById('edit-category');
            categorySelect.innerHTML = '';
            
            categories.forEach(cat => {
                const opt = document.createElement('option');
                opt.value = cat.name; // Assuming category object has 'name'
                opt.textContent = cat.name;
                categorySelect.appendChild(opt);
            });
            
             // Set current value
            categorySelect.value = currentIssueData.category;
            
        } catch (err) {
            console.error('Error fetching categories:', err);
             // Fallback existing options if fetch fails (though innerHTML cleared above, so actually we should rely on fetch)
             // If fetch fails, we might leave it empty or show error.
             // Simplest: just alert or ensure backend works.
        }

        viewContainer.classList.add('hidden');
        editContainer.classList.remove('hidden');
    } else {
        viewContainer.classList.remove('hidden');
        editContainer.classList.add('hidden');
    }
}

async function saveIssueDetails() {
    if (!currentIssueId) return;
    
    const title = document.getElementById('edit-title').value.trim();
    const description = document.getElementById('edit-description').value.trim();
    const category = document.getElementById('edit-category').value;
    const urgency = document.getElementById('edit-urgency').value;
    
    if (!title || !description || !category) {
        showAlert('All fields are required.');
        return;
    }

    const adminUser = JSON.parse(localStorage.getItem('fixam_admin_user'));
    
    try {
        const res = await fetch(`${API_BASE_URL}/admin/issues/${currentIssueId}/details`, {
             method: 'PUT',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ 
                 title, 
                 description, 
                 category, 
                 urgency,
                 admin_id: adminUser?.id 
             })
        });
        
        const data = await res.json();
        
        if (data.success) {
            toggleEditMode(false);
            openIssueDetails(currentIssueId); // Reload details
        } else {
            showAlert(data.message || 'Failed to update issue');
        }
    } catch (err) {
        console.error('Error saving issue details:', err);
        showAlert('An error occurred while saving.');
    }
}

async function flagAsSpam() {
    if (!currentIssueId) return;
    
    // Use the status confirmation overlay
    const overlay = document.getElementById('status-confirm-overlay');
    const messageEl = document.getElementById('confirm-message');
    const yesBtn = document.getElementById('confirm-yes-btn');
    const noteLabel = document.getElementById('confirm-note-label');
    const noteInput = document.getElementById('confirm-note-input');
    const noteError = document.getElementById('confirm-note-error');

    if (overlay && messageEl && yesBtn) {
        document.getElementById('confirm-title').innerText = "⚠️ Flag as SPAM";
        document.getElementById('confirm-title').style.color = "var(--admin-danger)";
        
        messageEl.innerHTML = `Are you sure you want to flag this issue as <strong>SPAM</strong>?<br><br>
        <div style="text-align: left; font-size: 0.85rem; background: rgba(239, 68, 68, 0.1); padding: 0.75rem; border-radius: 6px; color: var(--admin-danger);">
            <strong>This action will:</strong>
            <ul style="margin: 0; padding-left: 1.25rem; margin-top: 0.25rem;">
                <li>Hide the issue from public view.</li>
                <li>Remove it from trending lists.</li>
                <li>Send a warning to the reporter.</li>
                <li>Deduct 5 points from the reporter.</li>
            </ul>
        </div>`;
        
        yesBtn.setAttribute('data-action', 'spam');
        yesBtn.removeAttribute('data-pending-status'); // Ensure no collision
        yesBtn.innerText = "Yes, Flag as SPAM";
        yesBtn.style.background = "var(--admin-danger)";

        noteLabel.textContent = "Reason (Internal Note - Optional)";
        noteInput.value = "";
        noteInput.placeholder = "e.g. Violates community guidelines, Abusive content...";
        noteError.style.display = 'none';

        overlay.classList.remove('hidden');
    }
}

async function executeSpamFlag(reason) {
     const adminUser = JSON.parse(localStorage.getItem('fixam_admin_user'));
     
     try {
        const res = await fetch(`${API_BASE_URL}/admin/issues/${currentIssueId}/spam`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                reason: reason, 
                admin_id: adminUser?.id 
            })
        });

        const data = await res.json();

        if (data.success) {
            // Restore button style for next use
             const yesBtn = document.getElementById('confirm-yes-btn');
             if (yesBtn) {
                 yesBtn.style.background = "var(--admin-primary)";
                 yesBtn.innerText = "Yes, Update";
                 yesBtn.removeAttribute('data-action');
                 document.getElementById('confirm-title').innerText = "Confirm Action";
                 document.getElementById('confirm-title').style.color = "var(--admin-text)";
             }
             
            closeIssueModal();
            loadIssues();
        } else {
            showAlert(data.message || 'Failed to flag as spam');
        }
    } catch (err) {
        console.error('Error flagging spam:', err);
        showAlert('An error occurred.');
    }
}

// ── Single-report page ───────────────────────────────────────────────────────
//
// Managing a report means reading a timeline, writing a resolution note and
// sometimes placing a pin on a map. That is more than a dialogue floating over
// a list should carry, so it has a page and an address of its own: it can be
// linked to, opened in a second tab, and left with the browser's back button.

/** Where the list was when it handed over, so the back link returns there. */
function backToIssueList() {
    return sessionStorage.getItem('fixam_issue_list_url') || '/admin/issues';
}

function manageIssue(id) {
    // The list keeps its filters in the URL, so remembering the address is
    // enough to bring the user back to the view they left rather than to an
    // unfiltered first page.
    sessionStorage.setItem('fixam_issue_list_url', window.location.href);
    window.location.href = `/admin/issue?id=${id}`;
}

function showIssueUnavailable(message) {
    const card = document.getElementById('issue-detail-card');
    const missing = document.getElementById('issue-not-found');
    if (card) card.classList.add('hidden');
    if (missing) missing.classList.remove('hidden');
    if (message) {
        const detail = document.getElementById('not-found-detail');
        if (detail) detail.textContent = message;
    }
    const sub = document.getElementById('page-subheading');
    if (sub) sub.textContent = '';
}

function initIssueDetailPage() {
    checkAuth(async () => {
        const back = document.getElementById('back-to-issues');
        if (back) {
            back.href = backToIssueList();
            back.addEventListener('click', (e) => {
                e.preventDefault();
                window.location.href = backToIssueList();
            });
        }

        // The close button belonged to the modal chrome.
        const closeBtn = document.getElementById('close-modal');
        if (closeBtn) closeBtn.style.display = 'none';

        wireStatusConfirmation();

        const id = parseInt(new URLSearchParams(window.location.search).get('id'), 10);
        if (!Number.isFinite(id)) {
            showIssueUnavailable('No report was specified.');
            return;
        }

        await openIssueDetails(id);
    });
}

/**
 * The confirmation panel was wired up by the list page's initialiser, which
 * does not run here.
 */
function wireStatusConfirmation() {
    const yes = document.getElementById('confirm-yes-btn');
    const no = document.getElementById('confirm-no-btn');
    const overlay = document.getElementById('status-confirm-overlay');
    if (!yes || !no || !overlay) return;

    yes.addEventListener('click', () => {
        const status = yes.getAttribute('data-pending-status');
        const noteInput = document.getElementById('confirm-note-input');
        const noteError = document.getElementById('confirm-note-error');
        const note = noteInput.value.trim();

        // Resolving publishes an explanation to the citizen, so it cannot be an
        // unexplained assertion that the work is done.
        if (status === 'fixed' && !note) {
            noteError.style.display = 'block';
            return;
        }
        overlay.classList.add('hidden');
        executeStatusUpdate(status, note);
    });

    no.addEventListener('click', () => overlay.classList.add('hidden'));
}

// ── Follow-up questionnaires ─────────────────────────────────────────────────
//
// An institution's own questions, asked of the reporter after acknowledgement.
// Most reports have none and the section stays hidden; showing an empty panel
// on every report would train people to ignore the place the answers appear.

const QUESTIONNAIRE_STATES = {
    invited:     { label: 'Waiting for the citizen to reply', colour: 'var(--admin-warning)' },
    in_progress: { label: 'Answering now',                    colour: 'var(--admin-primary)' },
    completed:   { label: 'Answered',                         colour: 'var(--admin-success)' },
    abandoned:   { label: 'Citizen declined or stopped',      colour: 'var(--admin-text-muted)' },
    superseded:  { label: 'Replaced after recategorisation',  colour: 'var(--admin-text-muted)' }
};

async function loadQuestionnaires(issueId) {
    const section = document.getElementById('questionnaire-section');
    const list = document.getElementById('questionnaire-list');
    if (!section || !list) return;

    try {
        const res = await fetch(`${API_BASE_URL}/admin/issues/${issueId}/questionnaires`);
        if (!res.ok) { section.style.display = 'none'; return; }

        const runs = await res.json();
        if (!Array.isArray(runs) || runs.length === 0) {
            section.style.display = 'none';
            return;
        }

        list.innerHTML = runs.map((run) => {
            const state = QUESTIONNAIRE_STATES[run.state]
                || { label: run.state, colour: 'var(--admin-text-muted)' };

            const rows = run.answers.map((a) => {
                // Three distinct outcomes, and they mean different things to
                // whoever is reading: answered, deliberately skipped, and never
                // reached because the citizen stopped before it.
                let value;
                if (!a.answered) {
                    value = '<span style="color: var(--admin-text-muted); font-style: italic;">not reached</span>';
                } else if (a.skipped) {
                    value = '<span style="color: var(--admin-text-muted); font-style: italic;">skipped</span>';
                } else {
                    value = `<strong>${escapeHtml(a.value)}</strong>`;
                }
                return `<div style="display: flex; justify-content: space-between; gap: 1rem; padding: 0.45rem 0; border-bottom: 1px solid var(--admin-border);">
                            <span style="color: var(--admin-text-muted); font-size: 0.85rem;">${escapeHtml(a.question)}</span>
                            <span style="text-align: right; font-size: 0.9rem;">${value}</span>
                        </div>`;
            }).join('');

            const movedNote = run.category_at_send && currentIssueData
                && run.category_at_send !== currentIssueData.category
                ? `<div style="font-size: 0.78rem; color: var(--admin-warning); margin-top: 0.5rem;">
                     <i class="fa-solid fa-circle-info"></i>
                     Asked while this report was categorised as ${escapeHtml(run.category_at_send)}.
                   </div>`
                : '';

            return `
                <div style="border: 1px solid var(--admin-border); border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; flex-wrap: wrap; gap: 0.5rem;">
                        <strong>${escapeHtml(run.flow_name)}</strong>
                        <span style="color: ${state.colour}; font-size: 0.8rem; font-weight: 600;">${state.label}</span>
                    </div>
                    <div style="font-size: 0.78rem; color: var(--admin-text-muted); margin-bottom: 0.75rem;">
                        ${run.group_name || 'Platform'} · v${run.version_number} · ${run.progress} answered
                    </div>
                    ${rows}
                    ${movedNote}
                </div>`;
        }).join('');

        section.style.display = 'block';
    } catch (err) {
        console.error('Error loading follow-up questionnaires:', err);
        section.style.display = 'none';
    }
}
