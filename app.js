// --- CONSTANTS & STATE ---
const API_BASE_URL = '/api';

// ── SERVER CONFIG ─────────────────────────────────────────────────────────
let NGROK_BASE_URL  = '';
let BACKEND_WS_HOST = '';

// These are now fetched from the DB on login — see fetchMasterData()
let alatKerjaData = [];
let lokasiData    = [];
let uptDatabase   = [];

let _currentRole = '';  // set in checkAuth, used by renderDbCards for mutasi button visibility
let _wsNgrokFailed = false;
let _wsRetryCount = 0;

let db = [];

let activeHistoryUid = null;
let currentUser = sessionStorage.getItem('activeUser');
let authToken = sessionStorage.getItem('authToken');

// Track the QR currently shown in the modal (for export)
let _qrActiveItem = null;

(function() {
    const saved = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (saved === 'dark' || (!saved && prefersDark)) {
        document.documentElement.classList.add('dark');
    }
})();

// --- INISIALISASI UTAMA ---
document.addEventListener("DOMContentLoaded", async () => {
    await fetchConfig();
    populateSelects();
    setupEventListeners();
    fetchLoginRegions();

    if (currentUser && authToken) {
        document.getElementById('auth-view').style.display = 'none';
        checkAuth();
    } else {
        forceLogout(false);
    }
});

