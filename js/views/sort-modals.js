// ═══════════════════════════════════════════════════════════════════════
// The sort modals for Kelola Data Aset and Pantau Riwayat, and the
// year-dropdown helpers every other view's sort modal reuses.
//
// Part of the RAMCES frontend. These files are plain classic scripts
// loaded in a fixed order by index.html - no bundler, no modules. They
// share one global scope, so a top-level `let` or `const` declared twice
// across two files is a fatal SyntaxError; see CLAUDE.md.
// ═══════════════════════════════════════════════════════════════════════

// ── SORT MODAL ────────────────────────────────────────────────────

let _sortField = "id_aset";
let _sortDir = "date-desc";
let _sortFilters = {}; // custom filter values for db sort

let _histSortField = "id_aset";
let _histSortDir = "date-desc";
let _histSortFilters = {};

// ══════════════════════════════════════════════════════════════════════
// ACTIVE FILTER CHIPS
// ══════════════════════════════════════════════════════════════════════
//
// Kelola Data Aset, Pulihkan Aset Afkir and Kelola Data Alat Kerja each keep
// their entire sort/filter state behind a modal, with nothing on screen saying
// a filter is applied. A view showing 12 of 1,121 assets looked exactly like
// one showing all of them, and the only way to find out was to reopen the
// modal. These are that state, surfaced and individually removable.
//
// All three views write the SAME filter keys, `_sortFilters`,
// `_afkirSortFilters` and `_kdakSortFilters` are three variables holding one
// shape, so this is one renderer rather than three, and a key added in one
// place appears in all three.

const FILTER_CHIP_LABELS = {
  idFrom: "ID dari",
  idTo: "ID s/d",
  alat: "Alat kerja",
  pengadaan: "Pengadaan",
  tahunFrom: "Tahun dari",
  tahunTo: "Tahun s/d",
  peruntukan: "Peruntukan",
  lokasi: "Wilayah",
  upt: "UPT",
};

/**
 * Paint the chip row for one view.
 *
 * @param containerId  element the chips are written into
 * @param filters      the view's live filter object (mutated by the remover)
 * @param onChange     called after a chip is removed, to re-render the list
 * @param extra        optional [{key,label,value,clear}] for non-filter state
 *                     such as an active search term
 */
