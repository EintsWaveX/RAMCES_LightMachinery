// ═══════════════════════════════════════════════════════════════════════
// Asset screens: the edit and history-detail modals, the shared asset
// card, Kelola Data Aset, the mutasi modal and the QR label.
//
// Part of the RAMCES frontend. These files are plain classic scripts
// loaded in a fixed order by index.html - no bundler, no modules. They
// share one global scope, so a top-level `let` or `const` declared twice
// across two files is a fatal SyntaxError; see CLAUDE.md.
// ═══════════════════════════════════════════════════════════════════════

// ── RENDER & DISPLAY ───────────────────────────────────────────────────────

window.openEdit = (uid) => {
  const item = asetById(uid);
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

  const summaryItem = summaryFor(uid);
  const rawLokasiCode = summaryItem?.repair?.latest_id_lokasi || item.id_lokasi;
  const lastUptEntry = _uptByCode.get(rawLokasiCode);
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
  if (_v("edit-card-id")) _v("edit-card-id").textContent = item.id_aset;
  if (_v("edit-card-nama"))
    _v("edit-card-nama").textContent = item.kode_alat_name || item.kode_alat;

  // Status badge + the colour strip along the top of the card. Both go through
  // the .badge component layer rather than hand-rolled Tailwind — this was one
  // of the twenty drifting copies assets/style.css exists to retire.
  const statusEl = _v("edit-card-status");
  if (statusEl) {
    const mod =
      { SO: "badge-so", TSO: "badge-tso", AFKIR: "badge-afkir" }[
        item.status_terakhir
      ] || "badge-neutral";
    statusEl.textContent = item.status_terakhir || "—";
    statusEl.className = `badge ${mod}`;
  }
  const strip = _v("edit-status-strip");
  if (strip) {
    const tone =
      { SO: "bg-green-500", TSO: "bg-red-500", AFKIR: "bg-red-700" }[
        item.status_terakhir
      ] || "bg-gray-300";
    strip.className = `h-1.5 w-full transition-colors duration-500 ${tone}`;
  }

  // "WAJIB KALIBRASI" only for tool types the katalog flags as needing it.
  _v("edit-card-kalib-badge")?.classList.toggle(
    "hidden",
    item.perlu_kalibrasi !== true,
  );

  // ── Informasi Alat Kerja ──
  // The same eight rows landing.html prints, built the same way, so the QR
  // card and this form describe the machine identically.
  const grid = _v("edit-detail-grid");
  if (grid) {
    const row = (label, val) =>
      `<div><dt class="text-[9px] uppercase font-bold text-gray-400 dark:text-gray-500 tracking-wider mb-0.5">${label}</dt>
       <dd class="font-semibold text-gray-800 dark:text-gray-100 text-sm break-words">${window.spekEscape(val ?? "—")}</dd></div>`;
    grid.innerHTML = [
      row("Jenis Alat", item.kode_alat_name || item.kode_alat),
      row("Nomor Seri", item.nomor_seri || "—"),
      row("Model/Type", item.nama_varian || "—"),
      row("Pengadaan", item.sumber_pengadaan || "—"),
      row("Tanggal Beli", tanggalBeli),
      row("Lokasi", lokasiName || "—"),
      row("UPT", uptDisplayForCard),
      row("Peruntukan", peruntukanName),
    ].join("");
  }

  // ── Model/Type spec card ──
  // Fetched rather than read from `db`: the cached asset list carries only the
  // model's NAME, not its photo or spec rows, and duplicating the whole spec
  // block into /api/aset would add it to every one of 1,200 rows on a payload
  // that is already the app's largest.
  _loadEditSpecCard(item.id_varian);

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

  // A genset is serviced, not calibrated. Hiding the tab for tool types the
  // katalog does not flag keeps the form from producing records that cannot
  // mean anything — same rule as landing.html's tab strip.
  const kalibBtn = document.getElementById("edit-tab-kalibrasi");
  kalibBtn?.classList.toggle("hidden", item.perlu_kalibrasi !== true);
  _switchEditFormTab("perbaikan");

  // Parts picker: reset to one empty row, scoped to this machine's model.
  initPemakaianPicker(item);

  switchView("edit");
};

// Model/Type payloads, keyed by id_varian. `/api/master/varian` is ~90 rows
// and changes rarely, so one fetch serves every asset opened this session.
let _varianCache = null;

async function _loadEditSpecCard(idVarian) {
  const card = document.getElementById("edit-spec-card");
  if (!card) return;
  if (!idVarian) {
    window.renderSpekCard(card, null);
    return;
  }
  try {
    if (!_varianCache) {
      const res = await apiFetch("/master/varian", { background: true });
      if (!res.ok) throw new Error();
      _varianCache = new Map((await res.json()).map((v) => [v.id_varian, v]));
    }
    window.renderSpekCard(card, _varianCache.get(idVarian) || null, {
      fotoHeight: "h-40",
    });
  } catch (e) {
    window.renderSpekCard(card, null);
  }
}

