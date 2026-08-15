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

let _currentRole = ""; // one of ROLE_ORDER below

// ══════════════════════════════════════════════════════════════════════
// Role access — declarative, and the ONLY description of who sees what
// ══════════════════════════════════════════════════════════════════════
//
// `checkAuth()` used to gate FOUR elements by hand. That left two holes, and
// they were holes in the UI rather than in security — the server answers 403
// behind every one of them — but a menu that contradicts the permissions is its
// own kind of broken:
//
//   * `switchView()` had no role check at all, and 34 `onclick=` handlers built
//     inside template strings call it directly. Hiding a sidebar button does
//     nothing about a card link that jumps to the same view.
//   * `#mobile-bottom-nav` was never gated, so on a phone every role got the
//     full five slots.
//
// Three tables replace the four lines. Everything reads from them, so adding a
// role means editing here and nowhere else.
//
// ⚠️ These are a CONVENIENCE, not a control. The enforcement is
// `require_role([...])` plus `assert_*_region_scope()` on the server, and it
// stays that way: the token is in sessionStorage and its payload is read
// client-side, so anything decided here can be edited by the person it applies
// to.

const ROLE_ORDER = [
  "SUPER_ADMIN",
  "ADMIN_WILAYAH",
  "PETUGAS_GUDANG",
  "TEKNISI",
  "PIMPINAN",
];

// Views every role may open. `r` in the client's matrix means read-only: the
// view opens, and WRITE_ACCESS below decides whether its buttons appear.
const VIEW_ACCESS = {
  dashboard:  ROLE_ORDER,
  input:      ["SUPER_ADMIN", "ADMIN_WILAYAH"],
  inventaris: ROLE_ORDER,
  database:   ROLE_ORDER,
  history:    ROLE_ORDER,
  laporan:    ["SUPER_ADMIN", "ADMIN_WILAYAH", "PETUGAS_GUDANG", "PIMPINAN"],
  masterdata: ["SUPER_ADMIN"],
  afkir:      ["SUPER_ADMIN"],
  // Drill-downs reached from a row, never from a nav button. They inherit the
  // access of the list that leads to them; check_html.py exempts both from its
  // "every view is reachable from a data-view button" rule for the same reason.
  edit:            ROLE_ORDER,
  "history-detail": ROLE_ORDER,
};

// Who may WRITE in each area. A role absent here gets the view without its
// create/edit/delete controls — which must be hidden AND 403 behind, never one
// or the other.
const WRITE_ACCESS = {
  aset:       ["SUPER_ADMIN", "ADMIN_WILAYAH"],
  // Who may register a PUSAT-procured asset. The client's matrix: "admin daerah
  // hanya input pengadaan 2". An allow-list rather than an ADMIN_WILAYAH
  // exclusion, so a role added later is denied by default instead of silently
  // inheriting the permission. Enforced server-side by assert_pengadaan_scope().
  aset_pusat: ["SUPER_ADMIN"],
  inventaris: ["SUPER_ADMIN", "ADMIN_WILAYAH", "PETUGAS_GUDANG"],
  // Condition reporting is deliberately UNSCOPED for TEKNISI — reporting a
  // machine as broken is the one thing a technician does standing next to it,
  // and a region check there would block the report rather than the mistake.
  kondisi:    ["SUPER_ADMIN", "ADMIN_WILAYAH", "TEKNISI"],
  masterdata: ["SUPER_ADMIN"],
};

// Sidebar / bottom-nav element ids → the view they open. Ids that do not exist
// are skipped, so this may safely name a button a future layout adds.
const NAV_ACCESS = {
  "nav-input": "input",
  "nav-masterdata": "masterdata",
  "nav-afkir": "afkir",
};

/** True when `role` may open `viewId`. Unknown views are allowed — a view with
 *  no entry is not yet gated, and silently hiding it would be worse. */
function canView(viewId, role = _currentRole) {
  const allowed = VIEW_ACCESS[viewId];
  return !allowed || allowed.includes(role);
}

/** True when `role` may write in `area`. Unknown areas are DENIED — a typo here
 *  must not quietly grant a button. */
function canWrite(area, role = _currentRole) {
  return (WRITE_ACCESS[area] || []).includes(role);
}

window.canView = canView;
window.canWrite = canWrite;
window.VIEW_ACCESS = VIEW_ACCESS;
window.WRITE_ACCESS = WRITE_ACCESS;
window.NAV_ACCESS = NAV_ACCESS;
window.ROLE_ORDER = ROLE_ORDER;
let _wsNgrokFailed = false;
let _wsRetryCount = 0;

