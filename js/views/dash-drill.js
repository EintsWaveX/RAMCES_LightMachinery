// ═══════════════════════════════════════════════════════════════════════
// Dashboard KPI drill-down modal, js/views/dash-drill.js
//
// Part of the RAMCES frontend. These files are plain classic scripts
// loaded in a fixed order by index.html - no bundler, no modules. They
// share one global scope, so a top-level `let` or `const` declared twice
// across two files is a fatal SyntaxError; see CLAUDE.md.
// ═══════════════════════════════════════════════════════════════════════
//
// The seven KPI cards in #dash-kpi-strip (js/views/dashboard.js) print a
// number and call `window.openDashDrill(mode)`. This file is the door behind
// every one of them: a lazy region -> asset tree on the left, and four tabs
// (Pemeliharaan / Kalibrasi / Mutasi / Ketersediaan) on the right that reuse
// the SAME row renderers the asset detail view uses
// (window.renderRepairRows / renderKalibrasiRows / renderMutasiOriginBar,
// js/views/aset.js), so the two screens can never show a different shape for
// the same data.
//
// ── What this file does NOT do ──
// It never fetches the fleet. Level 1 of the tree (the region list) is
// painted entirely from GET /api/aset/dashboard/ringkasan and .../hirarki,
// both already fetched by the Dashboard's Matriks Kesiapan tab and cached by
// window.getRingkasan() / window.getDashHirarki() (js/views/dashboard.js),
// reading them here costs nothing extra unless the cache is cold, in which
// case it is exactly the one request the strip itself would have made.
// Level 2 (the assets inside one region) is fetched ONCE per region, on
// first expand, through window.fetchAsetPage(), the same paged endpoint
// Kelola Data Aset renders from. tools/verify/test_boot.py asserts none of
// this runs until a card is actually clicked.
//
// `_rollUp()` below is a deliberate SECOND copy of `_rollUpLokasi()` in
// dashboard.js, that function is not exported, and duplicating six lines
// beat asking S2/S3's file to export a helper for a modal it does not know
// about. Keep the two in step if the rollup rule ever changes: sum a region's
// own row plus its own row again under its parent code.
//
// Wrapped in one IIFE exporting only `window.openDashDrill` /
// `window.closeDashDrill`, the same containment trick as
// js/a11y-modal.js and js/views/repair-dashboard.js. Nothing else here is a
// top-level declaration, so it cannot collide with another file sharing this
// global scope.