function renderFilterChips(containerId, filters, onChange, extra) {
  const box = document.getElementById(containerId);
  if (!box) return;

  const items = [];
  for (const [key, label] of Object.entries(FILTER_CHIP_LABELS)) {
    const v = filters?.[key];
    // 0 is not a meaningful value for any of these, so falsy is "unset".
    if (v === undefined || v === null || v === "" ) continue;
    items.push({ key, label, value: String(v) });
  }
  for (const e of extra || []) {
    if (e && e.value) items.push(e);
  }

  if (!items.length) {
    box.innerHTML = "";
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");

  const esc = (s) => window.spekEscape ? window.spekEscape(s) : String(s);
  box.innerHTML =
    items
      .map(
        (it) => `<span class="chip">
            <span class="chip-label">${esc(it.label)}</span>
            <span class="chip-value">${esc(it.value)}</span>
            <button type="button" class="chip-x" data-chip-key="${esc(it.key)}"
                    aria-label="Hapus filter ${esc(it.label)}"><i class="fas fa-times"></i></button>
          </span>`,
      )
      .join("") +
    `<button type="button" class="chip-clear" data-chip-key="__all__">Hapus semua</button>`;

  // Delegated on the container, which is replaced wholesale above, so
  // re-rendering cannot multiply listeners.
  box.onclick = (ev) => {
    const btn = ev.target.closest("[data-chip-key]");
    if (!btn) return;
    const key = btn.dataset.chipKey;
    if (key === "__all__") {
      for (const k of Object.keys(FILTER_CHIP_LABELS)) delete filters[k];
      (extra || []).forEach((e) => e.clear && e.clear());
    } else {
      const ex = (extra || []).find((e) => e.key === key);
      if (ex && ex.clear) ex.clear();
      else delete filters[key];
    }
    onChange();
  };
}

window.renderFilterChips = renderFilterChips;

// ══════════════════════════════════════════════════════════════════════
// YEAR DROPDOWNS, one rule, eight pickers
// ══════════════════════════════════════════════════════════════════════
//
// The rule, requested by the client and applied everywhere a year can be
// chosen: **list only the years that actually hold data, and say how many.**
//
//     2025 (623)      2024 (245)      2026 (253)
//
// What this replaced walked from the oldest year present all the way to the
// current year and printed every gap as "2019 (kosong)". On the seeded fleet
// that is three real years buried among a column of dead ones, and the dead
// ones are selectable, picking one empties the list with no explanation.
//
// The count is scoped to the CALLING MENU's own rows, not to the fleet: the
// number beside a year in Pantau Riwayat is how many history rows fall in it,
// and in Pulihkan Aset Afkir how many scrapped assets. That is why every call
// site passes its own array.

// How many rows fall in each year of `dateField`.
function _yearCounts(rows, dateField = "tanggal_pembelian") {
  const counts = new Map();
  (rows || []).forEach((r) => {
    const y = String(r?.[dateField] ?? "").slice(0, 4);
    if (/^\d{4}$/.test(y)) counts.set(y, (counts.get(y) || 0) + 1);
  });
  return counts;
}

function yearOptionLabel(year, counts) {
  const n = counts.get(String(year)) || 0;
  return `${year} (${n.toLocaleString("id-ID")})`;
}

/**
 * The years to offer, newest first.
 *
 * `keep` is the currently-selected value. It is always included even when its
 * count has dropped to zero, so a refetch can never silently reset a filter the
 * user set, the option stays, reading "2019 (0)", and they can see why the
 * list is empty rather than watching their selection vanish.
 */
function _yearOptionsFor(counts, keep) {
  const years = [...counts.keys()].map(Number).filter((n) => !isNaN(n));
  if (keep && /^\d{4}$/.test(String(keep)) && !years.includes(Number(keep))) {
    years.push(Number(keep));
  }
  return years.sort((a, b) => b - a);
}

/**
 * Fill one year <select>.
 *
 * `allLabel` is the text of the leading "no filter" option, or null to omit it
 * entirely, Tren Perbaikan plots twelve months of ONE year, so "Semua Tahun"
 * has no meaning there and offering it only invites a selection the chart
 * cannot honour.
 */
function fillYearSelect(sel, counts, allLabel = "Semua Tahun") {
  if (!sel) return;

  // Rebuilt on every call rather than cached: the counts change whenever the
  // underlying list is refetched, so a stale list would misreport them.
  const previous = sel.value;
  const years = _yearOptionsFor(counts, previous);
  sel.innerHTML = "";

  if (allLabel !== null) {
    const all = document.createElement("option");
    all.value = "";
    all.textContent = allLabel;
    sel.appendChild(all);
  }

  years.forEach((y) => {
    const o = document.createElement("option");
    o.value = String(y);
    o.textContent = yearOptionLabel(y, counts);
    sel.appendChild(o);
  });

  // Nothing to choose from and no "all" option: say so rather than render an
  // empty box the user will click at.
  if (!years.length && allLabel === null) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "Belum ada data";
    o.disabled = true;
    sel.appendChild(o);
  }

  const wanted = previous || (allLabel !== null ? "" : String(years[0] ?? ""));
  sel.value = wanted;
  // Guard against selectedIndex = -1, which renders as a blank box: it happens
  // whenever `wanted` names an option that no longer exists.
  if (sel.selectedIndex < 0) sel.selectedIndex = 0;
}

/**
 * Fill a from/to pair. Both get the same option list.
 *
 * With no `rows`, the counts come from the fleet ROLLUP rather than from a
 * client-side array, since rev0.4.5 `db` and `_historySummary` are one page
 * each, and counting a page would offer a Tahun Beli list that changed every
 * time the user turned to the next one. Pass `rows` explicitly where the
 * question really is about a specific list (Pulihkan Aset Afkir counts
 * scrapped assets, which are not in the rollup at all).
 *
 * Async for the same reason; the callers await it or fire and forget, and
 * fillYearSelect() keeps whatever value was already selected either way.
 */
async function _populateYearDropdowns(fromId, toId, rows = null, dateField = "tanggal_pembelian") {
  let counts;
  if (rows) {
    counts = _yearCounts(rows, dateField);
  } else {
    counts = new Map();
    (await getRingkasan()).tahun_counts.forEach((r) =>
      counts.set(String(r.tahun), r.jumlah),
    );
  }
  [fromId, toId].forEach((id) =>
    fillYearSelect(document.getElementById(id), counts),
  );
}

