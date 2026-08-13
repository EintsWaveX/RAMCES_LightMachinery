// ═══════════════════════════════════════════════════════════════════════
// Pulihkan Aset Afkir: the card list, its sort modal and the restore
// / permanent-delete flow.
//
// Part of the RAMCES frontend. These files are plain classic scripts
// loaded in a fixed order by index.html - no bundler, no modules. They
// share one global scope, so a top-level `let` or `const` declared twice
// across two files is a fatal SyntaxError; see CLAUDE.md.
// ═══════════════════════════════════════════════════════════════════════

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
    // Afkir assets are excluded from _historySummary by design, so the identity
    // falls back to the row's own lokasi — which is correct here: a written-off
    // asset has no "current vs home" distinction left to make.
    const ident = assetLokasiIdentity(item);

    // The old matcher checked three fields only, so searching a status, a
    // peruntukan or a purchase date silently returned nothing on this view.
    if (!assetMatchesSearch(item, q)) return false;

    if (f.alat && item.kode_alat !== f.alat) return false;
    if (!lokasiMatchesCode(ident, f.lokasi)) return false;
    if (f.upt && ident.uptCode !== f.upt) return false;
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

document.getElementById("search-afkir")?.addEventListener(
  "input",
  debounce(() => {
    resetPage("afkir");
    renderAfkirCards();
  }),
);

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
  // Afkir has its own row set, so the counts must come from it and not `db`.
  _populateYearDropdowns("afkir-sort-tgl-from", "afkir-sort-tgl-to", _afkirDb);

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
