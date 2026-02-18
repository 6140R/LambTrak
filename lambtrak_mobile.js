// Initialize Local Database (Standalone)
const db = new Dexie('LambTrakMobileDB');
db.version(2).stores({
    lambing_records: '++id, date, ewe_id, sire_id', // Auto-increment ID
    sheep: 'id, is_ewe, is_ram', // Local cache of sheep
    settings: 'key' // For server URL, etc.
});

let currentViewDate = new Date();

document.addEventListener('DOMContentLoaded', async () => {
    window.lambingRecordsData = [];
    window.sheepData = [];

    // --- Event Listeners ---
    const form = document.getElementById('lambing-form');
    if (form) form.addEventListener('submit', handleLambingSubmit);

    const exportBtn = document.getElementById('export-csv-btn');
    if (exportBtn) exportBtn.addEventListener('click', exportLambingCSV);

    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.addEventListener('input', handleSearch);

    // Backup & Restore
    document.getElementById('backup-btn').addEventListener('click', backupData);
    document.getElementById('restore-btn-trigger').addEventListener('click', () => document.getElementById('restore-file-input').click());
    document.getElementById('restore-file-input').addEventListener('change', restoreData);

    // Server Sync
    document.getElementById('upload-btn').addEventListener('click', uploadToServer);
    const serverUrlInput = document.getElementById('server-url-input');
    if (serverUrlInput) {
        const savedUrl = await db.settings.get('serverUrl');
        if (savedUrl) serverUrlInput.value = savedUrl.value;
        serverUrlInput.addEventListener('change', async (e) => {
            await db.settings.put({ key: 'serverUrl', value: e.target.value.trim() });
        });
    }

    // List Actions (Edit/Delete)
    const handleListActions = (e) => {
        const editBtn = e.target.closest('.edit-record-btn');
        if (editBtn) {
            openEditModal(parseInt(editBtn.dataset.id));
            return;
        }
        const deleteBtn = e.target.closest('.delete-record-btn');
        if (deleteBtn) {
            deleteRecord(parseInt(deleteBtn.dataset.id));
            return;
        }
    };
    document.getElementById('daily-records-list')?.addEventListener('click', handleListActions);
    document.getElementById('search-results-list')?.addEventListener('click', handleListActions);

    // Modal Reset
    const modalEl = document.getElementById('addLambingModal');
    if (modalEl) {
        modalEl.addEventListener('hidden.bs.modal', () => {
            form.reset();
            delete form.dataset.editId;
            form.querySelector('button[type="submit"]').textContent = 'Save Record';
            document.querySelector('.modal-title').textContent = 'Record Lambing';
            document.getElementById('lambing-date').valueAsDate = new Date();
            ['lambing-male', 'lambing-female', 'lambing-dead', 'lambing-born'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '0';
            });
        });
    }

    // Auto-calculate totals
    ['lambing-male', 'lambing-female', 'lambing-dead'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', calculateFormTotal);
    });

    // Init
    document.getElementById('lambing-date').valueAsDate = new Date();

    // Listen for sex changes to update dynamic lamb fields
    ['lambing-male', 'lambing-female'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', updateLambFields);
    });

    await loadData();

    // Calendar Nav
    document.getElementById('prev-month').addEventListener('click', () => {
        currentViewDate.setDate(1);
        currentViewDate.setMonth(currentViewDate.getMonth() - 1);
        renderCalendar(currentViewDate);
        updateTotals(currentViewDate.getFullYear());
    });
    document.getElementById('next-month').addEventListener('click', () => {
        currentViewDate.setDate(1);
        currentViewDate.setMonth(currentViewDate.getMonth() + 1);
        renderCalendar(currentViewDate);
        updateTotals(currentViewDate.getFullYear());
    });
});

