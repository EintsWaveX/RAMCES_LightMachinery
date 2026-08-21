// ═══════════════════════════════════════════════════════════════════════
// Dashboard tabs: matrix, availability, bar and trend panels.
//
// Part of the RAMCES frontend. These files are plain classic scripts
// loaded in a fixed order by index.html - no bundler, no modules. They
// share one global scope, so a top-level `let` or `const` declared twice
// across two files is a fatal SyntaxError; see CLAUDE.md.
// ═══════════════════════════════════════════════════════════════════════

// ── DASHBOARD STATE ────────────────────────────────────────────────────────
// DEAD on the Dashboard as of rev0.4.7 — the Benchmark card and its Δ column
// are gone, replaced by Perlu Perhatian and a flag column (see
// _DASH_KPI_CARDS and _renderMatrixPanel below). The declaration STAYS: it
// is a top-level `let` still read by js/views/kdak.js (lines 24, 38, 41,
// 1436) and js/views/laporan.js (lines 286-290), neither of which this pass
// touches — deleting it now is a ReferenceError on both screens. Slated for
// removal once those two screens' own Benchmark cards go too.
let _benchmarkPct = (() => {
  const raw = localStorage.getItem("dashBenchmark");
  const parsed = parseInt(raw || "59", 10);
  return isNaN(parsed) ? 59 : Math.max(0, Math.min(100, parsed));
})();
let _dashTabIndex = 0;
let _dashChartBar = null;
let _dashChartAvail = null;
let _dashChartTrend = null;
// "perbaikan" is the printed repair report, moved here from Kelola Inventaris so
// every fleet-level dashboard lives behind one menu entry. It owns its own
// Lokasi + Tahun filters and boots lazily — see setupRepairDashboard().
// "mcf" is served by the same endpoint pair as "perbaikan", so activating
// either tab boots the repair dashboard.
const _DASH_TABS = ["matrix", "bar", "avail", "trend", "perbaikan", "mcf"];

// ══════════════════════════════════════════════════════════════════════
// PER-TAB FILTERS
// ══════════════════════════════════════════════════════════════════════
//
// There used to be ONE filter bar above all six tabs, carrying Semua Alat
// Kerja / Pengadaan / Tahun. Three of the six ignored it: Tren Perbaikan had
// its own year picker, and Laporan Perbaikan and Kurva MCF have their own
// Lokasi + Tahun row. A control that visibly applies to only half the screen is
// worse than no control, because there is no way to tell which half.
//
// Each tab now carries its own row AND its own selection — switching to
// Grafik Ketersediaan and narrowing to one alat kerja leaves the Matriks
// exactly as it was. That is what "individually per tabs" means: the rows are
// independent, not merely duplicated.
//
// One builder, four declarations. Adding a filter to a tab is a line in
// _DASH_FILTER_SPEC, never another block of markup in index.html.
let _dashFilters = {
  // `uptTipe` is the matrix's alone: "" | JR | JB | ME. The other three panels
  // roll UPT into the parent region, so a branch filter would have nothing to
  // narrow — the matrix is the only place the individual resorts are drawn.
  matrix: { alat: "", pengadaan: "", tahun: "", uptTipe: "" },
  bar: { alat: "", pengadaan: "", tahun: "" },
  avail: { alat: "", pengadaan: "", tahun: "" },
  // Trend plots twelve months of ONE year, so its `tahun` is never "" —
  // _renderDashFilterRow seeds it with the newest year that holds data.
  trend: { alat: "", pengadaan: "", tahun: "" },
};

// Semua / JR / JB / ME. The three prefixes come from UPT_PREFIX_BY_PERUNTUKAN
// in js/core.js rather than a second hardcoded copy — the UPT code prefix IS
// the peruntukan, and that mapping is already stated in one place.
const _UPT_TIPE_OPSI = [
  { val: "", label: "Semua" },
  { val: "JR", label: "JR" },
  { val: "JB", label: "JB" },
  { val: "ME", label: "ME" },
];

// `legend` is rendered to the right of the controls. Only the matrix gets the
// four-swatch key: it is the only panel that paints cells by status, and the
// Chart.js panels draw their own legends from the series they actually plot.
const _DASH_FILTER_SPEC = {
  matrix: {
    fields: ["alat", "pengadaan", "tahun", "uptTipe"],
    // The third swatch carries `.matrix-cell-mixed` — the SAME class the cell
    // itself uses, not a lookalike. It used to be a soft Tailwind
    // `from-green-300 to-red-300` diagonal blend while the real cell is a hard
    // 135° 50/50 split, so the key did not depict the thing it was keying.
    // Sharing the class means there is one declaration and it cannot drift.
    //
    // The LABEL was wrong too: "Lebih dari 1 unit" describes any cell holding
    // two or more machines, but three units that are all SO render solid green.
    // What this swatch actually marks is a MIXED cell.
    // The last two swatches replace a single "— Tidak ada alat" entry that
    // showed an actual em dash. The matrix no longer prints one anywhere —
    // an em dash reads as a fillable placeholder, not as "nothing here" — so
    // the key now names the two backgrounds that took its place instead: one
    // for a real UPT that simply has no assets right now, one for a column
    // slot that does not apply to this region at all. See _matrixCell() /
    // _matrixSlotEmptyCell().
    legend: `
      <span class="dash-key"><span class="dash-swatch bg-green-500"></span>SO — Siap Operasi</span>
      <span class="dash-key"><span class="dash-swatch bg-red-500"></span>TSO — Tidak Siap</span>
      <span class="dash-key"><span class="dash-swatch matrix-cell-mixed"></span>Campuran SO / TSO</span>
      <span class="dash-key"><span class="dash-swatch dash-matrix-cell-zero"></span>UPT ada, 0 aset</span>
      <span class="dash-key"><span class="dash-swatch dash-matrix-slot-empty"></span>Slot tidak berlaku</span>`,
  },
  bar: {
    fields: ["alat", "pengadaan", "tahun"],
    legend: "", // Chart.js prints SO / TSO from the series themselves
  },
  avail: {
    fields: ["alat", "pengadaan", "tahun"],
    // The bar colours encode rank, which nothing on the chart said out loud.
    legend: `
      <span class="dash-key"><span class="dash-swatch" style="background:rgba(34,197,94,.85)"></span>Tertinggi</span>
      <span class="dash-key"><span class="dash-swatch" style="background:rgba(59,130,246,.75)"></span>Lainnya</span>
      <span class="dash-key"><span class="dash-swatch" style="background:rgba(239,68,68,.85)"></span>Terendah</span>
      <span class="dash-key"><span class="dash-swatch h-0.5 self-center" style="background:rgba(239,68,68,.9)"></span>Rata-rata</span>`,
  },
  trend: {
    fields: ["alat", "pengadaan", "tahun"],
    // No "Semua Tahun": the chart is twelve months of one year, and offering an
    // all-years option only invites a selection it cannot honour. The previous
    // code accepted it and silently substituted the current year, which read as
    // the filter being ignored.
    tahunAllLabel: null,
    legend: "",
  },
};