// Invalidated by the WebSocket refresh so an edited Model/Type shows up
// without a reload — see handleSocketMessage in js/shell.js.
window.invalidateVarianCache = function () {
  _varianCache = null;
};

// ══════════════════════════════════════════════════════════════════════════
// PARTS PICKER — spareparts consumed by the repair being reported
//
// Submits inside the /api/perbaikan body, so the condition report and the
// stock movements land in one transaction. See catat_perbaikan() in main.py.
// ══════════════════════════════════════════════════════════════════════════

// Compatible parts for the asset currently open, indexed by id_part.
let _pakaiParts = new Map();

async function initPemakaianPicker(item) {
  const rows = document.getElementById("pakai-rows");
  const gudangSel = document.getElementById("pakai-gudang");
  if (!rows || !gudangSel) return;

  rows.innerHTML = "";
  _pakaiParts = new Map();
  _renderPakaiTotal();

  const semua = document.getElementById("pakai-semua");
  if (semua) semua.checked = false;

  const note = document.getElementById("pakai-scope-note");
  if (note) {
    note.textContent = item.nama_varian
      ? `Hanya sparepart yang cocok untuk ${item.kode_alat_name || item.kode_alat} — ${item.nama_varian}.`
      : `Hanya sparepart untuk ${item.kode_alat_name || item.kode_alat}.`;
  }

  try {
    if (!gudangSel.options.length) {
      const gres = await apiFetch("/inventaris/gudang", { background: true });
      if (gres.ok) {
        const gd = await gres.json();
        const list = Array.isArray(gd) ? gd : gd.items || [];
        gudangSel.innerHTML = list
          .map((g) => `<option value="${g.id_gudang}">${window.spekEscape(g.nama)}</option>`)
          .join("");
      }
    }
    await _reloadPakaiParts(item);
  } catch (e) {
    /* the picker is optional; a failure must not block the condition report */
  }
}

async function _reloadPakaiParts(item) {
  const gudangSel = document.getElementById("pakai-gudang");
  const semua = document.getElementById("pakai-semua")?.checked;
  const params = new URLSearchParams();
  // "Tampilkan semua" drops BOTH scoping filters, because a technician who
  // reaches for it is usually fitting something the catalogue never associated
  // with this tool at all — a generic bolt, a length of cable.
  if (!semua) {
    if (item.kode_alat) params.set("kode_alat", item.kode_alat);
    if (item.id_varian) params.set("id_varian", item.id_varian);
  }
  // Stock is scoped to the chosen warehouse, so the "sisa" the technician sees
  // is the number the server will check against on submit.
  if (gudangSel?.value) params.set("id_gudang", gudangSel.value);

  const res = await apiFetch(`/inventaris/parts?${params}`, { background: true });
  if (!res.ok) return;
  _pakaiParts = new Map((await res.json()).map((p) => [String(p.id_part), p]));

  // Say so when the strict filter matched nothing, rather than presenting an
  // empty dropdown that looks like a loading failure.
  const note = document.getElementById("pakai-scope-note");
  if (note && !semua && _pakaiParts.size === 0) {
    note.innerHTML =
      `<span class="text-amber-600 dark:text-amber-400 font-semibold">
         Tidak ada sparepart terdaftar untuk alat/model ini.</span>
       Centang "Tampilkan semua sparepart" untuk memilih dari seluruh katalog.`;
  }
  // Re-render existing rows so their option lists and stock hints follow the
  // warehouse switch instead of showing another store's numbers.
  document.querySelectorAll("#pakai-rows [data-pakai-row]").forEach((row) => {
    const keep = row.querySelector("[data-pakai-part]").value;
    _fillPakaiOptions(row.querySelector("[data-pakai-part]"), keep);
    _updatePakaiRowHint(row);
  });
  _renderPakaiTotal();
}

function _fillPakaiOptions(select, selected) {
  const opts = [...
    _pakaiParts.values()]
    .map(
      (p) =>
        `<option value="${p.id_part}" ${String(p.id_part) === String(selected) ? "selected" : ""}>` +
        `${window.spekEscape(p.nama_part)} — stok ${p.stok_sekarang} ${window.spekEscape(p.unit || "")}` +
        `</option>`,
    )
    .join("");
  select.innerHTML =
    `<option value="">— Pilih sparepart —</option>` +
    (opts || `<option value="" disabled>Tidak ada sparepart yang cocok</option>`);
}

