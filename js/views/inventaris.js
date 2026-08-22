// ═══════════════════════════════════════════════════════════════════════
// Kelola Inventaris: dashboard, catalogue, movements and transfers.
// 
// Loaded LAST: unlike the other IIFEs this one caches its DOM nodes at
// eval time, so the markup must already exist.
//
// Part of the RAMCES frontend. These files are plain classic scripts
// loaded in a fixed order by index.html - no bundler, no modules. They
// share one global scope, so a top-level `let` or `const` declared twice
// across two files is a fatal SyntaxError; see CLAUDE.md.
// ═══════════════════════════════════════════════════════════════════════

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
  const tabHirarki = el("inv-tab-hirarki");
  const panelHirarki = el("inv-panel-hirarki");
  const tabOpname = el("inv-tab-opname");
  const panelOpname = el("inv-panel-opname");
  const hirarkiAlat = el("inv-hirarki-alat");
  const hirarkiTree = el("inv-hirarki-tree");
  const hirarkiCakupan = el("inv-hirarki-cakupan");
  const toolbar = el("inv-toolbar");
  const toolbarActions = el("inv-toolbar-actions");
  const searchInput = el("inv-parts-search");

  // ── Tab switching ─────────────────────────────────────────────────
  const ALL_TABS = [
    { btn: tabDash, panel: panelDash, id: "dashboard" },
    { btn: tabParts, panel: panelParts, id: "parts" },
    { btn: tabTransaksi, panel: panelTransaksi, id: "transaksi" },
    { btn: tabTransfer, panel: panelTransfer, id: "transfer" },
    { btn: tabHirarki, panel: panelHirarki, id: "hirarki" },
    { btn: tabOpname, panel: panelOpname, id: "opname" },
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
    const noToolbar =
      which === "dashboard" || which === "transaksi" || which === "hirarki" ||
      which === "opname";
    toolbar?.classList.toggle("hidden", noToolbar);
    toolbarActions?.classList.toggle("hidden", noToolbar);

    // ⚠️ Role gating has to survive this.
    //
    // These four ids also carry `data-write="inventaris"`, so applyRoleGating()
    // hides them for a read-only role — and then the un-hide below would put
    // them straight back the moment that user opened the Parts tab. A tab
    // switcher must never be able to grant a control the role gate removed, so
    // both conditions are ANDed. The server refuses regardless, but a button
    // that appears and 403s is worse than one that never appears.
    const mayWrite = window.canWrite ? canWrite("inventaris") : true;
    const partsOnly = which === "parts" && mayWrite;
    ["inv-btn-add-part", "inv-btn-parts-category", "inv-btn-gudang"].forEach((id) =>
      el(id)?.classList.toggle("hidden", !partsOnly),
    );
    el("inv-btn-bulk-toggle")?.closest(".relative")?.classList.toggle("hidden", !partsOnly);
    el("inv-btn-transfer")?.classList.toggle(
      "hidden",
      !mayWrite || (which !== "parts" && which !== "transfer"),
    );

    if (searchInput) searchInput.value = "";
    if (which === "dashboard") loadStockDashboard();
    if (which === "parts") { loadInvParts(); loadInvKategoriOptions(); loadGudangOptions(); }
    if (which === "transaksi") { loadPartCatalog(); loadLedger({ reset: true }); }
    if (which === "transfer") loadInvTransfer();
    if (which === "hirarki") loadInvHirarki();
    if (which === "opname") loadOpname();
  }

  ALL_TABS.forEach(({ btn, id }) => btn?.addEventListener("click", () => setInvTab(id)));

  // ══════════════════════════════════════════════════════════════════
  // FLOW HEADER — the ordered prerequisite chain
  // ══════════════════════════════════════════════════════════════════
  //
  // gudang → kategori → sparepart → pergerakan → stok. The four tabs above
  // present this as four peers, so the ordering was invisible; the concrete
  // failure is that with NO warehouse the movement form has nothing to write
  // `id_gudang` to and refuses every submit without saying why.
  //
  // This marks the first incomplete step and links straight to the control that
  // completes it. Once every step is satisfied the whole strip hides itself —
  // it is scaffolding for an empty system, not permanent chrome.
  //
  // Nodes are looked up lazily, NOT cached at eval time like the tab elements
  // above: the strip is re-rendered on every REFRESH_INVENTARIS.

  const INV_FLOW_DISMISSED = "invFlowDismissed";

  const INV_FLOW_STEPS = [
    {
      key: "gudang",
      label: "Gudang",
      count: () => _gudangList.length,
      hint: "Buat minimal satu gudang — tanpa itu, form pergerakan tidak punya tujuan dan setiap simpan akan ditolak.",
      go: () => openGudangModal(),
      cta: "Buka Kelola Gudang",
    },
    {
      key: "kategori",
      label: "Kategori",
      count: () => _categories.length,
      hint: "Tambahkan kategori suku cadang agar katalog bisa dikelompokkan.",
      go: () => { setInvTab("parts"); el("inv-btn-parts-category")?.click(); },
      cta: "Buka Kelola Kategori",
    },
    {
      key: "sparepart",
      label: "Suku Cadang",
      count: () => _partsRows.length,
      hint: "Daftarkan suku cadang beserta stok awalnya pada sebuah gudang.",
      go: () => { setInvTab("parts"); el("inv-btn-add-part")?.click(); },
      cta: "Tambah Suku Cadang",
    },
    {
      key: "pergerakan",
      // `_ledgerTotal` is only populated once the Transaksi tab has been
      // opened, so reading it alone made a fully-stocked system report its
      // last step as incomplete on every first visit. `_flowLedgerTotal` is
      // fetched once at boot for exactly this, and the larger of the two wins
      // so a later real load always takes precedence.
      label: "Pergerakan",
      count: () => Math.max(_ledgerTotal || 0, _flowLedgerTotal || 0),
      hint: "Catat pergerakan masuk/keluar; saldo stok dihitung dari catatan ini, bukan disimpan sebagai angka.",
      go: () => setInvTab("transaksi"),
      cta: "Buka Transaksi Barang",
    },
  ];

  // Ledger row count, for the flow header only. `limit=1` because the envelope
  // carries `total` and the rows themselves are not wanted here.
  let _flowLedgerTotal = 0;

  async function loadFlowLedgerCount() {
    try {
      const res = await apiFetch("/inventaris/stok?limit=1", { background: true });
      if (!res.ok) return;
      const payload = await res.json();
      _flowLedgerTotal = payload.total || 0;
    } catch (_) {
      /* the flow header degrades to "step incomplete", which is safe */
    }
  }

  function renderInvFlow() {
    const wrap = el("inv-flow");
    const list = el("inv-flow-steps");
    if (!wrap || !list) return;

    if (localStorage.getItem(INV_FLOW_DISMISSED) === "1") {
      wrap.hidden = true;
      return;
    }

    const states = INV_FLOW_STEPS.map((s) => ({ ...s, n: s.count() || 0 }));
    const firstIncomplete = states.findIndex((s) => s.n === 0);

    // Nothing to guide once the chain is complete.
    if (firstIncomplete === -1) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;

    list.innerHTML = states
      .map((s, i) => {
        const done = s.n > 0;
        const active = i === firstIncomplete;
        const tone = done
          ? "bg-emerald-500 text-white border-emerald-500"
          : active
            ? "bg-kai-orange text-white border-kai-orange"
            : "bg-transparent text-gray-400 border-gray-300 dark:border-gray-600";
        const label = done
          ? `${s.label} (${s.n})`
          : active
            ? `<strong>${s.label}</strong>`
            : s.label;
        const sep = i
          ? '<li aria-hidden="true" class="text-gray-300 dark:text-gray-600 px-1"><i class="fas fa-chevron-right text-[9px]"></i></li>'
          : "";
        const mark = done ? '<i class="fas fa-check text-[9px]"></i>' : i + 1;
        return `${sep}<li class="flex items-center gap-1.5 text-xs ${done ? "text-gray-500 dark:text-gray-400" : active ? "text-gray-800 dark:text-gray-100" : "text-gray-400"}">
            <span class="inline-flex items-center justify-center w-4 h-4 rounded-full border text-[9px] font-bold ${tone}">${mark}</span>
            <span>${label}</span>
          </li>`;
      })
      .join("");

    const step = states[firstIncomplete];
    const hint = el("inv-flow-hint");
    if (hint) {
      hint.innerHTML =
        `${window.spekEscape ? window.spekEscape(step.hint) : step.hint} ` +
        `<button type="button" id="inv-flow-go" class="font-bold text-kai-blue dark:text-blue-400 underline">${step.cta}</button>`;
      // Re-bound every render because the innerHTML above replaces the node,
      // so no listener can accumulate.
      el("inv-flow-go")?.addEventListener("click", () => step.go());
    }
  }

  el("inv-flow-dismiss")?.addEventListener("click", () => {
    localStorage.setItem(INV_FLOW_DISMISSED, "1");
    const wrap = el("inv-flow");
    if (wrap) wrap.hidden = true;
  });

  window.renderInvFlow = renderInvFlow;

  // ══════════════════════════════════════════════════════════════════
  // DASBOR INVENTARIS — stock dashboard
  // ══════════════════════════════════════════════════════════════════

  // The five Items Master states, in severity order, rolled into three bands.
  //
  // Bands exist because the part-to-whole bar can carry a few segments legibly;
  // the exact per-status counts live in the counter tiles above it, so no detail
  // is lost. Each tile inherits its band's tone and adds its own icon and label —
  // `warning` and `serious` sit below 3:1 on a white surface, so colour must
  // never carry the meaning on its own.
  //
  // ⚠️ There is no `atasmax` band, and that is deliberate. It used to sit here
  // as a fourth segment while the matching "DI ATAS MAX" tile had already been
  // removed from STOK_STATUS_META below — so `bandTotals` summed an empty filter
  // and the chart carried a segment, and the legend an entry, that were 0 on
  // every single load. A category that is structurally incapable of being
  // non-zero reads as real data and is worse than no category at all.
  // `SparePart` has no `stok_max` column; see `_stok_status()` in
  // api/inventaris.py.
  const STOK_BANDS = [
    { key: "bermasalah", label: "Bermasalah", tone: "critical" },
    { key: "perhatian", label: "Perlu Perhatian", tone: "warning" },
    { key: "aman", label: "Aman", tone: "good" },
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
    // "DI ATAS MAX" used to sit here as a sixth tile. `_stok_status()` in
    // api/inventaris.py is only ever called with stok_max=None (there is no
    // stok_max column on SparePart), so the bucket could never be non-zero — a
    // permanent 0 that read as a real category. Its BAND was removed at the same
    // time; removing only one of the two is what left the chart legend still
    // printing "Di Atas Maksimum 0" long after the tile had gone.
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
      .map((g) => `<option value="${g.id_gudang}">${g.kode} — ${g.nama}</option>`)
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
    // Same rule for the opname sheet: a count is always OF one warehouse, so
    // there is no "all warehouses" option to offer. Filled here rather than in
    // loadOpname() so every gudang select in this view is built in one place —
    // the tab previously copied another select's innerHTML, which silently
    // produced an empty list whenever it happened to open first.
    const opname = el("inv-opname-gudang");
    if (opname) {
      const keep = opname.value;
      opname.innerHTML = opts || '<option value="">— Belum ada gudang —</option>';
      if (keep) opname.value = keep;
    }
    // Opening stock on the "Tambah Suku Cadang" modal, and both ends of a
    // transfer. All three write id_gudang, the pool every balance is computed
    // against.
    const awal = el("inv-field-gudang");
    if (awal) {
      const keep = awal.value;
      awal.innerHTML = '<option value="">— Pilih gudang —</option>' + opts;
      awal.value = keep;
    }
    ["inv-tf-asal", "inv-tf-tujuan"].forEach((id) => {
      const sel = el(id);
      if (!sel) return;
      const keep = sel.value;
      sel.innerHTML = opts || '<option value="">— Belum ada gudang —</option>';
      sel.value = keep;
    });
    renderGudangList();
    renderInvFlow();
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
                <p class="text-[10px] text-gray-400">${r.nama_alat || "—"}</p>
              </td>
              <td class="px-3 py-2 text-right tabular-nums text-gray-600 dark:text-gray-300">${r.stok_sekarang} <span class="text-[10px] text-gray-400">${r.unit}</span></td>
              <td class="px-3 py-2 text-right tabular-nums font-semibold text-gray-800 dark:text-white" title="${KAI_VIZ.rupiahFull(r.nilai)}">${KAI_VIZ.rupiah(r.nilai)}</td>
            </tr>`).join("")
        : '<tr><td colspan="4" class="empty-state">Tidak ada data</td></tr>';
    }

    // ── Ringkasan katalog ──
    if (el("sd-total-parts")) el("sd-total-parts").textContent = (d.total_parts ?? 0).toLocaleString("id-ID");
    if (el("sd-total-types")) el("sd-total-types").textContent = (d.total_types ?? 0).toLocaleString("id-ID");
    if (el("sd-auto-demand")) el("sd-auto-demand").textContent = (d.auto_demand ?? 0).toLocaleString("id-ID");

    // ── Perputaran suku cadang (fast / slow / tanpa pergerakan) ──
    //
    // Every row is a link into the history card, because "this part moved 94
    // times" is the beginning of a question, not the end of one.
    const g = d.pergerakan;
    if (g) {
      if (el("sd-fs-window")) {
        el("sd-fs-window").textContent =
          `${g.bulan} bulan terakhir — sejak ${g.sejak}`;
      }
      const fsList = (rows, empty) =>
        rows.length
          ? rows
              .map(
                (r) => `
          <li class="flex items-baseline gap-2 text-[11px]">
            <button type="button" onclick="window.openPartHistory(${r.id_part})"
                class="text-left text-kai-blue dark:text-blue-400 hover:underline truncate min-w-0 flex-1"
                title="${r.nama_part}">${r.nama_part}</button>
            <span class="tabular-nums font-bold text-gray-600 dark:text-gray-300 shrink-0">
              ${r.keluar.toLocaleString("id-ID")}</span>
          </li>`,
              )
              .join("")
          : `<li class="empty-state">${empty}</li>`;

      ["fast", "slow", "diam"].forEach((k) => {
        const cnt = el(`sd-fs-${k}-count`);
        if (cnt) cnt.textContent = (g[`${k}_count`] ?? 0).toLocaleString("id-ID");
      });
      if (el("sd-fs-fast")) el("sd-fs-fast").innerHTML = fsList(g.fast || [], "Belum ada pemakaian.");
      if (el("sd-fs-slow")) el("sd-fs-slow").innerHTML = fsList(g.slow || [], "Belum ada pemakaian.");
      if (el("sd-fs-diam")) el("sd-fs-diam").innerHTML = fsList(g.diam || [], "Semua suku cadang bergerak.");
    }

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
                  <p class="text-[9px] text-gray-400">${r.nama_alat || r.kode_alat || "—"}</p>
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
        : '<tr><td colspan="2" class="empty-state">Semua stok aman</td></tr>';
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
  //
  // `sku` used to guarantee uniqueness for free. Without it the key has to be
  // built from what actually identifies a part: its name, the alat kerja it
  // belongs to, and its Model/Type. That is exactly the triple seed.py dedupes
  // on, so it is unique across the seeded catalogue by construction — which
  // matters, because "BUSI" legitimately recurs once per tool and several times
  // per tool across models, and two identical option labels would silently make
  // one of them unselectable (Map.set keeps only the last).
  //
  // Nothing constrains it in the DB, though, so buildPartKeys() below still
  // disambiguates a genuine collision rather than trusting the invariant.
  const partLabel = (p) =>
    [p.nama_part, p.nama_alat || p.kode_alat, p.nama_varian]
      .filter(Boolean)
      .join(" · ");

  // Labels → parts, with `#<id_part>` appended ONLY to labels that repeat. The
  // suffix is ugly and never appears for the seeded catalogue; it is there so a
  // hand-created duplicate degrades into something still selectable instead of
  // vanishing from the picker.
  function buildPartKeys(list) {
    const counts = new Map();
    list.forEach((p) => {
      const l = partLabel(p);
      counts.set(l, (counts.get(l) || 0) + 1);
    });
    const keyed = new Map();
    list.forEach((p) => {
      const l = partLabel(p);
      keyed.set(counts.get(l) > 1 ? `${l} #${p.id_part}` : l, p);
    });
    return keyed;
  }

  async function loadPartCatalog() {
    // Scoped to the SELECTED warehouse. Fetching unscoped (as this used to)
    // returned the globally pooled `stok_sekarang`, which the hint below then
    // printed as if it were the chosen warehouse's — so the form could read
    // "Stok tercatat 120 Pcs" and the submit still fail with "Tersedia 0 Pcs",
    // because the server validates against the warehouse pool.
    const params = new URLSearchParams();
    const gudangAktif = el("tx-gudang")?.value || _gudangFilter;
    if (gudangAktif) params.set("id_gudang", gudangAktif);
    try {
      const res = await apiFetch(`/inventaris/parts?${params}`, { background: true });
      if (!res.ok) return;
      _partList = await res.json();
    } catch (_) {
      return;
    }
    // One pass builds both the lookup and the option list, so the datalist text
    // and the key can never disagree.
    //
    // The value MUST be escaped. Part names carry inch marks — `MATA GERINDA 4"`
    // and `MATA GERINDA 7"` are real catalogue rows — and an unescaped `"` closes
    // the attribute early, so the browser reported the option value as
    // `MATA GERINDA 4` while the Map key was the full string. selectedPart()
    // then returned null and those two parts could not be issued at all: no
    // error, no empty dropdown, just a form that refused to acknowledge them.
    _partByKey = buildPartKeys(_partList);
    const dl = el("tx-part-list");
    if (dl) {
      dl.innerHTML = [..._partByKey.keys()]
        .map((k) => `<option value="${window.spekEscape(k)}"></option>`)
        .join("");
    }
    syncPartFields();
  }

  function selectedPart(value) {
    const key = (value ?? el("tx-part")?.value ?? "").trim();
    return _partByKey.get(key) || null;
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
      const gudangNama =
        _gudangList.find((g) => String(g.id_gudang) === String(el("tx-gudang")?.value))
          ?.nama || "gudang terpilih";
      el("tx-part-info").textContent = p
        ? `Stok di ${gudangNama}: ${p.stok_sekarang} ${p.unit} · min ${p.stok_min} · ${p.subsistem || "tanpa subsistem"}`
        : "Belum ada barang dipilih.";
    }
    recalcAmount();
  }

  // Changing the warehouse changes the available stock, so the catalogue is
  // refetched for that pool and the hint above re-rendered.
  el("tx-gudang")?.addEventListener("change", () => loadPartCatalog());

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
      renderInvFlow();
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
              <p class="text-[10px] text-gray-400">${r.jenis || "—"}</p>
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
      // The flow header spans all four tabs, so it needs the kategori,
      // sparepart and ledger counts even though the Dashboard tab itself uses
      // none of them. Run in parallel, once, on first entry only.
      await Promise.all([
        loadInvKategoriOptions(),
        loadInvParts(),
        loadFlowLedgerCount(),
      ]);
      setInvTab("dashboard");
      renderInvFlow();
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
    // The warehouse select is refilled by loadGudangOptions(), not here: its
    // contents change whenever a gudang is added, so caching it on first open
    // would leave a newly created warehouse missing from the list.
  }

  // Null when adding, the id_part when editing. PUT /inventaris/parts/{id} and
  // the whole SparePartUpdate schema existed with no UI at all — the row's
  // Aksi column only ever offered delete.
  let _editingPartId = null;

  function openAddModal(part = null) {
    // Only one inventaris modal at a time — these used to be able to stack,
    // leaving two dialogs and two backdrops fighting over the same screen.
    closeCatModal();
    closeGudangModal();
    closeTransferModal();
    _editingPartId = part ? part.id_part : null;

    addModal?.classList.remove("hidden");
    fillAddModalRefSelects();
    loadInvKategoriOptions();
    loadGudangOptions();

    const title = el("inv-add-modal-title");
    const submitLabel = el("inv-add-modal-submit-label");
    if (title) title.textContent = part ? "Ubah Suku Cadang" : "Tambah Suku Cadang";
    if (submitLabel) submitLabel.textContent = part ? "Simpan Perubahan" : "Simpan";

    // Stock fields belong to the OPENING balance, which only makes sense when
    // creating. Editing a part must never silently re-post an opening receipt,
    // so they are disabled rather than merely ignored — a filled-in but
    // discarded field is worse than one that cannot be filled in.
    ["inv-field-quantity", "inv-field-gudang"].forEach((id) => {
      const node = el(id);
      if (node) node.disabled = !!part;
    });
    const stokHint = el("inv-field-gudang")?.closest("div")?.querySelector(".field-label");
    if (stokHint) {
      stokHint.title = part
        ? "Stok hanya bisa diubah lewat tab Transaksi Barang."
        : "";
    }

    if (part) _fillAddModal(part);
  }

  function _fillAddModal(p) {
    const set = (id, val) => { const n = el(id); if (n) n.value = val ?? ""; };
    const check = (id, val) => { const n = el(id); if (n) n.checked = !!val; };
    set("inv-field-item-name", p.nama_part);
    set("inv-field-item-type", p.kode_alat);
    set("inv-field-category", p.id_kategori);
    set("inv-field-unit", p.unit || UNIT_DEFAULT);
    set("inv-field-cost", p.harga_satuan);
    set("inv-field-threshold", p.stok_min);
    check("inv-field-auto-demand", p.auto_demand);
  }

  // "Piece" was never a stored unit; the catalogue uses Pcs/Unit. Resetting the
  // select to "" (a value no <option> carries) left the control blank.
  const UNIT_DEFAULT = "Pcs";

  function closeAddModal() {
    addModal?.classList.add("hidden");
    _editingPartId = null;
    const fields = [
      "inv-field-item-name", "inv-field-item-type", "inv-field-quantity",
      "inv-field-unit", "inv-field-cost", "inv-field-threshold",
      "inv-field-gudang", "inv-field-auto-demand", "inv-field-category"
    ];
    fields.forEach(id => {
      const node = document.getElementById(id);
      if (!node) return;
      node.disabled = false;
      if (node.type === "checkbox") node.checked = false;
      else if (id === "inv-field-unit") node.value = UNIT_DEFAULT;
      else node.value = "";
    });
  }

  btnOpen?.addEventListener("click", () => openAddModal());
  btnClose?.addEventListener("click",  closeAddModal);
  btnCancel?.addEventListener("click", closeAddModal);
  addModal?.addEventListener("click", (e) => { if (e.target === addModal) closeAddModal(); });

  btnSubmit?.addEventListener("click", async () => {
    const jumlahAwal = parseInt(document.getElementById("inv-field-quantity")?.value) || 0;
    const gudangAwal = parseInt(document.getElementById("inv-field-gudang")?.value) || null;

    // Every field the form still carries, and nothing else. The identification
    // and supplier blocks are gone from the markup AND from `sparepart`, so a
    // key here that the schema no longer declares would be silently dropped by
    // Pydantic rather than rejected — which is how a form starts lying about
    // what it saved.
    const body = {
      nama_part: document.getElementById("inv-field-item-name")?.value.trim(),
      id_kategori: parseInt(document.getElementById("inv-field-category")?.value) || null,
      kode_alat: document.getElementById("inv-field-item-type")?.value || null,
      unit: document.getElementById("inv-field-unit")?.value || "Pcs",
      harga_satuan: parseInt(document.getElementById("inv-field-cost")?.value) || null,
      stok_min: parseInt(document.getElementById("inv-field-threshold")?.value) || 0,
      auto_demand: document.getElementById("inv-field-auto-demand")?.checked || false,
    };

    // Only the two fields the form actually stars are required, and the
    // asterisks in the markup now say exactly that. Harga satuan is optional
    // on the API, so demanding it here was stricter than the server.
    const missing = [];
    if (!body.nama_part) missing.push("Nama Barang");
    if (!body.id_kategori) missing.push("Kategori");
    if (missing.length) {
      showToast(`Lengkapi dulu: ${missing.join(", ")}.`, "warning");
      return;
    }

    try {
      let res;
      if (_editingPartId) {
        res = await apiFetch(`/inventaris/parts/${_editingPartId}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
      } else {
        // Opening stock must name a warehouse — it is written with id_gudang,
        // the pool every balance query scopes by. Writing it against a region
        // instead (as this used to) made the stock invisible and un-issuable.
        if (jumlahAwal > 0 && !gudangAwal) {
          showToast("Pilih gudang penyimpanan untuk stok awal.", "warning");
          return;
        }
        res = await apiFetch("/inventaris/parts", {
          method: "POST",
          body: JSON.stringify({
            ...body,
            jumlah_awal: jumlahAwal,
            id_gudang_awal: gudangAwal,
          }),
        });
      }
      // apiFetch only THROWS on 401. A 400 (bad FK, missing gudang) or a 403
      // arrives here as an ordinary response, so without this check every
      // rejected submit still reported success and closed the form.
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(payload.detail || "Gagal menyimpan suku cadang.", "error");
        return;
      }
      showToast(
        _editingPartId ? "Suku cadang diperbarui." : "Suku cadang berhasil ditambahkan.",
        "success",
      );
      closeAddModal();
      loadPartCatalog();
      if (!panelParts.classList.contains("hidden")) loadInvParts();
    } catch (e) {
      showToast(e.message || "Gagal menyimpan suku cadang.", "error");
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // GUDANG (warehouse) CRUD
  //
  // The endpoints have always existed but nothing could reach them. On a
  // database that had not been seeded there were no warehouses, the movement
  // form's gudang select read "— Belum ada gudang —", and the client-side
  // guard blocked every submit. The whole module was unusable from a cold
  // start.
  // ══════════════════════════════════════════════════════════════════

  let _editingGudangId = null;

  function openGudangModal() {
    closeAddModal();
    closeCatModal();
    closeTransferModal();
    el("inv-gudang-modal")?.classList.remove("hidden");
    loadGudangOptions();
  }

  function closeGudangModal() {
    el("inv-gudang-modal")?.classList.add("hidden");
    _resetGudangForm();
  }

  function _resetGudangForm() {
    _editingGudangId = null;
    ["inv-gudang-kode", "inv-gudang-nama", "inv-gudang-keterangan"].forEach((id) => {
      const n = el(id);
      if (n) n.value = "";
    });
    const label = el("inv-gudang-save-label");
    if (label) label.textContent = "Tambah Gudang";
    el("inv-gudang-cancel-edit")?.classList.add("hidden");
  }

  function renderGudangList() {
    const list = el("inv-gudang-list");
    if (!list) return;
    if (!_gudangList.length) {
      list.innerHTML = '<li class="empty-state">Belum ada gudang.</li>';
      return;
    }
    list.innerHTML = _gudangList
      .map(
        (g) => `
      <li class="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-700/40 text-sm">
        <span class="font-mono font-bold text-kai-blue dark:text-blue-400 shrink-0">${g.kode}</span>
        <span class="truncate flex-1" title="${g.keterangan || ""}">${g.nama}</span>
        ${g.is_active ? "" : '<span class="badge badge-neutral">nonaktif</span>'}
        <button type="button" class="btn-icon" title="Ubah"
          onclick="window.invEditGudang(${g.id_gudang})"><i class="fas fa-pen text-[11px]"></i></button>
        <button type="button" class="btn-icon btn-icon-danger" title="Hapus"
          onclick="window.invDeleteGudang(${g.id_gudang})"><i class="fas fa-trash-alt text-[11px]"></i></button>
      </li>`,
      )
      .join("");
  }

  window.invEditGudang = function (id) {
    const g = _gudangList.find((x) => x.id_gudang === id);
    if (!g) return;
    _editingGudangId = id;
    el("inv-gudang-kode").value = g.kode || "";
    el("inv-gudang-nama").value = g.nama || "";
    el("inv-gudang-keterangan").value = g.keterangan || "";
    const label = el("inv-gudang-save-label");
    if (label) label.textContent = "Simpan Perubahan";
    el("inv-gudang-cancel-edit")?.classList.remove("hidden");
  };

  window.invDeleteGudang = async function (id) {
    const g = _gudangList.find((x) => x.id_gudang === id);
    if (!(await customConfirm(`Hapus gudang "${g?.nama || id}"?\n\nJika gudang masih memiliki riwayat stok, gudang hanya akan dinonaktifkan.`)))
      return;
    try {
      const res = await apiFetch(`/inventaris/gudang/${id}`, { method: "DELETE" });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(payload.detail || "Gagal menghapus gudang.", "error");
        return;
      }
      showToast(payload.message || "Gudang dihapus.", "success");
      await loadGudangOptions();
    } catch (e) {
      showToast(e.message || "Gagal menghapus gudang.", "error");
    }
  };

  el("inv-btn-gudang")?.addEventListener("click", openGudangModal);
  el("inv-btn-open-gudang-modal")?.addEventListener("click", openGudangModal);
  el("inv-gudang-modal-close")?.addEventListener("click", closeGudangModal);
  el("inv-gudang-modal-done")?.addEventListener("click", closeGudangModal);
  el("inv-gudang-cancel-edit")?.addEventListener("click", _resetGudangForm);
  el("inv-gudang-modal")?.addEventListener("click", (e) => {
    if (e.target === el("inv-gudang-modal")) closeGudangModal();
  });

  el("inv-gudang-save-btn")?.addEventListener("click", async () => {
    const kode = el("inv-gudang-kode")?.value.trim().toUpperCase();
    const nama = el("inv-gudang-nama")?.value.trim();
    const keterangan = el("inv-gudang-keterangan")?.value.trim() || null;
    if (!kode || !nama) {
      showToast("Kode dan nama gudang wajib diisi.", "warning");
      return;
    }
    try {
      const res = _editingGudangId
        ? await apiFetch(`/inventaris/gudang/${_editingGudangId}`, {
            method: "PUT",
            body: JSON.stringify({ kode, nama, keterangan }),
          })
        : await apiFetch("/inventaris/gudang", {
            method: "POST",
            body: JSON.stringify({ kode, nama, keterangan, is_active: true }),
          });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(payload.detail || "Gagal menyimpan gudang.", "error");
        return;
      }
      showToast(_editingGudangId ? "Gudang diperbarui." : "Gudang ditambahkan.", "success");
      _resetGudangForm();
      await loadGudangOptions();
    } catch (e) {
      showToast(e.message || "Gagal menyimpan gudang.", "error");
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // TRANSFER ANTAR GUDANG
  //
  // POST /api/inventaris/transfer had no form anywhere; the Transfer tab was a
  // read-only table.
  // ══════════════════════════════════════════════════════════════════

  function openTransferModal() {
    closeAddModal();
    closeCatModal();
    closeGudangModal();
    el("inv-transfer-modal")?.classList.remove("hidden");
    loadGudangOptions();
    loadPartCatalog();
  }

  function closeTransferModal() {
    el("inv-transfer-modal")?.classList.add("hidden");
    ["inv-tf-part", "inv-tf-jumlah", "inv-tf-penerima", "inv-tf-catatan"].forEach((id) => {
      const n = el(id);
      if (n) n.value = "";
    });
    const info = el("inv-tf-part-info");
    if (info) info.textContent = "";
  }

  el("inv-btn-transfer")?.addEventListener("click", openTransferModal);
  el("inv-transfer-close")?.addEventListener("click", closeTransferModal);
  el("inv-transfer-cancel")?.addEventListener("click", closeTransferModal);
  el("inv-transfer-modal")?.addEventListener("click", (e) => {
    if (e.target === el("inv-transfer-modal")) closeTransferModal();
  });

  el("inv-tf-part")?.addEventListener("input", () => {
    const p = selectedPart(el("inv-tf-part")?.value);
    const info = el("inv-tf-part-info");
    if (info) info.textContent = p ? `${p.nama_part} · satuan ${p.unit}` : "";
  });

  el("inv-transfer-submit")?.addEventListener("click", async () => {
    const part = selectedPart(el("inv-tf-part")?.value);
    const asal = parseInt(el("inv-tf-asal")?.value) || null;
    const tujuan = parseInt(el("inv-tf-tujuan")?.value) || null;
    const jumlah = parseInt(el("inv-tf-jumlah")?.value) || 0;

    if (!part) return showToast("Pilih suku cadang dari daftar.", "warning");
    if (!asal || !tujuan) return showToast("Pilih gudang asal dan tujuan.", "warning");
    if (asal === tujuan) return showToast("Gudang asal dan tujuan tidak boleh sama.", "warning");
    if (jumlah <= 0) return showToast("Jumlah transfer harus lebih dari 0.", "warning");

    try {
      const res = await apiFetch("/inventaris/transfer", {
        method: "POST",
        body: JSON.stringify({
          id_part: part.id_part,
          jumlah,
          id_gudang_asal: asal,
          id_gudang_tujuan: tujuan,
          transfer_to: el("inv-tf-penerima")?.value.trim() || null,
          catatan: el("inv-tf-catatan")?.value.trim() || null,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(payload.detail || "Gagal memproses transfer.", "error");
        return;
      }
      showToast("Transfer berhasil dicatat.", "success");
      closeTransferModal();
      loadInvTransfer();
      if (!panelParts?.classList.contains("hidden")) loadInvParts();
    } catch (e) {
      showToast(e.message || "Gagal memproses transfer.", "error");
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
      renderInvFlow();
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

  // Sort + status filter, driven by #inv-sort-modal. The sort icon in the
  // toolbar previously had no id and no handler at all.
  let _invSortField = "nama_part";
  let _invSortDir = "asc";
  let _invStatusFilter = "";

  function _invEmptyRow(message, isError = false) {
    return `<tr><td colspan="16" class="empty-state ${isError ? "is-error" : ""}">
      <i class="fas ${isError ? "fa-triangle-exclamation" : "fa-box-open"}"></i>${message}</td></tr>`;
  }

  async function loadInvParts() {
    const tbody = document.getElementById("inv-parts-body");
    // Stock is pooled across every warehouse unless one is picked on the Dasbor
    // Inventaris tab, which is the single place the scope is chosen.
    const params = new URLSearchParams();
    if (_gudangFilter) params.set("id_gudang", _gudangFilter);
    try {
      const res = await apiFetch(`/inventaris/parts?${params}`);
      if (!res.ok) {
        // These loaders used to `return` silently, leaving the previous
        // payload on screen with no indication anything had failed.
        if (tbody) tbody.innerHTML = _invEmptyRow("Gagal memuat daftar suku cadang.", true);
        return;
      }
      _partsRows = await res.json();
      renderInvPartsTable();
      renderInvFlow();
    } catch (e) {
      console.warn("Parts load failed:", e);
      if (tbody) tbody.innerHTML = _invEmptyRow("Gagal memuat daftar suku cadang.", true);
    }
  }

  function _filteredParts() {
    const q = (searchInput?.value || "").trim().toLowerCase();
    let rows = _partsRows;

    if (_invStatusFilter) {
      rows = rows.filter((p) => p.status_stok === _invStatusFilter);
    }
    if (q) {
      rows = rows.filter((p) =>
        [p.nama_part, p.subsistem, p.nama_alat, p.kode_alat,
         p.nama_varian, p.status_stok]
          .some((v) => (v ?? "").toString().toLowerCase().includes(q)),
      );
    }

    const dir = _invSortDir === "desc" ? -1 : 1;
    return [...rows].sort((a, b) => {
      const av = a[_invSortField];
      const bv = b[_invSortField];
      // Numeric columns compare numerically; a localeCompare on "10" vs "9"
      // would order them 10, 9.
      if (typeof av === "number" || typeof bv === "number") {
        return ((av || 0) - (bv || 0)) * dir;
      }
      return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
    });
  }

  function openInvSortModal() {
    el("inv-sort-field").value = _invSortField;
    el("inv-sort-dir").value = _invSortDir;
    el("inv-sort-status").value = _invStatusFilter;
    el("inv-sort-modal")?.classList.remove("hidden");
  }
  function closeInvSortModal() {
    el("inv-sort-modal")?.classList.add("hidden");
  }

  el("inv-btn-sort")?.addEventListener("click", openInvSortModal);
  el("inv-sort-close")?.addEventListener("click", closeInvSortModal);
  el("inv-sort-modal")?.addEventListener("click", (e) => {
    if (e.target === el("inv-sort-modal")) closeInvSortModal();
  });
  el("inv-sort-apply")?.addEventListener("click", () => {
    _invSortField = el("inv-sort-field")?.value || "nama_part";
    _invSortDir = el("inv-sort-dir")?.value || "asc";
    _invStatusFilter = el("inv-sort-status")?.value || "";
    resetPage("parts");
    closeInvSortModal();
    renderInvPartsTable();
  });
  el("inv-sort-reset")?.addEventListener("click", () => {
    _invSortField = "nama_part";
    _invSortDir = "asc";
    _invStatusFilter = "";
    resetPage("parts");
    closeInvSortModal();
    renderInvPartsTable();
  });

  // Items Master row. Movement columns are lifetime ledger totals; the date
  // range on the Dasbor Inventaris tab windows the dashboard, not this table.
  function renderInvPartsTable() {
    const tbody = document.getElementById("inv-parts-body");
    if (!tbody) return;
    const rows = _filteredParts();

    if (rows.length === 0) {
      renderPagerBar("inv-parts-pager", paginateList("parts", rows), renderInvPartsTable);
      tbody.innerHTML = _invEmptyRow(
        _partsRows.length
          ? "Tidak ada suku cadang yang cocok dengan pencarian atau filter ini."
          : "Belum ada suku cadang. Mulai dari Gudang → Kategori → Tambah Suku Cadang.",
      );
      return;
    }
    const t = KAI_VIZ.theme();
    const num = (n) => Number(n || 0).toLocaleString("id-ID");

    const page = paginateList("parts", rows);
    renderPagerBar("inv-parts-pager", page, renderInvPartsTable);

    tbody.innerHTML = page.items.map(p => {
      const meta = STOK_STATUS_META.find((m) => m.key === p.status_stok);
      const statusColor = bandTone(t, meta?.band);
      // `aman` is the only non-problem band now that `atasmax` is gone; the
      // second clause it used to carry could never match anything again.
      const isProblem = meta && meta.band !== "aman";
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
          <div class="flex items-center gap-0.5">
            <!-- The history card is READ-only, so it is not gated with
                 data-write — a technician who may not edit a part still needs to
                 see where it is and what has moved. -->
            <button class="btn-icon" title="Kartu riwayat suku cadang"
                onclick="window.openPartHistory(${p.id_part})">
              <i class="fas fa-clock-rotate-left text-[11px]"></i>
            </button>
            <button class="inv-part-edit btn-icon" data-id="${p.id_part}" title="Ubah suku cadang">
              <i class="fas fa-pen text-[11px]"></i>
            </button>
            <button class="inv-part-delete btn-icon btn-icon-danger" data-id="${p.id_part}" title="Hapus">
              <i class="fas fa-trash-alt text-[11px]"></i>
            </button>
          </div>
        </td>
        <td class="px-3 py-2.5 min-w-[180px]">
          <p class="font-semibold text-gray-800 dark:text-white text-xs leading-tight">${p.nama_part}</p>
          <p class="text-[10px] text-gray-400">${
            p.nama_varian || '<span class="italic">semua model</span>'
          }</p>
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
      </tr>`;
    }).join("");

    // Edit handlers — PUT /inventaris/parts/{id} was implemented server-side
    // but had no way to be triggered from the UI.
    tbody.querySelectorAll(".inv-part-edit").forEach((btn) => {
      btn.addEventListener("click", () => {
        const part = _partsRows.find(
          (p) => String(p.id_part) === String(btn.dataset.id),
        );
        if (part) openAddModal(part);
      });
    });

    // Delete handlers
    tbody.querySelectorAll(".inv-part-delete").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!(await customConfirm("Hapus part ini?"))) return;
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
  searchInput?.addEventListener(
    "input",
    debounce(function () {
      if (!panelParts?.classList.contains("hidden")) {
        resetPage("parts");
        renderInvPartsTable();
      } else if (!panelTransfer?.classList.contains("hidden")) {
        resetPage("transfer");
        renderInvTransferTable();
      }
    }),
  );

  // ── Transfer history loader ────────────────────────────────────────
  let _transferRows = [];

  // ══════════════════════════════════════════════════════════════════
  // Hierarki Suku Cadang — the BOM tree
  // ══════════════════════════════════════════════════════════════════
  //
  // The client's "Hierarki Part ▸ Tree ▸ Struktur BOM": pick a tool type, see
  // its parts grouped by subsistem, click one to open its history card.
  //
  // Rendered as a real <ul>/<li> nesting rather than indented divs, because
  // that is what a tree IS — a screen reader announces the levels and the item
  // counts for free, which no amount of padding-left can do.

  // Which subsistem gets which icon. Unknown ones fall back rather than being
  // dropped, so a catalogue that adds a fifth still renders.
  const SUBSISTEM_ICON = {
    ENGINE: "fa-gear",
    ELECTRIC: "fa-bolt",
    MECHANIC: "fa-screwdriver-wrench",
    CONSUMABLES: "fa-droplet",
  };

  let _hirarkiLoaded = false;

  async function loadInvHirarki() {
    if (!hirarkiAlat || !hirarkiTree) return;

    // The selector is fetched once per session — the catalogue of which tools
    // have parts changes only when parts are created.
    if (!_hirarkiLoaded) {
      try {
        const res = await apiFetch("/inventaris/hirarki", { background: true });
        if (!res.ok) throw new Error();
        const d = await res.json();
        const opts = (d.alat || [])
          .map(
            (a) =>
              `<option value="${a.kode_alat}">${a.kode_alat} — ${a.nama_alat} (${a.jumlah_part})</option>`,
          )
          .join("");
        hirarkiAlat.innerHTML =
          `<option value="">— Pilih jenis alat kerja —</option>` + opts;

        // State the coverage plainly. 17 of 104 tool types have parts; a
        // selector that silently listed only those would look complete while
        // hiding that 87 have nothing yet. Naming the gap makes it read as work
        // outstanding rather than as a defect in this screen.
        const c = d.cakupan || {};
        if (hirarkiCakupan) {
          hirarkiCakupan.innerHTML =
            `<i class="fas fa-circle-info mr-1 opacity-60"></i>` +
            `<b>${c.dengan_part ?? 0}</b> dari <b>${c.total_alat ?? 0}</b> alat kerja ` +
            `sudah punya suku cadang terdaftar. Sisanya belum didata — ` +
            `tambahkan lewat tab <b>Daftar Suku Cadang</b>.`;
        }
        _hirarkiLoaded = true;
      } catch (e) {
        hirarkiTree.innerHTML = `<p class="empty-state">Gagal memuat daftar alat kerja.</p>`;
        return;
      }
    }

    if (!hirarkiAlat.value) {
      hirarkiTree.innerHTML = `<p class="empty-state">
        Pilih jenis alat kerja di atas untuk melihat struktur suku cadangnya.</p>`;
      return;
    }
    await renderInvHirarki(hirarkiAlat.value);
  }

  async function renderInvHirarki(kodeAlat) {
    hirarkiTree.setAttribute("aria-busy", "true");
    hirarkiTree.innerHTML = `<p class="empty-state">Memuat…</p>`;
    let d;
    try {
      const res = await apiFetch(
        `/inventaris/hirarki?kode_alat=${encodeURIComponent(kodeAlat)}`,
        { background: true },
      );
      if (!res.ok) throw new Error();
      d = await res.json();
    } catch (e) {
      hirarkiTree.removeAttribute("aria-busy");
      hirarkiTree.innerHTML = `<p class="empty-state">Gagal memuat hierarki suku cadang.</p>`;
      return;
    }

    if (!d.subsistem?.length) {
      hirarkiTree.removeAttribute("aria-busy");
      hirarkiTree.innerHTML = `<p class="empty-state">
        Belum ada suku cadang terdaftar untuk ${d.nama_alat || kodeAlat}.</p>`;
      return;
    }

    // Theme tokens are read per render, exactly as every other renderer here
    // does — `t` is a local in each, not a shared binding, and the palette
    // changes when the user toggles dark mode mid-session.
    const t = KAI_VIZ.theme();

    const partLi = (p) => {
      const meta = STOK_STATUS_META.find((m) => m.key === p.status_stok);
      const color = bandTone(t, meta?.band);
      // `id_varian` NULL is the COMMON case and means "fits every model of this
      // tool" — a positive fact. Rendering it as a blank would read as missing
      // data about the part instead.
      const cocok = p.universal
        ? `<span class="badge badge-neutral">semua model</span>`
        : `<span class="badge badge-info">${p.nama_varian || "model tertentu"}</span>`;
      return `
        <li class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 pl-6 border-b border-gray-50 dark:border-gray-700/50 last:border-0">
          <button type="button" onclick="window.openPartHistory(${p.id_part})"
              class="text-left font-semibold text-sm text-kai-blue dark:text-blue-400 hover:underline min-w-0 flex-1">
            ${p.nama_part}
          </button>
          ${cocok}
          <span class="tabular-nums text-sm font-bold shrink-0" style="color:${color}">
            ${p.stok_sekarang.toLocaleString("id-ID")}
            <span class="text-[10px] font-normal text-gray-400">${p.unit || ""}</span>
          </span>
          <span class="badge ${
            meta && meta.band !== "aman" ? "badge-warn" : "badge-so"
          } shrink-0">${p.status_stok}</span>
        </li>`;
    };

    const kategoriBlock = (k, collapse) =>
      collapse
        ? k.parts.map(partLi).join("")
        : `<li class="pl-4">
             <p class="text-[11px] font-bold tracking-wide text-gray-500 dark:text-gray-400 uppercase pt-2">
               ${k.nama} <span class="font-normal opacity-70">(${k.jumlah_part})</span>
             </p>
             <ul>${k.parts.map(partLi).join("")}</ul>
           </li>`;

    const subBlock = (s) => {
      // Collapse a kategori level that has exactly one child — in this
      // catalogue every (alat, subsistem) pair has one kategori named
      // "SUBSISTEM — TOOL", so drawing it would add a level that always has one
      // child and whose label restates its parent. The rule is about SHAPE, not
      // about today's data: split the catalogue later and the level returns.
      const collapse = s.kategori.length === 1;
      return `
        <li class="border border-gray-100 dark:border-gray-700 rounded-lg overflow-hidden">
          <div class="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-700/40">
            <i class="fas ${SUBSISTEM_ICON[s.nama] || "fa-cube"} text-kai-blue dark:text-blue-400 text-xs"></i>
            <span class="font-bold text-xs tracking-wide text-gray-700 dark:text-gray-200 uppercase">${s.nama}</span>
            <span class="badge badge-neutral ml-auto">${s.jumlah_part} suku cadang</span>
          </div>
          <ul>${s.kategori.map((k) => kategoriBlock(k, collapse)).join("")}</ul>
        </li>`;
    };

    hirarkiTree.innerHTML = `
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-3">
        <h3 class="font-bold text-sm text-gray-800 dark:text-white">
          ${d.kode_alat} — ${d.nama_alat}
        </h3>
        <span class="badge badge-info">${d.jumlah_part} suku cadang</span>
        ${d.kelompok ? `<span class="badge badge-neutral">${d.kelompok}</span>` : ""}
        <span class="text-[11px] text-gray-400 basis-full">
          Klik nama suku cadang untuk membuka kartu riwayatnya.
        </span>
      </div>
      <ul class="space-y-3">${d.subsistem.map(subBlock).join("")}</ul>`;
    hirarkiTree.removeAttribute("aria-busy");
  }

  hirarkiAlat?.addEventListener("change", () => loadInvHirarki());

  // ══════════════════════════════════════════════════════════════════
  // Kartu Riwayat Suku Cadang — the per-part history card
  // ══════════════════════════════════════════════════════════════════
  //
  // The client's "History Card Part ▸ Riwayat ▸ Timeline transaksi part". The
  // data path already existed — `sparepart_stok` is append-only by design and
  // `/api/inventaris/stok?id_part=` has always returned the per-part ledger —
  // so this is the screen, not a new source of truth.
  //
  // Two requests, deliberately: identity + per-gudang balance from
  // /parts/{id}, and the movements from /stok. Neither endpoint grew a copy of
  // the other's job.

  const GERAKAN_META = {
    IN:           { label: "Masuk",              icon: "fa-arrow-down",  masuk: true },
    OUT:          { label: "Keluar",             icon: "fa-arrow-up",    masuk: false },
    RETUR_CUST:   { label: "Retur dari Customer", icon: "fa-rotate-left", masuk: true },
    RETUR_VENDOR: { label: "Retur ke Vendor",    icon: "fa-rotate-right", masuk: false },
    ADJ_IN:       { label: "Penyesuaian +",      icon: "fa-plus",        masuk: true },
    ADJ_OUT:      { label: "Penyesuaian −",      icon: "fa-minus",       masuk: false },
  };

  async function renderPartHistory(idPart) {
    const body = el("inv-ph-body");
    if (!body) return;
    body.setAttribute("aria-busy", "true");
    body.innerHTML = `<p class="empty-state">Memuat…</p>`;

    let detail, ledger;
    try {
      // apiFetch only THROWS on 401, so both have to be checked explicitly —
      // otherwise a 404 would render as an empty card rather than as an error.
      const [rd, rl] = await Promise.all([
        apiFetch(`/inventaris/parts/${idPart}`, { background: true }),
        apiFetch(`/inventaris/stok?id_part=${idPart}&limit=200`, { background: true }),
      ]);
      if (!rd.ok || !rl.ok) throw new Error();
      detail = await rd.json();
      ledger = await rl.json();
    } catch (e) {
      body.removeAttribute("aria-busy");
      body.innerHTML = `<p class="empty-state">Gagal memuat kartu riwayat suku cadang.</p>`;
      return;
    }

    const sub = el("inv-ph-subtitle");
    if (sub) {
      sub.textContent =
        `${detail.kode_alat || "—"} ${detail.nama_alat || ""} · ` +
        `${detail.subsistem || "—"} · ` +
        (detail.universal ? "cocok untuk semua model" : detail.nama_varian || "model tertentu");
    }
    const title = el("inv-ph-title");
    if (title) title.textContent = detail.nama_part;

    const t = KAI_VIZ.theme();
    const meta = STOK_STATUS_META.find((m) => m.key === detail.status_stok);
    const color = bandTone(t, meta?.band);

    // Per-gudang, because `id_gudang` is the pool every balance is scoped by —
    // "24 in total" is not actionable if a technician cannot tell which shelf.
    const gudangRows = (detail.per_gudang || []).length
      ? detail.per_gudang
          .map(
            (g) => `
        <div class="flex items-baseline justify-between gap-3 py-1.5 border-b border-gray-50 dark:border-gray-700/50 last:border-0">
          <span class="text-xs text-gray-600 dark:text-gray-300 min-w-0 truncate">${g.nama}</span>
          <span class="tabular-nums text-sm font-bold shrink-0">${g.stok.toLocaleString("id-ID")}
            <span class="text-[10px] font-normal text-gray-400">${detail.unit || ""}</span></span>
        </div>`,
          )
          .join("")
      : `<p class="empty-state">Belum ada pergerakan di gudang mana pun.</p>`;

    const movementRows = (ledger.items || []).length
      ? ledger.items
          .map((m) => {
            const g = GERAKAN_META[m.tipe_gerakan] || { label: m.tipe_gerakan, icon: "fa-circle", masuk: true };
            const sign = g.masuk ? "+" : "−";
            const tone = g.masuk ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400";
            return `
              <tr>
                <td class="px-3 py-2 text-xs whitespace-nowrap">${m.waktu || "—"}</td>
                <td class="px-3 py-2 text-xs">
                  <span class="badge ${g.masuk ? "badge-so" : "badge-tso"}">
                    <i class="fas ${g.icon}"></i> ${g.label}</span>
                </td>
                <td class="px-3 py-2 text-xs text-right tabular-nums font-bold ${tone} whitespace-nowrap">
                  ${sign}${Math.abs(m.jumlah).toLocaleString("id-ID")}
                </td>
                <td class="px-3 py-2 text-xs">${m.gudang || "—"}</td>
                <td class="px-3 py-2 text-xs">${m.user || "—"}</td>
                <td class="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">${m.keterangan || "—"}</td>
              </tr>`;
          })
          .join("")
      : `<tr><td colspan="6" class="empty-state">Belum ada pergerakan tercatat untuk suku cadang ini.</td></tr>`;

    const shown = (ledger.items || []).length;
    const more =
      ledger.total > shown
        ? `<p class="text-[11px] text-gray-400 mt-2">Menampilkan ${shown} dari
             ${ledger.total} pergerakan terakhir.</p>`
        : "";

    body.innerHTML = `
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        <div class="sm:col-span-1 card p-3">
          <p class="text-[10px] font-bold tracking-widest text-gray-400 uppercase mb-1">Stok saat ini</p>
          <p class="text-2xl font-bold tabular-nums" style="color:${color}">
            ${detail.stok_sekarang.toLocaleString("id-ID")}
            <span class="text-xs font-normal text-gray-400">${detail.unit || ""}</span>
          </p>
          <p class="text-[11px] text-gray-400 mt-0.5">Minimum: ${detail.stok_min ?? 0}</p>
          <span class="badge ${meta && meta.band !== "aman" ? "badge-warn" : "badge-so"} mt-2">
            ${detail.status_stok}</span>
        </div>
        <div class="sm:col-span-2 card p-3">
          <p class="text-[10px] font-bold tracking-widest text-gray-400 uppercase mb-1">Sebaran per gudang</p>
          ${gudangRows}
        </div>
      </div>

      <p class="text-[10px] font-bold tracking-widest text-gray-400 uppercase mb-1">Riwayat pergerakan</p>
      <div class="table-stack-wrap overflow-x-auto border border-gray-100 dark:border-gray-700 rounded-lg">
        <table class="table-stack table-timeline w-full text-left">
          <thead class="bg-gray-50 dark:bg-gray-700/40">
            <tr>
              <th class="px-3 py-2 text-[10px] font-bold tracking-widest text-gray-400 uppercase">Waktu</th>
              <th class="px-3 py-2 text-[10px] font-bold tracking-widest text-gray-400 uppercase">Jenis</th>
              <th class="px-3 py-2 text-[10px] font-bold tracking-widest text-gray-400 uppercase text-right">Jumlah</th>
              <th class="px-3 py-2 text-[10px] font-bold tracking-widest text-gray-400 uppercase">Gudang</th>
              <th class="px-3 py-2 text-[10px] font-bold tracking-widest text-gray-400 uppercase">Oleh</th>
              <th class="px-3 py-2 text-[10px] font-bold tracking-widest text-gray-400 uppercase">Keterangan</th>
            </tr>
          </thead>
          <tbody>${movementRows}</tbody>
        </table>
      </div>
      ${more}`;
    body.removeAttribute("aria-busy");
  }

  window.openPartHistory = function (idPart) {
    el("inv-part-history-modal")?.classList.remove("hidden");
    renderPartHistory(idPart);
  };

  el("close-inv-part-history-modal")?.addEventListener("click", () =>
    el("inv-part-history-modal")?.classList.add("hidden"),
  );

  async function loadInvTransfer() {
    const tbody = document.getElementById("inv-transfer-body");
    const fail = () => {
      if (tbody)
        tbody.innerHTML =
          '<tr><td colspan="9" class="empty-state is-error"><i class="fas fa-triangle-exclamation"></i>Gagal memuat riwayat transfer.</td></tr>';
    };
    const params = new URLSearchParams();
    if (_gudangFilter) params.set("id_gudang", _gudangFilter);
    try {
      const res = await apiFetch(`/inventaris/transfer?${params}`);
      if (!res.ok) return fail();
      // Server-paged envelope: { total, limit, offset, items }.
      const payload = await res.json();
      _transferRows = Array.isArray(payload) ? payload : payload.items || [];
      renderInvTransferTable();
    } catch (e) {
      console.warn("Transfer load failed:", e);
      fail();
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // BULK IMPORT
  //
  // The two dropdown buttons had no ids and no listeners: the menu opened and
  // nothing happened. Wired directly rather than through _wireMasterBulk,
  // which expects a per-prefix confirmation modal this view does not have.
  // ══════════════════════════════════════════════════════════════════

  el("inv-btn-bulk-toggle")?.addEventListener("click", (e) => {
    e.stopPropagation();
    el("inv-bulk-dropdown")?.classList.toggle("hidden");
  });
  document.addEventListener("click", () =>
    el("inv-bulk-dropdown")?.classList.add("hidden"),
  );

  el("inv-btn-sample-excel")?.addEventListener("click", async () => {
    el("inv-bulk-dropdown")?.classList.add("hidden");
    if (!(await ensureXLSX())) return;
    const wb = XLSX.utils.book_new();
    // Column set matches SparePartCreate exactly. Kode SKU, Nomor Part and
    // Supplier are gone from the template because they are gone from the table;
    // an importer that kept offering them would silently discard three columns
    // the operator had filled in. _importPartsExcel reads these SIX positions.
    const headers = [
      "Nama Barang", "Kategori", "Kode Alat", "Satuan",
      "Harga Satuan", "Stok Minimum",
    ];
    const sample = [
      ["Filter Oli GX390", "ENGINE – GENSET", "GEN", "Pcs", 45000, 4],
      ["Busi NGK BPR6ES", "ENGINE – GENSET", "GEN", "Pcs", 22000, 10],
    ];
    const ws = XLSX.utils.aoa_to_sheet([headers, ...sample]);
    ws["!cols"] = [{ wch: 28 }, { wch: 24 }, { wch: 12 },
                   { wch: 10 }, { wch: 14 }, { wch: 14 }];
    const instr = [
      ["Petunjuk Pengisian"],
      ["Nama Barang: WAJIB."],
      ["Kategori: WAJIB, harus PERSIS sama dengan nama kategori yang sudah terdaftar."],
      ["Kode Alat: kode alat kerja (GEN, PBT, …), boleh kosong."],
      ["Satuan: Pcs / Unit / Set / Box / Roll / Liter."],
      ["Harga Satuan & Stok Minimum: angka tanpa titik atau koma."],
      ["Stok awal TIDAK diimpor lewat file ini — catat lewat tab Transaksi Barang."],
    ];
    const wsI = XLSX.utils.aoa_to_sheet(instr);
    wsI["!cols"] = [{ wch: 72 }];
    XLSX.utils.book_append_sheet(wb, ws, "Data Suku Cadang");
    XLSX.utils.book_append_sheet(wb, wsI, "Petunjuk");
    XLSX.writeFile(wb, "Template_Import_SukuCadang.xlsx");
  });

  el("inv-btn-import-excel")?.addEventListener("click", () => {
    el("inv-bulk-dropdown")?.classList.add("hidden");
    // A detached input avoids adding yet another modal to index.html.
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".xlsx,.xls";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      await _importPartsExcel(file);
    });
    input.click();
  });

  async function _importPartsExcel(file) {
    if (!(await ensureXLSX())) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      let dataRows;
      try {
        const wb = XLSX.read(e.target.result, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        dataRows = rows.slice(1).filter((r) => String(r[0] || "").trim());
      } catch {
        showToast("Gagal membaca file Excel.", "error");
        return;
      }
      if (!dataRows.length) {
        showToast("File tidak memiliki baris data.", "warning");
        return;
      }

      // Category is matched by name against the existing master rather than
      // created on the fly: silently inventing categories from typos is how
      // a catalogue ends up with "ENGINE - GENSET" and "ENGINE – GENSET".
      if (!_categories.length) await loadInvKategoriOptions();
      const katByName = new Map(
        _categories.map((c) => [String(c.nama).trim().toUpperCase(), c.id_kategori]),
      );

      let success = 0, failed = 0;
      // Positions must track the template's `headers` above — six columns now
      // that SKU, Nomor Part and Supplier are gone.
      for (const row of dataRows) {
        const namaKat = String(row[1] || "").trim().toUpperCase();
        const body = {
          nama_part: String(row[0]).trim(),
          id_kategori: katByName.get(namaKat) || null,
          kode_alat: String(row[2] || "").trim().toUpperCase() || null,
          unit: String(row[3] || "").trim() || "Pcs",
          harga_satuan: parseInt(row[4]) || null,
          stok_min: parseInt(row[5]) || 0,
          jumlah_awal: 0,
        };
        if (!body.id_kategori) { failed++; continue; }
        try {
          const res = await apiFetch("/inventaris/parts", {
            method: "POST",
            body: JSON.stringify(body),
            background: true,
          });
          if (res.ok) success++; else failed++;
        } catch { failed++; }
      }
      showToast(
        `Impor suku cadang selesai: ${success} berhasil${failed ? `, ${failed} gagal (kategori tidak dikenal)` : ""}.`,
        success > 0 ? "success" : "error",
      );
      loadPartCatalog();
      loadInvParts();
    };
    reader.readAsArrayBuffer(file);
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
      tbody.innerHTML = `<tr><td colspan="9" class="empty-state">
        <i class="fas fa-right-left"></i>${
          _transferRows.length
            ? "Tidak ada transfer yang cocok dengan pencarian ini."
            : 'Belum ada transfer. Gunakan tombol "Transfer" di toolbar untuk memindahkan stok antar gudang.'
        }</td></tr>`;
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
    // A repair consuming parts, or another counter posting, changes the
    // balances this sheet is measured against.
    if (!panelOpname?.classList.contains("hidden")) loadOpname();
  });


  // ══════════════════════════════════════════════════════════════════
  // STOCK OPNAME — count sheet, variance, posting
  // ══════════════════════════════════════════════════════════════════
  //
  // Nothing in this tab touches the ledger until "Selesaikan" is pressed. The
  // physical counts are saved as they are typed so a half-finished sheet
  // survives a reload, but they are just numbers on a form until the variance
  // is posted as ADJ_IN/ADJ_OUT rows — see selesai_opname() in
  // api/inventaris.py, where the variance is deliberately recomputed against
  // the CURRENT balance rather than the one snapshotted when the sheet opened.
  //
  // The sheet shows BOTH figures for exactly that reason: `stok_sistem` is what
  // the system believed when counting started, `stok_kini` is what it believes
  // now, and when they differ it is because the warehouse legitimately moved
  // stock mid-count. Hiding that would make the counter answer for a variance
  // they did not create.

  let _opnameAktif = null;   // the open session's payload, or null

  async function loadOpname() {
    // loadGudangOptions() fills #inv-opname-gudang along with every other
    // warehouse select in this view.
    await loadGudangOptions();
    await Promise.all([_loadOpnameAktif(), _loadOpnameRiwayat()]);
  }

  async function _loadOpnameAktif() {
    const sheet = el("inv-opname-sheet");
    const info = el("inv-opname-status");
    if (!sheet) return;
    try {
      const res = await apiFetch("/inventaris/opname?status=DRAFT&limit=1", {
        background: true,
      });
      if (!res.ok) throw new Error("Gagal memuat opname.");
      const first = (await res.json()).items[0];
      if (!first) {
        _opnameAktif = null;
        if (info) info.textContent = "Tidak ada opname berjalan.";
        sheet.innerHTML =
          `<div class="empty-state"><i class="fas fa-clipboard-list"></i>
             Belum ada opname berjalan. Pilih gudang lalu tekan
             <b>Mulai Opname</b> untuk mencetak lembar hitung.</div>`;
        return;
      }
      const detail = await apiFetch(`/inventaris/opname/${first.id_opname}`, {
        background: true,
      });
      if (!detail.ok) throw new Error("Gagal memuat lembar opname.");
      _opnameAktif = await detail.json();
      if (info)
        info.textContent =
          `Opname #${_opnameAktif.id_opname} · ${_opnameAktif.nama_gudang} · ` +
          `${_opnameAktif.jumlah_dihitung}/${_opnameAktif.jumlah_baris} baris dihitung`;
      renderOpnameSheet();
    } catch (e) {
      sheet.innerHTML = `<div class="empty-state"><i class="fas fa-triangle-exclamation"></i>${e.message}</div>`;
    }
  }

  function renderOpnameSheet() {
    const sheet = el("inv-opname-sheet");
    if (!sheet || !_opnameAktif) return;
    const esc = window.spekEscape;

    const rows = _opnameAktif.baris
      .map((b) => {
        // A variance is only meaningful once something has been counted.
        const counted = b.stok_fisik !== null && b.stok_fisik !== undefined;
        const sel = counted ? b.stok_fisik - b.stok_kini : null;
        const selCls =
          sel === null ? "text-gray-300"
            : sel === 0 ? "text-gray-400"
              : sel > 0 ? "text-green-600 dark:text-green-400 font-bold"
                : "text-red-600 dark:text-red-400 font-bold";
        // The system figure MOVED while the sheet was open. Say so rather than
        // presenting a variance the counter cannot explain.
        const geser = b.stok_kini !== b.stok_sistem
          ? `<span class="badge badge-warn ml-1" title="Stok berubah saat opname berjalan">
               ${b.stok_sistem} → ${b.stok_kini}</span>`
          : "";
        return `
          <tr class="border-b border-gray-50 dark:border-gray-700/50" data-opname-row data-part="${b.id_part}">
            <td class="px-3 py-2 text-sm">${esc(b.nama_part || "—")}</td>
            <td class="px-3 py-2 text-center text-sm text-gray-500">${b.stok_kini} ${esc(b.unit || "")}${geser}</td>
            <td class="px-3 py-2 text-center">
              <input type="number" min="0" step="1" data-opname-fisik aria-label="Jumlah fisik ${esc(b.nama_part || "")}"
                value="${counted ? b.stok_fisik : ""}" placeholder="—"
                class="w-24 p-1.5 text-center bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm outline-none focus:border-kai-blue transition" />
            </td>
            <td class="px-3 py-2 text-center text-sm ${selCls}" data-opname-selisih>
              ${sel === null ? "—" : (sel > 0 ? "+" : "") + sel}
            </td>
          </tr>`;
      })
      .join("");

    sheet.innerHTML = `
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <button type="button" id="inv-opname-simpan" class="btn btn-ghost">
          <i class="fas fa-floppy-disk"></i> Simpan Hitungan
        </button>
        <button type="button" id="inv-opname-selesai" class="btn btn-success">
          <i class="fas fa-check"></i> Selesaikan &amp; Sesuaikan Stok
        </button>
        <button type="button" id="inv-opname-batal" class="btn btn-danger">
          <i class="fas fa-xmark"></i> Batalkan
        </button>
        <p class="text-[11px] text-gray-400 basis-full">
          Baris yang dikosongkan dianggap <b>belum dihitung</b> dan tidak akan
          menghasilkan penyesuaian — berbeda dengan diisi angka nol.
        </p>
      </div>
      <div class="overflow-x-auto table-stack-wrap">
        <table class="w-full text-sm table-stack">
          <thead class="text-[10px] uppercase tracking-wider text-gray-400 border-b border-gray-100 dark:border-gray-700">
            <tr>
              <th class="px-3 py-2 text-left">Sparepart</th>
              <th class="px-3 py-2 text-center">Stok Sistem</th>
              <th class="px-3 py-2 text-center">Hitung Fisik</th>
              <th class="px-3 py-2 text-center">Selisih</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  /** [{id_part, stok_fisik, keterangan}] straight off the sheet. */
  function _collectOpname() {
    return [...document.querySelectorAll("#inv-opname-sheet [data-opname-row]")].map(
      (tr) => {
        const raw = tr.querySelector("[data-opname-fisik]").value.trim();
        return {
          id_part: parseInt(tr.dataset.part, 10),
          // "" means not counted. `parseInt("")` is NaN, so the empty string has
          // to be tested before parsing or every blank row would post as null
          // anyway by accident rather than by intent.
          stok_fisik: raw === "" ? null : parseInt(raw, 10),
        };
      },
    );
  }

  async function _saveOpname(silent) {
    if (!_opnameAktif) return false;
    const res = await apiFetch(`/inventaris/opname/${_opnameAktif.id_opname}/baris`, {
      method: "PUT",
      body: JSON.stringify({ baris: _collectOpname() }),
      background: true,
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      showToast(d.detail || "Gagal menyimpan hitungan.", "error");
      return false;
    }
    if (!silent) showToast("Hitungan tersimpan.", "success");
    return true;
  }

  async function _loadOpnameRiwayat() {
    const tbody = el("inv-opname-riwayat");
    if (!tbody) return;
    try {
      const res = await apiFetch("/inventaris/opname?limit=20", { background: true });
      if (!res.ok) return;
      const rows = (await res.json()).items;
      if (!rows.length) {
        tbody.innerHTML =
          `<tr><td colspan="7" class="px-3 py-6 text-center text-xs text-gray-400">Belum ada opname.</td></tr>`;
        return;
      }
      const tone = { DRAFT: "badge-warn", SELESAI: "badge-so", BATAL: "badge-neutral" };
      tbody.innerHTML = rows
        .map(
          (r) => `
          <tr class="border-b border-gray-50 dark:border-gray-700/50">
            <td class="px-3 py-2 font-mono text-xs">#${r.id_opname}</td>
            <td class="px-3 py-2 text-sm">${window.spekEscape(r.nama_gudang || "—")}</td>
            <td class="px-3 py-2 font-mono text-xs">${r.waktu_mulai ? formatUtcToLocal(r.waktu_mulai) : "—"}</td>
            <td class="px-3 py-2 font-mono text-xs">${r.waktu_selesai ? formatUtcToLocal(r.waktu_selesai) : "—"}</td>
            <td class="px-3 py-2 text-sm">${window.spekEscape(r.oleh || "—")}</td>
            <td class="px-3 py-2 text-center text-sm">${r.jumlah_dihitung}/${r.jumlah_baris}</td>
            <td class="px-3 py-2 text-center">
              <span class="badge ${tone[r.status] || "badge-neutral"}">${r.status}</span>
            </td>
          </tr>`,
        )
        .join("");
    } catch (e) {
      /* the sheet above is the working surface; history is supporting detail */
    }
  }

  // Delegated, because the sheet is rebuilt from a template string on every
  // load and per-row listeners would have to be re-bound each time.
  el("inv-opname-sheet")?.addEventListener("input", (e) => {
    const tr = e.target.closest("[data-opname-row]");
    if (!tr || !_opnameAktif) return;
    const raw = tr.querySelector("[data-opname-fisik]").value.trim();
    const row = _opnameAktif.baris.find((b) => b.id_part === parseInt(tr.dataset.part, 10));
    const cell = tr.querySelector("[data-opname-selisih]");
    if (!row || !cell) return;
    if (raw === "") {
      cell.textContent = "—";
      cell.className = "px-3 py-2 text-center text-sm text-gray-300";
      return;
    }
    const sel = parseInt(raw, 10) - row.stok_kini;
    cell.textContent = (sel > 0 ? "+" : "") + sel;
    cell.className =
      "px-3 py-2 text-center text-sm " +
      (sel === 0 ? "text-gray-400"
        : sel > 0 ? "text-green-600 dark:text-green-400 font-bold"
          : "text-red-600 dark:text-red-400 font-bold");
  });

  el("inv-opname-sheet")?.addEventListener("click", async (e) => {
    if (e.target.closest("#inv-opname-simpan")) {
      await _saveOpname(false);
      return;
    }
    if (e.target.closest("#inv-opname-batal")) {
      if (!(await customConfirm({
        title: "Batalkan opname?",
        message: "Hitungan yang sudah dimasukkan akan dibuang dan stok tidak diubah.",
        confirmText: "Batalkan",
        danger: true,
      }))) return;
      const res = await apiFetch(`/inventaris/opname/${_opnameAktif.id_opname}/batal`, {
        method: "POST",
      });
      if (!res.ok) {
        showToast("Gagal membatalkan opname.", "error");
        return;
      }
      showToast("Opname dibatalkan.", "success");
      loadOpname();
      return;
    }
    if (e.target.closest("#inv-opname-selesai")) {
      // Save first: posting reads the SERVER's copy of the sheet, so an unsaved
      // number typed a second ago would otherwise be silently dropped.
      if (!(await _saveOpname(true))) return;
      const n = _collectOpname().filter((b) => b.stok_fisik !== null).length;
      if (!(await customConfirm({
        title: "Selesaikan opname?",
        message:
          `${n} baris akan dibandingkan dengan stok saat ini, dan setiap selisih ` +
          "dicatat sebagai penyesuaian (ADJ_IN / ADJ_OUT). Tindakan ini mengubah stok.",
        confirmText: "Selesaikan",
      }))) return;

      const res = await apiFetch(`/inventaris/opname/${_opnameAktif.id_opname}/selesai`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(d.detail || "Gagal menyelesaikan opname.", "error");
        return;
      }
      showToast(d.message || "Opname selesai.", "success");
      loadOpname();
      loadInvParts();
    }
  });

  el("inv-opname-buka")?.addEventListener("click", async () => {
    const gid = parseInt(el("inv-opname-gudang")?.value, 10);
    if (!gid) {
      showToast("Pilih gudang dulu.", "warning");
      return;
    }
    const res = await apiFetch("/inventaris/opname", {
      method: "POST",
      body: JSON.stringify({ id_gudang: gid }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(d.detail || "Gagal membuka opname.", "error");
      return;
    }
    showToast(d.message || "Opname dibuka.", "success");
    loadOpname();
  });

})();