function _dashFilterFor(tabId) {
  return _dashFilters[tabId] || { alat: "", pengadaan: "", tahun: "" };
}

// ══════════════════════════════════════════════════════════════════════
// THE FLEET ROLLUP — /api/aset/dashboard/ringkasan
// ══════════════════════════════════════════════════════════════════════
//
// Every panel here used to reduce `db`, a client-side copy of the whole fleet,
// and that copy was the single reason the SPA downloaded 1.06 MB at login. All
// four panels and the KPI strip turn out to want only SO/TSO counts keyed by
// something, so the server groups them and sends 5.6 KB instead — and it stops
// growing with the fleet.
//
// What did NOT change: the panels still key on the asset's CURRENT `id_lokasi`
// and still roll UPT up into the parent themselves. The identity location
// (js/search.js) is a different rule for a different question, and quietly
// swapping it here would move assets between regions on the matrix.
//
// Keyed by the exact filter triple, so switching tabs back and forth is free
// and a mutation clears the lot.
const _ringkasanCache = new Map();

function invalidateRingkasan() {
  _ringkasanCache.clear();
  // The hirarki rollup is scoped by the same filter triple and goes stale for
  // the same reasons, so the two caches are cleared together. Splitting them
  // would let the KPI strip print a calibration figure from before a mutation
  // beside an SO count from after it.
  _hirarkiCache.clear();
}
window.invalidateRingkasan = invalidateRingkasan;

const RINGKASAN_EMPTY = {
  total: 0, so: 0, tso: 0, jenis_unik: 0, lokasi_unik: 0, bulan_ini: 0,
  per_lokasi: {}, per_alat: {}, per_bulan: [], tahun_counts: [],
};

async function getRingkasan(f = {}) {
  const p = new URLSearchParams();
  if (f.alat) p.set("alat", f.alat);
  if (f.pengadaan) p.set("pengadaan", f.pengadaan);
  if (f.tahun) p.set("tahun", f.tahun);
  const key = p.toString();
  if (_ringkasanCache.has(key)) return _ringkasanCache.get(key);
  try {
    const res = await apiFetch(`/aset/dashboard/ringkasan?${key}`, {
      background: true,
    });
    if (!res.ok) throw new Error();
    const body = await res.json();
    _ringkasanCache.set(key, body);
    return body;
  } catch (e) {
    // A failed rollup must not blank a panel that was showing real numbers a
    // second ago — an empty shape renders the same empty state a genuinely
    // empty fleet does, and the toast in apiFetch already reported the failure.
    return RINGKASAN_EMPTY;
  }
}
window.getRingkasan = getRingkasan;

/**
 * The unfiltered rollup IF it is already cached, otherwise null — never a fetch.
 *
 * The KDAK live id preview runs on every keystroke and must stay synchronous.
 * `updateDashboardStats()` populates this at login, so by the time any form is
 * open it is there; the preview degrades to a placeholder rather than blocking
 * if it somehow is not.
 */
function ringkasanIfLoaded() {
  return _ringkasanCache.get("") || null;
}
window.ringkasanIfLoaded = ringkasanIfLoaded;

// ══════════════════════════════════════════════════════════════════════
// THE ATTENTION ROLLUP — /api/aset/dashboard/hirarki
// ══════════════════════════════════════════════════════════════════════
//
// `ringkasan` answers "how many, and where" and nothing else. Three of the
// seven KPI cards — Kalibrasi, Mutasi and Perlu Perhatian — ask a different
// question: which machines need somebody to do something today. That needs the
// latest calibration per asset and the first transfer per asset, neither of
// which `ringkasan` carries and neither of which the client can derive without
// the whole fleet.
//
// Same filter triple, same cache discipline, same per-RAW-lokasi keying as
// `ringkasan.per_lokasi` — so `_rollUpLokasi()` works on `per_lokasi` here
// unchanged, and the matrix's flag column lines up with its own SO/TSO row.
//
// LAZY BY CONSTRUCTION. This is fetched from `_renderDashActivePanel()` only
// while the matrix tab is showing, never from `updateDashboardStats()` — that
// function runs at login (js/shell.js) and after every mutation (js/api.js),
// and hanging a fetch off it would put this on the critical path of every
// sign-in for a strip the user may never scroll to.
const _hirarkiCache = new Map();

const HIRARKI_EMPTY = {
  hari: 30, total: 0, so: 0, tso: 0,
  kalibrasi: { perlu: 0, tidak_perlu: 0, lewat: 0, segera: 0, belum: 0 },
  mutasi: { pernah: 0, belum_kembali: 0, di_balaiyasa: 0 },
  perhatian: { total: 0, tso: 0, kalibrasi: 0, mutasi: 0 },
  per_lokasi: {},
};

async function getDashHirarki(f = {}) {
  const p = new URLSearchParams();
  if (f.alat) p.set("alat", f.alat);
  if (f.pengadaan) p.set("pengadaan", f.pengadaan);
  if (f.tahun) p.set("tahun", f.tahun);
  const key = p.toString();
  if (_hirarkiCache.has(key)) return _hirarkiCache.get(key);
  try {
    const res = await apiFetch(`/aset/dashboard/hirarki?${key}`, {
      background: true,
    });
    if (!res.ok) throw new Error();
    const body = await res.json();
    _hirarkiCache.set(key, body);
    return body;
  } catch (e) {
    // Same contract as getRingkasan(): a failed rollup renders the empty state
    // rather than blanking cards that held real numbers a second ago. The
    // result is deliberately NOT cached, so the next render retries.
    return HIRARKI_EMPTY;
  }
}
window.getDashHirarki = getDashHirarki;

/** The attention rollup IF already cached, otherwise null — never a fetch. */
function hirarkiIfLoaded(f = {}) {
  const p = new URLSearchParams();
  if (f.alat) p.set("alat", f.alat);
  if (f.pengadaan) p.set("pengadaan", f.pengadaan);
  if (f.tahun) p.set("tahun", f.tahun);
  return _hirarkiCache.get(p.toString()) || null;
}

/** The rollup for one tab's own filter. */
function _dashAgg(tabId) {
  return getRingkasan(_dashFilterFor(tabId));
}

/**
 * SO/TSO per lokasi code, with each UPT ALSO added to its parent.
 *
 * The availability and bar panels both did this by pushing every asset into two
 * buckets; the matrix deliberately does not, and sums only the resorts it draws.
 * Same rollup, done once over ~270 codes instead of once per asset.
 */
function _rollUpLokasi(perLokasi) {
  const out = {};
  const add = (k, v) => {
    if (!out[k]) out[k] = { so: 0, tso: 0 };
    out[k].so += v.so;
    out[k].tso += v.tso;
  };
  Object.entries(perLokasi || {}).forEach(([code, v]) => {
    add(code, v);
    const parent = getParentLokasiCode(code);
    if (parent && parent !== code) add(parent, v);
  });
  return out;
}