window.fillYearSelect = fillYearSelect;
window._yearCounts = _yearCounts;

// ── Helper: populate alat+lokasi dropdowns in sort modal ──
function _populateSortDropdowns(prefix) {
  // Alat (id_aset panel)
  const alatSel = document.getElementById(`${prefix}-id-alat`);
  if (alatSel && alatSel.options.length <= 1) {
    alatKerjaData.forEach((a) => {
      const o = document.createElement("option");
      o.value = a.code;
      o.textContent = `${a.code} — ${a.name}`;
      alatSel.appendChild(o);
    });
  }
  // Alat filter (kode_alat_name panel)
  const alatFilterSel = document.getElementById(`${prefix}-alat-filter`) || document.getElementById(`${prefix}-alat`);
  if (alatFilterSel && alatFilterSel !== alatSel && alatFilterSel.options.length <= 1) {
    alatKerjaData.forEach((a) => {
      const o = document.createElement("option");
      o.value = a.code;
      o.textContent = `${a.code} — ${a.name}`;
      alatFilterSel.appendChild(o);
    });
  }
  // Lokasi dropdowns (id_aset panel + id_lokasi panel)
  [`${prefix}-id-lokasi`, `${prefix}-lok-lokasi`].forEach((id) => {
    const lokSel = document.getElementById(id);
  if (lokSel && lokSel.options.length <= 1) {
    lokasiData.forEach((l) => {
      const o = document.createElement("option");
      o.value = l.code;
      o.textContent = `${l.name} (${l.code})`;
      lokSel.appendChild(o);
    });
  }
  });
  // UPT: repopulate based on current Lokasi value (preserves prior selection)
  const lokMain = document.getElementById(`${prefix}-lok-lokasi`);
  const uptSel = document.getElementById(`${prefix}-lok-upt`);
  if (uptSel) {
    const currentLok = lokMain ? lokMain.value : "";
    const currentUpt = uptSel.value; // save current selection
    uptSel.innerHTML = `<option value="">— ${currentLok ? "Semua UPT" : "Pilih Lokasi dahulu"} —</option>`;
    const uptList = currentLok
      ? uptDatabase.filter((u) => u.lokasi === currentLok)
      : uptDatabase;
    uptList.forEach((u) => {
      const o = document.createElement("option");
      o.value = u.upt;
      o.textContent = `${u.nama || u.upt} (${u.upt})`;
      uptSel.appendChild(o);
    });
    if (currentUpt) uptSel.value = currentUpt; // restore prior selection
  }
  // Wire Lokasi → UPT cascade (only once per prefix)
  if (lokMain && !lokMain.dataset.cascadeWired) {
    lokMain.dataset.cascadeWired = "1";
    lokMain.addEventListener("change", () => {
      _filterUptByLokasi(`${prefix}-lok-lokasi`, `${prefix}-lok-upt`);
    });
  }
}

// ── Helper: filter UPT dropdown based on selected Lokasi ──
function _filterUptByLokasi(lokSelId, uptSelId) {
  const lokSel = document.getElementById(lokSelId);
  const uptSel = document.getElementById(uptSelId);
  if (!lokSel || !uptSel) return;
  const chosenLok = lokSel.value;
  uptSel.innerHTML = `<option value="">— Semua UPT —</option>`;
  const filtered = chosenLok
    ? uptDatabase.filter((u) => u.lokasi === chosenLok)
    : uptDatabase;
  filtered.forEach((u) => {
    const o = document.createElement("option");
    o.value = u.upt;
    o.textContent = `${u.nama || u.upt} (${u.upt})`;
    uptSel.appendChild(o);
  });
}

