// ═══════════════════════════════════════════════════════════════════════
// Shared foundation: global state, the lokasi parent rule, JWT and
// profile, the loading overlay, the sidebar, the paginator, toasts,
// date formatters, on-demand script loading, and the KAI_VIZ chart
// theme. Everything here is used by three or more of the files below.
//
// Part of the RAMCES frontend. These files are plain classic scripts
// loaded in a fixed order by index.html - no bundler, no modules. They
// share one global scope, so a top-level `let` or `const` declared twice
// across two files is a fatal SyntaxError; see CLAUDE.md.
// ═══════════════════════════════════════════════════════════════════════

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

// Theme resolution, in priority order: the user's own choice (persisted by the
// Ganti Tema button) wins; with no stored choice, follow the operating system.
// It previously defaulted to light regardless, so a user whose machine is in
// dark mode got a full-brightness page on every first visit and had to toggle.
// An explicit "light" is still honoured on a dark OS — that is the whole point
// of storing it.
(function () {
  const saved = localStorage.getItem("theme");
  const prefersDark =
    window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = saved ? saved === "dark" : prefersDark;
  document.documentElement.classList.toggle("dark", dark);

  // Follow the OS if it changes while the tab is open, but only for users who
  // have never expressed a preference.
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.(
    "change",
    (e) => {
      if (localStorage.getItem("theme")) return;
      document.documentElement.classList.toggle("dark", e.matches);
      window.dispatchEvent(new Event("kai-theme-change"));
    },
  );
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
      <!-- flex-wrap matters on phones: with enough pages this row used to run
           past the viewport and the later page buttons were unreachable, since
           nothing in the chain scrolls horizontally. ml-auto only from sm: up,
           so the wrapped rows stay left-aligned instead of ragged. -->
      <div class="flex flex-wrap items-center gap-1.5 sm:ml-auto">
        ${btn('<i class="fas fa-angle-double-left"></i>', 1, { disabled: meta.page === 1, title: "Halaman pertama" })}
        ${btn('<i class="fas fa-angle-left"></i>', meta.page - 1, { disabled: meta.page === 1, title: "Sebelumnya" })}
        ${nums.map((n) => btn(String(n), n, { active: n === meta.page })).join("")}
        ${btn('<i class="fas fa-angle-right"></i>', meta.page + 1, { disabled: meta.page === meta.pages, title: "Berikutnya" })}
        ${btn('<i class="fas fa-angle-double-right"></i>', meta.pages, { disabled: meta.page === meta.pages, title: "Halaman terakhir" })}
      </div>
      <div class="flex items-center gap-2">
        <label class="text-[10px] font-bold tracking-widest text-gray-400 uppercase" for="${mountId}-size">Per Halaman</label>
        <select id="${mountId}-size" aria-label="Jumlah baris per halaman" class="pager-size text-[11px] px-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 outline-none focus:border-kai-blue transition font-semibold cursor-pointer">
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

const _scriptLoadPromises = new Map();

/**
 * Load a script once, returning the same promise for every later caller.
 *
 * Previously this deleted its own cache entry in `onload`, so the second call
 * built a fresh promise, found the tag already in the DOM, and resolved
 * immediately — which happened to work but meant a call racing the first load
 * could resolve before the library existed. The promise is now kept forever on
 * success (that is the whole point of the cache) and only evicted on failure,
 * so a transient network error can be retried.
 */
function loadScript(src) {
  if (_scriptLoadPromises.has(src)) return _scriptLoadPromises.get(src);

  const promise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      _scriptLoadPromises.delete(src);
      reject(new Error(`Gagal memuat pustaka: ${src}`));
    };
    document.head.appendChild(s);
  });

  _scriptLoadPromises.set(src, promise);
  return promise;
}

// ── On-demand libraries ────────────────────────────────────────────────────
//
// SheetJS (~900 KB) and jsPDF + autotable (~440 KB) used to load in <head> on
// every page view, blocking first paint, despite only ever being used on the
// Laporan view, the bulk importers and the QR-to-PDF button. Together they were
// most of the ~2 MB of blocking script the app shipped on login.
//
// Each helper resolves immediately once its library is present, so the many
// synchronous XLSX.* call sites downstream need no change — only the entry
// points that reach them have to await.
const _CDN = {
  xlsx: "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
  jspdf: "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
  autotable:
    "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js",
};

/** Ensure SheetJS is available. Returns false (and warns the user) on failure. */
async function ensureXLSX() {
  if (window.XLSX) return true;
  try {
    await loadScript(_CDN.xlsx);
    return !!window.XLSX;
  } catch (e) {
    showToast("Pustaka Excel gagal dimuat. Periksa koneksi internet.", "error");
    return false;
  }
}

/** Ensure jsPDF *and* the autotable plugin are available, in that order. */
async function ensureJsPDF() {
  if (window.jspdf && window.jspdf.jsPDF?.API?.autoTable) return true;
  try {
    await loadScript(_CDN.jspdf);
    // autotable patches jsPDF's prototype, so it must load after it.
    await loadScript(_CDN.autotable);
    return !!window.jspdf;
  } catch (e) {
    showToast("Pustaka PDF gagal dimuat. Periksa koneksi internet.", "error");
    return false;
  }
}

window.ensureXLSX = ensureXLSX;
window.ensureJsPDF = ensureJsPDF;

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