// ══════════════════════════════════════════════════════════════════════
// THE KPI STRIP
// ══════════════════════════════════════════════════════════════════════
//
// Seven cards, and every one of them is a door. Each card used to print a
// number and stop there — "165 tidak siap" with no way on screen to ask WHICH
// 165, even though the answer was already in the database. They are `<button>`s
// now, and each opens the shared drill-down modal scoped to what it counts.
//
// The strip lives INSIDE #dash-panel-matrix rather than above the tab bar. It
// always followed the active tab's filter, which is why it used to need a
// "Menghitung: …" caption underneath explaining which tab it was obeying — a
// caption is what you add when the layout is lying. Putting it in the panel
// whose filters drive it removes the question instead of answering it.
//
// One declarative entry per card, in the same register as _DASH_FILTER_SPEC:
// adding a card is a line here, never markup in index.html.
//   mode   the key handed to openDashDrill()
//   nilai  (agg, hir) -> the big number, already formatted
//   sub    (agg, hir) -> the small line under it, or "" for none
const _DASH_KPI_CARDS = [
  {
    mode: "total", label: "Total Aset", ikon: "fa-boxes", aksen: "kai-blue",
    warna: "text-gray-800 dark:text-white",
    watermark: "text-slate-100 dark:text-slate-700/50",
    nilai: (a) => _kpiNum(a.total),
    sub: (a) => `${_kpiNum(a.jenis_unik)} jenis alat kerja`,
  },
  {
    mode: "so", label: "Siap Operasi", ikon: "fa-check-circle", aksen: "green-400",
    warna: "text-green-500",
    watermark: "text-green-100 dark:text-green-900/30",
    nilai: (a) => _kpiNum(a.so),
    sub: (a) => (a.total ? `${Math.round((a.so / a.total) * 100)}% dari armada` : ""),
  },
  {
    mode: "tso", label: "Tidak Siap", ikon: "fa-times-circle", aksen: "red-400",
    warna: "text-red-500",
    watermark: "text-red-100 dark:text-red-900/30",
    nilai: (a) => _kpiNum(a.tso),
    sub: (a) => (a.total ? `${Math.round((a.tso / a.total) * 100)}% dari armada` : ""),
  },
  {
    mode: "kalibrasi", label: "Kalibrasi", ikon: "fa-ruler-combined", aksen: "cyan-400",
    warna: "text-cyan-600 dark:text-cyan-400",
    watermark: "text-cyan-100 dark:text-cyan-900/30",
    // Overdue plus due-soon: what somebody has to act on. `belum` — never
    // calibrated at all — is deliberately the sub-line and not the headline,
    // for the same reason the server leaves it out of `perhatian`: on a fresh
    // install it is most of the fleet and would read as a sudden backlog.
    nilai: (_a, h) => _kpiNum(h.kalibrasi.lewat + h.kalibrasi.segera),
    sub: (_a, h) => `${_kpiNum(h.kalibrasi.belum)} belum pernah`,
  },
  {
    mode: "mutasi", label: "Mutasi", ikon: "fa-exchange-alt", aksen: "orange-400",
    warna: "text-kai-orange",
    watermark: "text-orange-100 dark:text-orange-900/30",
    nilai: (_a, h) => _kpiNum(h.mutasi.pernah),
    sub: (_a, h) => `${_kpiNum(h.mutasi.belum_kembali)} belum kembali`,
  },
  {
    mode: "ketersediaan", label: "Ketersediaan", ikon: "fa-gauge-high", aksen: "kai-blue",
    warna: "text-kai-blue dark:text-blue-400",
    watermark: "text-blue-100 dark:text-blue-900/30",
    nilai: (a) => (a.total ? `${Math.round((a.so / a.total) * 100)}%` : "—"),
    sub: (a) => (a.total ? `${_kpiNum(a.so)} dari ${_kpiNum(a.total)} unit` : ""),
  },
  {
    mode: "perhatian", label: "Perlu Perhatian", ikon: "fa-triangle-exclamation",
    aksen: "amber-400",
    warna: "text-amber-600 dark:text-amber-400",
    watermark: "text-amber-100 dark:text-amber-900/30",
    nilai: (_a, h) => _kpiNum(h.perhatian.total),
    sub: (_a, h) =>
      `${_kpiNum(h.perhatian.tso)} TSO · ${_kpiNum(h.perhatian.kalibrasi)} kalibrasi · ` +
      `${_kpiNum(h.perhatian.mutasi)} di balaiyasa`,
  },
];

/** `—` rather than `0` for a missing rollup, matching what the tiles always did. */
function _kpiNum(n) {
  return n === null || n === undefined ? "—" : Number(n).toLocaleString("id-ID");
}

/**
 * Paint the seven cards into #dash-kpi-strip.
 *
 * `hir` may be HIRARKI_EMPTY on the first paint — the strip renders at login
 * from the cached ringkasan while the attention rollup is still in flight, and
 * `_renderDashActivePanel()` calls this again once it lands. That is why the
 * three hirarki-backed cards read `0` briefly rather than blocking the paint.
 */
function _renderDashKpiStrip(agg, hir) {
  const mount = document.getElementById("dash-kpi-strip");
  if (!mount) return;
  const a = agg || RINGKASAN_EMPTY;
  const h = hir || HIRARKI_EMPTY;

  mount.innerHTML = _DASH_KPI_CARDS.map((c) => {
    const sub = c.sub(a, h);
    return `<button type="button" data-dash-kpi="${c.mode}" aria-haspopup="dialog"
        title="Lihat rincian ${c.label}"
        class="text-left w-full bg-white dark:bg-gray-800 p-3 rounded-xl border
               border-gray-100 dark:border-gray-700 shadow-sm relative overflow-hidden
               group hover:border-${c.aksen} focus:border-${c.aksen}
               transition hover:-translate-y-0.5 hover:shadow-md motion-reduce:hover:transform-none">
        <p class="text-[9px] font-bold tracking-widest text-gray-400 uppercase mb-1">${c.label}</p>
        <h3 class="text-xl font-bold ${c.warna}">${c.nilai(a, h)}</h3>
        ${sub ? `<p class="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5 truncate">${sub}</p>` : ""}
        <i class="fas ${c.ikon} absolute -bottom-3 -right-1 text-5xl ${c.watermark}
                  group-hover:scale-125 transition-transform pointer-events-none"></i>
      </button>`;
  }).join("");

  // ONE delegated listener, guarded so re-rendering the strip cannot multiply
  // it — the same discipline _renderDashFilterRow() uses on its own mount.
  if (!mount.dataset.wired) {
    mount.dataset.wired = "1";
    mount.addEventListener("click", (e) => {
      const mode = e.target.closest("[data-dash-kpi]")?.dataset.dashKpi;
      // Optional-chained: the drill-down modal is a separate file that may not
      // have loaded (or may not exist yet), and a card that does nothing is a
      // better failure than a card that throws.
      if (mode) window.openDashDrill?.(mode);
    });
  }
}

