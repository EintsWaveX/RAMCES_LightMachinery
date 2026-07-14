// --- CONSTANTS & STATE ---
const API_BASE_URL = '/api';

// ── SERVER CONFIG ─────────────────────────────────────────────────────────
// Set to your ngrok URL when tunneling, or null to use window.location.host.
// When using Live Server for frontend dev, set this to 'localhost:8000' so
// WebSocket and API calls always reach uvicorn regardless of which port
// the page is served from.
const NGROK_BASE_URL = 'https://ac9b-114-10-146-213.ngrok-free.app';
const BACKEND_WS_HOST = NGROK_BASE_URL
    ? NGROK_BASE_URL.replace(/^https?:\/\//, '')
    : 'localhost:8000'; 
// ── SERVER CONFIG ─────────────────────────────────────────────────────────
// Set to your ngrok URL when tunneling, or null to use window.location.host.
// When using Live Server for frontend dev, set this to 'localhost:8000' so
// WebSocket and API calls always reach uvicorn regardless of which port
// the page is served from.

const alatKerjaData = [
    { name: 'GENSET', code: 'GEN' }, { name: 'PORTABLE BALLAST TAMPER', code: 'PBT' },
    { name: 'MESIN BOR', code: 'BOR' }, { name: 'IMPACT WRENCH', code: 'IMP' },
    { name: 'RAIL GRINDING MACHINE', code: 'RGM' }, { name: 'TRACK GEOMTERY TROLLEY', code: 'TGT' },
    { name: 'ULTRASONIC MEASUREMENT', code: 'USM' }, { name: 'RAIL FLAW DETECTOR', code: 'RFD' },
    { name: 'TRACK GAUGE', code: 'TRG' }
];

const lokasiData = [
    { name: 'DAOP 1 JAKARTA', code: 'D1' }, { name: 'DAOP 2 BANDUNG', code: 'D2' },
    { name: 'DAOP 3 CIREBON', code: 'D3' }, { name: 'DAOP 4 SEMARANG', code: 'D4' },
    { name: 'DAOP 5 PURWOKERTO', code: 'D5' }, { name: 'DAOP 6 YOGYAKARTA', code: 'D6' },
    { name: 'DAOP 7 MADIUN', code: 'D7' }, { name: 'DAOP 8 SURABAYA', code: 'D8' },
    { name: 'DAOP 9 JEMBER', code: 'D9' }, { name: 'DIVRE I SUMATERA UTARA', code: 'VI' },
    { name: 'DIVRE II SUMATERA BARAT', code: 'VII' }, { name: 'DIVRE III PALEMBANG', code: 'VIII' },
    { name: 'DIVRE IV TANJUNGKARANG', code: 'VIV' }, { name: 'BALAIYASA CIREBONPRUNJAKAN', code: 'BY1' },
    { name: 'BALAIYASA PRABUMULIH', code: 'BY2' }, { name: 'BALAIYASA KIARACONDONG', code: 'BY3' }
];

const uptDatabase = [
    {"upt":"JR 1.1 Jakartakota","lokasi":"D1"},{"upt":"JR 1.2 Tanjungpriuk","lokasi":"D1"},{"upt":"JR 1.3 Pasarsenen","lokasi":"D1"},{"upt":"JR 1.4 Manggarai","lokasi":"D1"},{"upt":"JR 1.5 Tanahabang","lokasi":"D1"},{"upt":"JR 1.6 Duri","lokasi":"D1"},{"upt":"JR 1.7 Tangerang","lokasi":"D1"},{"upt":"JR 1.8 Jatinegara","lokasi":"D1"},{"upt":"JR 1.9 Bekasi","lokasi":"D1"},{"upt":"JR 1.10 Cikarang","lokasi":"D1"},{"upt":"JR 1.11 Lemahabang","lokasi":"D1"},{"upt":"JR 1.12 Karawang","lokasi":"D1"},{"upt":"JR 1.13 Cikampek","lokasi":"D1"},{"upt":"JR 1.14 Pasarminggu","lokasi":"D1"},{"upt":"JR 1.15 Depok","lokasi":"D1"},{"upt":"JR 1.16 Citayam","lokasi":"D1"},{"upt":"JR 1.17 Bogor","lokasi":"D1"},{"upt":"JR 1.18 Cigombong","lokasi":"D1"},{"upt":"JR 1.19 Sukabumi","lokasi":"D1"},{"upt":"JR 1.20 Kebayoran","lokasi":"D1"},{"upt":"JR 1.21 Parungpanjang","lokasi":"D1"},{"upt":"JR 1.22 Tigaraksa","lokasi":"D1"},{"upt":"JR 1.23 Rangkasbitung","lokasi":"D1"},{"upt":"JR 1.24 Catang","lokasi":"D1"},{"upt":"JR 1.25 Cilegon","lokasi":"D1"},
    {"upt":"JR 2.1 Cibungur","lokasi":"D2"},{"upt":"JR 2.2 Purwakarta","lokasi":"D2"},{"upt":"JR 2.3 Rendeh","lokasi":"D2"},{"upt":"JR 2.4 Padalarang","lokasi":"D2"},{"upt":"JR 2.5 Cibeber","lokasi":"D2"},{"upt":"JR 2.6 Cianjur","lokasi":"D2"},{"upt":"JR 2.7 Bandung","lokasi":"D2"},{"upt":"JR 2.8 Kiaracondong","lokasi":"D2"},{"upt":"JR 2.9 Cicalengka","lokasi":"D2"},{"upt":"JR 2.10 Cibatu","lokasi":"D2"},{"upt":"JR 2.11 Ciawi","lokasi":"D2"},{"upt":"JR 2.12 Tasikmalaya","lokasi":"D2"},{"upt":"JR 2.13 Banjar","lokasi":"D2"},
    {"upt":"JR 3.1 Pabuaran","lokasi":"D3"},{"upt":"JR 3.2 Pasirbungur","lokasi":"D3"},{"upt":"JR 3.3 Pegadenbaru","lokasi":"D3"},{"upt":"JR 3.4 Haurgeulis","lokasi":"D3"},{"upt":"JR 3.5 Terisi","lokasi":"D3"},{"upt":"JR 3.6 Jatibarang","lokasi":"D3"},{"upt":"JR 3.7 Arjawinangun","lokasi":"D3"},{"upt":"JR 3.8 Cirebon","lokasi":"D3"},{"upt":"JR 3.9 Cirebonprujakan","lokasi":"D3"},{"upt":"JR 3.10 Babakan","lokasi":"D3"},{"upt":"JR 3.11 Tanjung","lokasi":"D3"},{"upt":"JR 3.12 Bulakamba","lokasi":"D3"},{"upt":"JR 3.13 Brebes","lokasi":"D3"},{"upt":"JR 3.14 Sindanglaut","lokasi":"D3"},{"upt":"JR 3.15 Ciledug","lokasi":"D3"},{"upt":"JR 3.16 Ketanggungan","lokasi":"D3"},{"upt":"JR 3.17 Songgom","lokasi":"D3"},
    {"upt":"JR 4.1 Tegal","lokasi":"D4"},{"upt":"JR 4.2 Pemalang","lokasi":"D4"},{"upt":"JR 4.3 Petarukan","lokasi":"D4"},{"upt":"JR 4.4 Pekalongan","lokasi":"D4"},{"upt":"JR 4.5 Batang","lokasi":"D4"},{"upt":"JR 4.6 Kuripan","lokasi":"D4"},{"upt":"JR 4.7 Weleri","lokasi":"D4"},{"upt":"JR 4.8 Kalibodri","lokasi":"D4"},{"upt":"JR 4.9 Kaliwungu","lokasi":"D4"},{"upt":"JR 4.10 Semarangponcol","lokasi":"D4"},{"upt":"JR 4.11 Brumbung","lokasi":"D4"},{"upt":"JR 4.12 Gubug","lokasi":"D4"},{"upt":"JR 4.13 Karangjati","lokasi":"D4"},{"upt":"JR 4.14 Gambringan","lokasi":"D4"},{"upt":"JR 4.15 Penunggalan","lokasi":"D4"},{"upt":"JR 4.16 Kradenan","lokasi":"D4"},{"upt":"JR 4.17 Doplang","lokasi":"D4"},{"upt":"JR 4.18 Randublatung","lokasi":"D4"},{"upt":"JR 4.19 Cepu","lokasi":"D4"},{"upt":"JR 4.20 Kedungjati","lokasi":"D4"},{"upt":"JR 4.21 Gundih","lokasi":"D4"},{"upt":"JR 4.22 Ambarawa","lokasi":"D4"},
    {"upt":"JR 5.1 Slawi","lokasi":"D5"},{"upt":"JR 5.2 Prupuk","lokasi":"D5"},{"upt":"JR 5.3 Bumiayu","lokasi":"D5"},{"upt":"JR 5.4 Legok","lokasi":"D5"},{"upt":"JR 5.5 Purwokerto","lokasi":"D5"},{"upt":"JR 5.6 Kebasen","lokasi":"D5"},{"upt":"JR 5.7 Langen","lokasi":"D5"},{"upt":"JR 5.8 Jeruk Legi","lokasi":"D5"},{"upt":"JR 5.9 Cilacap","lokasi":"D5"},{"upt":"JR 5.10 Kroya","lokasi":"D5"},{"upt":"JR 5.11 Tambak","lokasi":"D5"},{"upt":"JR 5.12 Gombong","lokasi":"D5"},{"upt":"JR 5.13 Kebumen","lokasi":"D5"},{"upt":"JR 5.14 Kutoarjo","lokasi":"D5"},
    {"upt":"JR 6.1 Jenar","lokasi":"D6"},{"upt":"JR 6.2 Wojo","lokasi":"D6"},{"upt":"JR 6.3 Wates","lokasi":"D6"},{"upt":"JR 6.4 Yogyakarta","lokasi":"D6"},{"upt":"JR 6.5 Brambanan","lokasi":"D6"},{"upt":"JR 6.6 Klaten","lokasi":"D6"},{"upt":"JR 6.7 Delanggu","lokasi":"D6"},{"upt":"JR 6.8 Solobalapan","lokasi":"D6"},{"upt":"JR 6.9 Wonogiri","lokasi":"D6"},{"upt":"JR 6.10 Sumberlawang","lokasi":"D6"},{"upt":"JR 6.11 Palur","lokasi":"D6"},{"upt":"JR 6.12 Sragen","lokasi":"D6"},{"upt":"JR 6.13 Kebonromo","lokasi":"D6"},
    {"upt":"JR 7.1 Sumobito","lokasi":"D7"},{"upt":"JR 7.2 Jombang","lokasi":"D7"},{"upt":"JR 7.3 Kertosono","lokasi":"D7"},{"upt":"JR 7.4 Nganjuk","lokasi":"D7"},{"upt":"JR 7.5 Bagor","lokasi":"D7"},{"upt":"JR 7.6 Caruban","lokasi":"D7"},{"upt":"JR 7.7 Madiun","lokasi":"D7"},{"upt":"JR 7.8 Magetan","lokasi":"D7"},{"upt":"JR 7.9 Ngawi","lokasi":"D7"},{"upt":"JR 7.10 Walikukun","lokasi":"D7"},{"upt":"JR 7.11 Blitar","lokasi":"D7"},{"upt":"JR 7.12 Tulungagung","lokasi":"D7"},{"upt":"JR 7.13 Kediri","lokasi":"D7"},
    {"upt":"JR 8.1 Tobo","lokasi":"D8"},{"upt":"JR 8.2 Bojonegoro","lokasi":"D8"},{"upt":"JR 8.3 Sumberrejo","lokasi":"D8"},{"upt":"JR 8.4 Babat","lokasi":"D8"},{"upt":"JR 8.5 Sumlaran","lokasi":"D8"},{"upt":"JR 8.6 Lamongan","lokasi":"D8"},{"upt":"JR 8.7 Cerme","lokasi":"D8"},{"upt":"JR 8.8 Kandangan","lokasi":"D8"},{"upt":"JR 8.9 Surabayapasarturi","lokasi":"D8"},{"upt":"JR 8.10 Sidotopo","lokasi":"D8"},{"upt":"JR 8.11 Surabayagubeng","lokasi":"D8"},{"upt":"JR 8.12 Sepanjang","lokasi":"D8"},{"upt":"JR 8.13 Mojokerto","lokasi":"D8"},{"upt":"JR 8.14 Sidoarjo","lokasi":"D8"},{"upt":"JR 8.15 Bangil","lokasi":"D8"},{"upt":"JR 8.16 Lawang","lokasi":"D8"},{"upt":"JR 8.17 Malang","lokasi":"D8"},{"upt":"JR 8.18 Wlingi","lokasi":"D8"},
    {"upt":"JR 9.1 Pasuruan","lokasi":"D9"},{"upt":"JR 9.2 Probolinggo","lokasi":"D9"},{"upt":"JR 9.3 Klakah","lokasi":"D9"},{"upt":"JR 9.4 Tanggul","lokasi":"D9"},{"upt":"JR 9.5 Jember","lokasi":"D9"},{"upt":"JR 9.6 Kalisat","lokasi":"D9"},{"upt":"JR 9.7 Kalibaru","lokasi":"D9"},{"upt":"JR 9.8 Rogojampi","lokasi":"D9"},
    {"upt":"JR I.1 Medan","lokasi":"VI"},{"upt":"JR I.2 Ujungbaru","lokasi":"VI"},{"upt":"JR I.3 Araskabu","lokasi":"VI"},{"upt":"JR I.4 Perbaungan","lokasi":"VI"},{"upt":"JR I.5 Tebingtinggi","lokasi":"VI"},{"upt":"JR I.6 Siantar","lokasi":"VI"},{"upt":"JR I.7 Perlanaan","lokasi":"VI"},{"upt":"JR I.8 Seibejangkar","lokasi":"VI"},{"upt":"JR I.9 Kisaran","lokasi":"VI"},{"upt":"JR I.10 Telukdalam","lokasi":"VI"},{"upt":"JR I.11 Mambang Muda","lokasi":"VI"},{"upt":"JR I.12 Rantauprapat","lokasi":"VI"},{"upt":"JR I.13 Binjai","lokasi":"VI"},{"upt":"JR I.14 Stabat","lokasi":"VI"},{"upt":"JR I.15 Pangkalan Brandan","lokasi":"VI"},{"upt":"JR I.16 Tanjung Gading","lokasi":"VI"},{"upt":"JR I.17 Lhokseumawe","lokasi":"VI"},
    {"upt":"JR II.1 Padang","lokasi":"VII"},{"upt":"JR II.2 Lubuk Alung","lokasi":"VII"},
    {"upt":"JR III.1 Kertapati","lokasi":"VIII"},{"upt":"JR III.2 Simpang","lokasi":"VIII"},{"upt":"JR III.3 Payakabung","lokasi":"VIII"},{"upt":"JR III.4 Serdang","lokasi":"VIII"},{"upt":"JR III.5 Glumbang","lokasi":"VIII"},{"upt":"JR III.6 Lembak","lokasi":"VIII"},{"upt":"JR III.7 Prabumulih","lokasi":"VIII"},{"upt":"JR III.8 Prabumulih Baru","lokasi":"VIII"},{"upt":"JR III.9 Penimur","lokasi":"VIII"},{"upt":"JR III.10 Niru","lokasi":"VIII"},{"upt":"JR III.11 Blimbing Pendopo","lokasi":"VIII"},{"upt":"JR III.12 Gunung Megang","lokasi":"VIII"},{"upt":"JR III.13 Ujanmas","lokasi":"VIII"},{"upt":"JR III.14 Muaraenim","lokasi":"VIII"},{"upt":"JR III.15 Tanjungenim Baru","lokasi":"VIII"},{"upt":"JR III.16 Banjarsari","lokasi":"VIII"},{"upt":"JR III.17 Sukacinta","lokasi":"VIII"},{"upt":"JR III.18 Lahat","lokasi":"VIII"},{"upt":"JR III.19 Sukarame","lokasi":"VIII"},{"upt":"JR III.20 Saung Naga","lokasi":"VIII"},{"upt":"JR III.21 Tebingtinggi","lokasi":"VIII"},{"upt":"JR III.22 Lubuklinggau","lokasi":"VIII"},
    {"upt":"JR IV.1 Tanjungkarang","lokasi":"VIV"},{"upt":"JR IV.2 Rejosari","lokasi":"VIV"},{"upt":"JR IV.3 Bekri","lokasi":"VIV"},{"upt":"JR IV.4 Blambangan Pagar","lokasi":"VIV"},{"upt":"JR IV.5 Kotabumi","lokasi":"VIV"},{"upt":"JR IV.6 Ketapang","lokasi":"VIV"},{"upt":"JR IV.7 Negararatu","lokasi":"VIV"},{"upt":"JR IV.8 Tulungbuyut","lokasi":"VIV"},{"upt":"JR IV.9 Negeri Agung","lokasi":"VIV"},{"upt":"JR IV.10 Blambangan Umpu","lokasi":"VIV"},{"upt":"JR IV.11 Waytuba","lokasi":"VIV"},{"upt":"JR IV.12 Martapura","lokasi":"VIV"},{"upt":"JR IV.13 Sepancar","lokasi":"VIV"},{"upt":"JR IV.14 Baturaja","lokasi":"VIV"},{"upt":"JR IV.15 Blimbing Airkaka","lokasi":"VIV"},{"upt":"JR IV.16 Peninjawan","lokasi":"VIV"},{"upt":"JR IV.17 Pagergunung","lokasi":"VIV"},{"upt":"JR IV.18 Tanjungrambang","lokasi":"VIV"},
    {"upt":"BY Cirebonprunjakan","lokasi":"BY1"},
    {"upt":"BY Prabumulih","lokasi":"BY2"},
    {"upt":"BY Kiaracondong","lokasi":"BY3"}
];

let activeHistoryUid = null;
let currentUser = sessionStorage.getItem('activeUser');
let authToken = sessionStorage.getItem('authToken');
let db = [];

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
    populateSelects();
    setupEventListeners();

    if (currentUser && authToken) {
        checkAuth();
        await fetchAsetFromServer();
    } else {
        forceLogout(false);
    }
});