let db = []; // Menampung data tabel aset

let activeHistoryUid = null;
let currentUser = sessionStorage.getItem("activeUser");
let authToken = sessionStorage.getItem("authToken");

// Track the QR currently shown in the modal (for export)
let _qrActiveItem = null;

// ── The peruntukan rule, on the client ──────────────────────────────────
//
// A resort code's PREFIX is its peruntukan, verified 1:1 across all 254 rows of
// the client's KATALOG UPT: JR → JALAN REL, JB → JEMBATAN, ME → MEKANIK, and
// BY is a Balaiyasa workshop rather than an operating unit. The server derives
// an imported asset's peruntukan exactly this way.
//
// Keep in step with `UPT_PREFIX_TO_LETTER` in seeds/dummy.py and with
// `normalise_peruntukan()` in api/deps.py.
const UPT_PREFIX_BY_PERUNTUKAN = {
  A: "JR", // JALAN REL
  B: "JB", // JEMBATAN
  C: "ME", // MEKANIK
  D: "BY", // BALAIYASA
};

const PERUNTUKAN_LABEL = {
  A: "JALAN REL",
  B: "JEMBATAN",
  C: "MEKANIK",
  D: "BALAIYASA",
};

/** The peruntukan letter for a stored value, or "" when it is not one of the four. */
function peruntukanLetter(value) {
  const v = String(value || "").trim().toUpperCase();
  if (UPT_PREFIX_BY_PERUNTUKAN[v]) return v; // already a letter
  const hit = Object.entries(PERUNTUKAN_LABEL).find(([, label]) => label === v);
  return hit ? hit[0] : "";
}

/**
 * Fill a UPT `<select>` with the resorts under `locCode`.
 *
 * `peruntukan` (a letter or a label, either is accepted) narrows the list to
 * the resorts that can actually hold such an asset. Omitting it keeps the old
 * unfiltered behaviour, which is what the Kalibrasi and Mutasi forms want —
 * they pick where a machine IS, not what it is for.
 *
 * ── Why the filter exists ──
 *
 * With JALAN REL + DAOP 1 selected, this offered 31 options: 25 JR, 4 JB and
 * 2 ME. Choosing any of the six wrong ones produced an asset whose id_aset
 * peruntukan segment contradicted the resort named in the same id — and since
 * the importer started deriving peruntukan from the resort prefix, that is a
 * contradiction the system can no longer produce any other way.
 */
function applyUptSelect(locCode, uptSelectEl, peruntukan) {
  if (!uptSelectEl) return;
  const loc = lokasiData.find((l) => l.code === locCode);
  const isBalaiyasa = loc?.tipe?.toUpperCase() === "BALAIYASA";

  if (isBalaiyasa) {
    uptSelectEl.innerHTML = `<option value="">Belum ada UPT untuk lokasi Balaiyasa</option>`;
    uptSelectEl.disabled = true;
    return;
  }

  uptSelectEl.disabled = false;
  let matches = uptDatabase.filter((u) => u.lokasi === locCode);

  const letter = peruntukanLetter(peruntukan);
  const prefix = UPT_PREFIX_BY_PERUNTUKAN[letter];
  if (prefix) {
    matches = matches.filter((m) =>
      String(m.upt || "").toUpperCase().startsWith(prefix),
    );
  }

  if (matches.length > 0) {
    uptSelectEl.innerHTML =
      '<option value="">Pilih UPT...</option>' +
      matches.map((m) => `<option value="${m.upt}">${m.nama || m.upt}</option>`).join("");
  } else if (prefix) {
    // A real empty state rather than an empty dropdown. MEKANIK + a DAOP with
    // no ME* resort is an ordinary combination, and a box that silently offers
    // nothing reads as a broken form rather than as an answer.
    uptSelectEl.innerHTML =
      `<option value="">Tidak ada UPT ${PERUNTUKAN_LABEL[letter]} di lokasi ini</option>`;
    uptSelectEl.disabled = true;
  } else {
    uptSelectEl.innerHTML = `<option value="">Tidak ada UPT untuk lokasi ini...</option>`;
    uptSelectEl.disabled = true;
  }
  uptSelectEl.value = "";
}