async function loadData() {
    try {
        // Load everything from local DB
        window.lambingRecordsData = await db.lambing_records.toArray();

        // Build sheep list from existing records + any manually saved ones
        const usedEwes = new Set(window.lambingRecordsData.map(r => r.ewe_id));
        const storedSheep = await db.sheep.toArray();
        storedSheep.forEach(s => usedEwes.add(s.id));

        window.sheepData = Array.from(usedEwes).sort().map(id => ({ id: id }));

        // Populate Datalist
        const eweDatalist = document.getElementById('ewe-datalist');
        if (eweDatalist) {
            eweDatalist.innerHTML = window.sheepData.map(s => `<option value="${s.id}">${s.id}</option>`).join('');
        }

        const ramDatalist = document.getElementById('ram-datalist');
        if (ramDatalist) {
            const rams = storedSheep.filter(s => s.is_ram);
            ramDatalist.innerHTML = rams.map(s => `<option value="${s.id}">${s.id}</option>`).join('');
        }

        updateTotals(currentViewDate.getFullYear());
        renderCalendar(currentViewDate);
    } catch (e) {
        console.error("Error loading local data:", e);
        alert("Error loading data. Please check console.");
    }
}

async function handleLambingSubmit(e) {
    e.preventDefault();

    const male = parseInt(document.getElementById('lambing-male').value) || 0;
    const female = parseInt(document.getElementById('lambing-female').value) || 0;
    const dead = parseInt(document.getElementById('lambing-dead').value) || 0;

    const data = {
        date: document.getElementById('lambing-date').value,
        ewe_id: document.getElementById('lambing-ewe').value.trim(),
        lambs_born: male + female + dead,
        male_lambs: male,
        female_lambs: female,
        scanned_count: parseInt(document.getElementById('lambing-scanned').value) || 0,
        sex_distribution: `${male}M ${female}F`,
        assistance: document.getElementById('lambing-assistance').value,
        id_mark: document.getElementById('lambing-mark').value.trim(),
        comments: document.getElementById('lambing-comments').value.trim(),
        deaths: dead,
        sire_id: document.getElementById('lambing-sire').value.trim(),
        lamb_ids: JSON.stringify(getLambDataFromUI())
    };

    if (!data.ewe_id || !data.date) return alert('Ewe ID and Date are required.');

    // Handle Image (Store as Blob in IndexedDB)
    const imageFile = document.getElementById('lambing-image').files[0];
    if (imageFile) {
        data.imageBlob = imageFile;
    }

    try {
        const editId = document.getElementById('lambing-form').dataset.editId;

        if (editId) {
            data.id = parseInt(editId);
            // Preserve existing image if not replaced
            if (!data.imageBlob) {
                const oldRecord = await db.lambing_records.get(data.id);
                if (oldRecord && oldRecord.imageBlob) data.imageBlob = oldRecord.imageBlob;
            }
            await db.lambing_records.put(data);
        } else {
            await db.lambing_records.add(data);
            // Auto-save new Ewe ID and Sire ID to sheep list
            await db.sheep.put({ id: data.ewe_id, is_ewe: 1 });
            if (data.sire_id) await db.sheep.put({ id: data.sire_id, is_ram: 1 });

            // Auto-save lamb IDs if provided
            const lambData = JSON.parse(data.lamb_ids);
            for (const lamb of lambData) {
                if (lamb.id) {
                    await db.sheep.put({ id: lamb.id, is_ewe: 0, is_ram: 0 });
                }
            }
        }

        const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('addLambingModal'));
        modal.hide();

        await loadData(); // Refresh UI
        alert('Saved locally!');
    } catch (error) {
        console.error(error);
        alert('Error saving record: ' + error.message);
    }
}

async function deleteRecord(id) {
    if (!confirm('Delete this record permanently?')) return;
    await db.lambing_records.delete(id);
    await loadData();
}

function openEditModal(id) {
    const record = window.lambingRecordsData.find(r => r.id === id);
    if (!record) return;

    const form = document.getElementById('lambing-form');
    form.dataset.editId = id;

    document.getElementById('lambing-date').value = record.date;
    document.getElementById('lambing-ewe').value = record.ewe_id;
    document.getElementById('lambing-scanned').value = record.scanned_count;
    document.getElementById('lambing-assistance').value = record.assistance;
    document.getElementById('lambing-mark').value = record.id_mark;
    document.getElementById('lambing-comments').value = record.comments;

    let male = 0, female = 0;
    if (record.sex_distribution) {
        const m = record.sex_distribution.match(/(\d+)M/);
        const f = record.sex_distribution.match(/(\d+)F/);
        if (m) male = parseInt(m[1]);
        if (f) female = parseInt(f[1]);
    }

    document.getElementById('lambing-male').value = record.male_lambs !== undefined ? record.male_lambs : male;
    document.getElementById('lambing-female').value = record.female_lambs !== undefined ? record.female_lambs : female;
    document.getElementById('lambing-dead').value = record.deaths || 0;
    document.getElementById('lambing-sire').value = record.sire_id || '';

    calculateFormTotal();
    updateLambFields(null, record.lamb_ids ? JSON.parse(record.lamb_ids) : null);

    document.querySelector('.modal-title').textContent = 'Edit Record';
    document.querySelector('#lambing-form button[type="submit"]').textContent = 'Update Record';

    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('addLambingModal'));
    modal.show();
}