async function fetchConfig() {
    try {
        const res  = await fetch('/api/config');
        const data = await res.json();
        NGROK_BASE_URL  = data.ngrok_url || '';
        BACKEND_WS_HOST = NGROK_BASE_URL
            ? NGROK_BASE_URL.replace(/^https?:\/\//, '').replace(/\/$/, '')
            : window.location.host;
    } catch (e) {
        NGROK_BASE_URL  = '';
        BACKEND_WS_HOST = window.location.host; // always set a valid fallback
    }
}

async function fetchMasterData() {
    try {
        const [alatRes, lokasiRes, uptRes] = await Promise.all([
            fetch(`${API_BASE_URL}/master/alat`),
            fetch(`${API_BASE_URL}/master/lokasi`),
            fetch(`${API_BASE_URL}/master/upt`),
        ]);

        if (alatRes.ok)   alatKerjaData = (await alatRes.json()).map(a => ({ name: a.nama,       code: a.kode }));
        if (lokasiRes.ok) lokasiData    = (await lokasiRes.json()).map(l => ({ name: l.nama_lokasi, code: l.kode_lokasi }));
        if (uptRes.ok)    uptDatabase   = (await uptRes.json()).map(u => ({ upt: u.nama_lokasi, lokasi: u.parent_kode }));

        // Re-populate all selects now that data is loaded
        populateSelects();
    } catch (e) {
        showToast("Gagal memuat data master. Beberapa dropdown mungkin kosong.", "warning");
    }
}

async function fetchLoginRegions() {
    try {
        const res = await fetch('/api/master/lokasi');
        if (!res.ok) return;
        const data = await res.json();
        const sel  = document.getElementById('login-region');
        if (!sel) return;
        sel.innerHTML = data.map(l => `<option value="${l.kode_lokasi}">${l.nama_lokasi}</option>`).join('');
    } catch (e) {
        // master data not seeded yet — leave as "Memuat..."
    }
}

// --- LOGIKA AUTENTIKASI ---
async function checkAuth() {
    if (currentUser && authToken) {
        const payload = getJwtPayload(authToken);
        const role = payload ? payload.role : 'TEKNISI';

        _currentRole = role;

        const filterModeEl = document.getElementById('filter-mode');
        if (filterModeEl) filterModeEl.style.display = role === 'TEKNISI' ? 'none' : '';

        document.getElementById('auth-view').classList.add('hidden');
        const mainApp = document.getElementById('main-app');
        if (mainApp) {
            mainApp.style.display = 'flex';
            mainApp.classList.remove('hidden');
        }

        // Update topbar user info
        const topbarUsername = document.getElementById('topbar-username');
        const topbarRole     = document.getElementById('topbar-role');
        if (topbarUsername) topbarUsername.innerText = currentUser;
        if (topbarRole)     topbarRole.innerText     = role.replace('_', ' ');

        if (role === 'SUPER_ADMIN') {
            const navMaster = document.getElementById('nav-masterdata');
            if (navMaster) navMaster.classList.remove('hidden');
        }
        if (role === 'TEKNISI') {
            const navInput = document.getElementById('nav-input');
            if (navInput) navInput.classList.add('hidden');
        }

        const welcomeMsg = document.getElementById('dashboard-welcome');
        if (welcomeMsg) welcomeMsg.innerText = `Selamat Datang, ${currentUser}`;

        switchView('dashboard');
        
        toggleSidebar();
        setupProfileModal();
        startTopbarClock();

        await fetchMasterData(); // fetch before setupWebSocket so selects are ready
        setupWebSocket();
        await fetchAsetFromServer();
    } else {
        const mainAppEl = document.getElementById('main-app');
        if (mainAppEl) {
            mainAppEl.style.display = 'none';
            mainAppEl.classList.add('hidden');
        }
    }
}

async function handleLogin() {
    const user   = document.getElementById('login-username').value.trim();
    const role   = document.getElementById('login-role')?.value   || 'TEKNISI';
    const region = document.getElementById('login-region')?.value || '';
    const regionText = document.getElementById('login-region')?.selectedOptions[0]?.text || region;
    const roleText   = document.getElementById('auth-display-role')?.textContent || role;

    if (!user) {
        showToast("Username tidak boleh kosong!", "warning");
        return;
    }

    // Single confirmation before proceeding
    const confirmed = await customConfirm(
        `Masuk sebagai "${user}"?\nRole: ${roleText}\nRegion: ${regionText}`
    );
    if (!confirmed) return;

    try {
        const response = await fetch(`${API_BASE_URL}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'ngrok-skip-browser-warning': 'true',
            },
            body: JSON.stringify({
                username:        user,
                role:            role,
                assigned_region: region || null
            })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || "Login gagal.");
        }

        const data = await response.json();
        currentUser = user;
        authToken   = data.access_token;
        sessionStorage.setItem('activeUser', user);
        sessionStorage.setItem('authToken',  authToken);

        showToast(
            data.already_existed
                ? `Berhasil masuk sebagai ${user}!`
                : `Berhasil membuat akun dan masuk sebagai "${user}"!`,
            'success'
        );
        document.getElementById('login-username').value = '';
        document.getElementById('auth-step-1')?.classList.remove('hidden');
        document.getElementById('auth-step-2')?.classList.add('hidden');
        document.getElementById('auth-step-3')?.classList.add('hidden');
        if (document.getElementById('login-role')) 
            document.getElementById('login-role').value = '';

        await checkAuth();
        fetchAsetFromServer();

    } catch (error) {
        showToast(error.message, 'error');
    }
}

function forceLogout(reloadPage = false) {
    currentUser = null;
    authToken = null;
    sessionStorage.removeItem('activeUser');
    sessionStorage.removeItem('authToken');

    if (reloadPage) {
        window.location.href = window.location.pathname;
        return;
    }

    const mainApp2 = document.getElementById('main-app');
    if (mainApp2) {
        mainApp2.style.display = 'none';
        mainApp2.classList.add('hidden');
    }

    const authView = document.getElementById('auth-view');
    authView.classList.remove('hidden');

    const u = document.getElementById('login-username');
    // const p = document.getElementById('login-password');
    if (u) u.value = '';
    // if (p) p.value = '';
    document.getElementById('auth-step-1')?.classList.remove('hidden');
    document.getElementById('auth-step-2')?.classList.add('hidden');
    document.getElementById('auth-step-3')?.classList.add('hidden');
    document.getElementById('login-role') && (document.getElementById('login-role').value = '');

    activeHistoryUid = null;

    // const navAdmin = document.getElementById('nav-user-management');
    // if (navAdmin) navAdmin.classList.add('hidden');

    if (window._wsHeartbeat) clearInterval(window._wsHeartbeat);
    if (window._ws && window._ws.readyState === WebSocket.OPEN) {
        window._ws.close();
    }
    window._ws = null;
}

// ── PROFILE MODAL ─────────────────────────────────────────────────────────

function getInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function updateWsDot(connected) {
    const color = connected ? 'bg-green-500' : 'bg-red-400';
    const off   = connected ? 'bg-red-400'   : 'bg-green-500';
    const label = connected ? 'Server terhubung' : 'Server terputus';
    ['ws-status-dot', 'avatar-ws-dot', 'profile-modal-ws-dot'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.remove('bg-green-500', 'bg-red-400', 'bg-gray-300');
        el.classList.add(color);
    });
    const lbl = document.getElementById('ws-status-label');
    if (lbl) lbl.textContent = label;
}

function setupProfileModal() {
    const initials = getInitials(currentUser);
    const roleLabel = (_currentRole || '').replace('_', ' ');

    ['topbar-avatar', 'profile-modal-avatar'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = initials;
    });
    const pmUser = document.getElementById('profile-modal-username');
    const pmRole = document.getElementById('profile-modal-role');
    if (pmUser) pmUser.textContent = currentUser || '—';
    if (pmRole) pmRole.textContent = roleLabel;

    // Show/hide delete button based on role
    const delBtn = document.getElementById('profile-delete-btn');
    if (delBtn) {
        if (_currentRole === 'SUPER_ADMIN') delBtn.classList.add('hidden');
        else delBtn.classList.remove('hidden');
    }
}

function openProfileModal() {
    setupProfileModal();
    document.getElementById('profile-modal')?.classList.remove('hidden');
}

function closeProfileModal() {
    document.getElementById('profile-modal')?.classList.add('hidden');
}

function startTopbarClock() {
    const bulan = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
    const hari  = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
    function tick() {
        const now = new Date();
        const clockEl = document.getElementById('topbar-clock');
        const dateEl  = document.getElementById('topbar-date');
        if (clockEl) clockEl.textContent =
            String(now.getHours()).padStart(2,'0') + ':' +
            String(now.getMinutes()).padStart(2,'0') + ':' +
            String(now.getSeconds()).padStart(2,'0');
        if (dateEl) dateEl.textContent =
            `${hari[now.getDay()]}, ${now.getDate()} ${bulan[now.getMonth()]} ${now.getFullYear()}`;
    }
    tick();
    setInterval(tick, 1000);
}

function getJwtPayload(token) {
    try {
        const base64Url = token.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
        return JSON.parse(jsonPayload);
    } catch (e) {
        return null;
    }
}

// --- FETCH API WRAPPER ---
async function apiFetch(endpoint, options = {}) {
    if (!authToken) throw new Error("Token tidak tersedia");

    const headers = {
        'Authorization': `Bearer ${authToken}`,
        ...options.headers
    };

    if (!(options.body instanceof URLSearchParams)) {
        headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(`${API_BASE_URL}${endpoint}`, { ...options, headers });

    if (response.status === 401) {
        showToast("Sesi Anda telah habis. Silakan login kembali.", "warning");
        forceLogout(false);
        throw new Error("Unauthorized");
    }

    return response;
}

// --- KOMUNIKASI DATABASE ---
async function fetchAsetFromServer() {
    try {
        const response = await apiFetch('/aset');
        if (!response.ok) throw new Error("Gagal mengambil data aset");
        db = await response.json();

        updateDashboardStats();
        if (document.getElementById('view-database').classList.contains('is-visible')) renderDbCards();
        if (document.getElementById('view-history').classList.contains('is-visible')) renderHistoryCards();
        if (document.getElementById('view-history').classList.contains('is-visible')) {
            loadHistorySummary().then(() => {
                if (_historyMode === 'mutasi') renderMutasiCards();
            });
        }

        if (activeHistoryUid && document.getElementById('view-history-detail').classList.contains('is-visible')) {
            window.openHistoryDetail(activeHistoryUid);
        }
    } catch (error) {
        showToast("Koneksi ke server gagal! Mencoba menghubungkan kembali...", 'error');
    }
}

function updateDashboardStats() {
    const statTotal = document.getElementById('stat-total');
    const statSo    = document.getElementById('stat-so');
    const statTso   = document.getElementById('stat-tso');

    if (statTotal && statSo && statTso) {
        statTotal.innerText = db.length;
        statSo.innerText    = db.filter(item => item.status === 'SO').length;
        statTso.innerText   = db.filter(item => item.status === 'TSO').length;
    }
}

async function afkirAset(uid) {
    const isConfirmed = await customConfirm("Apakah Anda yakin ingin meng-afkir aset ini? Data tidak akan muncul lagi di dashboard.");
    if (!isConfirmed) return;

    try {
        const response = await apiFetch(`/aset/afkir/${uid}`, { method: 'POST' });
        if (!response.ok) throw new Error("Gagal meng-afkir aset.");

        showToast("Aset berhasil di-afkir.", 'success');
        switchView('database');
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// --- UI UTILITIES & EVENT LISTENERS ---
function populateSelects() {
    const alatHTML  = alatKerjaData.map(d => `<option value="${d.code}">${d.name} (${d.code})</option>`).join('');
    const lokasiHTML = lokasiData.map(d => `<option value="${d.code}">${d.name} (${d.code})</option>`).join('');

    const inAlat   = document.getElementById('in-alat');
    const inLokasi = document.getElementById('in-lokasi');
    const editLokasi = document.getElementById('edit-lokasi');
    const regRegion  = document.getElementById('reg-region');

    if (inAlat)    inAlat.innerHTML    = alatHTML;
    if (inLokasi)  inLokasi.innerHTML  = lokasiHTML;
    if (editLokasi) editLokasi.innerHTML = `<option value="" disabled selected>Pilih Lokasi</option>` + lokasiHTML;
    if (regRegion)  regRegion.innerHTML = lokasiHTML;
}

function switchView(viewId) {
    document.querySelectorAll('.view-section').forEach(el => {
        el.classList.remove('is-visible', 'is-flex');
    });

    const targetView = document.getElementById(`view-${viewId}`);
    if (targetView) {
        targetView.classList.add('is-visible');
    }

    document.querySelectorAll('.nav-btn').forEach(btn => {
        if (btn.dataset.view === viewId) btn.classList.add('is-active');
        else btn.classList.remove('is-active');
    });

    const pageMeta = {
        dashboard:        { title: 'Dashboard',            subtitle: 'Pantau kesiapan dan kondisi aset alat kerja' },
        input:            { title: 'Tambah Alat Kerja',    subtitle: 'Registrasi aset alat kerja baru ke dalam sistem' },
        database:         { title: 'Data Aset',            subtitle: 'Daftar seluruh aset alat kerja yang terdaftar' },
        history:          { title: 'Riwayat Aset',         subtitle: 'Riwayat perbaikan dan mutasi aset' },
        'history-detail': { title: 'Detail Riwayat',       subtitle: 'Rincian riwayat perbaikan dan mutasi aset' },
        edit:             { title: 'Pembaruan Kondisi',    subtitle: 'Perbarui status kondisi aset alat kerja' },
        laporan:          { title: 'Laporan & Ekspor',     subtitle: 'Filter dan ekspor data aset ke Excel atau PDF' },
        masterdata:       { title: 'Pusat Data',           subtitle: 'Kelola data master sistem (Super Admin)' },
    };
    const meta = pageMeta[viewId];
    if (meta) {
        const t = document.getElementById('topbar-page-title');
        const s = document.getElementById('topbar-page-subtitle');
        if (t) t.textContent = meta.title;
        if (s) s.textContent = meta.subtitle;
    }

    const breadcrumb = document.getElementById('breadcrumb-label');
    if (breadcrumb && meta) breadcrumb.textContent = meta.title;

    if (viewId === 'masterdata') {
        setTimeout(() => {
            document.querySelector('.master-tab[data-tab="users"]')?.click();
        }, 50);
    }
    if (viewId === 'database' || viewId === 'history') {
        fetchAsetFromServer();
    }
    if (viewId === 'history') {
        loadHistorySummary().then(() => {
            if (_historyMode === 'repair') renderHistoryCards();
            else renderMutasiCards();
        });
    }
    if (viewId === 'laporan') {
        initLaporanView();
    }
}

function setupEventListeners() {
    // Navigasi Sidebar
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    // Auth — multi-step login
    document.getElementById('btn-next-step')?.addEventListener('click', () => {
        const username = document.getElementById('login-username').value.trim();
        if (!username) { showToast('Username tidak boleh kosong!', 'warning'); return; }
        document.getElementById('auth-display-username').innerText = username;
        document.getElementById('auth-step-1').classList.add('hidden');
        document.getElementById('auth-step-2').classList.remove('hidden');
    });

    document.getElementById('login-username')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') document.getElementById('btn-next-step')?.click();
    });

    document.getElementById('btn-back-step1')?.addEventListener('click', () => {
        document.getElementById('auth-step-2').classList.add('hidden');
        document.getElementById('auth-step-1').classList.remove('hidden');
    });

    document.getElementById('btn-back-step2')?.addEventListener('click', () => {
        document.getElementById('auth-step-3').classList.add('hidden');
        document.getElementById('auth-step-2').classList.remove('hidden');
    });

    document.querySelectorAll('.division-card').forEach(card => {
        card.addEventListener('click', () => {
            const division = card.dataset.division;
            const labels = { TEKNISI: 'Teknisi (TraKSI)', ADMIN_DAOP: 'Admin DAOP', SUPER_ADMIN: 'Super Admin (RAMCES)' };
            document.getElementById('login-role').value = division;
            document.getElementById('auth-display-role').innerText = labels[division] || division;

            const regionSel = document.getElementById('login-region');
            if (division === 'SUPER_ADMIN') {
                regionSel.disabled = true;
                regionSel.innerHTML = '<option value="">Semua Region (tidak diperlukan)</option>';
            } else {
                regionSel.disabled = false;
                fetchLoginRegions();
            }

            document.getElementById('auth-step-2').classList.add('hidden');
            document.getElementById('auth-step-3').classList.remove('hidden');
        });
    });

    document.getElementById('btn-login')?.addEventListener('click', handleLogin);
    document.getElementById('login-region')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleLogin();
    });

    // Sidebar & Theme
    document.getElementById('mobile-menu-btn')?.addEventListener('click', toggleSidebar);
    document.getElementById('sidebar-toggle-btn')?.addEventListener('click', toggleSidebar);
    document.getElementById('sidebar-overlay')?.addEventListener('click', toggleSidebar);
    document.getElementById('theme-toggle-btn')?.addEventListener('click', () => {
        const html = document.documentElement;
        html.classList.toggle('dark');
        localStorage.setItem('theme', html.classList.contains('dark') ? 'dark' : 'light');
    });
    document.getElementById('logout-btn')?.addEventListener('click', () => forceLogout(true));
    
    // Profile modal
    // (delete-account-btn re-added in redesign)
    document.getElementById('profile-btn')?.addEventListener('click', openProfileModal);
    document.getElementById('close-profile-modal')?.addEventListener('click', closeProfileModal);
    document.getElementById('profile-modal')?.addEventListener('click', (e) => {
        if (e.target === document.getElementById('profile-modal')) closeProfileModal();
    });
    document.getElementById('profile-logout-btn')?.addEventListener('click', () => {
        closeProfileModal();
        forceLogout(true);
    });
    document.getElementById('profile-delete-btn')?.addEventListener('click', async () => {
        closeProfileModal();
        const confirmed = await customConfirm(
            `Apakah Anda yakin ingin menghapus akun "${currentUser}"?\nTindakan ini tidak dapat dibatalkan.`
        );
        if (!confirmed) return;
        const reconfirmed = await customConfirm(
            `Konfirmasi terakhir: akun "${currentUser}" akan dihapus permanen dari sistem.`
        );
        if (!reconfirmed) return;
        try {
            const response = await apiFetch('/users/me', { method: 'DELETE' });
            if (!response.ok) throw new Error('Gagal menghapus akun.');
            showToast('Akun berhasil dihapus.', 'success');
            setTimeout(() => forceLogout(true), 1500);
        } catch (error) {
            showToast(error.message, 'error');
        }
    });

    // Search & Filter
    document.getElementById('search-db')?.addEventListener('input', renderDbCards);
    document.getElementById('search-history')?.addEventListener('input', () => {
        _historyMode === 'repair' ? renderHistoryCards() : renderMutasiCards();
    });
    document.getElementById('filter-mode')?.addEventListener('change', renderDbCards);

    // Data Aset quick-download buttons
    document.getElementById('btn-db-download-xlsx')?.addEventListener('click', () => {
        if (!db.length) { showToast('Belum ada aset yang terdaftar.', 'warning'); return; }
        const rows = db.map(item => ({
            'UID':      item.uid,
            'Kode ID':  item.kode_id,
            'Alat':     item.alat,
            'Lokasi':   item.lokasi,
            'Status':   item.status,
        }));
        const ws  = XLSX.utils.json_to_sheet(rows);
        const wb  = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Data Aset');
        XLSX.writeFile(wb, `DataAset_${new Date().toISOString().slice(0,10)}.xlsx`);
        showToast('File Excel berhasil diunduh.', 'success');
    });

    document.getElementById('btn-db-download-pdf')?.addEventListener('click', () => {
        if (!db.length) { showToast('Belum ada aset yang terdaftar.', 'warning'); return; }
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'landscape' });
        doc.setFontSize(13);
        doc.setFont('helvetica', 'bold');
        doc.text('SIMA-KAI — Data Aset', 14, 14);
        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        doc.text(`Dicetak: ${new Date().toLocaleString('id-ID')}  |  Total: ${db.length} aset`, 14, 20);
        doc.autoTable({
            head: [['UID', 'Kode ID', 'Alat', 'Lokasi', 'Status']],
            body: db.map(item => [item.uid, item.kode_id, item.alat, item.lokasi, item.status]),
            startY: 25,
            styles: { fontSize: 7, cellPadding: 2 },
            headStyles: { fillColor: [22, 76, 129], textColor: 255, fontStyle: 'bold' },
            alternateRowStyles: { fillColor: [249, 250, 251] },
            didParseCell(data) {
                if (data.section === 'body' && data.column.index === 4) {
                    const v = data.cell.raw;
                    data.cell.styles.textColor = v === 'SO' ? [21, 128, 61] : [185, 28, 28];
                    data.cell.styles.fontStyle = 'bold';
                }
            }
        });
        doc.save(`DataAset_${new Date().toISOString().slice(0,10)}.pdf`);
        showToast('File PDF berhasil diunduh.', 'success');
    });

    // Import Alat Excel
    document.getElementById('btn-import-alat')?.addEventListener('click', () => {
        document.getElementById('import-alat-file').value = '';
        document.getElementById('import-alat-filename').textContent = 'Belum ada file dipilih';
        document.getElementById('import-alat-modal').classList.remove('hidden');
    });
    document.getElementById('close-import-alat-modal')?.addEventListener('click', () => {
        document.getElementById('import-alat-modal').classList.add('hidden');
    });
    document.getElementById('import-alat-file')?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        document.getElementById('import-alat-filename').textContent = file ? file.name : 'Belum ada file dipilih';
    });
    document.getElementById('btn-import-alat-submit')?.addEventListener('click', async () => {
        const fileInput = document.getElementById('import-alat-file');
        const file = fileInput.files[0];
        if (!file) { showToast('Pilih file Excel terlebih dahulu.', 'warning'); return; }

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const wb   = XLSX.read(e.target.result, { type: 'array' });
                const ws   = wb.Sheets[wb.SheetNames[0]];
                const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

                // Find header row — look for a row containing 'kode' or 'nama'
                let dataRows = rows.filter(r => r.some(c => String(c).trim() !== ''));
                if (!dataRows.length) { showToast('File kosong atau tidak terbaca.', 'error'); return; }

                // Skip header row if first row looks like headers
                const firstRow = dataRows[0].map(c => String(c).toLowerCase().trim());
                if (firstRow.some(c => c.includes('kode') || c.includes('nama'))) {
                    dataRows = dataRows.slice(1);
                }

                // Detect column positions: skip leading numeric/index columns
                // Expected: [...optional numbering], kode, nama
                const parsed = [];
                for (const row of dataRows) {
                    const cells = row.map(c => String(c).trim()).filter((_, i) => row[i] !== '');
                    if (cells.length < 2) continue;

                    // If first cell is purely numeric, treat as index and skip it
                    let startIdx = 0;
                    if (/^\d+$/.test(cells[0])) startIdx = 1;

                    const kode = cells[startIdx];
                    const nama = cells[startIdx + 1];

                    if (!kode || !nama) { showToast(`Baris tidak valid ditemukan: "${row.join(', ')}". Format harus: Kode, Nama Alat.`, 'error'); return; }
                    if (/[^A-Za-z0-9_\-]/.test(kode)) { showToast(`Kode tidak valid: "${kode}". Hanya huruf, angka, - dan _ yang diperbolehkan.`, 'error'); return; }

                    parsed.push({ kode: kode.toUpperCase(), nama });
                }

                if (!parsed.length) { showToast('Tidak ada data valid yang ditemukan dalam file.', 'warning'); return; }

                // Send to backend
                let success = 0, failed = 0;
                for (const item of parsed) {
                    try {
                        const res = await apiFetch('/master/alat', { method: 'POST', body: JSON.stringify({ kode: item.kode, nama: item.nama }) });
                        if (res.ok) success++; else failed++;
                    } catch { failed++; }
                }

                document.getElementById('import-alat-modal').classList.add('hidden');
                showToast(`Import selesai: ${success} berhasil${failed ? `, ${failed} gagal` : ''}.`, success ? 'success' : 'error');
                await loadMasterAlat();
                await fetchMasterData();
            } catch (err) {
                showToast('Gagal membaca file. Pastikan format file adalah .xlsx yang valid.', 'error');
            }
        };
        reader.readAsArrayBuffer(file);
    });

    // Close buttons
    document.getElementById('close-edit-btn')?.addEventListener('click', () => switchView('database'));
    document.getElementById('close-hist-btn')?.addEventListener('click', () => {
        activeHistoryUid = null;
        switchView('history');
    });

    // Dynamic UPT select
    document.getElementById('edit-lokasi')?.addEventListener('change', (e) => {
        const locCode   = e.target.value;
        const uptSelect = document.getElementById('edit-upt');
        const matches   = uptDatabase.filter(u => u.lokasi === locCode);

        uptSelect.innerHTML = '<option value="">Pilih UPT...</option>';
        uptSelect.value = '';

        if (matches.length > 0) {
            uptSelect.innerHTML = '<option value="">Pilih UPT...</option>' + matches.map(m => `<option value="${m.upt}">${m.upt}</option>`).join('');
        } else {
            uptSelect.innerHTML = `<option value="Lainnya">Lainnya / Tidak ada data UPT</option>`;
        }
    });

    // SO / TSO buttons
    document.querySelectorAll('.status-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const status = e.currentTarget.dataset.status;
            document.getElementById('edit-kondisi').value = status;

            document.querySelectorAll('.status-btn').forEach(b => {
                b.className = "status-btn flex-1 py-3 rounded-lg font-bold transition-all " +
                    (b.dataset.status === status
                        ? `active ${status.toLowerCase()}`
                        : "inactive");
            });
        });
    });

    // ── FORM SUBMISSIONS ────────────────────────────────────────────────────

    document.getElementById('form-input-baru')?.addEventListener('submit', async function(e) {
        e.preventDefault();

        const alat      = document.getElementById('in-alat').value;
        const pengadaan = document.querySelector('input[name="in-pengadaan"]:checked').value;
        const tanggal   = document.getElementById('in-tanggal').value;
        const unit      = document.querySelector('input[name="in-unit"]:checked').value;
        const lokasi    = document.getElementById('in-lokasi').value;

        const yearStr = tanggal.split('-')[0].slice(-2);
        const codeID  = `${alat}-${pengadaan}-${yearStr}-${unit}-${lokasi}`;

        const payload = {
            kode_id:        codeID,
            kode_alat:      alat,
            kode_lokasi:    lokasi,
            pengadaan:      pengadaan,
            tahun_pembelian: parseInt(yearStr),
            unit_peruntukan: unit
        };

        try {
            const response = await apiFetch('/aset', { method: 'POST', body: JSON.stringify(payload) });
            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.detail || "Gagal menyimpan data ke database.");
            }
            const result = await response.json();
            showToast(`Berhasil disimpan! UID: ${result.uid}`, "success");
            this.reset();
            fetchAsetFromServer();
        } catch (error) {
            if (error.message !== "Unauthorized") showToast(error.message, "error");
        }
    });

    document.getElementById('form-edit')?.addEventListener('submit', async function(e) {
        e.preventDefault();

        const payload = {
            aset_uid:         document.getElementById('edit-uid').value,
            tanggal_perbaikan: document.getElementById('edit-tanggal').value,
            lokasi_perbaikan: document.getElementById('edit-lokasi').value || null,
            upt_perbaikan:    document.getElementById('edit-upt').value    || null,
            teknisi:          document.getElementById('edit-teknisi').value,
            status_baru:      document.getElementById('edit-kondisi').value,
            keterangan:       document.getElementById('edit-keterangan').value || '-'
        };

        if (!payload.status_baru) return showToast("Pilih Kondisi Alat Kerja (SO/TSO)!", "warning");

        try {
            const response = await apiFetch('/perbaikan', { method: 'POST', body: JSON.stringify(payload) });
            if (!response.ok) throw new Error("Gagal menyimpan riwayat perbaikan.");
            const result = await response.json();
            showToast(result.message, "success");
            switchView('database');
            fetchAsetFromServer();
        } catch (error) {
            if (error.message !== "Unauthorized") showToast(error.message, "error");
        }
    });

    // ── QR MODAL LISTENERS ───────────────────────────────────────────────────
    
    // Copy landing link to clipboard
    document.getElementById('btn-copy-link')?.addEventListener('click', async () => {
        const linkText = document.getElementById('qr-landing-link-text')?.textContent;
        if (!linkText) return;

        try {
            await navigator.clipboard.writeText(linkText);
            const btn = document.getElementById('btn-copy-link');
            btn.innerHTML = '<i class="fas fa-check"></i>';
            btn.title     = 'Tersalin!';
            setTimeout(() => {
                btn.innerHTML = '<i class="fas fa-copy"></i>';
                btn.title     = 'Salin link';
            }, 2000);
        } catch {
            // Fallback for browsers that block clipboard API without HTTPS
            showToast('Salin manual: ' + linkText, 'info');
        }
    });

    // Close modal on backdrop click or × button
    document.getElementById('close-qr-modal')?.addEventListener('click', closeQrModal);
    document.getElementById('qr-modal')?.addEventListener('click', (e) => {
        if (e.target === document.getElementById('qr-modal')) closeQrModal();
    });
    
    // Download PNG
    document.getElementById('btn-qr-download-png')?.addEventListener('click', downloadQrPng);
    
    // Download PDF (print-based)
    document.getElementById('btn-qr-download-pdf')?.addEventListener('click', downloadQrPdf);
    
    // ── HISTORY UI CONTROLS LISTENERS ────────────────────────────────────────
    
    // History mode toggle
    document.getElementById('hist-tab-repair')?.addEventListener('click', () => {
        _historyMode = 'repair';
        _setHistoryTab('repair');
        renderHistoryCards();
    });

    document.getElementById('hist-tab-mutasi')?.addEventListener('click', () => {
        _historyMode = 'mutasi';
        _setHistoryTab('mutasi');
        renderMutasiCards();
    });

    // History tab pill switcher — shared helper
    function _setHistoryTab(active) {
        const repairBtn = document.getElementById('hist-tab-repair');
        const mutasiBtn = document.getElementById('hist-tab-mutasi');
        const repairCon = document.getElementById('history-repair-container');
        const mutasiCon = document.getElementById('history-mutasi-container');

        const ACTIVE_CLS   = ['bg-white', 'dark:bg-gray-600', 'shadow-sm', 'text-gray-800', 'dark:text-white', 'font-semibold'];
        const INACTIVE_CLS = ['text-gray-500', 'dark:text-gray-400', 'font-medium', 'hover:text-gray-700', 'dark:hover:text-gray-200'];

        // Reset both
        [repairBtn, mutasiBtn].forEach(b => {
            if (!b) return;
            ACTIVE_CLS.forEach(c => b.classList.remove(c));
            INACTIVE_CLS.forEach(c => b.classList.remove(c));
        });

        // Apply active/inactive
        const activeBtn   = active === 'repair' ? repairBtn : mutasiBtn;
        const inactiveBtn = active === 'repair' ? mutasiBtn : repairBtn;
        ACTIVE_CLS.forEach(c => activeBtn?.classList.add(c));
        INACTIVE_CLS.forEach(c => inactiveBtn?.classList.add(c));

        // Show/hide containers
        repairCon?.classList.toggle('hidden', active !== 'repair');
        mutasiCon?.classList.toggle('hidden', active !== 'mutasi');
    }

    // Detail sub-tab listeners
    document.getElementById('detail-tab-repair')?.addEventListener('click', () => {
        switchDetailTab('repair', activeHistoryUid);
    });
    document.getElementById('detail-tab-mutasi')?.addEventListener('click', () => {
        switchDetailTab('mutasi', activeHistoryUid);
    });

    // Mutasi modal
    document.getElementById('close-mutasi-modal')?.addEventListener('click', () => {
        document.getElementById('mutasi-modal').classList.add('hidden');
    });
    document.getElementById('mutasi-modal')?.addEventListener('click', (e) => {
        if (e.target === document.getElementById('mutasi-modal'))
            document.getElementById('mutasi-modal').classList.add('hidden');
    });

    document.getElementById('btn-submit-mutasi')?.addEventListener('click', async () => {
        const uid        = document.getElementById('mutasi-uid').value;
        const lokasiTuju = document.getElementById('mutasi-lokasi-tuju').value;
        const alasan     = document.getElementById('mutasi-alasan').value.trim();

        if (!lokasiTuju) return showToast('Pilih lokasi tujuan terlebih dahulu.', 'warning');

        const btn  = document.getElementById('btn-submit-mutasi');
        const orig = btn.innerHTML;
        btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Memproses...`;
        btn.disabled  = true;

        try {
            const res = await apiFetch('/mutasi', {
                method: 'POST',
                body: JSON.stringify({ aset_uid: uid, kode_lokasi_tuju: lokasiTuju, alasan: alasan || null })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || 'Gagal memproses mutasi.');

            showToast(data.message, 'success');
            document.getElementById('mutasi-modal').classList.add('hidden');
            // Refresh both the db list and history summary
            await fetchAsetFromServer();
            await loadHistorySummary();
        } catch (e) {
            showToast(e.message, 'error');
        } finally {
            btn.innerHTML = orig;
            btn.disabled  = false;
        }
    });
}

// ── WEBSOCKET ──────────────────────────────────────────────────────────────

function setupWebSocket() {
    if (window._wsHeartbeat) clearInterval(window._wsHeartbeat);

    const protocol = NGROK_BASE_URL ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${BACKEND_WS_HOST}/ws/updates`;
    const ws = new WebSocket(NGROK_BASE_URL ? `${wsUrl}?ngrok-skip-browser-warning=true` : wsUrl);

    ws.onopen = () => {
        console.log("WebSocket connected.");
        _wsRetryCount = 0;
        updateWsDot(true);
        window._wsHeartbeat = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send("ping");
        }, 30000);
    };

    ws.onmessage = (event) => {
        if (event.data === "REFRESH_ASSET_LIST") fetchAsetFromServer();
    };

    ws.onclose = () => {
        console.log("WebSocket closed.");
        clearInterval(window._wsHeartbeat);
        updateWsDot(false);
        if (authToken && (!NGROK_BASE_URL || !_wsNgrokFailed)) {
            console.log("Retrying in 3s...");
            setTimeout(setupWebSocket, 3000);
        }
    };

    ws.onerror = (event) => {
        console.warn("WebSocket error:", event);
        if (NGROK_BASE_URL && !_wsNgrokFailed) {
            _wsNgrokFailed = true;
            showToast("Ngrok tunnel tidak aktif. Pastikan ngrok berjalan sebelum menggunakan fitur live-sync.", "warning");
        }
        ws.close();
    };

    window._ws = ws;
}

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && currentUser) {
        fetchAsetFromServer();
        if (!window._ws || window._ws.readyState === WebSocket.CLOSED) setupWebSocket();
    }
});

window.addEventListener('resize', () => {
    const sidebar     = document.getElementById('sidebar');
    const overlay     = document.getElementById('sidebar-overlay');
    const mainContent = document.getElementById('main-content-area');
    if (!sidebar) return;

    if (window.innerWidth >= 1024) {
        // Desktop: remove mobile overlay, keep sidebar open state as margin
        overlay.classList.remove('active');
        if (sidebar.classList.contains('open')) {
            mainContent.classList.add('sidebar-open');
        }
    } else {
        // Mobile: remove desktop margin shift, revert to overlay behavior
        mainContent.classList.remove('sidebar-open');
        if (sidebar.classList.contains('open')) {
            overlay.classList.add('active');
        }
    }
});

function toggleSidebar() {
    const sidebar     = document.getElementById('sidebar');
    const overlay     = document.getElementById('sidebar-overlay');
    const mainContent = document.getElementById('main-content-area');
    const isOpen      = sidebar.classList.contains('open');
    const isDesktop   = window.innerWidth >= 1024;
    const shouldOpen  = !isOpen;

    const chevron = document.getElementById('sidebar-chevron-icon');
    const toggleBtn = document.getElementById('sidebar-toggle-btn');

    if (toggleBtn) {
        toggleBtn.classList.toggle('is-open', shouldOpen);
    }

    if (isOpen) {
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
        if (isDesktop) mainContent.classList.remove('sidebar-open');
        if (chevron) { chevron.classList.remove('fa-chevron-right'); chevron.classList.add('fa-chevron-left'); }
    } else {
        sidebar.classList.add('open');
        if (isDesktop) {
            mainContent.classList.add('sidebar-open');
        } else {
            overlay.classList.add('active');
        }
        if (chevron) { chevron.classList.remove('fa-chevron-left'); chevron.classList.add('fa-chevron-right'); }
    }
}

// ── RENDER & DISPLAY ───────────────────────────────────────────────────────

window.openEdit = (uid) => {
    const item = db.find(x => x.uid === uid);
    if (!item) return;
    document.getElementById('edit-uid').value      = item.uid;
    document.getElementById('edit-subtitle').innerText = `${item.uid} | ${item.kode_id}`;
    document.getElementById('edit-teknisi').value  = currentUser;

    document.getElementById('form-edit').reset();
    document.getElementById('edit-kondisi').value  = '';
    document.querySelectorAll('.status-btn').forEach(btn => {
        btn.className = `status-btn flex-1 py-3 rounded-lg font-bold border-2 transition-all ${btn.dataset.status === 'SO' ? 'border-green-500 text-green-600' : 'border-red-500 text-red-600'}`;
    });
    switchView('edit');
};

window.openHistoryDetail = async (uid, tab = 'repair') => {
    activeHistoryUid = uid;
    const item = _historySummary.find(x => x.uid === uid) || db.find(x => x.uid === uid);
    if (!item) return;

    document.getElementById('hist-detail-subtitle').innerText = `${item.uid} | ${item.kode_id}`;
    switchView('history-detail');
    switchDetailTab(tab, uid);
};

function switchDetailTab(tab, uid) {
    // Update tab button styles
    document.getElementById('detail-tab-repair').className =
        `detail-tab-btn px-5 py-2 text-sm font-bold border-b-2 transition ${
            tab === 'repair'
                ? 'border-purple-500 text-purple-600 dark:text-purple-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
        }`;
    document.getElementById('detail-tab-mutasi').className =
        `detail-tab-btn px-5 py-2 text-sm font-bold border-b-2 transition ${
            tab === 'mutasi'
                ? 'border-orange-500 text-orange-600 dark:text-orange-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
        }`;

    document.getElementById('detail-panel-repair').classList.toggle('hidden', tab !== 'repair');
    document.getElementById('detail-panel-mutasi').classList.toggle('hidden', tab !== 'mutasi');

    if (tab === 'repair') loadDetailRepair(uid);
    if (tab === 'mutasi') loadDetailMutasi(uid);
}

async function loadDetailRepair(uid) {
    const tbody = document.getElementById('hist-repair-tbody');
    tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-gray-500"><i class="fas fa-spinner fa-spin mr-2"></i>Mengambil data...</td></tr>`;
    try {
        const res = await apiFetch(`/riwayat/${uid}`);
        if (!res.ok) throw new Error("Gagal mengambil riwayat.");
        const history = await res.json();
        if (!history.length) {
            tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-gray-500">Belum ada riwayat perbaikan.</td></tr>`;
            return;
        }
        tbody.innerHTML = history.map(h => `
            <tr class="border-b dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td class="p-3">${h.no}</td>
                <td class="p-3 font-mono text-xs">${formatUtcToLocal(h.date)}</td>
                <td class="p-3">${h.upt}</td>
                <td class="p-3">${h.teknisi}</td>
                <td class="p-3 font-bold ${h.kondisi === 'SO' ? 'text-green-500' : 'text-red-500'}">${h.kondisi}</td>
                <td class="p-3 whitespace-pre-wrap">${h.keterangan}</td>
            </tr>
        `).join('');
    } catch (e) {
        if (e.message !== 'Unauthorized')
            tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-red-500">${e.message}</td></tr>`;
    }
}

async function loadDetailMutasi(uid) {
    const timeline  = document.getElementById('mutasi-timeline');
    const originBar = document.getElementById('mutasi-origin-bar');
    timeline.innerHTML  = `<div class="text-center text-gray-400 py-6"><i class="fas fa-spinner fa-spin mr-2"></i>Mengambil data...</div>`;
    originBar.innerHTML = '';

    try {
        const res = await apiFetch(`/mutasi/${uid}`);
        if (!res.ok) throw new Error("Gagal mengambil riwayat mutasi.");
        const data = await res.json();

        // Origin + status bar
        const returnedBadge = data.sudah_kembali
            ? `<span class="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-3 py-1 rounded-full text-xs font-bold">✓ Sudah Kembali ke Asal</span>`
            : `<span class="bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 px-3 py-1 rounded-full text-xs font-bold">⟳ Belum Kembali ke Asal</span>`;
        originBar.innerHTML = `
            <div class="flex-1 min-w-0">
                <p class="text-xs text-gray-400">Lokasi Asal</p>
                <p class="font-bold text-gray-700 dark:text-gray-200">${data.original_lokasi}</p>
            </div>
            <div class="flex-1 min-w-0">
                <p class="text-xs text-gray-400">Lokasi Sekarang</p>
                <p class="font-bold text-gray-700 dark:text-gray-200">${data.lokasi_sekarang}</p>
            </div>
            ${returnedBadge}
        `;

        if (!data.mutasi.length) {
            timeline.innerHTML = `<div class="text-center text-gray-400 py-6">Belum ada riwayat mutasi.</div>`;
            return;
        }

        // Timeline entries
        timeline.innerHTML = data.mutasi.map((m, i) => `
            <div class="flex gap-4 items-start">
                <div class="flex flex-col items-center">
                    <div class="w-8 h-8 rounded-full bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 flex items-center justify-center text-xs font-bold shrink-0">${i + 1}</div>
                    ${i < data.mutasi.length - 1 ? '<div class="w-0.5 flex-1 bg-gray-200 dark:bg-gray-700 mt-1"></div>' : ''}
                </div>
                <div class="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4 flex-1 mb-2 space-y-1 text-sm">
                    <div class="flex justify-between items-start gap-2">
                        <span class="font-bold text-orange-600 dark:text-orange-400">${m.lokasi_asal} → ${m.lokasi_tuju}</span>
                        ${m.delta ? `<span class="text-xs text-blue-500 font-mono shrink-0">+${m.delta}</span>` : ''}
                    </div>
                    <p class="text-xs text-gray-500 font-mono">${formatUtcToLocal(m.created_at)}</p>
                    <p class="text-xs text-gray-600 dark:text-gray-400"><span class="font-semibold">Oleh:</span> ${m.dilakukan_oleh}</p>
                    <p class="text-xs text-gray-600 dark:text-gray-400 italic">${m.alasan}</p>
                </div>
            </div>
        `).join('');
    } catch (e) {
        if (e.message !== 'Unauthorized')
            timeline.innerHTML = `<div class="text-center text-red-400 py-6">${e.message}</div>`;
    }
}

function renderDbCards() {   
    const container   = document.getElementById('db-cards-container');
    const searchInput = document.getElementById('search-db');
    const modeSelect  = document.getElementById('filter-mode');
    if (!container) return;
    
    const isTeknisi = _currentRole === 'TEKNISI';
    if (modeSelect) modeSelect.style.display = isTeknisi ? 'none' : '';
    
    const searchQ = (searchInput?.value || '').toLowerCase();
    const mode    = isTeknisi ? 'public' : (modeSelect ? modeSelect.value : 'public');
    const isAdmin = _currentRole === 'SUPER_ADMIN' || _currentRole === 'ADMIN_DAOP';
    
    container.innerHTML = '';

    const filteredItems = db.filter(item => {
        const matchSearch = item.kode_id.toLowerCase().includes(searchQ) ||
                            item.uid.toLowerCase().includes(searchQ)     ||
                            item.alat.toLowerCase().includes(searchQ);
        const matchMode = mode === 'public' ? true :
            (item.creator || '').toLowerCase() === (currentUser || '').toLowerCase();
        return matchSearch && matchMode;
    });

    if (!filteredItems.length) {
        container.innerHTML = `<div class="col-span-3 text-center text-gray-400 py-12"><i class="fas fa-inbox text-3xl mb-2 block"></i>Belum ada data penambahan aset alat kerja.</div>`;
        return;
    }

    filteredItems.sort((a, b) => {
        const av = (a[_sortField] || '').toString().toLowerCase();
        const bv = (b[_sortField] || '').toString().toLowerCase();
        return _sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    }).forEach(item => {
        const statusColor = item.status === 'SO'  ? 'text-green-500' :
                            item.status === 'TSO' ? 'text-red-500'   : 'text-blue-500';

        const mutasiBtn = isAdmin ? `
            <button onclick="window.openMutasiModal('${item.uid}')"
                class="flex-1 bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 py-2 rounded font-bold hover:bg-orange-200 dark:hover:bg-orange-800 transition text-sm">
                <i class="fas fa-exchange-alt"></i> MUTASI
            </button>` : '';

        container.innerHTML += `
            <div class="bg-white dark:bg-gray-800 p-5 rounded-xl shadow border border-gray-200 dark:border-gray-700 flex flex-col justify-between">
                <div>
                    <div class="flex justify-between items-start mb-2">
                        <span class="text-xs font-bold bg-gray-200 dark:bg-gray-700 px-2 py-1 rounded">${item.uid}</span>
                        <span class="text-sm font-bold ${statusColor}"><i class="fas fa-circle text-xs mr-1"></i>${item.status}</span>
                    </div>
                    <h3 class="text-lg font-bold font-mono text-blue-600 dark:text-blue-400 break-words">${item.kode_id}</h3>
                    <p class="text-sm text-gray-600 dark:text-gray-400 mt-1">${item.alat} — ${item.lokasi}</p>
                    ${item.original_kode_lokasi && item.kode_lokasi !== item.original_kode_lokasi ? `
                    <p class="text-xs mt-1 flex items-center gap-1">
                        <i class="fas fa-exchange-alt text-orange-400"></i>
                        <span class="text-orange-500 dark:text-orange-400 font-semibold">Status Mutasi: Sedang di luar lokasi asal</span>
                    </p>` : item.original_kode_lokasi ? `
                    <p class="text-xs mt-1 flex items-center gap-1">
                        <i class="fas fa-check-circle text-green-400"></i>
                        <span class="text-green-600 dark:text-green-400 font-semibold">Status Mutasi: Di lokasi asal</span>
                    </p>` : ''}
                </div>
                <div class="mt-4 flex gap-2">
                    <button onclick="window.openEdit('${item.uid}')"
                        class="flex-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 py-2 rounded font-bold hover:bg-blue-200 dark:hover:bg-blue-800 transition text-sm">
                        <i class="fas fa-edit"></i> UPDATE
                    </button>
                    ${mutasiBtn}
                    <button onclick="window.openQrModal('${item.uid}')"
                        class="flex-1 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 py-2 rounded font-bold hover:bg-gray-200 dark:hover:bg-gray-600 transition text-sm">
                        <i class="fas fa-qrcode"></i> QR
                    </button>
                </div>
            </div>
        `;
    });
}

// ── HISTORY VIEW STATE ─────────────────────────────────────────────────────
let _historyMode = 'repair'; // 'repair' | 'mutasi'
let _historySummary = [];    // cached from /api/history/summary

async function loadHistorySummary() {
    try {
        const res = await apiFetch('/history/summary');
        if (res.ok) _historySummary = await res.json();
    } catch (e) { /* silent */ }
}

function renderHistoryCards() {
    const container   = document.getElementById('history-repair-container');
    const searchInput = document.getElementById('search-history');
    if (!container) return;

    const searchQ = (searchInput?.value || '').toLowerCase();

    const filtered = _historySummary.filter(item =>
        item.kode_id.toLowerCase().includes(searchQ) ||
        item.uid.toLowerCase().includes(searchQ)
    );

    if (!filtered.length) {
        container.innerHTML = `<div class="col-span-2 text-center text-gray-400 py-12"><i class="fas fa-inbox text-3xl mb-2 block"></i>Belum ada riwayat perbaikan.</div>`;
        return;
    }

    container.innerHTML = filtered.map(item => {
        const r = item.repair;
        const statusColor = item.status === 'SO'  ? 'text-green-500' :
                            item.status === 'TSO' ? 'text-red-500'   : 'text-blue-500';
        const kondisiColor = r.latest_kondisi === 'SO'  ? 'text-green-500' :
                             r.latest_kondisi === 'TSO' ? 'text-red-500'   : 'text-blue-400';

        return `
        <div class="bg-white dark:bg-gray-800 p-5 rounded-xl shadow border border-gray-200 dark:border-gray-700 flex flex-col gap-3">
            <div class="flex justify-between items-start border-b dark:border-gray-700 pb-3">
                <div>
                    <p class="text-xs text-gray-400 font-mono">${item.uid}</p>
                    <h3 class="text-base font-bold font-mono text-purple-600 dark:text-purple-400">${item.kode_id}</h3>
                    <p class="text-xs text-gray-500 mt-0.5">${item.alat} — ${item.lokasi}</p>
                </div>
                <span class="text-sm font-bold ${statusColor} shrink-0"><i class="fas fa-circle text-xs mr-1"></i>${item.status}</span>
            </div>
            ${r.latest_date ? `
            <div class="space-y-1 text-xs text-gray-600 dark:text-gray-400">
                <div class="flex gap-2"><span class="text-gray-400 w-20 shrink-0">Tgl Terakhir</span><span class="font-mono">${formatUtcToLocal(r.latest_date)}</span></div>
                <div class="flex gap-2"><span class="text-gray-400 w-20 shrink-0">Teknisi</span><span class="font-semibold text-gray-700 dark:text-gray-200">${r.latest_teknisi || '—'}</span></div>
                <div class="flex gap-2"><span class="text-gray-400 w-20 shrink-0">Kondisi</span><span class="font-bold ${kondisiColor}">${r.latest_kondisi}</span></div>
                <div class="flex gap-2"><span class="text-gray-400 w-20 shrink-0">Keterangan</span><span class="italic">${r.latest_keterangan || '—'}</span></div>
            </div>` : `<p class="text-xs text-gray-400 italic">Belum ada riwayat perbaikan.</p>`}
            <button onclick="window.openHistoryDetail('${item.uid}', 'repair')"
                class="w-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 py-2 rounded-lg font-bold hover:bg-purple-200 dark:hover:bg-purple-800 transition text-sm">
                <i class="fas fa-list mr-1"></i> Lihat Riwayat Lengkap
            </button>
        </div>`;
    }).join('');
}

function renderMutasiCards() {
    const container   = document.getElementById('history-mutasi-container');
    const searchInput = document.getElementById('search-history');
    if (!container) return;

    const searchQ = (searchInput?.value || '').toLowerCase();

    // Only show assets that have at least one mutation
    const filtered = _historySummary.filter(item =>
        item.mutasi &&
        (item.kode_id.toLowerCase().includes(searchQ) || item.uid.toLowerCase().includes(searchQ))
    );

    if (!filtered.length) {
        container.innerHTML = `<div class="col-span-2 text-center text-gray-400 py-12"><i class="fas fa-exchange-alt text-3xl mb-2 block"></i>Belum ada riwayat mutasi.</div>`;
        return;
    }

    container.innerHTML = filtered.map(item => {
        const m = item.mutasi;
        const returnedBadge = m.sudah_kembali
            ? `<span class="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-xs px-2 py-0.5 rounded-full font-bold">✓ Sudah Kembali</span>`
            : `<span class="bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 text-xs px-2 py-0.5 rounded-full font-bold">⟳ Belum Kembali</span>`;

        return `
        <div class="bg-white dark:bg-gray-800 p-5 rounded-xl shadow border border-gray-200 dark:border-gray-700 flex flex-col gap-3">
            <div class="flex justify-between items-start border-b dark:border-gray-700 pb-3">
                <div>
                    <p class="text-xs text-gray-400 font-mono">${item.uid}</p>
                    <h3 class="text-base font-bold font-mono text-orange-600 dark:text-orange-400">${item.kode_id}</h3>
                    <p class="text-xs text-gray-500 mt-0.5">${item.alat}</p>
                </div>
                ${returnedBadge}
            </div>
            <div class="space-y-1 text-xs text-gray-600 dark:text-gray-400">
                <div class="flex gap-2"><span class="text-gray-400 w-24 shrink-0">Lokasi Asal</span><span class="font-semibold text-gray-700 dark:text-gray-200">${m.original_lokasi}</span></div>
                <div class="flex gap-2"><span class="text-gray-400 w-24 shrink-0">Lokasi Kini</span><span class="font-semibold">${item.lokasi}</span></div>
                <div class="flex gap-2"><span class="text-gray-400 w-24 shrink-0">Tgl Mutasi</span><span class="font-mono">${formatUtcToLocal(m.latest_date)}</span></div>
                <div class="flex gap-2"><span class="text-gray-400 w-24 shrink-0">Tujuan</span><span>${m.latest_lokasi_tuju || '—'}</span></div>
                <div class="flex gap-2"><span class="text-gray-400 w-24 shrink-0">Oleh</span><span class="font-semibold text-gray-700 dark:text-gray-200">${m.latest_oleh || '—'}</span></div>
                <div class="flex gap-2"><span class="text-gray-400 w-24 shrink-0">Alasan</span><span class="italic">${m.latest_alasan || '—'}</span></div>
                ${m.delta ? `<div class="flex gap-2"><span class="text-gray-400 w-24 shrink-0">Jeda Mutasi</span><span class="font-mono text-blue-500">${m.delta}</span></div>` : ''}
                <div class="flex gap-2"><span class="text-gray-400 w-24 shrink-0">Total Mutasi</span><span class="font-bold">${m.count}×</span></div>
            </div>
            <button onclick="window.openHistoryDetail('${item.uid}', 'mutasi')"
                class="w-full bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 py-2 rounded-lg font-bold hover:bg-orange-200 dark:hover:bg-orange-800 transition text-sm">
                <i class="fas fa-route mr-1"></i> Lihat Timeline Mutasi
            </button>
        </div>`;
    }).join('');
}

// ── MASTER DATA UI ─────────────────────────────────────────────────────────

// Tab switching
document.querySelectorAll('.master-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const target = tab.dataset.tab;

        const ACTIVE_CLS   = ['bg-gray-200', 'dark:bg-gray-600', 'text-gray-900', 'dark:text-white', 'font-semibold'];
        const INACTIVE_CLS = ['text-gray-500', 'dark:text-gray-400', 'font-medium', 'hover:bg-gray-100', 'dark:hover:bg-gray-700/60'];

        document.querySelectorAll('.master-tab').forEach(t => {
            const isActive = t.dataset.tab === target;
            // Clear both sets first
            [...ACTIVE_CLS, ...INACTIVE_CLS].forEach(c => t.classList.remove(c));
            // Apply correct set
            (isActive ? ACTIVE_CLS : INACTIVE_CLS).forEach(c => t.classList.add(c));
        });

        // Show correct panel
        document.querySelectorAll('.master-tab-panel').forEach(p => p.classList.add('hidden'));
        document.getElementById(`master-panel-${target}`)?.classList.remove('hidden');

        // Load data for the active tab
        if (target === 'users')  loadMasterUsers();
        if (target === 'alat')   loadMasterAlat();
        if (target === 'lokasi') loadMasterLokasi();
        if (target === 'upt')    loadMasterUpt();
    });
});

