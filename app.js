// --- CONSTANTS & STATE ---
const API_BASE_URL = '/api';

// ── SERVER CONFIG ─────────────────────────────────────────────────────────
let NGROK_BASE_URL  = '';
let BACKEND_WS_HOST = '';

// Data master disesuaikan dengan skema PostgreSQL
let alatKerjaData = []; 
let lokasiData    = []; 
let uptDatabase   = []; // Dipertahankan jika backend API masih membutuhkannya

let _currentRole = '';  // SUPER_ADMIN, ADMIN_WILAYAH, TEKNISI
let _wsNgrokFailed = false;
let _wsRetryCount = 0;

let db = []; // Menampung data tabel aset

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
        BACKEND_WS_HOST = window.location.host; 
    }
}

async function fetchMasterData() {
    try {
        const [alatRes, lokasiRes] = await Promise.all([
            fetch(`${API_BASE_URL}/master/alat`),
            fetch(`${API_BASE_URL}/master/lokasi`),
        ]);

        if (alatRes.ok)   alatKerjaData = (await alatRes.json()).map(a => ({ name: a.nama_alat, code: a.kode_alat }));
        if (lokasiRes.ok) {
            lokasiData = (await lokasiRes.json()).map(l => ({ name: l.nama_lokasi, code: l.id_lokasi }));
            uptDatabase = lokasiData.map(l => ({ upt: l.name, lokasi: l.code }));
        }

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
        sel.innerHTML = data.map(l => `<option value="${l.id_lokasi}">${l.nama_lokasi}</option>`).join('');
    } catch (e) {
        // master data not seeded yet
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

        const topbarUsername = document.getElementById('topbar-username');
        const topbarRole     = document.getElementById('topbar-role');
        if (topbarUsername) topbarUsername.innerText = currentUser;
        if (topbarRole)     topbarRole.innerText     = role.replace('_', ' ');

        if (role === 'SUPER_ADMIN') {
            const navMaster   = document.getElementById('nav-masterdata');
            const navAfkir    = document.getElementById('nav-afkir');
            const adminHelper = document.getElementById('admin-helper');
            if (navMaster)      navMaster.classList.remove('hidden');
            if (navAfkir)       navAfkir.classList.remove('hidden');
            if (adminHelper)    adminHelper.classList.remove('hidden');
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

        await fetchMasterData(); 
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
                username:  user,
                role:      role,
                id_lokasi: region || null
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
    if (u) u.value = '';

    document.getElementById('auth-step-1')?.classList.remove('hidden');
    document.getElementById('auth-step-2')?.classList.add('hidden');
    document.getElementById('auth-step-3')?.classList.add('hidden');
    document.getElementById('login-role') && (document.getElementById('login-role').value = '');

    activeHistoryUid = null;

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
        statSo.innerText    = db.filter(item => item.status_terakhir === 'SO').length;
        statTso.innerText   = db.filter(item => item.status_terakhir === 'TSO').length;
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
    const alatHTML  = alatKerjaData.map(d => `<option value="${d.code}">${d.name}</option>`).join('');
    const lokasiHTML = lokasiData.map(d => `<option value="${d.code}">${d.name}</option>`).join('');

    const inAlat   = document.getElementById('in-alat');
    const inLokasi = document.getElementById('in-lokasi');
    const editLokasi = document.getElementById('edit-lokasi');

    if (inAlat)    inAlat.innerHTML    = alatHTML;
    if (inLokasi)  inLokasi.innerHTML  = lokasiHTML;
    if (editLokasi) editLokasi.innerHTML = `<option value="" disabled selected>Pilih Lokasi</option>` + lokasiHTML;
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
        afkir:            { title: 'Pulihkan Aset Afkir',  subtitle: 'Lihat dan pulihkan aset yang telah di-afkir' },
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

    if (viewId === 'database' || viewId === 'history' || viewId === 'afkir') {
        const tv = document.getElementById(`view-${viewId}`);
        if (tv) tv.classList.add('is-flex');
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
    if (viewId === 'masterdata') {
        setTimeout(() => {
            document.querySelector('.master-tab[data-tab="users"]')?.click();
        }, 50);
    }
    if (viewId === 'afkir') {
        loadAfkirCards();
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
            const labels = { TEKNISI: 'Teknisi (TraKSI)', ADMIN_WILAYAH: 'Admin Wilayah', SUPER_ADMIN: 'Super Admin (RAMCES)' };
            
            // Normalize legacy values to the backend role contract.
            const roleVal = division === 'ADMIN_DAOP' ? 'ADMIN_WILAYAH' : division;
            
            document.getElementById('login-role').value = roleVal;
            document.getElementById('auth-display-role').innerText = labels[roleVal] || labels[division] || division;

            const regionSel = document.getElementById('login-region');
            if (roleVal === 'SUPER_ADMIN') {
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
    
    // Profile modal
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
            'ID Aset':   item.id_aset,
            'Kode Alat': item.kode_alat,
            'Lokasi':    item.id_lokasi,
            'Status':    item.status_terakhir,
            'Pengadaan': item.sumber_pengadaan
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
            head: [['ID Aset', 'Kode Alat', 'Lokasi', 'Status']],
            body: db.map(item => [item.id_aset, item.kode_alat, item.id_lokasi, item.status_terakhir]),
            startY: 25,
            styles: { fontSize: 7, cellPadding: 2 },
            headStyles: { fillColor: [22, 76, 129], textColor: 255, fontStyle: 'bold' },
            alternateRowStyles: { fillColor: [249, 250, 251] },
            didParseCell(data) {
                if (data.section === 'body' && data.column.index === 3) {
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

                let dataRows = rows.filter(r => r.some(c => String(c).trim() !== ''));
                if (!dataRows.length) { showToast('File kosong atau tidak terbaca.', 'error'); return; }

                const firstRow = dataRows[0].map(c => String(c).toLowerCase().trim());
                if (firstRow.some(c => c.includes('kode') || c.includes('nama'))) {
                    dataRows = dataRows.slice(1);
                }

                const parsed = [];
                for (const row of dataRows) {
                    const cells = row.map(c => String(c).trim()).filter((_, i) => row[i] !== '');
                    if (cells.length < 2) continue;

                    let startIdx = 0;
                    if (/^\d+$/.test(cells[0])) startIdx = 1;

                    const kode = cells[startIdx];
                    const nama = cells[startIdx + 1];

                    if (!kode || !nama) { showToast(`Baris tidak valid ditemukan: "${row.join(', ')}". Format harus: Kode, Nama Alat.`, 'error'); return; }
                    if (/[^A-Za-z0-9_\-]/.test(kode)) { showToast(`Kode tidak valid: "${kode}". Hanya huruf, angka, - dan _ yang diperbolehkan.`, 'error'); return; }

                    parsed.push({ kode_alat: kode.toUpperCase(), nama_alat: nama });
                }

                if (!parsed.length) { showToast('Tidak ada data valid yang ditemukan dalam file.', 'warning'); return; }

                let success = 0, failed = 0;
                for (const item of parsed) {
                    try {
                        const res = await apiFetch('/master/alat', { method: 'POST', body: JSON.stringify({ kode_alat: item.kode_alat, nama_alat: item.nama_alat }) });
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

    // Apply UPT Select function helper
    function applyUptSelect(locCode, uptSelectEl) {
        if (!uptSelectEl) return;
        const loc = lokasiData.find(l => l.code === locCode);
        const isBalaiyasa = loc?.name?.toUpperCase().includes('BALAIYASA') || loc?.tipe?.toUpperCase() === 'BALAIYASA';

        if (isBalaiyasa) {
            uptSelectEl.innerHTML = `<option value="">Belum ada UPT untuk lokasi Balaiyasa</option>`;
            uptSelectEl.disabled = true;
            return;
        }

        uptSelectEl.disabled = false;
        const matches = uptDatabase.filter(u => u.lokasi === locCode);
        if (matches.length > 0) {
            uptSelectEl.innerHTML = '<option value="">Pilih UPT...</option>' +
                matches.map(m => `<option value="${m.upt}">${m.upt}</option>`).join('');
        } else {
            uptSelectEl.innerHTML = `<option value="">Tidak ada UPT untuk lokasi ini</option>`;
            uptSelectEl.disabled = true;
        }
        uptSelectEl.value = '';
    }

    // Dynamic UPT Select
    document.getElementById('edit-lokasi')?.addEventListener('change', (e) => {
        applyUptSelect(e.target.value, document.getElementById('edit-upt'));
    });

    // SO / TSO buttons
    document.querySelectorAll('.status-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const status = e.currentTarget.dataset.status;
            document.getElementById('edit-kondisi').value = status;

            document.querySelectorAll('.status-btn').forEach(b => {
                b.classList.remove('is-so', 'is-tso', 'is-idle');
                if (b.dataset.status === status) {
                    b.classList.add(status === 'SO' ? 'is-so' : 'is-tso');
                } else {
                    b.classList.add('is-idle');
                }
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
            id_aset: codeID,
            kode_alat: alat,
            id_lokasi: lokasi,
            tanggal_pembelian: tanggal,
            sumber_pengadaan: pengadaan
        };

        try {
            const response = await apiFetch('/aset', { method: 'POST', body: JSON.stringify(payload) });
            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.detail || "Gagal menyimpan data ke database.");
            }
            const result = await response.json();
            showToast(`Berhasil disimpan! ID Aset: ${payload.id_aset}`, "success");
            this.reset();
            fetchAsetFromServer();
        } catch (error) {
            if (error.message !== "Unauthorized") showToast(error.message, "error");
        }
    });

    document.getElementById('form-edit')?.addEventListener('submit', async function(e) {
        e.preventDefault();

        const payload = {
            id_aset:    document.getElementById('edit-uid').value,
            kondisi:    document.getElementById('edit-kondisi').value,
            keterangan: document.getElementById('edit-keterangan').value || '-'
        };

        if (!payload.kondisi) return showToast("Pilih Kondisi Alat Kerja (SO/TSO)!", "warning");

        try {
            const response = await apiFetch('/riwayat-kondisi', { method: 'POST', body: JSON.stringify(payload) });
            if (!response.ok) throw new Error("Gagal menyimpan riwayat perbaikan.");
            
            showToast("Berhasil memperbarui kondisi", "success");
            switchView('database');
            fetchAsetFromServer();
        } catch (error) {
            if (error.message !== "Unauthorized") showToast(error.message, "error");
        }
    });

    // ── QR MODAL LISTENERS ───────────────────────────────────────────────────
    
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
            showToast('Salin manual: ' + linkText, 'info');
        }
    });

    document.getElementById('close-qr-modal')?.addEventListener('click', closeQrModal);
    document.getElementById('qr-modal')?.addEventListener('click', (e) => {
        if (e.target === document.getElementById('qr-modal')) closeQrModal();
    });
    
    document.getElementById('btn-qr-download-png')?.addEventListener('click', downloadQrPng);
    document.getElementById('btn-qr-download-pdf')?.addEventListener('click', downloadQrPdf);
    
    // ── HISTORY UI CONTROLS LISTENERS ────────────────────────────────────────
    
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

    function _setHistoryTab(active) {
        const repairBtn = document.getElementById('hist-tab-repair');
        const mutasiBtn = document.getElementById('hist-tab-mutasi');
        const repairCon = document.getElementById('history-repair-container');
        const mutasiCon = document.getElementById('history-mutasi-container');

        const ACTIVE_CLS   = ['bg-kai-orange', 'text-white', 'font-semibold', 'shadow-sm'];
        const INACTIVE_CLS = ['text-gray-500', 'dark:text-gray-400', 'font-medium', 'hover:bg-kai-orange/20', 'hover:text-kai-orange'];

        [repairBtn, mutasiBtn].forEach(b => {
            if (!b) return;
            ACTIVE_CLS.forEach(c => b.classList.remove(c));
            INACTIVE_CLS.forEach(c => b.classList.remove(c));
        });

        const activeBtn   = active === 'repair' ? repairBtn : mutasiBtn;
        const inactiveBtn = active === 'repair' ? mutasiBtn : repairBtn;
        ACTIVE_CLS.forEach(c => activeBtn?.classList.add(c));
        INACTIVE_CLS.forEach(c => inactiveBtn?.classList.add(c));

        repairCon?.classList.toggle('hidden', active !== 'repair');
        mutasiCon?.classList.toggle('hidden', active !== 'mutasi');
    }

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
                body: JSON.stringify({ id_aset: uid, id_lokasi_tujuan: lokasiTuju, alasan_mutasi: alasan || null })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || 'Gagal memproses mutasi.');

            showToast(data.message || 'Mutasi berhasil', 'success');
            document.getElementById('mutasi-modal').classList.add('hidden');
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
        clearInterval(window._wsHeartbeat);
        updateWsDot(false);
        if (authToken && (!NGROK_BASE_URL || !_wsNgrokFailed)) {
            setTimeout(setupWebSocket, 3000);
        }
    };

    ws.onerror = (event) => {
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
        overlay.classList.remove('active');
        if (sidebar.classList.contains('open')) {
            mainContent.classList.add('sidebar-open');
        }
    } else {
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
    const item = db.find(x => x.id_aset === uid);
    if (!item) return;
    document.getElementById('edit-uid').value      = item.id_aset;
    document.getElementById('edit-subtitle').innerText = `${item.id_aset} | ${item.kode_alat}`;
    document.getElementById('edit-teknisi').value  = currentUser;

    document.getElementById('form-edit').reset();
    document.getElementById('edit-kondisi').value  = '';
    document.querySelectorAll('.status-btn').forEach(btn => {
        btn.classList.remove('is-so', 'is-tso', 'is-idle');
        btn.classList.add('is-idle');
    });
    switchView('edit');
};

window.openHistoryDetail = async (uid, tab = 'repair') => {
    activeHistoryUid = uid;
    const item = _historySummary.find(x => x.id_aset === uid) || db.find(x => x.id_aset === uid);
    if (!item) return;

    document.getElementById('hist-detail-subtitle').innerText = `${item.id_aset}`;
    switchView('history-detail');
    switchDetailTab(tab, uid);
};

window.openQrModal = (uid) => {
    const item = db.find(x => x.id_aset === uid);
    if (!item) return;
    _qrActiveItem = item;

    document.getElementById('qr-modal-subtitle').textContent = item.id_aset;
    document.getElementById('qr-label-kodeid').textContent   = item.id_aset;
    document.getElementById('qr-label-alat').textContent     = item.kode_alat;
    document.getElementById('qr-label-lokasi').textContent   = item.id_lokasi;

    const canvas = document.getElementById('qr-canvas');
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    new QRCode(canvas, {
        text: `${window.location.origin}/public/${item.id_aset}`,
        width: 160, height: 160,
        colorDark: '#000000', colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
    });

    const landingUrl = `${NGROK_BASE_URL || window.location.origin}/public/${item.id_aset}`;
    const linkEl = document.getElementById('qr-landing-link');
    if (linkEl) { linkEl.href = landingUrl; }
    const textEl = document.getElementById('qr-landing-link-text');
    if (textEl) textEl.textContent = landingUrl;

    document.getElementById('qr-modal').classList.remove('hidden');
};

window.deleteAset = async (uid) => {
    const item = db.find(x => x.id_aset === uid);
    if (!item) return;

    const confirmed = await customConfirm(
        `Hapus aset "${uid}"?\n\nAset akan di-afkir dan tidak muncul di dashboard.\nRiwayat perbaikan dan mutasi tetap tersimpan.`
    );
    if (!confirmed) return;

    const reconfirmed = await customConfirm(
        `Konfirmasi terakhir: aset "${uid}" akan dihapus permanen dari tampilan aktif.\n\nUntuk memulihkan kembali aset ini (ataupun menghapus secara permanen), silakan merujuk pada menu Pulihkan Aset Afkir dan pulihkan dari menu tersebut.`
    );
    if (!reconfirmed) return;

    try {
        const res = await apiFetch(`/aset/afkir/${uid}`, { method: 'POST' });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || 'Gagal menghapus aset.');
        }
        showToast(`Aset ${uid} berhasil dihapus.`, 'success');
        await fetchAsetFromServer();
    } catch (e) {
        showToast(e.message, 'error');
    }
};

function switchDetailTab(tab, uid) {
    const ACTIVE   = ['bg-kai-orange', 'text-white', 'font-semibold', 'shadow-sm'];
    const INACTIVE = ['text-gray-500', 'dark:text-gray-400', 'font-medium', 'hover:bg-kai-orange/20', 'hover:text-kai-orange'];

    ['repair', 'mutasi'].forEach(t => {
        const btn = document.getElementById(`detail-tab-${t}`);
        if (!btn) return;
        [...ACTIVE, ...INACTIVE].forEach(c => btn.classList.remove(c));
        (t === tab ? ACTIVE : INACTIVE).forEach(c => btn.classList.add(c));
    });

    document.getElementById('detail-panel-repair').classList.toggle('hidden', tab !== 'repair');
    document.getElementById('detail-panel-mutasi').classList.toggle('hidden', tab !== 'mutasi');

    if (tab === 'repair') loadDetailRepair(uid);
    if (tab === 'mutasi') loadDetailMutasi(uid);
}

async function loadDetailRepair(uid) {
    const tbody = document.getElementById('hist-repair-tbody');
    tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-gray-500"><i class="fas fa-spinner fa-spin mr-2"></i>Mengambil data...</td></tr>`;
    try {
        const res = await apiFetch(`/riwayat-kondisi/${uid}`);
        if (!res.ok) throw new Error("Gagal mengambil riwayat.");
        const history = await res.json();
        if (!history.length) {
            tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-gray-500">Belum ada riwayat perbaikan.</td></tr>`;
            return;
        }
        tbody.innerHTML = history.map((h, i) => `
            <tr class="border-b dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td class="p-3">${i+1}</td>
                <td class="p-3 font-mono text-xs">${formatUtcToLocal(h.waktu_lapor)}</td>
                <td class="p-3">${h.id_pengguna}</td>
                <td class="p-3">${h.id_pengguna}</td>
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

        const returnedBadge = data.sudah_kembali
            ? `<span class="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-3 py-1 rounded-full text-xs font-bold">✓ Sudah Kembali ke Lokasi Awal</span>`
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

        if (!data.mutasi || !data.mutasi.length) {
            timeline.innerHTML = `<div class="text-center text-gray-400 py-6">Belum ada riwayat mutasi.</div>`;
            return;
        }

        timeline.innerHTML = data.mutasi.map((m, i) => `
            <div class="flex gap-4 items-start">
                <div class="flex flex-col items-center">
                    <div class="w-8 h-8 rounded-full bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 flex items-center justify-center text-xs font-bold shrink-0">${i + 1}</div>
                    ${i < data.mutasi.length - 1 ? '<div class="w-0.5 flex-1 bg-gray-200 dark:bg-gray-700 mt-1"></div>' : ''}
                </div>
                <div class="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4 flex-1 mb-2 space-y-1 text-sm">
                    <div class="flex justify-between items-start gap-2">
                        <span class="font-bold text-orange-600 dark:text-orange-400">${m.id_lokasi_asal} → ${m.id_lokasi_tujuan}</span>
                    </div>
                    <p class="text-xs text-gray-500 font-mono">${formatUtcToLocal(m.waktu_mutasi)}</p>
                    <p class="text-xs text-gray-600 dark:text-gray-400"><span class="font-semibold">Oleh ID:</span> ${m.id_pengguna}</p>
                    <p class="text-xs text-gray-600 dark:text-gray-400 italic">${m.alasan_mutasi}</p>
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
    const isAdmin = _currentRole === 'SUPER_ADMIN' || _currentRole === 'ADMIN_WILAYAH';
    
    container.innerHTML = '';

    const filteredItems = db.filter(item => {
        const matchSearch = (item.id_aset || '').toLowerCase().includes(searchQ) ||
                            (item.kode_alat || '').toLowerCase().includes(searchQ) ||
                            (item.id_lokasi || '').toLowerCase().includes(searchQ);
        const matchMode = true; 
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
        const statusColor = item.status_terakhir === 'SO'  ? 'text-green-500' :
                            item.status_terakhir === 'TSO' ? 'text-red-500'   : 'text-blue-500';

        const mutasiBtn = isAdmin ? `
            <button onclick="window.openMutasiModal('${item.id_aset}')"
                class="flex-1 bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 py-2 rounded font-bold hover:bg-orange-200 dark:hover:bg-orange-800 transition text-sm">
                <i class="fas fa-exchange-alt"></i> MUTASI
            </button>` : '';

        const isSuperAdmin = _currentRole === 'SUPER_ADMIN';
        const isAdminWilayah = _currentRole === 'ADMIN_WILAYAH';
        const canDelete = isSuperAdmin || isAdminWilayah;

        container.innerHTML += `
            <div class="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 flex flex-col justify-between hover:border-kai-blue dark:hover:border-kai-orange transition-colors">
                <div>
                    <div class="flex justify-between items-start mb-2">
                        <span class="text-lg font-bold font-mono text-kai-blue dark:text-blue-400">${item.id_aset}</span>
                        <span class="text-xs font-bold px-2 py-0.5 rounded-full ${item.status_terakhir === 'SO' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : item.status_terakhir === 'TSO' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' : 'bg-blue-100 text-blue-700'}">
                            <i class="fas fa-circle text-[8px] mr-1"></i>${item.status_terakhir}
                        </span>
                    </div>
                    <p class="text-sm text-gray-700 dark:text-gray-300 font-semibold mt-1">${item.kode_alat}</p>
                    <p class="text-xs text-gray-400 mt-0.5">${item.id_lokasi}</p>
                </div>
                <div class="mt-4 space-y-2">
                    <!-- Row 1 desktop: Perbarui + Mutasi + QR | mobile: Perbarui + Mutasi -->
                    <div class="grid grid-cols-2 md:grid-cols-3 gap-2">
                        <button onclick="window.openEdit('${item.id_aset}')"
                            class="flex items-center justify-center gap-1.5 px-3 py-2.5 bg-kai-blue hover:bg-blue-800 active:bg-blue-900 text-white font-semibold rounded-lg transition text-sm shadow-sm">
                            <i class="fas fa-edit text-sm"></i> Perbarui
                        </button>
                        ${isAdmin ? `
                        <button onclick="window.openMutasiModal('${item.id_aset}')"
                            class="flex items-center justify-center gap-1.5 px-3 py-2.5 bg-kai-orange hover:bg-orange-600 active:bg-orange-700 text-white font-semibold rounded-lg transition text-sm shadow-sm">
                            <i class="fas fa-exchange-alt text-sm"></i> Mutasi
                        </button>` : `<div></div>`}
                        <!-- QR: hidden on mobile (shown in row 2 below) -->
                        <button onclick="window.openQrModal('${item.id_aset}')"
                            class="hidden md:flex items-center justify-center gap-1.5 px-3 py-2.5 bg-violet-600 dark:bg-violet-700 hover:bg-violet-400 dark:hover:bg-violet-600 text-white font-semibold rounded-lg transition text-sm">
                            <i class="fas fa-qrcode text-sm"></i> QR
                        </button>
                    </div>
                    <!-- Row 2 mobile: QR only -->
                    <button onclick="window.openQrModal('${item.id_aset}')"
                        class="md:hidden w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-violet-600 dark:bg-violet-700 hover:bg-violet-200 dark:hover:bg-violet-600 text-white font-semibold rounded-lg transition text-sm">
                        <i class="fas fa-qrcode text-sm"></i> Pindai / Cetak QR
                    </button>
                    <!-- Row 3: Delete (admin only) -->
                    ${canDelete ? `
                    <button onclick="window.deleteAset('${item.id_aset}')"
                        class="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 text-red-600 dark:text-red-400 font-semibold rounded-lg transition text-sm border border-red-200 dark:border-red-800">
                        <i class="fas fa-trash-alt text-sm"></i> Hapus Aset
                    </button>` : ''}
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
        (item.id_aset || '').toLowerCase().includes(searchQ)
    );

    if (!filtered.length) {
        container.innerHTML = `<div class="col-span-2 text-center text-gray-400 py-12"><i class="fas fa-inbox text-3xl mb-2 block"></i>Belum ada riwayat perbaikan.</div>`;
        return;
    }

    container.innerHTML = filtered.map(item => {
        const r = item.repair || {};
        const statusColor = item.status_terakhir === 'SO'  ? 'text-green-500' :
                            item.status_terakhir === 'TSO' ? 'text-red-500'   : 'text-blue-500';
        const kondisiColor = r.latest_kondisi === 'SO'  ? 'text-green-500' :
                             r.latest_kondisi === 'TSO' ? 'text-red-500'   : 'text-blue-400';

        return `
        <div class="bg-white dark:bg-gray-800 p-5 rounded-xl shadow border border-gray-200 dark:border-gray-700 flex flex-col gap-3">
            <div class="flex justify-between items-start border-b dark:border-gray-700 pb-3">
                <div>
                    <h3 class="text-base font-bold font-mono text-kai-blue dark:text-blue-400">${item.id_aset}</h3>
                    <p class="text-xs text-gray-500 dark:text-gray-200 mt-0.5">${item.kode_alat} — ${item.id_lokasi}</p>
                </div>
                <span class="text-sm font-bold ${statusColor} shrink-0"><i class="fas fa-circle text-xs mr-1"></i>${item.status_terakhir}</span>
            </div>
            ${r.latest_date ? `
            <div class="space-y-1 text-xs text-gray-600 dark:text-gray-400">
                <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Perbaruan Terakhir</span><span class="font-mono">${formatUtcToLocal(r.latest_date)}</span></div>
                <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">UPT Pengirim</span><span>${r.latest_upt || '—'}</span></div>
                <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Petugas</span><span>${r.latest_teknisi || '—'}</span></div>
                <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Keterangan</span><span class="italic">${r.latest_keterangan || '—'}</span></div>
            </div>` : `<p class="text-xs text-gray-400 italic">Belum ada riwayat perbaikan.</p>`}
            <button onclick="window.openHistoryDetail('${item.id_aset}', 'repair')"
                class="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-kai-blue hover:bg-blue-800 active:bg-blue-900 text-white font-semibold rounded-lg transition text-sm shadow-sm">
                <i class="fas fa-list text-sm"></i> Lihat Riwayat Lengkap
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
        item.mutasi && (item.id_aset || '').toLowerCase().includes(searchQ)
    );

    if (!filtered.length) {
        container.innerHTML = `<div class="col-span-2 text-center text-gray-400 py-12"><i class="fas fa-exchange-alt text-3xl mb-2 block"></i>Belum ada riwayat mutasi.</div>`;
        return;
    }

    container.innerHTML = filtered.map(item => {
        const m = item.mutasi;
        const returnedBadge = m.sudah_kembali
            ? `<span class="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-xs px-2 py-0.5 rounded-full font-bold">✓ Sudah Kembali ke Lokasi Asal</span>`
            : `<span class="bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 text-xs px-2 py-0.5 rounded-full font-bold">⟳ Belum Kembali</span>`;

        return `
        <div class="bg-white dark:bg-gray-800 p-5 rounded-xl shadow border border-gray-200 dark:border-gray-700 flex flex-col gap-3">
            <div class="flex justify-between items-start border-b dark:border-gray-700 pb-3">
                <div>
                    <h3 class="text-base font-bold font-mono text-kai-orange dark:text-orange-400">${item.id_aset}</h3>
                    <p class="text-xs text-gray-500 dark:text-gray-200 mt-0.5">${item.kode_alat} — ${item.id_lokasi}</p>
                </div>
                ${returnedBadge}
            </div>
            <div class="space-y-1 text-xs text-gray-600 dark:text-gray-400">
                <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Lokasi Asal</span><span class="font-semibold text-gray-700 dark:text-gray-200">${m.original_lokasi}</span></div>
                <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Lokasi Kini</span><span class="font-semibold">${item.id_lokasi}</span></div>
                <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Tanggal Mutasi</span><span class="font-mono">${formatUtcToLocal(m.latest_date)}</span></div>
                <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Tujuan</span><span>${m.latest_lokasi_tuju || '—'}</span></div>
                <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Alasan</span><span class="italic">${m.latest_alasan || '—'}</span></div>
                <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Total Mutasi</span><span class="font-bold">${m.count}×</span></div>
            </div>
            <button onclick="window.openHistoryDetail('${item.id_aset}', 'mutasi')"
                class="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-kai-orange hover:bg-orange-600 active:bg-orange-700 text-white font-semibold rounded-lg transition text-sm shadow-sm">
                <i class="fas fa-route text-sm"></i> Lihat Timeline Mutasi
            </button>
        </div>`;
    }).join('');
}

// ── MASTER DATA UI ─────────────────────────────────────────────────────────

// Tab switching
document.querySelectorAll('.master-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const target = tab.dataset.tab;

        const ACTIVE_CLS   = ['bg-kai-orange', 'text-white', 'font-semibold', 'shadow-sm'];
        const INACTIVE_CLS = ['text-gray-500', 'dark:text-gray-400', 'font-medium', 'hover:bg-kai-orange/20', 'hover:text-kai-orange'];

        document.querySelectorAll('.master-tab').forEach(t => {
            const isActive = t.dataset.tab === target;
            [...ACTIVE_CLS, ...INACTIVE_CLS].forEach(c => t.classList.remove(c));
            (isActive ? ACTIVE_CLS : INACTIVE_CLS).forEach(c => t.classList.add(c));
        });

        document.querySelectorAll('.master-tab-panel').forEach(p => p.classList.add('hidden'));
        document.getElementById(`master-panel-${target}`)?.classList.remove('hidden');

        if (target === 'users')  loadMasterUsers();
        if (target === 'alat')   loadMasterAlat();
        if (target === 'lokasi') loadMasterLokasi();
        if (target === 'upt')    loadMasterUpt();
    });
});

// ── LOAD FUNCTIONS ────────────────────────────────────────────────

function syncNewUserRegion() {
    const roleEl   = document.getElementById('new-user-role');
    const regionEl = document.getElementById('new-user-region');
    if (!roleEl || !regionEl) return;

    const isSA = roleEl.value === 'SUPER_ADMIN';
    if (isSA) {
        regionEl.disabled = true;
        regionEl.innerHTML = '<option value="">Semua Region (tidak diperlukan)</option>';
    } else {
        regionEl.disabled = false;
        regionEl.innerHTML = lokasiData.map(l =>
            `<option value="${l.code}">${l.name} (${l.code})</option>`
        ).join('');
        if (!regionEl.value && lokasiData.length) regionEl.value = lokasiData[0].code;
    }
}

async function loadMasterUsers() {
    const tbody = document.getElementById('table-users');
    if (!tbody) return;

    syncNewUserRegion();
    
    const addFormWrap = document.getElementById('form-add-user');
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
            ADMIN_WILAYAH:  'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
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
                <td class="px-4 py-3 text-sm text-gray-500 font-mono">${u.id_lokasi || '—'}</td>
                <td class="px-4 py-3 text-right">
                    <button onclick="window.openMasterEdit('users',${u.id_pengguna},'${u.username}','${u.role}','${u.id_lokasi || ''}')"
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
                <td class="px-4 py-3 font-mono font-bold text-blue-600 dark:text-blue-400">${a.kode_alat}</td>
                <td class="px-4 py-3 font-semibold">${a.nama_alat}</td>
                <td class="px-4 py-3 text-gray-500 text-xs"></td>
                <td class="px-4 py-3 text-gray-500 text-xs font-mono"></td>
                <td class="px-4 py-3 text-right">
                    <button onclick="window.openMasterEdit('alat','${a.kode_alat}','${a.nama_alat}','','')"
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
                <td class="px-4 py-3 font-mono font-bold text-blue-600 dark:text-blue-400">${l.id_lokasi}</td>
                <td class="px-4 py-3 font-semibold">${l.nama_lokasi}</td>
                <td class="px-4 py-3">
                    <span class="text-xs px-2 py-0.5 rounded-full font-bold
                        ${l.tipe === 'DAOP'      ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' :
                          l.tipe === 'DIVRE'     ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' :
                          l.tipe === 'PUSAT'     ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300' :
                                                          'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'}">
                        ${l.tipe}
                    </span>
                </td>
                <td class="px-4 py-3 text-right">
                    <button onclick="window.openMasterEdit('lokasi','${l.id_lokasi}','${l.nama_lokasi}','${l.tipe}')"
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

    const lokasiSel = document.getElementById('new-upt-lokasi');
    if (lokasiSel && lokasiData.length) {
        lokasiSel.innerHTML = lokasiData.map(l =>
            `<option value="${l.code}">${l.name} (${l.code})</option>`
        ).join('');
    }

    try {
        const res  = await apiFetch('/master/lokasi');
        const data = await res.json();

        if (!data.length) {
            tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-gray-400 text-sm">Belum ada data UPT.</td></tr>`;
            return;
        }

        tbody.innerHTML = data.map(u => `
            <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td class="px-4 py-3 text-gray-400 text-xs font-mono">${u.id_lokasi}</td>
                <td class="px-4 py-3 font-semibold">${u.nama_lokasi}</td>
                <td class="px-4 py-3 text-sm text-gray-500 font-mono">${u.tipe}</td>
                <td class="px-4 py-3 text-right">
                    <span class="text-xs text-gray-500">Data lokasi</span>
                </td>
            </tr>
        `).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-red-400 text-sm">Gagal memuat data.</td></tr>`;
    }
}

// ── SORT MODAL ────────────────────────────────────────────────────

let _sortField = 'id_aset';
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

document.getElementById('form-add-user')?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const username  = document.getElementById('new-user-username').value.trim();
    const role      = document.getElementById('new-user-role').value;
    const region    = document.getElementById('new-user-region').value;

    if (!username) return showToast('Nama pengguna tidak boleh kosong.', 'warning');

    try {
        const res = await apiFetch('/users/create', {
            method: 'POST',
            body: JSON.stringify({ username, role, id_lokasi: region || null })
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || 'Gagal menambahkan pengguna.');
        }
        showToast(`Pengguna "${username}" berhasil ditambahkan.`, 'success');
        document.getElementById('form-add-user').reset();
        await loadMasterUsers();
    } catch (err) {
        if (err.message !== 'Unauthorized') showToast(err.message, 'error');
    }
});