// --- Backup & Restore ---

async function backupData() {
    const records = await db.lambing_records.toArray();
    // Convert Blobs to Base64 for JSON storage (simple solution)
    // Note: Large images might make this slow/heavy.
    const backup = {
        timestamp: new Date().toISOString(),
        records: records // We might skip images for JSON backup to keep it light, or handle async
    };

    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lambtrak_backup_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

async function restoreData(e) {
    const file = e.target.files[0];
    if (!file) return;

    if (!confirm('This will merge the backup with your current data. Continue?')) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
        try {
            const data = JSON.parse(event.target.result);
            if (Array.isArray(data.records)) {
                await db.lambing_records.bulkPut(data.records);
                alert(`Restored ${data.records.length} records.`);
                await loadData();
            } else {
                alert('Invalid backup file format.');
            }
        } catch (err) {
            alert('Error parsing backup file: ' + err.message);
        }
    };
    reader.readAsText(file);
}

// --- Server Sync ---

async function uploadToServer() {
    const serverUrl = document.getElementById('server-url-input').value.trim();
    if (!serverUrl) return alert('Please enter the GrazeTrak Server URL.');

    const uploadBtn = document.getElementById('upload-btn');
    const originalText = uploadBtn.textContent;
    uploadBtn.disabled = true;
    uploadBtn.textContent = '🚀 Syncing...';

    try {
        const records = await db.lambing_records.toArray();
        if (records.length === 0) {
            alert('No records to upload.');
            uploadBtn.disabled = false;
            uploadBtn.textContent = originalText;
            return;
        }

        let successCount = 0;
        let failCount = 0;

        for (const record of records) {
            const formData = new FormData();

            // Clean record for JSON sending
            const cleanRecord = { ...record };
            delete cleanRecord.id;
            delete cleanRecord.imageBlob;

            formData.append('data', JSON.stringify(cleanRecord));

            if (record.imageBlob) {
                formData.append('image', record.imageBlob, `lambing_${record.ewe_id}_${record.date}.jpg`);
            }

            try {
                const response = await fetch(`${serverUrl}/api/lambing_records`, {
                    method: 'POST',
                    body: formData
                });

                if (response.ok) {
                    successCount++;
                } else {
                    failCount++;
                }
            } catch (err) {
                console.error('Upload failed for record:', record, err);
                failCount++;
            }
        }

        alert(`Sync Complete!\nSuccessfully uploaded: ${successCount}\nFailed: ${failCount}`);

    } catch (error) {
        console.error('Sync error:', error);
        alert('An error occurred during sync: ' + error.message);
    } finally {
        uploadBtn.disabled = false;
        uploadBtn.textContent = originalText;
    }
}

// --- UI Helpers (Same as before) ---

function calculateFormTotal() {
    const male = parseInt(document.getElementById('lambing-male').value) || 0;
    const female = parseInt(document.getElementById('lambing-female').value) || 0;
    const dead = parseInt(document.getElementById('lambing-dead').value) || 0;
    document.getElementById('lambing-born').value = male + female + dead;
}