function _addPakaiRow() {
  const wrap = document.getElementById("pakai-rows");
  if (!wrap) return;
  const row = document.createElement("div");
  row.dataset.pakaiRow = "1";
  row.className =
    "flex flex-wrap items-end gap-2 bg-gray-50 dark:bg-gray-700/40 border border-gray-100 dark:border-gray-600 rounded-lg p-3";
  row.innerHTML = `
    <div class="flex-1 min-w-[12rem]">
      <label class="block text-[10px] font-semibold text-gray-500 mb-1">Sparepart</label>
      <select data-pakai-part aria-label="Pilih sparepart"
        class="w-full p-2 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm outline-none focus:border-kai-blue transition"></select>
    </div>
    <div class="w-24">
      <label class="block text-[10px] font-semibold text-gray-500 mb-1">Jumlah</label>
      <input type="number" min="1" step="1" value="1" data-pakai-qty aria-label="Jumlah dipakai"
        class="w-full p-2 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm outline-none focus:border-kai-blue transition" />
    </div>
    <div class="text-xs text-gray-500 dark:text-gray-400 min-w-[9rem]" data-pakai-hint>—</div>
    <button type="button" class="btn-icon btn-icon-danger" data-pakai-remove aria-label="Hapus baris sparepart">
      <i class="fas fa-trash-alt text-[11px]"></i>
    </button>`;
  wrap.appendChild(row);
  _fillPakaiOptions(row.querySelector("[data-pakai-part]"), "");
}

function _updatePakaiRowHint(row) {
  const sel = row.querySelector("[data-pakai-part]");
  const qty = row.querySelector("[data-pakai-qty]");
  const hint = row.querySelector("[data-pakai-hint]");
  const part = _pakaiParts.get(String(sel.value));
  if (!part) {
    hint.textContent = "—";
    hint.className = "text-xs text-gray-500 dark:text-gray-400 min-w-[9rem]";
    return;
  }
  const n = parseInt(qty.value, 10) || 0;
  const sisa = part.stok_sekarang - n;
  const harga = (part.harga_satuan || 0) * n;
  // Warn before the server has to: the submit is rejected wholesale, so
  // catching it here saves the technician re-entering the whole report.
  const over = sisa < 0;
  hint.className = `text-xs min-w-[9rem] ${over ? "text-red-500 font-semibold" : "text-gray-500 dark:text-gray-400"}`;
  hint.textContent = over
    ? `Stok kurang ${Math.abs(sisa)} ${part.unit || ""}`
    : `Sisa ${sisa} · ${KAI_VIZ.rupiahFull(harga)}`;
}

function _renderPakaiTotal() {
  const el = document.getElementById("pakai-total");
  if (!el) return;
  let total = 0;
  document.querySelectorAll("#pakai-rows [data-pakai-row]").forEach((row) => {
    const part = _pakaiParts.get(String(row.querySelector("[data-pakai-part]").value));
    const n = parseInt(row.querySelector("[data-pakai-qty]").value, 10) || 0;
    if (part) total += (part.harga_satuan || 0) * n;
  });
  el.textContent = KAI_VIZ.rupiahFull(total);
}

/** → [{id_part, id_gudang, jumlah}] for the /api/perbaikan body, or [] when
 *  nothing was picked. Rows with no part selected are silently skipped, so an
 *  accidentally-added empty row never blocks the submit. */
function collectPemakaian() {
  const gudang = document.getElementById("pakai-gudang")?.value;
  const out = [];
  document.querySelectorAll("#pakai-rows [data-pakai-row]").forEach((row) => {
    const idPart = parseInt(row.querySelector("[data-pakai-part]").value, 10);
    const jumlah = parseInt(row.querySelector("[data-pakai-qty]").value, 10);
    if (!idPart || !jumlah || jumlah <= 0) return;
    out.push({
      id_part: idPart,
      jumlah,
      id_gudang: gudang ? parseInt(gudang, 10) : null,
    });
  });
  return out;
}

// Delegated: rows are created after this file evaluates, so per-row listeners
// would have to be re-bound on every add.
document.getElementById("pakai-rows")?.addEventListener("input", (e) => {
  const row = e.target.closest("[data-pakai-row]");
  if (!row) return;
  _updatePakaiRowHint(row);
  _renderPakaiTotal();
});
document.getElementById("pakai-rows")?.addEventListener("change", (e) => {
  const row = e.target.closest("[data-pakai-row]");
  if (!row) return;
  _updatePakaiRowHint(row);
  _renderPakaiTotal();
});
document.getElementById("pakai-rows")?.addEventListener("click", (e) => {
  if (!e.target.closest("[data-pakai-remove]")) return;
  e.target.closest("[data-pakai-row]")?.remove();
  _renderPakaiTotal();
});
document.getElementById("pakai-add-row")?.addEventListener("click", _addPakaiRow);
function _reloadPakaiForCurrentAsset() {
  const item = asetById(document.getElementById("edit-uid")?.value);
  if (item) _reloadPakaiParts(item);
}
document.getElementById("pakai-gudang")?.addEventListener("change", _reloadPakaiForCurrentAsset);
document.getElementById("pakai-semua")?.addEventListener("change", _reloadPakaiForCurrentAsset);