// ── LOAD FUNCTIONS ────────────────────────────────────────────────

async function loadMasterAlat() {
    const tbody = document.getElementById('table-alat');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-gray-400 text-sm"><i class="fas fa-spinner fa-spin mr-2"></i>Memuat...</td></tr>`;

    try {
        const res  = await apiFetch('/master/alat');
        const data = await res.json();

        if (!data.length) {
            tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-gray-400 text-sm">Belum ada data alat.</td></tr>`;
            return;
        }

        tbody.innerHTML = data.map(a => `
            <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td class="px-4 py-3 font-mono font-bold text-blue-600 dark:text-blue-400">${a.kode}</td>
                <td class="px-4 py-3 font-semibold">${a.nama}</td>
                <td class="px-4 py-3 text-gray-500 text-xs">${a.deskripsi || '—'}</td>
                <td class="px-4 py-3 text-gray-500 text-xs font-mono">${a.tanggal_pembelian || '—'}</td>
                <td class="px-4 py-3 text-right">
                    <button onclick="window.openMasterEdit('alat','${a.kode}','${a.nama}','${a.deskripsi || ''}','${a.tanggal_pembelian || ''}')"
                        class="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-3 py-1 rounded-lg font-bold hover:bg-blue-200 transition">
                        <i class="fas fa-edit mr-1"></i>Edit
                    </button>
                </td>
            </tr>
        `).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-red-400 text-sm">Gagal memuat data.</td></tr>`;
    }
}