window.applyUptSelect = applyUptSelect;
window.peruntukanLetter = peruntukanLetter;

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
  // No master-data fetch before login any more: the login screen asks only for
  // a username and a password, so there is nothing on it to populate.

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
  // "JR1.3" → "D1", "JB1.1" → "D1", "JR9.2" → "D9"
  //
  // `J[RB]`, not `JR`: the resort tree has two branches — JR (jalan rel) and
  // JB (jembatan) — and only JR was matched here, so every jembatan resort
  // resolved to no parent and its assets fell outside every regional filter.
  // Byte-identical to _RE_UPT_ARAB in main.py and seed.py.
  const arabMatch = idLokasi.match(/^J[RB]\s*(\d+)\./i);
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
  // Dot optional: the katalog's "JBII" (JB II Padang) has no sub-number.
  const romanMatch = idLokasi.match(
    /^J[RB]\s*(IV|IX|VIII|VII|VI|V|I{1,3})(?:\.|$)/i,
  );
  if (romanMatch) return romanMap[romanMatch[1].toUpperCase()] ?? null;

  // "ME1.1" → "D1", "ME2" → "D2", "MEIII" → "VIII". The THIRD branch of the
  // resort tree — 14 MEKANIK resorts that RAMCES had no rows for at all until
  // rev0.5.2, the same hole JB was in.
  //
  // THE `$` ANCHOR IS LOAD-BEARING. Alternation is leftmost-first, not
  // longest-first, so `I{1,3}` is tried before `IV`. With the anchor "MEIV"
  // backtracks to the right branch; without it, it matches `I` and returns VI,
  // putting MEKANIK DIVRE IV's assets silently in DIVRE I.
  //
  // Byte-identical to _RE_UPT_MEKANIK_* in api/deps.py, seeds/katalog.py and
  // landing.html. All four must stay in step.
  const mekArabMatch = idLokasi.match(/^ME\s*(\d+)(?:\.\d+)?$/i);
  if (mekArabMatch) return `D${mekArabMatch[1]}`;
  const mekRomanMatch = idLokasi.match(/^ME\s*(IV|IX|VIII|VII|VI|V|I{1,3})$/i);
  if (mekRomanMatch) return romanMap[mekRomanMatch[1].toUpperCase()] ?? null;

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

// ══════════════════════════════════════════════════════════════════════════
// SKELETON PLACEHOLDERS
// ══════════════════════════════════════════════════════════════════════════
//
// `beginLoading()` puts a full-screen overlay up for EVERY apiFetch, which for
// a list refresh is heavier than the change deserves: the screen blanks, the
// scroll position is lost, and the user cannot see what is being replaced.
//
// These paint an in-place placeholder instead. The caller pairs them with
// `apiFetch(..., { background: true })` — the escape hatch api.js already
// documents — so the overlay stays for the things it is actually right for:
// login, the paged fleet bootstrap, and destructive submits.
//
// `aria-busy` is the part that matters for assistive tech; a shimmer conveys
// nothing to a screen reader.

/**
 * Fill a <tbody> with placeholder rows.
 * `cols` must match the table's real column count or the layout jumps when the
 * data lands.
 */
function skeletonRows(tbodyId, cols, rows = 5) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  tbody.setAttribute("aria-busy", "true");
  // Widths vary so a block of rows does not read as a solid rectangle.
  const widths = ["70%", "45%", "85%", "55%", "65%", "40%"];
  tbody.innerHTML = Array.from({ length: rows })
    .map(
      (_, r) =>
        `<tr>${Array.from({ length: cols })
          .map(
            (__, c) =>
              `<td class="px-4 py-3"><span class="skeleton skeleton-text" style="width:${
                widths[(r + c) % widths.length]
              }"></span></td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
}

/** Fill a grid/list container with placeholder cards. */
function skeletonCards(containerId, count = 6) {
  const box = document.getElementById(containerId);
  if (!box) return;
  box.setAttribute("aria-busy", "true");
  box.innerHTML = Array.from({ length: count })
    .map(
      () =>
        `<div class="card"><div class="card-body">
           <span class="skeleton skeleton-text-lg" style="width:55%"></span>
           <span class="skeleton skeleton-text" style="width:80%"></span>
           <span class="skeleton skeleton-text-sm" style="width:40%"></span>
         </div></div>`,
    )
    .join("");
}