window.initPemakaianPicker = initPemakaianPicker;
window.collectPemakaian = collectPemakaian;

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
  const item = summaryFor(uid) || asetById(uid);
  if (!item) return;

  document.getElementById("hist-detail-subtitle").innerText = `${item.id_aset}`;
  switchView("history-detail");
  switchDetailTab(tab, uid);
};

// NOTE: an earlier window.openQrModal was defined here and immediately shadowed
// by the async version further down (which uses drawQrOnCanvas/buildLandingUrl).
// It also still pointed QR links at the old tunnel variable.

window.deleteAset = async (uid) => {
  const item = asetById(uid);
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
  // This was a near-identical copy of _setHistoryTab in shell.js — the same six
  // class arrays, the same swap, already drifting apart. Both go through the
  // one segmented-control helper now.
  setSegmented(
    ["detail-tab-repair", "detail-tab-kalibrasi", "detail-tab-mutasi"],
    `detail-tab-${tab}`,
  );

  document.getElementById("detail-panel-repair")?.classList.toggle("hidden", tab !== "repair");
  document.getElementById("detail-panel-kalibrasi")?.classList.toggle("hidden", tab !== "kalibrasi");
  document.getElementById("detail-panel-mutasi")?.classList.toggle("hidden", tab !== "mutasi");

  if (tab === "repair") loadDetailRepair(uid);
  if (tab === "kalibrasi") loadDetailKalibrasi(uid);
  if (tab === "mutasi") loadDetailMutasi(uid);
}

async function loadDetailRepair(uid) {
  const tbody = document.getElementById("hist-repair-tbody");
  skeletonRows("hist-repair-tbody", 8, 4);
  try {
    const res = await apiFetch(`/riwayat-kondisi/${uid}`, { background: true });
    if (!res.ok) throw new Error("Gagal mengambil riwayat.");
    const history = await res.json();
    if (!history.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="p-4 text-center text-gray-500">Belum ada riwayat perbaikan.</td></tr>`;
      return;
    }

    // Filter out KALIBRASI entries — they belong to the Kalibrasi tab only.
    // A caller's policy, not a rendering concern: renderRepairRows() renders
    // whatever rows it is handed.
    const repairEntries = history.filter((h) => h.kondisi !== "KALIBRASI");

    if (!repairEntries.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="p-4 text-center text-gray-500">Belum ada riwayat perbaikan (SO/TSO).</td></tr>`;
      return;
    }

    const asetTerkait = asetById(uid);

    // Spareparts consumed, grouped by the repair that consumed them. Fetched
    // alongside rather than joined into /api/riwayat-kondisi: most assets have
    // none, and this keeps that endpoint's shape unchanged.
    let pakaiByRiwayat = {};
    try {
      const pres = await apiFetch(`/aset/${uid}/pemakaian`, { background: true });
      if (pres.ok) pakaiByRiwayat = (await pres.json()).per_riwayat || {};
    } catch (_) { /* the table is still useful without the parts */ }

    tbody.innerHTML = window.renderRepairRows(repairEntries, {
      pemakaian: pakaiByRiwayat,
      asetTerkait,
    });
  } catch (e) {
    if (e.message !== "Unauthorized")
      tbody.innerHTML = `<tr><td colspan="8" class="p-4 text-center text-red-500">${e.message}</td></tr>`;
  }
}

/** Region + UPT display names for a stored lokasi code: exact UPT-code match,
 * then exact parent-code match, then the code itself as a last resort.
 *
 * Deliberately NOT resolveLokasi() from js/search.js — that adds two more
 * fallback branches (fuzzy match by UPT/parent NAME) that a stored code never
 * needs, and substituting it was rejected rather than risk a behaviour change
 * for input this function was never exercised against. */
function resolveLokasiCode(kode) {
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
}

/**
 * The condition-history table body — one <tr> per row, eight columns. Shared
 * by loadDetailRepair() (the asset detail view) and the Dashboard drill-down
 * modal, so the two can never drift.
 *
 * `rows` is expected already filtered of KALIBRASI entries — see the caller's
 * note above; this renderer does not re-apply that filter.
 *
 * `opts`:
 *   pemakaian   — the `.per_riwayat` map from GET /api/aset/{uid}/pemakaian,
 *                 keyed by id_riwayat, fed to _pakaiChips().
 *   onlyKondisi — optional "SO" | "TSO". When set, only rows whose kondisi
 *                 matches are rendered (row numbering restarts over the
 *                 filtered set). loadDetailRepair() passes nothing here, so
 *                 its output is unchanged; the Dashboard modal uses it when
 *                 opened from the Siap Operasi / Tidak Siap card.
 *   asetTerkait — the asset row (asetById/summaryFor), used only as a
 *                 fallback for legacy rows written before id_lokasi/peruntukan
 *                 were captured per-row.
 */