async function loadMasterLokasi() {
    const tbody = document.getElementById('table-lokasi');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-gray-400 text-sm"><i class="fas fa-spinner fa-spin mr-2"></i>Memuat...</td></tr>`;

    try {
        const res  = await apiFetch('/master/lokasi');
        const data = await res.json();

        if (!data.length) {
            tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-gray-400 text-sm">Belum ada data lokasi.</td></tr>`;
            return;
        }

        tbody.innerHTML = data.map(l => `
            <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td class="px-4 py-3 font-mono font-bold text-blue-600 dark:text-blue-400">${l.kode_lokasi}</td>
                <td class="px-4 py-3 font-semibold">${l.nama_lokasi}</td>
                <td class="px-4 py-3">
                    <span class="text-xs px-2 py-0.5 rounded-full font-bold
                        ${l.tipe_lokasi === 'DAOP'      ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' :
                          l.tipe_lokasi === 'DIVRE'     ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' :
                          l.tipe_lokasi === 'BALAIYASA' ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300' :
                                                          'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'}">
                        ${l.tipe_lokasi}
                    </span>
                </td>
                <td class="px-4 py-3 text-right">
                    <button onclick="window.openMasterEdit('lokasi','${l.kode_lokasi}','${l.nama_lokasi}','${l.tipe_lokasi}')"
                        class="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-3 py-1 rounded-lg font-bold hover:bg-blue-200 transition">
                        <i class="fas fa-edit mr-1"></i>Edit
                    </button>
                </td>
            </tr>
        `).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-red-400 text-sm">Gagal memuat data.</td></tr>`;
    }
}