/**
 * Build (or refresh) one tab's filter row.
 *
 * Called on every render rather than once, because the year counts change
 * whenever the asset list is refetched — a cached row would keep reporting
 * "2025 (623)" after a mutation made it 624.
 *
 * The <select> elements are recreated each time, so the change handlers are
 * attached to the ROW via delegation instead of to each control. That also
 * means there is exactly one listener per tab no matter how often this runs.
 */
async function _renderDashFilterRow(tabId) {
  const mount = document.getElementById(`dash-filters-${tabId}`);
  const spec = _DASH_FILTER_SPEC[tabId];
  if (!mount || !spec) return;

  const f = _dashFilterFor(tabId);
  // Counts are scoped to this tab's OTHER filters, so the year list answers
  // "how many of what I am currently looking at", not "how many in the fleet".
  // `tahun_counts` is computed the same way server-side — narrowed by alat and
  // pengadaan but NOT by the year, or the list would collapse to the one year
  // already chosen and there would be no way back.
  //
  // A Map keyed by the year as a STRING, which is the shape fillYearSelect()
  // and yearOptionLabel() read (`counts.get(String(year))`). A plain object
  // here throws inside the option builder and takes the whole row with it.
  const counts = new Map();
  (await getRingkasan({ alat: f.alat, pengadaan: f.pengadaan })).tahun_counts
    .forEach((r) => counts.set(String(r.tahun), r.jumlah));

  const SELECT_CLASS =
    "text-xs px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-600 " +
    "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 outline-none " +
    "focus:border-kai-blue transition min-h-[38px]";

  const controls = [];
  if (spec.fields.includes("alat")) {
    // Only alat kerja that actually HOLD assets in this scope, each with its
    // count, alphabetical. The katalog has 104 tool types and the seeded fleet
    // uses 26 of them, so listing them all left 78 options that render an empty
    // panel — a filter offering choices that cannot answer anything.
    //
    // Counts come from a rollup narrowed by pengadaan and tahun but NOT by alat
    // — exactly the rule `tahun_counts` follows. Scoping by the current alat
    // would collapse the list to the one option already chosen, with no way
    // back to any other.
    const alatCounts = (await getRingkasan({
      pengadaan: f.pengadaan,
      tahun: f.tahun,
    })).per_alat || {};

    const opsiAlat = Object.entries(alatCounts)
      .map(([code, v]) => ({
        code,
        name: alatKerjaData.find((a) => a.code === code)?.name || code,
        n: (v.so || 0) + (v.tso || 0),
      }))
      .filter((o) => o.n > 0)
      .sort((a, b) => a.name.localeCompare(b.name, "id"));

    // Keep the current selection even when it has fallen to zero, rendered
    // "(0)" — the same guarantee fillYearSelect() gives the year pickers, so a
    // refetch can never silently drop a filter the user set.
    if (f.alat && !opsiAlat.some((o) => o.code === f.alat)) {
      opsiAlat.push({
        code: f.alat,
        name: alatKerjaData.find((a) => a.code === f.alat)?.name || f.alat,
        n: 0,
      });
      opsiAlat.sort((a, b) => a.name.localeCompare(b.name, "id"));
    }

    controls.push(
      `<select data-dash-field="alat" aria-label="Filter alat kerja"
               class="${SELECT_CLASS} min-w-[150px]">
         <option value="">Semua Alat Kerja (${opsiAlat.length})</option>
         ${opsiAlat
           .map(
             (o) =>
               `<option value="${o.code}"${o.code === f.alat ? " selected" : ""}>` +
               `${spekEscape(o.name)} (${o.n.toLocaleString("id-ID")})</option>`,
           )
           .join("")}
       </select>`,
    );
  }
  if (spec.fields.includes("pengadaan")) {
    const opt = (v, label) =>
      `<option value="${v}"${v === f.pengadaan ? " selected" : ""}>${label}</option>`;
    controls.push(
      `<select data-dash-field="pengadaan" aria-label="Filter sumber pengadaan"
               class="${SELECT_CLASS}">
         ${opt("", "Semua Pengadaan")}${opt("1", "PUSAT")}${opt("2", "DAOP / DIVRE")}
       </select>`,
    );
  }
  if (spec.fields.includes("tahun")) {
    controls.push(
      `<select data-dash-field="tahun" aria-label="Filter tahun pembelian"
               class="${SELECT_CLASS} min-w-[130px]"></select>`,
    );
  }
  if (spec.fields.includes("uptTipe")) {
    // A segmented control rather than a fourth <select>: the three branches are
    // a small closed set the user switches between constantly while reading the
    // matrix, and burying that in a dropdown hides how the table narrows.
    controls.push(
      `<div class="segmented" role="tablist" aria-label="Jenis UPT">
         ${_UPT_TIPE_OPSI.map(
           (o) =>
             `<button type="button" role="tab" class="segmented-btn` +
             `${o.val === (f.uptTipe || "") ? " is-active" : ""}"` +
             ` id="dash-upt-${o.val || "semua"}" data-dash-upt="${o.val}"` +
             ` aria-selected="${o.val === (f.uptTipe || "")}">${o.label}</button>`,
         ).join("")}
       </div>`,
    );
  }

  mount.className =
    "dash-filter-row flex flex-col sm:flex-row sm:items-center gap-3 mb-4 " +
    "pb-3 border-b border-gray-100 dark:border-gray-700/60";
  mount.innerHTML =
    `<div class="flex flex-wrap gap-2 flex-1 min-w-0">${controls.join("")}</div>` +
    (spec.legend
      ? `<div class="flex flex-wrap gap-x-4 gap-y-1 text-[11px] shrink-0
                     text-gray-600 dark:text-gray-300">${spec.legend}</div>`
      : "") +
    // Laporan Perbaikan and Kurva MCF have always had their own #rd-refresh /
    // #rd-mcf-refresh; the four computed panels had no way to force a fresh
    // read without leaving the tab. Same markup, same behaviour: clear the
    // shared rollup caches and re-render.
    `<button type="button" data-action="dash-reload" title="Muat ulang data tab ini"
        class="shrink-0 flex items-center gap-2 px-3 py-2 bg-white dark:bg-gray-700
               border border-gray-200 dark:border-gray-600 hover:border-kai-blue
               text-gray-600 dark:text-gray-300 rounded-lg transition text-xs font-semibold">
       <i class="fas fa-rotate-right"></i> <span class="hidden sm:inline">Muat Ulang</span>
     </button>`;

  // Years are filled by the shared helper so this picker obeys exactly the same
  // rule as the five in the sort modals: only years that hold data, each with
  // its count. See fillYearSelect() in js/views/sort-modals.js.
  const tahunSel = mount.querySelector('[data-dash-field="tahun"]');
  if (tahunSel) {
    tahunSel.value = f.tahun;
    fillYearSelect(
      tahunSel,
      counts,
      spec.tahunAllLabel === null ? null : "Semua Tahun",
    );
    // Trend has no all-years option, so it must land on a concrete year — and
    // that year has to be written back into the state or the chart and the box
    // would disagree on first paint.
    f.tahun = tahunSel.value;
  }

  if (!mount.dataset.wired) {
    mount.dataset.wired = "1";
    mount.addEventListener("change", (e) => {
      const field = e.target?.dataset?.dashField;
      if (!field) return;
      _dashFilterFor(tabId)[field] = e.target.value;
      // Narrowing alat or pengadaan changes which years hold anything, so the
      // row rebuilds itself before the panel repaints.
      _renderDashFilterRow(tabId);
      updateDashboardStats();
    });
    // The segmented control and the reload button are both buttons, which
    // fire `click`, not `change` — a second listener on the SAME mount behind
    // the same wired flag, so rebuilding the row still cannot multiply any of
    // them.
    mount.addEventListener("click", (e) => {
      const reloadBtn = e.target.closest('[data-action="dash-reload"]');
      if (reloadBtn) {
        _reloadDashTab(tabId, reloadBtn);
        return;
      }
      const btn = e.target.closest("[data-dash-upt]");
      if (!btn) return;
      const val = btn.dataset.dashUpt;
      _dashFilterFor(tabId).uptTipe = val;
      setSegmented(
        _UPT_TIPE_OPSI.map((o) => `dash-upt-${o.val || "semua"}`),
        `dash-upt-${val || "semua"}`,
      );
      _renderDashFilterRow(tabId);
      updateDashboardStats();
    });
  }
}

