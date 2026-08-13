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

// ── Helper: how many rows fall in each purchase year ──
//
// Drives the "(128)" / "(kosong)" suffix on every year option, so a user can
// see which years hold data before selecting one instead of picking a year and
// getting an empty list.
function _yearCounts(rows = db, dateField = "tanggal_pembelian") {
  const counts = new Map();
  (rows || []).forEach((r) => {
    const y = String(r?.[dateField] ?? "").slice(0, 4);
    if (/^\d{4}$/.test(y)) counts.set(y, (counts.get(y) || 0) + 1);
  });
  return counts;
}

function yearOptionLabel(year, counts) {
  const n = counts.get(String(year)) || 0;
  return n ? `${year} (${n.toLocaleString("id-ID")})` : `${year} (kosong)`;
}

/**
 * Fill a pair of year <select>s.
 *
 * Two things were wrong before. The selects are authored EMPTY in index.html,
 * so option[0] was the current year and got auto-selected — choosing "Tahun
 * Beli" + a custom range then filtered to 2026 alone and emptied every list,
 * since the seeded data stops at 2023. And the reset handlers set value = ""
 * against an option that did not exist, leaving selectedIndex = -1 and a blank
 * box. A real "Semua Tahun" option at index 0 fixes both.
 *
 * The range is capped at the oldest year present (floored at 1950) rather than
 * always walking back to 1950 — 70+ dead options are noise.
 */
function _populateYearDropdowns(fromId, toId, rows = db, dateField = "tanggal_pembelian") {
  const counts = _yearCounts(rows, dateField);
  const curYear = new Date().getFullYear();
  const years = [...counts.keys()].map(Number).filter((n) => !isNaN(n));
  const oldest = years.length ? Math.min(...years) : curYear - 10;
  const newest = Math.max(curYear, ...(years.length ? years : [curYear]));

  [fromId, toId].forEach((id) => {
    const sel = document.getElementById(id);
    if (!sel) return;

    // Rebuild rather than bail on `options.length > 1`: the counts change every
    // time the asset list is refetched, so a cached list would go stale.
    const previous = sel.value;
    sel.innerHTML = "";

    const all = document.createElement("option");
    all.value = "";
    all.textContent = "Semua Tahun";
    sel.appendChild(all);

    for (let y = newest; y >= Math.max(1950, oldest); y--) {
      const o = document.createElement("option");
      o.value = String(y);
      o.textContent = yearOptionLabel(y, counts);
      sel.appendChild(o);
    }
    sel.value = previous || "";
  });
}

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

    // Hide every sub-panel first. This must list ALL prefix families — a
    // missing one means that modal's panels stack instead of swapping when the
    // user changes the sort criterion.
    customPanels
      .querySelectorAll(
        "[id^='sort-panel-'], [id^='hist-sort-panel-'], [id^='kdak-sort-panel-'], [id^='afkir-sort-panel-']",
      )
      .forEach((p) => p.classList.add("hidden"));
    // Show the one matching the active prefix + field. Scoped to THIS modal's
    // container — a global id lookup could reveal a panel belonging to another
    // sort modal when two of them use different names for the same field.
    const panel = customPanels.querySelector(
      `#${panelPrefix}-panel-${CSS.escape(fieldVal)}`,
    );
    if (panel) panel.classList.remove("hidden");
  }
}

// ── DB Sort Modal ──
document.getElementById("btn-sort-db")?.addEventListener("click", () => {
  // "sort-id-tahun-from/-to" exist in no HTML — the call was a no-op.
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
// key, so "Peruntukan" sorted on item.unit_peruntukan — a field that does not
// exist — and silently did nothing. Map panel id → real field in one place.
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
  _populateYearDropdowns("hist-sort-tgl-from", "hist-sort-tgl-to", _historySummary);

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
