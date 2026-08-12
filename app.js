// --- CONSTANTS & STATE ---
const API_BASE_URL = "/api";

// ── SERVER CONFIG ─────────────────────────────────────────────────────────
// Optional externally-reachable base URL (Tailscale Funnel / ngrok / reverse
// proxy). Only used to build QR/landing links when the page itself is being
// viewed on localhost — otherwise window.location.origin is already public.
let PUBLIC_BASE_URL = "";

// Data master disesuaikan dengan skema PostgreSQL
let alatKerjaData = [];
let lokasiData = [];
let uptDatabase = []; // Dipertahankan jika backend API masih membutuhkannya

let _currentRole = ""; // SUPER_ADMIN, ADMIN_WILAYAH, TEKNISI
let _wsNgrokFailed = false;
let _wsRetryCount = 0;

let db = []; // Menampung data tabel aset

let activeHistoryUid = null;
let currentUser = sessionStorage.getItem("activeUser");
let authToken = sessionStorage.getItem("authToken");

// Track the QR currently shown in the modal (for export)
let _qrActiveItem = null;

function applyUptSelect(locCode, uptSelectEl) {
  if (!uptSelectEl) return;
  const loc = lokasiData.find((l) => l.code === locCode);
  const isBalaiyasa = loc?.tipe?.toUpperCase() === "BALAIYASA";

  if (isBalaiyasa) {
    uptSelectEl.innerHTML = `<option value="">Belum ada UPT untuk lokasi Balaiyasa</option>`;
    uptSelectEl.disabled = true;
    return;
  }

  uptSelectEl.disabled = false;
  const matches = uptDatabase.filter((u) => u.lokasi === locCode);
  if (matches.length > 0) {
    uptSelectEl.innerHTML =
      '<option value="">Pilih UPT...</option>' +
      matches.map((m) => `<option value="${m.upt}">${m.nama || m.upt}</option>`).join("");
  } else {
    uptSelectEl.innerHTML = `<option value="">Tidak ada UPT untuk lokasi ini...</option>`;
    uptSelectEl.disabled = true;
  }
  uptSelectEl.value = "";
}

window.applyUptSelect = applyUptSelect;

(function () {
  const saved = localStorage.getItem("theme");
  if (saved === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
})();

// --- INISIALISASI UTAMA ---
document.addEventListener("DOMContentLoaded", async () => {
  await fetchConfig();
  populateSelects();
  setupEventListeners();
  fetchLoginRegions();

  if (currentUser && authToken) {
    document.getElementById("auth-view").style.display = "none";
    checkAuth();
  } else {
    forceLogout(false);
  }
});

async function fetchConfig() {
  beginLoading("Menghubungi server");
  try {
    const res = await fetch("/api/config");
    const data = await res.json();
    PUBLIC_BASE_URL = (data.public_url || data.ngrok_url || "").replace(
      /\/$/,
      "",
    );
  } catch (e) {
    PUBLIC_BASE_URL = "";
  } finally {
    endLoading();
  }
}

// Base URL for links that get scanned/opened on OTHER devices (QR codes).
// If this page is already served from a routable host, that host is correct;
// only fall back to the configured tunnel when we are on localhost.
function getPublicBaseUrl() {
  const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i.test(
    window.location.hostname,
  );
  if (!isLocal) return window.location.origin;
  return PUBLIC_BASE_URL || window.location.origin;
}

function getParentLokasiCode(idLokasi) {
  if (!idLokasi) return null;
  // "JR1.3" → "D1", "JR9.2" → "D9"
  const arabMatch = idLokasi.match(/^JR(\d+)\./i);
  if (arabMatch) return `D${arabMatch[1]}`;

  // "JRI.2" → "VI", "JRIII.1" → "VIII", "JRIV.1" → "VIV" etc.
  const romanMap = {
    I: "VI",
    II: "VII",
    III: "VIII",
    IV: "VIV",
    V: "VV",
    VI: "VVI",
    VII: "VVII",
    VIII: "VVIII",
    IX: "VIX",
  };
  const romanMatch = idLokasi.match(/^JR(IV|IX|VIII|VII|VI|V|I{1,3})\./i);
  if (romanMatch) return romanMap[romanMatch[1].toUpperCase()] ?? null;

  // "BY1A" → "BY1". Without this a Balaiyasa child resolves to null and gets
  // treated as its own parent, so region filters never match it.
  const balaiyasaMatch = idLokasi.match(/^(BY\d+)[A-Z]+$/i);
  if (balaiyasaMatch) return balaiyasaMatch[1].toUpperCase();

  return null;
}

async function fetchMasterData() {
  beginLoading("Memuat data master (alat kerja & lokasi)");
  try {
    const [alatRes, lokasiRes] = await Promise.all([
      fetch(`${API_BASE_URL}/master/alat`),
      fetch(`${API_BASE_URL}/master/lokasi`),
    ]);

    if (alatRes.ok) {
      alatKerjaData = (await alatRes.json()).map((a) => ({
        name: a.nama_alat,
        code: a.kode_alat,
      }));
    }

    if (lokasiRes.ok) {
      const allLokasi = await lokasiRes.json();

      // Regions: DAOP, DIVRE, PUSAT, BALAIYASA — top-level parent locations
      lokasiData = allLokasi
        .filter((l) => {
          const t = (l.tipe || "").toUpperCase();
          return (
            t === "DAOP" || t === "DIVRE" || t === "PUSAT" || t === "BALAIYASA"
          );
        })
        .map((l) => ({ name: l.nama_lokasi, code: l.id_lokasi, tipe: l.tipe }));

      // UPTs: everything else (JR*, or explicit tipe=UPT)
      const uptRaw = allLokasi.filter((l) => {
        const t = (l.tipe || "").toUpperCase();
        return (
          t !== "DAOP" && t !== "DIVRE" && t !== "PUSAT" && t !== "BALAIYASA"
        );
      });

      uptDatabase = uptRaw.map((u) => ({
        upt: u.id_lokasi,
        nama: u.nama_lokasi,
        lokasi: getParentLokasiCode(u.id_lokasi) || u.id_lokasi,
      }));

      // If no UPTs found, treat all regions as their own UPTs (flat fallback)
      if (!uptDatabase.length) {
        uptDatabase = lokasiData.map((l) => ({
          upt: l.code,
          nama: l.name,
          lokasi: l.code,
        }));
      }
    }

    populateSelects(true); // Preserve user selections after async load
  } catch (e) {
    showToast(
      "Gagal memuat data master. Beberapa dropdown mungkin kosong.",
      "warning",
    );
  } finally {
    endLoading();
  }
}

async function fetchLoginRegions() {
  beginLoading();
  try {
    const res = await fetch("/api/master/lokasi");
    if (!res.ok) return;
    const data = await res.json();
    const sel = document.getElementById("login-region");
    if (!sel) return;
    // Only show parent-level locations; exclude UPTs (JR* codes)
    const parentTypes = ["DAOP", "DIVRE", "PUSAT", "BALAIYASA"];
    const parents = data.filter((l) =>
      parentTypes.includes((l.tipe || "").toUpperCase()),
    );
    sel.innerHTML = parents
      .map((l) => `<option value="${l.id_lokasi}">${l.nama_lokasi}</option>`)
      .join("");
  } catch (e) {
    // master data not seeded yet
  } finally {
    endLoading();
  }
}

// --- LOGIKA AUTENTIKASI ---
async function checkAuth() {
  if (currentUser && authToken) {
    const payload = getJwtPayload(authToken);
    const role = payload ? payload.role : "TEKNISI";

    _currentRole = role;

    const filterModeEl = document.getElementById("filter-mode");
    if (filterModeEl)
      filterModeEl.style.display = role === "TEKNISI" ? "none" : "";

    document.getElementById("auth-view").classList.add("hidden");
    const mainApp = document.getElementById("main-app");
    if (mainApp) {
      mainApp.style.display = "flex";
      mainApp.classList.remove("hidden");
    }

    const topbarUsername = document.getElementById("topbar-username");
    const topbarRole = document.getElementById("topbar-role");
    if (topbarUsername) topbarUsername.innerText = currentUser;
    if (topbarRole) topbarRole.innerText = role.replace("_", " ");

    if (role === "SUPER_ADMIN") {
      const navMaster = document.getElementById("nav-masterdata");
      const navAfkir = document.getElementById("nav-afkir");
      const adminHelper = document.getElementById("admin-helper");
      if (navMaster) navMaster.classList.remove("hidden");
      if (navAfkir) navAfkir.classList.remove("hidden");
      if (adminHelper) adminHelper.classList.remove("hidden");
    }
    if (role === "TEKNISI") {
      const navInput = document.getElementById("nav-input");
      if (navInput) navInput.classList.add("hidden");
    }

    const welcomeMsg = document.getElementById("dashboard-welcome");
    if (welcomeMsg) welcomeMsg.innerText = `Selamat Datang, ${currentUser}`;

    switchView("dashboard");

    toggleSidebar();
    setupProfileModal();
    startTopbarClock();

    await fetchMasterData();
    setupWebSocket();
    await fetchAsetFromServer();
  } else {
    const mainAppEl = document.getElementById("main-app");
    if (mainAppEl) {
      mainAppEl.style.display = "none";
      mainAppEl.classList.add("hidden");
    }
  }
}

async function handleLogin() {
  const user = document.getElementById("login-username").value.trim();
  const role = document.getElementById("login-role")?.value || "TEKNISI";
  const region = document.getElementById("login-region")?.value || "";
  const regionText =
    document.getElementById("login-region")?.selectedOptions[0]?.text || region;
  const roleText =
    document.getElementById("auth-display-role")?.textContent || role;

  if (!user) {
    showToast("Username tidak boleh kosong!", "warning");
    return;
  }

  const confirmed = await customConfirm(
    `Masuk sebagai "${user}"?\nRole: ${roleText}\nRegion: ${regionText}`,
  );
  if (!confirmed) return;

  beginLoading("Memverifikasi akun");
  try {
    const response = await fetch(`${API_BASE_URL}/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
      },
      body: JSON.stringify({
        username: user,
        role: role,
        id_lokasi: region || null,
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.detail || "Login gagal.");
    }

    const data = await response.json();
    currentUser = user;
    authToken = data.access_token;
    sessionStorage.setItem("activeUser", user);
    sessionStorage.setItem("authToken", authToken);

    showToast(
      data.already_existed
        ? `Berhasil masuk sebagai ${user}!`
        : `Berhasil membuat akun dan masuk sebagai "${user}"!`,
      "success",
    );
    document.getElementById("login-username").value = "";
    document.getElementById("auth-step-1")?.classList.remove("hidden");
    document.getElementById("auth-step-2")?.classList.add("hidden");
    document.getElementById("auth-step-3")?.classList.add("hidden");
    if (document.getElementById("login-role"))
      document.getElementById("login-role").value = "";

    await checkAuth();
    fetchAsetFromServer();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    endLoading();
  }
}

function forceLogout(reloadPage = false) {
  currentUser = null;
  authToken = null;
  sessionStorage.removeItem("activeUser");
  sessionStorage.removeItem("authToken");
  resetLoading();
  stopPollingFallback();
  if (window._wsReconnectTimer) clearTimeout(window._wsReconnectTimer);
  if (window._wsHeartbeat) clearInterval(window._wsHeartbeat);
  try {
    window._ws?.close();
  } catch (_) {}

  if (reloadPage) {
    window.location.href = window.location.pathname;
    return;
  }

  const mainApp2 = document.getElementById("main-app");
  if (mainApp2) {
    mainApp2.style.display = "none";
    mainApp2.classList.add("hidden");
  }

  const authView = document.getElementById("auth-view");
  authView.classList.remove("hidden");

  const u = document.getElementById("login-username");
  if (u) u.value = "";

  document.getElementById("auth-step-1")?.classList.remove("hidden");
  document.getElementById("auth-step-2")?.classList.add("hidden");
  document.getElementById("auth-step-3")?.classList.add("hidden");
  document.getElementById("login-role") &&
    (document.getElementById("login-role").value = "");

  activeHistoryUid = null;

  if (window._wsHeartbeat) clearInterval(window._wsHeartbeat);
  if (window._ws && window._ws.readyState === WebSocket.OPEN) {
    window._ws.close();
  }
  window._ws = null;
}

// ── PROFILE MODAL ─────────────────────────────────────────────────────────

function getInitials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function updateWsDot(connected) {
  const color = connected ? "bg-green-500" : "bg-red-400";
  const label = connected ? "Server terhubung" : "Server terputus";
  ["ws-status-dot", "avatar-ws-dot", "profile-modal-ws-dot"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("bg-green-500", "bg-red-400", "bg-gray-300");
    el.classList.add(color);
  });
  const lbl = document.getElementById("ws-status-label");
  if (lbl) lbl.textContent = label;
}

function setupProfileModal() {
  const initials = getInitials(currentUser);
  const roleLabel = (_currentRole || "").replace("_", " ");

  ["topbar-avatar", "profile-modal-avatar"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = initials;
  });
  const pmUser = document.getElementById("profile-modal-username");
  const pmRole = document.getElementById("profile-modal-role");
  if (pmUser) pmUser.textContent = currentUser || "—";
  if (pmRole) pmRole.textContent = roleLabel;

  const delBtn = document.getElementById("profile-delete-btn");
  if (delBtn) {
    if (_currentRole === "SUPER_ADMIN") delBtn.classList.add("hidden");
    else delBtn.classList.remove("hidden");
  }
}

function openProfileModal() {
  setupProfileModal();
  document.getElementById("profile-modal")?.classList.remove("hidden");
}

function closeProfileModal() {
  document.getElementById("profile-modal")?.classList.add("hidden");
}

function startTopbarClock() {
  const bulan = [
    "Januari",
    "Februari",
    "Maret",
    "April",
    "Mei",
    "Juni",
    "Juli",
    "Agustus",
    "September",
    "Oktober",
    "November",
    "Desember",
  ];
  const hari = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
  function tick() {
    const now = new Date();
    const clockEl = document.getElementById("topbar-clock");
    const dateEl = document.getElementById("topbar-date");
    if (clockEl)
      clockEl.textContent =
        String(now.getHours()).padStart(2, "0") +
        ":" +
        String(now.getMinutes()).padStart(2, "0") +
        ":" +
        String(now.getSeconds()).padStart(2, "0");
    if (dateEl)
      dateEl.textContent = `${hari[now.getDay()]}, ${now.getDate()} ${bulan[now.getMonth()]} ${now.getFullYear()}`;
  }
  tick();
  setInterval(tick, 1000);
}

function getJwtPayload(token) {
  try {
    const base64Url = token.split(".")[1];
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split("")
        .map(function (c) {
          return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
        })
        .join(""),
    );
    return JSON.parse(jsonPayload);
  } catch (e) {
    return null;
  }
}

// ── GLOBAL LOADING OVERLAY ─────────────────────────────────────────────────
// A single request counter drives the blocking overlay: it appears when the
// first request goes out and disappears when the last one settles. The short
// delay keeps fast local calls from flashing it.
let _pendingRequests = 0;
let _loadingShowTimer = null;
const LOADING_SHOW_DELAY_MS = 200;

function _setLoadingVisible(visible) {
  const el = document.getElementById("global-loading-overlay");
  if (el) el.classList.toggle("hidden", !visible);
}

function beginLoading(detail) {
  _pendingRequests++;
  if (detail) {
    const d = document.getElementById("global-loading-detail");
    if (d) d.textContent = detail;
  }
  if (_pendingRequests === 1 && !_loadingShowTimer) {
    _loadingShowTimer = setTimeout(() => {
      _loadingShowTimer = null;
      if (_pendingRequests > 0) _setLoadingVisible(true);
    }, LOADING_SHOW_DELAY_MS);
  }
}

function endLoading() {
  _pendingRequests = Math.max(0, _pendingRequests - 1);
  if (_pendingRequests === 0) {
    if (_loadingShowTimer) {
      clearTimeout(_loadingShowTimer);
      _loadingShowTimer = null;
    }
    _setLoadingVisible(false);
  }
}

// Hard reset. The overlay blocks all interaction, so any path that abandons
// in-flight work (logout, session expiry) must clear the counter or the user is
// locked out of the UI with no way back.
function resetLoading() {
  _pendingRequests = 0;
  if (_loadingShowTimer) {
    clearTimeout(_loadingShowTimer);
    _loadingShowTimer = null;
  }
  _setLoadingVisible(false);
}

// Wraps any promise-returning call so it participates in the overlay counter.
async function withLoading(fn, detail) {
  beginLoading(detail);
  try {
    return await fn();
  } finally {
    endLoading();
  }
}

// --- FETCH API WRAPPER ---
// opts.background — skip the loading overlay (used by the polling fallback, so
// a periodic refresh doesn't blank the screen while the user is working).
async function apiFetch(endpoint, options = {}) {
  if (!authToken) throw new Error("Token tidak tersedia");

  const headers = {
    Authorization: `Bearer ${authToken}`,
    ...options.headers,
  };

  if (
    options.body !== undefined &&
    options.body !== null &&
    !(options.body instanceof URLSearchParams) &&
    !(options.body instanceof FormData)
  ) {
    headers["Content-Type"] = "application/json";
  }

  const { background, ...fetchOptions } = options;
  if (!background) beginLoading();
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...fetchOptions,
      headers,
    });
  } finally {
    if (!background) endLoading();
  }

  if (response.status === 401) {
    showToast("Sesi Anda telah habis. Silakan login kembali.", "warning");
    forceLogout(false);
    throw new Error("Unauthorized");
  }

  return response;
}

// --- KOMUNIKASI DATABASE ---
// opts.silent — suppress the failure toast (used by the background poller so a
// transient network blip doesn't spam the user).
async function fetchAsetFromServer(opts = {}) {
  try {
    const response = await apiFetch("/aset", { background: !!opts.silent });
    if (!response.ok) throw new Error("Gagal mengambil data aset");

    db = (await response.json()).map((a) => {
      // Defensive: ensure id_lokasi_raw is actually a code, not a name
      // A code is typically short (like "D1", "JR1.1"), a name is longer ("DAOP 1 Jakarta")
      const rawLokasi = a.id_lokasi || "";
      const isProbablyCode = rawLokasi.length <= 10 && !rawLokasi.includes(" ");

      // Cari blok ini di dalam fetchAsetFromServer() dan ganti menjadi:
      return {
        ...a,
        id_lokasi_raw: isProbablyCode
          ? rawLokasi
          : lokasiData.find((l) => l.name === rawLokasi)?.code ||
            uptDatabase.find((u) => u.nama === rawLokasi)?.upt ||
            rawLokasi,

        // Perbaikan: tangkap "lokasi_name" dari backend
        id_lokasi_display: a.lokasi_name || a.id_lokasi_name || rawLokasi,
        kode_alat_name: a.kode_alat_name || a.kode_alat,
      };
    });

    const isVisible = (id) =>
      !!document.getElementById(id)?.classList.contains("is-visible");

    updateDashboardStats();
    updateKdakStats();
    if (isVisible("view-input")) {
      renderKdakTable();
    }
    // Always refresh summary so badges are up to date everywhere
    loadHistorySummary().then(() => {
      if (isVisible("view-database")) {
        renderDbCards();
      }
      if (isVisible("view-history")) {
        if (_historyMode === "repair") renderHistoryCards();
        else if (_historyMode === "mutasi") renderMutasiCards();
        else if (_historyMode === "kalibrasi") renderKalibrasiCards();
      }
    });

    if (activeHistoryUid && isVisible("view-history-detail")) {
      window.openHistoryDetail(activeHistoryUid);
    }
  } catch (error) {
    if (!opts.silent) {
      showToast(
        "Koneksi ke server gagal! Mencoba menghubungkan kembali...",
        "error",
      );
    }
  }
}

// ── DASHBOARD STATE ────────────────────────────────────────────────────────
let _benchmarkPct = (() => {
  const raw = localStorage.getItem("dashBenchmark");
  const parsed = parseInt(raw || "59", 10);
  return isNaN(parsed) ? 59 : Math.max(0, Math.min(100, parsed));
})();
let _dashFilter = { alat: "", pengadaan: "", tahun: "" };
let _dashTabIndex = 0;
let _dashChartBar = null;
let _dashChartAvail = null;
let _dashChartTrend = null;
// "perbaikan" is the printed repair report, moved here from Kelola Inventaris so
// every fleet-level dashboard lives behind one menu entry. It owns its own
// Lokasi + Tahun filters and boots lazily — see setupRepairDashboard().
const _DASH_TABS = ["matrix", "bar", "avail", "trend", "perbaikan"];

function _dashFilteredDb() {
  return db.filter((item) => {
    // FIX 1: Gunakan properti yang benar (kode_alat)
    if (_dashFilter.alat && item.kode_alat !== _dashFilter.alat) return false;

    // FIX 2: Sesuaikan pemetaan nilai HTML dengan value di Database
    if (_dashFilter.pengadaan) {
      const valPengadaan = _dashFilter.pengadaan === "1" ? "PUSAT" : "DAOP";
      if (
        !item.sumber_pengadaan ||
        !item.sumber_pengadaan.includes(valPengadaan)
      ) {
        return false;
      }
    }

    if (
      _dashFilter.tahun &&
      String(item.tanggal_pembelian ?? "").slice(0, 4) !== _dashFilter.tahun
    )
      return false;

    return true;
  });
}

function _buildDashFilterBar() {
  // Alat dropdown
  const alatSel = document.getElementById("dash-filter-alat");
  if (alatSel && alatSel.options.length <= 1) {
    alatKerjaData.forEach((a) => {
      const o = document.createElement("option");
      o.value = a.code;
      o.textContent = a.name;
      alatSel.appendChild(o);
    });
  }

  // Year dropdown — 1950 to current
  const tahunSel = document.getElementById("dash-filter-tahun");
  if (tahunSel && tahunSel.options.length <= 1) {
    const curYear = new Date().getFullYear();
    for (let y = curYear; y >= 1950; y--) {
      const o = document.createElement("option");
      o.value = String(y);
      o.textContent = String(y);
      tahunSel.appendChild(o);
    }
  }

  // Wire filter changes (only once)
  if (!window._dashFiltersWired) {
    window._dashFiltersWired = true;
    ["dash-filter-alat", "dash-filter-pengadaan", "dash-filter-tahun"].forEach(
      (id) => {
        document.getElementById(id)?.addEventListener("change", (e) => {
          const key = {
            "dash-filter-alat": "alat",
            "dash-filter-pengadaan": "pengadaan",
            "dash-filter-tahun": "tahun",
          }[id];
          _dashFilter[key] = e.target.value;
          updateDashboardStats();
        });
      },
    );

    // Tab clicks
    document.querySelectorAll(".dash-tab-btn").forEach((btn, i) => {
      btn.addEventListener("click", () => _switchDashTab(i));
    });

    // Arrow buttons
    document
      .getElementById("dash-tab-prev")
      ?.addEventListener("click", () =>
        _switchDashTab(
          (_dashTabIndex - 1 + _DASH_TABS.length) % _DASH_TABS.length,
        ),
      );
    document
      .getElementById("dash-tab-next")
      ?.addEventListener("click", () =>
        _switchDashTab((_dashTabIndex + 1) % _DASH_TABS.length),
      );

    // Dot clicks
    document.querySelectorAll(".dash-dot").forEach((dot) => {
      dot.addEventListener("click", () =>
        _switchDashTab(parseInt(dot.dataset.dot)),
      );
    });
  }
}

function _switchDashTab(idx) {
  _dashTabIndex = idx;
  const tabId = _DASH_TABS[idx];

  document.querySelectorAll(".dash-tab-btn").forEach((btn, i) => {
    btn.classList.toggle("is-active", i === idx);
  });
  document
    .querySelectorAll(".dash-panel")
    .forEach((p) => p.classList.add("hidden"));
  document.getElementById(`dash-panel-${tabId}`)?.classList.remove("hidden");
  document.querySelectorAll(".dash-dot").forEach((d, i) => {
    d.classList.toggle("is-active", i === idx);
  });

  _renderDashActivePanel();
}

function _renderDashActivePanel() {
  const tabId = _DASH_TABS[_dashTabIndex];
  if (tabId === "matrix") _renderMatrixPanel();
  if (tabId === "bar") _renderBarPanel();
  if (tabId === "avail") _renderAvailPanel();
  if (tabId === "trend") _renderTrendPanel();
  // Unlike the other four, this panel is server-driven rather than computed from
  // the cached `db` array, so it fetches on activation instead of re-rendering.
  if (tabId === "perbaikan") window.initRepairDashboard?.();
}

// ── PANEL 1: Matrix ────────────────────────────────────────────────────────
function _renderMatrixPanel() {
  const thead = document.getElementById("dash-matrix-thead");
  const tbody = document.getElementById("dash-matrix-tbody");
  if (!thead || !tbody) return;

  const filtered = _dashFilteredDb();

  // FIX 3: Jangan membuang BALAIYASA. Gunakan seluruh lokasiData.
  let regions = lokasiData.filter(r => (r.tipe || "").toUpperCase() !== "BALAIYASA");
  let uptByParent = {};

  // Pastikan setiap region memiliki array UPT, dan tambahkan dirinya sendiri
  // sebagai "UPT" pertama untuk menampung aset yang ada di kantor pusat/region
  regions.forEach((r) => {
    uptByParent[r.code] = [];
    // uptByParent[r.code].push({
    //   upt: r.code,
    //   nama: `Kantor ${r.tipe || "Wilayah"}`,
    //   lokasi: r.code,
    // });
  });

  // Masukkan UPT ke region induk masing-masing
  uptDatabase.forEach((u) => {
    if (u.lokasi && uptByParent[u.lokasi] && u.lokasi !== u.upt) {
      uptByParent[u.lokasi].push(u);
    }
  });

  const maxUpt = Math.max(1, ...regions.map((r) => uptByParent[r.code].length));

  // Map aset berdasarkan UPT spesifik dan berdasarkan Region Induk
  const assetsByLokasi = {};

  filtered.forEach((a) => {
    const uptCode = a.id_lokasi_raw || a.id_lokasi;
    if (!uptCode) return;

    if (!assetsByLokasi[uptCode]) assetsByLokasi[uptCode] = [];
    assetsByLokasi[uptCode].push(a);
  });

  // Header Table
  const thCols = Array.from(
    { length: maxUpt },
    (_, i) =>
      `<th class="text-center text-gray-400 dark:text-gray-500 px-2">${i + 1}</th>`,
  ).join("");

  thead.innerHTML = `<tr>
        <th class="text-center sticky left-0 bg-white dark:bg-gray-800 z-10 pr-3 min-w-[110px]">Wilayah</th>
        ${thCols}
        <th class="text-center text-gray-500 px-2 border-l border-gray-200 dark:border-gray-700">Total</th>
        <th class="text-center text-green-600 px-2">SO</th>
        <th class="text-center text-red-500 px-2">TSO</th>
        <th class="text-center text-kai-blue px-2">Ada%</th>
        <th class="text-center text-slate-400 px-2">Δ</th>
    </tr>`;

  // Body Table
  const rowsHtml = regions
    .map((region) => {
      const upts = uptByParent[region.code] || [];

      // Hitung SO dan TSO secara ketat hanya dari UPT yang divisualisasikan
      let regionSo = 0;
      let regionTso = 0;

      upts.forEach(upt => {
        const assets = assetsByLokasi[upt.upt] || [];
        regionSo += assets.filter(a => a.status_terakhir === "SO").length;
        regionTso += assets.filter(a => a.status_terakhir === "TSO").length;
      });

      const total = regionSo + regionTso;

      const cells = Array.from({ length: maxUpt }, (_, i) => {
        const upt = upts[i];
        if (!upt)
          return `<td class="text-center px-2 text-gray-300 dark:text-gray-700">—</td>`;

        const assets = assetsByLokasi[upt.upt];
        if (!assets || !assets.length) {
          return `<td class="text-center px-2 text-gray-300 dark:text-gray-600" title="${upt.upt}">—</td>`;
        }

        const soCount = assets.filter((a) => a.status_terakhir === "SO").length;
        const tsoCount = assets.filter(
          (a) => a.status_terakhir === "TSO",
        ).length;

        if (assets.length === 1) {
          const isSo = soCount > 0;
          return `<td class="text-center px-2 rounded font-bold ${
            isSo
              ? "bg-green-100 dark:bg-green-900/40 "
              : "bg-red-100 dark:bg-red-900/40 "
          }" title="${upt.upt}: ${isSo ? "SO" : "TSO"}">${soCount}/${tsoCount}</td>`;
        }

         // }" title="${upt.upt}: ${isSo ? "SO" : "TSO"}">1</td>`;

        const allSo = tsoCount === 0;
        const allTso = soCount === 0;
        const cellClass = allSo
          ? "bg-green-100 dark:bg-green-900/40 text-green-700"
          : allTso
            ? "bg-red-100 dark:bg-red-900/40 text-red-700"
            : "matrix-cell-mixed";

        return `<td class="text-center px-2 rounded ${cellClass} font-bold" title="${upt.upt}: ${soCount} SO / ${tsoCount} TSO">${soCount}/${tsoCount}</td>`;
      }).join("");

      const avail = total > 0 ? Math.round((regionSo / total) * 100) : null;
      const delta = avail !== null ? avail - _benchmarkPct : null;
      const availStr = avail !== null ? `${avail}%` : "—";
      const deltaStr =
        delta !== null
          ? `<span class="${delta >= 0 ? "text-green-500" : "text-red-500"}">${delta >= 0 ? "+" : ""}${delta}%</span>`
          : "—";

      return `<tr class="border-t border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30">
          <td class="text-left sticky left-0 bg-white dark:bg-gray-800 z-10 font-bold text-gray-700 dark:text-gray-300 pr-3 py-1.5 text-xs">${region.name}</td>
          ${cells}
          <td class="text-center px-2 font-bold text-gray-700 dark:text-gray-300 border-l border-gray-200 dark:border-gray-700">${total || "—"}</td>
          <td class="text-center px-2 font-bold text-green-600">${regionSo || "—"}</td>
          <td class="text-center px-2 font-bold text-red-500">${regionTso || "—"}</td>
          <td class="text-center px-2 font-bold text-kai-blue dark:text-blue-400">${availStr}</td>
          <td class="text-center px-2">${deltaStr}</td>
      </tr>`;
    })
    .join("");

  tbody.innerHTML = rowsHtml;

  if (!rowsHtml.trim()) {
    tbody.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-gray-400">Tidak ada wilayah yang terdaftar.</td></tr>`;
  }
}

// ── PANEL: Availability Rate per Lokasi ───────────────────────────────────
function _renderAvailPanel() {
  const canvas = document.getElementById("dash-chart-avail");
  if (!canvas) return;

  const filtered = _dashFilteredDb();

  // Use non-BALAIYASA lokasi, same as matrix
  const regions = lokasiData.filter(
    (r) => (r.tipe || "").toUpperCase() !== "BALAIYASA"
  );

  // Aggregate assets per lokasi (roll up UPT → parent)
  const assetsByLokasi = {};
  filtered.forEach((a) => {
    const key = a.id_lokasi_raw || a.id_lokasi;
    if (!key) return;
    if (!assetsByLokasi[key]) assetsByLokasi[key] = [];
    assetsByLokasi[key].push(a);
    const parentKey = getParentLokasiCode(key);
    if (parentKey && parentKey !== key) {
      if (!assetsByLokasi[parentKey]) assetsByLokasi[parentKey] = [];
      assetsByLokasi[parentKey].push(a);
    }
  });

  // Build labels and availability rates
  const labels = [];
  const rates = [];

  regions.forEach((r) => {
    const assets = assetsByLokasi[r.code] || [];
    const total = assets.length;
    const so = assets.filter((a) => a.status_terakhir === "SO").length;
    const rate = total > 0 ? Math.round((so / total) * 100) : 0;
    labels.push(r.name.replace("DAOP ", "D").replace("DIVRE ", "DR"));
    rates.push(rate);
  });

  if (rates.length === 0) {
    if (_dashChartAvail) { _dashChartAvail.destroy(); _dashChartAvail = null; }
    return;
  }

  const avg = Math.round(rates.reduce((s, v) => s + v, 0) / rates.length);
  const maxRate = Math.max(...rates);
  const minRate = Math.min(...rates);

  const barColors = rates.map((v) => {
    if (v === maxRate) return "rgba(34,197,94,0.85)";   // green – highest
    if (v === minRate) return "rgba(239,68,68,0.85)";   // red   – lowest
    return "rgba(59,130,246,0.75)";                      // blue  – rest
  });

  const isDark = document.documentElement.classList.contains("dark");
  const gridColor = isDark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.06)";
  const textColor = isDark ? "#9ca3af" : "#6b7280";

  if (_dashChartAvail) _dashChartAvail.destroy();
  _dashChartAvail = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "avail",
          data: rates,
          backgroundColor: barColors,
          borderRadius: 4,
          order: 2,
        },
        {
          label: "avg",
          data: new Array(labels.length).fill(avg),
          type: "line",
          borderColor: "rgba(239,68,68,0.9)",
          borderWidth: 2,
          borderDash: [],
          pointRadius: 0,
          fill: false,
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        title: { display: false },
        subtitle: { display: false },
        legend: {
          labels: {
            color: textColor,
            font: { size: 11 },
            generateLabels: (chart) => [
              {
                text: "avg",
                strokeStyle: "rgba(239,68,68,0.9)",
                fillStyle: "rgba(239,68,68,0.9)",
                lineWidth: 2,
                lineDash: [],
                hidden: false,
                datasetIndex: 1,
              },
              {
                text: "avail",
                strokeStyle: "rgba(59,130,246,0.75)",
                fillStyle: "rgba(59,130,246,0.75)",
                lineWidth: 0,
                hidden: false,
                datasetIndex: 0,
              },
            ],
          },
        },
        tooltip: {
          callbacks: {
            label: (ctx) =>
              ctx.datasetIndex === 1
                ? `avg: ${avg}%`
                : `avail: ${ctx.parsed.y}%`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: textColor, font: { size: 10 } },
          grid: { color: gridColor },
        },
        y: {
          min: 0,
          max: 100,
          ticks: {
            color: textColor,
            font: { size: 10 },
            callback: (v) => v + "%",
          },
          grid: { color: gridColor },
        },
      },
    },
  });
}

// ── PANEL 2: Bar chart ─────────────────────────────────────────────────────
function _renderBarPanel() {
  const canvas = document.getElementById("dash-chart-bar");
  if (!canvas) return;

  const filtered = _dashFilteredDb();
  const regions = lokasiData.filter((r) => (r.tipe || "").toUpperCase() !== "BALAIYASA");

  const assetsByLokasi = {};
  filtered.forEach((a) => {
    const key = a.id_lokasi_raw || a.id_lokasi;
    if (!key) return;

    // Index by the raw key (UPT code)
    if (!assetsByLokasi[key]) assetsByLokasi[key] = [];
    assetsByLokasi[key].push(a);

    // Roll up to parent region for bar chart aggregation
    const parentKey = getParentLokasiCode(key);
    if (parentKey && parentKey !== key) {
      if (!assetsByLokasi[parentKey]) assetsByLokasi[parentKey] = [];
      assetsByLokasi[parentKey].push(a);
    }
  });

  const labels = [],
    soData = [],
    tsoData = [];
  regions.forEach((r) => {
    const assets = assetsByLokasi[r.code] || [];
    const so = assets.filter((a) => a.status_terakhir === "SO").length;
    const tso = assets.filter((a) => a.status_terakhir === "TSO").length;
    labels.push(r.name.replace("DAOP ", "D").replace("DIVRE ", "DR"));
    soData.push(so);
    tsoData.push(tso);
  });

  const isDark = document.documentElement.classList.contains("dark");
  const gridColor = isDark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.06)";
  const textColor = isDark ? "#9ca3af" : "#6b7280";

  if (_dashChartBar) _dashChartBar.destroy();
  _dashChartBar = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "SO",
          data: soData,
          backgroundColor: "rgba(34,197,94,0.75)",
          borderRadius: 4,
        },
        {
          label: "TSO",
          data: tsoData,
          backgroundColor: "rgba(239,68,68,0.75)",
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: textColor, font: { size: 11 } } } },
      scales: {
        x: {
          stacked: false,
          ticks: { color: textColor, font: { size: 10 } },
          grid: { color: gridColor },
        },
        y: {
          beginAtZero: true,
          ticks: { color: textColor, stepSize: 1, font: { size: 10 } },
          grid: { color: gridColor },
        },
      },
    },
  });
}

// ── PANEL 3: Trend line chart ──────────────────────────────────────────────
function _renderTrendPanel() {
  const canvas = document.getElementById("dash-chart-trend");
  if (!canvas) return;

  const selectedYear = _dashFilter.tahun || String(new Date().getFullYear());
  const months = [
    "Januari",
    "Februari",
    "Maret",
    "April",
    "Mei",
    "Juni",
    "Juli",
    "Agustus",
    "Septemebr",
    "Oktober",
    "November",
    "Desember",
  ];

  // Count perbaikan per month from db riwayat — we derive from latest_date in history summary
  // Use db directly: each item has repair.latest_date — for full tren we need per-month count
  // Since frontend db doesn't carry full riwayat, we approximate from `db` entries that were
  // updated in each month. For a full chart, wire to /api/export/riwayat — lazy-fetch here.
  const monthSo = new Array(12).fill(0);
  const monthTso = new Array(12).fill(0);

  db.forEach((item) => {
    const d = item.waktu_update || item.tanggal_pembelian;
    if (!d) return;
    // Normalize: handle "YYYY-MM-DD", "YYYY-MM-DD HH:MM:SS", ISO strings
    const dateObj = new Date(String(d).replace(" ", "T"));
    if (isNaN(dateObj.getTime())) return;
    const yr = String(dateObj.getFullYear());
    const mo = dateObj.getMonth(); // 0-indexed
    if (yr !== selectedYear || mo < 0 || mo > 11) return;
    if (item.status_terakhir === "SO") monthSo[mo]++;
    if (item.status_terakhir === "TSO") monthTso[mo]++;
  });

  const isDark = document.documentElement.classList.contains("dark");
  const textColor = isDark ? "#9ca3af" : "#6b7280";
  const gridColor = isDark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.06)";

  if (_dashChartTrend) _dashChartTrend.destroy();
  _dashChartTrend = new Chart(canvas, {
    type: "line",
    data: {
      labels: months,
      datasets: [
        {
          label: "Laporan SO",
          data: monthSo,
          borderColor: "rgba(34,197,94,0.9)",
          backgroundColor: "rgba(34,197,94,0.1)",
          fill: true,
          tension: 0.4,
          pointRadius: 4,
          pointHoverRadius: 6,
        },
        {
          label: "Laporan TSO",
          data: monthTso,
          borderColor: "rgba(239,68,68,0.9)",
          backgroundColor: "rgba(239,68,68,0.1)",
          fill: true,
          tension: 0.4,
          pointRadius: 4,
          pointHoverRadius: 6,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: textColor, font: { size: 11 } } } },
      scales: {
        x: {
          ticks: { color: textColor, font: { size: 10 } },
          grid: { color: gridColor },
        },
        y: {
          beginAtZero: true,
          ticks: { color: textColor, font: { size: 10 } },
          grid: { color: gridColor },
        },
      },
    },
  });
}

function updateDashboardStats() {
  const filtered = _dashFilteredDb();

  const so = filtered.filter((i) => i.status_terakhir === "SO").length;
  const tso = filtered.filter((i) => i.status_terakhir === "TSO").length;

  const total = so + tso;

  const avail = total > 0 ? Math.round((so / total) * 100) : null;
  const delta = avail !== null ? avail - _benchmarkPct : null;

  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  set("stat-total", total || "—");
  set("stat-so", so || "—");
  set("stat-tso", tso || "—");
  set("stat-avail", avail !== null ? `${avail}%` : "—");
  set("stat-benchmark", `${_benchmarkPct}%`);

  const deltaEl = document.getElementById("stat-benchmark-delta");
  if (deltaEl && delta !== null) {
    deltaEl.textContent = `${delta >= 0 ? "+" : ""}${delta}%`;
    deltaEl.className = `text-xs font-bold mb-0.5 ${delta >= 0 ? "text-green-500" : "text-red-500"}`;
  }

  _buildDashFilterBar();
  _renderDashActivePanel();
}

// NOTE: an unreferenced afkirAset() used to live here, duplicating
// window.deleteAset() with a weaker single confirmation. deleteAset is the one
// the card trash icon calls.

// --- UI UTILITIES & EVENT LISTENERS ---
function populateSelects(preserveValues = false) {
  const alatHTML = alatKerjaData
    .map((d) => `<option value="${d.code}">${d.name}</option>`)
    .join("");
  const lokasiHTML = lokasiData
    .map((d) => `<option value="${d.code}">${d.name}</option>`)
    .join("");

  const inAlat = document.getElementById("in-alat");
  const inLokasi = document.getElementById("in-lokasi");
  const inUpt = document.getElementById("in-upt");
  const editLokasi = document.getElementById("edit-lokasi");
  const editUpt = document.getElementById("edit-upt");

  // Helper to repopulate while preserving selected value if valid
  function repopulateSelect(selectEl, newHTML, defaultOptionHTML, preserve) {
    if (!selectEl) return;
    const oldValue = selectEl.value;
    selectEl.innerHTML = defaultOptionHTML + newHTML;
    if (
      preserve &&
      oldValue &&
      selectEl.querySelector(`option[value="${oldValue}"]`)
    ) {
      selectEl.value = oldValue;
    }
  }

  if (inAlat) repopulateSelect(inAlat, alatHTML, `<option value="">— Pilih Alat Kerja —</option>`, preserveValues);

  // Lokasi: regions only, blank default
  if (inLokasi)
    repopulateSelect(
      inLokasi,
      lokasiHTML,
      `<option value="">— Pilih Lokasi/Wilayah —</option>`,
      preserveValues,
    );

  // UPT: locked until lokasi chosen — only reset if not preserving or no valid value
  if (inUpt) {
    const currentUpt = inUpt.value;
    const currentLokasi = inLokasi?.value;
    const hasValidUpt = preserveValues && currentUpt && currentLokasi;

    if (!hasValidUpt) {
      inUpt.innerHTML = `<option value="">— Pilih Lokasi terlebih dahulu —</option>`;
      inUpt.disabled = true;
    } else {
      // Re-apply UPT options for current lokasi
      applyUptSelect(currentLokasi, inUpt);
      if (inUpt.querySelector(`option[value="${currentUpt}"]`)) {
        inUpt.value = currentUpt;
      }
    }
  }

  // Edit form (Kondisi Perbaikan)
  if (editLokasi)
    repopulateSelect(
      editLokasi,
      lokasiHTML,
      `<option value="" disabled selected>Pilih Lokasi</option>`,
      preserveValues,
    );
  if (editUpt) {
    const currentEditUpt = editUpt.value;
    const currentEditLokasi = editLokasi?.value;
    const hasValidEditUpt =
      preserveValues && currentEditUpt && currentEditLokasi;

    if (!hasValidEditUpt) {
      editUpt.innerHTML = `<option value="" disabled selected>Pilih UPT</option>`;
      editUpt.disabled = true;
    } else {
      applyUptSelect(currentEditLokasi, editUpt);
      if (editUpt.querySelector(`option[value="${currentEditUpt}"]`)) {
        editUpt.value = currentEditUpt;
      }
    }
  }

  // Kalibrasi form
  const kalibLokasi = document.getElementById("kalib-lokasi");
  const kalibUpt = document.getElementById("kalib-upt");
  if (kalibLokasi)
    repopulateSelect(
      kalibLokasi,
      lokasiHTML,
      `<option value="" disabled selected>Pilih Lokasi</option>`,
      preserveValues,
    );
  if (kalibUpt) {
    const currentKalibUpt = kalibUpt.value;
    const currentKalibLokasi = kalibLokasi?.value;
    const hasValidKalibUpt =
      preserveValues && currentKalibUpt && currentKalibLokasi;

    if (!hasValidKalibUpt) {
      kalibUpt.innerHTML = `<option value="" disabled selected>Pilih UPT</option>`;
      kalibUpt.disabled = true;
    } else {
      applyUptSelect(currentKalibLokasi, kalibUpt);
      if (kalibUpt.querySelector(`option[value="${currentKalibUpt}"]`)) {
        kalibUpt.value = currentKalibUpt;
      }
    }
  }
}

function switchView(viewId) {
  document.querySelectorAll(".view-section").forEach((el) => {
    el.classList.remove("is-visible", "is-flex");
  });

  const targetView = document.getElementById(`view-${viewId}`);
  if (targetView) {
    targetView.classList.add("is-visible");
  }

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    if (btn.dataset.view === viewId) btn.classList.add("is-active");
    else btn.classList.remove("is-active");
  });

  const pageMeta = {
    dashboard: {
      title: "Dashboard",
      subtitle: "Pantau Kesiapan dan Kondisi Aset Alat Kerja",
    },
    input: {
      title: "Kelola Aset Alat Kerja",
      subtitle: "Pantau, Registrasi, dan Kelola Inventaris Aset Alat Kerja",
    },
    inventaris: {
      title: "Kelola Inventaris",
      subtitle: "Kelola Suku Cadang dan Riwayat Transfer Inventaris",
    },
    database: {
      title: "Kelola Data Aset",
      subtitle: "Daftar Seluruh Aset Alat Kerja yang Terdaftar",
    },
    history: {
      title: "Pantau Riwayat Aset",
      subtitle: "Riwayat Perbaikan dan Mutasi Aset",
    },
    "history-detail": {
      title: "Detail Riwayat Aset",
      subtitle: "Rincian Riwayat Perbaikan dan Mutasi Aset",
    },
    edit: {
      title: "Pembaruan Kondisi",
      subtitle: "Perbarui Status Kondisi Aset Alat Kerja",
    },
    laporan: {
      title: "Proses Laporan",
      subtitle: "Filter dan Ekspor Data Aset ke Excel atau PDF",
    },
    masterdata: {
      title: "Pusat Data",
      subtitle: "Kelola Data Master Sistem (SUPER ADMIN)",
    },
    afkir: {
      title: "Pulihkan Aset Afkir",
      subtitle: "Lihat dan Pulihkan Aset yang Telah di-Afkir",
    },
  };
  const meta = pageMeta[viewId];
  if (meta) {
    const t = document.getElementById("topbar-page-title");
    const s = document.getElementById("topbar-page-subtitle");
    if (t) t.textContent = meta.title;
    if (s) s.textContent = meta.subtitle;
  }

  const breadcrumb = document.getElementById("breadcrumb-label");
  if (breadcrumb && meta) breadcrumb.textContent = meta.title;

  if (viewId === "database" || viewId === "history" || viewId === "afkir") {
    const tv = document.getElementById(`view-${viewId}`);
    if (tv) tv.classList.add("is-flex");
  }
  if (viewId === "database" || viewId === "history") {
    // This already calls loadHistorySummary() and re-renders whichever view is
    // visible, so History must not fetch the summary a second time — it used to
    // request /history/summary twice on every visit.
    fetchAsetFromServer();
  }
  if (viewId === "input") {
    // KDAK used to render ONLY from inside fetchAsetFromServer(), and only when
    // this view already happened to be visible — so arriving here from any other
    // view showed an empty table until some unrelated refresh fired. The data is
    // already cached in `db`, so render it directly.
    updateKdakStats();
    renderKdakTable();
  }
  if (viewId === "laporan") {
    initLaporanView();
  }
  if (viewId === "masterdata") {
    setTimeout(() => {
      document.querySelector('.master-tab[data-tab="users"]')?.click();
    }, 50);
  }
  if (viewId === "afkir") {
    loadAfkirCards();
  }
  if (viewId === "inventaris") {
    // Boots the lokasi/tahun dropdowns and loads the dashboard. Deferred to
    // here because it needs an auth token, which does not exist at script-eval.
    window.initInvView?.();
  }

  // Let other sessions see where this user is working.
  reportCurrentView(viewId);
}

function setupEventListeners() {
  // Navigasi Sidebar
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  // Auth — multi-step login
  document.getElementById("btn-next-step")?.addEventListener("click", () => {
    const username = document.getElementById("login-username").value.trim();
    if (!username) {
      showToast("Username tidak boleh kosong!", "warning");
      return;
    }
    document.getElementById("auth-display-username").innerText = username;
    document.getElementById("auth-step-1").classList.add("hidden");
    document.getElementById("auth-step-2").classList.remove("hidden");
  });

  document
    .getElementById("login-username")
    ?.addEventListener("keypress", (e) => {
      if (e.key === "Enter") document.getElementById("btn-next-step")?.click();
    });

  document.getElementById("btn-back-step1")?.addEventListener("click", () => {
    document.getElementById("auth-step-2").classList.add("hidden");
    document.getElementById("auth-step-1").classList.remove("hidden");
  });

  document.getElementById("btn-back-step2")?.addEventListener("click", () => {
    document.getElementById("auth-step-3").classList.add("hidden");
    document.getElementById("auth-step-2").classList.remove("hidden");
  });

  document.querySelectorAll(".division-card").forEach((card) => {
    card.addEventListener("click", () => {
      const division = card.dataset.division;
      const labels = {
        TEKNISI: "Teknisi (TraKSI)",
        ADMIN_WILAYAH: "Admin Wilayah",
        SUPER_ADMIN: "Super Admin (RAMCES)",
      };

      // Normalize legacy values to the backend role contract.
      const roleVal = division === "ADMIN_DAOP" ? "ADMIN_WILAYAH" : division;

      document.getElementById("login-role").value = roleVal;
      document.getElementById("auth-display-role").innerText =
        labels[roleVal] || labels[division] || division;

      const regionSel = document.getElementById("login-region");
      if (roleVal === "SUPER_ADMIN") {
        regionSel.disabled = true;
        regionSel.innerHTML =
          '<option value="">Semua Region (tidak diperlukan)</option>';
      } else {
        regionSel.disabled = false;
        fetchLoginRegions();
      }

      document.getElementById("auth-step-2").classList.add("hidden");
      document.getElementById("auth-step-3").classList.remove("hidden");
    });
  });

  document.getElementById("btn-login")?.addEventListener("click", handleLogin);
  document.getElementById("login-region")?.addEventListener("keypress", (e) => {
    if (e.key === "Enter") handleLogin();
  });

  // Sidebar & Theme
  document
    .getElementById("mobile-menu-btn")
    ?.addEventListener("click", toggleSidebar);
  document
    .getElementById("sidebar-toggle-btn")
    ?.addEventListener("click", toggleSidebar);
  document
    .getElementById("sidebar-overlay")
    ?.addEventListener("click", toggleSidebar);
  document.getElementById("theme-toggle-btn")?.addEventListener("click", () => {
    const html = document.documentElement;
    html.classList.toggle("dark");
    const isDark = html.classList.contains("dark");
    localStorage.setItem("theme", isDark ? "dark" : "light");
    // Charts bake their palette in at construction time, so anything currently
    // drawn has to be told to re-render against the new surface.
    window.dispatchEvent(
      new CustomEvent("kai-theme-change", { detail: { dark: isDark } }),
    );
  });

  // Profile modal
  document
    .getElementById("profile-btn")
    ?.addEventListener("click", openProfileModal);
  document
    .getElementById("close-profile-modal")
    ?.addEventListener("click", closeProfileModal);
  document.getElementById("profile-modal")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("profile-modal"))
      closeProfileModal();
  });
  document
    .getElementById("profile-logout-btn")
    ?.addEventListener("click", () => {
      closeProfileModal();
      forceLogout(true);
    });
  document
    .getElementById("profile-delete-btn")
    ?.addEventListener("click", async () => {
      closeProfileModal();
      const confirmed = await customConfirm(
        `Apakah Anda yakin ingin menghapus akun "${currentUser}"?\nTindakan ini tidak dapat dibatalkan.`,
      );
      if (!confirmed) return;
      const reconfirmed = await customConfirm(
        `Konfirmasi terakhir: akun "${currentUser}" akan dihapus permanen dari sistem.`,
      );
      if (!reconfirmed) return;
      try {
        const response = await apiFetch("/users/me", { method: "DELETE" });
        if (!response.ok) throw new Error("Gagal menghapus akun.");
        showToast("Akun berhasil dihapus.", "success");
        setTimeout(() => forceLogout(true), 1500);
      } catch (error) {
        showToast(error.message, "error");
      }
    });

  // Search & Filter.
  // Every one of these changes the SIZE of the result set, so the current page
  // number stops meaning anything — reset to page 1 before re-rendering, or a
  // search from page 7 lands the user on an empty page.
  document.getElementById("search-db")?.addEventListener("input", () => {
    resetPage("db");
    renderDbCards();
  });
  document.getElementById("search-history")?.addEventListener("input", () => {
    // Three history modes, not two: dispatching kalibrasi to renderMutasiCards
    // meant typing in the search box swapped the Kalibrasi tab's own contents.
    resetPage(`history-${_historyMode}`);
    if (_historyMode === "repair") renderHistoryCards();
    else if (_historyMode === "kalibrasi") renderKalibrasiCards();
    else renderMutasiCards();
  });
  document.getElementById("filter-mode")?.addEventListener("change", () => {
    resetPage("db");
    renderDbCards();
  });

  // Data Aset quick-download buttons
  document
    .getElementById("btn-db-download-xlsx")
    ?.addEventListener("click", () => {
      if (!db.length) {
        showToast("Belum ada aset yang terdaftar.", "warning");
        return;
      }
      const rows = db.map((item) => ({
        "ID Aset": item.id_aset,
        "Kode Alat": item.kode_alat,
        Lokasi: item.id_lokasi,
        Status: item.status_terakhir,
        Pengadaan: item.sumber_pengadaan,
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Data Aset");
      XLSX.writeFile(
        wb,
        `DataAset_${new Date().toISOString().slice(0, 10)}.xlsx`,
      );
      showToast("File Excel berhasil diunduh.", "success");
    });

  document
    .getElementById("btn-db-download-pdf")
    ?.addEventListener("click", () => {
      if (!db.length) {
        showToast("Belum ada aset yang terdaftar.", "warning");
        return;
      }
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: "landscape" });
      doc.setFontSize(13);
      doc.setFont("helvetica", "bold");
      doc.text("RAMCES Light Machinery — Data Aset", 14, 14);
      doc.setFontSize(8);
      doc.setFont("helvetica", "normal");
      doc.text(
        `Dicetak: ${new Date().toLocaleString("id-ID")}  |  Total: ${db.length} aset`,
        14,
        20,
      );
      doc.autoTable({
        head: [["ID Aset", "Kode Alat", "Lokasi", "Status"]],
        body: db.map((item) => [
          item.id_aset,
          item.kode_alat,
          item.id_lokasi,
          item.status_terakhir,
        ]),
        startY: 25,
        styles: { fontSize: 7, cellPadding: 2 },
        headStyles: {
          fillColor: [22, 76, 129],
          textColor: 255,
          fontStyle: "bold",
        },
        alternateRowStyles: { fillColor: [249, 250, 251] },
        didParseCell(data) {
          if (data.section === "body" && data.column.index === 3) {
            const v = data.cell.raw;
            data.cell.styles.textColor =
              v === "SO" ? [21, 128, 61] : [185, 28, 28];
            data.cell.styles.fontStyle = "bold";
          }
        },
      });
      doc.save(`DataAset_${new Date().toISOString().slice(0, 10)}.pdf`);
      showToast("File PDF berhasil diunduh.", "success");
    });

  // Import Alat Excel
  // ── Master Bulk Import: shared logic for Alat / Lokasi / UPT ──
  function _wireMasterBulk(prefix, sampleFn, importFn) {
    const toggleBtn = document.getElementById(`${prefix}-bulk-toggle`);
    const dropdown  = document.getElementById(`${prefix}-bulk-dropdown`);
    const modal     = document.getElementById(`${prefix}-bulk-modal`);
    const actionSel = document.getElementById(`${prefix}-bulk-action`);
    const fileArea  = document.getElementById(`${prefix}-bulk-file-area`);
    const fileInput = document.getElementById(`${prefix}-bulk-file-input`);
    const fileName  = document.getElementById(`${prefix}-bulk-filename`);

    toggleBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown?.classList.toggle("hidden");
    });
    document.addEventListener("click", () => dropdown?.classList.add("hidden"));

    document.getElementById(`${prefix}-btn-sample-excel`)?.addEventListener("click", () => {
      dropdown?.classList.add("hidden");
      if (actionSel) actionSel.value = "sample";
      fileArea?.classList.add("hidden");
      modal?.classList.remove("hidden");
    });
    document.getElementById(`${prefix}-btn-import-excel`)?.addEventListener("click", () => {
      dropdown?.classList.add("hidden");
      if (actionSel) actionSel.value = "import";
      fileArea?.classList.remove("hidden");
      modal?.classList.remove("hidden");
    });

    actionSel?.addEventListener("change", (e) => {
      fileArea?.classList.toggle("hidden", e.target.value !== "import");
    });
    fileInput?.addEventListener("change", (e) => {
      if (fileName) fileName.textContent = e.target.files[0]?.name || "Belum ada file dipilih";
    });
    document.getElementById(`close-${prefix}-bulk-modal`)?.addEventListener("click", () => modal?.classList.add("hidden"));
    document.getElementById(`${prefix}-bulk-cancel`)?.addEventListener("click", () => modal?.classList.add("hidden"));
    document.getElementById(`${prefix}-bulk-confirm`)?.addEventListener("click", async () => {
      const action = actionSel?.value;
      if (!action) { showToast("Pilih tindakan terlebih dahulu.", "warning"); return; }
      if (action === "sample") {
        sampleFn();
        modal?.classList.add("hidden");
      } else if (action === "import") {
        const file = fileInput?.files[0];
        if (!file) { showToast("Pilih file Excel terlebih dahulu.", "warning"); return; }
        modal?.classList.add("hidden");
        await importFn(file);
      }
    });
  }

  // ── Sample Excel generators for master tabs ──
  function downloadMasterAlatSample() {
    const wb = XLSX.utils.book_new();
    const headers = ["Kode Alat", "Nama Alat"];
    const sample  = [["RGM", "Rel Grinding Machine"], ["CWL", "Crane Wire Long"]];
    const ws = XLSX.utils.aoa_to_sheet([headers, ...sample]);
    ws["!cols"] = [{ wch: 14 }, { wch: 30 }];
    const instr = [
      ["Petunjuk Pengisian"],
      ["Kolom Kode Alat: alphanumerik, max 10 karakter, unik, WAJIB"],
      ["Kolom Nama Alat: teks deskriptif, max 100 karakter, WAJIB"],
    ];
    const wsI = XLSX.utils.aoa_to_sheet(instr);
    wsI["!cols"] = [{ wch: 60 }];
    XLSX.utils.book_append_sheet(wb, ws, "Data Alat Kerja");
    XLSX.utils.book_append_sheet(wb, wsI, "Petunjuk");
    XLSX.writeFile(wb, "Template_Import_MasterAlat.xlsx");
  }

  function downloadMasterLokasiSample() {
    const wb = XLSX.utils.book_new();
    const headers = ["Kode Lokasi", "Nama Lokasi", "Tipe"];
    const sample  = [["D1", "DAOP 1 Jakarta", "DAOP"], ["VI", "DIVRE VI Medan", "DIVRE"]];
    const ws = XLSX.utils.aoa_to_sheet([headers, ...sample]);
    ws["!cols"] = [{ wch: 14 }, { wch: 30 }, { wch: 14 }];
    const instr = [
      ["Petunjuk Pengisian"],
      ["Kode Lokasi: alphanumerik, max 10 karakter, unik, WAJIB"],
      ["Nama Lokasi: teks, max 100 karakter, WAJIB"],
      ["Tipe: salah satu dari PUSAT / DAOP / DIVRE / BALAIYASA, WAJIB"],
    ];
    const wsI = XLSX.utils.aoa_to_sheet(instr);
    wsI["!cols"] = [{ wch: 60 }];
    XLSX.utils.book_append_sheet(wb, ws, "Data Lokasi");
    XLSX.utils.book_append_sheet(wb, wsI, "Petunjuk");
    XLSX.writeFile(wb, "Template_Import_MasterLokasi.xlsx");
  }

  function downloadMasterUptSample() {
    const wb = XLSX.utils.book_new();
    const headers = ["Kode UPT", "Nama UPT", "Kode Induk Lokasi"];
    const sample  = [["JR1.1", "UPT Jalan Rel 1.1", "D1"], ["JR2.3", "UPT Jalan Rel 2.3", "D2"]];
    const ws = XLSX.utils.aoa_to_sheet([headers, ...sample]);
    ws["!cols"] = [{ wch: 14 }, { wch: 30 }, { wch: 20 }];
    const instr = [
      ["Petunjuk Pengisian"],
      ["Kode UPT: alphanumerik, max 10 karakter, unik (misal: JR1.1), WAJIB"],
      ["Nama UPT: teks, max 100 karakter, WAJIB"],
      ["Kode Induk Lokasi: harus sudah terdaftar di tabel Lokasi (misal: D1, VI), WAJIB"],
    ];
    const wsI = XLSX.utils.aoa_to_sheet(instr);
    wsI["!cols"] = [{ wch: 60 }];
    XLSX.utils.book_append_sheet(wb, ws, "Data UPT");
    XLSX.utils.book_append_sheet(wb, wsI, "Petunjuk");
    XLSX.writeFile(wb, "Template_Import_MasterUPT.xlsx");
  }

  // ── Import processors for master tabs ──
  async function processMasterAlatImport(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const wb = XLSX.read(e.target.result, { type: "array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
          const dataRows = rows.slice(1).filter((r) => r[0] && r[1]);
          if (!dataRows.length) { showToast("File tidak memiliki baris data.", "warning"); return resolve(0); }
          let success = 0, failed = 0;
          for (const row of dataRows) {
            const kode = String(row[0]).trim().toUpperCase();
            const nama = String(row[1]).trim();
            if (!kode || !nama) { failed++; continue; }
            try {
              const res = await apiFetch("/master/alat", { method: "POST", body: JSON.stringify({ kode_alat: kode, nama_alat: nama }) });
              if (res.ok) success++; else failed++;
            } catch { failed++; }
          }
          showToast(`Import Alat selesai: ${success} berhasil${failed ? `, ${failed} gagal` : ""}.`, success > 0 ? "success" : "error");
          await loadMasterAlat();
          await fetchMasterData();
          resolve(success);
        } catch (err) { showToast("Gagal membaca file Excel.", "error"); reject(err); }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  async function processMasterLokasiImport(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const wb = XLSX.read(e.target.result, { type: "array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
          const dataRows = rows.slice(1).filter((r) => r[0] && r[1] && r[2]);
          if (!dataRows.length) { showToast("File tidak memiliki baris data.", "warning"); return resolve(0); }
          let success = 0, failed = 0;
          for (const row of dataRows) {
            try {
              const res = await apiFetch("/master/lokasi", { method: "POST", body: JSON.stringify({ id_lokasi: String(row[0]).trim().toUpperCase(), nama_lokasi: String(row[1]).trim(), tipe: String(row[2]).trim().toUpperCase() }) });
              if (res.ok) success++; else failed++;
            } catch { failed++; }
          }
          showToast(`Import Lokasi selesai: ${success} berhasil${failed ? `, ${failed} gagal` : ""}.`, success > 0 ? "success" : "error");
          await fetchMasterData();
          resolve(success);
        } catch (err) { showToast("Gagal membaca file Excel.", "error"); reject(err); }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  async function processMasterUptImport(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const wb = XLSX.read(e.target.result, { type: "array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
          const dataRows = rows.slice(1).filter((r) => r[0] && r[1] && r[2]);
          if (!dataRows.length) { showToast("File tidak memiliki baris data.", "warning"); return resolve(0); }
          let success = 0, failed = 0;
          for (const row of dataRows) {
            try {
              const res = await apiFetch("/master/lokasi", { method: "POST", body: JSON.stringify({ id_lokasi: String(row[0]).trim(), nama_lokasi: String(row[1]).trim(), tipe: "UPT", parent_lokasi: String(row[2]).trim() }) });
              if (res.ok) success++; else failed++;
            } catch { failed++; }
          }
          showToast(`Import UPT selesai: ${success} berhasil${failed ? `, ${failed} gagal` : ""}.`, success > 0 ? "success" : "error");
          await fetchMasterData();
          await loadMasterUpt();
          resolve(success);
        } catch (err) { showToast("Gagal membaca file Excel.", "error"); reject(err); }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  // Wire all three master bulk panels
  _wireMasterBulk("master-alat",   downloadMasterAlatSample,   processMasterAlatImport);
  _wireMasterBulk("master-lokasi", downloadMasterLokasiSample, processMasterLokasiImport);
  _wireMasterBulk("master-upt",    downloadMasterUptSample,    processMasterUptImport);

  document.getElementById("btn-import-alat-submit")?.addEventListener("click", async () => {
      const fileInput = document.getElementById("import-alat-file");
      const file = fileInput.files[0];
      if (!file) {
        showToast("Pilih file Excel terlebih dahulu.", "warning");
        return;
      }

      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const wb = XLSX.read(e.target.result, { type: "array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

          let dataRows = rows.filter((r) =>
            r.some((c) => String(c).trim() !== ""),
          );
          if (!dataRows.length) {
            showToast("File kosong atau tidak terbaca.", "error");
            return;
          }

          const firstRow = dataRows[0].map((c) =>
            String(c).toUpperCase().trim(),
          );
          if (firstRow.some((c) => c.includes("kode") || c.includes("nama"))) {
            dataRows = dataRows.slice(1);
          }

          const parsed = [];
          for (const row of dataRows) {
            const cells = row
              .map((c) => String(c).trim())
              .filter((_, i) => row[i] !== "");
            if (cells.length < 2) continue;

            let startIdx = 0;
            if (/^\d+$/.test(cells[0])) startIdx = 1;

            const kode = cells[startIdx];
            const nama = cells[startIdx + 1];

            if (!kode || !nama) {
              showToast(
                `Baris tidak valid ditemukan: "${row.join(", ")}". Format harus: Kode, Nama Alat.`,
                "error",
              );
              return;
            }
            if (/[^A-Za-z0-9_\-]/.test(kode)) {
              showToast(
                `Kode tidak valid: "${kode}". Hanya huruf, angka, - dan _ yang diperbolehkan.`,
                "error",
              );
              return;
            }

            parsed.push({ kode_alat: kode.toUpperCase(), nama_alat: nama });
          }

          if (!parsed.length) {
            showToast(
              "Tidak ada data valid yang ditemukan dalam file.",
              "warning",
            );
            return;
          }

          let success = 0,
            failed = 0;
          for (const item of parsed) {
            try {
              const res = await apiFetch("/master/alat", {
                method: "POST",
                body: JSON.stringify({
                  kode_alat: item.kode_alat,
                  nama_alat: item.nama_alat,
                }),
              });
              if (res.ok) success++;
              else failed++;
            } catch {
              failed++;
            }
          }

          document.getElementById("import-alat-modal").classList.add("hidden");
          showToast(
            `Import selesai: ${success} berhasil${failed ? `, ${failed} gagal` : ""}.`,
            success ? "success" : "error",
          );
          await loadMasterAlat();
          await fetchMasterData();
        } catch (err) {
          showToast(
            "Gagal membaca file. Pastikan format file adalah .xlsx yang valid.",
            "error",
          );
        }
      };
      reader.readAsArrayBuffer(file);
    });

  // Import Lokasi
  document.getElementById("btn-import-lokasi")?.addEventListener("click", () => {
    document.getElementById("import-lokasi-file").value = "";
    document.getElementById("import-lokasi-filename").textContent = "Belum ada file dipilih";
    document.getElementById("import-lokasi-modal").classList.remove("hidden");
  });
  document.getElementById("close-import-lokasi-modal")?.addEventListener("click", () => {
    document.getElementById("import-lokasi-modal").classList.add("hidden");
  });
  document.getElementById("import-lokasi-file")?.addEventListener("change", (e) => {
    document.getElementById("import-lokasi-filename").textContent = e.target.files[0]?.name || "Belum ada file dipilih";
  });
  document.getElementById("btn-import-lokasi-submit")?.addEventListener("click", async () => {
    const file = document.getElementById("import-lokasi-file").files[0];
    if (!file) { showToast("Pilih file Excel terlebih dahulu.", "warning"); return; }
    document.getElementById("import-lokasi-modal").classList.add("hidden");
    await processMasterLokasiImport(file);
  });

  // Import UPT
  document.getElementById("btn-import-upt")?.addEventListener("click", () => {
    document.getElementById("import-upt-file").value = "";
    document.getElementById("import-upt-filename").textContent = "Belum ada file dipilih";
    document.getElementById("import-upt-modal").classList.remove("hidden");
  });
  document.getElementById("close-import-upt-modal")?.addEventListener("click", () => {
    document.getElementById("import-upt-modal").classList.add("hidden");
  });
  document.getElementById("import-upt-file")?.addEventListener("change", (e) => {
    document.getElementById("import-upt-filename").textContent = e.target.files[0]?.name || "Belum ada file dipilih";
  });
  document.getElementById("btn-import-upt-submit")?.addEventListener("click", async () => {
    const file = document.getElementById("import-upt-file").files[0];
    if (!file) { showToast("Pilih file Excel terlebih dahulu.", "warning"); return; }
    document.getElementById("import-upt-modal").classList.add("hidden");
    await processMasterUptImport(file);
  });

  // Close buttons
  document
    .getElementById("close-edit-btn")
    ?.addEventListener("click", () => switchView("database"));
  document.getElementById("close-hist-btn")?.addEventListener("click", () => {
    activeHistoryUid = null;
    switchView("history");
  });

  // Dynamic UPT Select
  document.getElementById("edit-lokasi")?.addEventListener("change", (e) => {
    applyUptSelect(e.target.value, document.getElementById("edit-upt"));
  });

  document.getElementById("in-lokasi")?.addEventListener("change", (e) => {
    applyUptSelect(e.target.value, document.getElementById("in-upt"));
  });

  // SO / TSO buttons (scoped to perbaikan panel only)
  document.querySelectorAll("#panel-perbaikan .status-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const status = e.currentTarget.dataset.status;
      document.getElementById("edit-kondisi").value = status;

      document.querySelectorAll("#panel-perbaikan .status-btn").forEach((b) => {
        b.classList.remove("is-so", "is-tso", "is-idle");
        if (b.dataset.status === status) {
          b.classList.add(status === "SO" ? "is-so" : "is-tso");
        } else {
          b.classList.add("is-idle");
        }
      });
    });
  });

  // ── Edit form tab switcher ──────────────────────────────────────────────
  document.getElementById("edit-tab-perbaikan")?.addEventListener("click", () => {
      _switchEditFormTab("perbaikan");
    });
  document.getElementById("edit-tab-kalibrasi")?.addEventListener("click", () => {
      _switchEditFormTab("kalibrasi");
    });

  // ── Kalib lokasi/UPT dynamic selects ──────────────────────────────────
  document.getElementById("kalib-lokasi")?.addEventListener("change", (e) => {
    applyUptSelect(e.target.value, document.getElementById("kalib-upt"));
  });

  // ── Close kalibrasi button ─────────────────────────────────────────────
  document.getElementById("close-kalib-btn")?.addEventListener("click", () => {
    switchView("database");
  });

  // ── FORM SUBMISSIONS ────────────────────────────────────────────────────
  document
    .getElementById("form-input-baru")
    ?.addEventListener("submit", async function (e) {
      e.preventDefault();

      const alat = document.getElementById("in-alat").value;
      const pengadaan = document.querySelector(
        'input[name="in-pengadaan"]:checked',
      ).value;
      const tanggal = document.getElementById("in-tanggal").value;
      const unitRaw = document.querySelector(
        'input[name="in-unit"]:checked',
      ).value;
      const peruntukanMap = {
        A: "JALAN REL",
        B: "JEMBATAN",
        C: "MEKANIK",
        D: "BALAIYASA",
      };
      const peruntukanVal = peruntukanMap[unitRaw] || "JALAN REL";
      const lokasi = document.getElementById("in-lokasi").value; // Parent (misal: D1)
      const uptName = document.getElementById("in-upt")?.value || ""; // UPT (misal: JR1.1)

      if (!lokasi) {
        showToast("Pilih Lokasi/Wilayah terlebih dahulu.", "warning");
        return;
      }
      // UPT is optional — aset can be assigned to a parent lokasi without a specific UPT

      // Payload mentah. Tidak ada pembuatan id_aset di sini.
      const payload = {
        kode_alat: alat,
        id_lokasi: uptName || lokasi, // UPT if chosen, otherwise parent lokasi
        parent_lokasi: lokasi,
        tanggal_pembelian: tanggal,
        sumber_pengadaan: pengadaan,
        peruntukan: peruntukanVal,
      };

      try {
        const response = await apiFetch("/aset", {
          method: "POST",
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.detail || "Gagal menyimpan data ke database.");
        }

        const result = await response.json();

        // Ambil ID yang dihasilkan dari respons backend
        showToast(`Berhasil disimpan! ID Aset: ${result.id_aset}`, "success");

        this.reset();

        const inUpt = document.getElementById("in-upt");
        const inLokasi = document.getElementById("in-lokasi");
        if (inLokasi) inLokasi.value = "";
        if (inUpt) {
          inUpt.innerHTML = `<option value="">— Pilih Lokasi terlebih dahulu —</option>`;
          inUpt.disabled = true;
        }
        fetchAsetFromServer();
      } catch (error) {
        if (error.message !== "Unauthorized") showToast(error.message, "error");
      }
    });

  document
    .getElementById("form-edit")
    ?.addEventListener("submit", async function (e) {
      e.preventDefault();

      const kondisi    = document.getElementById("edit-kondisi").value;
      const keterangan = document.getElementById("edit-keterangan").value || "-";
      const uptVal     = document.getElementById("edit-upt")?.value || "";
      const lokasiVal  = document.getElementById("edit-lokasi")?.value || "";

      // Radio values are A/B/C/D — map to full name before sending
      const _PERUNTUKAN_SUBMIT = { A: "JALAN REL", B: "JEMBATAN", C: "MEKANIK", D: "BALAIYASA" };
      const unitRaw    = document.querySelector('input[name="edit-unit"]:checked')?.value || "";
      const peruntukan = _PERUNTUKAN_SUBMIT[unitRaw] || unitRaw || "";

      if (!kondisi)
        return showToast("Pilih Kondisi Alat Kerja (SO/TSO)!", "warning");
      if (!peruntukan)
        return showToast("Pilih Unit Peruntukan terlebih dahulu!", "warning");

      const payload = {
        id_aset:    document.getElementById("edit-uid").value,
        kondisi,
        keterangan,
        peruntukan,
        id_lokasi:  uptVal || lokasiVal || "",
      };

      try {
        const response = await apiFetch("/riwayat-kondisi", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error("Gagal menyimpan riwayat perbaikan.");

        showToast("Berhasil memperbarui kondisi", "success");
        switchView("database");
        fetchAsetFromServer();
      } catch (error) {
        if (error.message !== "Unauthorized") showToast(error.message, "error");
      }
    });

  document
    .getElementById("form-kalib")
    ?.addEventListener("submit", async function (e) {
      e.preventDefault();

      const uid = document.getElementById("edit-uid").value;
      const tanggalKalibrasi = document.getElementById("kalib-tanggal")?.value || "";
      const tanggalBerlaku   = document.getElementById("kalib-berlaku")?.value || tanggalKalibrasi;
      const statusKalibrasi  = document.getElementById("kalib-status")?.value || "LULUS";
      const pelaksana        = document.getElementById("kalib-teknisi")?.value?.trim() || null;
      const nomorSertifikat  = document.getElementById("kalib-nomor")?.value?.trim() || null;
      const keterangan       = document.getElementById("kalib-keterangan")?.value?.trim() || null;

      const payload = {
        id_aset: uid,
        tanggal_kalibrasi: tanggalKalibrasi,
        tanggal_berlaku: tanggalBerlaku || tanggalKalibrasi,
        status: statusKalibrasi,
        pelaksana_kalibrasi: pelaksana,
        nomor_sertifikat: nomorSertifikat,
        keterangan: keterangan,
      };

      try {
        const response = await apiFetch("/kalibrasi", {
          method: "POST",
          body: JSON.stringify(payload),
        });

        if (!response.ok) throw new Error("Gagal menyimpan laporan kalibrasi.");
        showToast("Laporan kalibrasi berhasil disimpan", "success");
        switchView("database");
        fetchAsetFromServer();
      } catch (error) {
        if (error.message !== "Unauthorized") showToast(error.message, "error");
      }
    });

  // ── QR MODAL LISTENERS ───────────────────────────────────────────────────

  document
    .getElementById("btn-copy-link")
    ?.addEventListener("click", async () => {
      const linkText = document.getElementById(
        "qr-landing-link-text",
      )?.textContent;
      if (!linkText) return;

      try {
        await navigator.clipboard.writeText(linkText);
        const btn = document.getElementById("btn-copy-link");
        btn.innerHTML = '<i class="fas fa-check"></i>';
        btn.title = "Tersalin!";
        setTimeout(() => {
          btn.innerHTML = '<i class="fas fa-copy"></i>';
          btn.title = "Salin link";
        }, 2000);
      } catch {
        showToast("Salin manual: " + linkText, "info");
      }
    });

  document
    .getElementById("close-qr-modal")
    ?.addEventListener("click", closeQrModal);
  document.getElementById("qr-modal")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("qr-modal")) closeQrModal();
  });

  document
    .getElementById("btn-qr-download-png")
    ?.addEventListener("click", downloadQrPng);
  document
    .getElementById("btn-qr-download-pdf")
    ?.addEventListener("click", downloadQrPdf);

  // ── HISTORY UI CONTROLS LISTENERS ────────────────────────────────────────

  document.getElementById("hist-tab-repair")?.addEventListener("click", () => {
    _historyMode = "repair";
    _setHistoryTab("repair");
    renderHistoryCards();
  });

  document.getElementById("hist-tab-kalibrasi")?.addEventListener("click", () => {
      _historyMode = "kalibrasi";
      _setHistoryTab("kalibrasi");
      renderKalibrasiCards();
    });

  document.getElementById("hist-tab-mutasi")?.addEventListener("click", () => {
    _historyMode = "mutasi";
    _setHistoryTab("mutasi");
    renderMutasiCards();
  });

  function _setHistoryTab(active) {
    const ACTIVE_REPAIR   = ["bg-kai-blue", "text-white", "font-semibold", "shadow-sm"];
    const INACTIVE_REPAIR = ["text-gray-500", "dark:text-gray-400", "font-medium", "hover:bg-blue-100", "hover:text-kai-blue", "dark:hover:bg-blue-900/20", "dark:hover:text-blue-300"];
    const ACTIVE_KALIB    = ["bg-cyan-600", "text-white", "font-semibold", "shadow-sm"];
    const INACTIVE_KALIB  = ["text-gray-500", "dark:text-gray-400", "font-medium", "hover:bg-cyan-100", "hover:text-cyan-700", "dark:hover:bg-cyan-900/20", "dark:hover:text-cyan-300"];
    const ACTIVE_MUTASI   = ["bg-kai-orange", "text-white", "font-semibold", "shadow-sm"];
    const INACTIVE_MUTASI = ["text-gray-500", "dark:text-gray-400", "font-medium", "hover:bg-orange-100", "hover:text-kai-orange", "dark:hover:bg-orange-900/20", "dark:hover:text-orange-300"];

    const ALL = [...ACTIVE_REPAIR, ...INACTIVE_REPAIR, ...ACTIVE_KALIB, ...INACTIVE_KALIB, ...ACTIVE_MUTASI, ...INACTIVE_MUTASI];

    const tabCfg = {
      repair:    { active: ACTIVE_REPAIR,  inactive: INACTIVE_REPAIR  },
      kalibrasi: { active: ACTIVE_KALIB,   inactive: INACTIVE_KALIB   },
      mutasi:    { active: ACTIVE_MUTASI,  inactive: INACTIVE_MUTASI  },
    };

    ["repair", "kalibrasi", "mutasi"].forEach((t) => {
      const btn = document.getElementById(`hist-tab-${t}`);
      if (!btn) return;
      ALL.forEach((c) => btn.classList.remove(c));
      (t === active ? tabCfg[t].active : tabCfg[t].inactive).forEach((c) => btn.classList.add(c));
    });

    document.getElementById("history-repair-container")?.classList.toggle("hidden", active !== "repair");
    document.getElementById("history-kalibrasi-container")?.classList.toggle("hidden", active !== "kalibrasi");
    document.getElementById("history-mutasi-container")?.classList.toggle("hidden", active !== "mutasi");
    // Each tab keeps its own page, so each carries its own pager bar; they hide
    // and show with the grid they belong to.
    document.getElementById("history-repair-pager")?.classList.toggle("hidden", active !== "repair");
    document.getElementById("history-kalibrasi-pager")?.classList.toggle("hidden", active !== "kalibrasi");
    document.getElementById("history-mutasi-pager")?.classList.toggle("hidden", active !== "mutasi");
  }

  document
    .getElementById("detail-tab-repair")
    ?.addEventListener("click", () => {
      switchDetailTab("repair", activeHistoryUid);
    });
  document
    .getElementById("detail-tab-kalibrasi")
    ?.addEventListener("click", () => {
      switchDetailTab("kalibrasi", activeHistoryUid);
    });
  document
    .getElementById("detail-tab-mutasi")
    ?.addEventListener("click", () => {
      switchDetailTab("mutasi", activeHistoryUid);
    });

  // Mutasi modal
  document
    .getElementById("close-mutasi-modal")
    ?.addEventListener("click", () => {
      document.getElementById("mutasi-modal").classList.add("hidden");
    });
  document.getElementById("mutasi-modal")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("mutasi-modal"))
      document.getElementById("mutasi-modal").classList.add("hidden");
  });

  document
    .getElementById("btn-submit-mutasi")
    ?.addEventListener("click", async () => {
      const uid        = document.getElementById("mutasi-uid").value;
      const lokasiTuju = document.getElementById("mutasi-lokasi-tuju").value;
      const uptTuju    = document.getElementById("mutasi-upt-tuju")?.value || "";
      const alasan     = document.getElementById("mutasi-alasan").value.trim();

      // Field value takes priority; fall back to logged-in username when blank
      const petugasVal = (document.getElementById("mutasi-petugas")?.value || "").trim()
        || currentUser || "";

      if (!lokasiTuju)
        return showToast("Pilih lokasi tujuan terlebih dahulu.", "warning");

      // UPT is optional — use UPT when chosen, otherwise use the parent lokasi code
      const idLokasiTujuan = uptTuju || lokasiTuju;

      const btn  = document.getElementById("btn-submit-mutasi");
      const orig = btn.innerHTML;
      btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Memproses...`;
      btn.disabled = true;

      try {
        const res = await apiFetch("/mutasi", {
          method: "POST",
          body: JSON.stringify({
            id_aset: uid,
            id_lokasi_tujuan: idLokasiTujuan,
            alasan_mutasi: alasan || null,
            nama_petugas: petugasVal,
          }),
        });

        const data = await res.json();

        if (!res.ok) throw new Error(data.detail || "Gagal memproses mutasi.");

        showToast(data.message || "Mutasi berhasil", "success");
        document.getElementById("mutasi-modal").classList.add("hidden");
        await fetchAsetFromServer();
        await loadHistorySummary();
      } catch (e) {
        showToast(e.message, "error");
      } finally {
        btn.innerHTML = orig;
        btn.disabled = false;
      }
    });
}

// ── WEBSOCKET ──────────────────────────────────────────────────────────────

const WS_MAX_RETRIES = 10;
const WS_BASE_DELAY = 3000;
const WS_MAX_DELAY = 60000;

function setupWebSocket() {
  if (window._wsHeartbeat) clearInterval(window._wsHeartbeat);
  if (window._wsReconnectTimer) clearTimeout(window._wsReconnectTimer);

  // Derive the scheme from the PAGE, not from any tunnel config. Behind a
  // TLS-terminating tunnel (Tailscale Funnel, Cloudflare, ngrok) the page is
  // https:// and a ws:// socket is blocked by the browser as mixed content.
  // The backend serves this SPA itself, so the socket is always same-origin.
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  // The token rides as a query param because the browser WebSocket API cannot
  // set an Authorization header. It identifies the socket for presence; the
  // server still accepts anonymous sockets for broadcasts.
  const qs = authToken ? `?token=${encodeURIComponent(authToken)}` : "";
  const ws = new WebSocket(`${protocol}://${window.location.host}/ws/updates${qs}`);

  ws.onopen = () => {
    _wsRetryCount = 0;
    _wsNgrokFailed = false; // Reset on successful connection
    updateWsDot(true);
    stopPollingFallback(); // Socket is live — no need to poll
    // Re-announce the current screen: on a reconnect the server has forgotten it.
    reportCurrentView();
    window._wsHeartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, 30000);
  };

  ws.onmessage = (event) => {
    if (event.data === "pong") return; // heartbeat ack
    if (event.data === "REFRESH_ASSET_LIST") {
      fetchAsetFromServer();
      if (typeof window.refreshAfkirIfVisible === "function")
        window.refreshAfkirIfVisible();
    } else if (event.data === "REFRESH_PRESENCE") {
      if (typeof window.refreshPresenceIfVisible === "function")
        window.refreshPresenceIfVisible();
    } else if (event.data === "REFRESH_INVENTARIS") {
      window.dispatchEvent(
        new CustomEvent("ws-message", { detail: event.data }),
      );
    }
  };

  ws.onclose = () => {
    clearInterval(window._wsHeartbeat);
    updateWsDot(false);

    if (!authToken) return; // Don't reconnect if logged out

    // Socket is down — keep the UI fresh by polling until it comes back.
    startPollingFallback();

    if (_wsRetryCount >= WS_MAX_RETRIES) {
      showToast(
        "Live-sync terputus. Data tetap diperbarui secara berkala.",
        "warning",
      );
      return;
    }

    // Exponential backoff with jitter
    const delay = Math.min(
      WS_BASE_DELAY * Math.pow(2, _wsRetryCount),
      WS_MAX_DELAY,
    );
    const jitter = Math.random() * 1000;
    _wsRetryCount++;

    window._wsReconnectTimer = setTimeout(setupWebSocket, delay + jitter);
  };

  ws.onerror = () => {
    if (!_wsNgrokFailed) {
      _wsNgrokFailed = true;
      console.warn(
        `WebSocket gagal terhubung ke ${protocol}://${window.location.host}/ws/updates`,
      );
    }
    ws.close();
  };

  window._ws = ws;
}

// ── PRESENCE ───────────────────────────────────────────────────────────────
// Tells the server which screen this user is on, so the Pengguna list can show
// live activity. Cheap and fire-and-forget: a closed socket is simply skipped.
let _currentViewId = "";

function reportCurrentView(viewId) {
  if (viewId) _currentViewId = viewId;
  const sock = window._ws;
  if (sock && sock.readyState === WebSocket.OPEN && _currentViewId) {
    try {
      sock.send(`view:${_currentViewId}`);
    } catch (_) {
      /* socket closed mid-send — the next reconnect re-announces */
    }
  }
}

// ── LIVE-DATA POLLING FALLBACK ─────────────────────────────────────────────
// The WebSocket is the primary live-update channel. When it is unavailable
// (proxy drops the upgrade, network flap, retry budget exhausted) we fall back
// to periodic refetches so the page never shows stale data.
const POLL_INTERVAL_MS = 30000;

function startPollingFallback() {
  if (window._dataPollTimer || !authToken) return;
  window._dataPollTimer = setInterval(() => {
    if (!authToken) return stopPollingFallback();
    if (window._ws && window._ws.readyState === WebSocket.OPEN)
      return stopPollingFallback();
    if (document.visibilityState !== "visible") return; // don't poll hidden tabs
    fetchAsetFromServer({ silent: true });
    if (typeof window.refreshAfkirIfVisible === "function")
      window.refreshAfkirIfVisible();
  }, POLL_INTERVAL_MS);
}

function stopPollingFallback() {
  if (window._dataPollTimer) {
    clearInterval(window._dataPollTimer);
    window._dataPollTimer = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && currentUser) {
    fetchAsetFromServer();
    if (!window._ws || window._ws.readyState === WebSocket.CLOSED)
      setupWebSocket();
  }
});

window.addEventListener("resize", () => {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebar-overlay");
  const mainContent = document.getElementById("main-content-area");
  if (!sidebar) return;

  if (window.innerWidth >= 1024) {
    overlay?.classList.remove("active");
    if (sidebar.classList.contains("open")) {
      mainContent?.classList.add("sidebar-open");
    }
  } else {
    mainContent?.classList.remove("sidebar-open");
    if (sidebar.classList.contains("open")) {
      overlay?.classList.add("active");
    }
  }
});

function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebar-overlay");
  const mainContent = document.getElementById("main-content-area");
  const isOpen = sidebar.classList.contains("open");
  const isDesktop = window.innerWidth >= 1024;
  const shouldOpen = !isOpen;

  const chevron = document.getElementById("sidebar-chevron-icon");
  const toggleBtn = document.getElementById("sidebar-toggle-btn");

  if (toggleBtn) {
    toggleBtn.classList.toggle("is-open", shouldOpen);
  }

  if (isOpen) {
    sidebar.classList.remove("open");
    overlay.classList.remove("active");
    if (isDesktop) mainContent.classList.remove("sidebar-open");
    if (chevron) {
      chevron.classList.remove("fa-chevron-right");
      chevron.classList.add("fa-chevron-left");
    }
  } else {
    sidebar.classList.add("open");
    if (isDesktop) {
      mainContent.classList.add("sidebar-open");
    } else {
      overlay.classList.add("active");
    }
    if (chevron) {
      chevron.classList.remove("fa-chevron-left");
      chevron.classList.add("fa-chevron-right");
    }
  }
}

// ── SHARED PAGINATOR ───────────────────────────────────────────────────────
// One implementation for every list in the app.
//
// Slicing is client-side because every payload already arrives fully cached in
// `db` / `_historySummary` / the master arrays — paging is a view concern, not
// a transport one. The single exception is the sparepart movement ledger, an
// append-only table that can outgrow the client, which pages on the server.
//
// TWO RULES, both of which have bitten this codebase:
//   1. Slice AFTER filtering AND sorting. Paging an unsorted list shows the
//      right count of the wrong rows.
//   2. Search must filter the DATA, never hide DOM rows. A `style.display`
//      search only ever sees the current page.

const PAGE_SIZES = [5, 10, 20, 50, 100];
const PAGE_SIZE_DEFAULT = 20;

// key → { page, size }. `size` is a number, or "all".
const _pagerState = new Map();

function _pagerFor(key, defaultSize) {
  if (!_pagerState.has(key)) {
    _pagerState.set(key, { page: 1, size: defaultSize ?? PAGE_SIZE_DEFAULT });
  }
  return _pagerState.get(key);
}

/**
 * Slice an already-filtered, already-sorted array for the current page.
 * Returns the page plus the metadata renderPagerBar() needs.
 */
function paginateList(key, items, defaultSize) {
  const st = _pagerFor(key, defaultSize);
  const total = items.length;
  const size = st.size === "all" ? Math.max(total, 1) : st.size;
  const pages = Math.max(1, Math.ceil(total / size));
  // A filter can shrink the list out from under the current page; clamp rather
  // than render an empty page the user never asked for.
  if (st.page > pages) st.page = pages;
  if (st.page < 1) st.page = 1;
  const start = (st.page - 1) * size;
  return {
    key,
    items: items.slice(start, start + size),
    total,
    pages,
    page: st.page,
    size: st.size,
    from: total ? start + 1 : 0,
    to: Math.min(start + size, total),
  };
}

/** Reset a list to page 1 — call whenever a filter or search term changes. */
function resetPage(key) {
  const st = _pagerState.get(key);
  if (st) st.page = 1;
}

/**
 * Render the controls into `mountId`. `rerender` is the caller's own render
 * function, re-invoked after the state changes so the list and the bar can
 * never disagree about which page is showing.
 */
function renderPagerBar(mountId, meta, rerender) {
  const mount = document.getElementById(mountId);
  if (!mount) return;

  // Nothing to page and nothing to configure — stay out of the way entirely.
  if (meta.total === 0) {
    mount.innerHTML = "";
    return;
  }

  // A compact window around the current page: 1 … 4 5 [6] 7 8 … 20.
  const nums = [];
  const push = (n) => nums.push(n);
  if (meta.pages <= 7) {
    for (let i = 1; i <= meta.pages; i++) push(i);
  } else {
    push(1);
    const lo = Math.max(2, meta.page - 2);
    const hi = Math.min(meta.pages - 1, meta.page + 2);
    if (lo > 2) push("…");
    for (let i = lo; i <= hi; i++) push(i);
    if (hi < meta.pages - 1) push("…");
    push(meta.pages);
  }

  const btn = (label, page, opts = {}) => {
    const { active = false, disabled = false, title = "" } = opts;
    if (label === "…") {
      return '<span class="px-1.5 text-gray-300 dark:text-gray-600 select-none">…</span>';
    }
    const base =
      "min-w-[30px] h-[30px] px-2 inline-flex items-center justify-center rounded-lg text-[11px] font-semibold transition border";
    const cls = active
      ? "bg-kai-blue text-white border-kai-blue"
      : disabled
        ? "text-gray-300 dark:text-gray-600 border-transparent cursor-not-allowed"
        : "text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600 hover:border-kai-blue";
    return `<button type="button" class="pager-btn ${base} ${cls}" data-page="${page}" ${
      disabled ? "disabled" : ""
    } ${title ? `title="${title}"` : ""}>${label}</button>`;
  };

  mount.innerHTML = `
    <div class="flex flex-wrap items-center gap-3 px-4 py-3 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl shadow-sm">
      <p class="text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">
        Menampilkan <span class="font-bold text-gray-700 dark:text-gray-200">${meta.from}–${meta.to}</span>
        dari <span class="font-bold text-gray-700 dark:text-gray-200">${meta.total.toLocaleString("id-ID")}</span>
      </p>
      <div class="flex items-center gap-1.5 ml-auto">
        ${btn('<i class="fas fa-angle-double-left"></i>', 1, { disabled: meta.page === 1, title: "Halaman pertama" })}
        ${btn('<i class="fas fa-angle-left"></i>', meta.page - 1, { disabled: meta.page === 1, title: "Sebelumnya" })}
        ${nums.map((n) => btn(String(n), n, { active: n === meta.page })).join("")}
        ${btn('<i class="fas fa-angle-right"></i>', meta.page + 1, { disabled: meta.page === meta.pages, title: "Berikutnya" })}
        ${btn('<i class="fas fa-angle-double-right"></i>', meta.pages, { disabled: meta.page === meta.pages, title: "Halaman terakhir" })}
      </div>
      <div class="flex items-center gap-2">
        <label class="text-[10px] font-bold tracking-widest text-gray-400 uppercase">Per Halaman</label>
        <select class="pager-size text-[11px] px-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 outline-none focus:border-kai-blue transition font-semibold cursor-pointer">
          ${PAGE_SIZES.map(
            (s) => `<option value="${s}"${meta.size === s ? " selected" : ""}>${s}</option>`,
          ).join("")}
          <option value="all"${meta.size === "all" ? " selected" : ""}>Semua</option>
        </select>
      </div>
    </div>`;

  const st = _pagerFor(meta.key);
  mount.querySelectorAll(".pager-btn").forEach((b) => {
    b.addEventListener("click", () => {
      const target = parseInt(b.dataset.page, 10);
      if (isNaN(target) || target < 1 || target > meta.pages || target === st.page) return;
      st.page = target;
      rerender();
    });
  });
  mount.querySelector(".pager-size")?.addEventListener("change", function () {
    st.size = this.value === "all" ? "all" : parseInt(this.value, 10);
    // Page size changed — the old page number points somewhere meaningless.
    st.page = 1;
    rerender();
  });
}

// ── RENDER & DISPLAY ───────────────────────────────────────────────────────

window.openEdit = (uid) => {
  const item = db.find((x) => x.id_aset === uid);
  if (!item) return;

  document.getElementById("form-edit").reset();
  document.getElementById("form-kalib")?.reset();

  const _v = (id) => document.getElementById(id);

  // ── Shared derived values ──
  const dec = decodeAsetId(item.id_aset);
  const parentCode = getParentLokasiCode(item.id_lokasi) || item.id_lokasi;
  const lokasiName =
    item.id_lokasi_name ||
    lokasiData.find((l) => l.code === parentCode)?.name ||
    item.id_lokasi ||
    "—";

  const summaryItem = _historySummary.find((x) => x.id_aset === uid);
  const rawLokasiCode = summaryItem?.repair?.latest_id_lokasi || item.id_lokasi;
  const lastUptEntry = uptDatabase.find((u) => u.upt === rawLokasiCode);
  const lastUpt = lastUptEntry ? lastUptEntry.nama : rawLokasiCode || "—";

  // ── Populate form hidden fields & basic labels ──
  if (_v("edit-uid")) _v("edit-uid").value = item.id_aset;
  if (_v("edit-subtitle"))
    _v("edit-subtitle").innerText = `${item.id_aset} | ${item.kode_alat}`;
  if (_v("kalib-subtitle"))
    _v("kalib-subtitle").innerText = `${item.id_aset} | ${item.kode_alat}`;
  if (_v("edit-teknisi")) _v("edit-teknisi").value = currentUser;
  if (_v("kalib-teknisi")) _v("kalib-teknisi").value = currentUser;
  if (_v("edit-kondisi")) _v("edit-kondisi").value = "";

  // Pre-select peruntukan radio — radio values are A/B/C/D, stored value is full name
  const _PERUNTUKAN_REV = { "JALAN REL": "A", "JEMBATAN": "B", "MEKANIK": "C", "BALAIYASA": "D" };
  const preselectedUnit = _PERUNTUKAN_REV[item.peruntukan] || item.peruntukan || "";
  document.querySelectorAll('input[name="edit-unit"]').forEach((r) => {
    r.checked = r.value === preselectedUnit;
  });

  // ── Populate summary card ──
  const uptCodeForCard = item.id_lokasi || "";
  const uptEntryForCard = uptDatabase.find((u) => u.upt === uptCodeForCard);
  const uptDisplayForCard = uptEntryForCard
    ? uptEntryForCard.nama
    : item.id_lokasi_display || uptCodeForCard || "—";
  const kodePeruntukan = dec.peruntukan;
  const peruntukanName =
    item.unit_peruntukan && item.unit_peruntukan !== "—"
      ? item.unit_peruntukan
      : PERUNTUKAN_MAP[kodePeruntukan] || kodePeruntukan || "—";
  const tanggalBeli = item.tanggal_pembelian
    ? new Date(item.tanggal_pembelian).toLocaleDateString("id-ID", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";
  const statusBadgeCls =
    item.status_terakhir === "SO"
      ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
      : item.status_terakhir === "TSO"
        ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
        : "bg-blue-100 text-blue-700";

  if (_v("edit-card-id")) _v("edit-card-id").textContent = item.id_aset;
  if (_v("edit-card-nama"))
    _v("edit-card-nama").textContent = item.kode_alat_name || item.kode_alat;
  if (_v("edit-card-lokasi")) _v("edit-card-lokasi").textContent = lokasiName;
  if (_v("edit-card-upt")) _v("edit-card-upt").textContent = uptDisplayForCard;
  if (_v("edit-card-tgl")) _v("edit-card-tgl").textContent = tanggalBeli;
  if (_v("edit-card-peruntukan"))
    _v("edit-card-peruntukan").textContent = peruntukanName;
  if (_v("edit-card-varian"))
    _v("edit-card-varian").textContent = item.nama_varian || "—";
  const statusEl = _v("edit-card-status");
  if (statusEl) {
    statusEl.textContent = item.status_terakhir;
    statusEl.className = `text-[10px] font-bold px-2 py-0.5 rounded-full ${statusBadgeCls}`;
  }

  // ── "Sebelumnya di" labels ──
  const lokasiLabelEl = document.getElementById("edit-lokasi-label");
  const uptLabelEl = document.getElementById("edit-upt-label");
  if (lokasiLabelEl)
    lokasiLabelEl.textContent = `Lokasi Perbaikan (sebelumnya di: ${lokasiName})`;
  if (uptLabelEl)
    uptLabelEl.textContent = `UPT Pengirim (sebelumnya di: ${lastUpt})`;

  // ── Populate UPT dropdowns based on the asset's parent location ──
  const editUpt = document.getElementById("edit-upt");
  const editLokasiEl = document.getElementById("edit-lokasi");
  const currentUptCode = item.id_lokasi_raw || item.id_lokasi || "";
  const initialParentLoc = getParentLokasiCode(currentUptCode) || currentUptCode || "";

  // Pre-set the Lokasi dropdown so it submits the correct parent code
  if (editLokasiEl && initialParentLoc) {
    editLokasiEl.value = initialParentLoc;
  }
  if (editUpt) {
    applyUptSelect(initialParentLoc, editUpt);
    // Pre-select the exact UPT the asset is currently assigned to
    if (currentUptCode && editUpt.querySelector(`option[value="${currentUptCode}"]`)) {
      editUpt.value = currentUptCode;
    }
  }

  const kalibLokasi = document.getElementById("kalib-lokasi");
  const kalibUpt = document.getElementById("kalib-upt");
  if (kalibLokasi) kalibLokasi.value = "";
  if (kalibUpt) {
    applyUptSelect(initialParentLoc, kalibUpt);
  }

  // ── Reset SO/TSO buttons & switch to default tab ──
  document.querySelectorAll("#panel-perbaikan .status-btn").forEach((btn) => {
    btn.classList.remove("is-so", "is-tso", "is-idle");
    btn.classList.add("is-idle");
  });
  _switchEditFormTab("perbaikan");

  switchView("edit");
};

function _switchEditFormTab(tab) {
  const ACTIVE_REPAIR = [
    "bg-kai-blue",
    "text-white",
    "font-semibold",
    "shadow-sm"
  ];
  const INACTIVE_REPAIR = [
    "text-gray-500",
    "dark:text-gray-400",
    "font-medium",
    "hover:bg-blue-100",
    "hover:text-kai-blue",
    "dark:hover:bg-blue-900/20",
    "dark:hover:text-blue-300",
  ];
  const ACTIVE_KALIB = [
    "bg-cyan-600",
    "text-white",
    "font-semibold",
    "shadow-sm"
  ];
  const INACTIVE_KALIB = [
    "text-gray-500",
    "dark:text-gray-400",
    "font-medium",
    "hover:bg-cyan-100",
    "hover:text-cyan-700",
    "dark:hover:bg-cyan-900/20",
    "dark:hover:text-cyan-300",
  ];

  const repairBtn = document.getElementById("edit-tab-perbaikan");
  const kalibBtn = document.getElementById("edit-tab-kalibrasi");

  if (repairBtn) {
    [...ACTIVE_REPAIR, ...INACTIVE_REPAIR, ...ACTIVE_KALIB, ...INACTIVE_KALIB].forEach((c) => repairBtn.classList.remove(c));
    (tab === "perbaikan" ? ACTIVE_REPAIR : INACTIVE_REPAIR).forEach((c) => repairBtn.classList.add(c));
  }

  if (kalibBtn) {
    [...ACTIVE_REPAIR, ...INACTIVE_REPAIR, ...ACTIVE_KALIB, ...INACTIVE_KALIB].forEach((c) => kalibBtn.classList.remove(c));
    (tab === "kalibrasi" ? ACTIVE_KALIB : INACTIVE_KALIB).forEach((c) => kalibBtn.classList.add(c));
  }
  
  document.getElementById("panel-perbaikan")?.classList.toggle("hidden", tab !== "perbaikan");
  document.getElementById("panel-kalibrasi")?.classList.toggle("hidden", tab !== "kalibrasi");
}

window.openHistoryDetail = async (uid, tab = "repair") => {
  activeHistoryUid = uid;
  const item =
    _historySummary.find((x) => x.id_aset === uid) ||
    db.find((x) => x.id_aset === uid);
  if (!item) return;

  document.getElementById("hist-detail-subtitle").innerText = `${item.id_aset}`;
  switchView("history-detail");
  switchDetailTab(tab, uid);
};

// NOTE: an earlier window.openQrModal was defined here and immediately shadowed
// by the async version further down (which uses drawQrOnCanvas/buildLandingUrl).
// It also still pointed QR links at the old tunnel variable.

window.deleteAset = async (uid) => {
  const item = db.find((x) => x.id_aset === uid);
  if (!item) return;

  const confirmed = await customConfirm(
    `Hapus aset "${uid}"?\n\nAset akan di-afkir dan tidak muncul di dashboard.\nRiwayat perbaikan dan mutasi tetap tersimpan.`,
  );
  if (!confirmed) return;

  const reconfirmed = await customConfirm(
    `Konfirmasi terakhir: aset "${uid}" akan dihapus permanen dari tampilan aktif.\n\nUntuk memulihkan kembali aset ini (ataupun menghapus secara permanen), silakan merujuk pada menu Pulihkan Aset Afkir dan pulihkan dari menu tersebut.`,
  );
  if (!reconfirmed) return;

  try {
    const res = await apiFetch(`/aset/afkir/${uid}`, { method: "POST" });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Gagal menghapus aset.");
    }
    showToast(`Aset ${uid} berhasil dihapus.`, "success");
    await fetchAsetFromServer();
  } catch (e) {
    showToast(e.message, "error");
  }
};

function switchDetailTab(tab, uid) {
  const ACTIVE_REPAIR   = ["bg-kai-blue", "text-white", "font-semibold", "shadow-sm"];
  const INACTIVE_REPAIR = ["text-gray-500", "dark:text-gray-400", "font-medium", "hover:bg-blue-100", "hover:text-kai-blue", "dark:hover:bg-blue-900/20", "dark:hover:text-blue-300"];
  const ACTIVE_KALIB    = ["bg-cyan-600", "text-white", "font-semibold", "shadow-sm"];
  const INACTIVE_KALIB  = ["text-gray-500", "dark:text-gray-400", "font-medium", "hover:bg-cyan-100", "hover:text-cyan-700", "dark:hover:bg-cyan-900/20", "dark:hover:text-cyan-300"];
  const ACTIVE_MUTASI   = ["bg-kai-orange", "text-white", "font-semibold", "shadow-sm"];
  const INACTIVE_MUTASI = ["text-gray-500", "dark:text-gray-400", "font-medium", "hover:bg-orange-100", "hover:text-kai-orange", "dark:hover:bg-orange-900/20", "dark:hover:text-orange-300"];

  const ALL = [...ACTIVE_REPAIR, ...INACTIVE_REPAIR, ...ACTIVE_KALIB, ...INACTIVE_KALIB, ...ACTIVE_MUTASI, ...INACTIVE_MUTASI];

  const tabCfg = {
    repair:    { active: ACTIVE_REPAIR,  inactive: INACTIVE_REPAIR  },
    kalibrasi: { active: ACTIVE_KALIB,   inactive: INACTIVE_KALIB   },
    mutasi:    { active: ACTIVE_MUTASI,  inactive: INACTIVE_MUTASI  },
  };

  ["repair", "kalibrasi", "mutasi"].forEach((t) => {
    const btn = document.getElementById(`detail-tab-${t}`);
    if (!btn) return;
    ALL.forEach((c) => btn.classList.remove(c));
    (t === tab ? tabCfg[t].active : tabCfg[t].inactive).forEach((c) => btn.classList.add(c));
  });

  document.getElementById("detail-panel-repair")?.classList.toggle("hidden", tab !== "repair");
  document.getElementById("detail-panel-kalibrasi")?.classList.toggle("hidden", tab !== "kalibrasi");
  document.getElementById("detail-panel-mutasi")?.classList.toggle("hidden", tab !== "mutasi");

  if (tab === "repair") loadDetailRepair(uid);
  if (tab === "kalibrasi") loadDetailKalibrasi(uid);
  if (tab === "mutasi") loadDetailMutasi(uid);
}

async function loadDetailRepair(uid) {
  const tbody = document.getElementById("hist-repair-tbody");
  tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-gray-500"><i class="fas fa-spinner fa-spin mr-2"></i>Mengambil data...</td></tr>`;
  try {
    const res = await apiFetch(`/riwayat-kondisi/${uid}`);
    if (!res.ok) throw new Error("Gagal mengambil riwayat.");
    const history = await res.json();
    if (!history.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="p-4 text-center text-gray-500">Belum ada riwayat perbaikan.</td></tr>`;
      return;
    }

    // Filter out KALIBRASI entries — they belong to the Kalibrasi tab only
    const repairEntries = history.filter((h) => h.kondisi !== "KALIBRASI");

    if (!repairEntries.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="p-4 text-center text-gray-500">Belum ada riwayat perbaikan (SO/TSO).</td></tr>`;
      return;
    }

    const asetTerkait = db.find((x) => x.id_aset === uid);

    const resolveLokasiCode = (kode) => {
      if (!kode) return { parentName: "—", uptName: "—" };
      const uptEntry = uptDatabase.find((u) => u.upt === kode);
      if (uptEntry) {
        const parentCode = getParentLokasiCode(kode) || uptEntry.lokasi;
        const parentEntry = lokasiData.find((l) => l.code === parentCode);
        return { parentName: parentEntry ? parentEntry.name : parentCode, uptName: uptEntry.nama };
      }
      const parentEntry = lokasiData.find((l) => l.code === kode);
      if (parentEntry) return { parentName: parentEntry.name, uptName: "—" };
      return { parentName: kode, uptName: "—" };
    };

    tbody.innerHTML = repairEntries
      .map((h, i) => {
        // Use the per-row id_lokasi now returned by the backend.
        // Fall back to the asset's current lokasi for legacy rows that predate the schema change.
        const rowLokasi = h.id_lokasi || asetTerkait?.id_lokasi_raw || asetTerkait?.id_lokasi || "";
        const lokasi = resolveLokasiCode(rowLokasi);

        // Use per-row peruntukan from backend; fall back to asset's current value for legacy rows.
        const peruntukanName = h.peruntukan || asetTerkait?.peruntukan || "—";

        return `
            <tr class="border-b dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td class="p-3 text-center text-gray-400">${i + 1}</td>
                <td class="p-3 font-mono text-xs">${formatUtcToLocal(h.waktu_lapor)}</td>
                <td class="p-3 text-sm">${lokasi.parentName}</td>
                <td class="p-3 text-sm">${lokasi.uptName}</td>
                <td class="p-3 text-center">
                    <span class="text-xs text-gray-600 dark:text-gray-300 capitalize">${peruntukanName}</span>
                </td>
                <td class="p-3 text-sm font-medium">${h.id_pengguna}</td>
                <td class="p-3 text-center">
                    <span class="text-xs font-bold px-2 py-0.5 rounded ${h.kondisi === "SO" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"}">${h.kondisi}</span>
                </td>
                <td class="p-3 text-xs text-gray-500 whitespace-pre-wrap">${h.keterangan || "—"}</td>
            </tr>`;
      })
      .join("");
  } catch (e) {
    if (e.message !== "Unauthorized")
      tbody.innerHTML = `<tr><td colspan="8" class="p-4 text-center text-red-500">${e.message}</td></tr>`;
  }
}

async function loadDetailKalibrasi(uid) {
  const tbody = document.getElementById("hist-kalibrasi-tbody");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="8" class="p-4 text-center text-gray-500"><i class="fas fa-spinner fa-spin mr-2"></i>Mengambil data...</td></tr>`;
  try {
    const res = await apiFetch(`/kalibrasi/${uid}`);
    if (!res.ok) throw new Error("Gagal mengambil riwayat kalibrasi.");
    const history = await res.json();
    if (!history.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="p-4 text-center text-gray-500">Belum ada riwayat kalibrasi.</td></tr>`;
      return;
    }
    tbody.innerHTML = history
      .map((h) => {
        const statusClass =
          h.status === "LULUS"
            ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
            : h.status === "GAGAL"
              ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
              : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";
        return `
          <tr class="border-b dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50">
            <td class="p-3 text-center text-gray-400">${h.no}</td>
            <td class="p-3 font-mono text-xs">${formatUtcToLocal(h.waktu_input)}</td>
            <td class="p-3 font-mono text-xs">${h.tanggal_kalibrasi ? formatDateOnly(h.tanggal_kalibrasi) : "—"}</td>
            <td class="p-3 font-mono text-xs">${h.tanggal_berlaku ? formatDateOnly(h.tanggal_berlaku) : "—"}</td>
            <td class="p-3 text-sm text-center">
              <span class="text-xs font-bold px-2 py-0.5 rounded ${statusClass}">${h.status || "—"}</span>
            </td>
            <td class="p-3 text-sm">${h.pelaksana_kalibrasi || "—"}</td>
            <td class="p-3 text-sm">${h.nomor_sertifikat || "—"}</td>
            <td class="p-3 text-xs text-gray-500 whitespace-pre-wrap">${h.keterangan || "—"}</td>
          </tr>`;
      })
      .join("");
  } catch (e) {
    if (e.message !== "Unauthorized")
      tbody.innerHTML = `<tr><td colspan="8" class="p-4 text-center text-red-500">${e.message}</td></tr>`;
  }
}

async function loadDetailMutasi(uid) {
  const timeline = document.getElementById("mutasi-timeline");
  const originBar = document.getElementById("mutasi-origin-bar");
  timeline.innerHTML = `<div class="text-center text-gray-400 py-6"><i class="fas fa-spinner fa-spin mr-2"></i>Mengambil data...</div>`;
  originBar.innerHTML = "";

  try {
    const res = await apiFetch(`/mutasi/${uid}`);
    if (!res.ok) throw new Error("Gagal mengambil riwayat mutasi.");
    const data = await res.json();

    const returnedBadge = data.sudah_kembali
      ? `<span class="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-3 py-1 rounded-full text-xs font-bold">✓ Sudah Kembali ke Lokasi Awal</span>`
      : `<span class="bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 px-3 py-1 rounded-full text-xs font-bold">⟳ Belum Kembali ke Asal</span>`;

    const asal = resolveLokasi(data.original_lokasi);
    const kini = resolveLokasi(data.lokasi_sekarang);

    originBar.innerHTML = `
        <div class="flex-1 min-w-0">
            <p class="font-bold text-xs text-gray-400">Lokasi Asal</p>
            <p class="font-bold text-base text-gray-700 dark:text-gray-200">${asal.parentName}</p>
            <p class="font-bold text-sm text-gray-700 dark:text-gray-200 mt-0.5">${asal.uptName !== "—" ? `${asal.uptName} (${asal.uptCode})` : "—"}</p>
        </div>
        <div class="flex-1 min-w-0">
            <p class="font-bold text-xs text-gray-400">Lokasi Sekarang</p>
            <p class="font-bold text-base text-gray-700 dark:text-gray-200">${kini.parentName}</p>
            <p class="font-bold text-sm text-gray-700 dark:text-gray-200 mt-0.5">${kini.uptName !== "—" ? `${kini.uptName} (${kini.uptCode})` : "—"}</p>
        </div>
        ${returnedBadge}
    `;

    if (!data.mutasi || !data.mutasi.length) {
      timeline.innerHTML = `<div class="text-center text-gray-400 py-6">Belum ada riwayat mutasi.</div>`;
      return;
    }

    timeline.innerHTML = data.mutasi
      .map((m, i) => {
        const isLast = i === data.mutasi.length - 1;

        // Resolve lokasi untuk setiap tahapan mutasi
        const mutAsal = resolveLokasi(m.id_lokasi_asal);
        const mutTuju = resolveLokasi(m.id_lokasi_tujuan);

        // Hitung durasi di lokasi tertentu
        let durasi = "";
        if (!isLast) {
          const tCurr = new Date(m.waktu_mutasi.replace(" ", "T")).getTime();
          const tNext = new Date(
            data.mutasi[i + 1].waktu_mutasi.replace(" ", "T"),
          ).getTime();
          const days = Math.floor((tNext - tCurr) / (1000 * 60 * 60 * 24));
          durasi = days === 0 ? "kurang dari 1 hari" : `${days} hari`;
        }

        return `
        <div class="flex gap-4 items-start">
            <div class="flex flex-col items-center">
                <div class="w-8 h-8 rounded-full bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 flex items-center justify-center text-xs font-bold shrink-0">${i + 1}</div>
                ${!isLast ? '<div class="w-0.5 flex-1 bg-gray-200 dark:bg-gray-700 mt-1"></div>' : ""}
            </div>
            <div class="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4 flex-1 mb-2 space-y-1.5 text-sm">
                <div>
                    <span class="font-bold text-orange-600 dark:text-orange-400">
                        ${mutAsal.parentName} (${mutAsal.uptName !== "—" ? `${mutAsal.uptName}` : "—"})
                    </span>
                    <i class="fas fa-arrow-right text-base"></i>
                    <span class="font-bold text-orange-600 dark:text-orange-400">
                        ${mutTuju.parentName} (${mutTuju.uptName !== "—" ? `${mutTuju.uptName}` : "—"})
                    </span>
                </div>
                <p class="text-xs text-gray-500 text-sm">Waktu Mutasi: <span class="font-semibold">${formatUtcToLocal(m.waktu_mutasi)}</span></p>
                ${
                  durasi
                    ? `<p class="text-xs text-gray-500">Durasi di lokasi ini: <span class="font-semibold">${durasi}</span></p>`
                    : `<p class="text-xs text-gray-500">Durasi di lokasi ini: <span class="font-semibold italic">Masih dalam proses mutasi...</span></p>`
                }
                <p class="text-xs text-gray-600 dark:text-gray-400">Nama Petugas: <span class="font-semibold">${m.nama_petugas || "—"}</span></p>
                <p class="text-xs text-gray-600 dark:text-gray-400">Alasan Mutasi: <span class="font-bold">${m.alasan_mutasi || "—"}</span></p>
            </div>
        </div>`;
      })
      .join("");
  } catch (e) {
    if (e.message !== "Unauthorized")
      timeline.innerHTML = `<div class="text-center text-red-400 py-6">${e.message}</div>`;
  }
}

// ── SHARED ASSET-CARD LOOK ─────────────────────────────────────────────────
// One definition so the Kelola Data Aset cards and the Pulihkan Aset Afkir
// cards cannot drift apart again.
const ASSET_CARD_CLASS =
  "bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 flex flex-col justify-between hover:border-kai-blue dark:hover:border-kai-orange transition-colors";

const cardDetailRow = (label, val) =>
  `<div class="flex gap-2 text-xs"><span class="text-gray-400 w-28 shrink-0">${label}</span><span class="text-gray-700 dark:text-gray-200 font-medium">${val}</span></div>`;

// Total recorded activity for an asset: repair events + transfers. Backed by
// the counts the summary endpoint now returns, so "urutkan menurut jumlah"
// finally has real numbers behind it.
function _eventCount(item) {
  const s = _historySummary.find((x) => x.id_aset === item.id_aset);
  if (!s) return 0;
  return (s.repair?.count || 0) + (s.mutasi?.count || 0);
}

// Procurement source is compared loosely because the value has been written two
// ways over the project's life — "DAOP/DIVRE" and "DAOP / DIVRE". Comparing
// strictly made every pengadaan filter miss whichever spelling it wasn't
// written against. Normalising whitespace here fixes all four sort modals at
// once and survives whichever spelling arrives next.
function _pengadaanMatches(value, wanted) {
  if (!wanted) return true;
  const norm = (s) => (s || "").toString().toUpperCase().replace(/\s+/g, "");
  return norm(value).includes(norm(wanted));
}

// KPI tiles for Kelola Data Aset. Deliberately scoped to the filtered list
// rather than the whole fleet: the tiles sit directly above the cards they
// summarise, so a figure describing a different set would simply read as wrong.
function _renderDbStats(items, mode, myRegion) {
  const set = (id, value) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  };
  const total = items.length;
  const so = items.filter((i) => (i.status_terakhir || "").toUpperCase() === "SO").length;
  const tso = items.filter((i) => (i.status_terakhir || "").toUpperCase() === "TSO").length;

  set("db-stat-total", total.toLocaleString("id-ID"));
  set("db-stat-so", so.toLocaleString("id-ID"));
  set("db-stat-tso", tso.toLocaleString("id-ID"));
  set("db-stat-avail", total ? `${((so / total) * 100).toFixed(1)}%` : "—");
  set("db-stat-total-note", `dari ${db.length.toLocaleString("id-ID")} terdaftar`);

  // Scope line mirrors the two dashboards' header: which slice is on screen.
  const scope =
    mode === "local" && myRegion
      ? lokasiData.find((l) => l.code === myRegion)?.name || myRegion
      : "Seluruh Wilayah";
  set("db-scope-label", scope);
  const now = new Date();
  set(
    "db-dateline",
    `${now.getDate()} ${BULAN_PANJANG[now.getMonth()]} ${now.getFullYear()}`,
  );
}

function renderDbCards() {
  const container = document.getElementById("db-cards-container");
  const searchInput = document.getElementById("search-db");
  const modeSelect = document.getElementById("filter-mode");
  if (!container) return;

  container.innerHTML = "";

  const isTeknisi = _currentRole === "TEKNISI";
  if (modeSelect) modeSelect.style.display = isTeknisi ? "none" : "";

  const searchQ = (searchInput?.value || "").toUpperCase();
  // "Aset Saya" narrows the list to the region the logged-in user belongs to.
  // (This select was previously read into an unused variable, so the control
  // did nothing at all.)
  const mode = isTeknisi ? "public" : modeSelect ? modeSelect.value : "public";
  const myLokasiRaw = getJwtPayload(authToken)?.id_lokasi || "";
  const myRegion = getParentLokasiCode(myLokasiRaw) || myLokasiRaw;
  const isAdmin =
    _currentRole === "SUPER_ADMIN" || _currentRole === "ADMIN_WILAYAH";

  const filteredItems = db.filter((item) => {
    if (mode === "local" && myRegion) {
      const raw = item.id_lokasi_raw || item.id_lokasi || "";
      const parent = getParentLokasiCode(raw) || raw;
      if (parent !== myRegion && raw !== myLokasiRaw) return false;
    }
    const searchQ_upper = searchQ;
    const matchSearch =
      (item.id_aset || "").toUpperCase().includes(searchQ_upper) ||
      (item.kode_alat || "").toUpperCase().includes(searchQ_upper) ||
      (item.kode_alat_name || "").toUpperCase().includes(searchQ_upper) ||
      (item.id_lokasi || "").toUpperCase().includes(searchQ_upper) ||
      (item.id_lokasi_display || "").toUpperCase().includes(searchQ_upper) ||
      (item.sumber_pengadaan || "").toUpperCase().includes(searchQ_upper) ||
      (item.status_terakhir || "").toUpperCase().includes(searchQ_upper) ||
      (item.peruntukan || "").toUpperCase().includes(searchQ_upper) ||
      (item.tanggal_pembelian || "").toUpperCase().includes(searchQ_upper);
    if (!matchSearch) return false;

    // Apply custom sort filters
    const f = _sortFilters;
    if (f.alat && item.kode_alat !== f.alat)
        return false;
    if (!_pengadaanMatches(item.sumber_pengadaan, f.pengadaan)) return false;
    if (f.peruntukan) {
      const dec = decodeAsetId(item.id_aset);
      if (dec.peruntukan !== f.peruntukan)
        return false;
    }
    if (f.lokasi) {
      const _rawUpt = item.id_lokasi_raw || item.id_lokasi || "";
      const _parent = getParentLokasiCode(_rawUpt) || _rawUpt;
      if (_parent !== f.lokasi && _rawUpt !== f.lokasi) return false;
    }
    if (f.upt && item.id_lokasi_raw !== f.upt && item.id_lokasi !== f.upt)
        return false;
    if (f.tahunFrom || f.tahunTo) {
      const yr = parseInt((item.tanggal_pembelian || "").slice(0, 4));
      if (f.tahunFrom && yr < parseInt(f.tahunFrom))
        return false;
      if (f.tahunTo && yr > parseInt(f.tahunTo))
        return false;
    }
    if (f.idFrom || f.idTo) {
      const num = parseInt((item.id_aset || "").split(".")[0]) || 0;
      if (f.idFrom && num < f.idFrom)
        return false;
      if (f.idTo && num > f.idTo)
        return false;
    }
    return true;
  });

  // Stats describe the whole FILTERED set, not the current page — they answer
  // "how much matches", which paging must not change. Updated before the
  // empty-state return, or a search that matches nothing would leave the
  // previous filter's numbers standing.
  _renderDbStats(filteredItems, mode, myRegion);

  if (!filteredItems.length) {
    renderPagerBar("db-pager", paginateList("db", filteredItems), renderDbCards);
    container.innerHTML = `<div class="col-span-full text-center text-gray-400 py-12"><i class="fas fa-inbox text-3xl mb-2 block"></i>Tidak ada aset alat kerja yang cocok dengan filter ini.</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();

  // Sort the FULL filtered list first, then slice — paging an unsorted list
  // shows the right number of the wrong cards.
  const _dbSorted = filteredItems
    .sort((a, b) => {
      if (_sortDir === "date-desc") {
        return new Date(b.tanggal_pembelian || 0) - new Date(a.tanggal_pembelian || 0);
      }
      if (_sortDir === "date-asc") {
        return new Date(a.tanggal_pembelian || 0) - new Date(b.tanggal_pembelian || 0);
      }
      // Real event counts. This used to count how many SUMMARY ROWS matched the
      // asset — and the summary holds exactly one row per asset, so every score
      // was 1 and the two "jumlah" directions did nothing at all.
      if (_sortDir === "count-desc") return _eventCount(b) - _eventCount(a);
      if (_sortDir === "count-asc") return _eventCount(a) - _eventCount(b);
      const av = (a[_sortField] || "").toString().toUpperCase();
      const bv = (b[_sortField] || "").toString().toUpperCase();
      return _sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    });

  const _dbPage = paginateList("db", _dbSorted);
  renderPagerBar("db-pager", _dbPage, renderDbCards);

  _dbPage.items
    .forEach((item) => {
      const isSuperAdmin = _currentRole === "SUPER_ADMIN";
      const isAdminWilayah = _currentRole === "ADMIN_WILAYAH";
      const canDelete = isSuperAdmin || isAdminWilayah;

      const summaryItem = _historySummary.find((x) => x.id_aset === item.id_aset);

      // Decode original data dari id_aset menggunakan fungsi yang baru
      const dec = decodeAsetId(item.id_aset);

      // Peruntukan: Prioritas 1 dari database, Prioritas 2 ekstrak dari ID aset
      const peruntukanName = item.peruntukan ? item.peruntukan : "—";

      // --- REVISI LOGIKA LOKASI MURNI ---
      const rawUptCode =
        summaryItem?.mutasi?.original_lokasi_code || item.id_lokasi_raw || item.id_lokasi || "";
      const parentCode = getParentLokasiCode(rawUptCode) || rawUptCode;

      // Lokasi Induk (DAOP/DIVRE)
      const lokasiName =
        lokasiData.find((l) => l.code === parentCode)?.name ||
        summaryItem?.mutasi?.original_lokasi_name ||
        item.lokasi_name ||
        item.id_lokasi_name ||
        parentCode ||
        "—";

      // UPT — show em-dash when the stored code is a parent Lokasi (not a UPT)
      const uptEntry = uptDatabase.find((u) => u.upt === rawUptCode);
      const isDirectLokasi = !uptEntry && !!lokasiData.find((l) => l.code === rawUptCode);
      const uptDisplay = uptEntry
        ? `${uptEntry.nama}`
        : isDirectLokasi
          ? "—"
          : summaryItem?.mutasi?.original_lokasi_name || item.lokasi_name || "—";

      const tahunFull = dec.tahun
        ? dec.tahun.length === 2
          ? parseInt(dec.tahun) <= 30
            ? `20${dec.tahun}`
            : `19${dec.tahun}`
          : dec.tahun
        : "—";

      const tanggalBeli = item.tanggal_pembelian
        ? new Date(item.tanggal_pembelian).toLocaleDateString("id-ID", {
            day: "2-digit",
            month: "long",
            year: "numeric",
          })
        : tahunFull;

      // Badge 1: SO / TSO
      const isSO = item.status_terakhir === "SO";
      const kondisiBadge = isSO
        ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"><i class="fas fa-circle text-[6px]"></i>SO</span>`
        : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"><i class="fas fa-circle text-[6px]"></i>TSO</span>`;

      // Badge 2: Kalibrasi status
      const kalibStatus = summaryItem?.kalibrasi?.latest_status;
      const kalibBadge = kalibStatus === "LULUS"
        ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"><i class="fas fa-circle text-[6px]"></i>LULUS</span>`
        : kalibStatus === "BERSYARAT"
        ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"><i class="fas fa-circle text-[6px]"></i>BERSYARAT</span>`
        : kalibStatus === "GAGAL"
        ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400"><i class="fas fa-circle text-[6px]"></i>GAGAL</span>`
        : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-gray-100 text-gray-400 dark:bg-gray-700 dark:text-gray-500"><i class="fas fa-circle text-[6px]"></i>BLM KALIBRASI</span>`;

      // Badge 3: Mutasi status
      const mutasiInfo = summaryItem?.mutasi;
      const mutasiBadge = (mutasiInfo && mutasiInfo.count > 0)
        ? mutasiInfo.sudah_kembali
          ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"><i class="fas fa-circle text-[6px]"></i>DI LOKASI ASAL</span>`
          : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"><i class="fas fa-circle text-[6px]"></i>SEDANG TERMUTASI</span>`
        : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-gray-100 text-gray-400 dark:bg-gray-700 dark:text-gray-500"><i class="fas fa-circle text-[6px]"></i>TIDAK TERMUTASI</span>`;

      const statusBadgeCls =
        item.status_terakhir === "SO"
          ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
          : item.status_terakhir === "TSO"
            ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
            : "bg-blue-100 text-blue-700";

      const row = cardDetailRow;

      const card = document.createElement("div");
      card.className = ASSET_CARD_CLASS;

      card.innerHTML = `
            <div>
                <div class="flex justify-between items-start gap-2">
                    <div class="flex flex-col min-w-0">
                        <span class="text-base font-bold font-mono text-kai-blue dark:text-blue-400 leading-tight">${item.id_aset}</span>
                        <p class="text-sm text-gray-700 dark:text-gray-300 font-semibold mt-0.5">${item.kode_alat_name || item.kode_alat}</p>
                    </div>
                    <div class="flex items-start gap-1.5 shrink-0">
                        <div class="flex flex-col items-end gap-1">
                            ${kondisiBadge}
                            ${kalibBadge}
                            ${mutasiBadge}
                        </div>
                        ${
                          canDelete
                            ? `<button onclick="window.deleteAset('${item.id_aset}')"
                            title="Hapus aset (afkir)" aria-label="Hapus aset ${item.id_aset}"
                            class="w-7 h-7 flex items-center justify-center rounded-lg text-gray-300 dark:text-gray-600 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition shrink-0">
                            <i class="fas fa-trash-alt text-xs"></i>
                        </button>`
                            : ""
                        }
                    </div>
                </div>

                <div class="mt-3 space-y-1 border-t border-gray-100 dark:border-gray-700 pt-3 capitalize">
                    ${row("Pengadaan", PENGADAAN_MAP[item.sumber_pengadaan] || item.sumber_pengadaan || "—")}
                    ${row("Tanggal Beli", tanggalBeli)}
                    ${row("Lokasi", lokasiName)}
                    ${row("UPT", uptDisplay)}
                    ${row("Peruntukan", peruntukanName)}
                    ${row("Spesifikasi Teknis", item.nama_varian || "—")}
                </div>
            </div>
            <div class="mt-4 space-y-2">
                <button onclick="window.openEdit('${item.id_aset}')"
                    class="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 bg-kai-blue hover:bg-blue-800 active:bg-blue-900 text-white font-semibold rounded-lg transition text-sm shadow-sm">
                    <i class="fas fa-edit text-sm"></i> Form Pemeliharaan dan Kalibrasi
                </button>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    ${
                      isAdmin
                        ? `<button onclick="window.openMutasiModal('${item.id_aset}')"
                        class="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 bg-kai-orange hover:bg-orange-600 active:bg-orange-700 text-white font-semibold rounded-lg transition text-sm shadow-sm">
                        <i class="fas fa-exchange-alt text-sm"></i> Mutasi Aset
                    </button>`
                        : `<div class="hidden sm:block"></div>`
                    }
                    <button onclick="window.openQrModal('${item.id_aset}')"
                        class="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 bg-violet-600 dark:bg-violet-700 hover:bg-violet-500 dark:hover:bg-violet-600 text-white font-semibold rounded-lg transition text-sm shadow-sm">
                        <i class="fas fa-qrcode text-sm"></i> Pindai/Cetak QR
                    </button>
                </div>
            </div>
        `;

      fragment.appendChild(card);
    });
  container.appendChild(fragment);
}

// ── HISTORY VIEW STATE ─────────────────────────────────────────────────────
let _historyMode = "repair"; // 'repair' | 'kalibrasi' | 'mutasi'
let _historySummary = []; // cached from /api/history/summary

async function loadHistorySummary() {
  try {
    const res = await apiFetch("/history/summary");
    if (res.ok) _historySummary = await res.json();
  } catch (e) {
    /* silent */
  }
}

// ── Asset ID decoder ───────────────────────────────────────────────────────

const PERUNTUKAN_MAP = {
  A: "JALAN REL",
  B: "JEMBATAN",
  C: "MEKANIK",
  D: "BALAIYASA",
};
// sumber_pengadaan is stored as a string ("PUSAT" / "DAOP/DIVRE"), so the old
// integer keys 1/2 never matched and the map was dead. Keys kept for any legacy
// numeric rows; the string keys are what actually hit.
const PENGADAAN_MAP = {
  1: "PUSAT",
  2: "DAOP / DIVRE",
  PUSAT: "PUSAT",
  "DAOP/DIVRE": "DAOP / DIVRE",
  "DAOP / DIVRE": "DAOP / DIVRE",
};

/**
 * Decode id_aset format: <kode_alat>-<tahun>-<peruntukan>-<id_lokasi>
 * Returns { kodeAlat, tahun, peruntukan, lokasiCode }
 */
function decodeAsetId(id) {
  if (!id) return {};

  // Format baru (menggunakan titik): misal 6.RGM.1.24.A.D1
  if (id.includes(".")) {
    const parts = id.split(".");
    // urutan: nomor(0) . kode(1) . pengadaan(2) . tahun(3) . peruntukan(4) . lokasi(5+)
    if (parts.length >= 6) {
      return {
        kodeAlat: parts[1],
        tahun: parts[3],
        peruntukan: parts[4],
        lokasiCode: parts.slice(5).join("."), // Gabungkan sisa jika lokasi ada titik (misal JR1.1)
      };
    }
  }

  // Format lama (menggunakan strip): misal RGM-24-A-D1
  const parts = id.split("-");
  if (parts.length < 4) return {};
  return {
    kodeAlat: parts[0],
    tahun: parts[1],
    peruntukan: parts[2],
    lokasiCode: parts.slice(3).join("-"),
  };
}

function resolveLokasi(val) {
  if (!val || val === "—") return { parentName: "—", uptName: "—", uptCode: "" };

  // 1. PRIORITY 1: Exact match on UPT code (strictest)
  const uptEntry = uptDatabase.find((u) => u.upt === val);
  if (uptEntry) {
    const parentCode = getParentLokasiCode(uptEntry.upt) || uptEntry.lokasi;
    const parentEntry = lokasiData.find((l) => l.code === parentCode);
    return {
      parentName: parentEntry ? parentEntry.name : parentCode,
      uptName: uptEntry.nama,
      uptCode: uptEntry.upt,
    };
  }

  // 2. PRIORITY 2: Exact match on Parent code
  const parentEntry = lokasiData.find((l) => l.code === val);
  if (parentEntry) {
    return { parentName: parentEntry.name, uptName: "—", uptCode: "" };
  }

  // 3. PRIORITY 3: Fallback to fuzzy/name matches (UPT name, then Parent name)
  const uptByName = uptDatabase.find((u) => u.nama === val);
  if (uptByName) {
    const parentCode = getParentLokasiCode(uptByName.upt) || uptByName.lokasi;
    const parentEntry = lokasiData.find((l) => l.code === parentCode);
    return {
      parentName: parentEntry ? parentEntry.name : parentCode,
      uptName: uptByName.nama,
      uptCode: uptByName.upt,
    };
  }

  const parentByName = lokasiData.find((l) => l.name === val);
  if (parentByName) {
    return { parentName: parentByName.name, uptName: "—", uptCode: "" };
  }

  // 4. Complete fallback
  return { parentName: val, uptName: "—", uptCode: "" };
}

function renderHistoryCards() {
  const container = document.getElementById("history-repair-container");
  const searchInput = document.getElementById("search-history");
  if (!container) return;

  container.innerHTML = "";

  const searchQ = (searchInput?.value || "").toUpperCase();

  let filtered = _historySummary.filter((item) => {
    if (!_historySearchMatches(item, searchQ)) return false;
    return _historyFilterMatches(item, _histSortFilters);
  });

  filtered = filtered.sort(_historyComparator);

  if (!filtered.length) {
    renderPagerBar("history-repair-pager", paginateList("history-repair", filtered), renderHistoryCards);
    container.innerHTML = `<div class="col-span-2 text-center text-gray-400 py-12"><i class="fas fa-inbox text-3xl mb-2 block"></i>Belum ada riwayat perbaikan.</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();

  // Slice AFTER filter + sort, so paging never reorders the list.
  const _page = paginateList("history-repair", filtered);
  renderPagerBar("history-repair-pager", _page, renderHistoryCards);

  _page.items.forEach((item) => {
    const r = item.repair || {};
    const statusColor =
      item.status_terakhir === "SO"
        ? "text-green-500"
        : item.status_terakhir === "TSO"
          ? "text-red-500"
          : "text-blue-500";
    const kondisiColor =
      r.latest_kondisi === "SO"
        ? "text-green-500"
        : r.latest_kondisi === "TSO"
          ? "text-red-500"
          : "text-blue-400";

    const card = document.createElement("div");
    card.className =
      "bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-blue-200 dark:border-blue-900/30 flex flex-col justify-between hover:border-blue-500 transition-colors";
    card.innerHTML = `
            <div class="flex flex-col gap-3">
                <div class="flex justify-between items-start border-b dark:border-gray-700 pb-3">
                    <div>
                        <h3 class="text-base font-bold font-mono text-kai-blue dark:text-blue-400">${item.id_aset}</h3>
                        <p class="text-xs text-gray-500 dark:text-gray-200 mt-0.5">${item.kode_alat_name || item.kode_alat} — ${item.id_lokasi_name || item.id_lokasi}</p>
                    </div>
                    <span class="text-sm font-bold ${statusColor} shrink-0"><i class="fas fa-circle text-xs mr-1"></i>${item.status_terakhir}</span>
                </div>
                ${
                  r.latest_date
                    ? (() => {
                        // Ambil lokasi langsung dari data repair terbaru
                        const rawLokasiCode = item.id_lokasi_raw || item.id_lokasi;
                        const uptEntry = uptDatabase.find(
                          (u) => u.upt === rawLokasiCode,
                        );
                        const lokasiEntry = lokasiData.find(
                          (l) => l.code === rawLokasiCode,
                        );

                        const uptLabel = uptEntry
                          ? `${uptEntry.nama}`
                          :  "—";
                        const lokasiLabel = uptEntry
                          ? lokasiData.find((l) => l.code === uptEntry.lokasi)
                              ?.name || uptEntry.lokasi
                          : lokasiEntry
                            ? lokasiEntry.name
                            : "—";

                        const peruntukanLabel = item.peruntukan
                          ? item.peruntukan
                          : "—";

                        return `
                    <div class="space-y-1 text-xs text-gray-600 dark:text-gray-400">
                        <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Waktu Input</span>${formatUtcToLocal(r.latest_date)}</div>
                        <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Lokasi Pengirim</span><span class="font-bold">${lokasiLabel}</span></div>
                        <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">UPT Pengirim</span><span class="font-bold">${uptLabel}</span></div>
                        <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Peruntukan</span><span class="capitalize">${peruntukanLabel}</span></div>
                        <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Petugas</span><span>${r.latest_teknisi || "—"}</span></div>
                        <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Keterangan</span><span class="italic">${r.latest_keterangan || "—"}</span></div>
                        </div>`;
                      })()
                    : `
                <div class="space-y-1 text-xs text-gray-600 dark:text-gray-400">
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Waktu Input</span><span>—</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Peruntukan</span><span>—</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Lokasi Pengirim</span><span>—</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">UPT Pengirim</span><span>—</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Petugas</span><span>—</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Keterangan</span><span>—</span></div>
                </div>`
                }
            </div>
            <button onclick="window.openHistoryDetail('${item.id_aset}', 'repair')"
                class="mt-4 w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-kai-blue hover:bg-blue-800 active:bg-blue-900 text-white font-semibold rounded-lg transition text-sm shadow-sm">
                <i class="fas fa-list text-sm"></i> Lihat Riwayat Lengkap
            </button>
        `;

    fragment.appendChild(card);
  });

  container.appendChild(fragment);
}

// Shared search across the nine fields a Pantau Riwayat card actually shows.
// All three tabs use it, so searching by teknisi or lokasi behaves the same
// everywhere — Kalibrasi and Mutasi used to match on id_aset alone.
function _historySearchMatches(item, q) {
  if (!q) return true;
  return [
    // Shared across all three tabs
    item.id_aset, item.kode_alat, item.kode_alat_name,
    item.id_lokasi, item.id_lokasi_name, item.status_terakhir, item.peruntukan,
    // Perbaikan card
    item.repair?.latest_teknisi, item.repair?.latest_keterangan, item.repair?.latest_kondisi,
    // Kalibrasi card — searching "LULUS" or a certificate number should work on
    // the tab that actually displays them.
    item.kalibrasi?.latest_status, item.kalibrasi?.latest_nomor_sertifikat,
    item.kalibrasi?.latest_pelaksana, item.kalibrasi?.latest_keterangan,
    // Mutasi card
    item.mutasi?.latest_lokasi_tuju, item.mutasi?.latest_oleh,
    item.mutasi?.latest_alasan, item.mutasi?.original_lokasi_name,
  ].some((v) => (v || "").toString().toUpperCase().includes(q));
}

// Shared filter for the three Pantau Riwayat tabs — every criterion the sort
// modal can set, read in one place so no tab can silently ignore one.
function _historyFilterMatches(item, f) {
  if (f.alat && item.kode_alat !== f.alat) return false;
  if (!_pengadaanMatches(item.sumber_pengadaan, f.pengadaan)) return false;
  if (f.tahunFrom || f.tahunTo) {
    const yr = parseInt((item.tanggal_pembelian || "").slice(0, 4));
    if (f.tahunFrom && yr < parseInt(f.tahunFrom)) return false;
    if (f.tahunTo && yr > parseInt(f.tahunTo)) return false;
  }
  if (f.lokasi) {
    const parentCode = getParentLokasiCode(item.id_lokasi) || item.id_lokasi;
    if (parentCode !== f.lokasi) return false;
  }
  if (f.upt && item.id_lokasi !== f.upt) return false;
  if (f.peruntukan) {
    const dec = decodeAsetId(item.id_aset);
    if ((dec.peruntukan || "").toUpperCase() !== f.peruntukan) return false;
  }
  // The id range used to be honoured only on the Perbaikan tab.
  if (f.idFrom || f.idTo) {
    const num = parseInt((item.id_aset || "").split(".")[0]) || 0;
    if (f.idFrom && num < f.idFrom) return false;
    if (f.idTo && num > f.idTo) return false;
  }
  return true;
}

// Shared comparator covering all SIX directions. Kalibrasi implemented only
// asc/desc, so its four other buttons fell through to an A–Z compare and
// appeared to do nothing.
function _historyComparator(a, b) {
  if (_histSortDir === "date-desc")
    return new Date(b.tanggal_pembelian || 0) - new Date(a.tanggal_pembelian || 0);
  if (_histSortDir === "date-asc")
    return new Date(a.tanggal_pembelian || 0) - new Date(b.tanggal_pembelian || 0);
  if (_histSortDir === "count-desc") return _eventCount(b) - _eventCount(a);
  if (_histSortDir === "count-asc") return _eventCount(a) - _eventCount(b);
  const av = (a[_histSortField] || "").toString().toUpperCase();
  const bv = (b[_histSortField] || "").toString().toUpperCase();
  return _histSortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
}

function renderKalibrasiCards() {
  const container = document.getElementById("history-kalibrasi-container");
  const searchInput = document.getElementById("search-history");
  if (!container) return;

  container.innerHTML = "";

  const searchQ = (searchInput?.value || "").toUpperCase();

  let filtered = _historySummary.filter((item) => {
    if (!item.has_kalibrasi) return false;
    if (!_historySearchMatches(item, searchQ)) return false;
    return _historyFilterMatches(item, _histSortFilters);
  });

  filtered = filtered.sort(_historyComparator);

  if (!filtered.length) {
    renderPagerBar("history-kalibrasi-pager", paginateList("history-kalibrasi", filtered), renderKalibrasiCards);
    container.innerHTML = `<div class="col-span-2 text-center text-gray-400 py-12"><i class="fas fa-ruler-combined text-3xl mb-2 block"></i>Belum ada riwayat kalibrasi.</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();

  // Slice AFTER filter + sort, so paging never reorders the list.
  const _page = paginateList("history-kalibrasi", filtered);
  renderPagerBar("history-kalibrasi-pager", _page, renderKalibrasiCards);

  _page.items.forEach((item) => {
    const r = item.kalibrasi || {};
    const statusClass =
      r.latest_status === "LULUS"
        ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
        : r.latest_status === "GAGAL"
          ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
          : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";

    const card = document.createElement("div");
    card.className =
      "bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-cyan-200 dark:border-cyan-900/30 flex flex-col justify-between hover:border-cyan-500 transition-colors";

    card.innerHTML = `
            <div class="flex flex-col gap-3">
                <div class="flex justify-between items-start border-b dark:border-gray-700 pb-3">
                    <div>
                        <h3 class="text-base font-bold font-mono text-cyan-700 dark:text-cyan-400">${item.id_aset}</h3>
                        <p class="text-xs text-gray-500 dark:text-gray-200 mt-0.5">${item.kode_alat_name || item.kode_alat} — ${item.id_lokasi_name || item.id_lokasi}</p>
                    </div>
                    <span class="text-xs font-bold px-2 py-0.5 rounded-full ${statusClass}"><i class="fas fa-ruler-combined mr-1 text-[9px]"></i>${r.latest_status || "—"}</span>
                </div>
                <div class="space-y-1 text-xs text-gray-600 dark:text-gray-400">
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Waktu Input</span><span class="font-mono">${r.latest_waktu_input ? formatUtcToLocal(r.latest_waktu_input) : "—"}</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Tanggal Kalibrasi</span><span class="font-mono">${r.latest_tanggal_kalibrasi ? formatDateOnly(r.latest_tanggal_kalibrasi) : "—"}</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Tanggal Berlaku</span><span class="font-mono">${r.latest_berlaku ? formatDateOnly(r.latest_berlaku) : "—"}</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Pelaksana</span><span>${r.latest_pelaksana || "—"}</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">No. Sertifikat</span><span>${r.latest_nomor_sertifikat || "—"}</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Catatan</span><span class="italic">${r.latest_keterangan || "—"}</span></div>
                </div>
            </div>
            <button onclick="window.openHistoryDetail('${item.id_aset}', 'kalibrasi')"
                class="mt-4 w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-cyan-600 hover:bg-cyan-700 active:bg-cyan-800 text-white font-semibold rounded-lg transition text-sm shadow-sm">
                <i class="fas fa-list text-sm"></i> Lihat Riwayat Lengkap
            </button>
        `;
    fragment.appendChild(card);
  });

  container.appendChild(fragment);
}

function renderMutasiCards() {
  const container = document.getElementById("history-mutasi-container");
  const searchInput = document.getElementById("search-history");
  if (!container) return;

  container.innerHTML = "";

  const searchQ = (searchInput?.value || "").toUpperCase();

  // Only show assets that have at least one mutation
  let filtered = _historySummary.filter((item) => {
    if (!item.mutasi) return false;
    if (!_historySearchMatches(item, searchQ)) return false;
    return _historyFilterMatches(item, _histSortFilters);
  });

  filtered = filtered.sort(_historyComparator);

  if (!filtered.length) {
    renderPagerBar("history-mutasi-pager", paginateList("history-mutasi", filtered), renderMutasiCards);
    container.innerHTML = `<div class="col-span-2 text-center text-gray-400 py-12"><i class="fas fa-exchange-alt text-3xl mb-2 block"></i>Belum ada riwayat mutasi.</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();

  // Slice AFTER filter + sort, so paging never reorders the list.
  const _page = paginateList("history-mutasi", filtered);
  renderPagerBar("history-mutasi-pager", _page, renderMutasiCards);

  _page.items.forEach((item) => {
    const m = item.mutasi;
    const returnedBadge = m.sudah_kembali
      ? `<span class="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-xs px-2 py-0.5 rounded-full font-bold">✓ Sudah Kembali ke Lokasi Asal</span>`
      : `<span class="bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 text-xs px-2 py-0.5 rounded-full font-bold">⟳ Belum Kembali</span>`;

    const card = document.createElement("div");
    card.className =
      "bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-orange-200 dark:border-orange-900/30 flex flex-col justify-between hover:border-orange-500 transition-colors";
    card.innerHTML = `
            <div class="flex flex-col gap-3">
                <div class="flex justify-between items-start border-b dark:border-gray-700 pb-3">
                    <div>
                        <h3 class="text-base font-bold font-mono text-kai-orange dark:text-orange-400">${item.id_aset}</h3>
                        <p class="text-xs text-gray-500 dark:text-gray-200 mt-0.5">${item.kode_alat_name || item.kode_alat} — ${item.id_lokasi_name || item.id_lokasi}</p>
                    </div>
                    ${returnedBadge}
                </div>
                ${(() => {
                  const asal = resolveLokasi(m.original_lokasi_code || item.id_lokasi);
                  const kini = resolveLokasi(item.id_lokasi_raw || item.id_lokasi);

                  // Lama proses: dihitung dari mutasi terakhir hingga waktu sekarang
                  let lamaProses = "—";
                  if (m.latest_date) {
                    const latestMs = new Date(
                      m.latest_date.replace(" ", "T"),
                    ).getTime();
                    const diffDays = Math.floor(
                      (Date.now() - latestMs) / (1000 * 60 * 60 * 24),
                    );
                    lamaProses =
                      diffDays <= 0 ? "Hari ini" : `${diffDays} hari`;
                  }

                  return `
                <div class="space-y-1 text-xs text-gray-600 dark:text-gray-400">
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Lokasi Asal</span><span class="font-bold text-gray-700 dark:text-gray-200">${asal.parentName} (${asal.uptName !== "—" ? asal.uptName : "—"})</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Lokasi Kini</span><span class="font-bold text-gray-700 dark:text-gray-200">${kini.parentName} (${kini.uptName !== "—" ? kini.uptName : "—"})</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Tanggal Mutasi</span>${m.latest_date ? formatUtcToLocal(m.latest_date) : "—"}</div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Lama Proses</span><span class="font-bold">${lamaProses}</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Nama Petugas</span><span class="font-semibold">${m.latest_oleh || "—"}</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Alasan Mutasi</span><span class="italic">${m.latest_alasan || "—"}</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Total Mutasi</span><span class="font-bold">${m.count} kali</span></div>
                </div>`;
                })()}
            </div>
            <button onclick="window.openHistoryDetail('${item.id_aset}', 'mutasi')"
                class="mt-4 w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-kai-orange hover:bg-orange-600 active:bg-orange-700 text-white font-semibold rounded-lg transition text-sm shadow-sm">
                <i class="fas fa-route text-sm"></i> Lihat Timeline Mutasi
            </button>
        `;

    fragment.appendChild(card);
  });

  container.appendChild(fragment);
}

// ── MASTER DATA UI ─────────────────────────────────────────────────────────

// Tab switching
document.querySelectorAll(".master-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.tab;

    const ACTIVE_CLS = [
      "bg-kai-orange",
      "text-white",
      "font-semibold",
      "shadow-sm",
    ];
    const INACTIVE_CLS = [
      "text-gray-500",
      "dark:text-gray-400",
      "font-medium",
      "hover:bg-kai-orange/20",
      "hover:text-kai-orange",
    ];

    document.querySelectorAll(".master-tab").forEach((t) => {
      const isActive = t.dataset.tab === target;
      [...ACTIVE_CLS, ...INACTIVE_CLS].forEach((c) => t.classList.remove(c));
      (isActive ? ACTIVE_CLS : INACTIVE_CLS).forEach((c) => t.classList.add(c));
    });

    document
      .querySelectorAll(".master-tab-panel")
      .forEach((p) => p.classList.add("hidden"));
    document
      .getElementById(`master-panel-${target}`)
      ?.classList.remove("hidden");

    if (target === "users") loadMasterUsers();
    if (target === "alat") loadMasterAlat();
    if (target === "lokasi") loadMasterLokasi();
    if (target === "upt") loadMasterUpt();
  });
});

// ── LOAD FUNCTIONS ────────────────────────────────────────────────

function syncNewUserRegion() {
  const roleEl = document.getElementById("new-user-role");
  const regionEl = document.getElementById("new-user-region");
  if (!roleEl || !regionEl) return;

  const isSA = roleEl.value === "SUPER_ADMIN";
  if (isSA) {
    regionEl.disabled = true;
    regionEl.innerHTML =
      '<option value="">Semua Region (tidak diperlukan)</option>';
  } else {
    regionEl.disabled = false;
    regionEl.innerHTML = lokasiData
      .map((l) => `<option value="${l.code}">${l.name} (${l.code})</option>`)
      .join("");
    if (!regionEl.value && lokasiData.length)
      regionEl.value = lokasiData[0].code;
  }
}

async function loadMasterUsers() {
  const tbody = document.getElementById("table-users");
  if (!tbody) return;

  syncNewUserRegion();

  const addFormWrap = document.getElementById("form-add-user");
  if (addFormWrap) {
    addFormWrap.classList.toggle("hidden", _currentRole !== "SUPER_ADMIN");
  }

  tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-gray-400 text-sm"><i class="fas fa-spinner fa-spin mr-2"></i>Memuat...</td></tr>`;

  try {
    const res = await apiFetch("/users");
    if (!res.ok) throw new Error();
    const data = await res.json();

    if (!data.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-gray-400 text-sm">Belum ada data pengguna.</td></tr>`;
      return;
    }

    const roleColors = {
      SUPER_ADMIN:
        "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
      ADMIN_WILAYAH:
        "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
      TEKNISI:
        "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
    };

    tbody.innerHTML = data
      .map(
        (u) => `
            <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td class="px-4 py-3 font-semibold font-mono">${u.username}</td>
                <td class="px-4 py-3">
                    <span class="text-xs px-2 py-0.5 rounded-full font-bold ${roleColors[u.role] || "bg-gray-100 text-gray-700"}">
                        ${u.role}
                    </span>
                </td>
                <td class="px-4 py-3 text-sm text-gray-500 font-mono">${u.nama_lokasi || u.id_lokasi || "—"}</td>
                <td class="px-4 py-3">${_presenceCell(u)}</td>
                <td class="px-4 py-3 text-right">
                    <button onclick="window.openMasterEdit('users',${u.id_pengguna},'${u.username}','${u.role}','${u.id_lokasi || ""}')"
                        class="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-3 py-1 rounded-lg font-bold hover:bg-blue-200 transition">
                        <i class="fas fa-edit mr-1"></i> Edit
                    </button>
                </td>
            </tr>
        `,
      )
      .join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" class="px-4 py-6 text-center text-red-400 text-sm">Gagal memuat data pengguna.</td></tr>`;
  }
}

// Friendly names for the view ids reported over the WebSocket, so the Pengguna
// list reads "sedang di Kelola Inventaris" rather than "inventaris".
const VIEW_LABEL = {
  dashboard: "Dashboard",
  input: "Kelola Aset Alat Kerja",
  inventaris: "Kelola Inventaris",
  database: "Kelola Data Aset",
  history: "Pantau Riwayat Aset",
  "history-detail": "Detail Riwayat Aset",
  edit: "Pembaruan Kondisi",
  laporan: "Proses Laporan",
  masterdata: "Pusat Data",
  afkir: "Pulihkan Aset Afkir",
};

// Presence is a dot PLUS a word — never colour alone, so the state is readable
// for a colour-blind user and in a printed export.
function _presenceCell(u) {
  const view = u.last_view ? VIEW_LABEL[u.last_view] || u.last_view : null;
  if (u.online) {
    return `
      <span class="inline-flex items-center gap-1.5 text-[11px] font-bold text-green-600 dark:text-green-400">
        <span class="w-2 h-2 rounded-full bg-green-500 shrink-0"></span>Online
      </span>
      <p class="text-[10px] text-gray-400 mt-0.5">${view ? `di ${view}` : "sedang menjelajah"}</p>`;
  }
  return `
    <span class="inline-flex items-center gap-1.5 text-[11px] font-bold text-gray-400">
      <span class="w-2 h-2 rounded-full bg-gray-300 dark:bg-gray-600 shrink-0"></span>Offline
    </span>
    <p class="text-[10px] text-gray-400 mt-0.5">${
      u.last_seen ? `terakhir ${u.last_seen}` : "belum pernah masuk"
    }</p>`;
}

// Called by the WebSocket REFRESH_PRESENCE broadcast. Only refetches when the
// Pengguna tab is actually on screen — presence churns constantly and every
// connected client would otherwise poll it.
window.refreshPresenceIfVisible = function refreshPresenceIfVisible() {
  const view = document.getElementById("view-masterdata");
  if (!view?.classList.contains("is-visible")) return;
  const panel = document.getElementById("master-panel-users");
  if (!panel || panel.classList.contains("hidden")) return;
  loadMasterUsers();
};

// Cached variants, keyed by kode_alat, so the table can show each tool's
// technical specs without a request per row.
let _varianByAlat = {};

async function loadAlatVarian() {
  try {
    const res = await apiFetch("/master/varian", { background: true });
    if (!res.ok) return;
    const rows = await res.json();
    _varianByAlat = {};
    rows.forEach((v) => {
      (_varianByAlat[v.kode_alat] ||= []).push(v);
    });
  } catch (_) { /* the table degrades to "—" */ }
}
window.loadAlatVarian = loadAlatVarian;

async function loadMasterAlat() {
  const tbody = document.getElementById("table-alat");
  if (!tbody) return;
  // The table has FOUR columns; this used to emit five <td> under three <th>
  // with colspan="4" empty states matching neither, so every row was misaligned.
  tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-gray-400 text-sm"><i class="fas fa-spinner fa-spin mr-2"></i>Memuat...</td></tr>`;

  try {
    await loadAlatVarian();
    const res = await apiFetch("/master/alat");
    const data = await res.json();

    if (!data.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-gray-400 text-sm">Belum ada data alat.</td></tr>`;
      return;
    }

    tbody.innerHTML = data
      .map((a) => {
        // Spesifikasi teknis (spektek) — the variants that are NOT
        // interchangeable for sparepart purposes, e.g. GX270 vs GX390.
        const varian = _varianByAlat[a.kode_alat] || [];
        const varianCell = varian.length
          ? varian
              .map(
                (v) =>
                  `<span class="inline-block text-[10px] font-semibold bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-1.5 py-0.5 rounded mr-1 mb-1" title="${v.keterangan || v.nama_varian}">${v.nama_varian}</span>`,
              )
              .join("")
          : '<span class="text-gray-300 dark:text-gray-600">—</span>';
        return `
            <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td class="px-4 py-3 font-mono font-bold text-blue-600 dark:text-blue-400">${a.kode_alat}</td>
                <td class="px-4 py-3 font-semibold">${a.nama_alat}</td>
                <td class="px-4 py-3 text-xs max-w-[280px]">${varianCell}</td>
                <td class="px-4 py-3 text-right">
                    <button onclick="window.openMasterEdit('alat','${a.kode_alat}','${a.nama_alat}','','')"
                        class="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-3 py-1 rounded-lg font-bold hover:bg-blue-200 transition">
                        <i class="fas fa-edit mr-1"></i> Edit
                    </button>
                </td>
            </tr>`;
      })
      .join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-red-400 text-sm">Gagal memuat data.</td></tr>`;
  }
}

async function loadMasterLokasi() {
  const tbody = document.getElementById("table-lokasi");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-gray-400 text-sm"><i class="fas fa-spinner fa-spin mr-2"></i>Memuat...</td></tr>`;

  try {
    const res = await apiFetch(
      "/master/lokasi?tipe=DAOP&tipe=DIVRE&tipe=BALAIYASA&tipe=PUSAT",
    );
    const data = await res.json();

    if (!data.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-gray-400 text-sm">Belum ada data lokasi.</td></tr>`;
      return;
    }

    tbody.innerHTML = data
      .map(
        (l) => `
            <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td class="px-4 py-3 font-mono font-bold text-blue-600 dark:text-blue-400">${l.id_lokasi}</td>
                <td class="px-4 py-3 font-semibold">${l.nama_lokasi}</td>
                <td class="px-4 py-3">
                    <span class="text-xs px-2 py-0.5 rounded-full font-bold
                        ${
                          l.tipe === "DAOP"
                            ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                            : l.tipe === "DIVRE"
                              ? "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
                              : l.tipe === "PUSAT"
                                ? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300"
                                : "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300"
                        }">
                        <!--  
                        ${l.tipe == "BALAIYASA" ? "KANTOR PUSAT" : l.tipe}
                        -->
                        ${l.tipe}
                    </span>
                </td>
                <td class="px-4 py-3 text-right">
                    <button onclick="window.openMasterEdit('lokasi','${l.id_lokasi}','${l.nama_lokasi}','${l.tipe}')"
                        class="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-3 py-1 rounded-lg font-bold hover:bg-blue-200 transition">
                        <i class="fas fa-edit mr-1"></i> Edit
                    </button>
                </td>
            </tr>
        `,
      )
      .join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-red-400 text-sm">Gagal memuat data.</td></tr>`;
  }
}

function getParentLokasiName(idLokasi) {
  if (!idLokasi) return "-";

  // Ekstrak bagian kode di antara 'JR' dan titik '.'
  // Misal: "JR1.5" -> "1", "JRIII.2" -> "III"
  const match = idLokasi.match(/^JR([A-Z0-9]+)\./i);
  if (!match) return "-";

  const code = match[1].toUpperCase();

  // Jika berupa angka Arab (1, 2, 3...) -> DAOP
  if (/^\d+$/.test(code)) {
    return `DAOP ${code}`;
  }

  // Jika berupa angka Romawi (I, II, III, IV...) -> DIVRE
  return `DIVRE ${code}`;
}

async function loadMasterUpt() {
  const tbody = document.getElementById("table-upt");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-gray-400 text-sm"><i class="fas fa-spinner fa-spin mr-2"></i>Memuat...</td></tr>`;

  const lokasiSel = document.getElementById("new-upt-lokasi");
  if (lokasiSel && lokasiData.length) {
    lokasiSel.innerHTML = lokasiData
      .map((l) => `<option value="${l.code}">${l.name} (${l.code})</option>`)
      .join("");
  }

  try {
    const res = await apiFetch("/master/lokasi?tipe=upt");
    _masterUptRows = await res.json();
    resetPage("master-upt");
    renderMasterUpt();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-red-400 text-sm">Gagal memuat data.</td></tr>`;
  }
}

// Cached so paging re-renders without re-fetching all 205 rows.
let _masterUptRows = [];

function renderMasterUpt() {
  const tbody = document.getElementById("table-upt");
  if (!tbody) return;

  if (!_masterUptRows.length) {
    renderPagerBar("master-upt-pager", paginateList("master-upt", _masterUptRows), renderMasterUpt);
    tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-gray-400 text-sm">Belum ada data UPT.</td></tr>`;
    return;
  }

  const page = paginateList("master-upt", _masterUptRows);
  renderPagerBar("master-upt-pager", page, renderMasterUpt);

  {
    tbody.innerHTML = page.items
      .map((u) => {
        // Try regex-based derivation first, then fall back to lokasiData lookup via uptDatabase
        let parentCode = getParentLokasiCode(u.id_lokasi) || "";
        let parentName = "";
        if (parentCode) {
          const parentEntry = lokasiData.find((l) => l.code === parentCode);
          parentName = parentEntry ? parentEntry.name : parentCode;
        } else {
          // Fallback: check if uptDatabase already has this UPT mapped to a parent
          const uptEntry = uptDatabase.find((u2) => u2.upt === u.id_lokasi);
          if (uptEntry) {
            parentCode = uptEntry.lokasi || "—";
            const parentEntry = lokasiData.find((l) => l.code === parentCode);
            parentName = parentEntry ? parentEntry.name : parentCode;
          } else {
            parentCode = "—";
            parentName = "—";
          }
        }
        return `
                <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td class="px-4 py-3 text-gray-600 dark:text-gray-300 font-mono font-bold">${u.id_lokasi}</td>
                    <td class="px-4 py-3 font-semibold">${u.nama_lokasi}</td>
                    <td class="px-4 py-3 text-sm text-gray-600 dark:text-gray-300 font-mono font-medium">${parentName} <span class="text-gray-400">(${parentCode})</span></td>
                    <td class="px-4 py-3 text-right">
                        <button onclick="window.openMasterEdit('upt', '${u.id_lokasi}', '${u.nama_lokasi}', '${parentCode}')"
                            class="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-3 py-1 rounded-lg font-bold hover:bg-blue-200 transition">
                            <i class="fas fa-edit mr-1"></i> Edit
                        </button>
                    </td>
                </tr>`;
      })
      .join("");
  }
}

// ── SORT MODAL ────────────────────────────────────────────────────

let _sortField = "id_aset";
let _sortDir = "date-desc";
let _sortFilters = {}; // custom filter values for db sort

let _histSortField = "id_aset";
let _histSortDir = "date-desc";
let _histSortFilters = {};

// ── Helper: populate year dropdowns ──
function _populateYearDropdowns(fromId, toId) {
  const curYear = new Date().getFullYear();
  [fromId, toId].forEach((id) => {
    const sel = document.getElementById(id);
    if (!sel || sel.options.length > 1) return;
    for (let y = curYear; y >= 1950; y--) {
      const o = document.createElement("option");
      o.value = String(y);
      o.textContent = String(y);
      sel.appendChild(o);
    }
  });
}

// ── Helper: populate alat+lokasi dropdowns in sort modal ──
function _populateSortDropdowns(prefix) {
  // Alat (id_aset panel)
  const alatSel = document.getElementById(`${prefix}-id-alat`);
  if (alatSel && alatSel.options.length <= 1) {
    alatKerjaData.forEach((a) => {
      const o = document.createElement("option");
      o.value = a.code;
      o.textContent = `${a.code} — ${a.name}`;
      alatSel.appendChild(o);
    });
  }
  // Alat filter (kode_alat_name panel)
  const alatFilterSel = document.getElementById(`${prefix}-alat-filter`) || document.getElementById(`${prefix}-alat`);
  if (alatFilterSel && alatFilterSel !== alatSel && alatFilterSel.options.length <= 1) {
    alatKerjaData.forEach((a) => {
      const o = document.createElement("option");
      o.value = a.code;
      o.textContent = `${a.code} — ${a.name}`;
      alatFilterSel.appendChild(o);
    });
  }
  // Lokasi dropdowns (id_aset panel + id_lokasi panel)
  [`${prefix}-id-lokasi`, `${prefix}-lok-lokasi`].forEach((id) => {
    const lokSel = document.getElementById(id);
  if (lokSel && lokSel.options.length <= 1) {
    lokasiData.forEach((l) => {
      const o = document.createElement("option");
      o.value = l.code;
      o.textContent = `${l.name} (${l.code})`;
      lokSel.appendChild(o);
    });
  }
  });
  // UPT: repopulate based on current Lokasi value (preserves prior selection)
  const lokMain = document.getElementById(`${prefix}-lok-lokasi`);
  const uptSel = document.getElementById(`${prefix}-lok-upt`);
  if (uptSel) {
    const currentLok = lokMain ? lokMain.value : "";
    const currentUpt = uptSel.value; // save current selection
    uptSel.innerHTML = `<option value="">— ${currentLok ? "Semua UPT" : "Pilih Lokasi dahulu"} —</option>`;
    const uptList = currentLok
      ? uptDatabase.filter((u) => u.lokasi === currentLok)
      : uptDatabase;
    uptList.forEach((u) => {
      const o = document.createElement("option");
      o.value = u.upt;
      o.textContent = `${u.nama || u.upt} (${u.upt})`;
      uptSel.appendChild(o);
    });
    if (currentUpt) uptSel.value = currentUpt; // restore prior selection
  }
  // Wire Lokasi → UPT cascade (only once per prefix)
  if (lokMain && !lokMain.dataset.cascadeWired) {
    lokMain.dataset.cascadeWired = "1";
    lokMain.addEventListener("change", () => {
      _filterUptByLokasi(`${prefix}-lok-lokasi`, `${prefix}-lok-upt`);
    });
  }
}

// ── Helper: filter UPT dropdown based on selected Lokasi ──
function _filterUptByLokasi(lokSelId, uptSelId) {
  const lokSel = document.getElementById(lokSelId);
  const uptSel = document.getElementById(uptSelId);
  if (!lokSel || !uptSel) return;
  const chosenLok = lokSel.value;
  uptSel.innerHTML = `<option value="">— Semua UPT —</option>`;
  const filtered = chosenLok
    ? uptDatabase.filter((u) => u.lokasi === chosenLok)
    : uptDatabase;
  filtered.forEach((u) => {
    const o = document.createElement("option");
    o.value = u.upt;
    o.textContent = `${u.nama || u.upt} (${u.upt})`;
    uptSel.appendChild(o);
  });
}

// ── Helper: show/hide sort custom panels ──
function _syncSortPanels(fieldVal, customChecked, panelPrefix, allLabelId, customPanelsId) {
  const allLabel = document.getElementById(allLabelId);
  const customPanels = document.getElementById(customPanelsId);
  if (!allLabel || !customPanels) return;

  if (!customChecked || !fieldVal) {
    allLabel.classList.remove("hidden");
    customPanels.classList.add("hidden");
  } else {
    allLabel.classList.add("hidden");
    customPanels.classList.remove("hidden");

    // Hide every sub-panel first. This must list ALL prefix families — a
    // missing one means that modal's panels stack instead of swapping when the
    // user changes the sort criterion.
    customPanels
      .querySelectorAll(
        "[id^='sort-panel-'], [id^='hist-sort-panel-'], [id^='kdak-sort-panel-'], [id^='afkir-sort-panel-']",
      )
      .forEach((p) => p.classList.add("hidden"));
    // Show the one matching the active prefix + field. Scoped to THIS modal's
    // container — a global id lookup could reveal a panel belonging to another
    // sort modal when two of them use different names for the same field.
    const panel = customPanels.querySelector(
      `#${panelPrefix}-panel-${CSS.escape(fieldVal)}`,
    );
    if (panel) panel.classList.remove("hidden");
  }
}

// ── DB Sort Modal ──
document.getElementById("btn-sort-db")?.addEventListener("click", () => {
  _populateYearDropdowns("sort-id-tahun-from", "sort-id-tahun-to");
  _populateYearDropdowns("sort-tgl-from", "sort-tgl-to");
  _populateSortDropdowns("sort");

  // Also populate sort-alat-filter (the kode_alat_name panel dropdown)
  const alatFilterSel = document.getElementById("sort-alat-filter");
  if (alatFilterSel && alatFilterSel.options.length <= 1) {
    alatKerjaData.forEach((a) => {
      const o = document.createElement("option");
      o.value = a.code;
      o.textContent = `${a.code} — ${a.name}`;
      alatFilterSel.appendChild(o);
    });
  }

  // Sync panels and Terbaru/Terlama visibility for current field
  const curField = document.getElementById("sort-field")?.value || "id_aset";
  const curChecked = document.getElementById("sort-custom-spec")?.checked || false;
  _syncSortPanels(curField, curChecked, "sort", "sort-all-data-label", "sort-custom-panels");

  // Paint active direction button
  document.querySelectorAll(".sort-dir-btn").forEach((b) => {
    const active = b.dataset.dir === _sortDir;
    b.classList.toggle("border-kai-blue", active);
    b.classList.toggle("bg-sky-100", active);
    b.classList.toggle("dark:bg-sky-900/20", active);
    b.classList.toggle("text-kai-blue", active);
    b.classList.toggle("dark:text-sky-300", active);
    b.classList.toggle("border-gray-200", !active);
    b.classList.toggle("dark:border-gray-600", !active);
    b.classList.toggle("bg-white", !active);
    b.classList.toggle("dark:bg-gray-700", !active);
    b.classList.toggle("text-gray-500", !active);
  });

  // Populate id-panel alat and lokasi
  const idAlatSel = document.getElementById("sort-id-alat");
  if (idAlatSel && idAlatSel.options.length <= 1) {
    alatKerjaData.forEach((a) => {
      const o = document.createElement("option");
      o.value = a.code;
      o.textContent = `${a.code} — ${a.name}`;
      idAlatSel.appendChild(o);
    });
  }
  const idLokSel = document.getElementById("sort-id-lokasi");
  if (idLokSel && idLokSel.options.length <= 1) {
    lokasiData.forEach((l) => {
      const o = document.createElement("option");
      o.value = l.code;
      o.textContent = `${l.name} (${l.code})`;
      idLokSel.appendChild(o);
    });
  }
  // Lokasi → UPT cascade wiring (if not yet done)
  const sortLokSel = document.getElementById("sort-lok-lokasi");
  if (sortLokSel && !sortLokSel.dataset.cascadeWired) {
    sortLokSel.dataset.cascadeWired = "1";
    sortLokSel.addEventListener("change", () => {
      _filterUptByLokasi("sort-lok-lokasi", "sort-lok-upt");
    });
  }
  document.getElementById("sort-modal").classList.remove("hidden");
});

document.getElementById("close-sort-modal")?.addEventListener("click", () => {
  document.getElementById("sort-modal").classList.add("hidden");
});

// DB Sort: sync panels on field change
document.getElementById("sort-field")?.addEventListener("change", (e) => {
  const checked = document.getElementById("sort-custom-spec")?.checked;
  _syncSortPanels(e.target.value, checked, "sort", "sort-all-data-label", "sort-custom-panels");
});

document.getElementById("sort-custom-spec")?.addEventListener("change", (e) => {
  const field = document.getElementById("sort-field")?.value;
  _syncSortPanels(field, e.target.checked, "sort", "sort-all-data-label", "sort-custom-panels");
});

// DB sort direction buttons
document.querySelectorAll(".sort-dir-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    _sortDir = btn.dataset.dir;
    document.querySelectorAll(".sort-dir-btn").forEach((b) => {
      const active = b.dataset.dir === _sortDir;
      b.classList.toggle("border-kai-blue", active);
      b.classList.toggle("bg-sky-100", active);
      b.classList.toggle("dark:bg-sky-900/20", active);
      b.classList.toggle("text-kai-blue", active);
      b.classList.toggle("dark:text-sky-300", active);
      b.classList.toggle("border-gray-200", !active);
      b.classList.toggle("dark:border-gray-600", !active);
      b.classList.toggle("bg-white", !active);
      b.classList.toggle("dark:bg-gray-700", !active);
      b.classList.toggle("text-gray-500", !active);
    });
  });
});

// The <select> value doubles as a panel id, so some options are named after the
// PANEL rather than the data field. Sorting used the raw value as a property
// key, so "Peruntukan" sorted on item.unit_peruntukan — a field that does not
// exist — and silently did nothing. Map panel id → real field in one place.
const SORT_FIELD_ALIAS = {
  unit_peruntukan: "peruntukan",
  kode_alat_name: "kode_alat_name",
};
const sortFieldOf = (v) => SORT_FIELD_ALIAS[v] || v || "id_aset";

document.getElementById("btn-apply-sort")?.addEventListener("click", () => {
  const fieldVal = document.getElementById("sort-field").value;
  _sortField = sortFieldOf(fieldVal);
  const customChecked = document.getElementById("sort-custom-spec")?.checked;

  // Collect custom filters
  _sortFilters = {};
  if (customChecked && fieldVal) {
    if (fieldVal === "id_aset") {
      // The id_aset panel has exactly two controls. Six further reads used to
      // live here (alat / pengadaan / tahun-from / tahun-to / peruntukan /
      // lokasi) naming elements that exist in no panel, so they always resolved
      // to "" and quietly widened the filter back to everything.
      _sortFilters.idFrom = parseInt(document.getElementById("sort-id-from")?.value) || null;
      _sortFilters.idTo = parseInt(document.getElementById("sort-id-to")?.value) || null;
    } else if (fieldVal === "kode_alat_name") {
      _sortFilters.alat = document.getElementById("sort-alat-filter")?.value || "";
    } else if (fieldVal === "sumber_pengadaan") {
      _sortFilters.pengadaan = document.querySelector('input[name="sort-pengadaan-filter"]:checked')?.value || "";
    } else if (fieldVal === "tanggal_pembelian") {
      _sortFilters.tahunFrom = document.getElementById("sort-tgl-from")?.value || "";
      _sortFilters.tahunTo = document.getElementById("sort-tgl-to")?.value || "";
    } else if (fieldVal === "unit_peruntukan") {
      _sortFilters.peruntukan = document.querySelector('input[name="sort-peruntukan-filter"]:checked')?.value || "";
    } else if (fieldVal === "id_lokasi") {
      _sortFilters.lokasi = document.getElementById("sort-lok-lokasi")?.value || "";
      _sortFilters.upt = document.getElementById("sort-lok-upt")?.value || "";
    }
  }

  document.getElementById("sort-modal").classList.add("hidden");
  resetPage("db");
  renderDbCards();
});

// KDA sort reset
// REPLACE existing btn-reset-sort handler
document.getElementById("btn-reset-sort")?.addEventListener("click", () => {
  _sortField = "id_aset";
  _sortDir = "date-desc";
  _sortFilters = {};

  const sortField = document.getElementById("sort-field");
  if (sortField) sortField.value = "";
  const sortSpec = document.getElementById("sort-custom-spec");
  if (sortSpec) sortSpec.checked = false;

  // Clear all sub-filter inputs
  document.querySelectorAll("#sort-custom-panels input[type='text'], #sort-custom-panels input[type='number'], #sort-custom-panels select").forEach(el => { el.value = ""; });
  document.querySelectorAll("#sort-custom-panels input[type='radio']").forEach(el => { el.checked = false; });

  _syncSortPanels("", false, "sort", "sort-all-data-label", "sort-custom-panels");
  document.querySelectorAll(".sort-dir-btn").forEach((b) => {
    b.classList.remove("border-kai-blue", "bg-sky-100", "dark:bg-sky-900/20", "text-kai-blue", "dark:text-sky-300");
    b.classList.add("border-gray-200", "dark:border-gray-600", "bg-white", "dark:bg-gray-700", "text-gray-500");
  });
  showToast("Nilai sort pada menu ini telah direset.", "info");
  renderDbCards();
});

// ── History Sort Modal ──
document.getElementById("btn-sort-history")?.addEventListener("click", () => {
  _populateYearDropdowns("hist-sort-tgl-from", "hist-sort-tgl-to");

  // Sync panels and Terbaru/Terlama visibility for current field
  const curField = document.getElementById("hist-sort-field")?.value || "id_aset";
  const curChecked = document.getElementById("hist-sort-custom-spec")?.checked || false;
  _syncSortPanels(curField, curChecked, "hist-sort", "hist-sort-all-data-label", "hist-sort-custom-panels");

  // Paint active direction button
  document.querySelectorAll(".hist-sort-dir-btn").forEach((b) => {
    const active = b.dataset.histDir === _histSortDir;
    b.classList.toggle("border-kai-orange", active);
    b.classList.toggle("bg-orange-50", active);
    b.classList.toggle("dark:bg-orange-900/20", active);
    b.classList.toggle("text-kai-orange", active);
    b.classList.toggle("dark:text-orange-300", active);
    b.classList.toggle("border-gray-200", !active);
    b.classList.toggle("dark:border-gray-600", !active);
    b.classList.toggle("bg-white", !active);
    b.classList.toggle("dark:bg-gray-700", !active);
    b.classList.toggle("text-gray-500", !active);
  });

  ["hist-sort-alat-filter"].forEach((id) => {
    const sel = document.getElementById(id);
    if (sel && sel.options.length <= 1) {
    alatKerjaData.forEach((a) => {
      const o = document.createElement("option");
      o.value = a.code;
      o.textContent = `${a.code} — ${a.name}`;
        sel.appendChild(o);
      });
    }
  });

  ["hist-sort-lok-lokasi"].forEach((id) => {
    const sel = document.getElementById(id);
    if (sel && sel.options.length <= 1) {
      lokasiData.forEach((l) => {
        const o = document.createElement("option");
        o.value = l.code;
        o.textContent = `${l.name} (${l.code})`;
        sel.appendChild(o);
      });
    }
  });

  // Wire cascade if not yet done
  // Populate lokasi dropdown (only once)
  const histLokSel = document.getElementById("hist-sort-lok-lokasi");
  if (histLokSel && histLokSel.options.length <= 1) {
    lokasiData.forEach((l) => {
      const o = document.createElement("option");
      o.value = l.code;
      o.textContent = `${l.name} (${l.code})`;
      histLokSel.appendChild(o);
    });
  }
  // Repopulate UPT based on current Lokasi selection (preserves choice on reopen)
  const histUptSel = document.getElementById("hist-sort-lok-upt");
  if (histUptSel) {
    const currentLok = histLokSel ? histLokSel.value : "";
    const currentUpt = histUptSel.value;
    histUptSel.innerHTML = `<option value="">— ${currentLok ? "Semua UPT" : "Pilih Lokasi dahulu"} —</option>`;
    const uptList = currentLok ? uptDatabase.filter((u) => u.lokasi === currentLok) : uptDatabase;
    uptList.forEach((u) => {
      const o = document.createElement("option");
      o.value = u.upt;
      o.textContent = `${u.nama || u.upt} (${u.upt})`;
      histUptSel.appendChild(o);
    });
    if (currentUpt) histUptSel.value = currentUpt;
  }
  // Wire cascade (only once)
  if (histLokSel && !histLokSel.dataset.cascadeWired) {
    histLokSel.dataset.cascadeWired = "1";
    histLokSel.addEventListener("change", () => {
      _filterUptByLokasi("hist-sort-lok-lokasi", "hist-sort-lok-upt");
    });
  }
  document.getElementById("sort-history-modal").classList.remove("hidden");
});

document.getElementById("close-sort-history-modal")?.addEventListener("click", () => {
    document.getElementById("sort-history-modal").classList.add("hidden");
  });

document.getElementById("hist-sort-field")?.addEventListener("change", (e) => {
  const checked = document.getElementById("hist-sort-custom-spec")?.checked;
  _syncSortPanels(e.target.value, checked, "hist-sort", "hist-sort-all-data-label", "hist-sort-custom-panels");
});

document.getElementById("hist-sort-custom-spec")?.addEventListener("change", (e) => {
    const field = document.getElementById("hist-sort-field")?.value;
  _syncSortPanels(field, e.target.checked, "hist-sort", "hist-sort-all-data-label", "hist-sort-custom-panels");
  });

document.querySelectorAll(".hist-sort-dir-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    _histSortDir = btn.dataset.histDir;
    document.querySelectorAll(".hist-sort-dir-btn").forEach((b) => {
      const active = b.dataset.histDir === _histSortDir;
      b.classList.toggle("border-kai-orange", active);
      b.classList.toggle("bg-orange-50", active);
      b.classList.toggle("dark:bg-orange-900/20", active);
      b.classList.toggle("text-kai-orange", active);
      b.classList.toggle("dark:text-orange-300", active);
      b.classList.toggle("border-gray-200", !active);
      b.classList.toggle("dark:border-gray-600", !active);
      b.classList.toggle("bg-white", !active);
      b.classList.toggle("dark:bg-gray-700", !active);
      b.classList.toggle("text-gray-500", !active);
    });
  });
});

document.getElementById("btn-apply-hist-sort")?.addEventListener("click", () => {
  const fieldVal = document.getElementById("hist-sort-field")?.value || "id_aset";
  _histSortField = sortFieldOf(fieldVal);
  const customChecked = document.getElementById("hist-sort-custom-spec")?.checked;
    _histSortFilters = {};
  if (customChecked && fieldVal) {
    if (fieldVal === "id_aset") {
      _histSortFilters.idFrom = parseInt(document.getElementById("hist-sort-id-from")?.value) || null;
      _histSortFilters.idTo = parseInt(document.getElementById("hist-sort-id-to")?.value) || null;
    } else if (fieldVal === "kode_alat_name") {
      _histSortFilters.alat = document.getElementById("hist-sort-alat-filter")?.value || "";
    } else if (fieldVal === "sumber_pengadaan") {
      _histSortFilters.pengadaan = document.querySelector('input[name="hist-sort-pengadaan-filter"]:checked')?.value || "";
    } else if (fieldVal === "tanggal_pembelian") {
      _histSortFilters.tahunFrom = document.getElementById("hist-sort-tgl-from")?.value || "";
      _histSortFilters.tahunTo = document.getElementById("hist-sort-tgl-to")?.value || "";
    } else if (fieldVal === "unit_peruntukan") {
      _histSortFilters.peruntukan = document.querySelector('input[name="hist-sort-peruntukan-filter"]:checked')?.value || "";
    } else if (fieldVal === "id_lokasi") {
      _histSortFilters.lokasi = document.getElementById("hist-sort-lok-lokasi")?.value || "";
      _histSortFilters.upt = document.getElementById("hist-sort-lok-upt")?.value || "";
    }
    }
    document.getElementById("sort-history-modal").classList.add("hidden");
    resetPage(`history-${_historyMode}`);
    if (_historyMode === "repair") renderHistoryCards();
    else if (_historyMode === "kalibrasi") renderKalibrasiCards();
    else renderMutasiCards();
  });

// PRA sort reset
document.getElementById("btn-reset-hist-sort")?.addEventListener("click", () => {
  _histSortField = "id_aset";
  _histSortDir = "date-desc";
  _histSortFilters = {};

  const histField = document.getElementById("hist-sort-field");
  if (histField) histField.value = "";
  const histSpec = document.getElementById("hist-sort-custom-spec");
  if (histSpec) histSpec.checked = false;

  // Clear all sub-filter inputs
  document.querySelectorAll("#hist-sort-custom-panels input[type='text'], #hist-sort-custom-panels input[type='number'], #hist-sort-custom-panels select").forEach(el => { el.value = ""; });
  document.querySelectorAll("#hist-sort-custom-panels input[type='radio']").forEach(el => { el.checked = false; });

  _syncSortPanels("", false, "hist-sort", "hist-sort-all-data-label", "hist-sort-custom-panels");
  document.querySelectorAll(".hist-sort-dir-btn").forEach((b) => {
    b.classList.remove("border-kai-orange", "bg-orange-50", "dark:bg-orange-900/20", "text-kai-orange", "dark:text-orange-300");
    b.classList.add("border-gray-200", "dark:border-gray-600", "bg-white", "dark:bg-gray-700", "text-gray-500");
  });
  showToast("Nilai sort pada menu ini telah direset.", "info");
  if (_historyMode === "repair") renderHistoryCards();
  else if (_historyMode === "kalibrasi") renderKalibrasiCards();
  else renderMutasiCards();
});

// NOTE: the real #btn-apply-sort handler lives further up (it builds
// _sortFilters as well). A second listener used to be registered here; both
// fired on every click, rendering twice and overwriting _sortField with the raw
// select value — blanking it whenever no criterion was chosen.

// ── ADD FORMS ─────────────────────────────────────────────────────

document
  .getElementById("form-add-user")
  ?.addEventListener("submit", async (e) => {
    e.preventDefault();

    const username = document.getElementById("new-user-username").value.trim();
    const role = document.getElementById("new-user-role").value;
    const region = document.getElementById("new-user-region").value;

    if (!username)
      return showToast("Nama pengguna tidak boleh kosong.", "warning");

    try {
      const res = await apiFetch("/users/create", {
        method: "POST",
        body: JSON.stringify({ username, role, id_lokasi: region || null }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Gagal menambahkan pengguna.");
      }
      showToast(`Pengguna "${username}" berhasil ditambahkan.`, "success");
      document.getElementById("form-add-user").reset();
      await loadMasterUsers();
    } catch (err) {
      if (err.message !== "Unauthorized") showToast(err.message, "error");
    }
  });

document
  .getElementById("form-add-alat")
  ?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const kode = document
      .getElementById("new-alat-kode")
      .value.trim()
      .toUpperCase();
    const nama = document.getElementById("new-alat-nama").value.trim();
    if (!kode || !nama)
      return showToast("Kode dan Nama wajib diisi.", "warning");

    try {
      const res = await apiFetch("/master/alat", {
        method: "POST",
        body: JSON.stringify({ kode_alat: kode, nama_alat: nama }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail);
      }
      showToast("Alat berhasil ditambahkan.", "success");
      e.target.reset();
      await loadMasterAlat();
      await fetchMasterData(); // refresh dropdowns
    } catch (err) {
      showToast(err.message, "error");
    }
  });

document
  .getElementById("form-add-lokasi")
  ?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const kode_lokasi = document
      .getElementById("new-lokasi-kode")
      .value.trim()
      .toUpperCase();
    const nama_lokasi = document.getElementById("new-lokasi-nama").value.trim();
    const tipe_lokasi = document.getElementById("new-lokasi-tipe").value;
    if (!kode_lokasi || !nama_lokasi)
      return showToast("Kode dan Nama wajib diisi.", "warning");

    try {
      const res = await apiFetch("/master/lokasi", {
        method: "POST",
        body: JSON.stringify({
          id_lokasi: kode_lokasi,
          nama_lokasi,
          tipe: tipe_lokasi,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail);
      }
      showToast("Lokasi berhasil ditambahkan.", "success");
      e.target.reset();
      await loadMasterLokasi();
      await fetchMasterData();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

document
  .getElementById("form-add-upt")
  ?.addEventListener("submit", async (e) => {
    e.preventDefault();
      const kode_upt = document.getElementById("new-upt-kode").value.trim().toUpperCase();
      const nama_upt = document.getElementById("new-upt-nama").value.trim();
      const kode_lokasi = document.getElementById("new-upt-lokasi").value;
      if (!kode_upt || !nama_upt || !kode_lokasi)
        return showToast("Kode UPT, Nama UPT, dan Lokasi wajib diisi.", "warning");

      try {
        const res = await apiFetch("/master/lokasi", {
          method: "POST",
          body: JSON.stringify({
            id_lokasi: kode_upt,
            nama_lokasi: nama_upt,
            tipe: "UPT",
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.detail || "Gagal menambahkan UPT.");
        }
        showToast("UPT berhasil ditambahkan.", "success");
        e.target.reset();
        await loadMasterUpt();
        await fetchMasterData();
      } catch (err) {
        showToast(err.message, "error");
      }
  const loc = lokasiData.find((l) => l.code === e.target.value);
  const isBalaiyasa =
    loc?.name?.toUpperCase().includes("BALAIYASA") ||
    loc?.tipe?.toUpperCase() === "BALAIYASA";
  const namaInput = document.getElementById("new-upt-nama");
  const submitBtn = document.querySelector(
    '#form-add-upt button[type="submit"]',
  );
  if (isBalaiyasa) {
    if (namaInput) {
      namaInput.disabled = true;
      namaInput.placeholder = "Tidak berlaku untuk Balaiyasa";
    }
    if (submitBtn) submitBtn.disabled = true;
    showToast("Lokasi Balaiyasa tidak memiliki UPT terkait.", "warning");
  } else {
    if (namaInput) {
      namaInput.disabled = false;
      namaInput.placeholder = "Nama UPT";
    }
    if (submitBtn) submitBtn.disabled = false;
  }
});

// ── EDIT MODAL ────────────────────────────────────────────────────

let _masterEditCtx = null; // { type, id, ... }

window.openMasterEdit = (type, id, val1, val2, val3) => {
  _masterEditCtx = { type, id, val1, val2, val3 };
  const title = document.getElementById("master-edit-title");
  const fields = document.getElementById("master-edit-fields");
  const deactivateBtn = document.getElementById("btn-master-edit-delete");
  if (!deactivateBtn) return;

  // Reset deactivate button label
  deactivateBtn.innerHTML = '<i class="fas fa-ban mr-1"></i> Nonaktifkan';

  if (type === "users") {
    title.textContent = `Edit Pengguna: ${val1}`;
    deactivateBtn.innerHTML =
      '<i class="fas fa-user-slash mr-1"></i> Hapus User';
    fields.innerHTML = `
            <div>
                <label class="block text-xs font-semibold mb-1">Username</label>
                <input value="${val1}" disabled
                    class="w-full p-2 border rounded-md bg-gray-100 dark:bg-gray-600 dark:border-gray-500 text-gray-500 cursor-not-allowed">
            </div>
            <div>
                <label class="block text-xs font-semibold mb-1">Role</label>
                <select id="edit-field-role" class="w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600">
                    ${["TEKNISI", "ADMIN_WILAYAH", "SUPER_ADMIN"]
                      .map(
                        (r) =>
                          `<option value="${r}" ${val2 === r ? "selected" : ""}>${r}</option>`,
                      )
                      .join("")}
                </select>
            </div>
            <div>
                <label class="block text-xs font-semibold mb-1">Region</label>
                <select id="edit-field-region" class="w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600">
                    ${lokasiData
                      .map(
                        (l) =>
                          `<option value="${l.code}" ${val3 === l.code ? "selected" : ""}>${l.name} (${l.code})</option>`,
                      )
                      .join("")}
                </select>
            </div>
        `;

    // Wire role change to disable region — mirrors login page behaviour
    const roleEl = document.getElementById("edit-field-role");
    const regionEl = document.getElementById("edit-field-region");
    function syncRegionState() {
      const isSA = roleEl?.value === "SUPER_ADMIN";
      if (regionEl) {
        if (isSA) {
          regionEl.disabled = true;
          regionEl.innerHTML =
            '<option value="">Semua Region (tidak diperlukan)</option>';
        } else {
          regionEl.disabled = false;
          // Repopulate with lokasi options, keeping current selection or defaulting to first
          const currentVal =
            regionEl.dataset.currentVal || lokasiData[0]?.code || "";
          regionEl.innerHTML = lokasiData
            .map(
              (l) =>
                `<option value="${l.code}" ${l.code === currentVal ? "selected" : ""}>${l.name} (${l.code})</option>`,
            )
            .join("");
          if (!regionEl.value && lokasiData.length)
            regionEl.value = lokasiData[0].code;
        }
      }
    }
    // Store the original region value so repopulate can restore it
    if (regionEl) regionEl.dataset.currentVal = val3 || "";
    roleEl?.addEventListener("change", syncRegionState);
    syncRegionState(); // run on open

    // Hide delete button for SUPER_ADMIN users
    if (val2 === "SUPER_ADMIN") {
      deactivateBtn.classList.add("hidden");
    } else {
      deactivateBtn.classList.remove("hidden");
    }
  } else if (type === "alat") {
    title.textContent = `Edit Alat: ${id}`;
    fields.innerHTML = `
            <div>
                <label class="block text-xs font-semibold mb-1">Nama Alat</label>
                <input id="edit-field-nama" value="${val1}"
                    class="consolas-input w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600">
            </div>
        `;
  } else if (type === "lokasi") {
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
                    ${["DAOP", "DIVRE", "PUSAT"]
                      .map(
                        (t) =>
                          `<option value="${t}" ${val2 === t ? "selected" : ""}>${t}</option>`,
                      )
                      .join("")}
                </select>
            </div>
        `;
  } else if (type === "upt") {
    // id=id_lokasi (e.g. "JR6.3"), val1=nama_lokasi, val2=parent code (e.g. "JR6"), val3=unused
    title.textContent = `Edit UPT: ${val1}`;
    fields.innerHTML = `
            <div>
                <label class="block text-xs font-semibold mb-1">Nama UPT</label>
                <input id="edit-field-nama" value="${val1}"
                    class="consolas-input w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600">
            </div>
            <div>
                <label class="block text-xs font-semibold mb-1">Induk Lokasi (DAOP/DIVRE/BALAIYASA)</label>
                <select id="edit-field-lokasi" class="w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600">
                    ${lokasiData
                      .map(
                        (l) =>
                          `<option value="${l.code}" ${val2 === l.code ? "selected" : ""}>${l.name}</option>`,
                      )
                      .join("")}
                </select>
            </div>
        `;
  }

  document.getElementById("master-edit-modal").classList.remove("hidden");
};

document.getElementById("close-master-edit")?.addEventListener("click", () => {
  document.getElementById("master-edit-modal").classList.add("hidden");
  _masterEditCtx = null;
});

document
  .getElementById("btn-master-edit-save")
  ?.addEventListener("click", async () => {
    if (!_masterEditCtx) return;
    const { type, id } = _masterEditCtx;

    try {
      let res;
      if (type === "users") {
        const role = document.getElementById("edit-field-role").value;
        const region = document.getElementById("edit-field-region").value;
        res = await apiFetch(`/users/${id}`, {
          method: "PUT",
          body: JSON.stringify({
            username: _masterEditCtx.val1,
            role,
            id_lokasi: region,
          }),
        });
      } else if (type === "alat") {
        const nama = document.getElementById("edit-field-nama").value.trim();
        res = await apiFetch(`/master/alat/${id}`, {
          method: "PUT",
          body: JSON.stringify({ kode_alat: id, nama_alat: nama }),
        });
      } else if (type === "lokasi") {
        const nama_lokasi = document
          .getElementById("edit-field-nama")
          .value.trim();
        const tipe_lokasi = document.getElementById("edit-field-tipe").value;
        res = await apiFetch(`/master/lokasi/${id}`, {
          method: "PUT",
          body: JSON.stringify({
            id_lokasi: id,
            nama_lokasi,
            tipe: tipe_lokasi,
          }),
        });
      } else if (type === "upt") {
        const parentLokasi =
          document.getElementById("edit-field-lokasi")?.value ||
          _masterEditCtx.val2 ||
          "";
        res = await apiFetch(`/master/lokasi/${id}`, {
          method: "PUT",
          body: JSON.stringify({
            id_lokasi: id,
            nama_lokasi:
              document.getElementById("edit-field-nama")?.value ||
              _masterEditCtx.val1,
            tipe: "UPT",
          }),
        });
      }

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail);
      }
      showToast("Data berhasil diperbarui.", "success");
      document.getElementById("master-edit-modal").classList.add("hidden");
      _masterEditCtx = null;

      if (type === "users") {
        await loadMasterUsers();
      }
      if (type === "alat") {
        await loadMasterAlat();
        await fetchMasterData();
      }
      if (type === "lokasi") {
        await loadMasterLokasi();
        await fetchMasterData();
      }
      if (type === "upt") {
        await loadMasterUpt();
        await fetchMasterData();
      }
    } catch (err) {
      showToast(err.message, "error");
    }
  });

document
  .getElementById("btn-master-edit-delete")
  ?.addEventListener("click", async () => {
    if (!_masterEditCtx) return;
    const { type, id, val1 } = _masterEditCtx;

    const confirmed = await customConfirm(
      type === "users"
        ? `Hapus akun "${val1}" secara permanen? Tindakan ini tidak dapat dibatalkan.`
        : `Nonaktifkan "${val1}"?\n\nData yang sudah menggunakan referensi ini tidak akan terpengaruh, tapi tidak bisa dipilih untuk entri baru.`,
    );
    if (!confirmed) return;

    try {
      let res;
      if (type === "users")
        res = await apiFetch(`/users/${id}`, { method: "DELETE" });
      if (type === "alat")
        res = await apiFetch(`/master/alat/${id}`, { method: "DELETE" });
      if (type === "lokasi")
        res = await apiFetch(`/master/lokasi/${id}`, { method: "DELETE" });
      if (type === "upt")
        res = await apiFetch(`/master/lokasi/${id}`, { method: "DELETE" });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail);
      }
      showToast("Data berhasil dinonaktifkan.", "success");
      document.getElementById("master-edit-modal").classList.add("hidden");
      _masterEditCtx = null;

      if (type === "users") {
        await loadMasterUsers();
      }
      if (type === "alat") {
        await loadMasterAlat();
        await fetchMasterData();
      }
      if (type === "lokasi") {
        await loadMasterLokasi();
        await fetchMasterData();
      }
      if (type === "upt") {
        await loadMasterUpt();
        await fetchMasterData();
      }
    } catch (err) {
      showToast(err.message, "error");
    }
  });

// ── LAPORAN & EXPORT ───────────────────────────────────────────────────────

let _exportData = { active: [], afkir: [] }; // raw from server
let _exportFiltered = []; // after applying filters

// Called when switching to laporan view
async function initLaporanView() {
  // Populate lokasi filter from loaded master data
  const lokasiSel = document.getElementById("exp-filter-lokasi");
  if (lokasiSel && lokasiData.length) {
    lokasiSel.innerHTML =
      '<option value="">Semua Lokasi</option>' +
      lokasiData
        .map((l) => `<option value="${l.code}">${l.name}</option>`)
        .join("");
  }

  // Set default date range: last 12 months → today
  const today = new Date();
  const yearAgo = new Date();
  yearAgo.setFullYear(today.getFullYear() - 1);
  const fmt = (d) => d.toISOString().split("T")[0];

  const fromEl = document.getElementById("exp-date-from");
  const toEl   = document.getElementById("exp-date-to");
  if (fromEl && !fromEl.value) fromEl.value = fmt(yearAgo);
  if (toEl   && !toEl.value)   toEl.value   = fmt(today);

  // Default date ranges for kalibrasi
  const kalibFromEl = document.getElementById("exp-kalib-date-from");
  const kalibToEl   = document.getElementById("exp-kalib-date-to");
  if (kalibFromEl && !kalibFromEl.value) kalibFromEl.value = fmt(yearAgo);
  if (kalibToEl   && !kalibToEl.value)   kalibToEl.value   = fmt(today);

  // Default date ranges for mutasi
  const mutasiFromEl = document.getElementById("exp-mutasi-date-from");
  const mutasiToEl   = document.getElementById("exp-mutasi-date-to");
  if (mutasiFromEl && !mutasiFromEl.value) mutasiFromEl.value = fmt(yearAgo);
  if (mutasiToEl   && !mutasiToEl.value)   mutasiToEl.value   = fmt(today);

  await fetchExportData();
}

async function fetchExportData() {
  const previewCount = document.getElementById("exp-preview-count");
  if (previewCount)
    previewCount.innerHTML = `<i class="fas fa-spinner fa-spin mr-1"></i> Mengambil data...`;

  try {
    // Fetch perbaikan (active + afkir) and mutasi in parallel
    const [riwayatRes, mutasiRes] = await Promise.all([
      apiFetch("/export/riwayat"),
      apiFetch("/export/mutasi"),
    ]);

    if (!riwayatRes.ok) throw new Error("Gagal mengambil data riwayat.");
    const raw      = await riwayatRes.json();
    const mutasiRaw = mutasiRes.ok ? await mutasiRes.json() : [];

    // Build kalibrasi flat list from _historySummary (already loaded)
    const kalibRows = [];
    (_historySummary || []).forEach((item) => {
      if (!item.kalibrasi) return;
      const k = item.kalibrasi;
      kalibRows.push({
        id_aset:            item.id_aset,
        // display name, not the code — /api/history/summary now returns both
        kode_alat:          item.kode_alat_name || item.kode_alat,
        id_lokasi:          item.id_lokasi,
        tanggal_kalibrasi:  k.latest_date || "—",
        tanggal_berlaku:    k.latest_berlaku || "—",
        status:             k.latest_status || "—",
        pelaksana_kalibrasi: k.latest_pelaksana || "—",
        nomor_sertifikat:   k.latest_nomor_sertifikat || "—",
        keterangan:         k.latest_keterangan || "—",
      });
    });

    // /export/mutasi now returns the lokasi CODES alongside the display names,
    // so the old name→code reverse lookup is gone. It could only ever resolve
    // parent names (lokasiData holds no UPTs), which is exactly why the asal and
    // tujuan filters returned zero rows for anything UPT-level.
    const mutasiRows = mutasiRaw.map((r) => ({
      ...r,
      id_lokasi_asal:   r.id_lokasi_asal   || "",
      id_lokasi_tujuan: r.id_lokasi_tujuan || "",
      waktu_mutasi:     r.waktu_mutasi || "—",
      alasan_mutasi:    r.alasan || "—",
      id_pengguna:      r.oleh || "—",
    }));

    _exportData = {
      active:    raw.active    || [],
      afkir:     raw.afkir     || [],
      kalibrasi: kalibRows,
      mutasi:    mutasiRows,
    };

    // Update afkir stat
    const afkirStat = document.getElementById("exp-stat-afkir");
    if (afkirStat) {
      const afkirUids = new Set(_exportData.afkir.map((r) => r.id_aset));
      afkirStat.textContent = afkirUids.size;
    }

    applyExportFilters();
  } catch (e) {
    if (previewCount)
      previewCount.innerHTML = `<i class="fas fa-exclamation-circle mr-1 text-red-400"></i> Gagal memuat data.`;
  }
}

// ── Laporan: active preview tab state ──
let _expActiveTab = "pemeliharaan";

function applyExportFilters() {
  const dateFrom      = document.getElementById("exp-date-from")?.value || "";
  const dateTo        = document.getElementById("exp-date-to")?.value || "";
  const lokasi        = document.getElementById("exp-filter-lokasi")?.value || "";
  const uptPengirim   = document.getElementById("exp-filter-upt")?.value || "";
  const peruntukan    = document.getElementById("exp-filter-peruntukan")?.value || "";
  const kondisi       = document.getElementById("exp-filter-kondisi")?.value || "";

  const kalibFrom        = document.getElementById("exp-kalib-date-from")?.value || "";
  const kalibTo          = document.getElementById("exp-kalib-date-to")?.value || "";
  const kalibStatus      = document.getElementById("exp-filter-kalib-status")?.value || "";
  const kalibNoSertifikat = (document.getElementById("exp-filter-kalib-nomor")?.value || "").toLowerCase();

  const mutasiFrom    = document.getElementById("exp-mutasi-date-from")?.value || "";
  const mutasiTo      = document.getElementById("exp-mutasi-date-to")?.value || "";
  const mutasiAsal    = document.getElementById("exp-filter-mutasi-asal")?.value || "";
  const mutasiUptAsal = document.getElementById("exp-filter-mutasi-upt-asal")?.value || "";
  const mutasiTuju    = document.getElementById("exp-filter-mutasi-tuju")?.value || "";
  const mutasiUptTuju = document.getElementById("exp-filter-mutasi-upt-tuju")?.value || "";

  // ── Filter active (Pemeliharaan) rows ──
  const filteredActive = (_exportData.active || []).filter((r) => {
    const tgl = (r.tanggal || "").slice(0, 10);
    if (dateFrom && tgl && tgl < dateFrom) return false;
    if (dateTo   && tgl && tgl > dateTo)   return false;
    if (kondisi  && r.kondisi !== kondisi)  return false;
    if (lokasi) {
      // Use r.id_lokasi (per-row, from schema); fall back to aset current lokasi for legacy rows
      const asetItem  = db.find((x) => x.id_aset === r.id_aset);
      const rowCode   = r.id_lokasi || (asetItem ? (asetItem.id_lokasi_raw || asetItem.id_lokasi || "") : "");
      const parentCode = getParentLokasiCode(rowCode) || rowCode;
      if (parentCode !== lokasi && rowCode !== lokasi) return false;
    }
    if (uptPengirim) {
      const asetItem = db.find((x) => x.id_aset === r.id_aset);
      const rowCode  = r.id_lokasi || (asetItem ? (asetItem.id_lokasi_raw || asetItem.id_lokasi || "") : "");
      if (rowCode !== uptPengirim) return false;
    }
    if (peruntukan) {
      // Use r.peruntukan (per-row); fall back to aset current value for legacy rows
      const asetItem = db.find((x) => x.id_aset === r.id_aset);
      const rowPeruntukan = r.peruntukan || asetItem?.peruntukan || "";
      if (rowPeruntukan !== peruntukan) return false;
    }
    return true;
  });

  // ── Filter kalibrasi rows ──
  const filteredKalib = (_exportData.kalibrasi || []).filter((r) => {
    const tgl = (r.tanggal_kalibrasi || "").slice(0, 10);
    if (kalibFrom      && tgl && tgl < kalibFrom)   return false;
    if (kalibTo        && tgl && tgl > kalibTo)     return false;
    if (kalibStatus    && r.status !== kalibStatus) return false;
    if (kalibNoSertifikat && !(r.nomor_sertifikat || "").toLowerCase().includes(kalibNoSertifikat)) return false;
    return true;
  });

  // ── Filter mutasi rows (parent-code aware) ──
  const filteredMutasi = (_exportData.mutasi || []).filter((r) => {
    const tgl = (r.waktu_mutasi || r.tanggal || "").slice(0, 10);
    if (mutasiFrom && tgl && tgl < mutasiFrom) return false;
    if (mutasiTo   && tgl && tgl > mutasiTo)   return false;
    // A region selection matches the region itself or any UPT under it; a UPT
    // selection must match exactly. `*_raw` fields were read here before and
    // exist nowhere in the codebase, so both UPT filters were dead.
    const inRegion = (code, wanted) => {
      if (!wanted) return true;
      const c = code || "";
      return c === wanted || (getParentLokasiCode(c) || c) === wanted;
    };
    if (!inRegion(r.id_lokasi_asal, mutasiAsal)) return false;
    if (mutasiUptAsal && (r.id_lokasi_asal || "") !== mutasiUptAsal) return false;
    if (!inRegion(r.id_lokasi_tujuan, mutasiTuju)) return false;
    if (mutasiUptTuju && (r.id_lokasi_tujuan || "") !== mutasiUptTuju) return false;
    return true;
  });

  // Afkir was fetched and then handed straight through unfiltered, so the
  // Pemeliharaan filters above (alat / lokasi / UPT / tahun) had no effect on
  // the afkir tab or its export. It shares the Pemeliharaan filter set, since
  // those are the only fields an afkir row carries.
  const filteredAfkir = (_exportData.afkir || []).filter((r) => {
    const tgl = (r.tanggal || "").slice(0, 10);
    if (dateFrom && tgl && tgl < dateFrom) return false;
    if (dateTo   && tgl && tgl > dateTo)   return false;
    const rowCode = r.id_lokasi || "";
    if (lokasi) {
      const parent = getParentLokasiCode(rowCode) || rowCode;
      if (parent !== lokasi && rowCode !== lokasi) return false;
    }
    if (uptPengirim && rowCode !== uptPengirim) return false;
    if (peruntukan && (r.peruntukan || "") !== peruntukan) return false;
    return true;
  });
  _exportFiltered = { active: filteredActive, afkir: filteredAfkir, kalibrasi: filteredKalib, mutasi: filteredMutasi };

  // ── Stats (row 1 + row 2) ──
  const statTotal     = document.getElementById("exp-stat-total");
  const statSo        = document.getElementById("exp-stat-so");
  const statTso       = document.getElementById("exp-stat-tso");
  const statJenis     = document.getElementById("exp-stat-jenis");
  const statLokasi    = document.getElementById("exp-stat-lokasi");
  const statAvail     = document.getElementById("exp-stat-avail");
  const statBenchmark = document.getElementById("exp-stat-benchmark");
  const statTerbaru   = document.getElementById("exp-stat-terbaru");

  // Stats describe the FILTERED preview, not the whole fleet. They used to read
  // `db` directly, so every card sat frozen at the fleet total no matter what
  // the user filtered — the numbers openly disagreed with the table below them.
  // One row per asset, since the pemeliharaan export repeats an asset per event.
  const statAssets = [];
  const seenAsset = new Set();
  filteredActive.forEach((r) => {
    if (!r.id_aset || seenAsset.has(r.id_aset)) return;
    seenAsset.add(r.id_aset);
    statAssets.push(r);
  });

  const soCount = statAssets.filter((x) => (x.status || x.kondisi || x.status_terakhir) === "SO").length;
  const tsoCount = statAssets.filter((x) => (x.status || x.kondisi || x.status_terakhir) === "TSO").length;

  if (statTotal)  statTotal.textContent  = statAssets.length;
  if (statSo)     statSo.textContent     = soCount;
  if (statTso)    statTso.textContent    = tsoCount;
  if (statJenis)  statJenis.textContent  = new Set(statAssets.map((x) => x.kode_alat)).size;
  if (statLokasi) statLokasi.textContent = new Set(statAssets.map((x) => x.id_lokasi || x.id_lokasi_raw)).size;

  const availPct = statAssets.length ? Math.round((soCount / statAssets.length) * 100) : 0;
  if (statAvail) statAvail.textContent = `${availPct}%`;
  // Ketersediaan and Benchmark used to print the SAME number, which made the
  // second card meaningless. Benchmark is the configured target; showing the
  // gap against it is the only thing that makes the pair worth two cards.
  if (statBenchmark) {
    const delta = availPct - _benchmarkPct;
    const sign = delta > 0 ? "+" : "";
    statBenchmark.textContent = `${_benchmarkPct}%`;
    statBenchmark.title = `Ketersediaan ${availPct}% (${sign}${delta} poin terhadap benchmark)`;
    const deltaEl = document.getElementById("exp-stat-benchmark-delta");
    if (deltaEl) {
      deltaEl.textContent = `${sign}${delta} poin`;
      deltaEl.className =
        "text-xs font-bold mb-0.5 " +
        (delta >= 0 ? "text-green-500" : "text-red-500");
    }
  }

  const lastMonth = new Date(); lastMonth.setMonth(lastMonth.getMonth() - 1);
  const terbaruCount = statAssets.filter(
    (x) => x.tanggal_pembelian && new Date(x.tanggal_pembelian) >= lastMonth,
  ).length;
  if (statTerbaru) statTerbaru.textContent = terbaruCount;

  // ── Info strip ──
  const previewCount = document.getElementById("exp-preview-count");
  if (previewCount) {
    previewCount.innerHTML =
      `Pemeliharaan: <strong>${filteredActive.length}</strong> baris · ` +
      `Kalibrasi: <strong>${filteredKalib.length}</strong> baris · ` +
      `Mutasi: <strong>${filteredMutasi.length}</strong> baris · ` +
      `Afkir: <strong>${filteredAfkir.length}</strong> — akan diekspor sesuai tab aktif.`;
  }

  // ── Populate lokasi dropdowns once ──
  _populateExpLokasiDropdowns();

  // ── Render active tab preview ──
  renderExpTabPreview(_expActiveTab);
}

function _populateExpLokasiDropdowns() {
  const allLokasiOpts = lokasiData.map((l) =>
    `<option value="${l.code}">${l.name} (${l.code})</option>`
  ).join("");

  // Pemeliharaan: Lokasi Pengirim (parent codes)
  const lokasiPengirimEl = document.getElementById("exp-filter-lokasi");
  if (lokasiPengirimEl && lokasiPengirimEl.options.length <= 1) {
    lokasiPengirimEl.innerHTML = `<option value="">Semua Lokasi</option>` + allLokasiOpts;
  }

  // Pemeliharaan: Peruntukan
  const peruntukanEl = document.getElementById("exp-filter-peruntukan");
  if (peruntukanEl && peruntukanEl.options.length <= 1) {
    const uniquePeruntukan = [...new Set(db.map((x) => x.peruntukan).filter(Boolean))].sort();
    peruntukanEl.innerHTML = `<option value="">Semua Peruntukan</option>` +
      uniquePeruntukan.map((p) => `<option value="${p}">${p}</option>`).join("");
  }

  // Wire Lokasi Pengirim → UPT Pengirim cascade
  const lokasiSel = document.getElementById("exp-filter-lokasi");
  const uptSel    = document.getElementById("exp-filter-upt");
  if (lokasiSel && uptSel && !lokasiSel._expWiredPem) {
    lokasiSel._expWiredPem = true;
    lokasiSel.addEventListener("change", () => {
      const lokCode = lokasiSel.value;
      uptSel.innerHTML = `<option value="">Semua UPT</option>`;
      if (lokCode) {
        uptDatabase.filter((u) => u.lokasi === lokCode).forEach((u) => {
          const o = document.createElement("option");
          o.value = u.upt; o.textContent = u.nama;
          uptSel.appendChild(o);
        });
        uptSel.disabled = false;
      } else {
        uptSel.disabled = true;
      }
      applyExportFilters();
    });
  }

  // Mutasi lokasi dropdowns
  ["exp-filter-mutasi-asal", "exp-filter-mutasi-tuju"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el || el.options.length > 1) return;
    el.innerHTML = `<option value="">Semua Lokasi</option>` + allLokasiOpts;
  });

  // Wire Lokasi Asal → UPT Asal
  const asalSel    = document.getElementById("exp-filter-mutasi-asal");
  const uptAsalSel = document.getElementById("exp-filter-mutasi-upt-asal");
  if (asalSel && uptAsalSel && !asalSel._expWired) {
    asalSel._expWired = true;
    asalSel.addEventListener("change", () => {
      const lokCode = asalSel.value;
      uptAsalSel.innerHTML = `<option value="">Semua UPT</option>`;
      if (lokCode) {
        uptDatabase.filter((u) => u.lokasi === lokCode).forEach((u) => {
          const o = document.createElement("option");
          o.value = u.upt; o.textContent = u.nama;
          uptAsalSel.appendChild(o);
        });
        uptAsalSel.disabled = false;
      } else {
        uptAsalSel.disabled = true;
      }
      applyExportFilters();
    });
  }

  // Wire Lokasi Tujuan → UPT Tujuan
  const tujuSel    = document.getElementById("exp-filter-mutasi-tuju");
  const uptTujuSel = document.getElementById("exp-filter-mutasi-upt-tuju");
  if (tujuSel && uptTujuSel && !tujuSel._expWired) {
    tujuSel._expWired = true;
    tujuSel.addEventListener("change", () => {
      const lokCode = tujuSel.value;
      uptTujuSel.innerHTML = `<option value="">Semua UPT</option>`;
      if (lokCode) {
        uptDatabase.filter((u) => u.lokasi === lokCode).forEach((u) => {
          const o = document.createElement("option");
          o.value = u.upt; o.textContent = u.nama;
          uptTujuSel.appendChild(o);
        });
        uptTujuSel.disabled = false;
      } else {
        uptTujuSel.disabled = true;
      }
      applyExportFilters();
    });
  }
}

function renderExpTabPreview(tab) {
  _expActiveTab = tab;

  // Update tab button styles
  document.querySelectorAll(".exp-preview-tab").forEach((btn) => {
    btn.classList.remove("bg-kai-blue", "text-white", "shadow-sm",
      "bg-cyan-600", "bg-kai-orange");
    btn.classList.add("text-gray-500", "dark:text-gray-400");
  });
  document.querySelectorAll(".exp-preview-panel").forEach((p) => p.classList.add("hidden"));

  const countEl = document.getElementById("exp-preview-tab-count");

  if (tab === "pemeliharaan") {
    const btn = document.getElementById("exp-tab-pemeliharaan");
    if (btn) { btn.classList.remove("text-gray-500","dark:text-gray-400"); btn.classList.add("bg-kai-blue","text-white","shadow-sm"); }
    document.getElementById("exp-panel-pemeliharaan")?.classList.remove("hidden");
    const rows = _exportFiltered?.active || [];
    if (countEl) countEl.textContent = `${rows.length} baris`;
    _renderExpPemeliharaan(rows);
  } else if (tab === "kalibrasi") {
    const btn = document.getElementById("exp-tab-kalibrasi");
    if (btn) { btn.classList.remove("text-gray-500","dark:text-gray-400"); btn.classList.add("bg-cyan-600","text-white","shadow-sm"); }
    document.getElementById("exp-panel-kalibrasi")?.classList.remove("hidden");
    const rows = _exportFiltered?.kalibrasi || [];
    if (countEl) countEl.textContent = `${rows.length} baris`;
    _renderExpKalibrasi(rows);
  } else if (tab === "mutasi") {
    const btn = document.getElementById("exp-tab-mutasi");
    if (btn) { btn.classList.remove("text-gray-500","dark:text-gray-400"); btn.classList.add("bg-kai-orange","text-white","shadow-sm"); }
    document.getElementById("exp-panel-mutasi")?.classList.remove("hidden");
    const rows = _exportFiltered?.mutasi || [];
    if (countEl) countEl.textContent = `${rows.length} baris`;
    _renderExpMutasi(rows);
  }
}

function _resolveLokasiUpt(kode) {
  if (!kode || kode === "—") return { parentName: "—", uptName: "—" };
  const uptEntry = uptDatabase.find((u) => u.upt === kode);
  if (uptEntry) {
    const parentCode = getParentLokasiCode(kode) || uptEntry.lokasi;
    return {
      parentName: lokasiData.find((l) => l.code === parentCode)?.name || parentCode,
      uptName: uptEntry.nama,
    };
  }
  const parentEntry = lokasiData.find((l) => l.code === kode);
  return parentEntry ? { parentName: parentEntry.name, uptName: "—" } : { parentName: kode, uptName: "—" };
}

function _buildExpPemeliharaanDisplay(r, i = 0) {
  const aset = db.find((x) => x.id_aset === r.id_aset);
  // r.id_lokasi is the per-row lokasi stored by the backend (from the new schema column).
  // Fall back to the aset's current lokasi only for legacy rows that predate the schema change.
  const rowLokasi = r.id_lokasi || (aset ? (aset.id_lokasi_raw || aset.id_lokasi || "") : "");
  const lok = _resolveLokasiUpt(rowLokasi);
  // r.peruntukan is the per-row peruntukan stored at save time; fall back to aset current value.
  const peruntukanDisplay = r.peruntukan || aset?.peruntukan || "—";
  return {
    no: i + 1,
    tanggal: formatUtcToLocal(r.tanggal),
    id_aset: r.id_aset || "—",
    nama_alat: aset?.kode_alat_name || r.kode_alat || "—",
    lokasi_pengirim: lok.parentName,
    upt_pengirim: lok.uptName,
    peruntukan: peruntukanDisplay,
    petugas: r.id_pengguna || "—",
    kondisi: r.kondisi || "—",
    keterangan: r.keterangan || "—",
  };
}

function _buildExpKalibrasiDisplay(r, i = 0) {
  const aset = db.find((x) => x.id_aset === r.id_aset);
  const summaryItem = _historySummary.find((x) => x.id_aset === r.id_aset);
  const waktuInput = summaryItem?.kalibrasi?.latest_waktu_input
    ? formatUtcToLocal(summaryItem.kalibrasi.latest_waktu_input)
    : "—";
  return {
    no: i + 1,
    waktu_input: waktuInput,
    tanggal_kalibrasi: r.tanggal_kalibrasi ? formatDateOnly(r.tanggal_kalibrasi) : "—",
    id_aset: r.id_aset || "—",
    nama_alat: aset?.kode_alat_name || r.kode_alat || "—",
    status: r.status || "—",
    pelaksana: r.pelaksana_kalibrasi || "—",
    tanggal_berlaku: r.tanggal_berlaku ? formatDateOnly(r.tanggal_berlaku) : "—",
    nomor_sertifikat: r.nomor_sertifikat || "—",
    keterangan: r.keterangan || "—",
  };
}

function _buildExpMutasiDisplay(r, i = 0) {
  const aset = db.find((x) => x.id_aset === r.id_aset);

  // The API returns lokasi_asal/lokasi_tujuan as nama_upt strings.
  // Look them up in uptDatabase by nama to get the UPT code, then resolve
  // the parent lokasi name and UPT name from that code.
  function resolveFromUptName(uptNama) {
    if (!uptNama || uptNama === "—") return { parentName: "—", uptName: "—" };
    const uptEntry = uptDatabase.find((u) => u.nama === uptNama);
    if (uptEntry) {
      const parentName = lokasiData.find((l) => l.code === uptEntry.lokasi)?.name || uptEntry.lokasi || "—";
      return { parentName, uptName: uptEntry.nama };
    }
    // Maybe it's already a parent lokasi name (asset was never assigned a UPT)
    const lokasiEntry = lokasiData.find((l) => l.name === uptNama);
    if (lokasiEntry) return { parentName: lokasiEntry.name, uptName: "—" };
    return { parentName: uptNama, uptName: "—" };
  }

  const resolvedAsal = resolveFromUptName(r.lokasi_asal);
  const resolvedTuju = resolveFromUptName(r.lokasi_tujuan);
  const waktu = r.waktu_mutasi || r.tanggal || "—";
  return {
    no: i + 1,
    tanggal: formatUtcToLocal(waktu),
    id_aset: r.id_aset || "—",
    nama_alat: aset?.kode_alat_name || r.kode_alat || "—",
    lokasi_asal: resolvedAsal.parentName,
    upt_asal: resolvedAsal.uptName,
    lokasi_tujuan: resolvedTuju.parentName,
    upt_tujuan: resolvedTuju.uptName,
    alasan: r.alasan_mutasi || r.alasan || "—",
    petugas: r.id_pengguna || r.oleh || "—",
  };
}

function _renderExpPemeliharaan(rows) {
  const tbody = document.getElementById("exp-body-pemeliharaan");
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="px-3 py-6 text-center text-gray-400">Tidak ada data pemeliharaan dengan filter ini.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r, i) => {
    const item = _buildExpPemeliharaanDisplay(r, i);
    const kondisiCls = item.kondisi === "SO" ? "text-green-600 dark:text-green-400" : item.kondisi === "TSO" ? "text-red-600 dark:text-red-400" : "text-blue-500";
    return `<tr class="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
        <td class="px-3 py-2 text-center text-gray-400">${item.no}</td>
        <td class="px-3 py-2 font-mono">${item.tanggal}</td>
        <td class="px-3 py-2 font-bold text-kai-blue dark:text-blue-400 font-mono">${item.id_aset}</td>
        <td class="px-3 py-2">${item.nama_alat}</td>
        <td class="px-3 py-2">${item.lokasi_pengirim}</td>
        <td class="px-3 py-2">${item.upt_pengirim}</td>
        <td class="px-3 py-2">${item.peruntukan}</td>
        <td class="px-3 py-2">${item.petugas}</td>
        <td class="px-3 py-2 font-bold ${kondisiCls}">${item.kondisi}</td>
        <td class="px-3 py-2 text-gray-500 dark:text-gray-400 italic">${item.keterangan}</td>
    </tr>`;
  }).join("");
}

function _renderExpKalibrasi(rows) {
  const tbody = document.getElementById("exp-body-kalibrasi");
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="px-3 py-6 text-center text-gray-400">Tidak ada data kalibrasi dengan filter ini.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r, i) => {
    const item = _buildExpKalibrasiDisplay(r, i);
    const statusCls = item.status === "LULUS" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
      : item.status === "BERSYARAT" ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
      : item.status === "GAGAL" ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
      : "bg-gray-100 text-gray-400";
    return `<tr class="hover:bg-cyan-50/30 dark:hover:bg-cyan-900/10 transition-colors">
        <td class="px-3 py-2 text-center text-gray-400">${item.no}</td>
        <td class="px-3 py-2 font-mono text-xs">${item.waktu_input}</td>
        <td class="px-3 py-2 font-mono text-xs">${item.tanggal_kalibrasi}</td>
        <td class="px-3 py-2 font-bold text-kai-blue dark:text-blue-400 font-mono">${item.id_aset}</td>
        <td class="px-3 py-2">${item.nama_alat}</td>
        <td class="px-3 py-2"><span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${statusCls}">${item.status}</span></td>
        <td class="px-3 py-2">${item.pelaksana}</td>
        <td class="px-3 py-2 font-mono text-xs">${item.tanggal_berlaku}</td>
        <td class="px-3 py-2 font-mono">${item.nomor_sertifikat}</td>
        <td class="px-3 py-2 text-gray-500 dark:text-gray-400 italic">${item.keterangan}</td>
    </tr>`;
  }).join("");
}

function _renderExpMutasi(rows) {
  const tbody = document.getElementById("exp-body-mutasi");
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="px-3 py-6 text-center text-gray-400">Tidak ada data mutasi dengan filter ini.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r, i) => {
    const item = _buildExpMutasiDisplay(r, i);
    return `<tr class="hover:bg-orange-50/30 dark:hover:bg-orange-900/10 transition-colors">
      <td class="px-3 py-2 text-center text-gray-400">${item.no}</td>
      <td class="px-3 py-2 font-mono">${item.tanggal}</td>
      <td class="px-3 py-2 font-bold text-kai-blue dark:text-blue-400 font-mono">${item.id_aset}</td>
      <td class="px-3 py-2">${item.nama_alat}</td>
      <td class="px-3 py-2">${item.lokasi_asal}</td>
      <td class="px-3 py-2 text-gray-500 dark:text-gray-400">${item.upt_asal}</td>
      <td class="px-3 py-2 font-medium text-kai-orange dark:text-orange-400">${item.lokasi_tujuan}</td>
      <td class="px-3 py-2 text-gray-500 dark:text-gray-400">${item.upt_tujuan}</td>
      <td class="px-3 py-2 text-gray-500 dark:text-gray-400 italic">${item.alasan}</td>
      <td class="px-3 py-2">${item.petugas}</td>
    </tr>`;
  }).join("");
}

// ── Tab switching listeners ──
["pemeliharaan", "kalibrasi", "mutasi"].forEach((tab) => {
  document.getElementById(`exp-tab-${tab}`)?.addEventListener("click", () => renderExpTabPreview(tab));
});

// ── Wire all filter inputs ──
[
  "exp-date-from", "exp-date-to", "exp-filter-lokasi", "exp-filter-upt",
  "exp-filter-peruntukan", "exp-filter-kondisi",
  "exp-kalib-date-from", "exp-kalib-date-to", "exp-filter-kalib-status", "exp-filter-kalib-nomor",
  "exp-mutasi-date-from", "exp-mutasi-date-to",
  "exp-filter-mutasi-upt-asal", "exp-filter-mutasi-upt-tuju",
].forEach((id) => {
  document.getElementById(id)?.addEventListener("change", applyExportFilters);
  document.getElementById(id)?.addEventListener("input", applyExportFilters);
});

// ── EXCEL EXPORT ──────────────────────────────────────────────────

document
  .getElementById("btn-export-excel")
  ?.addEventListener("click", async () => {
    if (!window.XLSX) {
      showToast("Library Excel belum siap, tunggu sebentar.", "warning");
      return;
    }

    const btn = document.getElementById("btn-export-excel");
    const orig = btn.innerHTML;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Membuat file...`;
    btn.disabled = true;

    try {
      const repairHeaders = [
        "No",
        "Tanggal Laporan",
        "ID Aset",
        "Nama Alat",
        "Lokasi Pengirim",
        "UPT Pengirim",
        "Peruntukan",
        "Petugas",
        "Kondisi",
        "Keterangan",
      ];
      const mutasiHeaders = [
        "No",
        "Tanggal Mutasi",
        "ID Aset",
        "Nama Alat",
        "Lokasi Asal",
        "UPT Asal",
        "Lokasi Tujuan",
        "UPT Tujuan",
        "Keterangan",
        "Petugas",
      ];

      function makeSheet(headers, rows, mapFn) {
        const data = [headers, ...rows.map(mapFn)];
        const ws = XLSX.utils.aoa_to_sheet(data);
        ws["!cols"] = headers.map(() => ({ wch: 22 }));
        const range = XLSX.utils.decode_range(ws["!ref"]);
        for (let C = range.s.c; C <= range.e.c; C++) {
          const cell = ws[XLSX.utils.encode_cell({ r: 0, c: C })];
          if (cell) cell.s = { font: { bold: true } };
        }
        return ws;
      }

      const wb = XLSX.utils.book_new();

      // Tab 1: Riwayat Perbaikan
      XLSX.utils.book_append_sheet(
        wb,
        makeSheet(
          repairHeaders,
          _exportFiltered.active || [],
          (r, i) => {
            const item = _buildExpPemeliharaanDisplay(r, i);
            return [
              item.no,
              item.tanggal,
              item.id_aset,
              item.nama_alat,
              item.lokasi_pengirim,
              item.upt_pengirim,
              item.peruntukan,
              item.petugas,
              item.kondisi,
              item.keterangan,
            ];
          },
        ),
        "Riwayat Perbaikan",
      );

      // Tab 2: Riwayat Kalibrasi
      const kalibHeaders = ["No","Tgl. Laporan","Tgl. Kalibrasi","ID Aset","Nama Alat","Status","Pelaksana","Tgl. Berlaku","No. Sertifikat","Catatan"];
      XLSX.utils.book_append_sheet(
        wb,
        makeSheet(kalibHeaders, _exportFiltered.kalibrasi || [], (r, i) => {
          const item = _buildExpKalibrasiDisplay(r, i);
          return [
            item.no,
            item.waktu_input,
            item.tanggal_kalibrasi,
            item.id_aset,
            item.nama_alat,
            item.status,
            item.pelaksana,
            item.tanggal_berlaku,
            item.nomor_sertifikat,
            item.keterangan,
          ];
        }),
        "Riwayat Kalibrasi",
      );

      // Tab 3: Riwayat Mutasi (use already-filtered data)
      XLSX.utils.book_append_sheet(
        wb,
        makeSheet(mutasiHeaders, _exportFiltered.mutasi || [], (r, i) => {
          const item = _buildExpMutasiDisplay(r, i);
          return [
            item.no,
            item.tanggal,
            item.id_aset,
            item.nama_alat,
            item.lokasi_asal,
            item.upt_asal,
            item.lokasi_tujuan,
            item.upt_tujuan,
            item.alasan,
            item.petugas,
          ];
        }),
        "Riwayat Mutasi",
      );

      const dateStr = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `SIMAKAI_Laporan_${dateStr}.xlsx`);
      showToast("File Excel berhasil diunduh.", "success");
    } catch (e) {
      console.error(e);
      showToast("Gagal membuat file Excel.", "error");
    } finally {
      btn.innerHTML = orig;
      btn.disabled = false;
    }
  });

// ── PDF EXPORT ────────────────────────────────────────────────────

document
  .getElementById("btn-export-pdf")
  ?.addEventListener("click", async () => {
    if (!window.jspdf) {
      showToast("Library PDF belum siap, tunggu sebentar.", "warning");
      return;
    }

    const btn = document.getElementById("btn-export-pdf");
    const orig = btn.innerHTML;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Membuat PDF...`;
    btn.disabled = true;

    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({
        orientation: "landscape",
        unit: "mm",
        format: "a4",
      });
      const dateStr = new Date().toLocaleDateString("id-ID", {
        day: "2-digit",
        month: "long",
        year: "numeric",
      });

      const repairCols = [
        "No",
        "Tanggal Laporan",
        "ID Aset",
        "Nama Alat",
        "Lokasi Pengirim",
        "UPT Pengirim",
        "Peruntukan",
        "Petugas",
        "Kondisi",
        "Keterangan",
      ];
      const mutasiCols = [
        "No",
        "Tanggal Mutasi",
        "ID Aset",
        "Nama Alat",
        "Lokasi Asal",
        "UPT Asal",
        "Lokasi Tujuan",
        "UPT Tujuan",
        "Keterangan / BKO",
        "Petugas",
      ];

      const allRepair = _exportFiltered.active || [];

      // Page 1+: Perbaikan
      doc.setFontSize(13);
      doc.setFont("helvetica", "bold");
      doc.text("RAMCES Light Machinery — Laporan Riwayat Perbaikan Alat Kerja", 14, 14);
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      doc.text(
        `Dicetak: ${dateStr}  |  Total: ${allRepair.length} baris`,
        14,
        20,
      );

      doc.autoTable({
        head: [repairCols],
        body: allRepair.map((r, i) => {
          const item = _buildExpPemeliharaanDisplay(r, i);
          return [
            item.no,
            item.tanggal,
            item.id_aset,
            item.nama_alat,
            item.lokasi_pengirim,
            item.upt_pengirim,
            item.peruntukan,
            item.petugas,
            item.kondisi,
            item.keterangan,
          ];
        }),
        startY: 25,
        styles: { fontSize: 7, cellPadding: 2, overflow: "linebreak" },
        headStyles: {
          fillColor: [22, 76, 129],
          textColor: 255,
          fontStyle: "bold",
        },
        alternateRowStyles: { fillColor: [241, 245, 249] },
        didDrawCell: (data) => {
          if (data.section === "body" && data.column.index === 7) {
            const val = data.cell.raw;
            doc.setTextColor(
              val === "SO" ? 22 : val === "TSO" ? 220 : 0,
              val === "SO" ? 163 : val === "TSO" ? 38 : 0,
              val === "SO" ? 74 : val === "TSO" ? 38 : 0,
            );
            doc.setFontSize(7);
            doc.text(String(val), data.cell.x + 2, data.cell.y + 4);
            doc.setTextColor(0, 0, 0);
          }
        },
      });

      // Next page: Kalibrasi
      const kalibDataPdf = _exportFiltered.kalibrasi || [];
      const kalibColsPdf = ["No","Tgl. Laporan","Tgl. Kalibrasi","ID Aset","Nama Alat","Status","Pelaksana","Tgl. Berlaku","No. Sertifikat","Catatan"];
      doc.addPage();
      doc.setFontSize(13);
      doc.setFont("helvetica", "bold");
      doc.text("RAMCES Light Machinery — Laporan Riwayat Kalibrasi Alat Kerja", 14, 14);
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      doc.text(`Dicetak: ${dateStr}  |  Total: ${kalibDataPdf.length} baris`, 14, 20);
      doc.autoTable({
        head: [kalibColsPdf],
        body: kalibDataPdf.map((r, i) => {
          const item = _buildExpKalibrasiDisplay(r, i);
          return [
            item.no,
            item.waktu_input,
            item.tanggal_kalibrasi,
            item.id_aset,
            item.nama_alat,
            item.status,
            item.pelaksana,
            item.tanggal_berlaku,
            item.nomor_sertifikat,
            item.keterangan,
          ];
        }),
        startY: 25,
        styles: { fontSize: 7, cellPadding: 2, overflow: "linebreak" },
        headStyles: { fillColor: [8, 145, 178], textColor: 255, fontStyle: "bold" },
        alternateRowStyles: { fillColor: [236, 254, 255] },
      });

      // Next page: Mutasi (use already-filtered data)
      const mutasiDataPdf = _exportFiltered.mutasi || [];
      doc.addPage();
      doc.setFontSize(13);
      doc.setFont("helvetica", "bold");
      doc.text("RAMCES Light Machinery — Laporan Riwayat Mutasi Aset", 14, 14);
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      doc.text(
        `Dicetak: ${dateStr}  |  Total: ${mutasiDataPdf.length} baris`,
        14,
        20,
      );

      doc.autoTable({
        head: [mutasiCols],
        body: mutasiDataPdf.map((r, i) => {
          const item = _buildExpMutasiDisplay(r, i);
          return [
            item.no,
            item.tanggal,
            item.id_aset,
            item.nama_alat,
            item.lokasi_asal,
            item.upt_asal,
            item.lokasi_tujuan,
            item.upt_tujuan,
            item.alasan,
            item.petugas,
          ];
        }),
        startY: 25,
        styles: { fontSize: 7, cellPadding: 2, overflow: "linebreak" },
        headStyles: {
          fillColor: [243, 134, 27],
          textColor: 255,
          fontStyle: "bold",
        },
        alternateRowStyles: { fillColor: [255, 247, 237] },
      });

      const fileDate = new Date().toISOString().slice(0, 10);
      doc.save(`SIMAKAI_Laporan_${fileDate}.pdf`);
      showToast("File PDF berhasil diunduh.", "success");
    } catch (e) {
      console.error(e);
      showToast("Gagal membuat file PDF.", "error");
    } finally {
      btn.innerHTML = orig;
      btn.disabled = false;
    }
  });

window.openMutasiModal = (uid) => {
  const item = db.find((x) => x.id_aset === uid);
  if (!item) return;

  document.getElementById("mutasi-uid").value = uid;
  document.getElementById("mutasi-modal-subtitle").innerText = item.id_aset;

  // Lokasi Asal: use original lokasi from history summary (before any mutations)
  // item.id_lokasi is now UPT code, so get parent for region name
  const summaryItem = _historySummary.find((x) => x.id_aset === uid);

  function formatLocationDisplay(code) {
    if (!code) return "—";
    const parentCode = getParentLokasiCode(code) || code;
    const parentEntry = lokasiData.find((l) => l.code === parentCode);
    const parentName = parentEntry?.name || parentCode || "—";
    const uptEntry = uptDatabase.find((u) => u.upt === code);
    const uptName = uptEntry?.nama || "—";
    return uptName !== "—" ? `${parentName} (${uptName})` : parentName;
  }

  // ── Lokasi Asal (ORIGINAL — sebelum mutasi) ──
  const rawOriginal = summaryItem?.mutasi?.original_lokasi_code || item.id_lokasi_raw || item.id_lokasi || "";
  const rawKini = item.id_lokasi_raw || item.id_lokasi || "";
  const originalDisplay = formatLocationDisplay(rawOriginal);
  const kiniDisplay = formatLocationDisplay(rawKini);

  const asalEl = document.getElementById("mutasi-lokasi-asal");
  const kiniEl = document.getElementById("mutasi-lokasi-kini");
  if (asalEl) asalEl.textContent = originalDisplay;
  if (kiniEl) kiniEl.textContent = kiniDisplay;

  // Populate destination dropdown
  const tujuSel = document.getElementById("mutasi-lokasi-tuju");
  // ("A" || "B") evaluates to "A", so the old form silently only ever tested
  // ADMIN_WILAYAH. Region-scoped roles may only mutate within their own region.
  const isRegionScoped = ["ADMIN_WILAYAH", "TEKNISI"].includes(_currentRole);
  const myLokasi = getJwtPayload(authToken)?.id_lokasi || "";
  const myParent = getParentLokasiCode(myLokasi) || myLokasi;
  const options = isRegionScoped
    ? lokasiData.filter((l) => l.code === myParent)
    : lokasiData.filter((l) => l.code);

  tujuSel.innerHTML =
    '<option value="">Pilih Lokasi Tujuan...</option>' +
    options.map((l) => `<option value="${l.code}">${l.name}</option>`).join("");

  // Wire tuju → UPT select (fix disabled bug: must re-wire every modal open)
  const uptTujuEl = document.getElementById("mutasi-upt-tuju");
  const uptTujuLbl = document.getElementById("mutasi-upt-tuju-label"); // add id to the <label> in HTML if not present
  if (uptTujuEl) {
    uptTujuEl.innerHTML =
      '<option value="">Pilih Lokasi Tujuan dahulu...</option>';
    uptTujuEl.disabled = true;
    uptTujuEl.required = false;

    tujuSel.onchange = () => {
      const selectedLok = tujuSel.value;
      const currentLok = item.id_lokasi_raw || item.id_lokasi;
      const isSameLok = selectedLok === currentLok;

      if (!selectedLok) {
        uptTujuEl.innerHTML =
          '<option value="">Pilih Lokasi Tujuan dahulu...</option>';
        uptTujuEl.disabled = true;
        uptTujuEl.required = false;
        if (uptTujuLbl) uptTujuLbl.textContent = "Target UPT";
        return;
      }

      // Enable and populate UPT dropdown
      applyUptSelect(selectedLok, uptTujuEl);

      if (isSameLok) {
        // Same region → UPT is optional (just moving within the same DAOP/DIVRE)
        uptTujuEl.required = false;
        // Prepend "opsional" placeholder
        if (uptTujuEl.options[0])
          uptTujuEl.options[0].text = "Pilih Target UPT (opsional)";
        if (uptTujuLbl) uptTujuLbl.textContent = "Target UPT (Opsional)";
      } else {
        // Different region → UPT is required
        uptTujuEl.required = true;
        if (uptTujuEl.options[0])
          uptTujuEl.options[0].text = "Pilih Target UPT...";
        if (uptTujuLbl) uptTujuLbl.textContent = "Target UPT (Wajib)";
      }
    };
  }

  document.getElementById("mutasi-alasan").value = "";

  // Pre-fill Petugas with the logged-in username; user can override freely
  const petugasEl = document.getElementById("mutasi-petugas");
  if (petugasEl) petugasEl.value = currentUser || "";

  // Pre-select the user's default Lokasi from JWT, then fire UPT cascade
  const jwtPayload   = getJwtPayload(authToken);
  const userLokasi   = jwtPayload?.id_lokasi || "";
  const userParent   = getParentLokasiCode(userLokasi) || userLokasi;
  if (tujuSel && userParent) {
    tujuSel.value = userParent;
    tujuSel.dispatchEvent(new Event("change"));
  }

  document.getElementById("mutasi-modal").classList.remove("hidden");
};

// ── QR MODAL ───────────────────────────────────────────────────────────────

function buildLandingUrl(uid) {
  return `${getPublicBaseUrl()}/landing.html?uid=${encodeURIComponent(uid)}`;
}

function drawQrOnCanvas(text, targetCanvas) {
  return new Promise((resolve) => {
    const tmp = document.createElement("div");
    tmp.style.cssText =
      "visibility:hidden;width:200px;height:200px;overflow:hidden;";
    document.body.appendChild(tmp);

    new QRCode(tmp, {
      text,
      width: 200,
      height: 200,
      colorDark: "#000000",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M,
    });

    function copyAndClean(source) {
      const ctx = targetCanvas.getContext("2d");
      ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
      ctx.drawImage(source, 0, 0, 200, 200);
      document.body.removeChild(tmp);
      resolve();
    }

    const child = tmp.querySelector("canvas") || tmp.querySelector("img");

    if (!child) {
      requestAnimationFrame(() => {
        const retry = tmp.querySelector("canvas") || tmp.querySelector("img");
        if (!retry) {
          document.body.removeChild(tmp);
          resolve();
          return;
        }
        if (retry.tagName === "IMG" && !retry.complete) {
          retry.onload = () => copyAndClean(retry);
          retry.onerror = () => {
            document.body.removeChild(tmp);
            resolve();
          };
        } else {
          copyAndClean(retry);
        }
      });
      return;
    }

    if (child.tagName === "CANVAS") {
      copyAndClean(child);
    } else {
      if (child.complete && child.naturalWidth > 0) {
        copyAndClean(child);
      } else {
        child.onload = () => copyAndClean(child);
        child.onerror = () => {
          document.body.removeChild(tmp);
          resolve();
        };
      }
    }
  });
}

window.openQrModal = async (uid) => {
  const item = db.find((x) => x.id_aset === uid);
  if (!item) return;

  _qrActiveItem = item;

  document.getElementById("qr-modal-subtitle").innerText = item.id_aset;
  document.getElementById("qr-label-kodeid").innerText = item.id_aset;
  document.getElementById("qr-label-alat").innerText = item.kode_alat;
  document.getElementById("qr-label-lokasi").innerText = item.id_lokasi;

  const landingUrl = buildLandingUrl(uid);
  const linkEl = document.getElementById("qr-landing-link");
  const linkText = document.getElementById("qr-landing-link-text");
  if (linkEl && linkText) {
    linkText.textContent = landingUrl;
    linkEl.href = landingUrl;
  }

  const copyBtn = document.getElementById("btn-copy-link");
  if (copyBtn) {
    copyBtn.innerHTML = '<i class="fas fa-copy"></i>';
    copyBtn.title = "Salin link";
  }

  document.getElementById("qr-modal").classList.remove("hidden");

  const canvas = document.getElementById("qr-canvas");
  await drawQrOnCanvas(landingUrl, canvas);
};

function closeQrModal() {
  document.getElementById("qr-modal").classList.add("hidden");
  _qrActiveItem = null;
}

async function downloadQrPng() {
  if (!_qrActiveItem) return;

  const btn = document.getElementById("btn-qr-download-png");
  const originalHtml = btn.innerHTML;
  btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Memproses...`;
  btn.disabled = true;

  try {
    if (!window.html2canvas) {
      await loadScript(
        "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js",
      );
    }

    const labelEl = document.getElementById("qr-label-preview");
    const canvas = await html2canvas(labelEl, {
      backgroundColor: "#ffffff",
      scale: 3,
      useCORS: true,
      logging: false,
    });

    const link = document.createElement("a");
    link.download = `QR_${_qrActiveItem.id_aset}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();

    showToast(
      `PNG berhasil diunduh: QR_${_qrActiveItem.id_aset}.png`,
      "success",
    );
  } catch (err) {
    console.error(err);
    showToast("Gagal membuat PNG. Coba lagi.", "error");
  } finally {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }
}

async function downloadQrPdf() {
  if (!_qrActiveItem) return;

  const btn = document.getElementById("btn-qr-download-pdf");
  const originalHtml = btn.innerHTML;
  btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Membuka...`;
  btn.disabled = true;

  try {
    const qrCanvas = document.getElementById("qr-canvas");
    const qrDataUrl = qrCanvas.toDataURL("image/png");

    const labelEl = document.getElementById("qr-label-preview");
    const clone = labelEl.cloneNode(true);

    const cloneCanvas = clone.querySelector("canvas");
    if (cloneCanvas) {
      const img = document.createElement("img");
      img.src = qrDataUrl;
      img.width = 180;
      img.height = 180;
      cloneCanvas.parentNode.replaceChild(img, cloneCanvas);
    }

    const printArea = document.getElementById("qr-print-area");
    printArea.innerHTML = "";
    printArea.appendChild(clone);

    await new Promise((r) => setTimeout(r, 150));
    window.print();

    printArea.innerHTML = "";
    showToast("Dialog cetak/simpan PDF telah dibuka.", "info");
  } catch (err) {
    console.error(err);
    showToast("Gagal membuka dialog cetak.", "error");
  } finally {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }
}

const _scriptLoadPromises = new Map();

function loadScript(src) {
  if (_scriptLoadPromises.has(src)) {
    return _scriptLoadPromises.get(src);
  }

  const promise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      // If script exists but is still loading, we can't know.
      // Best effort: resolve immediately (may cause race if not loaded yet).
      // For production, use a script loader library.
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => {
      _scriptLoadPromises.delete(src);
      resolve();
    };
    s.onerror = () => {
      _scriptLoadPromises.delete(src);
      reject(new Error(`Failed to load ${src}`));
    };
    document.head.appendChild(s);
  });

  _scriptLoadPromises.set(src, promise);
  return promise;
}

// ── KDAK (Kelola Aset Alat Kerja) ────────────────────────────────────────

// ── Stats ──
function updateKdakStats() {
  const total = db.length;
  const so = db.filter((a) => a.status_terakhir === "SO").length;
  const tso = db.filter((a) => a.status_terakhir === "TSO").length;
  const jenisUnik = new Set(db.map((a) => a.kode_alat)).size;
  const lokasiUnik = new Set(db.map((a) => a.id_lokasi_raw || a.id_lokasi)).size;
  const avail = total > 0 ? Math.round((so / total) * 100) : null;
  const delta = avail !== null ? avail - _benchmarkPct : null;

  const now = new Date();
  const terbaru = db.filter((a) => {
    if (!a.tanggal_pembelian) return false;
    const d = new Date(a.tanggal_pembelian);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }).length;

  const _s = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  _s("kdak-stat-total", total || "—");
  _s("kdak-stat-so", so || "—");
  _s("kdak-stat-tso", tso || "—");
  _s("kdak-stat-jenis", jenisUnik || "—");
  _s("kdak-stat-lokasi", lokasiUnik || "—");
  _s("kdak-stat-avail", avail !== null ? `${avail}%` : "—");
  _s("kdak-stat-benchmark", `${_benchmarkPct}%`);
  _s("kdak-stat-terbaru", terbaru || "—");

  const deltaEl = document.getElementById("kdak-stat-benchmark-delta");
  if (deltaEl && delta !== null) {
    deltaEl.textContent = `${delta >= 0 ? "+" : ""}${delta}%`;
    deltaEl.className = `text-xs font-bold mb-0.5 ${delta >= 0 ? "text-green-500" : "text-red-500"}`;
  }
}

// ── Table ──
let _kdakSearch = "";
let _kdakSortField = "id_aset";
let _kdakSortDir = "date-desc";
let _kdakSortFilters = {};

function renderKdakTable() {
  const tbody = document.getElementById("kdak-table-body");
  const countEl = document.getElementById("kdak-table-count");
  if (!tbody) return;

  const q = _kdakSearch.toUpperCase();
  const f = _kdakSortFilters;

  let filtered = db.filter((a) => {
    // Search filter
    if (q) {
      const matchSearch =
        (a.id_aset || "").toUpperCase().includes(q) ||
        (a.kode_alat || "").toUpperCase().includes(q) ||
        (a.kode_alat_name || "").toUpperCase().includes(q) ||
        (a.id_lokasi_display || "").toUpperCase().includes(q) ||
        (a.id_lokasi || "").toUpperCase().includes(q) ||
        (a.sumber_pengadaan || "").toUpperCase().includes(q) ||
        (a.status_terakhir || "").toUpperCase().includes(q) ||
        (a.peruntukan || "").toUpperCase().includes(q) ||
        (a.tanggal_pembelian || "").toUpperCase().includes(q);
      if (!matchSearch)
        return false;
    }
    // Custom sort filters (same logic as renderDbCards)
    if (f.alat && a.kode_alat !== f.alat)
      return false;
    if (!_pengadaanMatches(a.sumber_pengadaan, f.pengadaan)) return false;
    if (f.peruntukan) {
      const dec = decodeAsetId(a.id_aset);
      if (dec.peruntukan !== f.peruntukan)
        return false;
    }
    if (f.lokasi) {
      const _rawUpt = a.id_lokasi_raw || a.id_lokasi || "";
      const _parent = getParentLokasiCode(_rawUpt) || _rawUpt;
      if (_parent !== f.lokasi && _rawUpt !== f.lokasi) return false;
    }
    if (f.upt && a.id_lokasi_raw !== f.upt && a.id_lokasi !== f.upt)
        return false;
    if (f.tahunFrom || f.tahunTo) {
      const yr = parseInt((a.tanggal_pembelian || "").slice(0, 4));
      if (f.tahunFrom && yr < parseInt(f.tahunFrom))
        return false;
      if (f.tahunTo && yr > parseInt(f.tahunTo))
        return false;
    }
    if (f.idFrom || f.idTo) {
      const num = parseInt((a.id_aset || "").split(".")[0]) || 0;
      if (f.idFrom && num < f.idFrom)
        return false;
      if (f.idTo && num > f.idTo)
        return false;
    }
    return true;
  });

  // Sort — mirrors renderDbCards logic
  filtered = [...filtered].sort((a, b) => {
    if (_kdakSortDir === "date-desc") return new Date(b.tanggal_pembelian || 0) - new Date(a.tanggal_pembelian || 0);
    if (_kdakSortDir === "date-asc") return new Date(a.tanggal_pembelian || 0) - new Date(b.tanggal_pembelian || 0);
    // The buttons are labelled "Terbanyak / Tersedikit", but this used to
    // partition on SO vs TSO — a two-value status, not a count. Now it sorts by
    // real activity (perbaikan + mutasi), matching the other three modals.
    if (_kdakSortDir === "count-desc") return _eventCount(b) - _eventCount(a);
    if (_kdakSortDir === "count-asc") return _eventCount(a) - _eventCount(b);
    const av = (a[_kdakSortField] || "").toString().toUpperCase();
    const bv = (b[_kdakSortField] || "").toString().toUpperCase();
    return _kdakSortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
  });

  // The count reports the whole filtered set, not the page — it answers "how
  // many match", which paging must not change.
  if (countEl) countEl.textContent = `${filtered.length} aset`;

  if (!filtered.length) {
    renderPagerBar("kdak-pager", paginateList("kdak", filtered), renderKdakTable);
    tbody.innerHTML = `<tr><td colspan="11" class="text-center py-10 text-sm text-gray-400">Tidak ada data ditemukan.</td></tr>`;
    return;
  }

  // Slice AFTER filter + sort.
  const _kdakPage = paginateList("kdak", filtered);
  renderPagerBar("kdak-pager", _kdakPage, renderKdakTable);

  tbody.innerHTML = _kdakPage.items
    .map((a) => {
      const summaryItem = _historySummary.find((x) => x.id_aset === a.id_aset);

      // Badge 1: SO / TSO
      const isSO = a.status_terakhir === "SO";
      const kondisiBadge = isSO
        ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"><i class="fas fa-circle text-[6px]"></i>SO</span>`
        : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"><i class="fas fa-circle text-[6px]"></i>TSO</span>`;

      // Badge 2: Kalibrasi status
      const kalibStatus = summaryItem?.kalibrasi?.latest_status;
      const kalibBadge = kalibStatus === "LULUS"
        ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"><i class="fas fa-circle text-[6px]"></i>LULUS</span>`
        : kalibStatus === "BERSYARAT"
        ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"><i class="fas fa-circle text-[6px]"></i>BERSYARAT</span>`
        : kalibStatus === "GAGAL"
        ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400"><i class="fas fa-circle text-[6px]"></i>GAGAL</span>`
        : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-gray-100 text-gray-400 dark:bg-gray-700 dark:text-gray-500"><i class="fas fa-circle text-[6px]"></i>BLM KALIBRASI</span>`;

      // Badge 3: Mutasi status
      const mutasiInfo = summaryItem?.mutasi;
      const mutasiBadge = (mutasiInfo && mutasiInfo.count > 0)
        ? mutasiInfo.sudah_kembali
          ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"><i class="fas fa-circle text-[6px]"></i>DI LOKASI ASAL</span>`
          : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"><i class="fas fa-circle text-[6px]"></i>SEDANG TERMUTASI</span>`
        : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-gray-100 text-gray-400 dark:bg-gray-700 dark:text-gray-500"><i class="fas fa-circle text-[6px]"></i>TIDAK TERMUTASI</span>`;

      const uptCode = a.id_lokasi_raw || a.id_lokasi || "";
      const uptEntry = uptDatabase.find((u) => u.upt === uptCode);
      const isUptDirect = !uptEntry && !!lokasiData.find((l) => l.code === uptCode);
      const uptDisplayName = uptEntry ? (uptEntry.nama || uptCode) : (isUptDirect ? "—" : uptCode || "—");
      const wilayahName = uptEntry
        ? lokasiData.find((l) => l.code === uptEntry.lokasi)?.name || uptEntry.lokasi
        : lokasiData.find((l) => l.code === uptCode)?.name || "—";

      const peruntukanDisplay = a.peruntukan || "—";

      return `<tr class="border-b border-gray-50 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
        <td class="px-4 py-3 font-mono text-xs text-kai-blue dark:text-blue-400 font-semibold whitespace-nowrap">${a.id_aset || "—"}</td>
        <td class="px-4 py-3 text-sm text-gray-700 dark:text-gray-200">${a.kode_alat_name || a.kode_alat || "—"}</td>
        <td class="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">${a.sumber_pengadaan || "—"}</td>
        <td class="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">${a.tanggal_pembelian || "—"}</td>
        <td class="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">${peruntukanDisplay}</td>
        <td class="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">${wilayahName}</td>
        <td class="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">${uptDisplayName}</td>
        <td class="px-4 py-3">${kondisiBadge}</td>
        <td class="px-4 py-3">${kalibBadge}</td>
        <td class="px-4 py-3">${mutasiBadge}</td>
        <td class="px-4 py-3 text-right whitespace-nowrap">
          <button onclick="window.openKdakEdit('${a.id_aset}')"
            class="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-3 py-1 rounded-lg font-bold hover:bg-blue-200 transition">
            <i class="fas fa-edit mr-1"></i> Edit
          </button>
        </td>
      </tr>`;
    })
    .join("");
}

// ── Group modals helpers ──
// `rerender` re-invokes the caller's own refresh closure so the pager can page
// without this generic renderer needing to know how the groups were built.
function _renderGroupList(containerId, groups, iconClass, colorClass, opts = {}) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const { pagerMount, pagerKey, rerender } = opts;

  if (!groups.length) {
    if (pagerMount) renderPagerBar(pagerMount, paginateList(pagerKey, groups), rerender || (() => {}));
    el.innerHTML = `<p class="text-sm text-gray-400 text-center py-6">Tidak ada data.</p>`;
    return;
  }

  // The lokasi list runs to 205+ rows; without paging the modal becomes an
  // unscannable wall. Groups arrive already sorted by the caller.
  let rows = groups;
  if (pagerMount) {
    const page = paginateList(pagerKey, groups);
    renderPagerBar(pagerMount, page, rerender || (() => {}));
    rows = page.items;
  }

  el.innerHTML = rows
    .map((g) => {
      // For lokasi groups: show parent lokasi name as secondary label
      const parentName = g.parentCode
        ? lokasiData.find((l) => l.code === g.parentCode)?.name || g.parentCode
        : null;
      const subtitle = parentName && parentName !== g.name
          ? `<p class="text-[10px] text-gray-400 font-mono">${g.code}</p><p class="text-[10px] text-teal-500">${parentName}</p>`
          : `<p class="text-[10px] text-gray-400 font-mono">${g.code}</p>`;
      return `
      <div class="flex items-center justify-between bg-gray-50 dark:bg-gray-700/50 rounded-lg px-4 py-3 border border-gray-100 dark:border-gray-600">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg ${colorClass} flex items-center justify-center shrink-0">
            <i class="${iconClass} text-xs"></i>
          </div>
          <div>
            <p class="text-sm font-semibold text-gray-700 dark:text-gray-200">${g.name}</p>
            ${subtitle}
          </div>
        </div>
        <div class="text-right shrink-0">
          <p class="text-lg font-bold text-gray-800 dark:text-white">${g.count}</p>
          <p class="text-[10px] text-gray-400">aset</p>
        </div>
      </div>`;
    })
    .join("");
}

function _buildAlatGroups(filterCode, sortVal) {
  const map = {};
  db.forEach((a) => {
    const code = a.kode_alat || "—";
    const name = a.kode_alat_name || code;
    if (!map[code]) map[code] = { code, name, count: 0 };
    map[code].count++;
  });
  let arr = Object.values(map);
  if (filterCode) arr = arr.filter((g) => g.code === filterCode);
  if (sortVal === "count-desc") arr.sort((a, b) => b.count - a.count);
  else if (sortVal === "count-asc") arr.sort((a, b) => a.count - b.count);
  else if (sortVal === "name-asc") arr.sort((a, b) => a.name.localeCompare(b.name));
  else if (sortVal === "name-desc") arr.sort((a, b) => b.name.localeCompare(a.name));
  return arr;
}

function _buildLokasiGroups(filterLokasi, filterUpt, sortVal) {
  const map = {};
  db.forEach((a) => {
    const uptCode = a.id_lokasi_raw || a.id_lokasi || "—";
    const uptName = a.id_lokasi_display || uptCode;
    const uptEntry = uptDatabase.find((u) => u.upt === uptCode);
    const parentCode = uptEntry ? uptEntry.lokasi : uptCode;

    // Apply lokasi filter
    if (filterLokasi && parentCode !== filterLokasi) return;
    // Apply UPT filter
    if (filterUpt && uptCode !== filterUpt) return;

    if (!map[uptCode]) map[uptCode] = { code: uptCode, name: uptName, parentCode, count: 0 };
    map[uptCode].count++;
  });
  let arr = Object.values(map);
  if (sortVal === "count-desc") arr.sort((a, b) => b.count - a.count);
  else if (sortVal === "count-asc") arr.sort((a, b) => a.count - b.count);
  else if (sortVal === "name-asc") arr.sort((a, b) => a.name.localeCompare(b.name));
  else if (sortVal === "name-desc") arr.sort((a, b) => b.name.localeCompare(a.name));
  return arr;
}

// ── Terbaru modal helpers ──
function _renderTerbaruList(from, to) {
  const list = document.getElementById("kdak-terbaru-list");
  const label = document.getElementById("kdak-terbaru-count-label");
  if (!list) return;

  const filtered = db.filter((a) => {
    if (!a.tanggal_pembelian) return false;
    const d = new Date(a.tanggal_pembelian);
    if (from && d < new Date(from)) return false;
    if (to && d > new Date(to + "T23:59:59")) return false;
    return true;
  });

  filtered.sort((a, b) => new Date(b.tanggal_pembelian) - new Date(a.tanggal_pembelian));

  if (label) label.textContent = `${filtered.length} aset ditemukan dalam rentang ini.`;

  if (!filtered.length) {
    list.innerHTML = `<p class="text-sm text-gray-400 text-center py-6">Tidak ada aset dalam rentang tanggal ini.</p>`;
    return;
  }
  list.innerHTML = filtered
    .map(
      (a) => `
      <div class="flex items-center justify-between bg-gray-50 dark:bg-gray-700/50 rounded-lg px-4 py-3 border border-gray-100 dark:border-gray-600">
        <div>
          <p class="text-xs font-mono font-bold text-kai-blue dark:text-blue-400">${a.id_aset || "—"}</p>
          <p class="text-sm font-semibold text-gray-700 dark:text-gray-200 mt-0.5">${a.kode_alat_name || a.kode_alat || "—"}</p>
          <p class="text-[10px] text-gray-400">${a.id_lokasi_display || a.id_lokasi || "—"}</p>
        </div>
        <div class="text-right shrink-0">
          <p class="text-xs font-semibold text-gray-600 dark:text-gray-300">${a.tanggal_pembelian || "—"}</p>
          <span class="inline-flex mt-1 items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${a.status_terakhir === "SO" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"}">${a.status_terakhir}</span>
        </div>
      </div>`
    )
    .join("");
}

function _setTerbaruPreset(preset) {
  const now = new Date();
  let from, to;
  to = now.toISOString().split("T")[0];

  if (preset === "week") {
    const d = new Date(now);
    d.setDate(d.getDate() - d.getDay());
    from = d.toISOString().split("T")[0];
  } else if (preset === "month") {
    from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  } else if (preset === "year") {
    from = `${now.getFullYear()}-01-01`;
  }

  const fromEl = document.getElementById("kdak-terbaru-from");
  const toEl = document.getElementById("kdak-terbaru-to");
  if (fromEl) fromEl.value = from;
  if (toEl) toEl.value = to;

  document.querySelectorAll(".kdak-terbaru-preset").forEach((b) => {
    b.classList.toggle("border-kai-orange", b.dataset.preset === preset);
    b.classList.toggle("text-kai-orange", b.dataset.preset === preset);
  });

  _renderTerbaruList(from, to);
}

// ── Sample Excel download ──
function downloadKdakSampleExcel() {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Template data
  const headers = [
    "Kode Alat",
    "ID Lokasi",
    "Tanggal Pembelian (YYYY-MM-DD)",
    "Sumber Pengadaan (PUSAT/DAOP/DIVRE)",
    "Parent Lokasi",
    "Unit (A/B/C/D)",
  ];
  const sampleRows = [
    ["RGM", "JR1.1", "2026-12-31", "PUSAT", "D1", "A"],
    ["BOR", "JR2.1", "2026-12-31", "DAOP / DIVRE", "D2", "B"],
  ];
  const wsData = [headers, ...sampleRows];
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Style header row width hints
  ws["!cols"] = [{ wch: 14 }, { wch: 14 }, { wch: 30 }, { wch: 32 }, { wch: 14 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, ws, "Data Aset");

  // Sheet 2: Instructions
  const instrData = [
    ["", "", "", "", "Petunjuk Pengisian"],
    ["Pastikan menggunakan format data yang benar."],
    ["Kolom dengan tanda * wajib diisi."],
    [""],
    ["Nama Kolom", "Tipe Data", "Panjang", "Wajib", "Keterangan"],
    ["Kode Alat *", "Alpanumerik", "10 karakter", "YA", "Kode kategori alat kerja (misal: RGM, CWL)"],
    ["ID Lokasi *", "Alpanumerik", "10 karakter", "YA", "Kode UPT tujuan (misal: JR1.1, JB2.1)"],
    ["Tanggal Pembelian *", "Tanggal", "YYYY-MM-DD", "YA", "Format: 2024-03-15"],
    ["Sumber Pengadaan *", "Teks", "—", "YA", "Hanya: PUSAT atau DAOP/DIVRE"],
    ["Parent Lokasi *", "Alpanumerik", "10 karakter", "YA", "Kode Wilayah/DAOP induk (misal: D1, D2)"],
    ["Unit *", "Karakter", "1 karakter", "YA", "A=Jalan Rel, B=Jembatan, C=Mekanik, D=Balaiyasa"],
  ];
  const wsInstr = XLSX.utils.aoa_to_sheet(instrData);
  wsInstr["!cols"] = [{ wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 8 }, { wch: 50 }];
  XLSX.utils.book_append_sheet(wb, wsInstr, "Petunjuk");

  XLSX.writeFile(wb, "Template_Import_Aset_SIMAKAI.xlsx");
}

// ── Import Excel handler ──
async function processKdakImportFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: "binary" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

        // Skip header row
        const dataRows = rows.slice(1).filter((r) => r.length >= 6 && r[0]);

        if (!dataRows.length) {
          showToast("File tidak memiliki baris data yang valid.", "warning");
          return resolve(0);
        }

        let success = 0;
        let failed = 0;

        for (const row of dataRows) {
          const payload = {
            kode_alat: String(row[0] || "").trim(),
            id_lokasi: String(row[1] || "").trim(),
            tanggal_pembelian: String(row[2] || "").trim(),
            sumber_pengadaan: String(row[3] || "").trim(),
            parent_lokasi: String(row[4] || "").trim(),
            unit: String(row[5] || "").trim(),
          };

          try {
            const res = await apiFetch("/aset", {
              method: "POST",
              body: JSON.stringify(payload),
            });
            if (res.ok) success++;
            else failed++;
          } catch {
            failed++;
          }
        }

        showToast(
          `Import selesai: ${success} berhasil${failed ? `, ${failed} gagal` : ""}.`,
          success > 0 ? "success" : "error"
        );
        fetchAsetFromServer();
        resolve(success);
      } catch (err) {
        showToast("Gagal membaca file Excel.", "error");
        reject(err);
      }
    };
    reader.readAsBinaryString(file);
  });
}

// NOTE: processMasterLokasiImport / processMasterUptImport are defined inside
// setupEventListeners(), which is where both call sites live. Duplicate
// top-level copies used to sit here, shadowed and never reachable.

// ── Map View ──
function openKdakMapModal() {
  const modal = document.getElementById("kdak-map-modal");
  const iframe = document.getElementById("kdak-map-iframe");
  const loading = document.getElementById("kdak-map-loading");
  if (!modal || !iframe) return;

  // Use geolocation if available, else fall back to Indonesia center
  modal.classList.remove("hidden");

  const loadMap = (lat, lng) => {
    const src = `https://maps.google.com/maps?q=${lat},${lng}&z=13&output=embed`;
    iframe.src = src;
    iframe.onload = () => {
      if (loading) loading.classList.add("hidden");
    };
  };

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => loadMap(pos.coords.latitude, pos.coords.longitude),
      () => loadMap(-2.5489, 118.0149) // Indonesia center fallback
    );
  } else {
    loadMap(-2.5489, 118.0149);
  }
}

// ── KDAK: Two-step confirmation modal helper ──
let _kdakPendingAction = null;

function _showKdakConfirm(title, message, onConfirm) {
  _kdakPendingAction = onConfirm;
  const el = document.getElementById("kdak-confirm-modal");
  if (!el) { onConfirm(); return; } // fallback if modal missing
  document.getElementById("kdak-confirm-title").textContent = title;
  document.getElementById("kdak-confirm-message").textContent = message;
  el.classList.remove("hidden");
}

document.getElementById("kdak-confirm-cancel")?.addEventListener("click", () => {
  _kdakPendingAction = null;
  document.getElementById("kdak-confirm-modal")?.classList.add("hidden");
});

document.getElementById("kdak-confirm-ok")?.addEventListener("click", async () => {
  document.getElementById("kdak-confirm-modal")?.classList.add("hidden");
  if (_kdakPendingAction) { await _kdakPendingAction(); _kdakPendingAction = null; }
});

// ── KDAK Edit ──
window.openKdakEdit = function(idAset) {
  const a = db.find((x) => x.id_aset === idAset);
  if (!a) { showToast("Data aset tidak ditemukan.", "error"); return; }

  document.getElementById("kdak-edit-id").value = idAset;
  const subtitle = document.getElementById("kdak-edit-subtitle");
  if (subtitle) subtitle.textContent = idAset;

  // Populate alat select
  const alatSel = document.getElementById("kdak-edit-alat");
  if (alatSel) {
    if (alatSel.options.length <= 1)
      alatSel.innerHTML = `<option value="">— Pilih Alat Kerja —</option>` +
        alatKerjaData.map((ak) => `<option value="${ak.code}">${ak.code} — ${ak.name}</option>`).join("");
    alatSel.value = a.kode_alat || "";
  }

  // Sumber Pengadaan
  const pengVal = a.sumber_pengadaan || "";
  document.querySelectorAll('input[name="kdak-edit-pengadaan"]').forEach((r) => { r.checked = r.value === pengVal; });

  // Tanggal
  const tglEl = document.getElementById("kdak-edit-tanggal");
  if (tglEl) tglEl.value = a.tanggal_pembelian || "";

  // Peruntukan
  const peruntukanRevMap = { "JALAN REL": "A", "JEMBATAN": "B", "MEKANIK": "C", "BALAIYASA": "D" };
  const unitVal = peruntukanRevMap[a.peruntukan] || "";
  document.querySelectorAll('input[name="kdak-edit-unit"]').forEach((r) => { r.checked = r.value === unitVal; });

  // Lokasi & UPT
  const uptCode = a.id_lokasi_raw || a.id_lokasi || "";
  const parentCode = getParentLokasiCode(uptCode) || uptCode;
  const lokasiSel = document.getElementById("kdak-edit-lokasi");
  if (lokasiSel) {
    lokasiSel.innerHTML = `<option value="">— Pilih Lokasi/Wilayah —</option>` +
      lokasiData.map((l) => `<option value="${l.code}"${l.code === parentCode ? " selected" : ""}>${l.name} (${l.code})</option>`).join("");
  }
  const uptSel = document.getElementById("kdak-edit-upt");
  if (uptSel) { applyUptSelect(parentCode, uptSel); uptSel.value = uptCode; }

  document.getElementById("kdak-edit-modal")?.classList.remove("hidden");
};

document.getElementById("kdak-edit-lokasi")?.addEventListener("change", (e) => {
  const uptSel = document.getElementById("kdak-edit-upt");
  applyUptSelect(e.target.value, uptSel);
  if (uptSel) uptSel.value = ""; // clear stale UPT when lokasi changes
});

document.getElementById("form-kdak-edit")?.addEventListener("submit", async function(e) {
  e.preventDefault();
  const idAset    = document.getElementById("kdak-edit-id").value;
  const alat      = document.getElementById("kdak-edit-alat").value;
  const pengadaan = document.querySelector('input[name="kdak-edit-pengadaan"]:checked')?.value || "";
  const tanggal   = document.getElementById("kdak-edit-tanggal").value;
  const unitRaw   = document.querySelector('input[name="kdak-edit-unit"]:checked')?.value || "";
  const peruntukanMap = { A: "JALAN REL", B: "JEMBATAN", C: "MEKANIK", D: "BALAIYASA" };
  const peruntukan = peruntukanMap[unitRaw] || "";
  const lokasi    = document.getElementById("kdak-edit-lokasi").value;
  const uptVal    = document.getElementById("kdak-edit-upt")?.value || "";

  if (!lokasi) { showToast("Pilih Lokasi/Wilayah terlebih dahulu.", "warning"); return; }

  const step1 = await customConfirm(
    `Simpan perubahan pada aset "${idAset}"?\n\nID aset mungkin berubah jika terdapat perubahan pada data utama (lokasi, alat, atau tahun).`
  );
  if (!step1) return;

  const step2 = await customConfirm(
    `Konfirmasi akhir: Data aset "${idAset}" akan diperbarui ke database.\n\nPastikan semua perubahan sudah benar sebelum melanjutkan.`
  );
  if (!step2) return;

  const payload = { kode_alat: alat, id_lokasi: uptVal || lokasi, parent_lokasi: lokasi, tanggal_pembelian: tanggal, sumber_pengadaan: pengadaan, peruntukan };
  try {
    const res = await apiFetch(`/aset/${idAset}`, { method: "PUT", body: JSON.stringify(payload) });
    if (!res.ok) { const err = await res.json(); throw new Error(err.detail || "Gagal memperbarui data."); }
    const result = await res.json();
    showToast(`Berhasil diperbarui! ID Aset: ${result.id_aset}`, "success");
    document.getElementById("kdak-edit-modal")?.classList.add("hidden");
    fetchAsetFromServer();
  } catch (err) { if (err.message !== "Unauthorized") showToast(err.message, "error"); }
});

document.getElementById("kdak-edit-nonaktifkan")?.addEventListener("click", async () => {
  const idAset = document.getElementById("kdak-edit-id").value;
  if (!idAset) return;

  const step1 = await customConfirm(
    `Hapus permanen aset "${idAset}"?\n\nAset beserta seluruh riwayatnya akan dihapus dari sistem. Tindakan ini tidak dapat dibatalkan.`
  );
  if (!step1) return;

  const step2 = await customConfirm(
    `Konfirmasi akhir: Aset "${idAset}" akan DIHAPUS PERMANEN.\n\nData tidak dapat dipulihkan kembali setelah tindakan ini.`
  );
  if (!step2) return;

  try {
    const res = await apiFetch(`/aset/${idAset}`, { method: "DELETE" });
    if (!res.ok) { const err = await res.json(); throw new Error(err.detail || "Gagal menghapus aset."); }
    showToast(`Aset ${idAset} berhasil dihapus.`, "success");
    document.getElementById("kdak-edit-modal")?.classList.add("hidden");
    fetchAsetFromServer();
  } catch (err) { if (err.message !== "Unauthorized") showToast(err.message, "error"); }
});

document.getElementById("close-kdak-edit-modal")?.addEventListener("click", () => {
  document.getElementById("kdak-edit-modal")?.classList.add("hidden");
});
document.getElementById("kdak-edit-cancel")?.addEventListener("click", () => {
  document.getElementById("kdak-edit-modal")?.classList.add("hidden");
});

// ── Event listeners ──
function setupKdakListeners() {
  // Toolbar buttons
  document.getElementById("kdak-btn-tambah")?.addEventListener("click", () => {
    document.getElementById("kdak-tambah-modal")?.classList.remove("hidden");
  });

  document.getElementById("close-kdak-tambah-modal")?.addEventListener("click", () => {
      document.getElementById("kdak-tambah-modal")?.classList.add("hidden");
    });
  document.getElementById("kdak-tambah-cancel")?.addEventListener("click", () => {
      document.getElementById("kdak-tambah-modal")?.classList.add("hidden");
    });

  // Bulk dropdown toggle
  document.getElementById("kdak-btn-bulk-toggle")?.addEventListener("click", (e) => {
      e.stopPropagation();
      document.getElementById("kdak-bulk-dropdown")?.classList.toggle("hidden");
    });
  document.addEventListener("click", () => {
    document.getElementById("kdak-bulk-dropdown")?.classList.add("hidden");
  });

  // Bulk dropdown items → open modal
  document.getElementById("kdak-btn-sample-excel")?.addEventListener("click", () => {
      document.getElementById("kdak-bulk-dropdown")?.classList.add("hidden");
      const sel = document.getElementById("kdak-bulk-action");
      if (sel) sel.value = "sample";
      document.getElementById("kdak-bulk-file-area")?.classList.add("hidden");
      document.getElementById("kdak-bulk-modal")?.classList.remove("hidden");
    });
  document.getElementById("kdak-btn-import-excel")?.addEventListener("click", () => {
      document.getElementById("kdak-bulk-dropdown")?.classList.add("hidden");
      const sel = document.getElementById("kdak-bulk-action");
      if (sel) sel.value = "import";
    document.getElementById("kdak-bulk-file-area")?.classList.remove("hidden");
      document.getElementById("kdak-bulk-modal")?.classList.remove("hidden");
    });

  // Bulk modal
  document.getElementById("kdak-bulk-action")?.addEventListener("change", (e) => {
      const fileArea = document.getElementById("kdak-bulk-file-area");
    if (fileArea) fileArea.classList.toggle("hidden", e.target.value !== "import");
    });
  document.getElementById("kdak-bulk-file-input")?.addEventListener("change", (e) => {
      const name = e.target.files[0]?.name || "Belum ada file dipilih";
      const el = document.getElementById("kdak-bulk-filename");
      if (el) el.textContent = name;
    });
  document.getElementById("close-kdak-bulk-modal")?.addEventListener("click", () => {
      document.getElementById("kdak-bulk-modal")?.classList.add("hidden");
    });
  document.getElementById("kdak-bulk-cancel")?.addEventListener("click", () => {
    document.getElementById("kdak-bulk-modal")?.classList.add("hidden");
  });
  document.getElementById("kdak-bulk-confirm")?.addEventListener("click", async () => {
      const action = document.getElementById("kdak-bulk-action")?.value;
    if (!action) { showToast("Pilih tindakan terlebih dahulu.", "warning"); return; }
      if (action === "sample") {
        downloadKdakSampleExcel();
        document.getElementById("kdak-bulk-modal")?.classList.add("hidden");
      } else if (action === "import") {
        const file = document.getElementById("kdak-bulk-file-input")?.files[0];
      if (!file) { showToast("Pilih file Excel terlebih dahulu.", "warning"); return; }
        document.getElementById("kdak-bulk-modal")?.classList.add("hidden");
        await processKdakImportFile(file);
      }
    });

  // Search table
  document.getElementById("kdak-search")?.addEventListener("input", (e) => {
    _kdakSearch = e.target.value;
    // A new search resizes the result set, so the old page number is meaningless.
    resetPage("kdak");
    renderKdakTable();
  });

  // Sort button — open modal, populate dropdowns
  document.getElementById("kdak-btn-sort")?.addEventListener("click", () => {
    _populateYearDropdowns("kdak-sort-id-tahun-from", "kdak-sort-id-tahun-to");
    _populateYearDropdowns("kdak-sort-tgl-from", "kdak-sort-tgl-to");

    // Sync panels and Terbaru/Terlama visibility for current field
    const curField = document.getElementById("kdak-sort-field")?.value || "id_aset";
    const curChecked = document.getElementById("kdak-sort-custom-spec")?.checked || false;
    _syncSortPanels(curField, curChecked, "kdak-sort", "kdak-sort-all-data-label", "kdak-sort-custom-panels");

    // Paint active direction button
    document.querySelectorAll(".kdak-sort-dir-btn").forEach((b) => {
      const active = b.dataset.kdakDir === _kdakSortDir;
      b.classList.toggle("border-purple-500", active);
      b.classList.toggle("bg-purple-100", active);
      b.classList.toggle("dark:bg-purple-900/20", active);
      b.classList.toggle("text-purple-600", active);
      b.classList.toggle("dark:text-purple-300", active);
      b.classList.toggle("border-gray-200", !active);
      b.classList.toggle("dark:border-gray-600", !active);
      b.classList.toggle("bg-white", !active);
      b.classList.toggle("dark:bg-gray-700", !active);
      b.classList.toggle("text-gray-500", !active);
    });

    // Populate alat dropdowns
    ["kdak-sort-id-alat", "kdak-sort-alat-filter"].forEach((id) => {
      const sel = document.getElementById(id);
      if (sel && sel.options.length <= 1) {
        alatKerjaData.forEach((a) => {
          const o = document.createElement("option");
          o.value = a.code;
          o.textContent = `${a.code} — ${a.name}`;
          sel.appendChild(o);
        });
      }
    });
    // Populate lokasi dropdowns
    ["kdak-sort-id-lokasi", "kdak-sort-lok-lokasi"].forEach((id) => {
      const sel = document.getElementById(id);
      if (sel && sel.options.length <= 1) {
        lokasiData.forEach((l) => {
          const o = document.createElement("option");
          o.value = l.code;
          o.textContent = `${l.name} (${l.code})`;
          sel.appendChild(o);
        });
      }
    });
    // UPT is cascade-driven by Lokasi — reset on modal open
    const uptSel = document.getElementById("kdak-sort-lok-upt");
    if (uptSel) uptSel.innerHTML = `<option value="">— Pilih Lokasi dahulu —</option>`;
    _filterUptByLokasi("kdak-sort-lok-lokasi", "kdak-sort-lok-upt");
    // Wire cascade if not yet done
    // Repopulate UPT based on current Lokasi selection (preserves choice on reopen)
    const kdakLokSel = document.getElementById("kdak-sort-lok-lokasi");
    const kdakUptSel = document.getElementById("kdak-sort-lok-upt");
    if (kdakUptSel) {
      const currentLok = kdakLokSel ? kdakLokSel.value : "";
      const currentUpt = kdakUptSel.value;
      kdakUptSel.innerHTML = `<option value="">— ${currentLok ? "Semua UPT" : "Pilih Lokasi dahulu"} —</option>`;
      const uptList = currentLok ? uptDatabase.filter((u) => u.lokasi === currentLok) : uptDatabase;
      uptList.forEach((u) => {
        const o = document.createElement("option");
        o.value = u.upt;
        o.textContent = `${u.nama || u.upt} (${u.upt})`;
        kdakUptSel.appendChild(o);
      });
      if (currentUpt) kdakUptSel.value = currentUpt;
    }
    // Wire cascade (only once)
    if (kdakLokSel && !kdakLokSel.dataset.cascadeWired) {
      kdakLokSel.dataset.cascadeWired = "1";
      kdakLokSel.addEventListener("change", () => {
        _filterUptByLokasi("kdak-sort-lok-lokasi", "kdak-sort-lok-upt");
      });
    }
    document.getElementById("kdak-sort-modal")?.classList.remove("hidden");
  });

  document.getElementById("close-kdak-sort-modal")?.addEventListener("click", () => {
      document.getElementById("kdak-sort-modal")?.classList.add("hidden");
    });

  // Field change → sync panels
  document.getElementById("kdak-sort-field")?.addEventListener("change", (e) => {
      const checked = document.getElementById("kdak-sort-custom-spec")?.checked;
    _syncSortPanels(e.target.value, checked, "kdak-sort", "kdak-sort-all-data-label", "kdak-sort-custom-panels");
    });

  document.getElementById("kdak-sort-custom-spec")?.addEventListener("change", (e) => {
      const field = document.getElementById("kdak-sort-field")?.value;
    _syncSortPanels(field, e.target.checked, "kdak-sort", "kdak-sort-all-data-label", "kdak-sort-custom-panels");
    });

  // Sort direction buttons — purple theme
  document.querySelectorAll(".kdak-sort-dir-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      _kdakSortDir = btn.dataset.kdakDir;
      document.querySelectorAll(".kdak-sort-dir-btn").forEach((b) => {
        const active = b.dataset.kdakDir === _kdakSortDir;
        b.classList.toggle("border-purple-500", active);
        b.classList.toggle("bg-purple-100", active);
        b.classList.toggle("dark:bg-purple-900/20", active);
        b.classList.toggle("text-purple-600", active);
        b.classList.toggle("dark:text-purple-300", active);
        b.classList.toggle("border-gray-200", !active);
        b.classList.toggle("dark:border-gray-600", !active);
        b.classList.toggle("bg-white", !active);
        b.classList.toggle("dark:bg-gray-700", !active);
        b.classList.toggle("text-gray-500", !active);
      });
    });
  });

  // Apply sort
  document.getElementById("kdak-btn-apply-sort")?.addEventListener("click", () => {
      const fieldVal = document.getElementById("kdak-sort-field")?.value;
      _kdakSortField = sortFieldOf(fieldVal);
    const customChecked = document.getElementById("kdak-sort-custom-spec")?.checked;

      _kdakSortFilters = {};
      if (customChecked && fieldVal) {
        if (fieldVal === "id_aset") {
        // Same six phantom reads as #sort-modal lived here; the panel only ever
        // had the from/to number inputs.
        _kdakSortFilters.idFrom = parseInt(document.getElementById("kdak-sort-id-from")?.value) || null;
        _kdakSortFilters.idTo = parseInt(document.getElementById("kdak-sort-id-to")?.value) || null;
        } else if (fieldVal === "kode_alat_name") {
        _kdakSortFilters.alat = document.getElementById("kdak-sort-alat-filter")?.value || "";
        } else if (fieldVal === "sumber_pengadaan") {
        _kdakSortFilters.pengadaan = document.querySelector('input[name="kdak-sort-pengadaan-filter"]:checked')?.value || "";
        } else if (fieldVal === "tanggal_pembelian") {
        _kdakSortFilters.tahunFrom = document.getElementById("kdak-sort-tgl-from")?.value || "";
        _kdakSortFilters.tahunTo = document.getElementById("kdak-sort-tgl-to")?.value || "";
        } else if (fieldVal === "unit_peruntukan") {
        _kdakSortFilters.peruntukan = document.querySelector('input[name="kdak-sort-peruntukan-filter"]:checked')?.value || "";
        } else if (fieldVal === "id_lokasi") {
        _kdakSortFilters.lokasi = document.getElementById("kdak-sort-lok-lokasi")?.value || "";
        _kdakSortFilters.upt = document.getElementById("kdak-sort-lok-upt")?.value || "";
        }
      }

      document.getElementById("kdak-sort-modal")?.classList.add("hidden");
      resetPage("kdak");
      renderKdakTable();
    });

// KDAK sort reset
document.getElementById("kdak-btn-reset-sort")?.addEventListener("click", () => {
  _kdakSortField = "id_aset";
  _kdakSortDir = "date-desc";
  _kdakSortFilters = {};

  const kdakField = document.getElementById("kdak-sort-field");
  if (kdakField) kdakField.value = "";
  const kdakSpec = document.getElementById("kdak-sort-custom-spec");
  if (kdakSpec) kdakSpec.checked = false;

  // Clear all sub-filter inputs
  document.querySelectorAll("#kdak-sort-custom-panels input[type='text'], #kdak-sort-custom-panels input[type='number'], #kdak-sort-custom-panels select").forEach(el => { el.value = ""; });
  document.querySelectorAll("#kdak-sort-custom-panels input[type='radio']").forEach(el => { el.checked = false; });

  _syncSortPanels("", false, "kdak-sort", "kdak-sort-all-data-label", "kdak-sort-custom-panels");
  document.querySelectorAll(".kdak-sort-dir-btn").forEach((b) => {
    b.classList.remove("border-purple-500", "bg-purple-100", "dark:bg-purple-900/20", "text-purple-600", "dark:text-purple-300");
    b.classList.add("border-gray-200", "dark:border-gray-600", "bg-white", "dark:bg-gray-700", "text-gray-500");
  });
  // Reset CLEARS the form and leaves the modal open, matching the other three
  // modals — this one used to close itself, so "reset" read as "cancel" and the
  // user could not see that anything had been cleared.
  showToast("Nilai sort pada menu ini telah direset.", "info");
  resetPage("kdak");
  renderKdakTable();
});

// ── Helper functions ──
const _refreshAlatList = () => {
  const alatFilter = document.getElementById("kdak-alat-filter");
  const alatSort = document.getElementById("kdak-alat-sort");
  _renderGroupList(
    "kdak-alat-list",
    _buildAlatGroups(alatFilter?.value || "", alatSort?.value || "count-desc"),
    "fas fa-wrench",
    "bg-kai-blue/10 dark:bg-blue-900/30 text-kai-blue",
    { pagerMount: "kdak-alat-pager", pagerKey: "group-alat", rerender: () => _refreshAlatList() }
  );
};

const _refreshLokasiList = () => {
  const lokasiFilter = document.getElementById("kdak-lokasi-filter");
  const uptFilter = document.getElementById("kdak-upt-filter");
  const lokasiSort = document.getElementById("kdak-lokasi-sort");
  _renderGroupList(
    "kdak-lokasi-list",
    _buildLokasiGroups(
      lokasiFilter?.value || "",
      uptFilter?.value || "",
      lokasiSort?.value || "count-desc"
    ),
    "fas fa-map-pin",
    "bg-teal-500/10 dark:bg-teal-900/30 text-teal-500",
    { pagerMount: "kdak-lokasi-pager", pagerKey: "group-lokasi", rerender: () => _refreshLokasiList() }
  );
};

const _refreshTerbaru = () => {
  const from = document.getElementById("kdak-terbaru-from")?.value;
  const to = document.getElementById("kdak-terbaru-to")?.value;
  document.querySelectorAll(".kdak-terbaru-preset").forEach((b) => {
    b.classList.remove("border-kai-orange", "text-kai-orange");
  });
  _renderTerbaruList(from, to);
};

// ── Daftar per Alat Kerja card ──
document.getElementById("kdak-card-per-alat")?.addEventListener("click", () => {
    const modal = document.getElementById("kdak-alat-modal");
    if (modal) modal.classList.remove("hidden");

    const alatFilter = document.getElementById("kdak-alat-filter");
    if (alatFilter) {
      const existing = new Set(db.map((a) => a.kode_alat));
      alatFilter.innerHTML =
        '<option value="">— Semua Alat Kerja —</option>' +
        alatKerjaData
          .filter((a) => existing.has(a.code))
          .map((a) => `<option value="${a.code}">${a.name}</option>`)
          .join("");
      alatFilter.value = "";
    }
    _refreshAlatList();
  });

document.getElementById("close-kdak-alat-modal")?.addEventListener("click", () => {
    document.getElementById("kdak-alat-modal")?.classList.add("hidden");
  });

document.getElementById("kdak-alat-filter")?.addEventListener("change", _refreshAlatList);
document.getElementById("kdak-alat-sort")?.addEventListener("change", _refreshAlatList);

// ── Daftar per Lokasi card (SINGLE event listener - removed duplicate) ──
document.getElementById("kdak-card-per-lokasi")?.addEventListener("click", () => {
    const modal = document.getElementById("kdak-lokasi-modal");
    if (modal) modal.classList.remove("hidden");

    const lokasiFilter = document.getElementById("kdak-lokasi-filter");
    if (lokasiFilter) {
      const usedParents = new Set(
        db.map((a) => {
        const uptEntry = uptDatabase.find((u) => u.upt === (a.id_lokasi_raw || a.id_lokasi));
        return uptEntry ? uptEntry.lokasi : (a.id_lokasi_raw || a.id_lokasi);
      })
      );
      lokasiFilter.innerHTML =
        '<option value="">— Semua Lokasi —</option>' +
        lokasiData
          .filter((l) => usedParents.has(l.code))
          .map((l) => `<option value="${l.code}">${l.name}</option>`)
          .join("");
      lokasiFilter.value = "";
    }

    const uptFilter = document.getElementById("kdak-upt-filter");
    if (uptFilter) {
    uptFilter.innerHTML = '<option value="">— Semua UPT untuk Lokasi ini —</option>';
      uptFilter.disabled = true;
    }
    _refreshLokasiList();
  });

document.getElementById("close-kdak-lokasi-modal")?.addEventListener("click", () => {
    document.getElementById("kdak-lokasi-modal")?.classList.add("hidden");
  });

// Lokasi filter events
document.getElementById("kdak-lokasi-filter")?.addEventListener("change", (e) => {
    const selLokasi = e.target.value;
    const uptFilter = document.getElementById("kdak-upt-filter");
    if (uptFilter) {
      if (!selLokasi) {
      uptFilter.innerHTML = '<option value="">— Semua UPT untuk Lokasi ini —</option>';
        uptFilter.disabled = true;
      } else {
        const matches = uptDatabase.filter((u) => u.lokasi === selLokasi);
        uptFilter.disabled = false;
        uptFilter.innerHTML =
          '<option value="">— Semua UPT untuk Lokasi ini —</option>' +
        matches.map((u) => `<option value="${u.upt}">${u.nama || u.upt}</option>`).join("");
        uptFilter.value = "";
      }
    }
    _refreshLokasiList();
  });

document.getElementById("kdak-upt-filter")?.addEventListener("change", _refreshLokasiList);
document.getElementById("kdak-lokasi-sort")?.addEventListener("change", _refreshLokasiList);

// ── Aset Terbaru card ──
document.getElementById("kdak-card-terbaru")?.addEventListener("click", () => {
    const modal = document.getElementById("kdak-terbaru-modal");
    if (modal) modal.classList.remove("hidden");
    _setTerbaruPreset("month");
  });

document.getElementById("close-kdak-terbaru-modal")?.addEventListener("click", () => {
    document.getElementById("kdak-terbaru-modal")?.classList.add("hidden");
  });

document.querySelectorAll(".kdak-terbaru-preset").forEach((btn) => {
  btn.addEventListener("click", () => _setTerbaruPreset(btn.dataset.preset));
});

document.getElementById("kdak-terbaru-from")?.addEventListener("change", _refreshTerbaru);
document.getElementById("kdak-terbaru-to")?.addEventListener("change", _refreshTerbaru);

// ── Switch to KDAK view ──
document.querySelector('[data-view="input"]')?.addEventListener("click", () => {
    updateKdakStats();
    renderKdakTable();
  });

// ── Jenis Alat card ──
document.getElementById("kdak-card-jenis")?.addEventListener("click", () => {
  const modal = document.getElementById("kdak-jenis-modal");
  if (modal) modal.classList.remove("hidden");
  const tbody = document.getElementById("kdak-jenis-table-body");
  if (!tbody) return;
  const countByKode = {};
  db.forEach((a) => { countByKode[a.kode_alat] = (countByKode[a.kode_alat] || 0) + 1; });
  tbody.innerHTML = alatKerjaData.map((a) => `
    <tr class="border-b border-gray-50 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
      <td class="px-4 py-3 font-mono text-xs text-purple-500 font-bold">${a.code}</td>
      <td class="px-4 py-3 text-sm text-gray-700 dark:text-gray-200">${a.name}</td>
      <td class="px-4 py-3 text-center font-bold text-gray-700 dark:text-gray-300">${countByKode[a.code] ?? "—"}</td>
    </tr>`).join("");
});
document.getElementById("close-kdak-jenis-modal")?.addEventListener("click", () => {
    document.getElementById("kdak-jenis-modal")?.classList.add("hidden");
  });

// ── Sebaran Lokasi info card ──
document.getElementById("kdak-card-lokasi-info")?.addEventListener("click", () => {
    const modal = document.getElementById("kdak-lokasi-info-modal");
    if (modal) modal.classList.remove("hidden");
    // Lokasi table
  const bodyLokasi = document.getElementById("kdak-lokasi-info-body-lokasi");
    if (bodyLokasi) {
    bodyLokasi.innerHTML = lokasiData.map((l) => `
      <tr class="border-b border-gray-50 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
        <td class="px-4 py-3 font-mono text-xs text-teal-500 font-bold">${l.code}</td>
        <td class="px-4 py-3 text-sm text-gray-700 dark:text-gray-200">${l.name}</td>
        <td class="px-4 py-3 text-center text-xs text-gray-500 dark:text-gray-400">${l.tipe || "—"}</td>
      </tr>`).join("");
    }
    // UPT table
    const bodyUpt = document.getElementById("kdak-lokasi-info-body-upt");
    if (bodyUpt) {
      bodyUpt.innerHTML = uptDatabase.map((u) => {
        const parentName = lokasiData.find((l) => l.code === u.lokasi)?.name || u.lokasi;
            return `
        <tr class="border-b border-gray-50 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
          <td class="px-4 py-3 font-mono text-xs text-teal-500 font-bold">${u.upt}</td>
          <td class="px-4 py-3 text-sm text-gray-700 dark:text-gray-200">${u.nama || "—"}</td>
          <td class="px-4 py-3 font-mono text-xs text-gray-400">${u.lokasi}</td>
          <td class="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">${parentName}</td>
        </tr>`;
      }).join("");
    }
  });
document.getElementById("close-kdak-lokasi-info-modal")?.addEventListener("click", () => {
  document.getElementById("kdak-lokasi-info-modal")?.classList.add("hidden");
  });
// Lokasi info tabs
document.getElementById("kdak-lokasi-info-tab-lokasi")?.addEventListener("click", () => {
  document.getElementById("kdak-lokasi-info-panel-lokasi")?.classList.remove("hidden");
  document.getElementById("kdak-lokasi-info-panel-upt")?.classList.add("hidden");
  document.getElementById("kdak-lokasi-info-tab-lokasi").className = "kdak-lokasi-info-tab flex-1 py-3 text-xs font-bold tracking-widest UpperCase text-kai-blue border-b-2 border-kai-blue transition";
  document.getElementById("kdak-lokasi-info-tab-upt").className = "kdak-lokasi-info-tab flex-1 py-3 text-xs font-bold tracking-widest UpperCase text-gray-400 border-b-2 border-transparent hover:text-gray-600 transition";
  });
document.getElementById("kdak-lokasi-info-tab-upt")?.addEventListener("click", () => {
  document.getElementById("kdak-lokasi-info-panel-upt")?.classList.remove("hidden");
  document.getElementById("kdak-lokasi-info-panel-lokasi")?.classList.add("hidden");
  document.getElementById("kdak-lokasi-info-tab-upt").className = "kdak-lokasi-info-tab flex-1 py-3 text-xs font-bold tracking-widest UpperCase text-kai-blue border-b-2 border-kai-blue transition";
  document.getElementById("kdak-lokasi-info-tab-lokasi").className = "kdak-lokasi-info-tab flex-1 py-3 text-xs font-bold tracking-widest UpperCase text-gray-400 border-b-2 border-transparent hover:text-gray-600 transition";
  });

// ── Ketersediaan card ──
document.getElementById("kdak-card-ketersediaan")?.addEventListener("click", () => {
  document.getElementById("kdak-ketersediaan-modal")?.classList.remove("hidden");
    _renderKdakAvailBenchmarkTable("ketersediaan");
  });
document.getElementById("close-kdak-ketersediaan-modal")?.addEventListener("click", () => {
  document.getElementById("kdak-ketersediaan-modal")?.classList.add("hidden");
  });

// ── Benchmark card ──
document.getElementById("kdak-card-benchmark")?.addEventListener("click", () => {
  document.getElementById("kdak-benchmark-modal")?.classList.remove("hidden");
    _renderKdakAvailBenchmarkTable("benchmark");
  });
document.getElementById("close-kdak-benchmark-modal")?.addEventListener("click", () => {
    document.getElementById("kdak-benchmark-modal")?.classList.add("hidden");
  });
}

// ── Shared helper: renders Ketersediaan or Benchmark table from matrix data ──
function _renderKdakAvailBenchmarkTable(mode) {
  const tbodyId = mode === "ketersediaan" ? "kdak-ketersediaan-table-body" : "kdak-benchmark-table-body";
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;

  const assetsByParent = {};
  db.forEach((a) => {
    const uptCode = a.id_lokasi_raw || a.id_lokasi;
    if (!uptCode) return;
    const parentCode = (uptDatabase.find((u) => u.upt === uptCode)?.lokasi) || uptCode;
    if (!assetsByParent[parentCode]) assetsByParent[parentCode] = [];
    assetsByParent[parentCode].push(a);
  });

  tbody.innerHTML = lokasiData.map((region) => {
      const assets = assetsByParent[region.code] || [];
      const so = assets.filter((a) => a.status_terakhir === "SO").length;
      const total = assets.length;
      const avail = total > 0 ? Math.round((so / total) * 100) : null;
      const delta = avail !== null ? avail - _benchmarkPct : null;

      if (mode === "ketersediaan") {
        return `<tr class="border-b border-gray-50 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
        <td class="px-4 py-3 text-sm font-bold text-gray-700 dark:text-gray-300">${region.name}</td>
        <td class="px-4 py-3 text-center font-bold text-gray-700 dark:text-gray-300">${total || "—"}</td>
        <td class="px-4 py-3 text-center font-bold text-kai-blue dark:text-blue-400">${avail !== null ? `${avail}%` : "—"}</td>
      </tr>`;
      } else {
      const deltaStr = delta !== null
            ? `<span class="${delta >= 0 ? "text-green-500" : "text-red-500"}">${delta >= 0 ? "+" : ""}${delta}%</span>`
            : "—";
        return `<tr class="border-b border-gray-50 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
        <td class="px-4 py-3 text-sm font-bold text-gray-700 dark:text-gray-300">${region.name}</td>
        <td class="px-4 py-3 text-center font-bold text-gray-700 dark:text-gray-300">${total || "—"}</td>
        <td class="px-4 py-3 text-center font-bold">${deltaStr}</td>
      </tr>`;
      }
  }).join("");
}

// Init KDAK on DOMContentLoaded
document.addEventListener("DOMContentLoaded", () => {
  setupKdakListeners();
});

// ─────────────────────────────────────────────────────────────────────────────

// ── NOTIFICATIONS & CONFIRM DIALOG ────────────────────────────────────────

const MAX_TOASTS = 5;

function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;

  // Remove oldest toasts if over limit
  while (container.children.length >= MAX_TOASTS) {
    container.firstChild.remove();
  }

  const toast = document.createElement("div");

  let colorClass = "bg-blue-500";
  let iconClass = "fa-info-circle";

  if (type === "success") {
    colorClass = "bg-green-500";
    iconClass = "fa-check-circle";
  } else if (type === "error") {
    colorClass = "bg-red-500";
    iconClass = "fa-exclamation-circle";
  } else if (type === "warning") {
    colorClass = "bg-yellow-500";
    iconClass = "fa-exclamation-triangle";
  }

  toast.className = `${colorClass} text-white px-5 py-3 rounded-xl shadow-lg transform transition-all duration-300 opacity-0 translate-y-4 sm:translate-y-0 sm:translate-x-full flex items-center gap-3 font-semibold`;
  toast.innerHTML = `
        <i class="fas ${iconClass} text-xl shrink-0"></i>
        <span class="flex-1 text-sm">${message}</span>
        <button class="toast-dismiss shrink-0 ml-1 w-5 h-5 flex items-center justify-center rounded-full hover:bg-white/20 transition text-white/80 hover:text-white">
            <i class="fas fa-times text-base"></i>
        </button>`;

  const dismiss = () => {
    toast.classList.add("opacity-0", "translate-y-4", "sm:translate-x-full");
    setTimeout(() => toast.remove(), 300);
  };

  toast.querySelector(".toast-dismiss").addEventListener("click", dismiss);

  container.appendChild(toast);

  requestAnimationFrame(() => {
    setTimeout(
      () =>
        toast.classList.remove(
          "opacity-0",
          "translate-y-4",
          "sm:translate-x-full",
        ),
      10,
    );
  });

  const autoHide = setTimeout(dismiss, 4000);
  toast
    .querySelector(".toast-dismiss")
    .addEventListener("click", () => clearTimeout(autoHide));
}

function customConfirm(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirm-modal");
    if (!modal) return resolve(window.confirm(message));

    const cancelBtn = document.getElementById("confirm-cancel");
    const okBtn = document.getElementById("confirm-ok");

    document.getElementById("confirm-message").innerText = message;
    modal.classList.remove("hidden");

    function finish(result) {
      modal.classList.add("hidden");
      cancelBtn.onclick = null;
      okBtn.onclick = null;
      resolve(result);
    }

    cancelBtn.onclick = () => finish(false);
    okBtn.onclick = () => finish(true);
  });
}

// ── AFKIR / PULIHKAN ──────────────────────────────────────────────────────

let _afkirDb = [];

// ── Afkir Sort State ──────────────────────────────────────────────────────
// Defaults must match what the Reset button writes, or resetting silently
// changes the ordering instead of restoring it.
const AFKIR_SORT_DEFAULTS = { field: "tanggal_pembelian", dir: "date-desc" };
let _afkirSortField = AFKIR_SORT_DEFAULTS.field;
let _afkirSortDir   = AFKIR_SORT_DEFAULTS.dir;
let _afkirSortFilters = {};

async function loadAfkirCards() {
  const container = document.getElementById("afkir-cards-container");
  if (!container) return;
  container.innerHTML = `<div class="col-span-full text-center text-gray-400 py-14"><i class="fas fa-spinner fa-spin text-2xl"></i></div>`;
  try {
    const res = await apiFetch("/aset/afkir");
    if (!res.ok) throw new Error();
    _afkirDb = await res.json();
    renderAfkirCards();
  } catch {
    container.innerHTML = `<div class="col-span-full text-center text-red-400 py-14 text-sm">Gagal memuat data aset afkir.</div>`;
  }
}

// Called by the WebSocket handler and the polling fallback so afkir-ing an
// asset in another tab doesn't leave this list stale.
window.refreshAfkirIfVisible = function refreshAfkirIfVisible() {
  if (document.getElementById("view-afkir")?.classList.contains("is-visible"))
    loadAfkirCards();
};

function renderAfkirCards() {
  const container = document.getElementById("afkir-cards-container");
  const countEl   = document.getElementById("afkir-table-count");
  if (!container) return;
  const q = (document.getElementById("search-afkir")?.value || "").toUpperCase();
  const f = _afkirSortFilters;

  let filtered = _afkirDb.filter((item) => {
    const rawLokasi = item.id_lokasi_raw || item.id_lokasi || "";
    if (q) {
      const match =
        (item.id_aset || "").toUpperCase().includes(q) ||
        (item.kode_alat_name || item.kode_alat || "").toUpperCase().includes(q) ||
        (item.lokasi_name || rawLokasi).toUpperCase().includes(q);
      if (!match) return false;
    }
    if (f.alat && item.kode_alat !== f.alat) return false;
    if (f.lokasi) {
      const parent = getParentLokasiCode(rawLokasi) || rawLokasi;
      if (parent !== f.lokasi && rawLokasi !== f.lokasi) return false;
    }
    if (f.upt && rawLokasi !== f.upt) return false;
    if (!_pengadaanMatches(item.sumber_pengadaan, f.pengadaan)) return false;
    if (f.peruntukan) {
      const dec = decodeAsetId(item.id_aset);
      if ((dec.peruntukan || "").toUpperCase() !== f.peruntukan) return false;
    }
    if (f.idFrom || f.idTo) {
      // Leading segment of the id is the running number: "6.RGM.1.24.A.D1"
      const urut = parseInt((item.id_aset || "").split(".")[0], 10);
      if (!isNaN(urut)) {
        if (f.idFrom && urut < parseInt(f.idFrom, 10)) return false;
        if (f.idTo   && urut > parseInt(f.idTo, 10))   return false;
      }
    }
    if (f.tahunFrom || f.tahunTo) {
      // "Tahun Beli" means the purchase date, not waktu_update (the scrap date).
      const yr = parseInt((item.tanggal_pembelian || "").slice(0, 4), 10);
      if (isNaN(yr)) return false;
      if (f.tahunFrom && yr < parseInt(f.tahunFrom, 10)) return false;
      if (f.tahunTo   && yr > parseInt(f.tahunTo, 10))   return false;
    }
    return true;
  });

  // Sort
  filtered = [...filtered].sort((a, b) => {
    if (_afkirSortDir === "date-desc")
      return new Date(b.waktu_update || 0) - new Date(a.waktu_update || 0);
    if (_afkirSortDir === "date-asc")
      return new Date(a.waktu_update || 0) - new Date(b.waktu_update || 0);
    if (_afkirSortDir === "count-desc" || _afkirSortDir === "count-asc") {
      // Counts ride on the afkir payload itself. They used to be looked up in
      // _historySummary, which excludes AFKIR assets by design — so every score
      // was 0 and both directions were no-ops.
      const hits = (x) => (x.repair_count || 0) + (x.mutasi_count || 0);
      return _afkirSortDir === "count-desc" ? hits(b) - hits(a) : hits(a) - hits(b);
    }
    const av = (a[_afkirSortField] || "").toString().toUpperCase();
    const bv = (b[_afkirSortField] || "").toString().toUpperCase();
    return _afkirSortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
  });

  if (countEl) countEl.textContent = `${filtered.length} aset`;

  if (!filtered.length) {
    renderPagerBar("afkir-pager", paginateList("afkir", filtered), renderAfkirCards);
    container.innerHTML = `<div class="col-span-full text-center text-gray-400 py-14">
            <i class="fas fa-recycle text-4xl mb-3 block"></i>
            <p class="text-sm">Tidak ada aset afkir${q ? " yang cocok dengan pencarian" : ""}.</p></div>`;
    return;
  }

  const row = cardDetailRow;

  // Slice AFTER filter + sort.
  const _afkirPage = paginateList("afkir", filtered);
  renderPagerBar("afkir-pager", _afkirPage, renderAfkirCards);

  container.innerHTML = _afkirPage.items
    .map((item) => {
      const uptCode  = item.id_lokasi_raw || item.id_lokasi || "";
      const uptEntry = uptDatabase.find((u) => u.upt === uptCode);
      const isParent = !uptEntry && !!lokasiData.find((l) => l.code === uptCode);
      const parentCode = getParentLokasiCode(uptCode) || uptCode;
      const lokasiName =
        lokasiData.find((l) => l.code === parentCode)?.name ||
        item.lokasi_name ||
        parentCode ||
        "—";
      const uptDisplay = uptEntry
        ? uptEntry.nama
        : isParent
          ? "—"
          : item.lokasi_name || uptCode || "—";
      const dec = decodeAsetId(item.id_aset);
      const tanggalBeli = item.tanggal_pembelian
        ? new Date(item.tanggal_pembelian).toLocaleDateString("id-ID", {
            day: "2-digit",
            month: "long",
            year: "numeric",
          })
        : "—";
      const afkirBadge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"><i class="fas fa-circle text-[6px]"></i>AFKIR</span>`;
      const waktuBadge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400"><i class="fas fa-clock text-[8px]"></i>${
        item.waktu_update ? formatUtcToLocal(item.waktu_update) : "—"
      }</span>`;

      return `
        <div class="${ASSET_CARD_CLASS}">
            <div>
                <div class="flex justify-between items-start gap-2">
                    <div class="flex flex-col min-w-0">
                        <span class="text-base font-bold font-mono text-kai-blue dark:text-blue-400 leading-tight">${item.id_aset}</span>
                        <p class="text-sm text-gray-700 dark:text-gray-300 font-semibold mt-0.5">${item.kode_alat_name || item.kode_alat || "—"}</p>
                    </div>
                    <div class="flex flex-col items-end gap-1 shrink-0 ml-2">
                        ${afkirBadge}
                        ${waktuBadge}
                    </div>
                </div>

                <div class="mt-3 space-y-1 border-t border-gray-100 dark:border-gray-700 pt-3 capitalize">
                    ${row("Pengadaan", PENGADAAN_MAP[item.sumber_pengadaan] || item.sumber_pengadaan || "—")}
                    ${row("Tanggal Beli", tanggalBeli)}
                    ${row("Lokasi", lokasiName)}
                    ${row("UPT", uptDisplay)}
                    ${row("Peruntukan", item.peruntukan || dec.peruntukan || "—")}
                </div>
            </div>
            <div class="mt-4 space-y-2">
                <button onclick="window.openPulihkanModal('${item.id_aset}')"
                    class="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 bg-green-600 hover:bg-green-700 active:bg-green-800 text-white font-semibold rounded-lg transition text-sm shadow-sm">
                    <i class="fas fa-wrench text-sm"></i> Proses Lebih Lanjut
                </button>
            </div>
        </div>`;
    })
    .join("");
}

document.getElementById("search-afkir")?.addEventListener("input", () => {
  resetPage("afkir");
  renderAfkirCards();
});

// ── Afkir Sort Button ─────────────────────────────────────────────────────
function _paintAfkirDirBtns() {
  document.querySelectorAll(".afkir-sort-dir-btn").forEach((b) => {
    const active = b.dataset.afkirDir === _afkirSortDir;
    b.classList.toggle("border-green-500",     active);
    b.classList.toggle("bg-green-100",         active);
    b.classList.toggle("dark:bg-green-900/20", active);
    b.classList.toggle("text-green-600",       active);
    b.classList.toggle("dark:text-green-300",  active);
    b.classList.toggle("border-gray-200",      !active);
    b.classList.toggle("dark:border-gray-600", !active);
    b.classList.toggle("bg-white",             !active);
    b.classList.toggle("dark:bg-gray-700",     !active);
    b.classList.toggle("text-gray-500",        !active);
  });
}

// Rebuilds the Lokasi → UPT pair the same way the other sort modals do:
// the UPT list is restricted to the chosen Lokasi's children, stays DISABLED
// until a Lokasi is picked, and preserves the current UPT across reopens.
function _syncAfkirLokasiUpt() {
  const lokSel = document.getElementById("afkir-sort-lok-lokasi");
  const uptSel = document.getElementById("afkir-sort-lok-upt");
  if (!uptSel) return;
  const chosenLok = lokSel?.value || "";
  const currentUpt = uptSel.value;
  uptSel.innerHTML = `<option value="">— ${chosenLok ? "Semua UPT" : "Pilih Lokasi dahulu"} —</option>`;
  uptSel.disabled = !chosenLok;
  if (chosenLok) {
    uptDatabase
      .filter((u) => u.lokasi === chosenLok)
      .forEach((u) => {
        const o = document.createElement("option");
        o.value = u.upt;
        o.textContent = `${u.nama || u.upt} (${u.upt})`;
        uptSel.appendChild(o);
      });
    if (currentUpt) uptSel.value = currentUpt;
  }
}

document.getElementById("afkir-btn-sort")?.addEventListener("click", () => {
  _populateYearDropdowns("afkir-sort-tgl-from", "afkir-sort-tgl-to");

  const alatSel = document.getElementById("afkir-sort-alat-filter");
  if (alatSel && alatSel.options.length <= 1) {
    alatKerjaData.forEach((a) => {
      const o = document.createElement("option");
      o.value = a.code;
      o.textContent = `${a.code} — ${a.name}`;
      alatSel.appendChild(o);
    });
  }
  const lokSel = document.getElementById("afkir-sort-lok-lokasi");
  if (lokSel && lokSel.options.length <= 1) {
    lokasiData.forEach((l) => {
      const o = document.createElement("option");
      o.value = l.code;
      o.textContent = `${l.name} (${l.code})`;
      lokSel.appendChild(o);
    });
  }
  _syncAfkirLokasiUpt();

  // Sync field → panel + checkbox state
  const curField = document.getElementById("afkir-sort-field")?.value || "";
  const curChecked = document.getElementById("afkir-sort-custom-spec")?.checked || false;
  _syncSortPanels(curField, curChecked, "afkir-sort", "afkir-sort-all-data-label", "afkir-sort-custom-panels");

  _paintAfkirDirBtns();
  document.getElementById("afkir-sort-modal")?.classList.remove("hidden");
});

document.getElementById("close-afkir-sort-modal")?.addEventListener("click", () => {
  document.getElementById("afkir-sort-modal")?.classList.add("hidden");
});

// Field change → show/hide panel
document.getElementById("afkir-sort-field")?.addEventListener("change", (e) => {
  const checked = document.getElementById("afkir-sort-custom-spec")?.checked;
  _syncSortPanels(e.target.value, checked, "afkir-sort", "afkir-sort-all-data-label", "afkir-sort-custom-panels");
});
document.getElementById("afkir-sort-custom-spec")?.addEventListener("change", (e) => {
  const field = document.getElementById("afkir-sort-field")?.value;
  _syncSortPanels(field, e.target.checked, "afkir-sort", "afkir-sort-all-data-label", "afkir-sort-custom-panels");
});

// Lokasi → UPT cascade in sort modal
document.getElementById("afkir-sort-lok-lokasi")?.addEventListener("change", () => {
  const uptSel = document.getElementById("afkir-sort-lok-upt");
  if (uptSel) uptSel.value = ""; // the old UPT belongs to the previous Lokasi
  _syncAfkirLokasiUpt();
});

// Direction buttons
document.querySelectorAll(".afkir-sort-dir-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    _afkirSortDir = btn.dataset.afkirDir;
    _paintAfkirDirBtns();
  });
});

// Apply
document.getElementById("afkir-sort-apply")?.addEventListener("click", () => {
  // Falls back to the SAME default Reset writes; these two used to disagree
  // ("id_aset" here vs "tanggal_pembelian" there), so applying an empty form
  // and resetting produced two different orderings.
  const fieldVal = document.getElementById("afkir-sort-field")?.value || AFKIR_SORT_DEFAULTS.field;
  _afkirSortField = sortFieldOf(fieldVal);
  const customChecked = document.getElementById("afkir-sort-custom-spec")?.checked;
  _afkirSortFilters = {};
  if (customChecked && fieldVal) {
    if (fieldVal === "id_aset") {
      _afkirSortFilters.idFrom = parseInt(document.getElementById("afkir-sort-id-from")?.value) || null;
      _afkirSortFilters.idTo   = parseInt(document.getElementById("afkir-sort-id-to")?.value)   || null;
    } else if (fieldVal === "kode_alat_name") {
      _afkirSortFilters.alat = document.getElementById("afkir-sort-alat-filter")?.value || "";
    } else if (fieldVal === "sumber_pengadaan") {
      _afkirSortFilters.pengadaan = document.querySelector('input[name="afkir-sort-pengadaan-filter"]:checked')?.value || "";
    } else if (fieldVal === "tanggal_pembelian") {
      _afkirSortFilters.tahunFrom = document.getElementById("afkir-sort-tgl-from")?.value || "";
      _afkirSortFilters.tahunTo   = document.getElementById("afkir-sort-tgl-to")?.value   || "";
    } else if (fieldVal === "peruntukan") {
      _afkirSortFilters.peruntukan = document.querySelector('input[name="afkir-sort-peruntukan-filter"]:checked')?.value || "";
    } else if (fieldVal === "id_lokasi") {
      _afkirSortFilters.lokasi = document.getElementById("afkir-sort-lok-lokasi")?.value || "";
      _afkirSortFilters.upt    = document.getElementById("afkir-sort-lok-upt")?.value    || "";
    }
  }
  document.getElementById("afkir-sort-modal")?.classList.add("hidden");
  resetPage("afkir");
  renderAfkirCards();
});

// Reset
document.getElementById("afkir-sort-reset")?.addEventListener("click", () => {
  _afkirSortField   = AFKIR_SORT_DEFAULTS.field;
  _afkirSortDir     = AFKIR_SORT_DEFAULTS.dir;
  _afkirSortFilters = {};

  const sortField = document.getElementById("afkir-sort-field");
  if (sortField) sortField.value = "";
  const sortSpec = document.getElementById("afkir-sort-custom-spec");
  if (sortSpec) sortSpec.checked = false;

  document.querySelectorAll("#afkir-sort-custom-panels input[type='text'], #afkir-sort-custom-panels input[type='number'], #afkir-sort-custom-panels select").forEach(el => { el.value = ""; });
  // Restore the "Semua" default rather than leaving every radio unchecked.
  document.querySelectorAll("#afkir-sort-custom-panels input[type='radio']").forEach(el => { el.checked = el.value === ""; });
  _syncAfkirLokasiUpt();

  _syncSortPanels("", false, "afkir-sort", "afkir-sort-all-data-label", "afkir-sort-custom-panels");
  _paintAfkirDirBtns();
  showToast("Nilai sort pada menu ini telah direset.", "info");
  resetPage("afkir");
  renderAfkirCards();
});

window.openPulihkanModal = (uid) => {
  document.getElementById("pulihkan-uid").value = uid;
  document.getElementById("pulihkan-modal-subtitle").innerText = uid;
  document.getElementById("pulihkan-modal").classList.remove("hidden");
};

document
  .getElementById("close-pulihkan-modal")
  ?.addEventListener("click", () => {
    document.getElementById("pulihkan-modal").classList.add("hidden");
  });
document.getElementById("pulihkan-modal")?.addEventListener("click", (e) => {
  if (e.target === document.getElementById("pulihkan-modal"))
    document.getElementById("pulihkan-modal").classList.add("hidden");
});
document
  .getElementById("pulihkan-cancel-btn")
  ?.addEventListener("click", () => {
    document.getElementById("pulihkan-modal").classList.add("hidden");
  });

document
  .getElementById("pulihkan-confirm-btn")
  ?.addEventListener("click", async () => {
    const uid = document.getElementById("pulihkan-uid").value;
    document.getElementById("pulihkan-modal").classList.add("hidden");
    try {
      const res = await apiFetch(`/aset/pulihkan/${uid}`, { method: "POST" });
      if (!res.ok)
        throw new Error((await res.json()).detail || "Gagal memulihkan aset.");
      showToast(`Aset ${uid} berhasil dipulihkan.`, "success");
      await loadAfkirCards();
      await fetchAsetFromServer();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

document
  .getElementById("pulihkan-delete-btn")
  ?.addEventListener("click", async () => {
    const uid = document.getElementById("pulihkan-uid").value;
    document.getElementById("pulihkan-modal").classList.add("hidden");
    const confirmed = await customConfirm(
      `Hapus permanen aset "${uid}"?\n\nTindakan ini TIDAK DAPAT DIBATALKAN. Seluruh riwayat aset ini akan hilang dari sistem.`,
    );
    if (!confirmed) return;
    try {
      const res = await apiFetch(`/aset/${uid}`, { method: "DELETE" });
      if (!res.ok)
        throw new Error((await res.json()).detail || "Gagal menghapus aset.");
      showToast(`Aset ${uid} telah dihapus permanen.`, "success");
      await loadAfkirCards();
      await fetchAsetFromServer();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

// Format a plain date string (YYYY-MM-DD) as "D MonthName YYYY 00:00:00"
function formatDateOnly(dateStr) {
  if (!dateStr) return "—";
  const bulan = ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];
  const parts = dateStr.slice(0, 10).split("-");
  if (parts.length < 3) return dateStr;
  const d = parseInt(parts[2]);
  const m = bulan[parseInt(parts[1]) - 1] || parts[1];
  const y = parts[0];
  return `${d} ${m} ${y}`;
}

function formatUtcToLocal(utcStr) {
  if (!utcStr) return "—";
  // Server sends naive local time (UTC+7). Append offset to parse correctly as local.
  const localStr = utcStr.replace(" ", "T"); // '+07:00'
  const date = new Date(localStr);
  if (isNaN(date)) return utcStr;

  const bulan = [
    "Januari",
    "Februari",
    "Maret",
    "April",
    "Mei",
    "Juni",
    "Juli",
    "Agustus",
    "September",
    "Oktober",
    "November",
    "Desember",
  ];
  const d = date.getDate();
  const m = bulan[date.getMonth()];
  const y = date.getFullYear();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${d} ${m} ${y} ${hh}:${mm}:${ss}`;
}

// ════════════════════════════════════════════════════════════════════
// CHART TOOLKIT — shared by the repair dashboard and the stock dashboard
// ════════════════════════════════════════════════════════════════════
// Both dashboards must read as one system, so the palette, the theme resolver
// and the mark specs live here rather than being re-declared per module.
//
// Every palette below was checked with the data-viz validator against this
// app's real surfaces (light #ffffff, dark #1f2937) — not against a generic
// default — for the OKLCH lightness band, the chroma floor, protan/deutan
// separation and contrast. Re-run it before changing any hex.

const KAI_VIZ = (() => {
  // Series colors: hue-preserving steps of the KAI brand blue and orange. Each
  // mode's pair clears the lightness band, the chroma floor, CVD separation
  // (ΔE 25.8 protan light / 28.6 dark) and 3:1 contrast on its own surface —
  // the raw brand hex values do not.
  const SERIES = {
    light: { in: "#0b73ca", out: "#cf7217" },
    dark: { in: "#1087ed", out: "#db7711" },
  };

  // 8-slot categorical theme, in fixed order. Never cycled: a 9th category
  // folds into "Lainnya" instead of reusing a hue, because a generated 9th hue
  // is indistinguishable from an existing one under CVD.
  const CATEGORICAL = {
    light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
    dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  };

  // Status scale — deliberately NOT part of the categorical theme, so a status
  // color can never impersonate a series. On the light surface `warning` (1.83:1)
  // and `serious` (2.64:1) sit below 3:1 by design; the icon + label pairing is
  // the mitigation, so every use of these MUST ship both. Never color alone.
  const STATUS = {
    good: "#0ca30c",
    warning: "#fab219",
    serious: "#ec835a",
    critical: "#d03b3b",
  };

  function theme() {
    const isDark = document.documentElement.classList.contains("dark");
    return {
      isDark,
      series: isDark ? SERIES.dark : SERIES.light,
      categorical: isDark ? CATEGORICAL.dark : CATEGORICAL.light,
      status: STATUS,
      // Off-axis neutral, e.g. "di atas max" — a state that is neither good nor
      // bad and must not borrow a status hue.
      neutral: isDark ? "#6b7280" : "#9ca3af",
      text: isDark ? "#9ca3af" : "#6b7280",
      grid: isDark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.05)",
      surface: isDark ? "#1f2937" : "#ffffff",
      track: isDark ? "#374151" : "#e5e7eb",
    };
  }

  // Draws the value above each bar, like the printed report. Selective on
  // purpose: zeros are skipped and labels are dropped entirely once bars get
  // too narrow to hold them, so a 25-resort chart doesn't turn into noise.
  const barValueLabels = {
    id: "kaiBarValueLabels",
    afterDatasetsDraw(chart, _args, opts) {
      const { ctx } = chart;
      const color = opts?.color || "#6b7280";
      const minBarWidth = opts?.minBarWidth ?? 9;
      ctx.save();
      ctx.font = "600 9px Inter, system-ui, sans-serif";
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      chart.data.datasets.forEach((ds, di) => {
        const meta = chart.getDatasetMeta(di);
        if (meta.hidden) return;
        for (const el of meta.data) {
          if (!el || el.width < minBarWidth) return; // bars too thin — skip all
        }
        meta.data.forEach((el, i) => {
          const v = ds.data[i];
          if (!v) return; // hide zeros
          ctx.fillText(String(v), el.x, el.y - 2);
        });
      });
      ctx.restore();
    },
  };

  // Shared options for the IN/OUT grouped bars. The 2px `borderColor` is the
  // surface gap that separates adjacent bars without drawing a box around them.
  function groupedBarOptions(t, { rotate = 0, valueLabels = true } = {}) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      layout: { padding: { top: 14 } }, // room for the value labels
      plugins: {
        legend: {
          labels: { color: t.text, font: { size: 10 }, boxWidth: 10, usePointStyle: true },
        },
        tooltip: {
          callbacks: {
            footer: (items) => {
              const inV = items.find((i) => i.dataset.label?.includes("Masuk"))?.parsed.y ?? 0;
              const outV = items.find((i) => i.dataset.label?.includes("Keluar"))?.parsed.y ?? 0;
              return inV ? `Selesai: ${Math.round((outV / inV) * 100)}%` : "";
            },
          },
        },
        kaiBarValueLabels: valueLabels ? { color: t.text } : false,
      },
      scales: {
        x: {
          ticks: {
            color: t.text,
            font: { size: 9 },
            maxRotation: rotate,
            minRotation: rotate,
            autoSkip: false,
          },
          grid: { display: false },
        },
        y: {
          ticks: { color: t.text, font: { size: 9 }, precision: 0 },
          grid: { color: t.grid },
          beginAtZero: true,
        },
      },
    };
  }

  function inOutDatasets(t, inData, outData) {
    const common = {
      borderRadius: 4,
      borderSkipped: false,
      borderWidth: 2,
      borderColor: t.surface, // 2px surface gap between adjacent bars
      categoryPercentage: 0.78,
      barPercentage: 0.92,
    };
    return [
      { label: "Alat Kerja Masuk (IN)", data: inData, backgroundColor: t.series.in, ...common },
      { label: "Alat Kerja Keluar (OUT)", data: outData, backgroundColor: t.series.out, ...common },
    ];
  }

  // Rupiah, compacted at the scale finance actually reads: a dashboard tile
  // showing "Rp 1.582.060.000" is unreadable at a glance.
  function rupiah(n) {
    const v = Number(n || 0);
    const abs = Math.abs(v);
    if (abs >= 1e12) return `Rp ${(v / 1e12).toFixed(2)} T`;
    if (abs >= 1e9) return `Rp ${(v / 1e9).toFixed(2)} M`;
    if (abs >= 1e6) return `Rp ${(v / 1e6).toFixed(1)} Jt`;
    return `Rp ${v.toLocaleString("id-ID")}`;
  }

  function rupiahFull(n) {
    return `Rp ${Number(n || 0).toLocaleString("id-ID")}`;
  }

  return {
    SERIES,
    CATEGORICAL,
    STATUS,
    theme,
    barValueLabels,
    groupedBarOptions,
    inOutDatasets,
    rupiah,
    rupiahFull,
  };
})();

const BULAN_PANJANG = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

// ════════════════════════════════════════════════════════════════════
// REPAIR DASHBOARD — Dashboard ▸ Laporan Perbaikan
// ════════════════════════════════════════════════════════════════════
// Moved out of Kelola Inventaris: it reports on the ASSET fleet, not on parts
// stock, so it belongs with the other fleet dashboards. Driven by
// GET /api/aset/dashboard/perbaikan and GET /api/aset/dashboard/mcf, which
// share this panel's Lokasi + Tahun filters.

(function setupRepairDashboard() {
  let _lokasiFilter = "";
  let _tahunFilter = null; // null until the backend resolves a year with data
  let _booted = false;

  const el = (id) => document.getElementById(id);

  // ── Filters ───────────────────────────────────────────────────────

  // The user's home region comes from GET /api/me (which resolves a UPT code
  // like JR1.3 up to its DAOP), falling back to the JWT claim if that call
  // fails. Preselected but never locked — every role can browse any region.
  async function resolveDefaultRegion() {
    try {
      const res = await apiFetch("/me");
      if (res.ok) {
        const me = await res.json();
        if (me.default_region) return me.default_region;
      }
    } catch (_) { /* fall through to the token */ }
    const raw = getJwtPayload(authToken)?.id_lokasi || "";
    if (!raw) return "";
    if (lokasiData.some((l) => l.code === raw)) return raw;
    return getParentLokasiCode(raw) || "";
  }

  async function loadLokasiOptions() {
    const sel = el("rd-lokasi");
    if (!sel) return;
    try {
      const res = await apiFetch("/master/lokasi?tipe=DAOP&tipe=DIVRE&tipe=PUSAT&tipe=BALAIYASA");
      if (!res.ok) return;
      const data = await res.json();
      sel.innerHTML = '<option value="">— Semua Lokasi —</option>' +
        data.map((l) => `<option value="${l.id_lokasi}">${l.nama_lokasi}</option>`).join("");
      const preferred = await resolveDefaultRegion();
      if (preferred && data.some((l) => l.id_lokasi === preferred)) {
        sel.value = preferred;
        _lokasiFilter = preferred;
      }
    } catch (_) { /* silent — the report falls back to the global view */ }
  }

  const MIN_TAHUN = 1950;

  // Rebuilt on every response: `available_years` is scope-dependent, so the
  // years that actually hold data change when the region changes. Years with
  // no data stay selectable but are marked, and the current pick is re-snapped
  // if the backend resolved a different year.
  function syncTahunOptions(resolvedYear, availableYears) {
    const sel = el("rd-tahun");
    if (!sel) return;
    const withData = new Set(availableYears || []);
    const maxYear = Math.max(new Date().getFullYear(), resolvedYear || 0, ...withData);
    const opts = [];
    for (let y = maxYear; y >= MIN_TAHUN; y--) {
      const has = withData.has(y);
      opts.push(
        `<option value="${y}"${has ? "" : ' class="text-gray-400"'}>${y}${has ? "" : " (kosong)"}</option>`,
      );
    }
    sel.innerHTML = opts.join("");
    sel.value = String(resolvedYear);
    _tahunFilter = resolvedYear;
  }

  el("rd-lokasi")?.addEventListener("change", function () {
    _lokasiFilter = this.value;
    // Drop the year so the backend re-resolves the newest year that actually
    // holds data for the new region. Regions have different histories, and
    // carrying the old year over strands the user on an empty report.
    _tahunFilter = null;
    load();
  });

  el("rd-tahun")?.addEventListener("change", function () {
    _tahunFilter = parseInt(this.value, 10) || null;
    load();
  });

  el("rd-refresh")?.addEventListener("click", () => load());

  // ── Chart handles ─────────────────────────────────────────────────
  let _chartResort = null;
  let _chartAlat = null;
  let _chartResortAll = null;
  let _chartAlatAll = null;
  let _chartTrend = null;
  let _chartPie = null;
  let _chartGauge = null;
  let _chartMcf = null;

  // ── Loader ────────────────────────────────────────────────────────
  async function load() {
    if (!authToken) return;
    const params = new URLSearchParams();
    if (_lokasiFilter) params.set("id_lokasi", _lokasiFilter);
    if (_tahunFilter) params.set("year", String(_tahunFilter));
    try {
      const res = await apiFetch(`/aset/dashboard/perbaikan?${params}`);
      if (!res.ok) {
        showToast("Gagal memuat laporan perbaikan.", "error");
        return;
      }
      render(await res.json());
      // MCF rides the year the repair report actually resolved to, so the two
      // halves of the panel can never disagree about which year is on screen.
      loadMcf();
    } catch (e) {
      console.warn("Repair dashboard load failed:", e);
    }
  }

  async function loadMcf() {
    const canvas = el("rd-chart-mcf");
    if (!canvas) return;
    const params = new URLSearchParams();
    if (_lokasiFilter) params.set("id_lokasi", _lokasiFilter);
    if (_tahunFilter) params.set("year", String(_tahunFilter));
    try {
      const res = await apiFetch(`/aset/dashboard/mcf?${params}`, { background: true });
      if (!res.ok) return;
      renderMcf(await res.json());
    } catch (e) {
      console.warn("MCF load failed:", e);
    }
  }

  function render(d) {
    const t = KAI_VIZ.theme();

    // ── Header ──
    syncTahunOptions(d.tahun, d.available_years);
    if (el("rd-kpi-year")) el("rd-kpi-year").textContent = d.tahun ?? "—";
    if (el("rd-region-name"))
      el("rd-region-name").textContent = d.region_label || "Semua Daerah Operasi";
    if (el("rd-dateline")) {
      const now = new Date();
      el("rd-dateline").textContent =
        `${d.kota || "Bandung"}, ${now.getDate()} ${BULAN_PANJANG[now.getMonth()]} ${now.getFullYear()}`;
    }

    // ── KPI strip ──
    if (el("rd-masuk")) el("rd-masuk").textContent = d.masuk ?? "—";
    if (el("rd-sedang")) el("rd-sedang").textContent = d.sedang ?? "—";
    if (el("rd-selesai")) el("rd-selesai").textContent = d.selesai ?? "—";
    if (el("rd-sedang-pct")) {
      // Deliberately NOT a percentage of `masuk`: sedang is a point-in-time
      // count that includes repairs opened in earlier years, so the ratio
      // against a single year's intake is meaningless (and can exceed 100%).
      el("rd-sedang-pct").textContent = d.sedang
        ? `${d.sedang} unit di workshop saat ini`
        : "tidak ada alat di workshop";
    }
    if (el("rd-diafkir")) {
      // Explains why masuk != selesai + sedang: some repairs end in scrapping.
      el("rd-diafkir").textContent = d.diafkir
        ? `${d.diafkir} berakhir afkir`
        : "kembali siap operasi";
    }

    // ── Completion gauge ──
    const pct = Number(d.persen_selesai || 0);
    if (el("rd-gauge-pct")) el("rd-gauge-pct").textContent = `${pct.toFixed(1)}%`;
    const gaugeCanvas = el("rd-chart-gauge");
    if (gaugeCanvas) {
      if (_chartGauge) _chartGauge.destroy();
      // Clamped for the arc only — a carry-over repair closed this year can push
      // the true ratio past 100%, and the ring must not wrap around itself.
      const arc = Math.max(0, Math.min(100, pct));
      _chartGauge = new Chart(gaugeCanvas, {
        type: "doughnut",
        data: {
          labels: ["Selesai", "Belum selesai"],
          datasets: [{
            data: [arc, 100 - arc],
            backgroundColor: [t.series.in, t.track],
            borderWidth: 0,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "72%",
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
        },
      });
    }

    // ── Workshop rail ──
    if (el("rd-workshop-badge")) el("rd-workshop-badge").textContent = d.sedang ?? 0;
    const wBody = el("rd-workshop-body");
    if (wBody) {
      if (!d.workshop_list || !d.workshop_list.length) {
        wBody.innerHTML =
          '<tr><td colspan="3" class="py-8 text-center text-gray-400 italic text-xs">Tidak ada alat sedang diperbaiki</td></tr>';
      } else {
        wBody.innerHTML = d.workshop_list.map((r, i) => `
          <tr class="border-b border-gray-50 dark:border-gray-700/50 hover:bg-amber-50 dark:hover:bg-amber-900/10 transition">
            <td class="px-2 py-1.5 text-gray-400 font-mono align-top">${i + 1}</td>
            <td class="px-2 py-1.5">
              <p class="font-semibold text-gray-700 dark:text-gray-200 leading-tight">${r.nama_alat}</p>
              <p class="text-[9px] text-gray-400">${r.lokasi_label || r.id_lokasi || "—"}</p>
            </td>
            <td class="px-2 py-1.5 text-right font-bold text-amber-600 align-top">${r.jumlah}</td>
          </tr>`).join("");
      }
    }

    // ── Top 10 Resort (grouped IN/OUT) ──
    const resortCanvas = el("rd-chart-resort");
    if (resortCanvas && d.top_resort) {
      if (_chartResort) _chartResort.destroy();
      _chartResort = new Chart(resortCanvas, {
        type: "bar",
        data: {
          labels: d.top_resort.map((r) => r.resort_label || r.resort),
          datasets: KAI_VIZ.inOutDatasets(t, d.top_resort.map((r) => r.masuk), d.top_resort.map((r) => r.selesai)),
        },
        options: KAI_VIZ.groupedBarOptions(t, { rotate: 45 }),
        plugins: [KAI_VIZ.barValueLabels],
      });
    }

    // ── Top 10 Alat (horizontal, single series — bar length carries the value,
    //    so no legend and no categorical hue is spent on identity) ──
    const alatCanvas = el("rd-chart-alat");
    if (alatCanvas && d.top_alat) {
      if (_chartAlat) _chartAlat.destroy();
      _chartAlat = new Chart(alatCanvas, {
        type: "bar",
        data: {
          labels: d.top_alat.map((a) => a.nama_alat),
          datasets: [{
            label: "Jumlah Perbaikan",
            data: d.top_alat.map((a) => a.masuk),
            backgroundColor: t.series.in,
            borderRadius: 4,
            borderSkipped: false,
          }],
        },
        options: {
          indexAxis: "y",
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } }, // single series — the title names it
          scales: {
            x: { ticks: { color: t.text, font: { size: 9 }, precision: 0 }, grid: { color: t.grid }, beginAtZero: true },
            y: {
              ticks: {
                color: t.text,
                font: { size: 9 },
                callback(v) {
                  const s = this.getLabelForValue(v);
                  return s.length > 22 ? s.slice(0, 21) + "…" : s;
                },
              },
              grid: { display: false },
            },
          },
        },
      });
    }

    // ── Full-width: every resort ──
    const resortAll = el("rd-chart-resort-all");
    if (resortAll && d.per_resort) {
      if (_chartResortAll) _chartResortAll.destroy();
      // Widen the scroll container so bars stay legible as resorts multiply.
      const wrap = el("rd-resort-all-wrap");
      if (wrap) wrap.style.minWidth = `${Math.max(720, d.per_resort.length * 46)}px`;
      if (el("rd-resort-count"))
        el("rd-resort-count").textContent = `${d.per_resort.length} resort`;
      _chartResortAll = new Chart(resortAll, {
        type: "bar",
        data: {
          labels: d.per_resort.map((r) => r.resort_label || r.resort),
          datasets: KAI_VIZ.inOutDatasets(t, d.per_resort.map((r) => r.masuk), d.per_resort.map((r) => r.selesai)),
        },
        options: KAI_VIZ.groupedBarOptions(t, { rotate: 55 }),
        plugins: [KAI_VIZ.barValueLabels],
      });
    }

    // ── Full-width: every alat kerja ──
    const alatAll = el("rd-chart-alat-all");
    if (alatAll && d.per_alat) {
      if (_chartAlatAll) _chartAlatAll.destroy();
      const wrap = el("rd-alat-all-wrap");
      if (wrap) wrap.style.minWidth = `${Math.max(720, d.per_alat.length * 56)}px`;
      if (el("rd-alat-count"))
        el("rd-alat-count").textContent = `${d.per_alat.length} jenis alat`;
      _chartAlatAll = new Chart(alatAll, {
        type: "bar",
        data: {
          labels: d.per_alat.map((a) =>
            a.nama_alat.length > 26 ? a.nama_alat.slice(0, 25) + "…" : a.nama_alat,
          ),
          datasets: KAI_VIZ.inOutDatasets(t, d.per_alat.map((a) => a.masuk), d.per_alat.map((a) => a.selesai)),
        },
        options: KAI_VIZ.groupedBarOptions(t, { rotate: 55 }),
        plugins: [KAI_VIZ.barValueLabels],
      });
    }

    // ── Monthly trend (line, matching the report) ──
    const trendCanvas = el("rd-chart-trend");
    if (trendCanvas && d.monthly_trend) {
      if (_chartTrend) _chartTrend.destroy();
      const line = (label, color, data) => ({
        label,
        data,
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        tension: 0.3,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointBackgroundColor: color,
        pointBorderColor: t.surface, // 2px surface ring on overlapping markers
        pointBorderWidth: 2,
      });
      _chartTrend = new Chart(trendCanvas, {
        type: "line",
        data: {
          labels: d.monthly_trend.map((m) => m.bulan),
          datasets: [
            line("Masuk (IN)", t.series.in, d.monthly_trend.map((m) => m.masuk)),
            line("Keluar (OUT)", t.series.out, d.monthly_trend.map((m) => m.selesai)),
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { labels: { color: t.text, font: { size: 10 }, boxWidth: 10, usePointStyle: true } },
          },
          scales: {
            x: { ticks: { color: t.text, font: { size: 9 } }, grid: { display: false } },
            y: { ticks: { color: t.text, font: { size: 9 }, precision: 0 }, grid: { color: t.grid }, beginAtZero: true },
          },
        },
      });
    }

    // ── Composition doughnut + direct-labeled legend ──
    const pieCanvas = el("rd-chart-pie");
    const legEl = el("rd-pie-legend");
    if (pieCanvas && d.by_alat) {
      if (_chartPie) _chartPie.destroy();
      const all = Object.entries(d.by_alat).sort((a, b) => b[1] - a[1]);
      const total = all.reduce((s, [, v]) => s + v, 0);
      // Part-to-whole reads at a glance only up to ~6 wedges; the rest folds
      // into "Lainnya". Nothing is lost — the per-alat bar chart above lists
      // every category individually.
      const top = all.slice(0, 6);
      const rest = all.slice(6).reduce((s, [, v]) => s + v, 0);
      const slices = rest > 0 ? [...top, ["Lainnya", rest]] : top;

      if (!total) {
        pieCanvas.parentElement?.classList.add("hidden");
        if (legEl) legEl.innerHTML =
          '<p class="text-center text-gray-400 italic py-4">Tidak ada data perbaikan</p>';
      } else {
        pieCanvas.parentElement?.classList.remove("hidden");
        _chartPie = new Chart(pieCanvas, {
          type: "doughnut",
          data: {
            labels: slices.map(([k]) => k),
            datasets: [{
              data: slices.map(([, v]) => v),
              backgroundColor: slices.map((_, i) => t.categorical[i]),
              borderWidth: 2,
              borderColor: t.surface,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: "58%",
            plugins: {
              legend: { display: false }, // replaced by the direct-labeled list below
              tooltip: {
                callbacks: {
                  label: (c) => `${c.label}: ${c.parsed} (${((c.parsed / total) * 100).toFixed(1)}%)`,
                },
              },
            },
          },
        });
        // Direct labels satisfy the relief rule for the lighter categorical
        // steps, which sit under 3:1 contrast on a white surface.
        if (legEl) {
          legEl.innerHTML = slices.map(([k, v], i) => `
            <div class="flex items-center gap-2">
              <span class="w-2.5 h-2.5 rounded-sm shrink-0" style="background:${t.categorical[i]}"></span>
              <span class="truncate" title="${k}">${k}</span>
              <span class="ml-auto shrink-0 tabular-nums font-bold text-gray-700 dark:text-gray-200">${((v / total) * 100).toFixed(1)}%</span>
            </div>`).join("");
        }
      }
    }
  }

  // ── MCF curve ─────────────────────────────────────────────────────
  // One measure on one axis. The absolute counts (`kumulatif`, `perbaikan`) are
  // a different scale entirely, so they ride in the tooltip and the stat strip
  // rather than on a second y-axis.
  function renderMcf(d) {
    const t = KAI_VIZ.theme();
    const canvas = el("rd-chart-mcf");
    if (!canvas) return;

    if (el("rd-mcf-risk")) el("rd-mcf-risk").textContent = (d.aset_berisiko ?? 0).toLocaleString("id-ID");
    if (el("rd-mcf-total")) el("rd-mcf-total").textContent = (d.total_perbaikan ?? 0).toLocaleString("id-ID");
    if (el("rd-mcf-akhir")) el("rd-mcf-akhir").textContent = Number(d.mcf_akhir || 0).toFixed(4);
    if (el("rd-mcf-caption")) {
      el("rd-mcf-caption").textContent = d.aset_berisiko
        ? `${d.tahun} · ${d.aset_berisiko} unit berisiko`
        : `${d.tahun} · tidak ada aset dalam cakupan`;
    }

    const series = d.series || [];
    if (_chartMcf) _chartMcf.destroy();
    _chartMcf = new Chart(canvas, {
      type: "line",
      data: {
        labels: series.map((s) => s.bulan),
        datasets: [{
          label: "MCF (perbaikan per aset)",
          data: series.map((s) => s.mcf),
          borderColor: t.series.in,
          backgroundColor: t.isDark ? "rgba(16,135,237,0.14)" : "rgba(11,115,202,0.10)",
          borderWidth: 2,
          fill: true,
          tension: 0.25,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: t.series.in,
          pointBorderColor: t.surface,
          pointBorderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false }, // single series — the card title names it
          tooltip: {
            callbacks: {
              label: (c) => `MCF: ${Number(c.parsed.y).toFixed(4)}`,
              afterLabel: (c) => {
                const row = series[c.dataIndex] || {};
                return [
                  `Perbaikan bulan ini: ${row.perbaikan ?? 0}`,
                  `Kumulatif: ${row.kumulatif ?? 0}`,
                ];
              },
            },
          },
        },
        scales: {
          x: { ticks: { color: t.text, font: { size: 9 } }, grid: { display: false } },
          y: {
            ticks: {
              color: t.text,
              font: { size: 9 },
              // 4dp: with a few hundred assets a single month's increment is
              // ~0.003, so fewer decimals would render the curve flat.
              callback: (v) => Number(v).toFixed(3),
            },
            grid: { color: t.grid },
            beginAtZero: true,
          },
        },
      },
    });
  }

  // Charts bake their light/dark colors in at construction, so a theme flip
  // needs a re-render rather than a resize.
  window.addEventListener("kai-theme-change", () => {
    const panel = el("dash-panel-perbaikan");
    if (panel && !panel.classList.contains("hidden")) load();
  });

  // ── Entry point ───────────────────────────────────────────────────
  // Deliberately NOT run at script-eval time: apiFetch throws without a token,
  // so booting before login left the dropdowns and the report silently empty.
  // _renderDashActivePanel() calls this when the tab becomes active.
  window.initRepairDashboard = async function initRepairDashboard() {
    if (!authToken) return;
    if (!_booted) {
      _booted = true;
      await loadLokasiOptions();
    }
    load();
  };
})();

// ════════════════════════════════════════════════════════════════════
// INVENTARIS — Kelola Inventaris (Dasbor, Parts, Transaksi, Transfer)
// ════════════════════════════════════════════════════════════════════

(function setupInventaris() {

  // ── State ─────────────────────────────────────────────────────────
  // Scope is a WAREHOUSE, not a DAOP/UPT region: stock physically sits in a
  // handful of named stores that don't map onto the operational region tree.
  let _gudangFilter = "";   // "" = pooled across every warehouse
  let _dari = "";           // period start — movement figures only
  let _sampai = "";         // period end
  let _gudangList = [];
  let _partList = [];       // catalog cache; powers the entry form's datalist
  let _partByKey = new Map(); // datalist option string → part
  let _categories = [];
  let _invBooted = false;

  const el = (id) => document.getElementById(id);

  // ── Tab elements ──────────────────────────────────────────────────
  const tabDash = el("inv-tab-dashboard");
  const tabParts = el("inv-tab-parts");
  const tabTransaksi = el("inv-tab-transaksi");
  const tabTransfer = el("inv-tab-transfer");
  const panelDash = el("inv-panel-dashboard");
  const panelParts = el("inv-panel-parts");
  const panelTransaksi = el("inv-panel-transaksi");
  const panelTransfer = el("inv-panel-transfer");
  const toolbar = el("inv-toolbar");
  const toolbarActions = el("inv-toolbar-actions");
  const searchInput = el("inv-parts-search");

  // ── Tab switching ─────────────────────────────────────────────────
  const ALL_TABS = [
    { btn: tabDash, panel: panelDash, id: "dashboard" },
    { btn: tabParts, panel: panelParts, id: "parts" },
    { btn: tabTransaksi, panel: panelTransaksi, id: "transaksi" },
    { btn: tabTransfer, panel: panelTransfer, id: "transfer" },
  ];

  function setInvTab(which) {
    ALL_TABS.forEach(({ btn, panel, id }) => {
      const active = id === which;
      btn?.classList.toggle("border-kai-blue", active);
      btn?.classList.toggle("text-kai-blue", active);
      btn?.classList.toggle("border-transparent", !active);
      btn?.classList.toggle("text-gray-400", !active);
      panel?.classList.toggle("hidden", !active);
    });
    // The toolbar belongs to Parts and Transfer and lives outside every panel,
    // so it has to be hidden explicitly on the tabs that don't want it.
    toolbar?.classList.toggle("hidden", which === "dashboard" || which === "transaksi");
    toolbarActions?.classList.toggle("hidden", which !== "parts");
    if (searchInput) searchInput.value = "";
    if (which === "dashboard") loadStockDashboard();
    if (which === "parts") { loadInvParts(); loadInvKategoriOptions(); }
    if (which === "transaksi") { loadPartCatalog(); loadLedger({ reset: true }); }
    if (which === "transfer") loadInvTransfer();
  }

  ALL_TABS.forEach(({ btn, id }) => btn?.addEventListener("click", () => setInvTab(id)));

  // ── Bulk Upload dropdown ──────────────────────────────────────────
  const bulkToggle = el("inv-btn-bulk-toggle");
  const bulkDropdown = el("inv-bulk-dropdown");
  bulkToggle?.addEventListener("click", (e) => {
    e.stopPropagation();
    bulkDropdown?.classList.toggle("hidden");
  });
  document.addEventListener("click", () => bulkDropdown?.classList.add("hidden"));

  // ══════════════════════════════════════════════════════════════════
  // DASBOR INVENTARIS — stock dashboard
  // ══════════════════════════════════════════════════════════════════

  // The six Items Master states, in severity order, rolled into four bands.
  //
  // Bands exist because the part-to-whole bar can carry four segments legibly
  // and the status scale only defines four reserved tones; the six exact counts
  // live in the counter tiles above it, so no detail is lost. Each tile inherits
  // its band's tone and adds its own icon and label — `warning` and `serious`
  // sit below 3:1 on a white surface, so colour must never carry the meaning.
  const STOK_BANDS = [
    { key: "bermasalah", label: "Bermasalah", tone: "critical" },
    { key: "perhatian", label: "Perlu Perhatian", tone: "warning" },
    { key: "aman", label: "Aman", tone: "good" },
    { key: "atasmax", label: "Di Atas Maksimum", tone: "neutral" },
  ];

  const STOK_STATUS_META = [
    { key: "MINUS", label: "Minus", icon: "fa-circle-exclamation", band: "bermasalah",
      hint: "saldo negatif — cek data" },
    { key: "KOSONG", label: "Kosong", icon: "fa-box-open", band: "bermasalah",
      hint: "stok habis" },
    { key: "KRITIS", label: "Kritis", icon: "fa-triangle-exclamation", band: "perhatian",
      hint: "di bawah stok minimum" },
    { key: "DI BAWAH MIN", label: "Batas Min", icon: "fa-equals", band: "perhatian",
      hint: "tepat di stok minimum" },
    { key: "AMAN", label: "Aman", icon: "fa-circle-check", band: "aman",
      hint: "di atas stok minimum" },
    { key: "DI ATAS MAX", label: "Di Atas Max", icon: "fa-layer-group", band: "atasmax",
      hint: "melebihi stok maksimum" },
  ];

  function bandTone(t, key) {
    const band = STOK_BANDS.find((b) => b.key === key);
    if (!band) return t.neutral;
    return band.tone === "neutral" ? t.neutral : t.status[band.tone];
  }

  const fmtTanggal = (iso) => {
    if (!iso) return "—";
    const d = new Date(`${iso}T00:00:00`);
    if (isNaN(d)) return iso;
    return `${d.getDate()} ${BULAN_PANJANG[d.getMonth()]} ${d.getFullYear()}`;
  };

  const isoToday = () => new Date().toISOString().slice(0, 10);

  async function loadGudangOptions() {
    try {
      const res = await apiFetch("/inventaris/gudang");
      if (!res.ok) return;
      _gudangList = await res.json();
    } catch (_) {
      _gudangList = [];
    }
    const opts = _gudangList
      .map((g) => `<option value="${g.id_gudang}">${g.nama}</option>`)
      .join("");
    const dash = el("sd-filter-gudang");
    if (dash) dash.innerHTML = '<option value="">— Semua Gudang —</option>' + opts;
    const ledger = el("tx-filter-gudang");
    if (ledger) ledger.innerHTML = '<option value="">Semua Gudang</option>' + opts;
    // The entry form requires a warehouse — no blank option there.
    const entry = el("tx-gudang");
    if (entry) {
      entry.innerHTML = opts || '<option value="">— Belum ada gudang —</option>';
    }
  }

  el("sd-filter-gudang")?.addEventListener("change", function () {
    _gudangFilter = this.value;
    loadStockDashboard();
    // The Parts tab is scoped by the same warehouse, so its cached numbers are
    // stale the moment this changes.
    if (!panelParts?.classList.contains("hidden")) loadInvParts();
  });

  el("sd-filter-dari")?.addEventListener("change", function () {
    _dari = this.value;
    loadStockDashboard();
  });
  el("sd-filter-sampai")?.addEventListener("change", function () {
    _sampai = this.value;
    loadStockDashboard();
  });

  el("sd-preset-bulan")?.addEventListener("click", () => {
    const now = new Date();
    _dari = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    _sampai = isoToday();
    loadStockDashboard();
  });
  el("sd-preset-tahun")?.addEventListener("click", () => {
    _dari = `${new Date().getFullYear()}-01-01`;
    _sampai = isoToday();
    loadStockDashboard();
  });
  el("sd-refresh")?.addEventListener("click", () => loadStockDashboard());

  // ── Chart handles ─────────────────────────────────────────────────
  let _chartStatus = null;
  let _chartTransaksi = null;
  let _chartKategori = null;
  let _chartUsage = null;

  async function loadStockDashboard() {
    if (!authToken) return;
    const params = new URLSearchParams();
    if (_gudangFilter) params.set("id_gudang", _gudangFilter);
    if (_dari) params.set("dari", _dari);
    if (_sampai) params.set("sampai", _sampai);
    try {
      const res = await apiFetch(`/inventaris/dashboard?${params}`);
      if (!res.ok) {
        showToast("Gagal memuat dasbor inventaris.", "error");
        return;
      }
      renderStockDashboard(await res.json());
    } catch (e) {
      console.warn("Stock dashboard load failed:", e);
    }
  }

  function renderStockDashboard(d) {
    const t = KAI_VIZ.theme();
    const periode = d.periode || {};

    // Reflect back whatever window the server actually used — the inputs start
    // blank and the backend defaults to the current month, so without this the
    // date fields would silently disagree with the figures beside them.
    if (el("sd-filter-dari") && periode.dari) {
      el("sd-filter-dari").value = periode.dari;
      _dari = periode.dari;
    }
    if (el("sd-filter-sampai") && periode.sampai) {
      el("sd-filter-sampai").value = periode.sampai;
      _sampai = periode.sampai;
    }

    const gudangNama = _gudangFilter
      ? (_gudangList.find((g) => String(g.id_gudang) === String(_gudangFilter))?.nama || "Gudang")
      : "Semua Gudang";
    if (el("sd-scope-label")) el("sd-scope-label").textContent = gudangNama;
    if (el("sd-dateline")) {
      const now = new Date();
      el("sd-dateline").textContent =
        `Bandung, ${now.getDate()} ${BULAN_PANJANG[now.getMonth()]} ${now.getFullYear()}`;
    }

    const rentang = `${fmtTanggal(periode.dari)} — ${fmtTanggal(periode.sampai)}`;

    // ── Three value KPIs ──
    if (el("sd-nilai-total")) {
      el("sd-nilai-total").textContent = KAI_VIZ.rupiah(d.total_value);
      el("sd-nilai-total").title = KAI_VIZ.rupiahFull(d.total_value);
    }
    if (el("sd-nilai-masuk")) {
      el("sd-nilai-masuk").textContent = KAI_VIZ.rupiah(d.nilai_masuk);
      el("sd-nilai-masuk").title = KAI_VIZ.rupiahFull(d.nilai_masuk);
    }
    if (el("sd-nilai-keluar")) {
      el("sd-nilai-keluar").textContent = KAI_VIZ.rupiah(d.nilai_keluar);
      el("sd-nilai-keluar").title = KAI_VIZ.rupiahFull(d.nilai_keluar);
    }
    if (el("sd-nilai-masuk-note")) el("sd-nilai-masuk-note").textContent = rentang;
    if (el("sd-nilai-keluar-note")) el("sd-nilai-keluar-note").textContent = rentang;

    // ── Status counters ──
    const counts = d.status_counts || {};
    const totalParts = STOK_STATUS_META.reduce((s, m) => s + (counts[m.key] || 0), 0);
    if (el("sd-status-total")) el("sd-status-total").textContent = totalParts.toLocaleString("id-ID");

    const countersEl = el("sd-status-counters");
    if (countersEl) {
      countersEl.innerHTML = STOK_STATUS_META.map((m) => {
        const n = counts[m.key] || 0;
        const color = bandTone(t, m.band);
        return `
          <div class="p-4 text-center">
            <i class="fas ${m.icon} text-sm mb-1 block" style="color:${color}"></i>
            <p class="text-[9px] font-bold tracking-widest text-gray-400 uppercase mb-0.5">${m.label}</p>
            <p class="text-xl font-bold tabular-nums" style="color:${color}">${n.toLocaleString("id-ID")}</p>
            <p class="text-[9px] text-gray-400 mt-0.5 leading-tight">${m.hint}</p>
          </div>`;
      }).join("");
    }

    // ── Part-to-whole status bar (horizontal stacked) ──
    // A stacked bar rather than a doughnut: part-to-whole with long category
    // names reads better horizontally, and the segment lengths stay comparable
    // across reloads in a way pie angles do not.
    const bandTotals = STOK_BANDS.map((b) => ({
      ...b,
      value: STOK_STATUS_META
        .filter((m) => m.band === b.key)
        .reduce((s, m) => s + (counts[m.key] || 0), 0),
    }));
    const statusCanvas = el("sd-chart-status");
    if (statusCanvas) {
      if (_chartStatus) _chartStatus.destroy();
      _chartStatus = new Chart(statusCanvas, {
        type: "bar",
        data: {
          labels: [""],
          datasets: bandTotals.map((b) => ({
            label: b.label,
            data: [b.value],
            backgroundColor: bandTone(t, b.key),
            borderWidth: 2,
            borderColor: t.surface, // 2px surface gap between stacked segments
            borderRadius: 4,
            borderSkipped: false,
            barThickness: 26,
          })),
        },
        options: {
          indexAxis: "y",
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false }, // replaced by the direct-labeled row below
            tooltip: {
              callbacks: {
                label: (c) => {
                  const pct = totalParts ? ((c.parsed.x / totalParts) * 100).toFixed(1) : "0.0";
                  return `${c.dataset.label}: ${c.parsed.x} jenis (${pct}%)`;
                },
              },
            },
          },
          scales: {
            x: { stacked: true, display: false, beginAtZero: true },
            y: { stacked: true, display: false },
          },
        },
      });
    }
    const statusLegend = el("sd-status-legend");
    if (statusLegend) {
      statusLegend.innerHTML = bandTotals.map((b) => {
        const pct = totalParts ? ((b.value / totalParts) * 100).toFixed(1) : "0.0";
        return `
          <span class="flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-sm shrink-0" style="background:${bandTone(t, b.key)}"></span>
            <span>${b.label}</span>
            <span class="tabular-nums font-bold text-gray-700 dark:text-gray-200">${b.value} (${pct}%)</span>
          </span>`;
      }).join("");
    }

    // ── Transaksi per periode ──
    // Two-colour encoding by DIRECTION, not six categorical hues: what the
    // reader needs is whether each movement added or removed stock.
    const tx = d.transaksi_periode || [];
    const MASUK_TIPE = new Set(["IN", "RETUR_CUST", "ADJ_IN"]);
    // The server's labels are the printed report's full wording, which is too
    // long for a rotated axis tick. Shorten for the axis only — the tooltip and
    // the ledger keep the full names.
    const TX_TICK = {
      IN: "Masuk",
      OUT: "Keluar",
      RETUR_CUST: "Retur Cust.",
      RETUR_VENDOR: "Retur Vendor",
      ADJ_IN: "Peny. Masuk",
      ADJ_OUT: "Peny. Keluar",
    };
    if (el("sd-transaksi-periode")) el("sd-transaksi-periode").textContent = rentang;
    const txCanvas = el("sd-chart-transaksi");
    if (txCanvas) {
      if (_chartTransaksi) _chartTransaksi.destroy();
      _chartTransaksi = new Chart(txCanvas, {
        type: "bar",
        data: {
          labels: tx.map((r) => TX_TICK[r.tipe] || r.label),
          datasets: [{
            label: "Jumlah unit",
            data: tx.map((r) => r.jumlah),
            backgroundColor: tx.map((r) => (MASUK_TIPE.has(r.tipe) ? t.series.in : t.series.out)),
            borderRadius: 4,
            borderSkipped: false,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          layout: { padding: { top: 14 } },
          plugins: {
            legend: { display: false }, // direct-labeled legend row sits below
            tooltip: {
              callbacks: {
                // The axis tick is abbreviated, so the tooltip restores the
                // report's full wording.
                title: (items) => tx[items[0].dataIndex]?.label || "",
                label: (c) => {
                  const row = tx[c.dataIndex] || {};
                  const arah = MASUK_TIPE.has(row.tipe) ? "menambah stok" : "mengurangi stok";
                  return `${c.parsed.y} unit — ${arah}`;
                },
              },
            },
            kaiBarValueLabels: { color: t.text },
          },
          scales: {
            x: {
              ticks: { color: t.text, font: { size: 9 }, maxRotation: 20, minRotation: 20, autoSkip: false },
              grid: { display: false },
            },
            y: {
              ticks: { color: t.text, font: { size: 9 }, precision: 0 },
              grid: { color: t.grid },
              beginAtZero: true,
            },
          },
        },
        plugins: [KAI_VIZ.barValueLabels],
      });
    }
    const txLegend = el("sd-transaksi-legend");
    if (txLegend) {
      txLegend.innerHTML = [
        ["Menambah stok", t.series.in],
        ["Mengurangi stok", t.series.out],
      ].map(([label, color]) => `
        <span class="flex items-center gap-2">
          <span class="w-2.5 h-2.5 rounded-sm shrink-0" style="background:${color}"></span>
          <span>${label}</span>
        </span>`).join("");
    }

    // ── Jumlah part per subsistem ──
    // Nominal categories compared by magnitude: one hue for every bar. Colouring
    // them individually would spend the identity channel re-encoding what the
    // bar length already says.
    const subs = Object.entries(d.by_subsistem || {}).sort((a, b) => b[1] - a[1]);
    const katCanvas = el("sd-chart-kategori");
    if (katCanvas) {
      if (_chartKategori) _chartKategori.destroy();
      _chartKategori = new Chart(katCanvas, {
        type: "bar",
        data: {
          labels: subs.map(([k]) => k),
          datasets: [{
            label: "Jenis suku cadang",
            data: subs.map(([, v]) => v),
            backgroundColor: t.categorical[0],
            borderRadius: 4,
            borderSkipped: false,
          }],
        },
        options: {
          indexAxis: "y",
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false }, // single series — the title names it
            tooltip: { callbacks: { label: (c) => `${c.parsed.x} jenis suku cadang` } },
          },
          scales: {
            x: { ticks: { color: t.text, font: { size: 9 }, precision: 0 }, grid: { color: t.grid }, beginAtZero: true },
            y: { ticks: { color: t.text, font: { size: 10 } }, grid: { display: false } },
          },
        },
      });
    }

    // ── Pemakaian 12 bulan ──
    const usage = d.monthly_usage || [];
    const usageCanvas = el("sd-chart-usage");
    if (usageCanvas) {
      if (_chartUsage) _chartUsage.destroy();
      _chartUsage = new Chart(usageCanvas, {
        type: "line",
        data: {
          labels: usage.map((r) => r.bulan),
          datasets: [{
            label: "Unit keluar",
            data: usage.map((r) => r.jumlah),
            borderColor: t.series.out,
            backgroundColor: t.isDark ? "rgba(219,119,17,0.14)" : "rgba(207,114,23,0.10)",
            borderWidth: 2,
            fill: true,
            tension: 0.3,
            pointRadius: 4,
            pointHoverRadius: 6,
            pointBackgroundColor: t.series.out,
            pointBorderColor: t.surface,
            pointBorderWidth: 2,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { display: false }, // single series — the title names it
            tooltip: { callbacks: { label: (c) => `${c.parsed.y} unit keluar` } },
          },
          scales: {
            x: { ticks: { color: t.text, font: { size: 9 } }, grid: { display: false } },
            y: { ticks: { color: t.text, font: { size: 9 }, precision: 0 }, grid: { color: t.grid }, beginAtZero: true },
          },
        },
      });
    }

    // ── Top nilai persediaan ──
    const topBody = el("sd-top-value");
    if (topBody) {
      const rows = d.top_value || [];
      topBody.innerHTML = rows.length
        ? rows.map((r, i) => `
            <tr class="border-b border-gray-50 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition">
              <td class="px-3 py-2 text-gray-400 font-mono align-top">${i + 1}</td>
              <td class="px-3 py-2">
                <p class="font-semibold text-gray-700 dark:text-gray-200 leading-tight">${r.nama_part}</p>
                <p class="text-[10px] text-gray-400">${r.sku}</p>
              </td>
              <td class="px-3 py-2 text-right tabular-nums text-gray-600 dark:text-gray-300">${r.stok_sekarang} <span class="text-[10px] text-gray-400">${r.unit}</span></td>
              <td class="px-3 py-2 text-right tabular-nums font-semibold text-gray-800 dark:text-white" title="${KAI_VIZ.rupiahFull(r.nilai)}">${KAI_VIZ.rupiah(r.nilai)}</td>
            </tr>`).join("")
        : '<tr><td colspan="4" class="py-8 text-center text-gray-400 italic">Tidak ada data</td></tr>';
    }

    // ── Ringkasan katalog ──
    if (el("sd-total-parts")) el("sd-total-parts").textContent = (d.total_parts ?? 0).toLocaleString("id-ID");
    if (el("sd-total-types")) el("sd-total-types").textContent = (d.total_types ?? 0).toLocaleString("id-ID");
    if (el("sd-total-suppliers")) el("sd-total-suppliers").textContent = (d.total_suppliers ?? 0).toLocaleString("id-ID");
    if (el("sd-auto-demand")) el("sd-auto-demand").textContent = (d.auto_demand ?? 0).toLocaleString("id-ID");

    // ── Perlu segera dipesan ──
    if (el("sd-critical-badge")) el("sd-critical-badge").textContent = d.critical_count ?? 0;
    const critBody = el("sd-critical-body");
    if (critBody) {
      const rows = d.critical_list || [];
      critBody.innerHTML = rows.length
        ? rows.map((r) => {
            const meta = STOK_STATUS_META.find((m) => m.key === r.status_stok);
            const color = bandTone(t, meta?.band);
            return `
              <tr class="border-b border-gray-50 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition">
                <td class="px-4 py-2">
                  <p class="font-semibold text-gray-700 dark:text-gray-200 leading-tight">${r.nama_part}</p>
                  <p class="text-[9px] text-gray-400">${r.sku} · ${r.nama_alat || r.kode_alat || "—"}</p>
                </td>
                <td class="px-4 py-2 text-right whitespace-nowrap">
                  <span class="tabular-nums font-bold" style="color:${color}">${r.stok_sekarang}</span>
                  <span class="text-[9px] text-gray-400">/ ${r.stok_min} ${r.unit}</span>
                  <span class="flex items-center justify-end gap-1 text-[9px] font-bold mt-0.5" style="color:${color}">
                    <i class="fas ${meta?.icon || "fa-circle-exclamation"}"></i>${meta?.label || r.status_stok}
                  </span>
                </td>
              </tr>`;
          }).join("")
        : '<tr><td class="py-8 text-center text-gray-400 italic">Semua stok aman</td></tr>';
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // TRANSAKSI BARANG — movement entry + running ledger
  // ══════════════════════════════════════════════════════════════════

  const TIPE_LABEL = {
    IN: "Masuk",
    OUT: "Keluar",
    RETUR_CUST: "Retur dari Customer",
    RETUR_VENDOR: "Retur ke Vendor",
    ADJ_IN: "Penyesuaian Masuk",
    ADJ_OUT: "Penyesuaian Keluar",
  };
  const TIPE_MASUK = new Set(["IN", "RETUR_CUST", "ADJ_IN"]);

  // The datalist option text doubles as the lookup key, so the two must be
  // produced by the same function — a mismatch here silently breaks selection.
  const partKey = (p) => `${p.sku} · ${p.nama_part}`;

  async function loadPartCatalog() {
    try {
      const res = await apiFetch("/inventaris/parts");
      if (!res.ok) return;
      _partList = await res.json();
    } catch (_) {
      return;
    }
    _partByKey = new Map(_partList.map((p) => [partKey(p), p]));
    const dl = el("tx-part-list");
    if (dl) {
      dl.innerHTML = _partList
        .map((p) => `<option value="${partKey(p)}"></option>`)
        .join("");
    }
  }

  function selectedPart() {
    return _partByKey.get(el("tx-part")?.value.trim() || "") || null;
  }

  function recalcAmount() {
    const jumlah = parseInt(el("tx-jumlah")?.value, 10) || 0;
    const harga = parseInt(el("tx-harga")?.value, 10) || 0;
    if (el("tx-amount")) el("tx-amount").textContent = KAI_VIZ.rupiahFull(jumlah * harga);
  }

  function syncPartFields() {
    const p = selectedPart();
    if (el("tx-unit")) el("tx-unit").textContent = p ? p.unit : "—";
    if (p && el("tx-harga") && !el("tx-harga").dataset.touched) {
      el("tx-harga").value = p.harga_satuan ?? "";
    }
    if (el("tx-part-info")) {
      el("tx-part-info").textContent = p
        ? `Stok tercatat ${p.stok_sekarang} ${p.unit} · min ${p.stok_min} · ${p.subsistem || "tanpa subsistem"}`
        : "Belum ada barang dipilih.";
    }
    recalcAmount();
  }

  el("tx-part")?.addEventListener("input", () => {
    // A new part re-arms the auto-fill; an edit the user made to the price for a
    // previous part must not stick to the next one.
    if (el("tx-harga")) delete el("tx-harga").dataset.touched;
    syncPartFields();
  });
  el("tx-jumlah")?.addEventListener("input", recalcAmount);
  el("tx-harga")?.addEventListener("input", function () {
    this.dataset.touched = "1";
    recalcAmount();
  });

  el("tx-submit")?.addEventListener("click", async () => {
    const part = selectedPart();
    const tipe = el("tx-tipe")?.value || "";
    const idGudang = parseInt(el("tx-gudang")?.value, 10) || null;
    const jumlah = parseInt(el("tx-jumlah")?.value, 10) || 0;
    const harga = el("tx-harga")?.value === "" ? null : parseInt(el("tx-harga").value, 10);
    const tanggal = el("tx-tanggal")?.value || null;
    const keterangan = el("tx-keterangan")?.value.trim() || null;

    if (!part) { showToast("Pilih suku cadang dari daftar terlebih dahulu.", "warning"); return; }
    if (!tipe) { showToast("Status transaksi wajib dipilih.", "warning"); return; }
    if (!idGudang) { showToast("Gudang wajib dipilih.", "warning"); return; }
    if (jumlah <= 0) { showToast("Jumlah harus lebih dari nol.", "warning"); return; }

    const btn = el("tx-submit");
    if (btn) btn.disabled = true;
    try {
      const res = await apiFetch("/inventaris/stok", {
        method: "POST",
        body: JSON.stringify({
          id_part: part.id_part,
          tipe_gerakan: tipe,
          jumlah,
          id_gudang: idGudang,
          harga_satuan: harga,
          tanggal,
          keterangan,
        }),
      });
      // apiFetch only throws on 401, so a 400 (insufficient stock, bad type)
      // arrives here as a perfectly ordinary response and MUST be checked —
      // otherwise a rejected movement reports success.
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(payload.detail || "Transaksi ditolak server.", "error");
        return;
      }
      showToast(
        `${TIPE_LABEL[tipe]} ${jumlah} ${part.unit} — stok kini ${payload.stok_sekarang}.`,
        "success",
      );
      // Reset only the per-transaction fields; warehouse, type and date persist
      // so a run of entries doesn't require re-picking them every time.
      if (el("tx-part")) el("tx-part").value = "";
      if (el("tx-jumlah")) el("tx-jumlah").value = "";
      if (el("tx-keterangan")) el("tx-keterangan").value = "";
      if (el("tx-harga")) { el("tx-harga").value = ""; delete el("tx-harga").dataset.touched; }
      syncPartFields();
      await loadPartCatalog();
      loadLedger({ reset: true });
    } catch (e) {
      showToast(e.message || "Gagal mencatat transaksi.", "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // ── Running ledger ────────────────────────────────────────────────
  const LEDGER_PAGE = 50;
  let _ledgerOffset = 0;
  let _ledgerTotal = 0;

  async function loadLedger({ reset = false } = {}) {
    if (!authToken) return;
    if (reset) _ledgerOffset = 0;
    const params = new URLSearchParams({
      limit: String(LEDGER_PAGE),
      offset: String(_ledgerOffset),
    });
    const tipe = el("tx-filter-tipe")?.value;
    const gud = el("tx-filter-gudang")?.value;
    if (tipe) params.set("tipe_gerakan", tipe);
    if (gud) params.set("id_gudang", gud);
    try {
      const res = await apiFetch(`/inventaris/stok?${params}`, { background: !reset });
      if (!res.ok) return;
      const payload = await res.json();
      _ledgerTotal = payload.total || 0;
      renderLedger(payload.items || [], reset);
    } catch (e) {
      console.warn("Ledger load failed:", e);
    }
  }

  function renderLedger(items, reset) {
    const tbody = el("tx-body");
    if (!tbody) return;
    const t = KAI_VIZ.theme();

    if (reset && !items.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="text-center py-12 text-sm text-gray-400">
        <i class="fas fa-receipt text-3xl mb-2 block text-gray-300"></i>Belum ada transaksi</td></tr>`;
    } else {
      const html = items.map((r) => {
        const masuk = TIPE_MASUK.has(r.tipe_gerakan);
        const color = masuk ? t.series.in : t.series.out;
        return `
          <tr class="border-b border-gray-50 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition">
            <td class="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">${r.waktu || "—"}</td>
            <td class="px-4 py-2.5">
              <p class="text-xs font-semibold text-gray-800 dark:text-white leading-tight">${r.nama_part}</p>
              <p class="text-[10px] text-gray-400">${r.sku || ""}${r.jenis ? " · " + r.jenis : ""}</p>
            </td>
            <td class="px-4 py-2.5 whitespace-nowrap">
              <span class="inline-flex items-center gap-1.5 text-[11px] font-bold" style="color:${color}">
                <i class="fas ${masuk ? "fa-arrow-down-long" : "fa-arrow-up-long"}"></i>
                ${TIPE_LABEL[r.tipe_gerakan] || r.tipe_gerakan}
              </span>
            </td>
            <td class="px-4 py-2.5 text-right text-xs tabular-nums text-gray-700 dark:text-gray-300">
              ${masuk ? "+" : "−"}${r.jumlah} <span class="text-[10px] text-gray-400">${r.unit}</span>
            </td>
            <td class="px-4 py-2.5 text-right text-xs tabular-nums text-gray-500">${KAI_VIZ.rupiahFull(r.harga_satuan)}</td>
            <td class="px-4 py-2.5 text-right text-xs tabular-nums font-semibold text-gray-700 dark:text-gray-200">${KAI_VIZ.rupiahFull(r.amount)}</td>
            <td class="px-4 py-2.5 text-xs text-gray-500">${r.gudang}</td>
            <td class="px-4 py-2.5 text-xs text-gray-500">${r.user}</td>
            <td class="px-4 py-2.5 text-xs text-gray-400 max-w-[180px] truncate" title="${r.keterangan}">${r.keterangan}</td>
          </tr>`;
      }).join("");
      if (reset) tbody.innerHTML = html;
      else tbody.insertAdjacentHTML("beforeend", html);
    }

    _ledgerOffset += items.length;
    if (el("tx-total")) {
      el("tx-total").textContent = _ledgerTotal
        ? `menampilkan ${Math.min(_ledgerOffset, _ledgerTotal)} dari ${_ledgerTotal} transaksi`
        : "belum ada transaksi";
    }
    el("tx-more")?.classList.toggle("hidden", _ledgerOffset >= _ledgerTotal);
  }

  el("tx-more")?.addEventListener("click", () => loadLedger());
  el("tx-filter-tipe")?.addEventListener("change", () => loadLedger({ reset: true }));
  el("tx-filter-gudang")?.addEventListener("change", () => loadLedger({ reset: true }));

  // Charts bake their light/dark colors in at construction, so a theme flip
  // needs a re-render rather than a resize.
  window.addEventListener("kai-theme-change", () => {
    if (panelDash && !panelDash.classList.contains("hidden")) loadStockDashboard();
    if (panelTransaksi && !panelTransaksi.classList.contains("hidden")) loadLedger({ reset: true });
  });

  // ── Entry point ───────────────────────────────────────────────────
  // Deliberately NOT run at script-eval time: apiFetch throws without a token,
  // so booting before login left the dropdowns and dashboard silently empty.
  // switchView("inventaris") calls this instead.
  window.initInvView = async function initInvView() {
    if (!authToken) return;
    if (!_invBooted) {
      _invBooted = true;
      if (el("tx-tanggal") && !el("tx-tanggal").value) el("tx-tanggal").value = isoToday();
      await loadGudangOptions();
      setInvTab("dashboard");
      return;
    }
    // Re-entry keeps whichever tab the user left open and refreshes only that
    // one — reloading the dashboard behind a visible Parts table would spend a
    // request on a panel nobody is looking at.
    if (!panelDash?.classList.contains("hidden")) loadStockDashboard();
    else if (!panelParts?.classList.contains("hidden")) loadInvParts();
    else if (!panelTransaksi?.classList.contains("hidden")) loadLedger({ reset: true });
    else if (!panelTransfer?.classList.contains("hidden")) loadInvTransfer();
  };
  // ── Add Parts Item modal ──────────────────────────────────────────
  const addModal  = document.getElementById("inv-add-modal");
  const btnOpen   = document.getElementById("inv-btn-add-part");
  const btnClose  = document.getElementById("inv-add-modal-close");
  const btnCancel = document.getElementById("inv-add-modal-cancel");
  const btnSubmit = document.getElementById("inv-add-modal-submit");

  // Populates the two selects that used to be free-text boxes writing foreign
  // keys. Both are filled from the master data the app already caches.
  function fillAddModalRefSelects() {
    const typeSel = el("inv-field-item-type");
    if (typeSel && typeSel.options.length <= 1) {
      typeSel.innerHTML = '<option value="">— Pilih alat kerja —</option>' +
        alatKerjaData.map((a) => `<option value="${a.code}">${a.code} — ${a.name}</option>`).join("");
    }
    const locSel = el("inv-field-stored-location");
    if (locSel && locSel.options.length <= 1) {
      locSel.innerHTML = '<option value="">— Pilih lokasi —</option>' +
        lokasiData.map((l) => `<option value="${l.code}">${l.name} (${l.code})</option>`).join("");
    }
  }

  function openAddModal() {
    // Only one inventaris modal at a time — these used to be able to stack,
    // leaving two dialogs and two backdrops fighting over the same screen.
    closeCatModal();
    addModal?.classList.remove("hidden");
    fillAddModalRefSelects();
    loadInvKategoriOptions();
  }

  // "Piece" was never a stored unit; the catalogue uses Pcs/Unit. Resetting the
  // select to "" (a value no <option> carries) left the control blank.
  const UNIT_DEFAULT = "Pcs";

  function closeAddModal() {
    addModal?.classList.add("hidden");
    const fields = [
      "inv-field-sku", "inv-field-part-number", "inv-field-item-name", "inv-field-manufacturer",
      "inv-field-item-type", "inv-field-quantity", "inv-field-unit", "inv-field-cost",
      "inv-field-threshold", "inv-field-stored-location", "inv-field-auto-demand",
      "inv-field-serial", "inv-field-tag", "inv-field-critical", "inv-field-vehicle",
      "inv-field-warranty", "inv-field-supplier", "inv-field-ref-part", "inv-field-description",
      "inv-field-category"
    ];
    fields.forEach(id => {
      const node = document.getElementById(id);
      if (!node) return;
      if (node.type === "checkbox") node.checked = false;
      else if (id === "inv-field-unit") node.value = UNIT_DEFAULT;
      else node.value = "";
    });
  }

  btnOpen?.addEventListener("click",   openAddModal);
  btnClose?.addEventListener("click",  closeAddModal);
  btnCancel?.addEventListener("click", closeAddModal);
  addModal?.addEventListener("click", (e) => { if (e.target === addModal) closeAddModal(); });

  btnSubmit?.addEventListener("click", async () => {
    const itemName = document.getElementById("inv-field-item-name")?.value.trim();
    const manufacturer = document.getElementById("inv-field-manufacturer")?.value.trim() || "";
    const supplierValue = document.getElementById("inv-field-supplier")?.value.trim() || manufacturer || null;
    const storedLocation = document.getElementById("inv-field-stored-location")?.value || null;
    const body = {
      sku: document.getElementById("inv-field-sku")?.value.trim() || null,
      nama_part: itemName,
      id_kategori: parseInt(document.getElementById("inv-field-category")?.value) || null,
      kode_alat: document.getElementById("inv-field-item-type")?.value || null,
      part_number: document.getElementById("inv-field-part-number")?.value.trim() || null,
      unit: document.getElementById("inv-field-unit")?.value || "Pcs",
      harga_satuan: parseInt(document.getElementById("inv-field-cost")?.value) || null,
      stok_min: parseInt(document.getElementById("inv-field-threshold")?.value) || 0,
      auto_demand: document.getElementById("inv-field-auto-demand")?.checked || false,
      supplier: supplierValue,
      deskripsi: document.getElementById("inv-field-description")?.value.trim() || null,
      is_critical: document.getElementById("inv-field-critical")?.checked || false,
      serial_numbers: document.getElementById("inv-field-serial")?.value.trim() || null,
      lookup_tags: document.getElementById("inv-field-tag")?.value.trim() || null,
      linked_vehicle: document.getElementById("inv-field-vehicle")?.value.trim() || null,
      warranty_months: parseInt(document.getElementById("inv-field-warranty")?.value) || null,
      ref_part: document.getElementById("inv-field-ref-part")?.value.trim() || null,
      jumlah_awal: parseInt(document.getElementById("inv-field-quantity")?.value) || 0,
      id_lokasi_awal: storedLocation,
    };
    // The form marks these with an asterisk; nothing enforced them, so a blank
    // submit produced an unnamed, uncategorised, zero-cost part.
    const missing = [];
    if (!body.nama_part) missing.push("Nama Barang");
    if (!body.id_kategori) missing.push("Kategori");
    if (body.harga_satuan === null) missing.push("Harga Satuan");
    if (missing.length) {
      showToast(`Lengkapi dulu: ${missing.join(", ")}.`, "warning");
      return;
    }
    try {
      const res = await apiFetch("/inventaris/parts", { method: "POST", body: JSON.stringify(body) });
      // apiFetch only THROWS on 401. A 400 (duplicate SKU, bad FK) or a 403
      // arrives here as an ordinary response, so without this check every
      // rejected submit still reported success and closed the form.
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(payload.detail || "Gagal menambahkan part.", "error");
        return;
      }
      showToast("Part berhasil ditambahkan.", "success");
      closeAddModal();
      if (!panelParts.classList.contains("hidden")) loadInvParts();
    } catch (e) {
      showToast(e.message || "Gagal menambahkan part.", "error");
    }
  });

  // Category names are seeded as "SUBSISTEM – ALAT" ("ENGINE – HTT 220 V"), and
  // the dropdown used to prefix the subsistem a second time, rendering
  // "[ENGINE] ENGINE – HTT 220 V". `nama` is UNIQUE in the database, so the
  // safe place to fix it is here rather than by rewriting stored names.
  function _kategoriLabel(c) {
    const nama = (c.nama || "").trim();
    const sub = (c.subsistem || "").trim();
    if (!sub) return nama;
    // Already carries its subsistem — show the stored name unchanged.
    if (nama.toUpperCase().startsWith(sub.toUpperCase())) return nama;
    return `[${sub}] ${nama}`;
  }

  // ── Load kategori for dropdown ────────────────────────────────────
  async function loadInvKategoriOptions() {
    try {
      const res = await apiFetch("/inventaris/kategori");
      if (!res.ok) return;
      const data = await res.json();
      _categories = data;
      const sel  = document.getElementById("inv-field-category");
      if (sel) {
        sel.innerHTML = '<option value="">— Pilih Kategori —</option>' +
          data.map(c => `<option value="${c.id_kategori}">${_kategoriLabel(c)}</option>`).join("");
      }
      // Also sync in category modal list
      renderCategories();
    } catch (_) { /* silent */ }
  }

  // ── Parts Category modal ──────────────────────────────────────────
  const catModal   = document.getElementById("inv-category-modal");
  const btnCatOpen  = document.getElementById("inv-btn-parts-category");
  const btnCatOpenShortcut = document.getElementById("inv-btn-open-category-modal");
  const btnCatClose = document.getElementById("inv-category-modal-close");
  const btnCatDone  = document.getElementById("inv-category-modal-close-btn");
  const catInput    = document.getElementById("inv-category-input");
  const catAddBtn   = document.getElementById("inv-category-add-btn");
  const catList     = document.getElementById("inv-category-list");

  function openCatModal() {
    // Never stack the two inventaris dialogs — see openAddModal().
    addModal?.classList.add("hidden");
    catModal?.classList.remove("hidden");
    fillCategoryAlatSelect();
    loadInvKategoriOptions();
  }

  function fillCategoryAlatSelect() {
    const sel = el("inv-category-alat");
    if (sel && sel.options.length <= 1) {
      sel.innerHTML = '<option value="">— Semua alat kerja —</option>' +
        alatKerjaData.map((a) => `<option value="${a.code}">${a.code} — ${a.name}</option>`).join("");
    }
  }
  function closeCatModal() { catModal?.classList.add("hidden"); }

  btnCatOpen?.addEventListener("click",  openCatModal);
  btnCatOpenShortcut?.addEventListener("click", openCatModal);
  btnCatClose?.addEventListener("click", closeCatModal);
  btnCatDone?.addEventListener("click",  closeCatModal);
  catModal?.addEventListener("click", (e) => { if (e.target === catModal) closeCatModal(); });

  function renderCategories() {
    if (!catList) return;
    if (_categories.length === 0) {
      catList.innerHTML = '<li class="text-sm text-gray-400 italic py-2 text-center">Belum ada kategori.</li>';
    } else {
      catList.innerHTML = _categories.map(c => `
        <li class="flex items-center justify-between px-3 py-2 rounded-lg bg-white dark:bg-gray-700 border border-gray-100 dark:border-gray-600">
          <div>
            <span class="text-sm text-gray-700 dark:text-gray-200 font-medium">${_kategoriLabel(c)}</span>
            ${c.subsistem ? `<span class="ml-2 text-[10px] bg-gray-100 dark:bg-gray-600 text-gray-500 dark:text-gray-300 px-1.5 py-0.5 rounded">${c.subsistem}</span>` : ""}
          </div>
          <button data-id="${c.id_kategori}" class="inv-cat-delete text-gray-300 hover:text-red-400 transition text-xs">
            <i class="fas fa-times"></i>
          </button>
        </li>`).join("");
    }
    catList.querySelectorAll(".inv-cat-delete").forEach(btn => {
      btn.addEventListener("click", async () => {
        try {
          const res = await apiFetch(`/inventaris/kategori/${btn.dataset.id}`, { method: "DELETE" });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            showToast(payload.detail || "Gagal menghapus kategori.", "error");
            return;
          }
          showToast("Kategori dihapus.", "success");
          loadInvKategoriOptions();
        } catch (e) {
          showToast(e.message || "Gagal menghapus.", "error");
        }
      });
    });
  }

  catAddBtn?.addEventListener("click", async () => {
    const val = catInput?.value.trim();
    if (!val) { showToast("Nama kategori wajib diisi.", "warning"); return; }
    try {
      const res = await apiFetch("/inventaris/kategori", {
        method: "POST",
        body: JSON.stringify({
          nama: val,
          subsistem: el("inv-category-subsistem")?.value || null,
          kode_alat: el("inv-category-alat")?.value || null,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      // A duplicate name is a 400, and apiFetch only throws on 401 — so this
      // used to show a green "Kategori ditambahkan" for a rejected insert.
      if (!res.ok) {
        showToast(payload.detail || "Gagal menambahkan kategori.", "error");
        return;
      }
      if (catInput) catInput.value = "";
      if (el("inv-category-subsistem")) el("inv-category-subsistem").value = "";
      if (el("inv-category-alat")) el("inv-category-alat").value = "";
      showToast("Kategori ditambahkan.", "success");
      loadInvKategoriOptions();
    } catch (e) {
      showToast(e.message || "Gagal menambahkan kategori.", "error");
    }
  });
  catInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") catAddBtn?.click(); });

  // ── Load & render Parts table ──────────────────────────────────────
  // The last payload is cached so search can filter the DATA. The previous
  // implementation walked DOM rows setting `style.display`, which only ever saw
  // the rows currently in the table — with paging that means only the current
  // page, so a match on page 3 was invisible.
  let _partsRows = [];

  async function loadInvParts() {
    // Stock is pooled across every warehouse unless one is picked on the Dasbor
    // Inventaris tab, which is the single place the scope is chosen.
    const params = new URLSearchParams();
    if (_gudangFilter) params.set("id_gudang", _gudangFilter);
    try {
      const res = await apiFetch(`/inventaris/parts?${params}`);
      if (!res.ok) return;
      _partsRows = await res.json();
      renderInvPartsTable();
    } catch (e) {
      console.warn("Parts load failed:", e);
    }
  }

  function _filteredParts() {
    const q = (searchInput?.value || "").trim().toLowerCase();
    if (!q) return _partsRows;
    return _partsRows.filter((p) =>
      [p.nama_part, p.sku, p.part_number, p.subsistem, p.nama_alat,
       p.kode_alat, p.supplier, p.status_stok, p.deskripsi]
        .some((v) => (v ?? "").toString().toLowerCase().includes(q)),
    );
  }

  // Items Master row. Movement columns are lifetime ledger totals; the date
  // range on the Dasbor Inventaris tab windows the dashboard, not this table.
  function renderInvPartsTable() {
    const tbody = document.getElementById("inv-parts-body");
    if (!tbody) return;
    const rows = _filteredParts();

    if (rows.length === 0) {
      renderPagerBar("inv-parts-pager", paginateList("parts", rows), renderInvPartsTable);
      tbody.innerHTML = `<tr><td colspan="16" class="text-center py-12 text-sm text-gray-400">
        <i class="fas fa-box-open text-3xl mb-2 block text-gray-300"></i>Tidak ada data</td></tr>`;
      return;
    }
    const t = KAI_VIZ.theme();
    const num = (n) => Number(n || 0).toLocaleString("id-ID");

    const page = paginateList("parts", rows);
    renderPagerBar("inv-parts-pager", page, renderInvPartsTable);

    tbody.innerHTML = page.items.map(p => {
      const meta = STOK_STATUS_META.find((m) => m.key === p.status_stok);
      const statusColor = bandTone(t, meta?.band);
      const isProblem = meta && meta.band !== "aman" && meta.band !== "atasmax";
      const rowCls = isProblem
        ? "bg-red-50/40 dark:bg-red-900/10"
        : "hover:bg-gray-50 dark:hover:bg-gray-700/30";
      const retur = (p.retur_vendor || 0) + (p.retur_customer || 0);
      const adj = (p.penyesuaian_masuk || 0) - (p.penyesuaian_keluar || 0);
      // Never issued reads as "belum pernah" rather than 0 days, so an untouched
      // part is not mistaken for one that moved today.
      const idle = p.hari_tidak_bergerak === null || p.hari_tidak_bergerak === undefined
        ? '<span class="text-gray-300 dark:text-gray-600">—</span>'
        : `${num(p.hari_tidak_bergerak)} hari`;

      return `<tr class="${rowCls} border-b border-gray-50 dark:border-gray-700/50 transition">
        <td class="px-3 py-2.5 whitespace-nowrap">
          <button class="inv-part-delete text-gray-300 hover:text-red-400 transition" data-id="${p.id_part}" title="Hapus">
            <i class="fas fa-trash-alt text-xs"></i>
          </button>
        </td>
        <td class="px-3 py-2.5 min-w-[180px]">
          <p class="font-semibold text-gray-800 dark:text-white text-xs leading-tight">${p.nama_part}</p>
          <p class="text-[10px] text-gray-400">${p.sku}${p.part_number ? " · " + p.part_number : ""}</p>
        </td>
        <td class="px-3 py-2.5 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">${p.subsistem || "—"}</td>
        <td class="px-3 py-2.5 text-xs text-gray-600 dark:text-gray-300 whitespace-nowrap">${p.nama_alat || p.kode_alat || "—"}</td>
        <td class="px-3 py-2.5 text-xs text-right tabular-nums text-gray-600 dark:text-gray-300 whitespace-nowrap" title="${KAI_VIZ.rupiahFull(p.map)}">${p.map ? KAI_VIZ.rupiah(p.map) : "—"}</td>
        <td class="px-3 py-2.5 text-xs text-right tabular-nums text-gray-600 dark:text-gray-300">${num(p.masuk)}</td>
        <td class="px-3 py-2.5 text-xs text-right tabular-nums text-gray-600 dark:text-gray-300">${num(p.keluar)}</td>
        <td class="px-3 py-2.5 text-xs text-right tabular-nums text-gray-500 dark:text-gray-400" title="Ke vendor ${num(p.retur_vendor)} · Dari customer ${num(p.retur_customer)}">${num(retur)}</td>
        <td class="px-3 py-2.5 text-xs text-right tabular-nums text-gray-500 dark:text-gray-400" title="Masuk ${num(p.penyesuaian_masuk)} · Keluar ${num(p.penyesuaian_keluar)}">${adj > 0 ? "+" : ""}${num(adj)}</td>
        <td class="px-3 py-2.5 text-right whitespace-nowrap">
          <span class="text-sm font-bold tabular-nums" style="color:${statusColor}">${num(p.stok_sekarang)}</span>
          <span class="text-[10px] text-gray-400 ml-0.5">${p.unit}</span>
        </td>
        <td class="px-3 py-2.5 text-xs text-right tabular-nums text-gray-400">${num(p.stok_min)}</td>
        <td class="px-3 py-2.5 text-xs text-right tabular-nums font-semibold text-gray-700 dark:text-gray-200 whitespace-nowrap" title="${KAI_VIZ.rupiahFull(p.nilai_inventory)}">${KAI_VIZ.rupiah(p.nilai_inventory)}</td>
        <td class="px-3 py-2.5 whitespace-nowrap">
          <span class="inline-flex items-center gap-1.5 text-[11px] font-bold" style="color:${statusColor}">
            <i class="fas ${meta?.icon || "fa-circle-question"}"></i>${meta?.label || p.status_stok || "—"}
          </span>
        </td>
        <td class="px-3 py-2.5 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">${p.tanggal_terakhir_keluar || "—"}</td>
        <td class="px-3 py-2.5 text-xs text-right tabular-nums text-gray-500 dark:text-gray-400 whitespace-nowrap">${idle}</td>
        <td class="px-3 py-2.5 text-xs text-gray-500 dark:text-gray-400 max-w-[140px] truncate" title="${p.supplier || ""}">${p.supplier || "—"}</td>
      </tr>`;
    }).join("");

    // Delete handlers
    tbody.querySelectorAll(".inv-part-delete").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Hapus part ini?")) return;
        try {
          const res = await apiFetch(`/inventaris/parts/${btn.dataset.id}`, { method: "DELETE" });
          const payload = await res.json().catch(() => ({}));
          // Same success-on-failure trap: a part with stock history comes back
          // as a 400, which apiFetch does not throw on.
          if (!res.ok) {
            showToast(payload.detail || "Gagal menghapus part.", "error");
            return;
          }
          showToast("Part dihapus.", "success");
          loadInvParts();
        } catch (e) { showToast(e.message || "Gagal menghapus part.", "error"); }
      });
    });
  }

  // Load parts when switching to Parts tab
  // Tab activation is handled centrally in setInvTab() — no per-tab listener
  // here, or switching to Parts would fire two identical fetches.

  // ── Unified search ────────────────────────────────────────────────
  // Filters the DATA and re-renders, rather than hiding DOM rows: a row-hiding
  // search can only ever match what is currently in the table, so with paging
  // it silently ignores every other page.
  searchInput?.addEventListener("input", function () {
    if (!panelParts?.classList.contains("hidden")) {
      resetPage("parts");
      renderInvPartsTable();
    } else if (!panelTransfer?.classList.contains("hidden")) {
      resetPage("transfer");
      renderInvTransferTable();
    }
  });

  // ── Transfer history loader ────────────────────────────────────────
  let _transferRows = [];

  async function loadInvTransfer() {
    const params = new URLSearchParams();
    try {
      const res = await apiFetch(`/inventaris/transfer?${params}`);
      if (!res.ok) return;
      // Server-paged envelope: { total, limit, offset, items }.
      const payload = await res.json();
      _transferRows = Array.isArray(payload) ? payload : payload.items || [];
      renderInvTransferTable();
    } catch (e) { console.warn("Transfer load failed:", e); }
  }

  function renderInvTransferTable() {
    const tbody = document.getElementById("inv-transfer-body");
    if (!tbody) return;
    const q = (searchInput?.value || "").trim().toLowerCase();
    const data = q
      ? _transferRows.filter((r) =>
          [r.nama_part, r.nama_alat, r.site_from, r.site_to,
           r.transfer_by, r.transfer_to, r.catatan, r.waktu]
            .some((v) => (v ?? "").toString().toLowerCase().includes(q)))
      : _transferRows;

    if (data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" class="text-center py-12 text-sm text-gray-400">
        <i class="fas fa-exchange-alt text-3xl mb-2 block text-gray-300"></i>Tidak ada data</td></tr>`;
      return;
    }
    tbody.innerHTML = data.map(r => `
        <tr class="border-b border-gray-50 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition">
          <td class="px-4 py-2.5 text-xs text-gray-500">${r.waktu || "—"}</td>
          <td class="px-4 py-2.5 text-xs font-medium text-gray-800 dark:text-white">${r.nama_part}</td>
          <td class="px-4 py-2.5 text-xs text-gray-600">${r.jumlah} ${r.unit}</td>
          <td class="px-4 py-2.5 text-xs text-gray-500">${r.nama_alat || "—"}</td>
          <td class="px-4 py-2.5 text-xs text-gray-600">${r.site_from}</td>
          <td class="px-4 py-2.5 text-xs text-gray-600">${r.site_to}</td>
          <td class="px-4 py-2.5 text-xs text-gray-500">${r.transfer_by}</td>
          <td class="px-4 py-2.5 text-xs text-gray-500">${r.transfer_to}</td>
          <td class="px-4 py-2.5 text-xs text-gray-400">${r.catatan}</td>
        </tr>`).join("");
  }

  // WebSocket refresh — only the visible panel, so a stock movement logged by
  // another user doesn't trigger four fetches on every connected client.
  window.addEventListener("ws-message", (e) => {
    if (e.detail !== "REFRESH_INVENTARIS") return;
    if (!panelDash?.classList.contains("hidden")) loadStockDashboard();
    if (!panelParts?.classList.contains("hidden")) loadInvParts();
    if (!panelTransaksi?.classList.contains("hidden")) {
      loadPartCatalog();
      loadLedger({ reset: true });
    }
    if (!panelTransfer?.classList.contains("hidden")) loadInvTransfer();
  });

})();
