// ═══════════════════════════════════════════════════════════════════════
// Dashboard tabs: matrix, availability, bar and trend panels.
//
// Part of the RAMCES frontend. These files are plain classic scripts
// loaded in a fixed order by index.html - no bundler, no modules. They
// share one global scope, so a top-level `let` or `const` declared twice
// across two files is a fatal SyntaxError; see CLAUDE.md.
// ═══════════════════════════════════════════════════════════════════════

// ── DASHBOARD STATE ────────────────────────────────────────────────────────
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
  matrix: { alat: "", pengadaan: "", tahun: "" },
  bar: { alat: "", pengadaan: "", tahun: "" },
  avail: { alat: "", pengadaan: "", tahun: "" },
  // Trend plots twelve months of ONE year, so its `tahun` is never "" —
  // _renderDashFilterRow seeds it with the newest year that holds data.
  trend: { alat: "", pengadaan: "", tahun: "" },
};

// `legend` is rendered to the right of the controls. Only the matrix gets the
// four-swatch key: it is the only panel that paints cells by status, and the
// Chart.js panels draw their own legends from the series they actually plot.
const _DASH_FILTER_SPEC = {
  matrix: {
    fields: ["alat", "pengadaan", "tahun"],
    legend: `
      <span class="dash-key"><span class="dash-swatch bg-green-500"></span>SO — Siap Operasi</span>
      <span class="dash-key"><span class="dash-swatch bg-red-500"></span>TSO — Tidak Siap</span>
      <span class="dash-key"><span class="dash-swatch bg-gradient-to-br from-green-300 to-red-300"></span>Lebih dari 1 unit</span>
      <span class="dash-key"><span class="dash-swatch border border-gray-300 dark:border-gray-600"></span>— Tidak ada alat</span>`,
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

function _dashFilteredDb(tabId) {
  const f = _dashFilterFor(tabId);
  return db.filter((item) => {
    if (f.alat && item.kode_alat !== f.alat) return false;

    // The dropdown's values are the ID segments "1"/"2"; canonicalPengadaan
    // maps those and every stored spelling onto the same two constants. The
    // old code mapped "2" to the literal "DAOP" and then substring-tested it,
    // so any asset stored as plain "DIVRE" was silently excluded.
    if (!_pengadaanMatches(item.sumber_pengadaan, f.pengadaan)) return false;

    if (f.tahun && String(item.tanggal_pembelian ?? "").slice(0, 4) !== f.tahun)
      return false;

    return true;
  });
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
function _renderDashFilterRow(tabId) {
  const mount = document.getElementById(`dash-filters-${tabId}`);
  const spec = _DASH_FILTER_SPEC[tabId];
  if (!mount || !spec) return;

  const f = _dashFilterFor(tabId);
  // Counts are scoped to this tab's OTHER filters, so the year list answers
  // "how many of what I am currently looking at", not "how many in the fleet".
  const scoped = db.filter(
    (item) =>
      (!f.alat || item.kode_alat === f.alat) &&
      _pengadaanMatches(item.sumber_pengadaan, f.pengadaan),
  );
  const counts = _yearCounts(scoped);

  const SELECT_CLASS =
    "text-xs px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-600 " +
    "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 outline-none " +
    "focus:border-kai-blue transition min-h-[38px]";

  const controls = [];
  if (spec.fields.includes("alat")) {
    controls.push(
      `<select data-dash-field="alat" aria-label="Filter alat kerja"
               class="${SELECT_CLASS} min-w-[150px]">
         <option value="">Semua Alat Kerja</option>
         ${alatKerjaData
           .map(
             (a) =>
               `<option value="${a.code}"${a.code === f.alat ? " selected" : ""}>${spekEscape(a.name)}</option>`,
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

  mount.className =
    "dash-filter-row flex flex-col sm:flex-row sm:items-center gap-3 mb-4 " +
    "pb-3 border-b border-gray-100 dark:border-gray-700/60";
  mount.innerHTML =
    `<div class="flex flex-wrap gap-2 flex-1 min-w-0">${controls.join("")}</div>` +
    (spec.legend
      ? `<div class="flex flex-wrap gap-x-4 gap-y-1 text-[11px] shrink-0
                     text-gray-600 dark:text-gray-300">${spec.legend}</div>`
      : "");

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
  }
}

// Tab navigation. Wired once; the filter rows wire themselves per tab.
function _wireDashChrome() {
  if (window._dashChromeWired) return;
  window._dashChromeWired = true;

  document.querySelectorAll(".dash-tab-btn").forEach((btn, i) => {
    btn.addEventListener("click", () => _switchDashTab(i));
  });

  document
    .getElementById("dash-tab-prev")
    ?.addEventListener("click", () =>
      _switchDashTab((_dashTabIndex - 1 + _DASH_TABS.length) % _DASH_TABS.length),
    );
  document
    .getElementById("dash-tab-next")
    ?.addEventListener("click", () =>
      _switchDashTab((_dashTabIndex + 1) % _DASH_TABS.length),
    );

  document.querySelectorAll(".dash-dot").forEach((dot) => {
    dot.addEventListener("click", () => _switchDashTab(parseInt(dot.dataset.dot)));
  });
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
  // Only the ACTIVE tab's row is rebuilt. The others keep their DOM and their
  // selection, which is what makes the filters independent per tab rather than
  // four copies of one shared value.
  _renderDashFilterRow(tabId);
  _syncDashKpiScope(tabId);

  if (tabId === "matrix") _renderMatrixPanel();
  if (tabId === "bar") _renderBarPanel();
  if (tabId === "avail") _renderAvailPanel();
  if (tabId === "trend") _renderTrendPanel();
  // Unlike the computed panels, these two are server-driven rather than derived
  // from the cached `db` array, so they fetch on activation. Both are filled by
  // the same load() inside repair-dashboard.js.
  if (tabId === "perbaikan" || tabId === "mcf") window.initRepairDashboard?.();
}

// ── PANEL 1: Matrix ────────────────────────────────────────────────────────
function _renderMatrixPanel() {
  const thead = document.getElementById("dash-matrix-thead");
  const tbody = document.getElementById("dash-matrix-tbody");
  if (!thead || !tbody) return;

  const filtered = _dashFilteredDb("matrix");

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

  const filtered = _dashFilteredDb("avail");

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

  const filtered = _dashFilteredDb("bar");
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

  // This tab's own year. It is never "" — _renderDashFilterRow seeds it with
  // the newest year that holds data, because the chart is twelve months of ONE
  // year and has nothing to draw for "Semua Tahun". The previous code accepted
  // an empty value and silently substituted the current calendar year, which
  // read as the filter being ignored.
  const selectedYear =
    _dashFilterFor("trend").tahun || String(new Date().getFullYear());
  const months = BULAN_PANJANG;

  // Count perbaikan per month from db riwayat — we derive from latest_date in history summary
  // Use db directly: each item has repair.latest_date — for full tren we need per-month count
  // Since frontend db doesn't carry full riwayat, we approximate from `db` entries that were
  // updated in each month. For a full chart, wire to /api/export/riwayat — lazy-fetch here.
  const monthSo = new Array(12).fill(0);
  const monthTso = new Array(12).fill(0);

  // Was `db.forEach` — the panel ignored its own alat and pengadaan filters
  // entirely, so narrowing to one tool type changed the dropdown and nothing
  // else on the chart.
  _dashFilteredDb("trend").forEach((item) => {
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
function _syncDashKpiScope(tabId) {
  const el = document.getElementById("dash-kpi-scope");
  if (!el) return;

  if (!_DASH_FILTER_SPEC[tabId]) {
    el.textContent = "seluruh armada — tab ini memakai filter Lokasi sendiri";
    return;
  }
  const f = _dashFilterFor(tabId);
  const bits = [];
  if (f.alat) {
    const nama = alatKerjaData.find((a) => a.code === f.alat)?.name || f.alat;
    bits.push(nama);
  }
  if (f.pengadaan) bits.push(f.pengadaan === "1" ? "PUSAT" : "DAOP / DIVRE");
  if (f.tahun) bits.push(`tahun ${f.tahun}`);
  el.textContent = bits.length ? bits.join(" · ") : "seluruh armada";
}

function updateDashboardStats() {
  _wireDashChrome();

  // The headline follows the ACTIVE tab's filter, so the numbers above the
  // panel and the panel itself can never disagree. Tabs with no alat/pengadaan
  // filter of their own (perbaikan, mcf) fall back to the whole fleet.
  const tabId = _DASH_TABS[_dashTabIndex];
  const filtered = _DASH_FILTER_SPEC[tabId] ? _dashFilteredDb(tabId) : db;

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

  _renderDashActivePanel();
}