document.getElementById('form-add-alat')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const kode      = document.getElementById('new-alat-kode').value.trim().toUpperCase();
    const nama      = document.getElementById('new-alat-nama').value.trim();
    if (!kode || !nama) return showToast('Kode dan Nama wajib diisi.', 'warning');

    try {
        const res = await apiFetch('/master/alat', { method: 'POST', body: JSON.stringify({ kode_alat: kode, nama_alat: nama }) });
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
        const res = await apiFetch('/master/lokasi', { method: 'POST', body: JSON.stringify({ id_lokasi: kode_lokasi, nama_lokasi, tipe: tipe_lokasi }) });
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

    showToast('Fitur UPT belum tersedia pada backend saat ini. Lokasi yang ada dapat dikelola melalui tab Lokasi.', 'warning');
    e.target.reset();
});

document.getElementById('new-upt-lokasi')?.addEventListener('change', (e) => {
    // Warn admin if they're trying to add UPT under Balaiyasa
    const loc = lokasiData.find(l => l.code === e.target.value);
    const isBalaiyasa = loc?.name?.toUpperCase().includes('BALAIYASA') || loc?.tipe?.toUpperCase() === 'BALAIYASA';
    const namaInput = document.getElementById('new-upt-nama');
    const submitBtn = document.querySelector('#form-add-upt button[type="submit"]');
    if (isBalaiyasa) {
        if (namaInput) { namaInput.disabled = true; namaInput.placeholder = 'Tidak berlaku untuk Balaiyasa'; }
        if (submitBtn) submitBtn.disabled = true;
        showToast('Lokasi Balaiyasa tidak memiliki UPT terkait.', 'warning');
    } else {
        if (namaInput) { namaInput.disabled = false; namaInput.placeholder = 'Nama UPT'; }
        if (submitBtn) submitBtn.disabled = false;
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
                <label class="block text-xs font-semibold mb-1">Role</label>
                <select id="edit-field-role" class="w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600">
                    ${['TEKNISI','ADMIN_WILAYAH','SUPER_ADMIN'].map(r =>
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
        
        // Wire role change to disable region — mirrors login page behaviour
        const roleEl = document.getElementById('edit-field-role');
        const regionEl = document.getElementById('edit-field-region');
        function syncRegionState() {
            const isSA = roleEl?.value === 'SUPER_ADMIN';
            if (regionEl) {
                if (isSA) {
                    regionEl.disabled = true;
                    regionEl.innerHTML = '<option value="">Semua Region (tidak diperlukan)</option>';
                } else {
                    regionEl.disabled = false;
                    // Repopulate with lokasi options, keeping current selection or defaulting to first
                    const currentVal = regionEl.dataset.currentVal || lokasiData[0]?.code || '';
                    regionEl.innerHTML = lokasiData.map(l =>
                        `<option value="${l.code}" ${l.code === currentVal ? 'selected' : ''}>${l.name} (${l.code})</option>`
                    ).join('');
                    if (!regionEl.value && lokasiData.length) regionEl.value = lokasiData[0].code;
                }
            }
        }
        // Store the original region value so repopulate can restore it
        if (regionEl) regionEl.dataset.currentVal = val3 || '';
        roleEl?.addEventListener('change', syncRegionState);
        syncRegionState(); // run on open

        // Hide delete button for SUPER_ADMIN users
        if (val2 === 'SUPER_ADMIN') {
            deactivateBtn.classList.add('hidden');
        } else {
            deactivateBtn.classList.remove('hidden');
        }
    } else if (type === 'alat') {
        title.textContent = `Edit Alat: ${id}`;
        fields.innerHTML = `
            <div>
                <label class="block text-xs font-semibold mb-1">Nama Alat</label>
                <input id="edit-field-nama" value="${val1}"
                    class="consolas-input w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600">
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
                    ${['DAOP','DIVRE','PUSAT'].map(t =>
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
            res = await apiFetch(`/users/${id}`, { method: 'PUT', body: JSON.stringify({ username: _masterEditCtx.val1, role, id_lokasi: region }) });
        } else if (type === 'alat') {
            const nama        = document.getElementById('edit-field-nama').value.trim();
            res = await apiFetch(`/master/alat/${id}`, { method: 'PUT', body: JSON.stringify({ kode_alat: id, nama_alat: nama }) });
        } else if (type === 'lokasi') {
            const nama_lokasi = document.getElementById('edit-field-nama').value.trim();
            const tipe_lokasi = document.getElementById('edit-field-tipe').value;
            res = await apiFetch(`/master/lokasi/${id}`, { method: 'PUT', body: JSON.stringify({ id_lokasi: id, nama_lokasi, tipe: tipe_lokasi }) });
        } else if (type === 'upt') {
            res = await apiFetch(`/master/lokasi/${id}`, { method: 'PUT', body: JSON.stringify({ id_lokasi: id, nama_lokasi: _masterEditCtx.val1, tipe: 'DAOP' }) });
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
        if (type === 'upt')    res = await apiFetch(`/master/lokasi/${id}`,  { method: 'DELETE' });

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
            const afkirUids = new Set(_exportData.afkir.map(r => r.id_aset));
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
            if (dateFrom && r.tanggal !== '—' && r.tanggal.slice(0, 10) < dateFrom) return false;
            if (dateTo   && r.tanggal !== '—' && r.tanggal.slice(0, 10) > dateTo)   return false;
            if (lokasi   && r.id_lokasi_asal !== lokasi) return false;
            if (kondisi  && r.kondisi !== kondisi) return false;
            return true;
        });
    }

    const filteredActive = filterRows(_exportData.active);
    const filteredAfkir  = filterRows(_exportData.afkir);
    _exportFiltered = { active: filteredActive, afkir: filteredAfkir };

    const statTotal = document.getElementById('exp-stat-total');
    const statSo    = document.getElementById('exp-stat-so');
    const statTso   = document.getElementById('exp-stat-tso');
    if (statTotal) statTotal.textContent = db.length;
    if (statSo)    statSo.textContent    = db.filter(x => x.status_terakhir === 'SO').length;
    if (statTso)   statTso.textContent   = db.filter(x => x.status_terakhir === 'TSO').length;

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
    if (!tbody) return;

    const preview = rows.slice(0, 10);
    if (!preview.length) {
        tbody.innerHTML = `<tr><td colspan="8" class="px-3 py-4 text-center text-gray-400">Tidak ada data dengan filter ini.</td></tr>`;
        return;
    }

    tbody.innerHTML = preview.map(r => `
        <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/50">
            <td class="px-3 py-2 text-center text-gray-400">${r.no ?? '—'}</td>
            <td class="px-3 py-2 font-mono text-xs">${r.tanggal || '—'}</td>
            <td class="px-3 py-2 font-bold text-kai-blue dark:text-blue-400 font-mono">${r.id_aset}</td>
            <td class="px-3 py-2">${r.kode_alat || '—'}</td>
            <td class="px-3 py-2">${r.id_lokasi_asal || r.id_lokasi || '—'}</td>
            <td class="px-3 py-2">${r.upt || r.id_pengguna || '—'}</td>
            <td class="px-3 py-2">${r.id_pengguna || '—'}</td>
            <td class="px-3 py-2 font-bold ${r.kondisi === 'SO' ? 'text-green-500' : r.kondisi === 'TSO' ? 'text-red-500' : 'text-blue-400'}">${r.kondisi || '—'}</td>
            <td class="px-3 py-2 text-gray-500 italic text-xs">${r.keterangan || '—'}</td>
        </tr>
    `).join('');
}

// Wire filter inputs to re-apply on change
['exp-date-from','exp-date-to','exp-filter-lokasi','exp-filter-kondisi'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', applyExportFilters);
});

// ── EXCEL EXPORT ──────────────────────────────────────────────────

document.getElementById('btn-export-excel')?.addEventListener('click', async () => {
    if (!window.XLSX) { showToast('Library Excel belum siap, tunggu sebentar.', 'warning'); return; }

    const btn = document.getElementById('btn-export-excel');
    const orig = btn.innerHTML;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Membuat file...`;
    btn.disabled  = true;

    try {
        const repairHeaders = ['No','Tanggal & Waktu','ID Aset','Kode Alat','Lokasi Asal','UPT','Petugas','Kondisi','Keterangan'];
        const mutasiHeaders = ['No','Tanggal & Waktu','ID Aset','Kode Alat','Lokasi Asal','Lokasi Tujuan','Dilakukan Oleh','Alasan'];

        function makeSheet(headers, rows, mapFn) {
            const data = [headers, ...rows.map(mapFn)];
            const ws = XLSX.utils.aoa_to_sheet(data);
            ws['!cols'] = headers.map(() => ({ wch: 22 }));
            const range = XLSX.utils.decode_range(ws['!ref']);
            for (let C = range.s.c; C <= range.e.c; C++) {
                const cell = ws[XLSX.utils.encode_cell({ r: 0, c: C })];
                if (cell) cell.s = { font: { bold: true } };
            }
            return ws;
        }

        const wb = XLSX.utils.book_new();

        // Tab 1: Riwayat Perbaikan
        XLSX.utils.book_append_sheet(wb,
            makeSheet(repairHeaders, [..._exportFiltered.active, ..._exportFiltered.afkir], r => [
                r.no ?? '', r.tanggal, r.id_aset, r.kode_alat,
                r.id_lokasi_asal || r.id_lokasi, r.upt || '—', r.id_pengguna,
                r.kondisi, r.keterangan
            ]),
            'Riwayat Perbaikan'
        );

        // Tab 2: Riwayat Mutasi
        const mutasiRes = await apiFetch('/export/mutasi');
        const mutasiData = mutasiRes.ok ? await mutasiRes.json() : [];
        XLSX.utils.book_append_sheet(wb,
            makeSheet(mutasiHeaders, mutasiData, (r, i) => [
                i + 1, r.tanggal, r.id_aset, r.kode_alat,
                r.lokasi_asal, r.lokasi_tuju, r.dilakukan_oleh, r.alasan || '—'
            ]),
            'Riwayat Mutasi'
        );

        const dateStr = new Date().toISOString().slice(0, 10);
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
    if (!window.jspdf) { showToast('Library PDF belum siap, tunggu sebentar.', 'warning'); return; }

    const btn = document.getElementById('btn-export-pdf');
    const orig = btn.innerHTML;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Membuat PDF...`;
    btn.disabled  = true;

    try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        const dateStr = new Date().toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });

        const repairCols = ['No','Tanggal & Waktu','ID Aset','Kode Alat','Lokasi Asal','UPT','Petugas','Kondisi','Keterangan'];
        const mutasiCols = ['No','Tanggal & Waktu','ID Aset','Kode Alat','Lokasi Asal','Lokasi Tujuan','Dilakukan Oleh','Alasan'];

        const allRepair = [..._exportFiltered.active, ..._exportFiltered.afkir];

        // Page 1+: Perbaikan
        doc.setFontSize(13); doc.setFont('helvetica', 'bold');
        doc.text('SIMA-KAI — Laporan Riwayat Perbaikan Alat Kerja', 14, 14);
        doc.setFontSize(9); doc.setFont('helvetica', 'normal');
        doc.text(`Dicetak: ${dateStr}  |  Total: ${allRepair.length} baris`, 14, 20);

        doc.autoTable({
            head: [repairCols],
            body: allRepair.map(r => [
                r.no ?? '—', r.tanggal, r.id_aset, r.kode_alat,
                r.id_lokasi_asal || r.id_lokasi, r.upt || '—', r.id_pengguna,
                r.kondisi, r.keterangan
            ]),
            startY: 25,
            styles: { fontSize: 7, cellPadding: 2, overflow: 'linebreak' },
            headStyles: { fillColor: [22, 76, 129], textColor: 255, fontStyle: 'bold' },
            alternateRowStyles: { fillColor: [241, 245, 249] },
            didDrawCell: (data) => {
                if (data.section === 'body' && data.column.index === 7) {
                    const val = data.cell.raw;
                    doc.setTextColor(val === 'SO' ? 22 : val === 'TSO' ? 220 : 0,
                                     val === 'SO' ? 163 : val === 'TSO' ? 38  : 0,
                                     val === 'SO' ? 74  : val === 'TSO' ? 38  : 0);
                    doc.setFontSize(7);
                    doc.text(String(val), data.cell.x + 2, data.cell.y + 4);
                    doc.setTextColor(0, 0, 0);
                }
            }
        });

        // Next page: Mutasi
        const mutasiRes = await apiFetch('/export/mutasi');
        const mutasiData = mutasiRes.ok ? await mutasiRes.json() : [];

        doc.addPage();
        doc.setFontSize(13); doc.setFont('helvetica', 'bold');
        doc.text('SIMA-KAI — Laporan Riwayat Mutasi Aset', 14, 14);
        doc.setFontSize(9); doc.setFont('helvetica', 'normal');
        doc.text(`Dicetak: ${dateStr}  |  Total: ${mutasiData.length} baris`, 14, 20);

        doc.autoTable({
            head: [mutasiCols],
            body: mutasiData.map((r, i) => [
                i + 1, r.tanggal, r.id_aset, r.kode_alat,
                r.lokasi_asal, r.lokasi_tuju, r.dilakukan_oleh, r.alasan || '—'
            ]),
            startY: 25,
            styles: { fontSize: 7, cellPadding: 2, overflow: 'linebreak' },
            headStyles: { fillColor: [243, 134, 27], textColor: 255, fontStyle: 'bold' },
            alternateRowStyles: { fillColor: [255, 247, 237] },
        });

        const fileDate = new Date().toISOString().slice(0, 10);
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
    const item = db.find(x => x.id_aset === uid);
    if (!item) return;

    document.getElementById('mutasi-uid').value = uid;
    document.getElementById('mutasi-modal-subtitle').innerText = item.id_aset;
    document.getElementById('mutasi-lokasi-asal').textContent = item.id_lokasi;

    // Populate destination dropdown
    const tujuSel = document.getElementById('mutasi-lokasi-tuju');
    const options = _currentRole === 'ADMIN_WILAYAH'
        ? lokasiData.filter(l => l.code === (getJwtPayload(authToken)?.id_lokasi || ''))
        : lokasiData.filter(l => l.code !== item.id_lokasi);

    tujuSel.innerHTML = '<option value="">Pilih Lokasi Tujuan...</option>' +
        options.map(l => `<option value="${l.code}">${l.name}</option>`).join('');

    document.getElementById('mutasi-alasan').value = '';
    document.getElementById('mutasi-modal').classList.remove('hidden');
};

// ── QR MODAL ───────────────────────────────────────────────────────────────

function buildLandingUrl(uid) {
    const base = NGROK_BASE_URL
        ? NGROK_BASE_URL.replace(/\/$/, '')
        : window.location.origin;
    return `${base}/landing.html?uid=${encodeURIComponent(uid)}`;
}

function drawQrOnCanvas(text, targetCanvas) {
    return new Promise((resolve) => {
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

        const child = tmp.querySelector('canvas') || tmp.querySelector('img');

        if (!child) {
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
            copyAndClean(child);
        } else {
            if (child.complete && child.naturalWidth > 0) {
                copyAndClean(child);
            } else {
                child.onload  = () => copyAndClean(child);
                child.onerror = () => { document.body.removeChild(tmp); resolve(); };
            }
        }
    });
}

window.openQrModal = async (uid) => {
    const item = db.find(x => x.id_aset === uid);
    if (!item) return;

    _qrActiveItem = item;

    document.getElementById('qr-modal-subtitle').innerText = item.id_aset;
    document.getElementById('qr-label-kodeid').innerText   = item.id_aset;
    document.getElementById('qr-label-alat').innerText     = item.kode_alat;
    document.getElementById('qr-label-lokasi').innerText   = item.id_lokasi;

    const landingUrl = buildLandingUrl(uid);
    const linkEl     = document.getElementById('qr-landing-link');
    const linkText   = document.getElementById('qr-landing-link-text');
    if (linkEl && linkText) {
        linkText.textContent = landingUrl;
        linkEl.href          = landingUrl;
    }

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

async function downloadQrPng() {
    if (!_qrActiveItem) return;

    const btn = document.getElementById('btn-qr-download-png');
    const originalHtml = btn.innerHTML;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Memproses...`;
    btn.disabled  = true;

    try {
        if (!window.html2canvas) {
            await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js');
        }

        const labelEl = document.getElementById('qr-label-preview');
        const canvas  = await html2canvas(labelEl, {
            backgroundColor: '#ffffff',
            scale: 3, 
            useCORS: true,
            logging: false
        });

        const link = document.createElement('a');
        link.download = `QR_${_qrActiveItem.id_aset}.png`;
        link.href     = canvas.toDataURL('image/png');
        link.click();

        showToast(`PNG berhasil diunduh: QR_${_qrActiveItem.id_aset}.png`, 'success');
    } catch (err) {
        console.error(err);
        showToast("Gagal membuat PNG. Coba lagi.", 'error');
    } finally {
        btn.innerHTML = originalHtml;
        btn.disabled  = false;
    }
}

async function downloadQrPdf() {
    if (!_qrActiveItem) return;

    const btn = document.getElementById('btn-qr-download-pdf');
    const originalHtml = btn.innerHTML;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Membuka...`;
    btn.disabled  = true;

    try {
        const qrCanvas   = document.getElementById('qr-canvas');
        const qrDataUrl  = qrCanvas.toDataURL('image/png');

        const labelEl    = document.getElementById('qr-label-preview');
        const clone      = labelEl.cloneNode(true);

        const cloneCanvas = clone.querySelector('canvas');
        if (cloneCanvas) {
            const img    = document.createElement('img');
            img.src      = qrDataUrl;
            img.width    = 180;
            img.height   = 180;
            cloneCanvas.parentNode.replaceChild(img, cloneCanvas);
        }

        const printArea  = document.getElementById('qr-print-area');
        printArea.innerHTML = '';
        printArea.appendChild(clone);

        await new Promise(r => setTimeout(r, 150));
        window.print();

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
    toast.innerHTML = `
        <i class="fas ${iconClass} text-xl shrink-0"></i>
        <span class="flex-1 text-sm">${message}</span>
        <button class="toast-dismiss shrink-0 ml-1 w-5 h-5 flex items-center justify-center rounded-full hover:bg-white/20 transition text-white/80 hover:text-white">
            <i class="fas fa-times text-base"></i>
        </button>`;

    const dismiss = () => {
        toast.classList.add('opacity-0', 'translate-y-4', 'sm:translate-x-full');
        setTimeout(() => toast.remove(), 300);
    };

    toast.querySelector('.toast-dismiss').addEventListener('click', dismiss);

    container.appendChild(toast);

    requestAnimationFrame(() => {
        setTimeout(() => toast.classList.remove('opacity-0', 'translate-y-4', 'sm:translate-x-full'), 10);
    });

    const autoHide = setTimeout(dismiss, 4000);
    toast.querySelector('.toast-dismiss').addEventListener('click', () => clearTimeout(autoHide));
}

function customConfirm(message) {
    return new Promise((resolve) => {
        const modal     = document.getElementById('confirm-modal');
        if (!modal) return resolve(window.confirm(message));

        const cancelBtn = document.getElementById('confirm-cancel');
        const okBtn     = document.getElementById('confirm-ok');

        document.getElementById('confirm-message').innerText = message;
        modal.classList.remove('hidden');

        function finish(result) {
            modal.classList.add('hidden');
            cancelBtn.onclick = null;
            okBtn.onclick     = null;
            resolve(result);
        }

        cancelBtn.onclick = () => finish(false);
        okBtn.onclick     = () => finish(true);
    });
}

// ── AFKIR / PULIHKAN ──────────────────────────────────────────────────────

let _afkirDb = [];

async function loadAfkirCards() {
    const container = document.getElementById('afkir-cards-container');
    if (!container) return;
    container.innerHTML = `<div class="col-span-3 text-center text-gray-400 py-14"><i class="fas fa-spinner fa-spin text-2xl"></i></div>`;
    try {
        const res = await apiFetch('/aset/afkir');
        if (!res.ok) throw new Error();
        _afkirDb = await res.json();
        renderAfkirCards();
    } catch {
        container.innerHTML = `<div class="col-span-3 text-center text-red-400 py-14 text-sm">Gagal memuat data aset afkir.</div>`;
    }
}

function renderAfkirCards() {
    const container = document.getElementById('afkir-cards-container');
    if (!container) return;
    const q = (document.getElementById('search-afkir')?.value || '').toLowerCase();
    const filtered = _afkirDb.filter(item =>
        (item.id_aset || '').toLowerCase().includes(q) ||
        (item.kode_alat || '').toLowerCase().includes(q)
    );
    if (!filtered.length) {
        container.innerHTML = `<div class="col-span-3 text-center text-gray-400 py-14">
            <i class="fas fa-recycle text-4xl mb-3 block"></i>
            <p class="text-sm">Tidak ada aset afkir${q ? ' yang cocok dengan pencarian' : ''}.</p></div>`;
        return;
    }
    container.innerHTML = filtered.map(item => `
        <div class="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 shadow-sm p-5 flex flex-col hover:shadow-md transition-shadow">
            <div class="flex justify-between items-start mb-3 pb-3 border-b border-gray-50 dark:border-gray-700/60">
                <span class="text-[10px] font-mono text-gray-400">${item.id_aset}</span>
                <span class="text-[10px] font-bold px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">AFKIR</span>
            </div>
            <h3 class="text-sm font-bold font-mono text-gray-600 dark:text-gray-300 break-words">${item.id_aset}</h3>
            <p class="text-xs text-gray-500 mt-1">${item.kode_alat || '—'} — ${item.id_lokasi || '—'}</p>
            <p class="text-xs text-gray-400 mt-1"><i class="fas fa-clock mr-1"></i>${item.waktu_update ? formatUtcToLocal(item.waktu_update) : 'Tanggal tidak tersedia'}</p>
            <div class="mt-4">
                <button onclick="window.openPulihkanModal('${item.id_aset}')"
                    class="w-full bg-orange-600 hover:bg-orange-700 active:bg-orange-800 text-white py-2.5 rounded-lg text-sm font-semibold transition flex items-center justify-center gap-2">
                    <i class="fas fa-wrench"></i> Proses Lebih Lanjut
                </button>
            </div>
        </div>`).join('');
}

document.getElementById('search-afkir')?.addEventListener('input', renderAfkirCards);

window.openPulihkanModal = (uid) => {
    document.getElementById('pulihkan-uid').value = uid;
    document.getElementById('pulihkan-modal-subtitle').innerText = uid;
    document.getElementById('pulihkan-modal').classList.remove('hidden');
};

document.getElementById('close-pulihkan-modal')?.addEventListener('click', () => {
    document.getElementById('pulihkan-modal').classList.add('hidden');
});
document.getElementById('pulihkan-modal')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('pulihkan-modal'))
        document.getElementById('pulihkan-modal').classList.add('hidden');
});
document.getElementById('pulihkan-cancel-btn')?.addEventListener('click', () => {
    document.getElementById('pulihkan-modal').classList.add('hidden');
});

document.getElementById('pulihkan-confirm-btn')?.addEventListener('click', async () => {
    const uid = document.getElementById('pulihkan-uid').value;
    document.getElementById('pulihkan-modal').classList.add('hidden');
    try {
        const res = await apiFetch(`/aset/pulihkan/${uid}`, { method: 'POST' });
        if (!res.ok) throw new Error((await res.json()).detail || 'Gagal memulihkan aset.');
        showToast(`Aset ${uid} berhasil dipulihkan.`, 'success');
        await loadAfkirCards();
        await fetchAsetFromServer();
    } catch (err) { showToast(err.message, 'error'); }
});

document.getElementById('pulihkan-delete-btn')?.addEventListener('click', async () => {
    const uid = document.getElementById('pulihkan-uid').value;
    document.getElementById('pulihkan-modal').classList.add('hidden');
    const confirmed = await customConfirm(
        `Hapus permanen aset "${uid}"?\n\nTindakan ini TIDAK DAPAT DIBATALKAN. Seluruh riwayat aset ini akan hilang dari sistem.`
    );
    if (!confirmed) return;
    try {
        const res = await apiFetch(`/aset/${uid}`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).detail || 'Gagal menghapus aset.');
        showToast(`Aset ${uid} telah dihapus permanen.`, 'success');
        await loadAfkirCards();
        await fetchAsetFromServer();
    } catch (err) { showToast(err.message, 'error'); }
});

function formatUtcToLocal(utcStr) {
    if (!utcStr) return '—';
    const date = new Date(utcStr.replace(' ', 'T'));
    if (isNaN(date)) return utcStr; 

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