// ── Helper: show/hide sort custom panels ──
function _syncSortPanels(fieldVal, customChecked, panelPrefix, allLabelId, customPanelsId) {
  const allLabel = document.getElementById(allLabelId);
  const customPanels = document.getElementById(customPanelsId);
  if (!allLabel || !customPanels) return;

  if (!customChecked || !fieldVal) {
    allLabel.classList.remove("hidden");
    customPanels.classList.add("hidden");
  } else {
    allLabel.classList.add("hidden");
    customPanels.classList.remove("hidden");

    // Hide every sub-panel first. This must list ALL prefix families, a
    // missing one means that modal's panels stack instead of swapping when the
    // user changes the sort criterion.
    customPanels
      .querySelectorAll(
        "[id^='sort-panel-'], [id^='hist-sort-panel-'], [id^='kdak-sort-panel-'], [id^='afkir-sort-panel-']",
      )
      .forEach((p) => p.classList.add("hidden"));
    // Show the one matching the active prefix + field. Scoped to THIS modal's
    // container, a global id lookup could reveal a panel belonging to another
    // sort modal when two of them use different names for the same field.
    const panel = customPanels.querySelector(
      `#${panelPrefix}-panel-${CSS.escape(fieldVal)}`,
    );
    if (panel) panel.classList.remove("hidden");
  }
}

// ── DB Sort Modal ──
document.getElementById("btn-sort-db")?.addEventListener("click", () => {
  // "sort-id-tahun-from/-to" exist in no HTML, the call was a no-op.
  _populateYearDropdowns("sort-tgl-from", "sort-tgl-to");
  _populateSortDropdowns("sort");

  // Also populate sort-alat-filter (the kode_alat_name panel dropdown)
  const alatFilterSel = document.getElementById("sort-alat-filter");
  if (alatFilterSel && alatFilterSel.options.length <= 1) {
    alatKerjaData.forEach((a) => {
      const o = document.createElement("option");
      o.value = a.code;
      o.textContent = `${a.code} — ${a.name}`;
      alatFilterSel.appendChild(o);
    });
  }

  // Sync panels and Terbaru/Terlama visibility for current field
  const curField = document.getElementById("sort-field")?.value || "id_aset";
  const curChecked = document.getElementById("sort-custom-spec")?.checked || false;
  _syncSortPanels(curField, curChecked, "sort", "sort-all-data-label", "sort-custom-panels");

  // Paint active direction button
  document.querySelectorAll(".sort-dir-btn").forEach((b) => {
    const active = b.dataset.dir === _sortDir;
    b.classList.toggle("border-kai-blue", active);
    b.classList.toggle("bg-sky-100", active);
    b.classList.toggle("dark:bg-sky-900/20", active);
    b.classList.toggle("text-kai-blue", active);
    b.classList.toggle("dark:text-sky-300", active);
    b.classList.toggle("border-gray-200", !active);
    b.classList.toggle("dark:border-gray-600", !active);
    b.classList.toggle("bg-white", !active);
    b.classList.toggle("dark:bg-gray-700", !active);
    b.classList.toggle("text-gray-500", !active);
  });

  // Populate id-panel alat and lokasi
  const idAlatSel = document.getElementById("sort-id-alat");
  if (idAlatSel && idAlatSel.options.length <= 1) {
    alatKerjaData.forEach((a) => {
      const o = document.createElement("option");
      o.value = a.code;
      o.textContent = `${a.code} — ${a.name}`;
      idAlatSel.appendChild(o);
    });
  }
  const idLokSel = document.getElementById("sort-id-lokasi");
  if (idLokSel && idLokSel.options.length <= 1) {
    lokasiData.forEach((l) => {
      const o = document.createElement("option");
      o.value = l.code;
      o.textContent = `${l.name} (${l.code})`;
      idLokSel.appendChild(o);
    });
  }
  // Lokasi → UPT cascade wiring (if not yet done)
  const sortLokSel = document.getElementById("sort-lok-lokasi");
  if (sortLokSel && !sortLokSel.dataset.cascadeWired) {
    sortLokSel.dataset.cascadeWired = "1";
    sortLokSel.addEventListener("change", () => {
      _filterUptByLokasi("sort-lok-lokasi", "sort-lok-upt");
    });
  }
  document.getElementById("sort-modal").classList.remove("hidden");
});

document.getElementById("close-sort-modal")?.addEventListener("click", () => {
  document.getElementById("sort-modal").classList.add("hidden");
});

// DB Sort: sync panels on field change
document.getElementById("sort-field")?.addEventListener("change", (e) => {
  const checked = document.getElementById("sort-custom-spec")?.checked;
  _syncSortPanels(e.target.value, checked, "sort", "sort-all-data-label", "sort-custom-panels");
});

document.getElementById("sort-custom-spec")?.addEventListener("change", (e) => {
  const field = document.getElementById("sort-field")?.value;
  _syncSortPanels(field, e.target.checked, "sort", "sort-all-data-label", "sort-custom-panels");
});

