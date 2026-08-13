// ═══════════════════════════════════════════════════════════════════════
// Proses Laporan: filters, previews and the Excel / PDF exporters.
//
// Part of the RAMCES frontend. These files are plain classic scripts
// loaded in a fixed order by index.html - no bundler, no modules. They
// share one global scope, so a top-level `let` or `const` declared twice
// across two files is a fatal SyntaxError; see CLAUDE.md.
// ═══════════════════════════════════════════════════════════════════════

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

/**
 * Count the filters actually set inside each collapsible section and label its
 * summary chip. Progressive disclosure is only safe if the collapsed header
 * still says something is in there.
 */
const _EXP_FILTER_GROUPS = {
  perbaikan: ["exp-date-from", "exp-date-to", "exp-filter-lokasi",
              "exp-filter-upt", "exp-filter-peruntukan", "exp-filter-kondisi"],
  kalibrasi: ["exp-kalib-date-from", "exp-kalib-date-to",
              "exp-filter-kalib-status", "exp-filter-kalib-nomor"],
  mutasi:    ["exp-mutasi-date-from", "exp-mutasi-date-to",
              "exp-filter-mutasi-asal", "exp-filter-mutasi-upt-asal",
              "exp-filter-mutasi-tuju", "exp-filter-mutasi-upt-tuju"],
};

function syncExportFilterChips() {
  Object.entries(_EXP_FILTER_GROUPS).forEach(([group, ids]) => {
    const active = ids.filter(
      (id) => (document.getElementById(id)?.value || "").trim() !== "",
    ).length;
    const chip = document.querySelector(`[data-chip="${group}"]`);
    if (!chip) return;
    chip.textContent = `${active} filter aktif`;
    chip.classList.toggle("hidden", active === 0);
  });
}

function applyExportFilters() {
  syncExportFilterChips();
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
  const summaryItem = summaryFor(r.id_aset);
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
//
// The three cascade parents (exp-filter-lokasi and the two mutasi lokasi
// selects) are deliberately absent: each already calls applyExportFilters()
// from its own change listener in _populateExpLokasiDropdowns, after it has
// rebuilt its dependent UPT select. Listing them here too made every change on
// those controls run the whole filter pass twice.
[
  "exp-date-from", "exp-date-to", "exp-filter-upt",
  "exp-filter-peruntukan", "exp-filter-kondisi",
  "exp-kalib-date-from", "exp-kalib-date-to", "exp-filter-kalib-status", "exp-filter-kalib-nomor",
  "exp-mutasi-date-from", "exp-mutasi-date-to",
  "exp-filter-mutasi-upt-asal", "exp-filter-mutasi-upt-tuju",
].forEach((id) => {
  const node = document.getElementById(id);
  if (!node) return;
  // Text and date inputs fire `input`; selects fire `change`. Binding both to
  // the same element double-fires, so pick by control type.
  node.addEventListener(node.tagName === "SELECT" ? "change" : "input", applyExportFilters);
});

// ── EXCEL EXPORT ──────────────────────────────────────────────────

document
  .getElementById("btn-export-excel")
  ?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-export-excel");
    const orig = btn.innerHTML;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Membuat file...`;
    btn.disabled = true;

    // Fetches SheetJS on first use. The old guard told the user to "wait a
    // moment" for a library that was already loaded or never would be; now the
    // click itself triggers the load, inside the button's own busy state.
    if (!(await ensureXLSX())) {
      btn.innerHTML = orig;
      btn.disabled = false;
      return;
    }

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
    const btn = document.getElementById("btn-export-pdf");
    const orig = btn.innerHTML;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Membuat PDF...`;
    btn.disabled = true;

    // Fetches jsPDF + autotable on first use (see the note on the Excel button).
    if (!(await ensureJsPDF())) {
      btn.innerHTML = orig;
      btn.disabled = false;
      return;
    }

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
        "Keterangan",
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