/**
 * "Muat Ulang" for the four computed panels — Laporan Perbaikan and Kurva MCF
 * have always had their own #rd-refresh/#rd-mcf-refresh; these had no way to
 * force a fresh read without switching tabs and back.
 *
 * Spins the icon and disables the button for the duration; neither needs to
 * be undone by hand, because _renderDashActivePanel() rebuilds this exact
 * mount's innerHTML on the way back, replacing the spinning button with a
 * fresh, un-spun one.
 */
async function _reloadDashTab(tabId, btn) {
  btn.disabled = true;
  btn.querySelector("i")?.classList.add("fa-spin");
  invalidateRingkasan(); // clears both the ringkasan AND the hirarki cache
  await _renderDashActivePanel();
}

// Tab navigation. Wired once; the filter rows wire themselves per tab.
function _wireDashChrome() {
  if (window._dashChromeWired) return;
  window._dashChromeWired = true;

  // Bound by the `data-dash-tab` ATTRIBUTE, not by position in the DOM.
  // _switchDashTab() used to take an index and look the id up in _DASH_TABS,
  // which meant the attributes already in the markup were dead and reordering
  // the buttons silently misrouted every tab. Keying on the attribute also
  // makes the tab buttons and the dot markers one selector instead of two
  // parallel lists that have to stay index-aligned by hand.
  document.querySelectorAll("[data-dash-tab]").forEach((btn) => {
    btn.addEventListener("click", () => _switchDashTab(btn.dataset.dashTab));
  });

  // Replaces #dash-tab-prev / #dash-tab-next, which were `hidden sm:flex` —
  // visible only at the widths where the strip no longer scrolls at all. Arrow
  // keys are what a tab strip is supposed to answer to anyway.
  document.getElementById("dash-tab-bar")?.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.key === "ArrowRight" ? 1 : -1;
    const next = (_dashTabIndex + step + _DASH_TABS.length) % _DASH_TABS.length;
    _switchDashTab(_DASH_TABS[next]);
    document
      .querySelector(`.dash-tab-btn[data-dash-tab="${_DASH_TABS[next]}"]`)
      ?.focus();
  });
}

function _switchDashTab(tabId) {
  // Tolerate an index from any caller not yet migrated, so a stale call site
  // degrades to the right tab instead of resolving `dash-panel-undefined`.
  if (typeof tabId === "number") tabId = _DASH_TABS[tabId];
  if (!_DASH_TABS.includes(tabId)) return;
  _dashTabIndex = _DASH_TABS.indexOf(tabId);

  document.querySelectorAll("[data-dash-tab]").forEach((el) => {
    const on = el.dataset.dashTab === tabId;
    el.classList.toggle("is-active", on);
    if (el.classList.contains("dash-dot")) {
      // The dots are the only place the current tab is conveyed by shape
      // alone, so it needs a programmatic equivalent.
      el.setAttribute("aria-current", on ? "true" : "false");
    }
  });
  document
    .querySelectorAll(".dash-panel")
    .forEach((p) => p.classList.add("hidden"));
  document.getElementById(`dash-panel-${tabId}`)?.classList.remove("hidden");

  _renderDashActivePanel();
}

async function _renderDashActivePanel() {
  const tabId = _DASH_TABS[_dashTabIndex];

  // ONE rollup per render, handed to both the filter row and the panel. Two
  // fetches would be two chances for them to disagree about what is on screen.
  const agg = _DASH_FILTER_SPEC[tabId] ? await _dashAgg(tabId) : RINGKASAN_EMPTY;

  // Only the ACTIVE tab's row is rebuilt. The others keep their DOM and their
  // selection, which is what makes the filters independent per tab rather than
  // four copies of one shared value.
  await _renderDashFilterRow(tabId);

  // BEFORE the repair dispatch below, never after: on those two tabs
  // setDashBanner() fires from their load() and must win, and it can only win
  // if the generic title has already been laid down.
  _syncDashBanner(tabId);

  if (tabId === "matrix") {
    // The attention rollup is fetched HERE and only here — see the comment on
    // _hirarkiCache. The strip is painted twice on a cold cache: once from the
    // ringkasan that is already in hand, then again when this resolves, so the
    // four ringkasan-backed cards appear immediately instead of waiting.
    _renderDashKpiStrip(agg, hirarkiIfLoaded(_dashFilterFor("matrix")));
    const hir = await getDashHirarki(_dashFilterFor("matrix"));
    _renderDashKpiStrip(agg, hir);
    _renderMatrixPanel(agg, hir);
  }
  if (tabId === "bar") _renderBarPanel(agg);
  if (tabId === "avail") _renderAvailPanel(agg);
  if (tabId === "trend") _renderTrendPanel(agg);
  // Unlike the computed panels, these two are server-driven rather than derived
  // from the cached `db` array, so they fetch on activation. Both are filled by
  // the same load() inside repair-dashboard.js.
  if (tabId === "perbaikan" || tabId === "mcf") window.initRepairDashboard?.();
}

// ── PANEL 1: Matrix ────────────────────────────────────────────────────────
/** JR / JB / ME from a UPT code's own prefix — the same rule the UPT-tipe
 *  filter already applies (`startsWith(uptTipe)`), pulled out once so the
 *  grouped header and the branch filter can never disagree on where a code
 *  belongs. */
function _branchOf(code) {
  const c = String(code || "").toUpperCase();
  if (c.startsWith("JR")) return "JR";
  if (c.startsWith("JB")) return "JB";
  if (c.startsWith("ME")) return "ME";
  return null;
}