async function loadMasterUpt() {
    const tbody = document.getElementById('table-upt');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-gray-400 text-sm"><i class="fas fa-spinner fa-spin mr-2"></i>Memuat...</td></tr>`;

    // Also populate the lokasi select in the add form
    const lokasiSel = document.getElementById('new-upt-lokasi');
    if (lokasiSel && lokasiData.length) {
        lokasiSel.innerHTML = lokasiData.map(l =>
            `<option value="${l.code}">${l.name} (${l.code})</option>`
        ).join('');
    }

    try {
        const res  = await apiFetch('/master/upt');
        const data = await res.json();

        if (!data.length) {
            tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-gray-400 text-sm">Belum ada data UPT.</td></tr>`;
            return;
        }

        tbody.innerHTML = data.map(u => `
            <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td class="px-4 py-3 text-gray-400 text-xs font-mono">${u.id}</td>
                <td class="px-4 py-3 font-semibold">${u.nama_upt}</td>
                <td class="px-4 py-3 text-sm text-gray-500 font-mono">${u.kode_lokasi}</td>
                <td class="px-4 py-3 text-right">
                    <button onclick="window.openMasterEdit('upt',${u.id},'${u.nama_upt}','${u.kode_lokasi}')"
                        class="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-3 py-1 rounded-lg font-bold hover:bg-blue-200 transition">
                        <i class="fas fa-edit mr-1"></i>Edit
                    </button>
                </td>
            </tr>
        `).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-red-400 text-sm">Gagal memuat data.</td></tr>`;
    }
}