// DB sort direction buttons
document.querySelectorAll(".sort-dir-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    _sortDir = btn.dataset.dir;
    document.querySelectorAll(".sort-dir-btn").forEach((b) => {
      const active = b.dataset.dir === _sortDir;
      b.classList.toggle("border-kai-blue", active);
      b.classList.toggle("bg-sky-100", active);
      b.classList.toggle("dark:bg-sky-900/20", active);
      b.classList.toggle("text-kai-blue", active);
      b.classList.toggle("dark:text-sky-300", active);
      b.classList.toggle("border-gray-200", !active);
      b.classList.toggle("dark:border-gray-600", !active);
      b.classList.toggle("bg-white", !active);
      b.classList.toggle("dark:bg-gray-700", !active);
      b.classList.toggle("text-gray-500", !active);
    });
  });
});

// The <select> value doubles as a panel id, so some options are named after the
// PANEL rather than the data field. Sorting used the raw value as a property
// key, so "Peruntukan" sorted on item.unit_peruntukan, a field that does not
// exist, and silently did nothing. Map panel id → real field in one place.
const SORT_FIELD_ALIAS = {
  unit_peruntukan: "peruntukan",
  kode_alat_name: "kode_alat_name",
};
const sortFieldOf = (v) => SORT_FIELD_ALIAS[v] || v || "id_aset";

document.getElementById("btn-apply-sort")?.addEventListener("click", () => {
  const fieldVal = document.getElementById("sort-field").value;
  _sortField = sortFieldOf(fieldVal);
  const customChecked = document.getElementById("sort-custom-spec")?.checked;

  // Collect custom filters
  _sortFilters = {};
  if (customChecked && fieldVal) {
    if (fieldVal === "id_aset") {
      // The id_aset panel has exactly two controls. Six further reads used to
      // live here (alat / pengadaan / tahun-from / tahun-to / peruntukan /
      // lokasi) naming elements that exist in no panel, so they always resolved
      // to "" and quietly widened the filter back to everything.
      _sortFilters.idFrom = parseInt(document.getElementById("sort-id-from")?.value) || null;
      _sortFilters.idTo = parseInt(document.getElementById("sort-id-to")?.value) || null;
    } else if (fieldVal === "kode_alat_name") {
      _sortFilters.alat = document.getElementById("sort-alat-filter")?.value || "";
    } else if (fieldVal === "sumber_pengadaan") {
      _sortFilters.pengadaan = document.querySelector('input[name="sort-pengadaan-filter"]:checked')?.value || "";
    } else if (fieldVal === "tanggal_pembelian") {
      _sortFilters.tahunFrom = document.getElementById("sort-tgl-from")?.value || "";
      _sortFilters.tahunTo = document.getElementById("sort-tgl-to")?.value || "";
    } else if (fieldVal === "unit_peruntukan") {
      _sortFilters.peruntukan = document.querySelector('input[name="sort-peruntukan-filter"]:checked')?.value || "";
    } else if (fieldVal === "id_lokasi") {
      _sortFilters.lokasi = document.getElementById("sort-lok-lokasi")?.value || "";
      _sortFilters.upt = document.getElementById("sort-lok-upt")?.value || "";
    }
  }

  document.getElementById("sort-modal").classList.add("hidden");
  resetPage("db");
  renderDbCards();
});

// KDA sort reset
// REPLACE existing btn-reset-sort handler
document.getElementById("btn-reset-sort")?.addEventListener("click", () => {
  _sortField = "id_aset";
  _sortDir = "date-desc";
  _sortFilters = {};

  const sortField = document.getElementById("sort-field");
  if (sortField) sortField.value = "";
  const sortSpec = document.getElementById("sort-custom-spec");
  if (sortSpec) sortSpec.checked = false;

  // Clear all sub-filter inputs
  document.querySelectorAll("#sort-custom-panels input[type='text'], #sort-custom-panels input[type='number'], #sort-custom-panels select").forEach(el => { el.value = ""; });
  document.querySelectorAll("#sort-custom-panels input[type='radio']").forEach(el => { el.checked = false; });

  _syncSortPanels("", false, "sort", "sort-all-data-label", "sort-custom-panels");
  document.querySelectorAll(".sort-dir-btn").forEach((b) => {
    b.classList.remove("border-kai-blue", "bg-sky-100", "dark:bg-sky-900/20", "text-kai-blue", "dark:text-sky-300");
    b.classList.add("border-gray-200", "dark:border-gray-600", "bg-white", "dark:bg-gray-700", "text-gray-500");
  });
  showToast("Nilai sort pada menu ini telah direset.", "info");
  renderDbCards();
});

