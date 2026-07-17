// --- CONSTANTS & STATE ---
const API_BASE_URL = '/api';

// ── SERVER CONFIG ─────────────────────────────────────────────────────────
let NGROK_BASE_URL  = '';
let BACKEND_WS_HOST = '';

// These are now fetched from the DB on login — see fetchMasterData()
let alatKerjaData = [];
let lokasiData    = [];
let uptDatabase   = [];

let _wsNgrokFailed = false;
let _wsRetryCount = 0;

let db = [];

let activeHistoryUid = null;
let currentUser = sessionStorage.getItem('activeUser');
let authToken = sessionStorage.getItem('authToken');

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

    document.getElementById('login-username')?.addEventListener('blur', async () => {
        const username = document.getElementById('login-username').value.trim();
        if (!username) return;

        try {
            const res = await fetch('/api/master/lokasi');
            // If fetch ok, check if user exists by attempting a peek
            // We show extra fields preemptively — server decides on submit
            document.getElementById('login-extra-fields').classList.remove('hidden');
        } catch(e) {
            // silently ignore
        }
    });

    if (currentUser && authToken) {
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
        if (uptRes.ok)    uptDatabase   = (await uptRes.json()).map(u => ({ upt: u.nama_upt,     lokasi: u.kode_lokasi }));

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

        document.getElementById('auth-view').classList.add('hidden');
        document.getElementById('main-app').classList.remove('hidden');
        document.getElementById('current-username').innerText = currentUser;

        if (role === 'TEKNISI') {
            const navInput = document.getElementById('nav-input');
            if (navInput) navInput.classList.add('hidden');
        }

        const welcomeMsg = document.getElementById('welcome-message');
        if (welcomeMsg) welcomeMsg.innerText = `Selamat Datang, ${currentUser}`;

        switchView('dashboard');

        await fetchMasterData(); // fetch before setupWebSocket so selects are ready
        setupWebSocket();
        await fetchAsetFromServer();
    } else {
        document.getElementById('main-app').classList.add('hidden');
    }
}

async function handleLogin() {
    const user   = document.getElementById('login-username').value.trim();
    const role   = document.getElementById('login-role')?.value   || 'TEKNISI';
    const region = document.getElementById('login-region')?.value || '';
    const regionText = document.getElementById('login-region')?.selectedOptions[0]?.text || region;
    const roleText   = document.getElementById('login-role')?.selectedOptions[0]?.text   || role;

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
                ? `Berhasil login sebagai ${user}!`
                : `Akun "${user}" berhasil dibuat & login!`,
            'success'
        );
        document.getElementById('login-username').value = '';
        document.getElementById('login-extra-fields').classList.add('hidden');

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

    document.getElementById('main-app').classList.add('hidden');

    const authView = document.getElementById('auth-view');
    authView.classList.remove('hidden');

    const u = document.getElementById('login-username');
    // const p = document.getElementById('login-password');
    if (u) u.value = '';
    // if (p) p.value = '';

    activeHistoryUid = null;

    // const navAdmin = document.getElementById('nav-user-management');
    // if (navAdmin) navAdmin.classList.add('hidden');

    if (window._wsHeartbeat) clearInterval(window._wsHeartbeat);
    if (window._ws && window._ws.readyState === WebSocket.OPEN) {
        window._ws.close();
    }
    window._ws = null;
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
        if (!document.getElementById('view-database').classList.contains('hidden')) renderDbCards();
        if (!document.getElementById('view-history').classList.contains('hidden')) renderHistoryCards();

        if (activeHistoryUid && !document.getElementById('view-history-detail').classList.contains('hidden')) {
            window.openHistoryDetail(activeHistoryUid);
        }
    } catch (error) {
        showToast("Koneksi ke server gagal", 'error');
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
    document.querySelectorAll('.view-section').forEach(el => el.classList.add('hidden'));

    const targetView = document.getElementById(`view-${viewId}`);
    if (targetView) targetView.classList.remove('hidden');

    document.querySelectorAll('.nav-btn').forEach(btn => {
        if (btn.dataset.target === viewId) btn.classList.add('bg-gray-200', 'dark:bg-gray-700');
        else btn.classList.remove('bg-gray-200', 'dark:bg-gray-700');
    });

    if (viewId === 'database' || viewId === 'history') {
        fetchAsetFromServer();
    }
}

