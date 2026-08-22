// ═══════════════════════════════════════════════════════════════════════
// Kelola Data Alat Kerja: the table, the grouping panels and the
// bulk importer.
//
// Part of the RAMCES frontend. These files are plain classic scripts
// loaded in a fixed order by index.html - no bundler, no modules. They
// share one global scope, so a top-level `let` or `const` declared twice
// across two files is a fatal SyntaxError; see CLAUDE.md.
// ═══════════════════════════════════════════════════════════════════════

// ── KDAK (Kelola Aset Alat Kerja) ────────────────────────────────────────

// ── Stats ──
// Six fleet-wide numbers. They used to reduce `db`, a client-side copy of every
// asset; the same six are grouped server-side and arrive as one ~6 KB rollup.
async function updateKdakStats() {
  const agg = await getRingkasan();
  const total = agg.total;
  const so = agg.so;
  const tso = agg.tso;
  const jenisUnik = agg.jenis_unik;
  const lokasiUnik = agg.lokasi_unik;
  const avail = total > 0 ? Math.round((so / total) * 100) : null;
  const delta = avail !== null ? avail - _benchmarkPct : null;

  const terbaru = agg.bulan_ini;

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

/**
 * Kelola Data Alat Kerja — ONE page, filtered and sorted by the server.
 *
 * The same conversion as Kelola Data Aset, and for the same reason: this used
 * to filter and sort a client-side copy of the whole fleet. `_kdakSortFilters`
 * is the same shape as `_sortFilters`, so it goes through the same
 * asetFilterParams() and the same api/query.py rules.
 */
async function renderKdakTable() {
  const tbody = document.getElementById("kdak-table-body");
  const countEl = document.getElementById("kdak-table-count");
  if (!tbody) return;

  // Third caller of the shared renderer. `_kdakSortFilters` is the same shape
  // as `_sortFilters` and `_afkirSortFilters`, so all three surface identically.
  window.renderFilterChips?.("kdak-filter-chips", _kdakSortFilters, () => {
    resetPage("kdak");
    renderKdakTable();
  }, [
    {
      key: "__q",
      label: "Cari",
      value: _kdakSearch.trim(),
      clear: () => {
        _kdakSearch = "";
        const box = document.getElementById("kdak-search");
        if (box) box.value = "";
      },
    },
  ]);

  const params = asetFilterParams(_kdakSortFilters, {
    q: _kdakSearch,
    sort: _kdakSortField,
    dir: _kdakSortDir,
  });
  const { limit, offset } = pagerRequest("kdak");
  params.set("limit", limit);
  params.set("offset", offset);

  skeletonRows("kdak-table-body", 11, Math.min(limit, 6));

  let page;
  try {
    page = await fetchAsetPage(params);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="11" class="text-center py-10 text-sm text-red-500">${e.message}</td></tr>`;
    return;
  }

  const _kdakPage = serverPage("kdak", page.total, page.items);
  if (_kdakPage.stale) return renderKdakTable();

  // The count reports the whole filtered set, not the page — it answers "how
  // many match", which paging must not change.
  if (countEl) countEl.textContent = `${page.total} aset`;

  renderPagerBar("kdak-pager", _kdakPage, renderKdakTable);

  if (!_kdakPage.items.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="text-center py-10 text-sm text-gray-400">Tidak ada data ditemukan.</td></tr>`;
    return;
  }

  tbody.innerHTML = _kdakPage.items
    .map((a) => {
      // Badge 1: SO / TSO
      const isSO = a.status_terakhir === "SO";
      const kondisiBadge = isSO
        ? `<span class="badge badge-so"><i class="fas fa-circle text-[6px]"></i>SO</span>`
        : `<span class="badge badge-tso"><i class="fas fa-circle text-[6px]"></i>TSO</span>`;

      // Badge 2: Kalibrasi. Carried by /api/aset since rev0.4.5 —
      // see _card_facts() — rather than by a fleet-wide summary download.
      // Same one rule as Kelola Data Aset; see kalibrasiBadgeState().
      const kalibBadge = window.kalibrasiBadgeHtml(a);

      // Badge 3: Mutasi status
      const mutasiBadge = (a.mutasi_count > 0)
        ? a.mutasi_sudah_kembali
          ? `<span class="badge badge-so"><i class="fas fa-circle text-[6px]"></i>DI LOKASI ASAL</span>`
          : `<span class="badge badge-move"><i class="fas fa-circle text-[6px]"></i>SEDANG TERMUTASI</span>`
        : `<span class="badge badge-neutral"><i class="fas fa-circle text-[6px]"></i>TIDAK TERMUTASI</span>`;

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

// The three grouping views below roll the WHOLE fleet up, so they take it as an
// argument rather than reading `db` — which is now one page. `ensureFleet()`
// fetches it once, on the first modal that asks, and caches it until a mutation.
function _buildAlatGroups(fleet, filterCode, sortVal) {
  const map = {};
  (fleet || []).forEach((a) => {
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

function _buildLokasiGroups(fleet, filterLokasi, filterUpt, sortVal) {
  const map = {};
  (fleet || []).forEach((a) => {
    // Shared identity, not a second derivation. This used to read the parent
    // out of uptDatabase, which silently fell back to treating a UPT code as
    // its own parent whenever the code was missing from that table.
    const ident = assetLokasiIdentity(a);
    const uptCode = ident.uptCode || "—";

    if (!lokasiMatchesCode(ident, filterLokasi)) return;
    if (filterUpt && uptCode !== filterUpt) return;

    if (!map[uptCode])
      map[uptCode] = {
        code: uptCode,
        name: ident.uptName || uptCode,
        parentCode: ident.parentCode,
        count: 0,
      };
    map[uptCode].count++;
  });
  let arr = Object.values(map);
  if (sortVal === "count-desc") arr.sort((a, b) => b.count - a.count);
  else if (sortVal === "count-asc") arr.sort((a, b) => a.count - b.count);
  // Natural order, so 1.2 comes before 1.10 — a plain localeCompare on the
  // label puts "1.10" first, which reads as a bug in a numbered resort list.
  else if (sortVal === "name-asc") arr.sort((a, b) => compareNaturalLabel(a.name, b.name));
  else if (sortVal === "name-desc") arr.sort((a, b) => compareNaturalLabel(b.name, a.name));
  return arr;
}

// ── Terbaru modal helpers ──
async function _renderTerbaruList(from, to) {
  const list = document.getElementById("kdak-terbaru-list");
  const label = document.getElementById("kdak-terbaru-count-label");
  if (!list) return;

  const fleet = await ensureFleet({ silent: true });
  const filtered = fleet.filter((a) => {
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
// async because SheetJS is now fetched on demand rather than loaded in <head>.
async function downloadKdakSampleExcel() {
  if (!(await ensureXLSX())) return;
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

  XLSX.writeFile(wb, "Template_Import_Aset_RAMCES.xlsx");
}

// ── Import Excel handler ──
async function processKdakImportFile(file) {
  if (!(await ensureXLSX())) return 0;
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

// ── KDAK: Two-step confirmation modal helper ──
let _kdakPendingAction = null;

document.getElementById("kdak-confirm-cancel")?.addEventListener("click", () => {
  _kdakPendingAction = null;
  document.getElementById("kdak-confirm-modal")?.classList.add("hidden");
});

document.getElementById("kdak-confirm-ok")?.addEventListener("click", async () => {
  document.getElementById("kdak-confirm-modal")?.classList.add("hidden");
  if (_kdakPendingAction) { await _kdakPendingAction(); _kdakPendingAction = null; }
});

// ── KDAK Edit ──
// ══════════════════════════════════════════════════════════════════════════
// STEP 1b — MODEL/TYPE
//
// Client request: "setelah input 1. alat kerja, tambahkan model alat kerja".
// Both KDAK forms (Tambah and Edit) carry the same step; neither could set a
// Model/Type before, so every asset's model came from seed.py and nowhere else.
//
// Reads the `_varianByAlat` index that masterdata.js already maintains — one
// fetch of /master/varian serves the whole session.
// ══════════════════════════════════════════════════════════════════════════

const KDAK_MODEL_NEW = "__new__";

/**
 * Fill a Model/Type select with the models of `kodeAlat`.
 * `selectedId` re-selects a value across a repopulate (the edit form).
 */
function fillModelSelect(selectId, kodeAlat, selectedId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;

  if (!kodeAlat) {
    sel.innerHTML = `<option value="">— Pilih Alat Kerja terlebih dahulu... —</option>`;
    return;
  }

  const models = (typeof _varianByAlat === "object" && _varianByAlat[kodeAlat]) || [];
  const opts = models
    .map((v) => {
      const label = v.judul || v.nama_varian;
      const sub = v.merk && v.tipe_model ? "" : " (spesifikasi belum lengkap)";
      return `<option value="${v.id_varian}"${String(v.id_varian) === String(selectedId) ? " selected" : ""}>${window.spekEscape(label + sub)}</option>`;
    })
    .join("");

  sel.innerHTML =
    `<option value="">${models.length ? "— Tanpa Model/Type —" : "— Belum ada Model/Type —"}</option>` +
    opts +
    `<option value="${KDAK_MODEL_NEW}">+ Tambah Model/Type baru…</option>`;
}

/**
 * "+ Tambah Model/Type baru…" — hand over to Pusat Data ▸ Model/Type with the
 * alat kerja pre-filled. The same shortcut shape Kelola Inventaris uses for
 * Gudang, so a missing prerequisite never dead-ends a form.
 */
function handleModelSelectChange(sel, kodeAlatSelectId) {
  if (sel.value !== KDAK_MODEL_NEW) return;
  sel.value = "";
  const kode = document.getElementById(kodeAlatSelectId)?.value || "";
  if (!kode) {
    showToast("Pilih Alat Kerja terlebih dahulu.", "warning");
    return;
  }
  document.getElementById("kdak-tambah-modal")?.classList.add("hidden");
  document.getElementById("kdak-edit-modal")?.classList.add("hidden");
  switchView("masterdata");
  if (typeof window.openMasterVarianFor === "function")
    window.openMasterVarianFor(kode);
}

document.getElementById("in-alat")?.addEventListener("change", (e) => {
  fillModelSelect("in-model", e.target.value, "");
});
document.getElementById("in-model")?.addEventListener("change", (e) => {
  handleModelSelectChange(e.target, "in-alat");
});
document.getElementById("kdak-edit-alat")?.addEventListener("change", (e) => {
  fillModelSelect("kdak-edit-model", e.target.value, "");
});
document.getElementById("kdak-edit-model")?.addEventListener("change", (e) => {
  handleModelSelectChange(e.target, "kdak-edit-alat");
});

window.fillModelSelect = fillModelSelect;

// ══════════════════════════════════════════════════════════════════════════
// LIVE id_aset PREVIEW
// ══════════════════════════════════════════════════════════════════════════
//
// Format: <urutan>.<kode_alat>.<pengadaan>.<yy>.<peruntukan>.<lokasi>
//         e.g. 6.RGM.1.24.A.D1
//
// Five of those six segments come from choices made in this form, and all five
// are part of the asset's composite PRIMARY KEY — so a wrong pick is not a
// display bug, it is a malformed key that cannot be corrected later without
// rewriting every child row. The preview exists to put that consequence on
// screen while the choice is still cheap.
//
// The rules here mirror create_aset()/update_aset() in api/aset.py exactly. If
// those change, change these.
// ══════════════════════════════════════════════════════════════════════════

const KDAK_PERUNTUKAN_KODE = { A: "A", B: "B", C: "C", D: "D" };

const KDAK_ID_SEGMENTS = [
  ["urutan", "no. urut"],
  ["alat", "alat kerja"],
  ["pengadaan", "pengadaan"],
  ["tahun", "tahun"],
  ["peruntukan", "peruntukan"],
  ["lokasi", "wilayah"],
];

/**
 * The sequence number a NEW asset of this kode_alat would most likely get.
 *
 * create_aset() takes max(urutan) + 1 over every asset sharing the kode_alat —
 * never a row count, because deleting one would then make the next create reuse
 * a live number.
 *
 * The SERVER answers this now (`urutan_berikutnya` on /ringkasan), and that made
 * the preview EXACT rather than an estimate. Deriving it from the client's
 * cached fleet was always slightly wrong: that array excludes AFKIR assets, so
 * a scrapped machine holding the highest number made the preview disagree with
 * the id the server went on to mint. The server's max is over every row.
 *
 * Still returns null if the rollup has not arrived, and the caller still renders
 * a placeholder for this ONE segment — every other segment is the user's own
 * input and stays exact either way.
 */
function _kdakNextUrutan(kodeAlat) {
  const agg = window.ringkasanIfLoaded?.();
  if (!kodeAlat || !agg || !agg.urutan_berikutnya) return null;
  return agg.urutan_berikutnya[kodeAlat] ?? 1;
}

/**
 * Read the six ID segments out of one of the two forms.
 * `cfg.urutan` is supplied by the caller: known exactly on edit, estimated on
 * create.
 */
function _kdakReadSegments(cfg) {
  const val = (id) => document.getElementById(id)?.value || "";
  const radio = (name) =>
    document.querySelector(`input[name="${name}"]:checked`)?.value || "";

  const tanggal = val(cfg.tanggal);
  let tahun = "";
  if (tanggal) {
    const y = parseInt(tanggal.slice(0, 4), 10);
    // Matches the server: last two digits from 2000 on, the bare year before.
    if (Number.isFinite(y)) tahun = y >= 2000 ? String(y).slice(-2) : String(y);
  }

  const pengadaanRaw = radio(cfg.pengadaan);
  return {
    urutan: cfg.urutan,
    alat: val(cfg.alat),
    // 1 = PUSAT, 2 = DAOP/DIVRE — normalise_sumber_pengadaan() in api/deps.py.
    pengadaan: pengadaanRaw ? (pengadaanRaw === "PUSAT" ? "1" : "2") : "",
    tahun,
    peruntukan: KDAK_PERUNTUKAN_KODE[radio(cfg.unit)] || "",
    // The PARENT wilayah code, never the UPT — the UPT is stored on the row.
    lokasi: val(cfg.lokasi),
  };
}

/**
 * Repaint the preview and the step markers for one form.
 * `mode` is "create" or "edit".
 */
function renderIdPreview(cfg) {
  const out = document.getElementById(cfg.preview);
  if (!out) return;

  const segs = _kdakReadSegments(cfg);

  out.innerHTML = KDAK_ID_SEGMENTS.map(([key], i) => {
    const dot = i ? '<span class="id-seg-empty">.</span>' : "";
    const v = segs[key];
    return v
      ? `${dot}<span>${window.spekEscape(String(v))}</span>`
      : `${dot}<span class="id-seg-empty">&lt;${KDAK_ID_SEGMENTS[i][1]}&gt;</span>`;
  }).join("");

  const legend = document.getElementById(cfg.legend);
  if (legend) {
    legend.textContent = KDAK_ID_SEGMENTS.map(([, label]) => label).join(" · ");
  }

  // Step completion. `.is-done` for a step that has a value, `.is-active` for
  // the first that does not — so the form always says where to go next.
  let activeMarked = false;
  for (const step of cfg.steps) {
    const el = document.getElementById(step.id);
    if (!el) continue;
    const filled = step.optional || Boolean(segs[step.seg] || (step.value && step.value()));
    el.classList.toggle("is-done", filled);
    const active = !filled && !activeMarked;
    el.classList.toggle("is-active", active);
    if (active) activeMarked = true;
  }

  return segs;
}

const KDAK_TAMBAH_PREVIEW = {
  alat: "in-alat", pengadaan: "in-pengadaan", tanggal: "in-tanggal",
  unit: "in-unit", lokasi: "in-lokasi",
  preview: "in-preview", legend: "in-preview-legend",
  steps: [
    { id: "step-in-alat", seg: "alat" },
    { id: "step-in-model", optional: true },
    { id: "step-in-pengadaan", seg: "pengadaan" },
    { id: "step-in-tanggal", seg: "tahun" },
    { id: "step-in-unit", seg: "peruntukan" },
    { id: "step-in-lokasi", seg: "lokasi" },
    { id: "step-in-upt", optional: true },
  ],
};

const KDAK_EDIT_PREVIEW = {
  alat: "kdak-edit-alat", pengadaan: "kdak-edit-pengadaan",
  tanggal: "kdak-edit-tanggal", unit: "kdak-edit-unit", lokasi: "kdak-edit-lokasi",
  preview: "kdak-edit-preview", legend: "kdak-edit-preview-legend",
  steps: [
    { id: "step-kdak-edit-alat", seg: "alat" },
    { id: "step-kdak-edit-model", optional: true },
    { id: "step-kdak-edit-pengadaan", seg: "pengadaan" },
    { id: "step-kdak-edit-tanggal", seg: "tahun" },
    { id: "step-kdak-edit-unit", seg: "peruntukan" },
    { id: "step-kdak-edit-lokasi", seg: "lokasi" },
    { id: "step-kdak-edit-upt", optional: true },
  ],
};

function refreshTambahPreview() {
  const kode = document.getElementById("in-alat")?.value || "";
  const next = _kdakNextUrutan(kode);
  renderIdPreview({ ...KDAK_TAMBAH_PREVIEW, urutan: kode && next ? String(next) : "" });
}

function refreshEditPreview() {
  // update_aset() PRESERVES the original sequence number, so on edit this
  // segment is known exactly rather than estimated.
  const current = document.getElementById("kdak-edit-id")?.value || "";
  const urutan = current.split(".")[0];
  const segs = renderIdPreview({
    ...KDAK_EDIT_PREVIEW,
    urutan: /^\d+$/.test(urutan) ? urutan : "",
  });

  // Changing alat / pengadaan / tahun / peruntukan / parent lokasi regenerates
  // the primary key and re-parents every child row. Say so before they submit.
  const warn = document.getElementById("kdak-edit-preview-warn");
  if (warn && segs) {
    const rebuilt = [
      segs.urutan, segs.alat, segs.pengadaan, segs.tahun, segs.peruntukan, segs.lokasi,
    ];
    const complete = rebuilt.every(Boolean);
    warn.classList.toggle("hidden", !(complete && rebuilt.join(".") !== current));
  }
}

// Both forms repaint on any change to a field that feeds a segment. Delegated
// on the form so a re-rendered select cannot multiply listeners.
document.getElementById("form-input-baru")?.addEventListener("change", refreshTambahPreview);
document.getElementById("form-input-baru")?.addEventListener("input", refreshTambahPreview);
document.getElementById("form-kdak-edit")?.addEventListener("change", refreshEditPreview);
document.getElementById("form-kdak-edit")?.addEventListener("input", refreshEditPreview);

window.refreshTambahPreview = refreshTambahPreview;
window.refreshEditPreview = refreshEditPreview;

window.openKdakEdit = function(idAset) {
  const a = asetById(idAset);
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

  // Step 1b — Model/Type and the per-unit serial
  fillModelSelect("kdak-edit-model", a.kode_alat, a.id_varian);
  const seriEl = document.getElementById("kdak-edit-seri");
  if (seriEl) seriEl.value = a.nomor_seri || "";

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
  // Filtered by the peruntukan radio set just above, and the asset's own UPT
  // re-selected only if the filter still offers it.
  const uptSel = document.getElementById("kdak-edit-upt");
  if (uptSel) {
    uptSel.value = uptCode;
    kdakSyncUpt("edit", { keepUpt: true });
  }

  // Paint the preview from the asset's CURRENT values, so the starting state
  // shows the existing ID and every step reads as done. Any edit from here is
  // then visibly a change to that ID rather than a fresh construction.
  refreshEditPreview();

  document.getElementById("kdak-edit-modal")?.classList.remove("hidden");
};

// ── UPT list ⇄ peruntukan ───────────────────────────────────────────────
//
// The UPT dropdown must offer only the resorts that can hold an asset of the
// chosen peruntukan. It offered all of them: JALAN REL + DAOP 1 listed 31
// options — 25 JR, 4 JB, 2 ME — so six of them produced an asset whose id_aset
// peruntukan segment contradicted the resort named in the same id. Since the
// importer began deriving peruntukan from the resort prefix, this form was the
// only remaining way to create that contradiction.
//
// Both KDAK forms go through here, and it is wired to BOTH inputs: changing the
// peruntukan radio must repopulate the list just as changing the region does,
// or the filter would only apply in one order of use.
const KDAK_UPT_FORMS = {
  tambah: { lokasi: "in-lokasi", upt: "in-upt", unit: "in-unit" },
  edit: { lokasi: "kdak-edit-lokasi", upt: "kdak-edit-upt", unit: "kdak-edit-unit" },
};

function kdakSyncUpt(which, { keepUpt = false } = {}) {
  const cfg = KDAK_UPT_FORMS[which];
  if (!cfg) return;
  const lokasiSel = document.getElementById(cfg.lokasi);
  const uptSel = document.getElementById(cfg.upt);
  if (!uptSel) return;

  const previous = uptSel.value;
  const unit =
    document.querySelector(`input[name="${cfg.unit}"]:checked`)?.value || "";
  applyUptSelect(lokasiSel?.value || "", uptSel, unit);

  // On open, the asset's stored UPT is re-selected when it is still offered.
  // When it is NOT — an existing asset whose resort disagrees with its own
  // peruntukan, which the old unfiltered form could produce — it is dropped
  // rather than forced back in, so saving the form corrects the row instead of
  // silently preserving the contradiction. The preview repaints either way, so
  // the change is visible before submit.
  if (keepUpt && previous && uptSel.querySelector(`option[value="${previous}"]`)) {
    uptSel.value = previous;
  }
}

window.kdakSyncUpt = kdakSyncUpt;

document.getElementById("kdak-edit-lokasi")?.addEventListener("change", () => {
  kdakSyncUpt("edit"); // clears any stale UPT — see applyUptSelect
});
document.querySelectorAll('input[name="kdak-edit-unit"]').forEach((r) =>
  r.addEventListener("change", () => kdakSyncUpt("edit")),
);
document.querySelectorAll('input[name="in-unit"]').forEach((r) =>
  r.addEventListener("change", () => kdakSyncUpt("tambah")),
);

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
  if (!peruntukan) { showToast("Pilih Unit Peruntukan terlebih dahulu.", "warning"); return; }
  if (!pengadaan) { showToast("Pilih Sumber Pengadaan terlebih dahulu.", "warning"); return; }
  if (!tanggal) { showToast("Isi Tanggal Pembelian terlebih dahulu.", "warning"); return; }

  const step1 = await customConfirm(
    `Simpan perubahan pada aset "${idAset}"?\n\nID aset mungkin berubah jika terdapat perubahan pada data utama (lokasi, alat, atau tahun).`
  );
  if (!step1) return;

  const step2 = await customConfirm(
    `Konfirmasi akhir: Data aset "${idAset}" akan diperbarui ke database.\n\nPastikan semua perubahan sudah benar sebelum melanjutkan.`
  );
  if (!step2) return;

  // Both fields are now edited by this form (step 1b above). They are still
  // sent EXPLICITLY on every submit rather than omitted: `AsetUpdate` leaves
  // them optional and `update_aset()` distinguishes absent from null, so a
  // payload that skipped them would leave a cleared field unchanged instead of
  // clearing it.
  const modelRaw = document.getElementById("kdak-edit-model")?.value || "";
  const seriRaw = document.getElementById("kdak-edit-seri")?.value?.trim() || "";

  const payload = {
    kode_alat: alat,
    id_lokasi: uptVal || lokasi,
    parent_lokasi: lokasi,
    tanggal_pembelian: tanggal,
    sumber_pengadaan: pengadaan,
    peruntukan,
    id_varian: modelRaw ? parseInt(modelRaw, 10) : null,
    nomor_seri: seriRaw || null,
  };
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
    // Paint the empty preview and mark step 1 active, so the form opens saying
    // what it is going to build and where to start.
    refreshTambahPreview();
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
  document.getElementById("kdak-search")?.addEventListener(
    "input",
    debounce((e) => {
      _kdakSearch = e.target.value;
      // A new search resizes the result set, so the old page number is meaningless.
      resetPage("kdak");
      renderKdakTable();
    }),
  );

  // Sort button — open modal, populate dropdowns
  document.getElementById("kdak-btn-sort")?.addEventListener("click", () => {
    // "kdak-sort-id-tahun-from/-to" exist in no HTML — the call was a no-op.
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
const _refreshAlatList = async () => {
  const alatFilter = document.getElementById("kdak-alat-filter");
  const alatSort = document.getElementById("kdak-alat-sort");
  const fleet = await ensureFleet({ silent: true });
  _renderGroupList(
    "kdak-alat-list",
    _buildAlatGroups(fleet, alatFilter?.value || "", alatSort?.value || "count-desc"),
    "fas fa-wrench",
    "bg-kai-blue/10 dark:bg-blue-900/30 text-kai-blue",
    { pagerMount: "kdak-alat-pager", pagerKey: "group-alat", rerender: () => _refreshAlatList() }
  );
};

const _refreshLokasiList = async () => {
  const lokasiFilter = document.getElementById("kdak-lokasi-filter");
  const uptFilter = document.getElementById("kdak-upt-filter");
  const lokasiSort = document.getElementById("kdak-lokasi-sort");
  const fleet = await ensureFleet({ silent: true });
  _renderGroupList(
    "kdak-lokasi-list",
    _buildLokasiGroups(
      fleet,
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
document.getElementById("kdak-card-per-alat")?.addEventListener("click", async () => {
    const modal = document.getElementById("kdak-alat-modal");
    if (modal) modal.classList.remove("hidden");

    const alatFilter = document.getElementById("kdak-alat-filter");
    if (alatFilter) {
      // Which tool types the fleet actually holds — from the rollup's per_alat
      // keys rather than from a client-side scan of every asset.
      const existing = new Set(Object.keys((await getRingkasan()).per_alat));
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
document.getElementById("kdak-card-per-lokasi")?.addEventListener("click", async () => {
    const modal = document.getElementById("kdak-lokasi-modal");
    if (modal) modal.classList.remove("hidden");

    const lokasiFilter = document.getElementById("kdak-lokasi-filter");
    if (lokasiFilter) {
      // Which parent regions actually hold assets — from the rollup's per_lokasi
      // keys rather than from a scan of every asset.
      const usedParents = new Set(
        Object.keys((await getRingkasan()).per_lokasi).map(
          (code) => getParentLokasiCode(code) || code,
        ),
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
document.getElementById("kdak-card-jenis")?.addEventListener("click", async () => {
  const modal = document.getElementById("kdak-jenis-modal");
  if (modal) modal.classList.remove("hidden");
  const tbody = document.getElementById("kdak-jenis-table-body");
  if (!tbody) return;
  // Counts per tool type, from the rollup. `per_alat` is keyed by kode_alat and
  // splits SO/TSO, which together are the total this column prints.
  const per = (await getRingkasan()).per_alat;
  const countByKode = {};
  Object.entries(per).forEach(([k, v]) => { countByKode[k] = v.so + v.tso; });
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
async function _renderKdakAvailBenchmarkTable(mode) {
  const tbodyId = mode === "ketersediaan" ? "kdak-ketersediaan-table-body" : "kdak-benchmark-table-body";
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;

  // SO/TSO per parent region. `_rollUpLokasi` adds every UPT to its parent,
  // which is what the per-asset loop here used to do one asset at a time.
  const byParent = _rollUpLokasi((await getRingkasan()).per_lokasi);

  tbody.innerHTML = lokasiData.map((region) => {
      const counts = byParent[region.code] || { so: 0, tso: 0 };
      const so = counts.so;
      const total = counts.so + counts.tso;
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