async function loadMasterUsers() {
    const tbody = document.getElementById('table-users');
    if (!tbody) return;

    const regionSel = document.getElementById('new-user-region');
    if (regionSel && lokasiData.length) {
        regionSel.innerHTML = lokasiData.map(l =>
            `<option value="${l.code}">${l.name} (${l.code})</option>`
        ).join('');
    }
    const addFormWrap = document.getElementById('add-user-form-wrap');
    if (addFormWrap) {
        addFormWrap.classList.toggle('hidden', _currentRole !== 'SUPER_ADMIN');
    }
    
    tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-gray-400 text-sm"><i class="fas fa-spinner fa-spin mr-2"></i>Memuat...</td></tr>`;

    try {
        const res  = await apiFetch('/users');
        if (!res.ok) throw new Error();
        const data = await res.json();

        if (!data.length) {
            tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-gray-400 text-sm">Belum ada data pengguna.</td></tr>`;
            return;
        }

        const roleColors = {
            SUPER_ADMIN: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
            ADMIN_DAOP:  'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
            TEKNISI:     'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
        };

        tbody.innerHTML = data.map(u => `
            <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td class="px-4 py-3 font-semibold font-mono">${u.username}</td>
                <td class="px-4 py-3">
                    <span class="text-xs px-2 py-0.5 rounded-full font-bold ${roleColors[u.role] || 'bg-gray-100 text-gray-700'}">
                        ${u.role}
                    </span>
                </td>
                <td class="px-4 py-3 text-sm text-gray-500 font-mono">${u.assigned_region || '—'}</td>
                <td class="px-4 py-3 text-right">
                    <button onclick="window.openMasterEdit('users',${u.id},'${u.username}','${u.role}','${u.assigned_region || ''}')"
                        class="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-3 py-1 rounded-lg font-bold hover:bg-blue-200 transition">
                        <i class="fas fa-edit mr-1"></i>Edit
                    </button>
                </td>
            </tr>
        `).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-red-400 text-sm">Gagal memuat data pengguna.</td></tr>`;
    }
}

// ── SORT MODAL ────────────────────────────────────────────────────

let _sortField = 'kode_id';
let _sortDir   = 'asc';

document.getElementById('btn-sort-db')?.addEventListener('click', () => {
    document.getElementById('sort-modal').classList.remove('hidden');
});

document.getElementById('close-sort-modal')?.addEventListener('click', () => {
    document.getElementById('sort-modal').classList.add('hidden');
});

document.querySelectorAll('.sort-dir-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        _sortDir = btn.dataset.dir;
        document.querySelectorAll('.sort-dir-btn').forEach(b => {
            const active = b.dataset.dir === _sortDir;
            b.classList.toggle('border-blue-500', active);
            b.classList.toggle('bg-blue-50',      active);
            b.classList.toggle('dark:bg-blue-900/20', active);
            b.classList.toggle('text-blue-700',   active);
            b.classList.toggle('dark:text-blue-300', active);
            b.classList.toggle('border-transparent', !active);
            b.classList.toggle('text-gray-500',   !active);
        });
    });
});

document.getElementById('btn-apply-sort')?.addEventListener('click', () => {
    _sortField = document.getElementById('sort-field').value;
    document.getElementById('sort-modal').classList.add('hidden');
    renderDbCards();
});

// ── ADD FORMS ─────────────────────────────────────────────────────

document.getElementById('form-add-alat')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const kode      = document.getElementById('new-alat-kode').value.trim().toUpperCase();
    const nama      = document.getElementById('new-alat-nama').value.trim();
    const tanggal   = document.getElementById('new-alat-tanggal').value || null;
    const deskripsi = document.getElementById('new-alat-deskripsi').value.trim();
    if (!kode || !nama) return showToast('Kode dan Nama wajib diisi.', 'warning');

    try {
        const res = await apiFetch('/master/alat', { method: 'POST', body: JSON.stringify({ kode, nama, deskripsi: deskripsi || null, tanggal_pembelian: tanggal }) });
        if (!res.ok) { const err = await res.json(); throw new Error(err.detail); }
        showToast('Alat berhasil ditambahkan.', 'success');
        e.target.reset();
        await loadMasterAlat();
        await fetchMasterData(); // refresh dropdowns
    } catch (err) {
        showToast(err.message, 'error');
    }
});

document.getElementById('form-add-lokasi')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const kode_lokasi = document.getElementById('new-lokasi-kode').value.trim().toUpperCase();
    const nama_lokasi = document.getElementById('new-lokasi-nama').value.trim();
    const tipe_lokasi = document.getElementById('new-lokasi-tipe').value;
    if (!kode_lokasi || !nama_lokasi) return showToast('Kode dan Nama wajib diisi.', 'warning');

    try {
        const res = await apiFetch('/master/lokasi', { method: 'POST', body: JSON.stringify({ kode_lokasi, nama_lokasi, tipe_lokasi }) });
        if (!res.ok) { const err = await res.json(); throw new Error(err.detail); }
        showToast('Lokasi berhasil ditambahkan.', 'success');
        e.target.reset();
        await loadMasterLokasi();
        await fetchMasterData();
    } catch (err) {
        showToast(err.message, 'error');
    }
});

document.getElementById('form-add-upt')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nama_upt    = document.getElementById('new-upt-nama').value.trim();
    const kode_lokasi = document.getElementById('new-upt-lokasi').value;
    if (!nama_upt || !kode_lokasi) return showToast('Nama UPT dan Lokasi wajib diisi.', 'warning');

    try {
        const res = await apiFetch('/master/upt', { method: 'POST', body: JSON.stringify({ nama_upt, kode_lokasi }) });
        if (!res.ok) { const err = await res.json(); throw new Error(err.detail); }
        showToast('UPT berhasil ditambahkan.', 'success');
        e.target.reset();
        await loadMasterUpt();
        await fetchMasterData();
    } catch (err) {
        showToast(err.message, 'error');
    }
});

// ── EDIT MODAL ────────────────────────────────────────────────────

let _masterEditCtx = null; // { type, id, ... }

window.openMasterEdit = (type, id, val1, val2, val3) => {
    _masterEditCtx = { type, id, val1, val2, val3 };
    const title  = document.getElementById('master-edit-title');
    const fields = document.getElementById('master-edit-fields');
    const deactivateBtn = document.getElementById('btn-master-edit-delete');
    if (!deactivateBtn) return;

    // Reset deactivate button label
    deactivateBtn.innerHTML = '<i class="fas fa-ban mr-1"></i> Nonaktifkan';

    if (type === 'users') {
        title.textContent = `Edit Pengguna: ${val1}`;
        deactivateBtn.innerHTML = '<i class="fas fa-user-slash mr-1"></i> Hapus User';
        fields.innerHTML = `
            <div>
                <label class="block text-xs font-semibold mb-1">Username</label>
                <input value="${val1}" disabled
                    class="w-full p-2 border rounded-md bg-gray-100 dark:bg-gray-600 dark:border-gray-500 text-gray-500 cursor-not-allowed">
            </div>
            <div>
                <label class="block text-xs font-semibold mb-1">Password</label>
                <input disabled placeholder="(belum digunakan)"
                    class="w-full p-2 border rounded-md bg-gray-100 dark:bg-gray-600 dark:border-gray-500 text-gray-400 cursor-not-allowed italic">
            </div>
            <div>
                <label class="block text-xs font-semibold mb-1">Role</label>
                <select id="edit-field-role" class="w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600">
                    ${['TEKNISI','ADMIN_DAOP','SUPER_ADMIN'].map(r =>
                        `<option value="${r}" ${val2 === r ? 'selected' : ''}>${r}</option>`
                    ).join('')}
                </select>
            </div>
            <div>
                <label class="block text-xs font-semibold mb-1">Region</label>
                <select id="edit-field-region" class="w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600">
                    ${lokasiData.map(l =>
                        `<option value="${l.code}" ${val3 === l.code ? 'selected' : ''}>${l.name} (${l.code})</option>`
                    ).join('')}
                </select>
            </div>
        `;
    } else if (type === 'alat') {
        title.textContent = `Edit Alat: ${id}`;
        fields.innerHTML = `
            <div>
                <label class="block text-xs font-semibold mb-1">Nama Alat</label>
                <input id="edit-field-nama" value="${val1}"
                    class="consolas-input w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600">
            </div>
            <div>
                <label class="block text-xs font-semibold mb-1">Deskripsi (opsional)</label>
                <input id="edit-field-deskripsi" value="${val2}"
                    class="w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600">
            </div>
            <div>
                <label class="block text-xs font-semibold mb-1">Tanggal Pembelian (opsional)</label>
                <input id="edit-field-tanggal" type="date" value="${val3 || ''}"
                    class="w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600">
            </div>
        `;
    } else if (type === 'lokasi') {
        title.textContent = `Edit Lokasi: ${id}`;
        fields.innerHTML = `
            <div>
                <label class="block text-xs font-semibold mb-1">Nama Lokasi</label>
                <input id="edit-field-nama" value="${val1}"
                    class="consolas-input w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600">
            </div>
            <div>
                <label class="block text-xs font-semibold mb-1">Tipe</label>
                <select id="edit-field-tipe" class="w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600">
                    ${['DAOP','DIVRE','BALAIYASA','PUSAT'].map(t =>
                        `<option value="${t}" ${val2 === t ? 'selected' : ''}>${t}</option>`
                    ).join('')}
                </select>
            </div>
        `;
    } else if (type === 'upt') {
        title.textContent = `Edit UPT #${id}`;
        fields.innerHTML = `
            <div>
                <label class="block text-xs font-semibold mb-1">Nama UPT</label>
                <input id="edit-field-nama" value="${val1}"
                    class="consolas-input w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600">
            </div>
            <div>
                <label class="block text-xs font-semibold mb-1">Lokasi</label>
                <select id="edit-field-lokasi" class="w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600">
                    ${lokasiData.map(l =>
                        `<option value="${l.code}" ${val2 === l.code ? 'selected' : ''}>${l.name} (${l.code})</option>`
                    ).join('')}
                </select>
            </div>
        `;
    }

    document.getElementById('master-edit-modal').classList.remove('hidden');
};

document.getElementById('close-master-edit')?.addEventListener('click', () => {
    document.getElementById('master-edit-modal').classList.add('hidden');
    _masterEditCtx = null;
});

document.getElementById('btn-master-edit-save')?.addEventListener('click', async () => {
    if (!_masterEditCtx) return;
    const { type, id } = _masterEditCtx;

    try {
        let res;
        if (type === 'users') {
            const role        = document.getElementById('edit-field-role').value;
            const region      = document.getElementById('edit-field-region').value;
            res = await apiFetch(`/users/${id}`, { method: 'PUT', body: JSON.stringify({ username: _masterEditCtx.val1, role, assigned_region: region }) });
        } else if (type === 'alat') {
            const nama        = document.getElementById('edit-field-nama').value.trim();
            const deskripsi   = document.getElementById('edit-field-deskripsi').value.trim();
            const tanggal     = document.getElementById('edit-field-tanggal')?.value || null;
            res = await apiFetch(`/master/alat/${id}`, { method: 'PUT', body: JSON.stringify({ kode: id, nama, deskripsi: deskripsi || null, tanggal_pembelian: tanggal }) });
        } else if (type === 'lokasi') {
            const nama_lokasi = document.getElementById('edit-field-nama').value.trim();
            const tipe_lokasi = document.getElementById('edit-field-tipe').value;
            res = await apiFetch(`/master/lokasi/${id}`, { method: 'PUT', body: JSON.stringify({ kode_lokasi: id, nama_lokasi, tipe_lokasi }) });
        } else if (type === 'upt') {
            const nama_upt    = document.getElementById('edit-field-nama').value.trim();
            const kode_lokasi = document.getElementById('edit-field-lokasi').value;
            res = await apiFetch(`/master/upt/${id}`, { method: 'PUT', body: JSON.stringify({ nama_upt, kode_lokasi }) });
        }

        if (!res.ok) { const err = await res.json(); throw new Error(err.detail); }
        showToast('Data berhasil diperbarui.', 'success');
        document.getElementById('master-edit-modal').classList.add('hidden');
        _masterEditCtx = null;

        if (type === 'users')  { await loadMasterUsers();                           }
        if (type === 'alat')   { await loadMasterAlat();   await fetchMasterData(); }
        if (type === 'lokasi') { await loadMasterLokasi(); await fetchMasterData(); }
        if (type === 'upt')    { await loadMasterUpt();    await fetchMasterData(); }

    } catch (err) {
        showToast(err.message, 'error');
    }
});