(function setupDashDrill() {
  "use strict";

  const el = (id) => document.getElementById(id);
  // window.spekEscape is declared in js/views/spektek.js, which loads AFTER
  // this file, safe here because `esc` only ever CALLS it from inside a
  // function invoked at runtime (a click, a render triggered by one), never
  // at this file's own eval time. See CLAUDE.md's load-order rule.
  const esc = (v) => window.spekEscape(v);

  // ── The four detail tabs ────────────────────────────────────────────────
  const TABS = ["repair", "kalibrasi", "mutasi", "ketersediaan"];
  const TAB_IDS = TABS.map((t) => `dash-drill-tab-${t}`);

  // ── One declarative entry per KPI card mode ─────────────────────────────
  // `tab` is the right-pane tab pre-selected on open; `onlyKondisi` narrows
  // the Pemeliharaan table when the card itself was already a status split.
  const _MODE_SPEC = {
    total: { title: "Total Aset", icon: "fa-boxes", tab: "repair", onlyKondisi: null },
    so: { title: "Siap Operasi", icon: "fa-check-circle", tab: "repair", onlyKondisi: "SO" },
    tso: { title: "Tidak Siap", icon: "fa-times-circle", tab: "repair", onlyKondisi: "TSO" },
    kalibrasi: { title: "Kalibrasi", icon: "fa-ruler-combined", tab: "kalibrasi", onlyKondisi: null },
    mutasi: { title: "Mutasi", icon: "fa-exchange-alt", tab: "mutasi", onlyKondisi: null },
    ketersediaan: { title: "Ketersediaan", icon: "fa-gauge-high", tab: "ketersediaan", onlyKondisi: null },
    perhatian: { title: "Perlu Perhatian", icon: "fa-triangle-exclamation", tab: "repair", onlyKondisi: null },
  };

  // Three reason groups for `perhatian`, see the module docstring for why
  // "Belum Kembali" here means "currently sitting at a Balaiyasa" rather than
  // the (much larger) set of every asset that has ever moved: it mirrors the
  // server's `mut_di_balaiyasa`, which is what actually feeds the KPI number.
  const _PERHATIAN_GROUPS = [
    { key: "tso", label: "Tidak Siap Operasi (TSO)", icon: "fa-times-circle" },
    { key: "jatuh-tempo", label: "Jatuh Tempo Kalibrasi", icon: "fa-ruler-combined" },
    { key: "balaiyasa", label: "Belum Kembali (di Balaiyasa)", icon: "fa-warehouse" },
  ];

  // ── Module state, reset at the top of every openDashDrill() call ──────
  let _mode = "total";
  let _agg = null; // GET /api/aset/dashboard/ringkasan, for the current dashboard filter
  let _hir = null; // GET /api/aset/dashboard/hirarki, same filter
  let _aggRoll = {}; // agg.per_lokasi rolled up onto parent codes too
  let _hirRoll = {}; // hir.per_lokasi, same rollup
  let _activeTab = "repair";
  let _onlyKondisi = null;
  // Set only for mode "perhatian" opened from the matrix's ⚑ flag button
  // (data-action="matrix-flag" in js/views/dashboard.js), never from the KPI
  // card. When set, narrows the LEFT TREE to just this one region, see
  // _buildPerhatianTreeHtml(). Does NOT narrow `_agg`/`_hir` (still the same
  // fleet-wide rollup the KPI card itself reads) or the header/footer counts,
  // which stay fleet-wide on purpose: scoping those too would need a second,
  // differently-filtered fetch for a modal that already has everything it
  // needs to draw the one region the user actually asked to see.
  let _scopeLokasi = null;
  let _selected = null; // the asset row object, or null
  let _treeSearch = "";
  let _treeSort = "nama-asc";
  let _rSearch = "";
  let _rSort = "";
  let _wired = false;

  const _regionCache = new Map(); // id_lokasi -> {status:'loading'|'loaded'|'error', items:[]}
  const _riwayatCache = new Map(); // id_aset -> riwayat-kondisi rows, shared by the Pemeliharaan and Ketersediaan tabs
  const _expanded = new Set(); // region keys currently expanded: "CODE" or "GROUP::CODE"

  const _kpiFmt = (n) => (n || 0).toLocaleString("id-ID");

  // ── The current Dashboard filter, so the tree matches the number the user
  // clicked ──
  // The KPI strip renders from getRingkasan/getDashHirarki scoped to the
  // Matriks Kesiapan tab's OWN filter (alat/pengadaan/tahun), see
  // _renderDashKpiStrip() in dashboard.js. Reading the same filter here, via
  // the (also un-exported, but top-level and therefore visible) _dashFilterFor(),
  // is what keeps "1,077 Total Aset" on the card and "1,077" in this modal
  // the same number instead of two independently-fetched ones.
  function _currentDashFilter() {
    const f = typeof _dashFilterFor === "function" ? _dashFilterFor("matrix") : null;
    return { alat: f?.alat || "", pengadaan: f?.pengadaan || "", tahun: f?.tahun || "" };
  }

  /** Second copy of dashboard.js's _rollUpLokasi(), generalised to N fields, see the header note. */
  function _rollUp(perLokasi, fields) {
    const out = {};
    const add = (code, v) => {
      if (!out[code]) out[code] = {};
      fields.forEach((f) => {
        out[code][f] = (out[code][f] || 0) + (v[f] || 0);
      });
    };
    Object.entries(perLokasi || {}).forEach(([code, v]) => {
      add(code, v);
      const parent = typeof getParentLokasiCode === "function" ? getParentLokasiCode(code) : null;
      if (parent && parent !== code) add(parent, v);
    });
    return out;
  }

  function _regionList() {
    return (typeof lokasiData !== "undefined" ? lokasiData : [])
      .slice()
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }

  // ══════════════════════════════════════════════════════════════════════
  // LEVEL 2, fetching and filtering one region's assets
  // ══════════════════════════════════════════════════════════════════════

  async function _ensureRegionLoaded(code) {
    const existing = _regionCache.get(code);
    if (existing && (existing.status === "loaded" || existing.status === "loading")) return existing;
    const entry = { status: "loading", items: [] };
    _regionCache.set(code, entry);
    try {
      const f = _currentDashFilter();
      const p = new URLSearchParams();
      p.set("id_lokasi", code);
      p.set("limit", "1000");
      if (f.alat) p.set("alat", f.alat);
      if (f.pengadaan) p.set("pengadaan", f.pengadaan);
      if (f.tahun) p.set("tahun", f.tahun);
      // so/tso are pre-filtered SERVER-side, matching the KPI card exactly.
      // kalibrasi/mutasi/perhatian are narrowed CLIENT-side after fetch, see
      // _modeFilteredItems()/_groupFilteredItems(), because /api/aset has no
      // "perlu_kalibrasi" or "mutasi_count>0" filter of its own, and a region
      // is small enough that filtering its own page is cheap.
      if (_mode === "so") p.set("status", "SO");
      if (_mode === "tso") p.set("status", "TSO");
      const { items } = await window.fetchAsetPage(p);
      entry.items = items;
      entry.status = "loaded";
    } catch (e) {
      entry.status = "error";
    }
    _regionCache.set(code, entry);
    return entry;
  }

  function _modeFilteredItems(items) {
    if (_mode === "kalibrasi") return items.filter((i) => i.perlu_kalibrasi);
    if (_mode === "mutasi") return items.filter((i) => (i.mutasi_count || 0) > 0);
    return items;
  }

  function _groupFilteredItems(items, group) {
    if (group === "tso") return items.filter((i) => i.status_terakhir === "TSO");
    if (group === "jatuh-tempo") {
      return items.filter((i) => {
        const s = kalibrasiBadgeState(i).teks;
        return s === "JATUH TEMPO" || s.startsWith("SEGERA");
      });
    }
    if (group === "balaiyasa") {
      return items.filter((i) => /^BY/i.test(i.id_lokasi_raw || i.id_lokasi || ""));
    }
    return items;
  }

  function _searchFilteredItems(items) {
    if (!_treeSearch) return items;
    return items.filter((i) => assetMatchesSearch(i, _treeSearch));
  }

  function _sortItems(items) {
    const arr = items.slice();
    switch (_treeSort) {
      case "nama-desc":
        arr.sort((a, b) => (b.kode_alat_name || "").localeCompare(a.kode_alat_name || ""));
        break;
      case "lokasi":
        arr.sort((a, b) =>
          (a.identitas_lokasi_name || a.lokasi_name || "").localeCompare(
            b.identitas_lokasi_name || b.lokasi_name || "",
          ),
        );
        break;
      case "tanggal":
        arr.sort((a, b) => (b.tanggal_pembelian || "").localeCompare(a.tanggal_pembelian || ""));
        break;
      case "jatuh-tempo":
        arr.sort((a, b) => (a.kalibrasi_berlaku || "9999").localeCompare(b.kalibrasi_berlaku || "9999"));
        break;
      case "kejadian":
        arr.sort((a, b) => (b.jumlah_kejadian || 0) - (a.jumlah_kejadian || 0));
        break;
      default: // nama-asc
        arr.sort((a, b) => (a.kode_alat_name || "").localeCompare(b.kode_alat_name || ""));
    }
    return arr;
  }

  // `dir` drives the sort-direction icon (_updateSortIcon), set explicitly
  // per option rather than guessed from the label, because "Jatuh Tempo
  // Terdekat" is ascending (soonest due first) while "Kejadian Terbanyak" is
  // descending, and no naming convention short of stating it plainly covers
  // both.
  function _sortOptionsForMode() {
    const base = [
      { v: "nama-asc", l: "Nama Alat A-Z", dir: "asc" },
      { v: "nama-desc", l: "Nama Alat Z-A", dir: "desc" },
      { v: "lokasi", l: "Lokasi", dir: "asc" },
      { v: "tanggal", l: "Tanggal Pembelian", dir: "desc" },
    ];
    if (_mode === "kalibrasi") base.push({ v: "jatuh-tempo", l: "Jatuh Tempo Terdekat", dir: "asc" });
    else base.push({ v: "kejadian", l: "Kejadian Terbanyak", dir: "desc" });
    return base;
  }

  // Whether a region belongs in the tree AT ALL, ignoring search. Zero-count
  // regions are hidden for the two narrowing modes so the list reads as "the
  // regions that need this", exactly like the card that opened it; so/tso/
  // total/ketersediaan show every region including a real zero, because the
  // fleet's shape is itself part of the answer those cards give.
  function _regionPassesBaseFilter(code) {
    if (_mode === "kalibrasi") return (_hirRoll[code]?.perlu_kalibrasi || 0) > 0;
    if (_mode === "mutasi") return (_hirRoll[code]?.mut_pernah || 0) > 0;
    return true;
  }

  // Region visibility under the search box. A region whose NAME/code matches
  // is shown regardless of whether it has been expanded yet, the tree cannot
  // know its unfetched contents. A region already loaded is ALSO shown (and
  // auto-expanded) when one of its cached rows matches, via the same matcher
  // every other search box in this app uses.
  function _regionMatchesSearch(code, name, groupKey) {
    if (!_treeSearch) return true;
    const norm = normalizeSearchText(_treeSearch);
    if (normalizeSearchText(name).includes(norm)) return true;
    if (normalizeSearchText(code) === norm) return true;
    const entry = _regionCache.get(code);
    if (entry && entry.status === "loaded") {
      const base = groupKey ? _groupFilteredItems(entry.items, groupKey) : _modeFilteredItems(entry.items);
      const matched = base.some((i) => assetMatchesSearch(i, _treeSearch));
      if (matched) _expanded.add(groupKey ? `${groupKey}::${code}` : code);
      return matched;
    }
    return false;
  }

  function _groupRegionCount(code, groupKey) {
    const roll = _hirRoll[code] || {};
    if (groupKey === "tso") return roll.tso || 0;
    if (groupKey === "jatuh-tempo") return (roll.kal_lewat || 0) + (roll.kal_segera || 0);
    if (groupKey === "balaiyasa") return roll.mut_di_balaiyasa || 0;
    return 0;
  }

  // ══════════════════════════════════════════════════════════════════════
  // TREE RENDERING (left pane)
  // ══════════════════════════════════════════════════════════════════════

  function _regionBadgeHtml(code) {
    const roll = _hirRoll[code] || {};
    const aggRoll = _aggRoll[code] || { so: 0, tso: 0 };
    if (_mode === "so") return `<span class="badge badge-so">${aggRoll.so}</span>`;
    if (_mode === "tso") return `<span class="badge badge-tso">${aggRoll.tso}</span>`;
    if (_mode === "kalibrasi") return `<span class="badge badge-info">${roll.perlu_kalibrasi || 0}</span>`;
    if (_mode === "mutasi") return `<span class="badge badge-move">${roll.mut_pernah || 0}</span>`;
    if (_mode === "ketersediaan") {
      const total = aggRoll.so + aggRoll.tso;
      const pct = total ? Math.round((aggRoll.so / total) * 100) : null;
      const cls =
        pct === null
          ? "text-gray-400"
          : pct >= 90
            ? "text-green-600 dark:text-green-400"
            : pct >= 70
              ? "text-amber-600 dark:text-amber-400"
              : "text-red-600 dark:text-red-400";
      return `<span class="text-xs font-bold ${cls}">${pct === null ? "—" : `${pct}%`}</span>`;
    }
    // total / perhatian (perhatian never reaches this, see _buildPerhatianTreeHtml)
    return `<span class="badge badge-neutral">${aggRoll.so + aggRoll.tso}</span>`;
  }

  function _renderRegionRow(code, name, badgeHtml, groupKey) {
    const key = groupKey ? `${groupKey}::${code}` : code;
    const expanded = _expanded.has(key);
    return `
      <div class="dash-drill-region" data-region-key="${esc(key)}">
        <button type="button" class="dash-drill-region-btn" data-action="toggle-region"
          data-code="${esc(code)}" data-group="${esc(groupKey || "")}" aria-expanded="${expanded}">
          <span class="truncate">${esc(name)}</span>
          <span class="flex items-center gap-2 shrink-0">
            ${badgeHtml}
            <i class="fas fa-chevron-${expanded ? "down" : "right"} text-[10px] text-gray-400"></i>
          </span>
        </button>
        ${expanded ? `<div class="dash-drill-region-body">${_renderRegionBody(code, groupKey)}</div>` : ""}
      </div>`;
  }

  function _renderRegionBody(code, groupKey) {
    const entry = _regionCache.get(code);
    if (!entry || entry.status === "loading") {
      return `<div class="p-2 space-y-1.5">${Array.from({ length: 3 })
        .map(() => `<span class="skeleton skeleton-text" style="width:${60 + Math.floor(Math.random() * 25)}%"></span>`)
        .join("")}</div>`;
    }
    if (entry.status === "error") {
      return `<div class="empty-state is-error text-xs py-3"><i class="fas fa-triangle-exclamation"></i>Gagal memuat aset wilayah ini.</div>`;
    }
    let items = groupKey ? _groupFilteredItems(entry.items, groupKey) : _modeFilteredItems(entry.items);
    items = _searchFilteredItems(items);
    items = _sortItems(items);
    if (!items.length) {
      return `<div class="empty-state text-xs py-3">Tidak ada aset yang cocok pada wilayah ini.</div>`;
    }
    return items.map((i) => _renderAssetRow(i)).join("");
  }

  function _renderAssetRow(item) {
    const isSel = _selected && _selected.id_aset === item.id_aset;
    const ident = assetLokasiIdentity(item);
    let badge;
    if (_mode === "kalibrasi") badge = kalibrasiBadgeHtml(item);
    else if (_mode === "mutasi") {
      badge = item.mutasi_sudah_kembali
        ? `<span class="badge badge-so">Kembali</span>`
        : `<span class="badge badge-move">Termutasi</span>`;
    } else {
      badge =
        item.status_terakhir === "SO"
          ? `<span class="badge badge-so">SO</span>`
          : `<span class="badge badge-tso">TSO</span>`;
    }
    return `
      <button type="button" class="dash-drill-asset-row${isSel ? " is-selected" : ""}"
        data-action="select-asset" data-id="${esc(item.id_aset)}">
        <span class="flex-1 min-w-0 text-left">
          <span class="block truncate font-medium">${esc(item.kode_alat_name || item.kode_alat)}${item.nama_varian ? ` — ${esc(item.nama_varian)}` : ""}</span>
          <span class="block truncate text-[11px] text-gray-400">${esc(ident.uptName || ident.parentName || "—")} · ${esc(item.id_aset)}</span>
        </span>
        ${badge}
      </button>`;
  }

  function _buildNormalTreeHtml() {
    const regions = _regionList().filter((r) => _regionPassesBaseFilter(r.code));
    const rowsHtml = regions
      .filter((r) => _regionMatchesSearch(r.code, r.name, null))
      .map((r) => _renderRegionRow(r.code, r.name, _regionBadgeHtml(r.code), null))
      .join("");
    if (!rowsHtml) {
      return `<div class="empty-state"><i class="fas fa-inbox"></i>Tidak ada wilayah yang cocok.</div>`;
    }
    return rowsHtml;
  }

  function _buildPerhatianTreeHtml() {
    // Scoped open (matrix ⚑ button): only the one region requested, still
    // split into the same three reason groups. Unscoped (KPI card): every
    // region, exactly as before.
    const regions = _scopeLokasi
      ? _regionList().filter((r) => r.code === _scopeLokasi)
      : _regionList();
    return _PERHATIAN_GROUPS.map((g) => {
      const totalG =
        g.key === "tso"
          ? _hir?.perhatian?.tso || 0
          : g.key === "jatuh-tempo"
            ? _hir?.perhatian?.kalibrasi || 0
            : _hir?.perhatian?.mutasi || 0;
      const rows = regions
        .filter((r) => _groupRegionCount(r.code, g.key) > 0)
        .filter((r) => _regionMatchesSearch(r.code, r.name, g.key))
        .sort((a, b) => _groupRegionCount(b.code, g.key) - _groupRegionCount(a.code, g.key))
        .map((r) =>
          _renderRegionRow(
            r.code,
            r.name,
            `<span class="badge badge-warn">${_groupRegionCount(r.code, g.key)}</span>`,
            g.key,
          ),
        )
        .join("");
      return `
        <div class="dash-drill-group">
          <div class="dash-drill-group-head">
            <i class="fas ${g.icon}"></i> ${esc(g.label)}
            <span class="dash-drill-group-count">${totalG}</span>
          </div>
          ${rows || `<div class="empty-state text-xs py-2">Tidak ada wilayah pada kategori ini.</div>`}
        </div>`;
    }).join("");
  }

  function _renderTreeBody() {
    const mount = el("dash-drill-tree");
    if (!mount) return;
    mount.innerHTML = _mode === "perhatian" ? _buildPerhatianTreeHtml() : _buildNormalTreeHtml();
    _updateCountFooter();
  }

  function _updateCountFooter() {
    const mount = el("dash-drill-count");
    if (!mount) return;
    if (!_agg || !_hir) {
      mount.textContent = "";
      return;
    }
    if (_mode === "perhatian") {
      // Deliberately BOTH numbers: `total` is the deduplicated KPI figure (one
      // asset counted once even if TSO and overdue at the same time), the sum
      // of the three groups is not, an asset appearing in two groups is two
      // reasons. Printing only one of them reads as a bug; see CLAUDE.md.
      const sumReasons = (_hir.perhatian.tso || 0) + (_hir.perhatian.kalibrasi || 0) + (_hir.perhatian.mutasi || 0);
      mount.textContent = `${_kpiFmt(_hir.perhatian.total)} aset · ${_kpiFmt(sumReasons)} alasan`;
      return;
    }
    let n;
    if (_mode === "so") n = _agg.so;
    else if (_mode === "tso") n = _agg.tso;
    else if (_mode === "kalibrasi") n = _hir.kalibrasi.perlu;
    else if (_mode === "mutasi") n = _hir.mutasi.pernah;
    else n = _agg.total;
    mount.textContent = `${_kpiFmt(n)} aset`;
  }

  function _renderNote() {
    const mount = el("dash-drill-note");
    if (!mount) return;
    if (_mode === "kalibrasi" && _hir) {
      mount.textContent =
        `${_kpiFmt(_hir.kalibrasi.tidak_perlu)} aset dari alat kerja yang tidak memerlukan kalibrasi ` +
        `dikecualikan dari daftar ini.`;
      mount.classList.remove("hidden");
    } else {
      mount.textContent = "";
      mount.classList.add("hidden");
    }
  }

  function _loadingTreeSkeleton() {
    return `<div class="p-2 space-y-2">${Array.from({ length: 6 })
      .map(() => `<span class="skeleton skeleton-text" style="width:${55 + Math.floor(Math.random() * 30)}%"></span>`)
      .join("")}</div>`;
  }

  // ══════════════════════════════════════════════════════════════════════
  // RIGHT PANE
  // ══════════════════════════════════════════════════════════════════════

  function _renderHead() {
    const spec = _MODE_SPEC[_mode];
    const titleEl = el("dash-drill-title");
    const iconEl = el("dash-drill-icon");
    const subEl = el("dash-drill-sub");
    if (titleEl) titleEl.textContent = spec.title;
    if (iconEl) iconEl.className = `fas ${spec.icon} text-kai-blue text-lg`;
    let sub = "";
    if (_agg) {
      if (_mode === "total") sub = `${_kpiFmt(_agg.total)} aset terdaftar`;
      else if (_mode === "so") sub = `${_kpiFmt(_agg.so)} dari ${_kpiFmt(_agg.total)} aset siap operasi`;
      else if (_mode === "tso") sub = `${_kpiFmt(_agg.tso)} dari ${_kpiFmt(_agg.total)} aset tidak siap operasi`;
      else if (_mode === "kalibrasi" && _hir) sub = `${_kpiFmt(_hir.kalibrasi.perlu)} alat kerja memerlukan kalibrasi`;
      else if (_mode === "mutasi" && _hir) sub = `${_kpiFmt(_hir.mutasi.pernah)} aset pernah dimutasi`;
      else if (_mode === "ketersediaan")
        sub = `${_agg.total ? Math.round((_agg.so / _agg.total) * 100) : 0}% ketersediaan armada`;
      else if (_mode === "perhatian" && _hir) sub = `${_kpiFmt(_hir.perhatian.total)} aset memerlukan tindakan`;
    }
    if (subEl) subEl.textContent = sub;
  }

  function _pilihAsetEmpty() {
    return `<div class="empty-state"><i class="fas fa-hand-pointer"></i>Pilih aset dari daftar di sebelah kiri untuk melihat detailnya.</div>`;
  }

  function _tableSkeleton(cols) {
    return `<div class="space-y-2">${Array.from({ length: 4 })
      .map(
        () =>
          `<div class="flex gap-3">${Array.from({ length: cols })
            .map(() => `<span class="skeleton skeleton-text" style="width:${50 + Math.floor(Math.random() * 40)}%"></span>`)
            .join("")}</div>`,
      )
      .join("")}</div>`;
  }

  function _renderSubject() {
    const mount = el("dash-drill-subject");
    if (!mount) return;
    if (!_selected) {
      mount.innerHTML = "";
      return;
    }
    const it = _selected;
    const ident = assetLokasiIdentity(it);
    mount.innerHTML = `
      <div class="dash-drill-subject flex items-start justify-between gap-3 flex-wrap">
        <div class="min-w-0">
          <p class="font-bold text-sm truncate">${esc(it.kode_alat_name || it.kode_alat)}${it.nama_varian ? ` — ${esc(it.nama_varian)}` : ""}</p>
          <p class="text-xs text-gray-400 font-mono truncate">${esc(it.id_aset)} · ${esc(it.nomor_seri || "—")}</p>
          <p class="text-xs text-gray-500 mt-0.5">${esc(ident.parentName || "—")} / ${esc(ident.uptName || "—")}</p>
        </div>
        <span class="badge ${it.status_terakhir === "SO" ? "badge-so" : "badge-tso"}">${esc(it.status_terakhir || "—")}</span>
      </div>`;
  }

  // Every tab already renders _pilihAsetEmpty() when nothing is selected, so
  // disabling the other three tabs until a click landed on an asset row was
  // never load-bearing, it only stopped a user from previewing "this is
  // where Kalibrasi will show up" before picking anything.
  function _tabEnabled(_t) {
    return true;
  }

  function _renderTabsState() {
    TABS.forEach((t) => {
      const btn = el(`dash-drill-tab-${t}`);
      if (btn) btn.disabled = !_tabEnabled(t);
    });
    setSegmented(TAB_IDS, `dash-drill-tab-${_activeTab}`);
  }

  function _rtoolsVisible() {
    if (_activeTab === "mutasi") return false;
    if (_activeTab === "ketersediaan") return !_selected;
    return !!_selected;
  }

  function _rSortOptions() {
    if (_activeTab === "repair")
      return [{ v: "terbaru", l: "Terbaru", dir: "desc" }, { v: "terlama", l: "Terlama", dir: "asc" }];
    if (_activeTab === "kalibrasi")
      return [
        { v: "terbaru", l: "Terbaru", dir: "desc" },
        { v: "jatuh-tempo", l: "Jatuh Tempo Terdekat", dir: "asc" },
      ];
    if (_activeTab === "ketersediaan")
      return [
        { v: "ada-desc", l: "Ada% Tertinggi", dir: "desc" },
        { v: "ada-asc", l: "Ada% Terendah", dir: "asc" },
        { v: "wilayah", l: "Wilayah A-Z", dir: "asc" },
      ];
    return [];
  }

  /** Flip the leading icon on a `.toolbar-select` to match the active option's
   *  direction, asc (A-Z / soonest / lowest first) vs desc (Z-A / newest /
   *  highest first). Falls back to "asc" so a freshly-populated select with no
   *  match yet still shows a sensible icon rather than none. */
  function _updateSortIcon(selectEl, opts, currentVal) {
    if (!selectEl) return;
    const wrap = selectEl.closest(".toolbar-select");
    const icon = wrap?.querySelector(".toolbar-select-icon");
    if (!icon) return;
    const dir = opts.find((o) => o.v === currentVal)?.dir || opts[0]?.dir || "asc";
    icon.className =
      "fas toolbar-select-icon " + (dir === "desc" ? "fa-arrow-down-wide-short" : "fa-arrow-up-short-wide");
  }

  function _renderRTools() {
    const wrap = el("dash-drill-rtools");
    if (!wrap) return;
    const visible = _rtoolsVisible();
    wrap.classList.toggle("hidden", !visible);
    if (!visible) return;
    const sortSel = el("dash-drill-rsort");
    const searchInp = el("dash-drill-rsearch");
    const opts = _rSortOptions();
    if (sortSel) {
      sortSel.innerHTML = opts.map((o) => `<option value="${o.v}">${esc(o.l)}</option>`).join("");
      if (!opts.some((o) => o.v === _rSort)) _rSort = opts[0]?.v || "";
      sortSel.value = _rSort;
      _updateSortIcon(sortSel, opts, _rSort);
    }
    if (searchInp) searchInp.value = _rSearch;
  }

  // ── Pemeliharaan tab ─────────────────────────────────────────────────

  async function _fetchRiwayat(uid) {
    if (_riwayatCache.has(uid)) return _riwayatCache.get(uid);
    const res = await apiFetch(`/riwayat-kondisi/${uid}`, { background: true });
    if (!res.ok) throw new Error("Gagal mengambil riwayat.");
    const data = await res.json();
    _riwayatCache.set(uid, data);
    return data;
  }

  function _rSearchFilterRepair(entries) {
    if (!_rSearch) return entries;
    const norm = normalizeSearchText(_rSearch);
    return entries.filter((h) =>
      [h.kondisi, h.keterangan, h.id_pengguna, h.nama_lokasi, h.peruntukan].some((v) =>
        normalizeSearchText(v).includes(norm),
      ),
    );
  }

  function _rSortRepair(entries) {
    const arr = entries.slice();
    if (_rSort === "terlama") arr.sort((a, b) => (a.waktu_lapor || "").localeCompare(b.waktu_lapor || ""));
    else arr.sort((a, b) => (b.waktu_lapor || "").localeCompare(a.waktu_lapor || ""));
    return arr;
  }

  async function _renderRepairPanel() {
    const mount = el("dash-drill-panel");
    if (!mount) return;
    if (!_selected) {
      mount.innerHTML = _pilihAsetEmpty();
      return;
    }
    const it = _selected;
    const uid = it.id_aset;
    mount.innerHTML = _tableSkeleton(8);
    let history;
    try {
      history = await _fetchRiwayat(uid);
    } catch (e) {
      mount.innerHTML = `<div class="empty-state is-error">${esc(e.message || "Gagal memuat riwayat.")}</div>`;
      return;
    }
    if (!_selected || _selected.id_aset !== uid) return; // the user moved on while this was in flight

    let entries = history.filter((h) => h.kondisi !== "KALIBRASI");
    if (_onlyKondisi) entries = entries.filter((h) => h.kondisi === _onlyKondisi);
    entries = _rSearchFilterRepair(entries);
    entries = _rSortRepair(entries);

    if (!entries.length) {
      mount.innerHTML = `<div class="empty-state"><i class="fas fa-wrench"></i>Belum ada riwayat perbaikan${_onlyKondisi ? ` (${esc(_onlyKondisi)})` : ""}.</div>`;
      return;
    }

    let pemakaian = {};
    try {
      const pres = await apiFetch(`/aset/${uid}/pemakaian`, { background: true });
      if (pres.ok) pemakaian = (await pres.json()).per_riwayat || {};
    } catch (_) {
      /* the table is still useful without the parts */
    }
    if (!_selected || _selected.id_aset !== uid) return;

    mount.innerHTML = `
      <div class="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700 table-stack-wrap">
        <table class="table-stack w-full text-left text-sm whitespace-nowrap">
          <thead class="bg-gray-50 dark:bg-gray-700/50 text-gray-500 text-xs">
            <tr>
              <th class="p-3 font-semibold w-10">No.</th>
              <th class="p-3 font-semibold">Tanggal</th>
              <th class="p-3 font-semibold">Lokasi Pengirim</th>
              <th class="p-3 font-semibold">UPT Pengirim</th>
              <th class="p-3 font-semibold">Peruntukan</th>
              <th class="p-3 font-semibold">Petugas</th>
              <th class="p-3 font-semibold">Kondisi</th>
              <th class="p-3 font-semibold">Keterangan</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100 dark:divide-gray-700/50">${window.renderRepairRows(entries, { pemakaian, asetTerkait: it })}</tbody>
        </table>
      </div>`;
  }

  // ── Kalibrasi tab ────────────────────────────────────────────────────

  function _diasHint(berlaku) {
    if (!berlaku) return "";
    const hariIni = new Date();
    const today = Date.UTC(hariIni.getFullYear(), hariIni.getMonth(), hariIni.getDate());
    const due = Date.parse(`${berlaku.slice(0, 10)}T00:00:00Z`);
    if (isNaN(due)) return "";
    const sisa = Math.round((due - today) / 86400000);
    if (sisa < 0) return `<span class="text-red-500 font-semibold ml-1">(lewat ${Math.abs(sisa)} hari)</span>`;
    return `<span class="text-gray-400 ml-1">(${sisa} hari lagi)</span>`;
  }

  function _rSearchFilterKalibrasi(entries) {
    if (!_rSearch) return entries;
    const norm = normalizeSearchText(_rSearch);
    return entries.filter((h) =>
      [h.status, h.pelaksana_kalibrasi, h.nomor_sertifikat, h.keterangan].some((v) =>
        normalizeSearchText(v).includes(norm),
      ),
    );
  }

  function _rSortKalibrasi(entries) {
    const arr = entries.slice();
    if (_rSort === "jatuh-tempo") arr.sort((a, b) => (a.tanggal_berlaku || "9999").localeCompare(b.tanggal_berlaku || "9999"));
    else arr.sort((a, b) => (b.waktu_input || "").localeCompare(a.waktu_input || ""));
    return arr;
  }

  async function _renderKalibrasiPanel() {
    const mount = el("dash-drill-panel");
    if (!mount) return;
    if (!_selected) {
      mount.innerHTML = _pilihAsetEmpty();
      return;
    }
    const it = _selected;
    if (!it.perlu_kalibrasi) {
      mount.innerHTML = `<div class="empty-state"><i class="fas fa-ruler-combined"></i>${esc(it.kode_alat_name || it.kode_alat)} bukan alat kerja yang memerlukan kalibrasi.</div>`;
      return;
    }
    const uid = it.id_aset;
    mount.innerHTML = _tableSkeleton(9);
    let history;
    try {
      const res = await apiFetch(`/kalibrasi/${uid}`, { background: true });
      if (!res.ok) throw new Error("Gagal mengambil riwayat kalibrasi.");
      history = await res.json();
    } catch (e) {
      mount.innerHTML = `<div class="empty-state is-error">${esc(e.message || "Gagal memuat riwayat kalibrasi.")}</div>`;
      return;
    }
    if (!_selected || _selected.id_aset !== uid) return;

    const state = kalibrasiBadgeState(it);
    const statusBlock = `
      <div class="dash-drill-kal-status">
        <span class="badge ${state.kelas} text-sm">${esc(state.teks)}</span>
        <div class="text-xs text-gray-500 mt-1">
          Berlaku sampai <span class="font-semibold">${it.kalibrasi_berlaku ? formatDateOnly(it.kalibrasi_berlaku) : "—"}</span>
          ${_diasHint(it.kalibrasi_berlaku)}
        </div>
      </div>`;

    let entries = _rSearchFilterKalibrasi(history);
    entries = _rSortKalibrasi(entries);
    const canDelete = _currentRole === "SUPER_ADMIN" || _currentRole === "ADMIN_WILAYAH";
    const tableHtml = entries.length
      ? `
      <div class="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700 table-stack-wrap mt-3">
        <table class="table-stack w-full text-left text-sm whitespace-nowrap">
          <thead class="bg-gray-50 dark:bg-gray-700/50 text-gray-500 dark:text-gray-400 text-xs">
            <tr>
              <th class="p-3 font-semibold w-10">No.</th>
              <th class="p-3 font-semibold">Waktu Input</th>
              <th class="p-3 font-semibold">Tanggal Kalibrasi</th>
              <th class="p-3 font-semibold">Tanggal Berlaku</th>
              <th class="p-3 font-semibold">Status</th>
              <th class="p-3 font-semibold">Pelaksana</th>
              <th class="p-3 font-semibold">No. Sertifikat</th>
              <th class="p-3 font-semibold text-center">Berkas</th>
              <th class="p-3 font-semibold">Catatan</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-cyan-100 dark:divide-cyan-800/50">${window.renderKalibrasiRows(entries, { uid, canDelete })}</tbody>
        </table>
      </div>`
      : `<div class="empty-state mt-3">Belum ada riwayat kalibrasi.</div>`;

    mount.innerHTML = statusBlock + tableHtml;
  }

  // ── Mutasi tab ───────────────────────────────────────────────────────

  async function _renderMutasiPanel() {
    const mount = el("dash-drill-panel");
    if (!mount) return;
    if (!_selected) {
      mount.innerHTML = _pilihAsetEmpty();
      return;
    }
    const uid = _selected.id_aset;
    mount.innerHTML = `<div class="space-y-2">${Array.from({ length: 2 })
      .map(() => `<span class="skeleton skeleton-text" style="width:70%"></span>`)
      .join("")}</div>`;
    try {
      const res = await apiFetch(`/mutasi/${uid}`, { background: true });
      if (!res.ok) throw new Error("Gagal mengambil riwayat mutasi.");
      const data = await res.json();
      if (!_selected || _selected.id_aset !== uid) return;
      if (!data.mutasi || !data.mutasi.length) {
        mount.innerHTML = `<div class="empty-state"><i class="fas fa-exchange-alt"></i>Belum ada riwayat mutasi.</div>`;
        return;
      }
      mount.innerHTML = `
        <div class="flex flex-wrap gap-5 items-center border border-gray-100 dark:border-gray-700 rounded-lg p-5 bg-gray-50 dark:bg-gray-700/50">
          ${window.renderMutasiOriginBar(data)}
        </div>
        <p class="text-xs text-gray-400 mt-3">Jalur mutasi lengkap (${data.mutasi.length} perpindahan) tersedia di Pantau Riwayat Aset ▸ Mutasi.</p>`;
    } catch (e) {
      mount.innerHTML = `<div class="empty-state is-error">${esc(e.message || "Gagal memuat riwayat mutasi.")}</div>`;
    }
  }

  // ── Ketersediaan tab ─────────────────────────────────────────────────

  function _renderKetersediaanRegions() {
    let regions = _regionList().map((r) => {
      const roll = _aggRoll[r.code] || { so: 0, tso: 0 };
      const total = roll.so + roll.tso;
      const pct = total ? (roll.so / total) * 100 : null;
      return { code: r.code, name: r.name, total, so: roll.so, tso: roll.tso, pct };
    });
    if (_rSearch) {
      const norm = normalizeSearchText(_rSearch);
      regions = regions.filter(
        (r) => normalizeSearchText(r.name).includes(norm) || normalizeSearchText(r.code) === norm,
      );
    }
    if (_rSort === "ada-asc") regions.sort((a, b) => (a.pct ?? 999) - (b.pct ?? 999));
    else if (_rSort === "wilayah") regions.sort((a, b) => a.name.localeCompare(b.name));
    else regions.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));

    if (!regions.length) return `<div class="empty-state">Tidak ada wilayah yang cocok.</div>`;

    const rows = regions
      .map(
        (r) => `
      <tr class="border-b dark:border-gray-700">
        <td class="p-3 text-sm font-medium" data-label="Wilayah">${esc(r.name)}</td>
        <td class="p-3 text-sm text-center" data-label="Total">${r.total}</td>
        <td class="p-3 text-sm text-center text-green-600 dark:text-green-400" data-label="SO">${r.so}</td>
        <td class="p-3 text-sm text-center text-red-600 dark:text-red-400" data-label="TSO">${r.tso}</td>
        <td class="p-3 text-sm" data-label="Ada%">
          <div class="flex items-center gap-2">
            <div class="flex-1 h-1.5 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
              <div class="h-full bg-green-500" style="width:${r.pct === null ? 0 : r.pct}%"></div>
            </div>
            <span class="text-xs font-semibold w-10 text-right">${r.pct === null ? "—" : `${Math.round(r.pct)}%`}</span>
          </div>
        </td>
      </tr>`,
      )
      .join("");

    return `
      <div class="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700 table-stack-wrap">
        <table class="table-stack w-full text-left text-sm">
          <thead class="bg-gray-50 dark:bg-gray-700/50 text-gray-500 text-xs">
            <tr>
              <th class="p-3 font-semibold">Wilayah</th>
              <th class="p-3 font-semibold text-center">Total</th>
              <th class="p-3 font-semibold text-center">SO</th>
              <th class="p-3 font-semibold text-center">TSO</th>
              <th class="p-3 font-semibold">Ada%</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function _availBar(roll, label) {
    const total = roll.so + roll.tso;
    const pct = total ? Math.round((roll.so / total) * 100) : null;
    return `
      <div>
        <div class="flex justify-between text-xs text-gray-500 mb-0.5">
          <span class="truncate">${esc(label)}</span><span class="font-semibold shrink-0 ml-2">${pct === null ? "—" : `${pct}%`} (${roll.so}/${total})</span>
        </div>
        <div class="h-1.5 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
          <div class="h-full bg-green-500" style="width:${pct === null ? 0 : pct}%"></div>
        </div>
      </div>`;
  }

  async function _renderKetersediaanAsset(it) {
    const ident = assetLokasiIdentity(it);
    const uptRoll = _aggRoll[ident.uptCode] || { so: 0, tso: 0 };
    const parentRoll = _aggRoll[ident.parentCode] || { so: 0, tso: 0 };
    const alatRoll = (_agg?.per_alat && _agg.per_alat[it.kode_alat]) || { so: 0, tso: 0 };

    let tsoCount = 0;
    let daysInState = null;
    try {
      const hist = await _fetchRiwayat(it.id_aset);
      if (!_selected || _selected.id_aset !== it.id_aset) return "";
      const nonKal = hist.filter((h) => h.kondisi !== "KALIBRASI");
      tsoCount = nonKal.filter((h) => h.kondisi === "TSO").length;
      if (nonKal.length) {
        const last = nonKal[nonKal.length - 1];
        const t = new Date((last.waktu_lapor || "").replace(" ", "T")).getTime();
        if (!isNaN(t)) daysInState = Math.floor((Date.now() - t) / 86400000);
      }
    } catch (_) {
      /* the stat blocks below still render without the uptime detail */
    }

    return `
      <div class="space-y-4">
        <div class="flex items-center gap-3">
          <span class="badge ${it.status_terakhir === "SO" ? "badge-so" : "badge-tso"} text-sm">${esc(it.status_terakhir || "—")}</span>
          <span class="text-xs text-gray-500">${daysInState === null ? "" : `${daysInState} hari pada status ini`}</span>
        </div>
        ${_availBar(uptRoll, ident.uptName || ident.uptCode || "Lokasi")}
        ${_availBar(parentRoll, ident.parentName || ident.parentCode || "Wilayah")}
        ${_availBar(alatRoll, `${it.kode_alat_name || it.kode_alat} (armada)`)}
        <p class="text-xs text-gray-400">${tsoCount} kejadian TSO tercatat pada riwayat kondisi aset ini.</p>
      </div>`;
  }

  async function _renderKetersediaanPanel() {
    const mount = el("dash-drill-panel");
    if (!mount) return;
    if (_selected) {
      const uid = _selected.id_aset;
      mount.innerHTML = _tableSkeleton(3);
      const html = await _renderKetersediaanAsset(_selected);
      if (_selected && _selected.id_aset === uid) mount.innerHTML = html;
      return;
    }
    mount.innerHTML = _renderKetersediaanRegions();
  }

  async function _renderPanelDispatch() {
    if (_activeTab === "repair") return _renderRepairPanel();
    if (_activeTab === "kalibrasi") return _renderKalibrasiPanel();
    if (_activeTab === "mutasi") return _renderMutasiPanel();
    if (_activeTab === "ketersediaan") return _renderKetersediaanPanel();
  }

  // ══════════════════════════════════════════════════════════════════════
  // SELECTION
  // ══════════════════════════════════════════════════════════════════════

  async function _selectAsset(item) {
    _selected = item;
    el("dash-drill-modal")?.classList.add("is-drilled");
    _renderSubject();
    _renderTabsState();
    _renderRTools();
    _renderTreeBody(); // repaint so the picked row highlights
    await _renderPanelDispatch();
  }

  // ══════════════════════════════════════════════════════════════════════
  // WIRING, every listener guarded by a `dataset.wired` flag so re-opening
  // the modal (openDashDrill called again) cannot attach a second copy.
  // ══════════════════════════════════════════════════════════════════════

  function _wireClose() {
    const btn = el("close-dash-drill-modal");
    if (btn && !btn.dataset.wired) {
      btn.dataset.wired = "1";
      btn.addEventListener("click", () => window.closeDashDrill());
    }
  }

  function _wireBack() {
    const btn = el("dash-drill-back");
    if (btn && !btn.dataset.wired) {
      btn.dataset.wired = "1";
      btn.addEventListener("click", () => {
        el("dash-drill-modal")?.classList.remove("is-drilled");
      });
    }
  }

  function _wireLeftControls() {
    const search = el("dash-drill-search");
    const sort = el("dash-drill-sort");
    if (search && !search.dataset.wired) {
      search.dataset.wired = "1";
      search.addEventListener(
        "input",
        debounce(() => {
          _treeSearch = search.value.trim();
          _renderTreeBody();
        }, 200),
      );
    }
    if (sort && !sort.dataset.wired) {
      sort.dataset.wired = "1";
      sort.addEventListener("change", () => {
        _treeSort = sort.value;
        _updateSortIcon(sort, _sortOptionsForMode(), _treeSort);
        _renderTreeBody();
      });
    }
  }

  function _wireTree() {
    const mount = el("dash-drill-tree");
    if (!mount || mount.dataset.wired) return;
    mount.dataset.wired = "1";
    mount.addEventListener("click", async (e) => {
      const toggleBtn = e.target.closest('[data-action="toggle-region"]');
      if (toggleBtn) {
        const code = toggleBtn.dataset.code;
        const group = toggleBtn.dataset.group || null;
        const key = group ? `${group}::${code}` : code;
        if (_expanded.has(key)) {
          _expanded.delete(key);
          _renderTreeBody();
          return;
        }
        _expanded.add(key);
        _renderTreeBody(); // shows the loading skeleton immediately
        await _ensureRegionLoaded(code);
        _renderTreeBody();
        return;
      }
      const assetBtn = e.target.closest('[data-action="select-asset"]');
      if (assetBtn) {
        const item = typeof asetById === "function" ? asetById(assetBtn.dataset.id) : null;
        if (item) await _selectAsset(item);
      }
    });
  }

  function _wireTabs() {
    const mount = el("dash-drill-tabs");
    if (!mount || mount.dataset.wired) return;
    mount.dataset.wired = "1";
    mount.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-tab]");
      if (!btn || btn.disabled) return;
      const tab = btn.dataset.tab;
      if (!_tabEnabled(tab)) return;
      _activeTab = tab;
      _rSearch = "";
      _rSort = "";
      _renderTabsState();
      _renderRTools();
      await _renderPanelDispatch();
    });
  }

  function _wireRTools() {
    const search = el("dash-drill-rsearch");
    const sort = el("dash-drill-rsort");
    if (search && !search.dataset.wired) {
      search.dataset.wired = "1";
      search.addEventListener(
        "input",
        debounce(() => {
          _rSearch = search.value.trim();
          _renderPanelDispatch();
        }, 200),
      );
    }
    if (sort && !sort.dataset.wired) {
      sort.dataset.wired = "1";
      sort.addEventListener("change", () => {
        _rSort = sort.value;
        _updateSortIcon(sort, _rSortOptions(), _rSort);
        _renderPanelDispatch();
      });
    }
  }

  function _wireOnce() {
    if (_wired) return;
    _wired = true;
    _wireClose();
    _wireBack();
    _wireLeftControls();
    _wireTree();
    _wireTabs();
    _wireRTools();
  }

  function _renderTreeSortOptions() {
    const sel = el("dash-drill-sort");
    if (!sel) return;
    const opts = _sortOptionsForMode();
    sel.innerHTML = opts.map((o) => `<option value="${o.v}">${esc(o.l)}</option>`).join("");
    _treeSort = opts[0].v;
    sel.value = _treeSort;
    _updateSortIcon(sel, opts, _treeSort);
  }

  // ══════════════════════════════════════════════════════════════════════
  // OPEN / CLOSE, the only two exports
  // ══════════════════════════════════════════════════════════════════════

  // Guards the fade+scale open/close pair below against a rapid close-then-
  // reopen: closeDashDrill() defers adding `hidden` until the CSS transition
  // has had time to play, and if openDashDrill() runs again before that timer
  // fires, it must cancel the pending hide, otherwise the freshly reopened
  // modal would vanish 180ms later.
  let _closeTimer = null;

  // `opts.lokasi`, a region code (the same codes `lokasiData` carries, e.g.
  // "D1", "VIII", "BY1"), scopes mode "perhatian"'s left tree to just that
  // region. Only the matrix's ⚑ button (js/views/dashboard.js) passes it;
  // every other caller (all seven KPI cards) calls with one argument, and
  // `opts = {}` there is exactly the fleet-wide behaviour this modal has
  // always had.
  window.openDashDrill = async function openDashDrill(mode, opts = {}) {
    const modal = el("dash-drill-modal");
    if (!modal) return;

    if (_closeTimer) {
      clearTimeout(_closeTimer);
      _closeTimer = null;
    }

    _mode = _MODE_SPEC[mode] ? mode : "total";
    const spec = _MODE_SPEC[_mode];
    _selected = null;
    _regionCache.clear();
    _expanded.clear();
    _treeSearch = "";
    _rSearch = "";
    _rSort = "";
    _activeTab = spec.tab;
    _onlyKondisi = spec.onlyKondisi;
    _scopeLokasi = _mode === "perhatian" && opts && opts.lokasi ? opts.lokasi : null;

    _wireOnce();
    modal.classList.remove("hidden");
    modal.classList.remove("is-drilled");
    // Fade + scale in. `hidden` must come off (and the browser must paint a
    // frame with `.is-open` still absent) before adding it, or the opacity/
    // transform change has nothing to transition FROM, a single
    // requestAnimationFrame is sometimes coalesced with the class removal
    // above by the browser, so this double-rAF is the standard guard against
    // that. See assets/style.css for the transition itself.
    modal.classList.remove("is-open");
    requestAnimationFrame(() => requestAnimationFrame(() => modal.classList.add("is-open")));

    const searchInp = el("dash-drill-search");
    if (searchInp) searchInp.value = "";
    _renderTreeSortOptions();
    el("dash-drill-tree").innerHTML = _loadingTreeSkeleton();
    el("dash-drill-count").textContent = "";
    el("dash-drill-subject").innerHTML = "";
    _renderHead();
    _renderNote();
    _renderTabsState();
    _renderRTools();
    await _renderPanelDispatch();

    const f = _currentDashFilter();
    const [agg, hir] = await Promise.all([window.getRingkasan(f), window.getDashHirarki(f)]);
    // The user may have already closed the modal (or opened a different card)
    // by the time this resolves, painting into a hidden/retargeted modal
    // would silently overwrite whatever the newer call already rendered.
    if (el("dash-drill-modal")?.classList.contains("hidden")) return;
    if (_mode !== mode && _MODE_SPEC[mode]) return;

    _agg = agg;
    _hir = hir;
    _aggRoll = _rollUp(agg.per_lokasi, ["so", "tso"]);
    _hirRoll = _rollUp(hir.per_lokasi, [
      "perlu_kalibrasi",
      "kal_lewat",
      "kal_segera",
      "kal_belum",
      "mut_pernah",
      "mut_belum_kembali",
      "mut_di_balaiyasa",
      "perhatian",
      "so",
      "tso",
    ]);

    // Scoped open: pre-expand the one region's three reason groups and fetch
    // its assets right away, rather than making the user click to expand a
    // tree that can only ever show one row. Mirrors _wireTree()'s own
    // expand-then-fetch sequence (render the skeleton immediately, then
    // render again once the fetch resolves).
    if (_scopeLokasi) {
      _PERHATIAN_GROUPS.forEach((g) => _expanded.add(`${g.key}::${_scopeLokasi}`));
      _renderTreeBody();
      await _ensureRegionLoaded(_scopeLokasi);
    }

    _renderHead();
    _renderNote();
    _renderTreeBody();
  };

  window.closeDashDrill = function closeDashDrill() {
    const modal = el("dash-drill-modal");
    if (!modal) return;
    modal.classList.remove("is-open");
    modal.classList.remove("is-drilled");
    const reduceMotion =
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (modal.classList.contains("hidden") || reduceMotion) {
      modal.classList.add("hidden");
      return;
    }
    // Let the fade-out play before pulling the modal out of layout. Guarded
    // against a reopen racing this timer, see the comment on _closeTimer.
    if (_closeTimer) clearTimeout(_closeTimer);
    _closeTimer = setTimeout(() => {
      _closeTimer = null;
      if (!modal.classList.contains("is-open")) modal.classList.add("hidden");
    }, 180);
  };
})();