/**
 * One <td> for a real slot — the Kantor Wilayah column or an actual resort —
 * covering both "has assets" and "exists, currently has none." Never called
 * for a slot that does not exist for this region at all; see
 * _matrixSlotEmptyCell() for that.
 *
 * `data-tip` + `tabindex="0"` replace the old `title` attribute: `title`
 * never fires on touch, so every informative cell is readable through the
 * SAME mechanism regardless of input device — see _wireMatrixInfo().
 */
function _matrixCell(upt, countsByLokasi, groupStart) {
  const judul = upt._kantor ? `${upt.nama} (${upt.upt})` : upt.upt;
  const startCls = groupStart ? " dash-matrix-group-start" : "";
  const c = countsByLokasi[upt.upt];
  const n = c ? c.so + c.tso : 0;

  if (!n) {
    return `<td class="dash-matrix-cell-zero${startCls}" data-tip="${spekEscape(judul)}: 0 aset" tabindex="0"></td>`;
  }

  const soCount = c.so;
  const tsoCount = c.tso;

  if (n === 1) {
    const isSo = soCount > 0;
    return `<td class="text-center px-2 rounded font-bold${startCls} ${
      isSo ? "bg-green-100 dark:bg-green-900/40" : "bg-red-100 dark:bg-red-900/40"
    }" data-tip="${spekEscape(judul)}: ${isSo ? "SO" : "TSO"}" tabindex="0">${soCount}/${tsoCount}</td>`;
  }

  const allSo = tsoCount === 0;
  const allTso = soCount === 0;
  const cellClass = allSo
    ? "bg-green-100 dark:bg-green-900/40 text-green-700"
    : allTso
      ? "bg-red-100 dark:bg-red-900/40 text-red-700"
      : "matrix-cell-mixed";

  return `<td class="text-center px-2 rounded font-bold ${cellClass}${startCls}" data-tip="${spekEscape(judul)}: ${soCount} SO / ${tsoCount} TSO" tabindex="0">${soCount}/${tsoCount}</td>`;
}

/** A column slot this region simply does not have (fewer UPTs in that branch
 *  than the widest region needs). Structural, not data — no text, no tap
 *  target, no tooltip; there is nothing to say about it. */
function _matrixSlotEmptyCell(groupStart) {
  return `<td class="dash-matrix-slot-empty${groupStart ? " dash-matrix-group-start" : ""}" aria-hidden="true"></td>`;
}

/**
 * One delegated listener for the whole table, wired once (thead/tbody are
 * replaced wholesale on every render, but the <table> element itself is
 * not). Reads `data-tip` off whatever cell was hovered, tapped, or
 * keyboard-focused and writes it into #dash-matrix-info — the SAME
 * mechanism for a mouse, a finger and a keyboard, because `title` tooltips
 * never fire on touch at all.
 */
function _wireMatrixInfo(table) {
  if (!table || table.dataset.infoWired) return;
  table.dataset.infoWired = "1";
  const info = document.getElementById("dash-matrix-info");
  if (!info) return;
  const hint = info.textContent.trim();
  const show = (e) => {
    const cell = e.target.closest("[data-tip]");
    if (!cell) return;
    info.textContent = cell.dataset.tip;
    info.classList.add("is-active");
  };
  table.addEventListener("mouseover", show);
  table.addEventListener("focusin", show);
  table.addEventListener("click", show);
  table.addEventListener("mouseleave", () => {
    info.textContent = hint;
    info.classList.remove("is-active");
  });
}