window.renderRepairRows = function renderRepairRows(rows, opts = {}) {
  const pemakaian = opts.pemakaian || {};
  const asetTerkait = opts.asetTerkait || null;
  const entries = opts.onlyKondisi
    ? rows.filter((h) => h.kondisi === opts.onlyKondisi)
    : rows;

  return entries
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
              <td class="p-3 text-xs text-gray-500 whitespace-pre-wrap">${h.keterangan || "—"}${_pakaiChips(pemakaian[String(h.id_riwayat)])}</td>
          </tr>`;
    })
    .join("");
};

/** The parts consumed by one repair, as chips under its Keterangan cell. */
function _pakaiChips(items) {
  if (!items || !items.length) return "";
  const esc = window.spekEscape;
  const total = items.reduce((s, i) => s + (i.subtotal || 0), 0);
  const chips = items
    .map(
      (i) =>
        `<span class="inline-block text-[10px] bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300
           border border-amber-200 dark:border-amber-800/60 px-1.5 py-0.5 rounded mr-1 mb-1"
           title="${esc(i.nama_part)} — ${esc(String(i.jumlah))} ${esc(i.unit || "")} @ ${KAI_VIZ.rupiahFull(i.harga_satuan)}">
           <i class="fas fa-gear text-[8px]"></i> ${esc(i.nama_part)} ×${esc(String(i.jumlah))}</span>`,
    )
    .join("");
  return `<div class="mt-1.5 pt-1.5 border-t border-dashed border-gray-200 dark:border-gray-600">
            ${chips}
            <span class="block text-[10px] font-semibold text-gray-600 dark:text-gray-300 mt-0.5">
              Biaya sparepart: ${KAI_VIZ.rupiahFull(total)}</span>
          </div>`;
}

/**
 * Download a calibration certificate.
 *
 * GET /api/kalibrasi/sertifikat/{nama} is Bearer-authenticated, so a plain
 * <a href> 401s. Fetch it as a blob and hand the browser an object URL.
 */
window.downloadSertifikat = async function downloadSertifikat(namaFile) {
  if (!namaFile) return;
  try {
    const res = await apiFetch(
      `/kalibrasi/sertifikat/${encodeURIComponent(namaFile)}`,
      { background: true },
    );
    if (!res.ok) throw new Error("Berkas sertifikat tidak ditemukan.");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = namaFile;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked on a timer: revoking synchronously can cancel the download
    // before the browser has started it.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    if (e.message !== "Unauthorized")
      showToast(e.message || "Gagal mengunduh sertifikat.", "error");
  }
};

/** Detach a certificate from its calibration record. SUPER_ADMIN / ADMIN only. */
window.hapusSertifikat = async function hapusSertifikat(idKalibrasi, uid) {
  if (!idKalibrasi) return;
  if (!(await customConfirm("Hapus berkas sertifikat dari catatan kalibrasi ini?"))) return;
  try {
    const res = await apiFetch(`/kalibrasi/${idKalibrasi}/sertifikat`, {
      method: "DELETE",
    });
    // apiFetch only throws on 401, so a 403/404 arrives as a normal response.
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))).detail;
      throw new Error(detail || "Gagal menghapus sertifikat.");
    }
    showToast("Berkas sertifikat dihapus.", "success");
    if (uid) loadDetailKalibrasi(uid);
  } catch (e) {
    if (e.message !== "Unauthorized") showToast(e.message, "error");
  }
};

async function loadDetailKalibrasi(uid) {
  const tbody = document.getElementById("hist-kalibrasi-tbody");
  if (!tbody) return;
  const COLS = 9;
  skeletonRows("hist-kalibrasi-tbody", COLS, 4);
  try {
    const res = await apiFetch(`/kalibrasi/${uid}`, { background: true });
    if (!res.ok) throw new Error("Gagal mengambil riwayat kalibrasi.");
    const history = await res.json();
    if (!history.length) {
      tbody.innerHTML = `<tr><td colspan="${COLS}" class="p-4 text-center text-gray-500">Belum ada riwayat kalibrasi.</td></tr>`;
      return;
    }
    const canDelete =
      _currentRole === "SUPER_ADMIN" || _currentRole === "ADMIN_WILAYAH";

    tbody.innerHTML = window.renderKalibrasiRows(history, { uid, canDelete });
  } catch (e) {
    if (e.message !== "Unauthorized")
      tbody.innerHTML = `<tr><td colspan="${COLS}" class="p-4 text-center text-red-500">${e.message}</td></tr>`;
  }
}

/**
 * The certificate-history table body — one <tr> per row, nine columns.
 * Shared by loadDetailKalibrasi() (the asset detail view) and the Dashboard
 * drill-down modal.
 *
 * `opts`:
 *   uid       — the asset id, threaded into the delete button's
 *               loadDetailKalibrasi(uid) refresh call.
 *   canDelete — computed by the CALLER from _currentRole; this renderer does
 *               not read role state itself.
 */
window.renderKalibrasiRows = function renderKalibrasiRows(rows, opts = {}) {
  const uid = opts.uid;
  const canDelete = !!opts.canDelete;

  return rows
    .map((h) => {
      const statusClass =
        h.status === "LULUS"
          ? "badge badge-so"
          : h.status === "GAGAL"
            ? "badge badge-tso"
            : "badge badge-warn";
      // h.file_sertifikat has always been in this payload and was never read,
      // so an uploaded certificate was unreachable from the UI.
      const berkas = h.file_sertifikat
        ? `<div class="flex items-center justify-center gap-1">
             <button type="button" onclick="window.downloadSertifikat('${h.file_sertifikat}')"
               title="Unduh ${h.file_sertifikat}"
               class="text-cyan-600 dark:text-cyan-400 hover:underline text-xs font-semibold">
               <i class="fas fa-file-arrow-down mr-1"></i>Unduh</button>
             ${
               canDelete
                 ? `<button type="button" class="btn-icon btn-icon-danger"
                      title="Hapus berkas sertifikat"
                      onclick="window.hapusSertifikat(${h.id_kalibrasi}, '${uid}')">
                      <i class="fas fa-trash-alt text-[11px]"></i></button>`
                 : ""
             }
           </div>`
        : `<span class="text-gray-300 dark:text-gray-600 text-xs">—</span>`;

      return `
        <tr class="border-b dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50">
          <td class="p-3 text-center text-gray-400">${h.no}</td>
          <td class="p-3 font-mono text-xs">${formatUtcToLocal(h.waktu_input)}</td>
          <td class="p-3 font-mono text-xs">${h.tanggal_kalibrasi ? formatDateOnly(h.tanggal_kalibrasi) : "—"}</td>
          <td class="p-3 font-mono text-xs">${h.tanggal_berlaku ? formatDateOnly(h.tanggal_berlaku) : "—"}</td>
          <td class="p-3 text-sm text-center">
            <span class="${statusClass}">${h.status || "—"}</span>
          </td>
          <td class="p-3 text-sm">${h.pelaksana_kalibrasi || "—"}</td>
          <td class="p-3 text-sm">${h.nomor_sertifikat || "—"}</td>
          <td class="p-3 text-center">${berkas}</td>
          <td class="p-3 text-xs text-gray-500 whitespace-pre-wrap">${h.keterangan || "—"}</td>
        </tr>`;
    })
    .join("");
};

async function loadDetailMutasi(uid) {
  const timeline = document.getElementById("mutasi-timeline");
  const originBar = document.getElementById("mutasi-origin-bar");
  if (!timeline || !originBar) return;
  timeline.setAttribute("aria-busy", "true");
  timeline.innerHTML = Array.from({ length: 3 })
    .map(
      () =>
        `<div class="mb-3"><span class="skeleton skeleton-text" style="width:60%"></span>
           <span class="skeleton skeleton-text-sm" style="width:35%"></span></div>`,
    )
    .join("");
  originBar.innerHTML = "";

  try {
    const res = await apiFetch(`/mutasi/${uid}`, { background: true });
    if (!res.ok) throw new Error("Gagal mengambil riwayat mutasi.");
    const data = await res.json();

    originBar.innerHTML = window.renderMutasiOriginBar(data);

    if (!data.mutasi || !data.mutasi.length) {
      timeline.innerHTML = `<div class="empty-state">Belum ada riwayat mutasi.</div>`;
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

/**
 * The mutasi tab's origin bar ONLY — "Lokasi Asal" / "Lokasi Sekarang" plus
 * the sudah_kembali badge. Shared by loadDetailMutasi() (the asset detail
 * view) and the Dashboard drill-down modal, which deliberately shows only
 * this block and not the full timeline below it.
 *
 * `data` is the GET /api/mutasi/{id} payload.
 *
 * The returned/not-returned pill was hand-rolled inline Tailwind; converted
 * here to the .badge component layer per CLAUDE.md ("status badges go
 * through .badge, never inline Tailwind") — .badge-so for "sudah kembali",
 * .badge-move for "belum kembali" (the same orange "SEDANG TERMUTASI" state
 * used elsewhere for an asset still away from its origin). This is the one
 * intentional visual change in this extraction.
 */
window.renderMutasiOriginBar = function renderMutasiOriginBar(data) {
  const returnedBadge = data.sudah_kembali
    ? `<span class="badge badge-so">✓ Sudah Kembali ke Lokasi Awal</span>`
    : `<span class="badge badge-move">⟳ Belum Kembali ke Asal</span>`;

  const asal = resolveLokasi(data.original_lokasi);
  const kini = resolveLokasi(data.lokasi_sekarang);

  return `
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
};

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
  // `jumlah_kejadian` is the server's own figure, added to /api/aset in
  // rev0.4.5 and computed by the same rule — TSO rows plus transfers, never
  // every riwayat row, because an SO row is a repair being CLOSED. Sorting by
  // it now happens server-side; this remains for the summary-shaped rows on
  // Pantau Riwayat and for the parity harness.
  if (typeof item?.jumlah_kejadian === "number") return item.jumlah_kejadian;
  const s = summaryFor(item.id_aset);
  if (!s) return 0;
  return (s.repair?.count || 0) + (s.mutasi?.count || 0);
}