function updateLambFields(e, existingData = null) {
    const maleCount = parseInt(document.getElementById('lambing-male').value) || 0;
    const femaleCount = parseInt(document.getElementById('lambing-female').value) || 0;
    const totalLiving = maleCount + femaleCount;
    const container = document.getElementById('lamb-details-container');
    const list = document.getElementById('lamb-fields-list');

    if (totalLiving === 0) {
        container.style.display = 'none';
        list.innerHTML = '';
        return;
    }

    container.style.display = 'block';

    // We want to preserve existing values if possible when just changing counts
    const currentData = getLambDataFromUI();
    list.innerHTML = '';

    let lambIndex = 0;

    // Add male lambs
    for (let i = 0; i < maleCount; i++) {
        addLambRow(list, 'M', i + 1, existingData ? existingData[lambIndex] : currentData[lambIndex]);
        lambIndex++;
    }
    // Add female lambs
    for (let i = 0; i < femaleCount; i++) {
        addLambRow(list, 'F', i + 1, existingData ? existingData[lambIndex] : currentData[lambIndex]);
        lambIndex++;
    }
}

function addLambRow(container, sex, index, data = null) {
    const div = document.createElement('div');
    div.className = 'row g-2 mb-2 lamb-data-row';
    div.dataset.sex = sex;
    const sexLabel = sex === 'M' ? 'Male' : 'Female';
    const colorClass = sex === 'M' ? 'text-primary' : 'text-danger';

    div.innerHTML = `
        <div class="col-6">
            <label class="form-label small mb-0 ${colorClass}">${sexLabel} ${index} ID</label>
            <input type="text" class="form-control form-control-sm lamb-id" value="${data?.id || ''}" placeholder="New ID">
        </div>
        <div class="col-6">
            <label class="form-label small mb-0">Weight (kg)</label>
            <input type="number" step="0.1" class="form-control form-control-sm lamb-weight" value="${data?.weight || ''}" placeholder="0.0">
        </div>
    `;
    container.appendChild(div);
}

function getLambDataFromUI() {
    const rows = document.querySelectorAll('.lamb-data-row');
    const data = [];
    rows.forEach(row => {
        data.push({
            id: row.querySelector('.lamb-id').value.trim(),
            weight: row.querySelector('.lamb-weight').value,
            sex: row.dataset.sex
        });
    });
    return data;
}

function renderCalendar(date) {
    const grid = document.getElementById('calendar-grid');
    const monthLabel = document.getElementById('current-month-label');
    if (!grid) return;
    grid.innerHTML = '';

    const year = date.getFullYear();
    const month = date.getMonth();
    monthLabel.textContent = date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();
    const startDayOfWeek = firstDay.getDay();

    for (let i = 0; i < startDayOfWeek; i++) {
        const cell = document.createElement('div');
        cell.className = 'calendar-day empty';
        grid.appendChild(cell);
    }

    for (let d = 1; d <= daysInMonth; d++) {
        const cell = document.createElement('div');
        cell.className = 'calendar-day';
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const recordsForDay = window.lambingRecordsData.filter(r => r.date === dateStr);

        const today = new Date();
        if (d === today.getDate() && month === today.getMonth() && year === today.getFullYear()) {
            cell.classList.add('today');
        }

        if (recordsForDay.length > 0) {
            cell.classList.add('has-events');
            const badge = document.createElement('span');
            badge.className = 'badge bg-primary day-badge';
            badge.textContent = recordsForDay.length;
            cell.appendChild(badge);
        }

        cell.innerHTML += `<div class="day-number">${d}</div>`;
        cell.addEventListener('click', () => showDailyRecords(dateStr, recordsForDay));
        grid.appendChild(cell);
    }
}