function _renderMatrixPanel(agg, hir) {
  const table = document.getElementById("dash-matrix-table");
  const thead = document.getElementById("dash-matrix-thead");
  const tbody = document.getElementById("dash-matrix-tbody");
  if (!thead || !tbody) return;
  _wireMatrixInfo(table);

  // Raw per-code counts, NOT rolled up: the matrix sums only the resorts it
  // actually draws, so an asset sitting directly on a parent code is
  // deliberately absent from the row it would otherwise inflate.
  const countsByLokasi = agg.per_lokasi || {};

  // FIX 3: Jangan membuang BALAIYASA. Gunakan seluruh lokasiData.
  let regions = lokasiData.filter((r) => (r.tipe || "").toUpperCase() !== "BALAIYASA");

  // KANTOR WILAYAH — the region's own code, as its own column.
  //
  // 680 of the seeded fleet's 1,077 assets (63%) carry a PARENT code as their
  // `id_lokasi` — D1 alone holds 87, DIVRE VIII and VIV 66 each — rather than a
  // resort code like JR1.3. The matrix sums only the resorts it draws, so all
  // 680 were absent from every row and the table totalled 397 while the KPI
  // strip directly above it said 1,077. The panel was under-reporting by nearly
  // two thirds and nothing on screen said so.
  //
  // This column is where those assets live. It is deliberately NOT one of the
  // branch groups below — it is a different kind of place — and it is omitted
  // entirely when a JR/JB/ME branch filter is active, because an asset
  // registered at the wilayah office has no branch and folding it into "JR"
  // would put non-JR machines under a JR heading.
  const uptTipe = (_dashFilterFor("matrix").uptTipe || "").toUpperCase();
  const adaKantor = !uptTipe;

  // Masukkan UPT ke region induk masing-masing, filtered by branch (if any)
  // and sorted naturally within each region — the same natural-order
  // comparator the app already uses for UPT labels everywhere else.
  const uptByParent = {};
  regions.forEach((r) => {
    uptByParent[r.code] = [];
  });
  uptDatabase.forEach((u) => {
    if (!u.lokasi || !uptByParent[u.lokasi] || u.lokasi === u.upt) return;
    const branch = _branchOf(u.upt);
    if (uptTipe && branch !== uptTipe) return;
    uptByParent[u.lokasi].push(u);
  });
  Object.values(uptByParent).forEach((arr) => arr.sort((a, b) => compareNaturalLabel(a.upt, b.upt)));

  // Every code actually DRAWN for a region — KW plus its own (branch-
  // filtered) UPTs — independent of how those are laid out into columns.
  // Totals, the flag count and the per-slot cells all key off this same
  // list, so a row's summary can never disagree with what its own cells show.
  const drawnCodesFor = (region) => {
    const codes = uptByParent[region.code].map((u) => u.upt);
    if (adaKantor) codes.push(region.code);
    return codes;
  };

  let theadHtml;
  let colCount;
  let buildRowCells;

  if (adaKantor) {
    // GROUPED MODE (Semua branches): fixed-width column BLOCKS per branch, so
    // column N means the same branch-slot on every row — a region with 3 JR
    // and a region with 9 JR both start their JR block in the same place —
    // instead of a region's own UPT count deciding what each numbered column
    // holds, which is what made mixed JR/JB/ME columns unreadable before.
    const BRANCHES = ["JR", "JB", "ME"];
    const byRegionBranch = {};
    regions.forEach((r) => {
      const buckets = { JR: [], JB: [], ME: [] };
      uptByParent[r.code].forEach((u) => {
        const b = _branchOf(u.upt);
        if (b) buckets[b].push(u);
      });
      byRegionBranch[r.code] = buckets;
    });
    const maxByBranch = {};
    BRANCHES.forEach((b) => {
      maxByBranch[b] = Math.max(0, ...regions.map((r) => byRegionBranch[r.code][b].length));
    });
    const groups = BRANCHES.filter((b) => maxByBranch[b] > 0).map((b) => ({
      key: b,
      label: b,
      n: maxByBranch[b],
    }));

    const groupRow = groups
      .map((g) => `<th colspan="${g.n}" class="dash-matrix-group-th">${g.label}</th>`)
      .join("");
    const numRow = groups
      .map((g) =>
        Array.from(
          { length: g.n },
          (_, i) =>
            `<th class="text-center text-gray-400 dark:text-gray-500 px-2${i === 0 ? " dash-matrix-group-start" : ""}">${i + 1}</th>`,
        ).join(""),
      )
      .join("");

    theadHtml = `<tr>
        <th class="text-center sticky left-0 bg-white dark:bg-gray-800 z-10 pr-3 min-w-[110px]" rowspan="2">Wilayah</th>
        <th class="text-center text-kai-blue dark:text-blue-400 px-2 dash-matrix-group-start" rowspan="2"
            data-tip="Kantor Wilayah — aset yang terdaftar langsung di kode wilayah, bukan di salah satu resort" tabindex="0">KW</th>
        ${groupRow}
        <th class="text-center text-gray-500 px-2 border-l border-gray-200 dark:border-gray-700" rowspan="2">Total</th>
        <th class="text-center text-green-600 px-2" rowspan="2">SO</th>
        <th class="text-center text-red-500 px-2" rowspan="2">TSO</th>
        <th class="text-center text-kai-blue px-2" rowspan="2">Ada%</th>
        <th class="text-center text-amber-500 px-2" rowspan="2" aria-label="Perlu perhatian"
            title="Aset yang perlu tindakan: TSO, kalibrasi jatuh tempo, atau sedang di balaiyasa">⚑</th>
      </tr>
      <tr>${numRow}</tr>`;

    colCount = 1 + groups.reduce((s, g) => s + g.n, 0); // +1 for KW

    buildRowCells = (region) => {
      const buckets = byRegionBranch[region.code];
      const cells = [
        _matrixCell(
          { upt: region.code, nama: `Kantor ${region.tipe || "Wilayah"}`, lokasi: region.code, _kantor: true },
          countsByLokasi,
          true,
        ),
      ];
      groups.forEach((g) => {
        for (let i = 0; i < g.n; i++) {
          const upt = buckets[g.key][i];
          const groupStart = i === 0;
          cells.push(upt ? _matrixCell(upt, countsByLokasi, groupStart) : _matrixSlotEmptyCell(groupStart));
        }
      });
      return cells.join("");
    };
  } else {
    // SINGLE-BRANCH MODE — one flat, ungrouped set of columns; nothing to
    // separate when only one branch is on screen at all.
    const maxUpt = Math.max(1, ...regions.map((r) => uptByParent[r.code].length));
    const numRow = Array.from(
      { length: maxUpt },
      (_, i) => `<th class="text-center text-gray-400 dark:text-gray-500 px-2">${i + 1}</th>`,
    ).join("");

    theadHtml = `<tr>
        <th class="text-center sticky left-0 bg-white dark:bg-gray-800 z-10 pr-3 min-w-[110px]">Wilayah</th>
        ${numRow}
        <th class="text-center text-gray-500 px-2 border-l border-gray-200 dark:border-gray-700">Total</th>
        <th class="text-center text-green-600 px-2">SO</th>
        <th class="text-center text-red-500 px-2">TSO</th>
        <th class="text-center text-kai-blue px-2">Ada%</th>
        <th class="text-center text-amber-500 px-2" aria-label="Perlu perhatian"
            title="Aset yang perlu tindakan: TSO, kalibrasi jatuh tempo, atau sedang di balaiyasa">⚑</th>
      </tr>`;

    colCount = maxUpt;

    buildRowCells = (region) => {
      const upts = uptByParent[region.code];
      return Array.from({ length: maxUpt }, (_, i) => {
        const upt = upts[i];
        return upt ? _matrixCell(upt, countsByLokasi, false) : _matrixSlotEmptyCell(false);
      }).join("");
    };
  }

  thead.innerHTML = theadHtml;

  // Body Table
  const rowsHtml = regions
    .map((region) => {
      const codes = drawnCodesFor(region);

      // Hitung SO dan TSO secara ketat hanya dari kode yang divisualisasikan
      let regionSo = 0;
      let regionTso = 0;
      codes.forEach((code) => {
        const c = countsByLokasi[code];
        if (!c) return;
        regionSo += c.so;
        regionTso += c.tso;
      });
      const total = regionSo + regionTso;

      const avail = total > 0 ? Math.round((regionSo / total) * 100) : null;
      const availStr = avail !== null ? `${avail}%` : "—";

      // Replaces the Benchmark Δ, which compared this region against a
      // hardcoded 59% that no screen in the app could ever set. The flag counts
      // machines in this region that need somebody to do something today, summed
      // over exactly the codes this row draws — the same rule regionSo/regionTso
      // follow, so the flag can never disagree with the row it sits on.
      let flagN = 0;
      if (hir && hir.per_lokasi) {
        codes.forEach((code) => {
          flagN += hir.per_lokasi[code]?.perhatian || 0;
        });
      }
      const flagStr = flagN
        ? `<span class="badge badge-warn" title="${flagN} aset perlu tindakan di ${region.name}">${flagN}</span>`
        : `<span class="text-gray-300 dark:text-gray-600">—</span>`;

      return `<tr class="border-t border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30">
          <td class="text-left sticky left-0 bg-white dark:bg-gray-800 z-10 font-bold text-gray-700 dark:text-gray-300 pr-3 py-1.5 text-xs">${spekEscape(region.name)}</td>
          ${buildRowCells(region)}
          <td class="text-center px-2 font-bold text-gray-700 dark:text-gray-300 border-l border-gray-200 dark:border-gray-700">${total || "—"}</td>
          <td class="text-center px-2 font-bold text-green-600">${regionSo || "—"}</td>
          <td class="text-center px-2 font-bold text-red-500">${regionTso || "—"}</td>
          <td class="text-center px-2 font-bold text-kai-blue dark:text-blue-400">${availStr}</td>
          <td class="text-center px-2">${flagStr}</td>
      </tr>`;
    })
    .join("");

  tbody.innerHTML = rowsHtml;

  if (!rowsHtml.trim()) {
    // Wilayah(1) + [KW + branch groups, or the flat single-branch columns] + Total/SO/TSO/Ada%/Flag(5)
    tbody.innerHTML =
      `<tr><td colspan="${1 + colCount + 5}" class="empty-state">Tidak ada wilayah yang terdaftar.</td></tr>`;
  }
}