// KPI tiles for Kelola Data Aset. Deliberately scoped to the filtered list
// rather than the whole fleet: the tiles sit directly above the cards they
// summarise, so a figure describing a different set would simply read as wrong.
function _renderDbStats(ringkas, total, fleetTotal, mode, myRegion) {
  const set = (id, value) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  };
  const so = ringkas.so || 0;
  const tso = ringkas.tso || 0;

  set("db-stat-total", total.toLocaleString("id-ID"));
  set("db-stat-so", so.toLocaleString("id-ID"));
  set("db-stat-tso", tso.toLocaleString("id-ID"));
  set("db-stat-avail", total ? `${((so / total) * 100).toFixed(1)}%` : "—");
  set("db-stat-total-note", `dari ${fleetTotal.toLocaleString("id-ID")} terdaftar`);

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

// ══════════════════════════════════════════════════════════════════════
// DENSITY TOGGLE (Kelola Data Aset)
// ══════════════════════════════════════════════════════════════════════
//
// 1,121 assets as cards is a lot of scrolling for someone who already knows
// what they are looking for. Scoped to this view and remembered, because a
// density preference that resets on every visit is worse than none.

const DB_DENSITY_KEY = "dbDensity";

function applyDbDensity() {
  const compact = localStorage.getItem(DB_DENSITY_KEY) === "compact";
  document.getElementById("view-database")?.classList.toggle("is-compact", compact);
  const btn = document.getElementById("btn-db-density");
  const label = document.getElementById("btn-db-density-label");
  if (label) label.textContent = compact ? "Rapat" : "Nyaman";
  if (btn) {
    btn.setAttribute("aria-pressed", compact ? "true" : "false");
    const icon = btn.querySelector("i");
    if (icon) icon.className = compact ? "fas fa-grip-lines" : "fas fa-bars";
  }
}