document.getElementById('btn-master-edit-delete')?.addEventListener('click', async () => {
    if (!_masterEditCtx) return;
    const { type, id, val1 } = _masterEditCtx;

    const confirmed = await customConfirm(
        type === 'users'
            ? `Hapus akun "${val1}" secara permanen? Tindakan ini tidak dapat dibatalkan.`
            : `Nonaktifkan "${val1}"?\n\nData yang sudah menggunakan referensi ini tidak akan terpengaruh, tapi tidak bisa dipilih untuk entri baru.`
    );
    if (!confirmed) return;

    try {
        let res;
        if (type === 'users')  res = await apiFetch(`/users/${id}`,          { method: 'DELETE' });
        if (type === 'alat')   res = await apiFetch(`/master/alat/${id}`,    { method: 'DELETE' });
        if (type === 'lokasi') res = await apiFetch(`/master/lokasi/${id}`,  { method: 'DELETE' });
        if (type === 'upt')    res = await apiFetch(`/master/upt/${id}`,     { method: 'DELETE' });

        if (!res.ok) { const err = await res.json(); throw new Error(err.detail); }
        showToast('Data berhasil dinonaktifkan.', 'success');
        document.getElementById('master-edit-modal').classList.add('hidden');
        _masterEditCtx = null;

        if (type === 'users')  { await loadMasterUsers();                           }
        if (type === 'alat')   { await loadMasterAlat();   await fetchMasterData(); }
        if (type === 'lokasi') { await loadMasterLokasi(); await fetchMasterData(); }
        if (type === 'upt')    { await loadMasterUpt();    await fetchMasterData(); }

    } catch (err) {
        showToast(err.message, 'error');
    }
});

// ── LAPORAN & EXPORT ───────────────────────────────────────────────────────

let _exportData = { active: [], afkir: [] }; // raw from server
let _exportFiltered = [];                      // after applying filters

// Called when switching to laporan view
async function initLaporanView() {
    // Populate lokasi filter from loaded master data
    const lokasiSel = document.getElementById('exp-filter-lokasi');
    if (lokasiSel && lokasiData.length) {
        lokasiSel.innerHTML = '<option value="">Semua Lokasi</option>' +
            lokasiData.map(l => `<option value="${l.code}">${l.name}</option>`).join('');
    }

    // Set default date range: last 12 months → today
    const today = new Date();
    const yearAgo = new Date();
    yearAgo.setFullYear(today.getFullYear() - 1);
    const fmt = d => d.toISOString().split('T')[0];

    const fromEl = document.getElementById('exp-date-from');
    const toEl   = document.getElementById('exp-date-to');
    if (fromEl && !fromEl.value) fromEl.value = fmt(yearAgo);
    if (toEl   && !toEl.value)   toEl.value   = fmt(today);

    await fetchExportData();
}

async function fetchExportData() {
    const previewCount = document.getElementById('exp-preview-count');
    if (previewCount) previewCount.innerHTML = `<i class="fas fa-spinner fa-spin mr-1"></i> Mengambil data...`;

    try {
        const res  = await apiFetch('/export/riwayat');
        if (!res.ok) throw new Error("Gagal mengambil data export.");
        _exportData = await res.json();

        // Update afkir stat
        const afkirStat = document.getElementById('exp-stat-afkir');
        if (afkirStat) {
            // Count unique afkir asset UIDs
            const afkirUids = new Set(_exportData.afkir.map(r => r.uid));
            afkirStat.textContent = afkirUids.size;
        }

        applyExportFilters();
    } catch (e) {
        if (previewCount) previewCount.innerHTML = `<i class="fas fa-exclamation-circle mr-1 text-red-400"></i> Gagal memuat data.`;
    }
}

function applyExportFilters() {
    const dateFrom   = document.getElementById('exp-date-from')?.value  || '';
    const dateTo     = document.getElementById('exp-date-to')?.value    || '';
    const lokasi     = document.getElementById('exp-filter-lokasi')?.value || '';
    const kondisi    = document.getElementById('exp-filter-kondisi')?.value || '';

    function filterRows(rows) {
        return rows.filter(r => {
            // Date filter — compare against tanggal string (YYYY-MM-DD prefix)
            if (dateFrom && r.tanggal !== '—' && r.tanggal.slice(0, 10) < dateFrom) return false;
            if (dateTo   && r.tanggal !== '—' && r.tanggal.slice(0, 10) > dateTo)   return false;
            // Lokasi filter matches lokasi_aset
            if (lokasi   && r.lokasi_aset !== lokasiData.find(l => l.code === lokasi)?.name) return false;
            // Kondisi filter matches last kondisi on the row
            if (kondisi  && r.kondisi !== kondisi) return false;
            return true;
        });
    }

    const filteredActive = filterRows(_exportData.active);
    const filteredAfkir  = filterRows(_exportData.afkir);
    _exportFiltered = { active: filteredActive, afkir: filteredAfkir };

    // Update summary stats from the in-memory db (already loaded)
    const statTotal = document.getElementById('exp-stat-total');
    const statSo    = document.getElementById('exp-stat-so');
    const statTso   = document.getElementById('exp-stat-tso');
    if (statTotal) statTotal.textContent = db.length;
    if (statSo)    statSo.textContent    = db.filter(x => x.status === 'SO').length;
    if (statTso)   statTso.textContent   = db.filter(x => x.status === 'TSO').length;

    // Update preview count
    const total = filteredActive.length + filteredAfkir.length;
    const previewCount = document.getElementById('exp-preview-count');
    if (previewCount) {
        previewCount.innerHTML =
            `<strong>${filteredActive.length}</strong> baris aset aktif + ` +
            `<strong>${filteredAfkir.length}</strong> baris aset afkir ` +
            `(<strong>${total}</strong> total) akan diekspor.`;
    }

    renderExportPreview(filteredActive);
}

function renderExportPreview(rows) {
    const tbody = document.getElementById('exp-preview-body');
    const label = document.getElementById('exp-preview-label');
    if (!tbody) return;
    if (label) label.textContent = 'Aset Aktif — 10 baris pertama';

    const preview = rows.slice(0, 10);
    if (!preview.length) {
        tbody.innerHTML = `<tr><td colspan="8" class="px-3 py-4 text-center text-gray-400">Tidak ada data dengan filter ini.</td></tr>`;
        return;
    }

    tbody.innerHTML = preview.map(r => `
        <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/50">
            <td class="px-3 py-2">${r.no ?? '—'}</td>
            <td class="px-3 py-2">${r.tanggal}</td>
            <td class="px-3 py-2 font-bold text-blue-600 dark:text-blue-400">${r.kode_id}</td>
            <td class="px-3 py-2">${r.alat}</td>
            <td class="px-3 py-2">${r.lokasi_aset}</td>
            <td class="px-3 py-2">${r.upt}</td>
            <td class="px-3 py-2">${r.teknisi}</td>
            <td class="px-3 py-2 font-bold ${r.kondisi === 'SO' ? 'text-green-500' : r.kondisi === 'TSO' ? 'text-red-500' : 'text-blue-500'}">${r.kondisi}</td>
        </tr>
    `).join('');
}

// Wire filter inputs to re-apply on change
['exp-date-from','exp-date-to','exp-filter-lokasi','exp-filter-kondisi'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', applyExportFilters);
});

// ── EXCEL EXPORT ──────────────────────────────────────────────────

document.getElementById('btn-export-excel')?.addEventListener('click', async () => {
    if (!window.XLSX) {
        showToast('Library Excel belum siap, tunggu sebentar.', 'warning');
        return;
    }

    const btn = document.getElementById('btn-export-excel');
    const orig = btn.innerHTML;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Membuat file...`;
    btn.disabled  = true;

    try {
        const headers = ['No','Tanggal','UID Aset','Kode ID','Alat','Lokasi Aset','Lokasi Perbaikan','UPT','Teknisi','Kondisi','Keterangan'];

        function rowsToSheet(rows) {
            const data = [headers, ...rows.map(r => [
                r.no ?? '', r.tanggal, r.uid, r.kode_id, r.alat,
                r.lokasi_aset, r.lokasi_perbaikan, r.upt,
                r.teknisi, r.kondisi, r.keterangan
            ])];
            const ws = XLSX.utils.aoa_to_sheet(data);

            // Column widths
            ws['!cols'] = [
                {wch:5},{wch:20},{wch:16},{wch:22},{wch:24},
                {wch:22},{wch:18},{wch:24},{wch:20},{wch:8},{wch:32}
            ];

            // Bold header row
            const range = XLSX.utils.decode_range(ws['!ref']);
            for (let C = range.s.c; C <= range.e.c; C++) {
                const cell = ws[XLSX.utils.encode_cell({ r: 0, c: C })];
                if (cell) cell.s = { font: { bold: true } };
            }
            return ws;
        }

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, rowsToSheet(_exportFiltered.active), 'Riwayat Perbaikan');
        XLSX.utils.book_append_sheet(wb, rowsToSheet(_exportFiltered.afkir),  'Aset Afkir');

        const dateStr = new Date().toISOString().slice(0,10);
        XLSX.writeFile(wb, `SIMAKAI_Laporan_${dateStr}.xlsx`);
        showToast('File Excel berhasil diunduh.', 'success');
    } catch (e) {
        console.error(e);
        showToast('Gagal membuat file Excel.', 'error');
    } finally {
        btn.innerHTML = orig;
        btn.disabled  = false;
    }
});

// ── PDF EXPORT ────────────────────────────────────────────────────

document.getElementById('btn-export-pdf')?.addEventListener('click', async () => {
    if (!window.jspdf) {
        showToast('Library PDF belum siap, tunggu sebentar.', 'warning');
        return;
    }

    const btn = document.getElementById('btn-export-pdf');
    const orig = btn.innerHTML;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Membuat PDF...`;
    btn.disabled  = true;

    try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

        const dateStr  = new Date().toLocaleDateString('id-ID', { day:'2-digit', month:'long', year:'numeric' });
        const columns  = ['No','Tanggal','Kode ID','Alat','Lokasi Aset','Lok. Perbaikan','UPT','Teknisi','Kondisi','Keterangan'];

        function buildBody(rows) {
            return rows.map(r => [
                r.no ?? '—', r.tanggal, r.kode_id, r.alat,
                r.lokasi_aset, r.lokasi_perbaikan, r.upt,
                r.teknisi, r.kondisi, r.keterangan
            ]);
        }

        // ── Page 1+: Active assets ──
        doc.setFontSize(14);
        doc.setFont('helvetica', 'bold');
        doc.text('SIMA-KAI — Laporan Riwayat Perbaikan Alat Kerja', 14, 14);
        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        doc.text(`Dicetak: ${dateStr}  |  Total baris: ${_exportFiltered.active.length}`, 14, 20);

        doc.autoTable({
            head: [columns],
            body: buildBody(_exportFiltered.active),
            startY: 25,
            styles:       { fontSize: 7, cellPadding: 2, overflow: 'linebreak' },
            headStyles:   { fillColor: [37, 99, 235], textColor: 255, fontStyle: 'bold' },
            alternateRowStyles: { fillColor: [241, 245, 249] },
            columnStyles: {
                0: { cellWidth: 8 },   // No
                1: { cellWidth: 28 },  // Tanggal
                2: { cellWidth: 28 },  // Kode ID
                3: { cellWidth: 24 },  // Alat
                4: { cellWidth: 28 },  // Lokasi Aset
                5: { cellWidth: 20 },  // Lok. Perbaikan
                6: { cellWidth: 30 },  // UPT
                7: { cellWidth: 22 },  // Teknisi
                8: { cellWidth: 12 },  // Kondisi
                9: { cellWidth: 'auto' } // Keterangan
            },
            didDrawCell: (data) => {
                // Colour the Kondisi column
                if (data.section === 'body' && data.column.index === 8) {
                    const val = data.cell.raw;
                    if (val === 'SO')  { doc.setTextColor(22, 163, 74);  }
                    if (val === 'TSO') { doc.setTextColor(220, 38,  38);  }
                    doc.setFontSize(7);
                    doc.text(val, data.cell.x + 2, data.cell.y + 4);
                    doc.setTextColor(0, 0, 0); // reset
                }
            }
        });

        // ── Afkir section on new page ──
        if (_exportFiltered.afkir.length > 0) {
            doc.addPage();
            doc.setFontSize(14);
            doc.setFont('helvetica', 'bold');
            doc.text('SIMA-KAI — Riwayat Perbaikan Aset Afkir (Tidak Aktif)', 14, 14);
            doc.setFontSize(9);
            doc.setFont('helvetica', 'normal');
            doc.text(`Dicetak: ${dateStr}  |  Total baris: ${_exportFiltered.afkir.length}`, 14, 20);

            doc.autoTable({
                head: [columns],
                body: buildBody(_exportFiltered.afkir),
                startY: 25,
                styles:       { fontSize: 7, cellPadding: 2, overflow: 'linebreak' },
                headStyles:   { fillColor: [107, 114, 128], textColor: 255, fontStyle: 'bold' },
                alternateRowStyles: { fillColor: [249, 250, 251] },
                columnStyles: {
                    0: { cellWidth: 8 },
                    1: { cellWidth: 28 },
                    2: { cellWidth: 28 },
                    3: { cellWidth: 24 },
                    4: { cellWidth: 28 },
                    5: { cellWidth: 20 },
                    6: { cellWidth: 30 },
                    7: { cellWidth: 22 },
                    8: { cellWidth: 12 },
                    9: { cellWidth: 'auto' }
                },
            });
        }

        const fileDate = new Date().toISOString().slice(0,10);
        doc.save(`SIMAKAI_Laporan_${fileDate}.pdf`);
        showToast('File PDF berhasil diunduh.', 'success');
    } catch (e) {
        console.error(e);
        showToast('Gagal membuat file PDF.', 'error');
    } finally {
        btn.innerHTML = orig;
        btn.disabled  = false;
    }
});