// ── PANEL: Availability Rate per Lokasi ───────────────────────────────────
function _renderAvailPanel(agg) {
  const canvas = document.getElementById("dash-chart-avail");
  if (!canvas) return;

  // Use non-BALAIYASA lokasi, same as matrix
  const regions = lokasiData.filter(
    (r) => (r.tipe || "").toUpperCase() !== "BALAIYASA"
  );

  // Rolled up UPT → parent, exactly as this panel always did it.
  const byLokasi = _rollUpLokasi(agg.per_lokasi);

  // Build labels and availability rates
  const labels = [];
  const rates = [];

  regions.forEach((r) => {
    const c = byLokasi[r.code] || { so: 0, tso: 0 };
    const total = c.so + c.tso;
    const rate = total > 0 ? Math.round((c.so / total) * 100) : 0;
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
function _renderBarPanel(agg) {
  const canvas = document.getElementById("dash-chart-bar");
  if (!canvas) return;

  const regions = lokasiData.filter((r) => (r.tipe || "").toUpperCase() !== "BALAIYASA");
  const byLokasi = _rollUpLokasi(agg.per_lokasi);

  const labels = [],
    soData = [],
    tsoData = [];
  regions.forEach((r) => {
    const c = byLokasi[r.code] || { so: 0, tso: 0 };
    labels.push(r.name.replace("DAOP ", "D").replace("DIVRE ", "DR"));
    soData.push(c.so);
    tsoData.push(c.tso);
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
function _renderTrendPanel(agg) {
  const canvas = document.getElementById("dash-chart-trend");
  if (!canvas) return;

  // This tab's own year. It is never "" — _renderDashFilterRow seeds it with
  // the newest year that holds data, because the chart is twelve months of ONE
  // year and has nothing to draw for "Semua Tahun". The previous code accepted
  // an empty value and silently substituted the current calendar year, which
  // read as the filter being ignored.
  const selectedYear =
    _dashFilterFor("trend").tahun || String(new Date().getFullYear());
  const months = BULAN_PANJANG;

  // Assets by PURCHASE month and current status. This has always been what the
  // panel plots: it read `item.waktu_update || item.tanggal_pembelian`, and
  // /api/aset has never carried a `waktu_update`, so the first half never fired.
  // `per_bulan` groups the same thing server-side, under the same tab filter.
  const monthSo = new Array(12).fill(0);
  const monthTso = new Array(12).fill(0);

  (agg.per_bulan || []).forEach((r) => {
    if (String(r.tahun) !== selectedYear) return;
    const mo = r.bulan - 1;
    if (mo < 0 || mo > 11) return;
    monthSo[mo] += r.so;
    monthTso[mo] += r.tso;
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

/**
 * Keep the KPI strip honest about what it is counting.
 *
 * The strip sits ABOVE the tabs, so with per-tab filters it has to say which
 * tab's filter it is following — otherwise "Total 250" over a panel showing the
 * whole fleet is simply a wrong number with no way to tell.
 *
 * Laporan Perbaikan and Kurva MCF filter by LOKASI, not by alat kerja, so the
 * strip cannot follow them at all; it shows unfiltered fleet totals and says so.
 */
// ══════════════════════════════════════════════════════════════════════
// THE LETTERHEAD BANNER
// ══════════════════════════════════════════════════════════════════════
//
// The blue KAI/BUMN letterhead used to live inside #dash-panel-perbaikan, so
// five of the six tabs had no header at all. It sits above the tab strip now
// and every tab names itself in it.
//
// TWO PUBLISHERS, ONE WRITER. _syncDashBanner() is the only function that
// touches the three elements. The four computed tabs get their sub-line from
// their own filter state; Laporan Perbaikan and Kurva MCF instead publish the
// region label and dateline their endpoint resolved, through
// window.setDashBanner(), and _syncDashBanner() reads that back. Two functions
// writing the same node directly is the bug this shape avoids — the loser
// would depend on which fetch resolved last.
const _DASH_BANNER = {
  matrix: { judul: "Matriks Kesiapan" },
  bar: { judul: "Grafik Ketersediaan" },
  avail: { judul: "Ketersediaan per Lokasi" },
  trend: { judul: "Tren Perbaikan" },
  perbaikan: { judul: "Laporan Perbaikan", dariRepair: true },
  mcf: { judul: "Kurva MCF", dariRepair: true },
};

// What repair-dashboard.js last published. Held rather than written straight
// through, because that tab's load() resolves AFTER _syncDashBanner() has
// already run for it — without a cache the first paint would show a stale
// sub-line until the next tab switch.
let _dashBannerRepair = { sub: "", dateline: "" };

/**
 * Publish the repair report's own region + dateline into the shared banner.
 * Called from js/views/repair-dashboard.js once its payload resolves.
 */
function setDashBanner({ sub, dateline } = {}) {
  _dashBannerRepair = {
    sub: sub || _dashBannerRepair.sub,
    dateline: dateline || _dashBannerRepair.dateline,
  };
  _syncDashBanner(_DASH_TABS[_dashTabIndex]);
}
window.setDashBanner = setDashBanner;

/** The filter triple as a sentence — lifted out of the deleted "Menghitung:"
 *  caption, whose information belongs in the header, not in a footnote. */
function _dashScopeLabel(tabId) {
  const f = _dashFilterFor(tabId);
  const bits = [];
  if (f.alat) {
    bits.push(alatKerjaData.find((a) => a.code === f.alat)?.name || f.alat);
  }
  if (f.pengadaan) bits.push(f.pengadaan === "1" ? "PUSAT" : "DAOP / DIVRE");
  if (f.tahun) bits.push(`tahun ${f.tahun}`);
  return bits.length ? bits.join(" · ") : "seluruh armada";
}

function _syncDashBanner(tabId) {
  const spec = _DASH_BANNER[tabId];
  const elJudul = document.getElementById("dash-banner-title");
  const elSub = document.getElementById("dash-banner-sub");
  const elTgl = document.getElementById("dash-banner-dateline");
  if (!spec || !elJudul || !elSub || !elTgl) return;

  elJudul.textContent = spec.judul;

  if (spec.dariRepair) {
    elSub.textContent = _dashBannerRepair.sub || "Semua Daerah Operasi";
    elTgl.textContent = _dashBannerRepair.dateline || "—";
    return;
  }
  elSub.textContent = _dashScopeLabel(tabId);
  const now = new Date();
  elTgl.textContent =
    `Bandung, ${now.getDate()} ${BULAN_PANJANG[now.getMonth()]} ${now.getFullYear()}`;
}

async function updateDashboardStats() {
  _wireDashChrome();

  // The strip belongs to the Matriks panel now and is scoped by THAT tab's
  // filter, whichever tab happens to be showing. It used to follow the active
  // tab, which is exactly why it needed a caption underneath explaining which
  // tab it was obeying; a strip that lives inside one panel does not have that
  // question to answer.
  //
  // Paint from whatever is cached and do NOT await the attention rollup here:
  // this function runs at login (js/shell.js) and after every mutation
  // (js/api.js), and _renderDashActivePanel() below fetches and repaints for
  // real when the Matriks tab is the one on screen.
  const fMatrix = _dashFilterFor("matrix");
  _renderDashKpiStrip(await getRingkasan(fMatrix), hirarkiIfLoaded(fMatrix));

  _renderDashActivePanel();
}