document.getElementById("btn-db-density")?.addEventListener("click", () => {
  const compact = localStorage.getItem(DB_DENSITY_KEY) === "compact";
  localStorage.setItem(DB_DENSITY_KEY, compact ? "comfortable" : "compact");
  applyDbDensity();
});

/**
 * Kelola Data Aset — ONE page, filtered and sorted by the server.
 *
 * Until rev0.4.5 this filtered, sorted and sliced a client-side copy of the
 * whole fleet. Everything it used to do in JavaScript now travels as query
 * parameters, and `api/query.py` applies the identical rules — including the
 * three location term shapes and the identity-location rule that decides which
 * region an asset belongs to. `tools/verify/test_paging.py` asserts the two
 * agree; if you change a filter here, change it there and re-run it.
 *
 * The two paging rules from js/core.js still hold, and now hold on the server:
 * the slice happens AFTER filtering and sorting, and the search narrows the
 * DATA rather than hiding rendered rows.
 */
async function renderDbCards() {
  const container = document.getElementById("db-cards-container");
  const searchInput = document.getElementById("search-db");
  const modeSelect = document.getElementById("filter-mode");
  if (!container) return;

  applyDbDensity();

  const isTeknisi = _currentRole === "TEKNISI";
  if (modeSelect) modeSelect.style.display = isTeknisi ? "none" : "";

  const searchQ = searchInput?.value || "";
  // "Aset Saya" narrows the list to the region the logged-in user belongs to.
  // The server reads the region out of the caller's own token rather than
  // trusting a parameter — see own_region_codes() in api/query.py.
  const mode = isTeknisi ? "public" : modeSelect ? modeSelect.value : "public";
  const myLokasiRaw = getJwtPayload(authToken)?.id_lokasi || "";
  const myRegion = getParentLokasiCode(myLokasiRaw) || myLokasiRaw;
  const isAdmin =
    _currentRole === "SUPER_ADMIN" || _currentRole === "ADMIN_WILAYAH";

  const params = asetFilterParams(_sortFilters, {
    q: searchQ,
    sort: _sortField,
    dir: _sortDir,
    milikSaya: mode === "local",
  });
  const { limit, offset } = pagerRequest("db");
  params.set("limit", limit);
  params.set("offset", offset);

  skeletonCards("db-cards-container", Math.min(limit, 6));

  let page;
  try {
    page = await fetchAsetPage(params);
  } catch (e) {
    container.innerHTML = `<div class="empty-state col-span-full"><i class="fas fa-triangle-exclamation"></i>${e.message}</div>`;
    return;
  }

  // `db` is now this page, not the fleet. Replaced wholesale rather than
  // mutated, because the Map indexes in js/search.js key off array identity.
  db = page.items;

  const meta = serverPage("db", page.total, page.items);
  // A narrowing filter can leave the user past the end of the new list. The
  // client-side paginator clamped and sliced in one pass; here the request has
  // already gone out, so re-issue it rather than render the empty page.
  if (meta.stale) return renderDbCards();

  // Stats describe the whole FILTERED set, not the current page — they answer
  // "how much matches", which paging must not change. `ringkas` is computed by
  // the server over the same filter, before the slice.
  const fleetTotal = (await getRingkasan()).total;
  _renderDbStats(page.ringkas, page.total, fleetTotal, mode, myRegion);

  // The active sort/filter state used to be visible nowhere outside the modal,
  // so a view showing 12 of 1,121 assets looked like one showing all of them.
  window.renderFilterChips?.("db-filter-chips", _sortFilters, () => {
    resetPage("db");
    renderDbCards();
  }, [
    {
      key: "__q",
      label: "Cari",
      value: (document.getElementById("search-db")?.value || "").trim(),
      clear: () => {
        const box = document.getElementById("search-db");
        if (box) box.value = "";
      },
    },
  ]);

  container.innerHTML = "";
  renderPagerBar("db-pager", meta, renderDbCards);

  if (!page.items.length) {
    container.innerHTML = `<div class="empty-state col-span-full"><i class="fas fa-inbox"></i>Tidak ada aset alat kerja yang cocok dengan filter ini.</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();

  page.items
    .forEach((item) => {
      const isSuperAdmin = _currentRole === "SUPER_ADMIN";
      const isAdminWilayah = _currentRole === "ADMIN_WILAYAH";
      const canDelete = isSuperAdmin || isAdminWilayah;

      // Decode original data dari id_aset menggunakan fungsi yang baru
      const dec = decodeAsetId(item.id_aset);

      // Peruntukan: Prioritas 1 dari database, Prioritas 2 ekstrak dari ID aset
      const peruntukanName = item.peruntukan ? item.peruntukan : "—";

      // Location comes from the shared identity, the same call the search and
      // the filters above make — so what the card prints is by construction
      // what a search for that string will find.
      const ident = assetLokasiIdentity(item);
      const rawUptCode = ident.uptCode;
      const lokasiName = ident.parentName || "—";

      // UPT — show em-dash when the stored code is a parent Lokasi (not a UPT)
      const isDirectLokasi =
        !uptDatabase.some((u) => u.upt === rawUptCode) &&
        lokasiData.some((l) => l.code === rawUptCode);
      const uptDisplay = isDirectLokasi ? "—" : ident.uptName || "—";

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
        ? `<span class="badge badge-so"><i class="fas fa-circle text-[6px]"></i>SO</span>`
        : `<span class="badge badge-tso"><i class="fas fa-circle text-[6px]"></i>TSO</span>`;

      // Badge 2: Kalibrasi.
      // These three badges are why the SPA used to download the entire
      // /api/history/summary at login. They ride on /api/aset itself now —
      // batched over the ids on this page, see _card_facts() in api/aset.py.
      //
      // The four-branch ladder that used to be inline here is now
      // kalibrasiBadgeState() in js/core.js, shared with Kelola Data Alat
      // Kerja: an EXPIRED pass has to read JATUH TEMPO rather than a green
      // LULUS, and two copies of that rule would drift.
      const kalibBadge = window.kalibrasiBadgeHtml(item);

      // Badge 3: Mutasi status
      const mutasiBadge = (item.mutasi_count > 0)
        ? item.mutasi_sudah_kembali
          ? `<span class="badge badge-so"><i class="fas fa-circle text-[6px]"></i>DI LOKASI ASAL</span>`
          : `<span class="badge badge-move"><i class="fas fa-circle text-[6px]"></i>SEDANG TERMUTASI</span>`
        : `<span class="badge badge-neutral"><i class="fas fa-circle text-[6px]"></i>TIDAK TERMUTASI</span>`;

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
                    ${row("Model/Type", item.nama_varian || "—")}
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

window.openMutasiModal = (uid) => {
  const item = asetById(uid);
  if (!item) return;

  document.getElementById("mutasi-uid").value = uid;
  document.getElementById("mutasi-modal-subtitle").innerText = item.id_aset;

  // Lokasi Asal: use original lokasi from history summary (before any mutations)
  // item.id_lokasi is now UPT code, so get parent for region name
  const summaryItem = summaryFor(uid);

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
  const item = asetById(uid);
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