window.openMutasiModal = (uid) => {
    const item = db.find(x => x.uid === uid);
    if (!item) return;

    document.getElementById('mutasi-uid').value = uid;
    document.getElementById('mutasi-modal-subtitle').innerText = `${item.uid} | ${item.kode_id}`;
    document.getElementById('mutasi-lokasi-asal').textContent = item.lokasi;

    // Populate destination dropdown
    // ADMIN_DAOP: only their own region. SUPER_ADMIN: all.
    const tujuSel = document.getElementById('mutasi-lokasi-tuju');
    const options = _currentRole === 'ADMIN_DAOP'
        ? lokasiData.filter(l => l.code === (getJwtPayload(authToken)?.assigned_region || ''))
        : lokasiData.filter(l => l.code !== item.kode_lokasi); // exclude current

    tujuSel.innerHTML = '<option value="">Pilih Lokasi Tujuan...</option>' +
        lokasiData
            .filter(l => l.code !== item.kode_lokasi) // never show current lokasi as option
            .map(l => `<option value="${l.code}">${l.name}</option>`)
            .join('');

    document.getElementById('mutasi-alasan').value = '';
    document.getElementById('mutasi-modal').classList.remove('hidden');
};

// ── QR MODAL ───────────────────────────────────────────────────────────────

/**
 * Build the QR landing URL for a given UID.
 * The landing page lives at landing.html (same origin as index.html).
 */
function buildLandingUrl(uid) {
    // Use ngrok URL if configured, otherwise fall back to browser origin
    const base = NGROK_BASE_URL
        ? NGROK_BASE_URL.replace(/\/$/, '')           // strip trailing slash
        : window.location.origin;
    return `${base}/landing.html?uid=${encodeURIComponent(uid)}`;
}

/**
 * Draw a QR code onto the shared #qr-canvas using the tiny qrcodejs library.
 *
 * Mobile-safe strategy: render into an invisible <div> that is IN the normal
 * document flow (visibility:hidden, zero size) rather than off-screen at
 * -9999px. Off-screen elements get zero layout width on mobile browsers, which
 * causes qrcodejs to produce a blank canvas. We then wait for the <img> src
 * to finish loading (or use the child canvas directly) before copying pixels.
 */
function drawQrOnCanvas(text, targetCanvas) {
    return new Promise((resolve) => {
        // Container must be in-flow so the browser gives it real dimensions,
        // but invisible so it doesn't flash on screen.
        const tmp = document.createElement('div');
        tmp.style.cssText = 'visibility:hidden;width:180px;height:180px;overflow:hidden;';
        document.body.appendChild(tmp);

        new QRCode(tmp, {
            text,
            width:        180,
            height:       180,
            colorDark:    '#000000',
            colorLight:   '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
        });

        function copyAndClean(source) {
            const ctx = targetCanvas.getContext('2d');
            ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
            ctx.drawImage(source, 0, 0, 180, 180);
            document.body.removeChild(tmp);
            resolve();
        }

        // qrcodejs renders either an <img> (desktop Chrome/FF) or a <canvas>
        // (Safari, some mobile browsers). Handle both.
        const child = tmp.querySelector('canvas') || tmp.querySelector('img');

        if (!child) {
            // Fallback: wait one frame and try again
            requestAnimationFrame(() => {
                const retry = tmp.querySelector('canvas') || tmp.querySelector('img');
                if (!retry) { document.body.removeChild(tmp); resolve(); return; }
                if (retry.tagName === 'IMG' && !retry.complete) {
                    retry.onload = () => copyAndClean(retry);
                    retry.onerror = () => { document.body.removeChild(tmp); resolve(); };
                } else {
                    copyAndClean(retry);
                }
            });
            return;
        }

        if (child.tagName === 'CANVAS') {
            // Already a canvas — copy immediately (no async needed)
            copyAndClean(child);
        } else {
            // It's an <img>: wait for the data-URI to load before drawing
            if (child.complete && child.naturalWidth > 0) {
                copyAndClean(child);
            } else {
                child.onload  = () => copyAndClean(child);
                child.onerror = () => { document.body.removeChild(tmp); resolve(); };
            }
        }
    });
}

/**
 * Open the QR modal for a given asset UID.
 * Populates label text, then draws the QR.
 */
window.openQrModal = async (uid) => {
    const item = db.find(x => x.uid === uid);
    if (!item) return;

    _qrActiveItem = item;

    document.getElementById('qr-modal-subtitle').innerText = `${item.uid} | ${item.kode_id}`;
    document.getElementById('qr-label-kodeid').innerText   = item.kode_id;
    document.getElementById('qr-label-alat').innerText     = item.alat;
    document.getElementById('qr-label-lokasi').innerText   = item.lokasi;

    // Build and display the landing URL
    const landingUrl = buildLandingUrl(uid);
    const linkEl     = document.getElementById('qr-landing-link');
    const linkText   = document.getElementById('qr-landing-link-text');
    if (linkEl && linkText) {
        linkText.textContent = landingUrl;
        linkEl.href          = landingUrl;
    }

    // Reset copy button state
    const copyBtn = document.getElementById('btn-copy-link');
    if (copyBtn) {
        copyBtn.innerHTML = '<i class="fas fa-copy"></i>';
        copyBtn.title     = 'Salin link';
    }

    document.getElementById('qr-modal').classList.remove('hidden');

    const canvas = document.getElementById('qr-canvas');
    await drawQrOnCanvas(landingUrl, canvas);
};

function closeQrModal() {
    document.getElementById('qr-modal').classList.add('hidden');
    _qrActiveItem = null;
}

/**
 * Export the label preview as a PNG.
 * Uses html2canvas to capture #qr-label-preview (which already has the canvas
 * embedded), then triggers a browser download.
 *
 * html2canvas is loaded from CDN lazily only when needed.
 */
async function downloadQrPng() {
    if (!_qrActiveItem) return;

    const btn = document.getElementById('btn-qr-download-png');
    const originalHtml = btn.innerHTML;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Memproses...`;
    btn.disabled  = true;

    try {
        // Lazy-load html2canvas if not already present
        if (!window.html2canvas) {
            await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js');
        }

        const labelEl = document.getElementById('qr-label-preview');
        const canvas  = await html2canvas(labelEl, {
            backgroundColor: '#ffffff',
            scale: 3, // 3× for crisp print quality
            useCORS: true,
            logging: false
        });

        const link = document.createElement('a');
        link.download = `QR_${_qrActiveItem.kode_id}.png`;
        link.href     = canvas.toDataURL('image/png');
        link.click();

        showToast(`PNG berhasil diunduh: QR_${_qrActiveItem.kode_id}.png`, 'success');
    } catch (err) {
        console.error(err);
        showToast("Gagal membuat PNG. Coba lagi.", 'error');
    } finally {
        btn.innerHTML = originalHtml;
        btn.disabled  = false;
    }
}

/**
 * Export the label as a PDF using the browser's print dialog.
 *
 * Strategy: clone the label into the #qr-print-area div (which is revealed
 * only during @media print via CSS), trigger window.print(), then restore.
 * The QR canvas must be converted to a static <img> first so it survives
 * the print pipeline across all browsers.
 */
async function downloadQrPdf() {
    if (!_qrActiveItem) return;

    const btn = document.getElementById('btn-qr-download-pdf');
    const originalHtml = btn.innerHTML;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Membuka...`;
    btn.disabled  = true;

    try {
        // Convert the live QR canvas to a static data-URL image
        const qrCanvas   = document.getElementById('qr-canvas');
        const qrDataUrl  = qrCanvas.toDataURL('image/png');

        // Clone the label element
        const labelEl    = document.getElementById('qr-label-preview');
        const clone      = labelEl.cloneNode(true);

        // Replace <canvas> inside the clone with a plain <img>
        const cloneCanvas = clone.querySelector('canvas');
        if (cloneCanvas) {
            const img    = document.createElement('img');
            img.src      = qrDataUrl;
            img.width    = 180;
            img.height   = 180;
            cloneCanvas.parentNode.replaceChild(img, cloneCanvas);
        }

        // Put clone into the print area
        const printArea  = document.getElementById('qr-print-area');
        printArea.innerHTML = '';
        printArea.appendChild(clone);

        // Small delay so the browser renders the clone, then print
        await new Promise(r => setTimeout(r, 150));
        window.print();

        // Cleanup after the print dialog closes
        printArea.innerHTML = '';
        showToast("Dialog cetak/simpan PDF telah dibuka.", 'info');
    } catch (err) {
        console.error(err);
        showToast("Gagal membuka dialog cetak.", 'error');
    } finally {
        btn.innerHTML = originalHtml;
        btn.disabled  = false;
    }
}

/** Dynamically load an external script (returns a Promise). */
function loadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
        const s  = document.createElement('script');
        s.src    = src;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

// ── NOTIFICATIONS & CONFIRM DIALOG ────────────────────────────────────────

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');

    let colorClass = 'bg-blue-500';
    let iconClass  = 'fa-info-circle';

    if (type === 'success') { colorClass = 'bg-green-500'; iconClass = 'fa-check-circle'; }
    else if (type === 'error')   { colorClass = 'bg-red-500';    iconClass = 'fa-exclamation-circle'; }
    else if (type === 'warning') { colorClass = 'bg-yellow-500'; iconClass = 'fa-exclamation-triangle'; }

    toast.className = `${colorClass} text-white px-5 py-3 rounded-xl shadow-lg transform transition-all duration-300 opacity-0 translate-y-4 sm:translate-y-0 sm:translate-x-full flex items-center gap-3 font-semibold`;
    toast.innerHTML = `<i class="fas ${iconClass} text-xl"></i> <span>${message}</span>`;

    container.appendChild(toast);

    requestAnimationFrame(() => {
        setTimeout(() => toast.classList.remove('opacity-0', 'translate-y-4', 'sm:translate-x-full'), 10);
    });
    setTimeout(() => {
        toast.classList.add('opacity-0', 'translate-y-4', 'sm:translate-x-full');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function customConfirm(message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        if (!modal) return resolve(window.confirm(message));

        document.getElementById('confirm-message').innerText = message;
        modal.classList.remove('hidden');

        document.getElementById('confirm-cancel').onclick = () => {
            modal.classList.add('hidden');
            resolve(false);
        };
        document.getElementById('confirm-ok').onclick = () => {
            modal.classList.add('hidden');
            resolve(true);
        };
    });
}

/**
 * Convert a UTC datetime string from the server to the user's local time.
 * Input:  "2025-07-16 08:30:00"  (UTC, as returned by strftime in main.py)
 * Output: "16 Juli 2025 15:30:00" (local, formatted in Indonesian)
 */
function formatUtcToLocal(utcStr) {
    if (!utcStr) return '—';
    // Replace space with 'T' and append 'Z' so the browser parses it as UTC
    const date = new Date(utcStr.replace(' ', 'T') + 'Z');
    if (isNaN(date)) return utcStr; // fallback if unparseable

    const bulan = [
        'Januari','Februari','Maret','April','Mei','Juni',
        'Juli','Agustus','September','Oktober','November','Desember'
    ];
    const d = date.getDate();
    const m = bulan[date.getMonth()];
    const y = date.getFullYear();
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${d} ${m} ${y} ${hh}:${mm}:${ss}`;
}