function setupEventListeners() {
    // Navigasi Sidebar
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => switchView(btn.dataset.target));
    });

    // Auth
    // Disable region selector for SUPER_ADMIN role
    document.getElementById('btn-login')?.addEventListener('click', handleLogin);
    const triggerEnter = (e) => { if (e.key === 'Enter') handleLogin(); };
    document.getElementById('login-username')?.addEventListener('keypress', triggerEnter);
    // document.getElementById('login-password')?.addEventListener('keypress', triggerEnter);
    document.getElementById('login-role')?.addEventListener('change', (e) => {
        const regionSel = document.getElementById('login-region');
        if (!regionSel) return;
        if (e.target.value === 'SUPER_ADMIN') {
            regionSel.disabled = true;
            regionSel.innerHTML = '<option value="">Semua Region</option>';
        } else {
            regionSel.disabled = false;
            // Re-populate from lokasiData since it may have been cleared
            regionSel.innerHTML = lokasiData.map(l =>
                `<option value="${l.code}">${l.name}</option>`
            ).join('');
        }
    });

    // Sidebar & Theme
    document.getElementById('open-sidebar-btn')?.addEventListener('click', toggleSidebar);
    document.getElementById('close-sidebar-btn')?.addEventListener('click', toggleSidebar);
    document.getElementById('theme-toggle-btn')?.addEventListener('click', () => {
        const html = document.documentElement;
        html.classList.toggle('dark');
        localStorage.setItem('theme', html.classList.contains('dark') ? 'dark' : 'light');
    });
    document.getElementById('logout-btn')?.addEventListener('click', () => forceLogout(true));
    document.getElementById('delete-account-btn')?.addEventListener('click', async () => {
        const confirmed = await customConfirm(
            `Apakah Anda yakin ingin menghapus akun "${currentUser}"? Tindakan ini tidak dapat dibatalkan.`
        );
        if (!confirmed) return;

        // Second confirmation
        const reconfirmed = await customConfirm(
            `Konfirmasi terakhir: akun "${currentUser}" akan dihapus permanen dari sistem.`
        );
        if (!reconfirmed) return;

        try {
            const response = await apiFetch('/users/me', { method: 'DELETE' });
            if (!response.ok) throw new Error("Gagal menghapus akun.");
            showToast("Akun berhasil dihapus.", 'success');
            setTimeout(() => forceLogout(true), 1500);
        } catch (error) {
            showToast(error.message, 'error');
        }
    });

    // Search & Filter
    document.getElementById('search-db')?.addEventListener('input', renderDbCards);
    document.getElementById('search-history')?.addEventListener('input', renderHistoryCards);
    document.getElementById('filter-mode')?.addEventListener('change', renderDbCards);

    // Close buttons
    document.getElementById('close-edit-btn')?.addEventListener('click', () => switchView('database'));
    document.getElementById('close-hist-btn')?.addEventListener('click', () => {
        activeHistoryUid = null;
        switchView('history');
    });

    // Dynamic UPT select
    document.getElementById('edit-lokasi')?.addEventListener('change', (e) => {
        const locCode  = e.target.value;
        const uptSelect = document.getElementById('edit-upt');
        const matches  = uptDatabase.filter(u => u.lokasi === locCode);

        if (uptSelect) {
            if (matches.length > 0) {
                uptSelect.innerHTML = matches.map(m => `<option value="${m.upt}">${m.upt}</option>`).join('');
            } else {
                uptSelect.innerHTML = `<option value="Lainnya">Lainnya / Tidak ada data UPT</option>`;
            }
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
}

// ── WEBSOCKET ──────────────────────────────────────────────────────────────

function setupWebSocket() {
    if (window._wsHeartbeat) clearInterval(window._wsHeartbeat);

    const protocol = NGROK_BASE_URL ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${BACKEND_WS_HOST}/ws/updates`;
    const ws = new WebSocket(NGROK_BASE_URL ? `${wsUrl}?ngrok-skip-browser-warning=true` : wsUrl);

    ws.onopen = () => {
        console.log("WebSocket connected.");
        _wsRetryCount = 0; // ← ADD THIS LINE
        window._wsHeartbeat = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send("ping");
        }, 25000);
    };

    ws.onmessage = (event) => {
        if (event.data === "REFRESH_ASSET_LIST") fetchAsetFromServer();
    };

    ws.onclose = () => {
        console.log("WebSocket closed.");
        clearInterval(window._wsHeartbeat);
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

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
        sidebar.classList.toggle('-ml-64');
        sidebar.classList.toggle('absolute');
        sidebar.classList.toggle('z-50');
        sidebar.classList.toggle('h-full');
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

window.openHistoryDetail = async (uid) => {
    activeHistoryUid = uid;
    const item = db.find(x => x.uid === uid);
    if (!item) return;

    document.getElementById('hist-detail-subtitle').innerText = `${item.uid} | ${item.kode_id}`;
    const tbody = document.getElementById('hist-table-body');
    tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-gray-500"><i class="fas fa-spinner fa-spin mr-2"></i> Mengambil data dari server...</td></tr>`;

    switchView('history-detail');

    try {
        const response = await apiFetch(`/riwayat/${uid}`);
        if (!response.ok) throw new Error("Gagal mengambil riwayat dari database.");

        const history = await response.json();

        if (history.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-gray-500">Belum ada riwayat perbaikan untuk alat ini.</td></tr>`;
        } else {
            tbody.innerHTML = history.map(h => `
                <tr class="border-b dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td class="p-3">${h.no}</td>
                    <td class="p-3">${formatUtcToLocal(h.date)}</td>
                    <td class="p-3">${h.upt}</td>
                    <td class="p-3">${h.teknisi}</td>
                    <td class="p-3 font-bold ${h.kondisi === 'SO' ? 'text-green-500' : 'text-red-500'}">${h.kondisi}</td>
                    <td class="p-3 whitespace-pre-wrap">${h.keterangan}</td>
                </tr>
            `).join('');
        }
    } catch (error) {
        if (error.message !== "Unauthorized") {
            tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-red-500">Error memuat data: ${error.message}</td></tr>`;
        }
    }
};

function renderDbCards() {
    const container   = document.getElementById('db-cards-container');
    const searchInput = document.getElementById('search-db');
    const modeSelect  = document.getElementById('filter-mode');

    if (!container) return;

    const searchQ = searchInput ? searchInput.value.toLowerCase() : '';
    const mode    = modeSelect  ? modeSelect.value              : 'public';

    container.innerHTML = '';

    let filtered = db.filter(item => {
        const matchSearch = item.kode_id.toLowerCase().includes(searchQ) ||
                            item.uid.toLowerCase().includes(searchQ)     ||
                            item.alat.toLowerCase().includes(searchQ);

        const itemCreator  = (item.creator   || "").toLowerCase();
        const loggedInUser = (currentUser || "").toLowerCase();
        const matchMode    = (mode === 'public') ? true : (itemCreator === loggedInUser);

        return matchSearch && matchMode;
    });

    filtered.forEach(item => {
        const statusColor = item.status === 'SO'  ? 'text-green-500' :
                            item.status === 'TSO' ? 'text-red-500'   : 'text-blue-500';

        container.innerHTML += `
            <div class="bg-white dark:bg-gray-800 p-5 rounded-xl shadow border border-gray-200 dark:border-gray-700 flex flex-col justify-between">
                <div>
                    <div class="flex justify-between items-start mb-2">
                        <span class="text-xs font-bold bg-gray-200 dark:bg-gray-700 px-2 py-1 rounded">${item.uid}</span>
                        <span class="text-sm font-bold ${statusColor}"><i class="fas fa-circle text-xs mr-1"></i>${item.status}</span>
                    </div>
                    <h3 class="text-lg font-bold font-mono text-blue-600 dark:text-blue-400 break-words">${item.kode_id}</h3>
                    <p class="text-sm text-gray-600 dark:text-gray-400 mt-1">${item.alat} - ${item.lokasi}</p>
                </div>
                <div class="mt-4 flex gap-2">
                    <button onclick="window.openEdit('${item.uid}')"
                        class="flex-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 py-2 rounded font-bold hover:bg-blue-200 dark:hover:bg-blue-800 transition text-sm">
                        <i class="fas fa-edit"></i> UPDATE
                    </button>
                </div>
            </div>
        `;
    });
}

function renderHistoryCards() {
    const container   = document.getElementById('history-cards-container');
    const searchInput = document.getElementById('search-history');

    if (!container) return;

    const searchQ = searchInput ? searchInput.value.toLowerCase() : '';

    container.innerHTML = '';
    let filtered = db.filter(item =>
        item.kode_id.toLowerCase().includes(searchQ) ||
        item.uid.toLowerCase().includes(searchQ)
    );

    filtered.forEach(item => {
        container.innerHTML += `
            <div class="bg-white dark:bg-gray-800 p-5 rounded-xl shadow border border-gray-200 dark:border-gray-700">
                <div class="flex justify-between border-b dark:border-gray-700 pb-3 mb-3">
                    <div>
                        <p class="text-xs text-gray-500">UID: ${item.uid}</p>
                        <h3 class="text-lg font-bold font-mono text-purple-600 dark:text-purple-400">${item.kode_id}</h3>
                    </div>
                </div>
                <div class="grid grid-cols-2 gap-2 text-sm mb-4">
                    <div><span class="text-gray-500">Merk/Alat:</span> <br><b>${item.alat}</b></div>
                    <div><span class="text-gray-500">Status Terkini:</span> <br><b><span class="${item.status === 'SO' ? 'text-green-500' : 'text-red-500'} font-bold">${item.status}</span></b></div>
                </div>
                <button onclick="window.openHistoryDetail('${item.uid}')"
                    class="mt-4 w-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 py-2 rounded font-bold hover:bg-purple-200 dark:hover:bg-purple-800 transition">
                    <i class="fas fa-list"></i> VIEW HISTORY
                </button>
            </div>
        `;
    });
}

// ── MASTER DATA UI ─────────────────────────────────────────────────────────

// Tab switching
document.querySelectorAll('.master-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const target = tab.dataset.tab;

        // Update tab styles
        document.querySelectorAll('.master-tab').forEach(t => {
            t.classList.toggle('border-emerald-500', t.dataset.tab === target);
            t.classList.toggle('text-emerald-600',   t.dataset.tab === target);
            t.classList.toggle('dark:text-emerald-400', t.dataset.tab === target);
            t.classList.toggle('border-transparent',  t.dataset.tab !== target);
        });

        // Show correct panel
        document.querySelectorAll('.master-tab-panel').forEach(p => p.classList.add('hidden'));
        document.getElementById(`master-tab-${target}`)?.classList.remove('hidden');

        // Load data for the active tab
        if (target === 'alat')   loadMasterAlat();
        if (target === 'lokasi') loadMasterLokasi();
        if (target === 'upt')    loadMasterUpt();
    });
});

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

    toast.className = `${colorClass} text-white px-6 py-3 rounded-lg shadow-lg transform transition-all duration-300 translate-x-full opacity-0 flex items-center gap-3 font-semibold z-50 mb-2`;
    toast.innerHTML = `<i class="fas ${iconClass} text-xl"></i> <span>${message}</span>`;

    container.appendChild(toast);

    requestAnimationFrame(() => {
        setTimeout(() => toast.classList.remove('translate-x-full', 'opacity-0'), 10);
    });

    setTimeout(() => {
        toast.classList.add('translate-x-full', 'opacity-0');
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