// ── History Sort Modal ──
document.getElementById("btn-sort-history")?.addEventListener("click", () => {
  // Counts come from the summary rows this view actually lists.
  _populateYearDropdowns("hist-sort-tgl-from", "hist-sort-tgl-to");

  // Sync panels and Terbaru/Terlama visibility for current field
  const curField = document.getElementById("hist-sort-field")?.value || "id_aset";
  const curChecked = document.getElementById("hist-sort-custom-spec")?.checked || false;
  _syncSortPanels(curField, curChecked, "hist-sort", "hist-sort-all-data-label", "hist-sort-custom-panels");

  // Paint active direction button
  document.querySelectorAll(".hist-sort-dir-btn").forEach((b) => {
    const active = b.dataset.histDir === _histSortDir;
    b.classList.toggle("border-kai-orange", active);
    b.classList.toggle("bg-orange-50", active);
    b.classList.toggle("dark:bg-orange-900/20", active);
    b.classList.toggle("text-kai-orange", active);
    b.classList.toggle("dark:text-orange-300", active);
    b.classList.toggle("border-gray-200", !active);
    b.classList.toggle("dark:border-gray-600", !active);
    b.classList.toggle("bg-white", !active);
    b.classList.toggle("dark:bg-gray-700", !active);
    b.classList.toggle("text-gray-500", !active);
  });

  ["hist-sort-alat-filter"].forEach((id) => {
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

  ["hist-sort-lok-lokasi"].forEach((id) => {
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

  // Wire cascade if not yet done
  // Populate lokasi dropdown (only once)
  const histLokSel = document.getElementById("hist-sort-lok-lokasi");
  if (histLokSel && histLokSel.options.length <= 1) {
    lokasiData.forEach((l) => {
      const o = document.createElement("option");
      o.value = l.code;
      o.textContent = `${l.name} (${l.code})`;
      histLokSel.appendChild(o);
    });
  }
  // Repopulate UPT based on current Lokasi selection (preserves choice on reopen)
  const histUptSel = document.getElementById("hist-sort-lok-upt");
  if (histUptSel) {
    const currentLok = histLokSel ? histLokSel.value : "";
    const currentUpt = histUptSel.value;
    histUptSel.innerHTML = `<option value="">— ${currentLok ? "Semua UPT" : "Pilih Lokasi dahulu"} —</option>`;
    const uptList = currentLok ? uptDatabase.filter((u) => u.lokasi === currentLok) : uptDatabase;
    uptList.forEach((u) => {
      const o = document.createElement("option");
      o.value = u.upt;
      o.textContent = `${u.nama || u.upt} (${u.upt})`;
      histUptSel.appendChild(o);
    });
    if (currentUpt) histUptSel.value = currentUpt;
  }
  // Wire cascade (only once)
  if (histLokSel && !histLokSel.dataset.cascadeWired) {
    histLokSel.dataset.cascadeWired = "1";
    histLokSel.addEventListener("change", () => {
      _filterUptByLokasi("hist-sort-lok-lokasi", "hist-sort-lok-upt");
    });
  }
  document.getElementById("sort-history-modal").classList.remove("hidden");
});

document.getElementById("close-sort-history-modal")?.addEventListener("click", () => {
    document.getElementById("sort-history-modal").classList.add("hidden");
  });

document.getElementById("hist-sort-field")?.addEventListener("change", (e) => {
  const checked = document.getElementById("hist-sort-custom-spec")?.checked;
  _syncSortPanels(e.target.value, checked, "hist-sort", "hist-sort-all-data-label", "hist-sort-custom-panels");
});

document.getElementById("hist-sort-custom-spec")?.addEventListener("change", (e) => {
    const field = document.getElementById("hist-sort-field")?.value;
  _syncSortPanels(field, e.target.checked, "hist-sort", "hist-sort-all-data-label", "hist-sort-custom-panels");
  });

document.querySelectorAll(".hist-sort-dir-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    _histSortDir = btn.dataset.histDir;
    document.querySelectorAll(".hist-sort-dir-btn").forEach((b) => {
      const active = b.dataset.histDir === _histSortDir;
      b.classList.toggle("border-kai-orange", active);
      b.classList.toggle("bg-orange-50", active);
      b.classList.toggle("dark:bg-orange-900/20", active);
      b.classList.toggle("text-kai-orange", active);
      b.classList.toggle("dark:text-orange-300", active);
      b.classList.toggle("border-gray-200", !active);
      b.classList.toggle("dark:border-gray-600", !active);
      b.classList.toggle("bg-white", !active);
      b.classList.toggle("dark:bg-gray-700", !active);
      b.classList.toggle("text-gray-500", !active);
    });
  });
});

document.getElementById("btn-apply-hist-sort")?.addEventListener("click", () => {
  const fieldVal = document.getElementById("hist-sort-field")?.value || "id_aset";
  _histSortField = sortFieldOf(fieldVal);
  const customChecked = document.getElementById("hist-sort-custom-spec")?.checked;
    _histSortFilters = {};
  if (customChecked && fieldVal) {
    if (fieldVal === "id_aset") {
      _histSortFilters.idFrom = parseInt(document.getElementById("hist-sort-id-from")?.value) || null;
      _histSortFilters.idTo = parseInt(document.getElementById("hist-sort-id-to")?.value) || null;
    } else if (fieldVal === "kode_alat_name") {
      _histSortFilters.alat = document.getElementById("hist-sort-alat-filter")?.value || "";
    } else if (fieldVal === "sumber_pengadaan") {
      _histSortFilters.pengadaan = document.querySelector('input[name="hist-sort-pengadaan-filter"]:checked')?.value || "";
    } else if (fieldVal === "tanggal_pembelian") {
      _histSortFilters.tahunFrom = document.getElementById("hist-sort-tgl-from")?.value || "";
      _histSortFilters.tahunTo = document.getElementById("hist-sort-tgl-to")?.value || "";
    } else if (fieldVal === "unit_peruntukan") {
      _histSortFilters.peruntukan = document.querySelector('input[name="hist-sort-peruntukan-filter"]:checked')?.value || "";
    } else if (fieldVal === "id_lokasi") {
      _histSortFilters.lokasi = document.getElementById("hist-sort-lok-lokasi")?.value || "";
      _histSortFilters.upt = document.getElementById("hist-sort-lok-upt")?.value || "";
    }
    }
    document.getElementById("sort-history-modal").classList.add("hidden");
    resetPage(`history-${_historyMode}`);
    if (_historyMode === "repair") renderHistoryCards();
    else if (_historyMode === "kalibrasi") renderKalibrasiCards();
    else renderMutasiCards();
  });

// PRA sort reset
document.getElementById("btn-reset-hist-sort")?.addEventListener("click", () => {
  _histSortField = "id_aset";
  _histSortDir = "date-desc";
  _histSortFilters = {};

  const histField = document.getElementById("hist-sort-field");
  if (histField) histField.value = "";
  const histSpec = document.getElementById("hist-sort-custom-spec");
  if (histSpec) histSpec.checked = false;

  // Clear all sub-filter inputs
  document.querySelectorAll("#hist-sort-custom-panels input[type='text'], #hist-sort-custom-panels input[type='number'], #hist-sort-custom-panels select").forEach(el => { el.value = ""; });
  document.querySelectorAll("#hist-sort-custom-panels input[type='radio']").forEach(el => { el.checked = false; });

  _syncSortPanels("", false, "hist-sort", "hist-sort-all-data-label", "hist-sort-custom-panels");
  document.querySelectorAll(".hist-sort-dir-btn").forEach((b) => {
    b.classList.remove("border-kai-orange", "bg-orange-50", "dark:bg-orange-900/20", "text-kai-orange", "dark:text-orange-300");
    b.classList.add("border-gray-200", "dark:border-gray-600", "bg-white", "dark:bg-gray-700", "text-gray-500");
  });
  showToast("Nilai sort pada menu ini telah direset.", "info");
  if (_historyMode === "repair") renderHistoryCards();
  else if (_historyMode === "kalibrasi") renderKalibrasiCards();
  else renderMutasiCards();
});