// `skeletonDone(id)` lived here and had no callers — it was the manual version
// of what the observer below does automatically, and the comment explaining why
// the observer exists was already sitting directly underneath it.
//
// Clearing `aria-busy` by hand means finding every success path in every
// loader, and the one that gets forgotten leaves a container permanently
// announced as loading. Watch instead: when an element marked busy no longer
// contains a `.skeleton`, its real content has landed.
//
// Same approach as stampTableLabels() below, and for the same reason — the
// rows are built from template strings in nine different files.
(function watchSkeletons() {
  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      const el = rec.target.closest?.("[aria-busy='true']");
      if (el && !el.querySelector(".skeleton")) el.removeAttribute("aria-busy");
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();

// ══════════════════════════════════════════════════════════════════════════
// SEGMENTED CONTROL
// ══════════════════════════════════════════════════════════════════════════
//
// Three mode switches in this app were the same control drawn three different
// ways. Two of them — Pantau Riwayat's and the asset detail's — each carried
// six hand-maintained Tailwind class arrays and a ~30-line function to swap
// them, in near-identical copies that had already drifted apart.
//
// `.segmented` / `.segmented-btn` / `.is-active` in assets/style.css owns the
// appearance now, so switching a tab is one class and one aria attribute.
//
// `ids` is the full set of button ids in the group; `activeId` the one to mark.
function setSegmented(ids, activeId) {
  ids.forEach((id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    const on = id === activeId;
    btn.classList.toggle("is-active", on);
    // role="tab" is on the markup, so keep the state that goes with it: a
    // screen reader otherwise reads three tabs with no indication which is open.
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
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

// Update the overlay's caption without touching the request counter. Used by
// the paged bootstrap in js/api.js to count "1.000 / 1.121" up as pages land,
// so a multi-second fleet load reads as progress rather than as a hang.
function setLoadingMessage(detail) {
  const d = document.getElementById("global-loading-detail");
  if (d) d.textContent = detail || "";
}
window.setLoadingMessage = setLoadingMessage;

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

/**
 * The app's only confirmation dialog.
 *
 * Two call shapes, and the string one is unchanged:
 *
 *     await customConfirm("Hapus aset ini?")
 *     await customConfirm({ title, message, confirmText, danger, html })
 *
 * `html: true` renders `message` as markup instead of text, which lets a
 * caller put a couple of `<select>`s in the body — approving a registration
 * needs a role and a region chosen at the moment of approval, and a second
 * bespoke modal for one two-field question is how a codebase ends up with
 * five dialogs that behave differently. It is opt-in precisely because
 * `innerText` is the safe default and every other caller wants it.
 *
 * ⚠️ The promise resolves from the BUTTON HANDLERS, and js/a11y-modal.js
 * depends on that: Esc closes this dialog through its own close control rather
 * than by setting `hidden`, because hiding the panel behind this function's
 * back would leave every awaiting caller hanging forever.
 */
function customConfirm(message) {
  const opts = typeof message === "string" ? { message } : message || {};
  return new Promise((resolve) => {
    const modal = document.getElementById("confirm-modal");
    if (!modal) return resolve(window.confirm(opts.message || ""));

    const cancelBtn = document.getElementById("confirm-cancel");
    const okBtn = document.getElementById("confirm-ok");
    const titleEl = document.getElementById("confirm-title");
    const bodyEl = document.getElementById("confirm-message");

    // Remembered so the dialog is restored for the next caller — otherwise one
    // `danger: true` call would leave every later confirmation red.
    const priorTitle = titleEl ? titleEl.textContent : null;
    const priorOk = okBtn.className;
    const priorOkText = okBtn.textContent;

    if (titleEl && opts.title) titleEl.textContent = opts.title;
    if (opts.html) bodyEl.innerHTML = opts.message || "";
    else bodyEl.innerText = opts.message || "";
    if (opts.confirmText) okBtn.textContent = opts.confirmText;
    if (opts.danger) okBtn.classList.add("btn-danger");

    modal.classList.remove("hidden");

    function finish(result) {
      modal.classList.add("hidden");
      cancelBtn.onclick = null;
      okBtn.onclick = null;
      if (titleEl && priorTitle !== null) titleEl.textContent = priorTitle;
      okBtn.className = priorOk;
      okBtn.textContent = priorOkText;
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

// ══════════════════════════════════════════════════════════════════════
// RESPONSIVE TABLES — one observer, every table
// ══════════════════════════════════════════════════════════════════════
//
// `.table-stack` in assets/style.css turns each <tr> into a card under 640px
// and prints each <td>'s caption from its `data-label`. Writing that attribute
// by hand would mean touching every renderer in js/views/*.js — 24 tables,
// several hundred <td>s built inside template strings — and every future one
// would have to remember.
//
// So it is done at RUNTIME instead: the caption is already in the table's own
// <thead>, and the column index of a <td> is already its position. This walks
// each table once, copies header text down onto the cells, and re-runs when a
// view re-renders its rows.
//
// Consequences worth knowing:
//   * A renderer that changes its <th> text automatically changes the mobile
//     captions. There is no second copy to keep in step.
//   * Tables are opted IN by `.table-stack` on the <table>, so a genuine grid
//     (the dashboard matrix, where the columns ARE the data) keeps scrolling.
//   * `colspan` cells — empty states, spinners — are skipped by the CSS.

// ── Horizontal scroll affordance ────────────────────────────────────────
//
// Marks a `.scroll-hint` strip with how much is left to scroll at each end, so
// the stylesheet can fade only the end that actually has more content. Pure CSS
// cannot do this — it has no access to scrollLeft.
//
// The dashboard tab bar is the reason: at 390px it is 925px of tabs in 308px of
// viewport with `scrollbar-none`, so three of six tabs existed with nothing on
// screen hinting at them.
function _syncScrollHint(el) {
  const max = el.scrollWidth - el.clientWidth;
  // "0" means there IS more in that direction — the attribute names read as
  // "distance to the start/end is not zero", which is what the CSS keys on.
  el.setAttribute("data-scroll-start", el.scrollLeft > 4 ? "0" : "1");
  el.setAttribute("data-scroll-end", max - el.scrollLeft > 4 ? "0" : "1");
}

function wireScrollHints(root = document) {
  root.querySelectorAll(".scroll-hint").forEach((el) => {
    if (el.dataset.scrollWired) return;
    el.dataset.scrollWired = "1";
    el.addEventListener("scroll", () => _syncScrollHint(el), { passive: true });
    // Content and viewport both change after this runs — tabs are re-rendered,
    // the sidebar opens, the phone rotates — so observe rather than measure once.
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(() => _syncScrollHint(el)).observe(el);
    }
    _syncScrollHint(el);
  });
}

window.wireScrollHints = wireScrollHints;

function stampTableLabels(root = document) {
  root.querySelectorAll("table.table-stack").forEach((table) => {
    const heads = [...table.querySelectorAll("thead th")].map((th) =>
      th.textContent.trim(),
    );
    // No header row means no captions to copy down, and a stacked card whose
    // cells have no labels is LESS readable than the scrolling table it
    // replaced — the reader loses the column positions and gains nothing. Such
    // a table opts itself back out rather than degrading.
    if (!heads.some(Boolean)) {
      table.classList.remove("table-stack");
      table.closest(".table-stack-wrap")?.classList.remove("table-stack-wrap");
      return;
    }
    table.querySelectorAll("tbody tr").forEach((tr) => {
      [...tr.children].forEach((td, i) => {
        if (td.hasAttribute("colspan")) return;
        const label = heads[i];
        // A blank header means a control column (checkbox, actions); those
        // render full-width with no caption, which is what we want.
        if (label) td.setAttribute("data-label", label);
        else td.removeAttribute("data-label");
      });
    });
  });
}
window.stampTableLabels = stampTableLabels;

// Re-stamp whenever a tbody's rows are replaced. Views render from template
// strings into innerHTML, so there is no single hook to call — the observer is
// what makes this work without editing 24 renderers.
(function watchTables() {
  // A LOCAL throttle, not the shared `debounce()` from js/search.js.
  //
  // This IIFE runs at core.js EVAL time, and search.js is loaded after it — so
  // calling debounce() here threw "debounce is not defined" and killed the rest
  // of core.js, taking the whole page with it. That is precisely the ordering
  // rule CLAUDE.md states: function declarations hoist WITHIN a file, but one
  // file's top-level code cannot reach into a file that has not run yet.
  // tools/check_js.py cannot catch it — the identifier does exist, just not yet.
  let timer = null;
  const restamp = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stampTableLabels(), 60);
  };
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.target.closest?.("table.table-stack")) {
        restamp();
        return;
      }
    }
  });
  document.addEventListener("DOMContentLoaded", () => {
    stampTableLabels();
    // Same listener rather than a second DOMContentLoaded handler: both are
    // "measure the DOM once it exists", and wireScrollHints() is idempotent
    // (it marks what it has already wired).
    wireScrollHints();
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