// --- LOGIKA AUTENTIKASI ---
function checkAuth() {
    if (currentUser && authToken) {
        const payload = getJwtPayload(authToken);
        const role = payload ? payload.role : 'TEKNISI';

        document.getElementById('auth-view').classList.add('hidden');
        document.getElementById('main-app').classList.remove('hidden');
        document.getElementById('current-username').innerText = currentUser;

        setupWebSocket();

        if (role === 'SUPER_ADMIN' || role === 'ADMIN_DAOP') {
            const navAdmin = document.getElementById('nav-user-management');
            if (navAdmin) navAdmin.classList.remove('hidden');
            const optAdmin = document.getElementById('opt-admin-daop');
            if (role === 'ADMIN_DAOP' && optAdmin) optAdmin.disabled = true;
        }

        if (role === 'TEKNISI') {
            const viewInput = document.getElementById('view-input');
            if (viewInput) {
                viewInput.innerHTML = `
                    <div class="flex flex-col items-center justify-center h-96 text-center space-y-4">
                        <div class="p-6 bg-red-100 dark:bg-red-900/30 rounded-full">
                            <i class="fas fa-ban text-6xl text-red-400 dark:text-red-500"></i>
                        </div>
                        <h2 class="text-2xl font-bold text-gray-700 dark:text-gray-300">Akses Dibatasi</h2>
                        <p class="text-gray-500 dark:text-gray-400 max-w-sm">
                            Halaman ini hanya dapat diakses oleh <span class="font-semibold text-red-500">Admin</span>.<br>
                            Silakan hubungi admin wilayah Anda untuk input data alat kerja baru.
                        </p>
                        <span class="px-4 py-1 bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded-full text-sm font-mono">
                            Role: TEKNISI
                        </span>
                    </div>
                `;
            }
        }

        const welcomeMsg = document.getElementById('welcome-message');
        if (welcomeMsg) welcomeMsg.innerText = `Selamat Datang, ${currentUser}`;

        switchView('dashboard');
    } else {
        document.getElementById('auth-view').classList.remove('auth-preload');
        document.getElementById('main-app').classList.add('hidden');
    }
}