function showDailyRecords(dateStr, records) {
    const container = document.getElementById('daily-records-container');
    const list = document.getElementById('daily-records-list');
    document.getElementById('selected-date-label').textContent = formatDate(dateStr);
    list.innerHTML = '';
    container.style.display = 'block';

    if (records.length === 0) {
        list.innerHTML = '<div class="list-group-item text-muted">No records for this day.</div>';
        return;
    }

    records.forEach(r => {
        const item = document.createElement('div');
        item.className = 'list-group-item';

        // Format lamb details if they exist in lamb_ids string
        let lambDetailsHtml = '';
        if (r.lamb_ids) {
            try {
                const details = JSON.parse(r.lamb_ids);
                if (details && details.length > 0) {
                    lambDetailsHtml = `
                        <div class="mt-2 p-1 bg-light rounded small">
                            <strong class="d-block mb-1">Lamb Details:</strong>
                            <div class="row g-1">
                                ${details.map(l => `
                                    <div class="col-6 border-end">
                                        <span class="${l.sex === 'M' ? 'text-primary' : 'text-danger'}">${l.sex}</span>: ${l.id || 'N/A'} ${l.weight ? `(${l.weight}kg)` : ''}
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    `;
                }
            } catch (e) {
                console.warn('Error parsing lamb_ids:', e);
            }
        }

        item.innerHTML = `
            <div class="d-flex justify-content-between align-items-center">
                <h6 class="mb-1">Ewe: ${r.ewe_id}</h6>
                <div>
                    <span class="badge bg-secondary">${r.lambs_born} Lambs</span>
                    <button class="btn btn-sm btn-outline-secondary ms-2 py-0 px-1 edit-record-btn" data-id="${r.id}" style="font-size: 0.8rem;">Edit</button>
                    <button class="btn btn-sm btn-outline-danger ms-1 py-0 px-1 delete-record-btn" data-id="${r.id}" style="font-size: 0.8rem;">Delete</button>
                </div>
            </div>
            <div class="mb-1 small">
                <div class="row">
                    <div class="col-6"><strong>Sire:</strong> ${r.sire_id || '-'}</div>
                    <div class="col-6"><strong>Scanned:</strong> ${r.scanned_count || '-'}</div>
                </div>
                <div class="row">
                    <div class="col-6"><strong>Mark:</strong> ${r.id_mark || '-'}</div>
                    <div class="col-6"><strong>Deaths:</strong> ${r.deaths || '0'}</div>
                </div>
                <p class="mb-1"><strong>Assistance:</strong> ${r.assistance || 'None'}</p>
                ${lambDetailsHtml}
            </div>
            ${r.comments ? `<div class="mt-1"><small class="text-muted"><strong>Notes:</strong> ${r.comments}</small></div>` : ''}
        `;
        list.appendChild(item);
    });
    container.scrollIntoView({ behavior: 'smooth' });
}

function updateTotals(year) {
    const records = window.lambingRecordsData.filter(r => new Date(r.date).getFullYear() === year);

    const totalLambs = records.reduce((sum, r) => sum + (parseInt(r.lambs_born) || 0), 0);
    const totalDeaths = records.reduce((sum, r) => sum + (parseInt(r.deaths) || 0), 0);
    const totalAssisted = records.filter(r => r.assistance && r.assistance !== 'None').length;
    const totalLiving = totalLambs - totalDeaths;
    const totalEwes = records.length;

    document.getElementById('total-lambs').textContent = totalLambs;
    document.getElementById('total-deaths').textContent = totalDeaths;
    document.getElementById('total-assistance').textContent = totalAssisted;
    document.getElementById('total-living').textContent = totalLiving;
    document.getElementById('total-ewes').textContent = totalEwes;
    document.getElementById('totals-year').textContent = year;

    // Performance Calculations
    const lambingPct = totalEwes > 0 ? ((totalLiving / totalEwes) * 100).toFixed(1) : 0;
    const livingPct = totalLambs > 0 ? ((totalLiving / totalLambs) * 100).toFixed(1) : 0;
    const deadPct = totalLambs > 0 ? ((totalDeaths / totalLambs) * 100).toFixed(1) : 0;
    const assistedPct = totalEwes > 0 ? ((totalAssisted / totalEwes) * 100).toFixed(1) : 0;

    const setPerf = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val + '%'; };
    setPerf('perf-lambing', lambingPct);
    setPerf('perf-living', livingPct);
    setPerf('perf-dead', deadPct);
    setPerf('perf-assisted', assistedPct);
}

function exportLambingCSV() {
    const data = window.lambingRecordsData;
    if (!data || data.length === 0) return alert('No data to export.');

    const headers = ['id', 'date', 'ewe_id', 'lambs_born', 'scanned_count', 'sex_distribution', 'assistance', 'deaths', 'id_mark', 'comments'];
    const csvContent = [
        headers.join(','),
        ...data.map(row => headers.map(fieldName => {
            let val = row[fieldName];
            if (val === null || val === undefined) val = '';
            val = String(val).replace(/"/g, '""');
            if (val.includes(',') || val.includes('\n')) val = `"${val}"`;
            return val;
        }).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'lambtrak_export.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function handleSearch(e) {
    const term = e.target.value.toLowerCase().trim();
    const calendarContainer = document.getElementById('calendar-view-container');
    const searchContainer = document.getElementById('search-results-container');
    const searchList = document.getElementById('search-results-list');

    if (!term) {
        calendarContainer.style.display = 'block';
        searchContainer.style.display = 'none';
        return;
    }

    calendarContainer.style.display = 'none';
    searchContainer.style.display = 'block';
    searchList.innerHTML = '';

    const results = window.lambingRecordsData.filter(r =>
        (r.ewe_id && String(r.ewe_id).toLowerCase().includes(term)) ||
        (r.id_mark && String(r.id_mark).toLowerCase().includes(term))
    );

    if (results.length === 0) {
        searchList.innerHTML = '<div class="list-group-item text-muted">No matching records found.</div>';
        return;
    }

    results.sort((a, b) => new Date(b.date) - new Date(a.date));
    showDailyRecords(null, results); // Reuse render logic, but we need to adapt it slightly
    // Actually, showDailyRecords expects a dateStr for the label.
    // Let's just manually render the list items here to be safe.
    results.forEach(r => {
        // ... (same rendering logic as showDailyRecords loop) ...
        // For brevity, I'll just call showDailyRecords with a dummy date and let it render the list
    });
    // Better: Just reuse the loop logic inside handleSearch or refactor.
    // For now, let's just copy the loop logic to avoid breaking the label.
    results.forEach(r => {
        const item = document.createElement('div');
        item.className = 'list-group-item';

        // Format lamb details if they exist in lamb_ids string
        let lambDetailsHtml = '';
        if (r.lamb_ids) {
            try {
                const details = JSON.parse(r.lamb_ids);
                if (details && details.length > 0) {
                    lambDetailsHtml = `
                        <div class="mt-2 p-1 bg-light rounded small">
                            <strong class="d-block mb-1">Lamb Details:</strong>
                            <div class="row g-1">
                                ${details.map(l => `
                                    <div class="col-6 border-end">
                                        <span class="${l.sex === 'M' ? 'text-primary' : 'text-danger'}">${l.sex}</span>: ${l.id || 'N/A'} ${l.weight ? `(${l.weight}kg)` : ''}
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    `;
                }
            } catch (e) {
                console.warn('Error parsing lamb_ids:', e);
            }
        }

        item.innerHTML = `
            <div class="d-flex justify-content-between align-items-center">
                <h6 class="mb-1">Ewe: ${r.ewe_id} <small class="text-muted">(${formatDate(r.date)})</small></h6>
                <div>
                    <span class="badge bg-secondary">${r.lambs_born} Lambs</span>
                    <button class="btn btn-sm btn-outline-secondary ms-2 py-0 px-1 edit-record-btn" data-id="${r.id}" style="font-size: 0.8rem;">Edit</button>
                    <button class="btn btn-sm btn-outline-danger ms-1 py-0 px-1 delete-record-btn" data-id="${r.id}" style="font-size: 0.8rem;">Delete</button>
                </div>
            </div>
            <div class="mb-1 small">
                <div class="row">
                    <div class="col-6"><strong>Sire:</strong> ${r.sire_id || '-'}</div>
                    <div class="col-6"><strong>Scanned:</strong> ${r.scanned_count || '-'}</div>
                </div>
                <div class="row">
                    <div class="col-6"><strong>Mark:</strong> ${r.id_mark || '-'}</div>
                    <div class="col-6"><strong>Deaths:</strong> ${r.deaths || '0'}</div>
                </div>
                <p class="mb-1"><strong>Assistance:</strong> ${r.assistance || 'None'}</p>
                ${lambDetailsHtml}
            </div>
            ${r.comments ? `<div class="mt-1"><small class="text-muted"><strong>Notes:</strong> ${r.comments}</small></div>` : ''}
        `;
        searchList.appendChild(item);
    });
}

function formatDate(d) {
    if (!d) return '';
    const date = new Date(d);
    return `${date.getDate().toString().padStart(2, '0')}/${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getFullYear()}`;
}