async function handleLogin() {
    const user = document.getElementById('login-username').value.trim();
    const pass = document.getElementById('login-password').value.trim();

    if (!user || !pass) {
        showToast("Username atau password tidak boleh kosong!", "warning");
        return;
    }

    try {
        const formData = new URLSearchParams();
        formData.append('username', user);
        formData.append('password', pass);

        const response = await fetch(`${API_BASE_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formData
        });

        if (!response.ok) {
            const err = await response.json();
            let errorMessage = "Login gagal.";
            if (Array.isArray(err.detail)) {
                errorMessage = err.detail.map(e => e.msg).join(', ');
            } else if (err.detail) {
                errorMessage = err.detail;
            }
            throw new Error(errorMessage);
        }

        const data = await response.json();

        currentUser = user;
        authToken = data.access_token;
        sessionStorage.setItem('activeUser', user);
        sessionStorage.setItem('authToken', authToken);

        showToast(`Berhasil login sebagai ${user}`, 'success');

        document.getElementById('login-username').value = '';
        document.getElementById('login-password').value = '';

        checkAuth();
        setupWebSocket();
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
    const p = document.getElementById('login-password');
    if (u) u.value = '';
    if (p) p.value = '';

    activeHistoryUid = null;

    const navAdmin = document.getElementById('nav-user-management');
    if (navAdmin) navAdmin.classList.add('hidden');

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
    document.getElementById('btn-login')?.addEventListener('click', handleLogin);
    const triggerEnter = (e) => { if (e.key === 'Enter') handleLogin(); };
    document.getElementById('login-username')?.addEventListener('keypress', triggerEnter);
    document.getElementById('login-password')?.addEventListener('keypress', triggerEnter);

    // Sidebar & Theme
    document.getElementById('open-sidebar-btn')?.addEventListener('click', toggleSidebar);
    document.getElementById('close-sidebar-btn')?.addEventListener('click', toggleSidebar);
    document.getElementById('theme-toggle-btn')?.addEventListener('click', () => {
        const html = document.documentElement;
        html.classList.toggle('dark');
        localStorage.setItem('theme', html.classList.contains('dark') ? 'dark' : 'light');
    });
    document.getElementById('logout-btn')?.addEventListener('click', () => forceLogout(true));

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

    document.getElementById('form-register-user')?.addEventListener('submit', async function(e) {
        e.preventDefault();

        const payload = {
            username:        document.getElementById('reg-username').value.trim(),
            password:        document.getElementById('reg-password').value.trim(),
            role:            document.getElementById('reg-role').value,
            assigned_region: document.getElementById('reg-region').value
        };

        try {
            const response = await apiFetch('/users/create', { method: 'POST', body: JSON.stringify(payload) });
            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.detail || "Gagal membuat user");
            }
            showToast(`User ${payload.username} berhasil didaftarkan!`, 'success');
            this.reset();
        } catch (error) {
            if (error.message !== "Unauthorized") showToast(error.message, 'error');
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
}

// ── WEBSOCKET ──────────────────────────────────────────────────────────────

function setupWebSocket() {
    if (window._wsHeartbeat) clearInterval(window._wsHeartbeat);

    const protocol = NGROK_BASE_URL ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${BACKEND_WS_HOST}/ws/updates`);

    ws.onopen = () => {
        console.log("WebSocket connected.");
        window._wsHeartbeat = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send("ping");
        }, 25000);
    };

    ws.onmessage = (event) => {
        if (event.data === "REFRESH_ASSET_LIST") fetchAsetFromServer();
    };

    ws.onclose = () => {
        console.log("WebSocket closed. Retrying in 3s...");
        clearInterval(window._wsHeartbeat);
        setTimeout(setupWebSocket, 3000);
    };

    ws.onerror = () => ws.close();

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
                    <td class="p-3">${h.date}</td>
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
                    <button onclick="window.openQrModal('${item.uid}')"
                        class="flex-1 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 py-2 rounded font-bold hover:bg-gray-200 dark:hover:bg-gray-600 transition text-sm">
                        <i class="fas fa-qrcode"></i> QR LABEL
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