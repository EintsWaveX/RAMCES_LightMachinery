// ═══════════════════════════════════════════════════════════════════════
// Pusat Data: pengguna, alat kerja, Model/Type, lokasi, UPT
// and gudang, plus the shared master edit modal.
//
// Part of the RAMCES frontend. These files are plain classic scripts
// loaded in a fixed order by index.html - no bundler, no modules. They
// share one global scope, so a top-level `let` or `const` declared twice
// across two files is a fatal SyntaxError; see CLAUDE.md.
// ═══════════════════════════════════════════════════════════════════════

// ── MASTER DATA UI ─────────────────────────────────────────────────────────

// Which Pusat Data tab is open. The shared search box filters whichever table
// this names, so every renderer reads the same query.
let _masterTab = "users";
let _masterSearch = "";

/** Reload the visible master table. Used by the tabs, the search box and the
 *  post-mutation refreshes, so no caller has to remember the mapping. */
function refreshMasterTab() {
  if (_masterTab === "users") loadMasterUsers();
  if (_masterTab === "alat") loadMasterAlat();
  if (_masterTab === "varian") loadMasterVarian();
  if (_masterTab === "lokasi") loadMasterLokasi();
  if (_masterTab === "upt") loadMasterUpt();
  if (_masterTab === "gudang") loadMasterGudang();
}

/**
 * Shared row matcher for every Pusat Data table.
 *
 * Location-bearing rows go through lokasiMatchesTerm so "DAOP 1" behaves the
 * same here as it does on the asset views; everything else is plain substring.
 */
function masterRowMatches(values, { lokasiIdentity } = {}) {
  const q = _masterSearch;
  if (!q) return true;
  if (lokasiIdentity && lokasiMatchesTerm(lokasiIdentity, q)) return true;
  return textMatchesTerm(values, q);
}

function setMasterSearchCount(shown, total) {
  const node = document.getElementById("master-search-count");
  if (!node) return;
  node.textContent = _masterSearch
    ? `${shown} dari ${total} baris`
    : `${total} baris`;
}

// Tab switching.
//
// Extracted from the click handler and exported so other views can jump
// straight to a panel — the KDAK forms' "+ Tambah Model/Type baru…" shortcut
// needs to land on the Model/Type tab, not merely on Pusat Data.
function switchMasterTab(target) {
  _masterTab = target;

  // The tabs now carry the shared .tab component class, so activation is a
  // single class toggle rather than two lists of Tailwind utilities that had
  // to be kept in sync with the markup by hand.
  document
    .querySelectorAll(".master-tab")
    .forEach((t) => t.classList.toggle("is-active", t.dataset.tab === target));

  document
    .querySelectorAll(".master-tab-panel")
    .forEach((p) => p.classList.add("hidden"));
  document.getElementById(`master-panel-${target}`)?.classList.remove("hidden");

  // A query typed for one table rarely means anything in the next.
  const box = document.getElementById("master-search");
  if (box) box.value = "";
  _masterSearch = "";

  // Second level. Under lg: the tab list and the panel are two screens, so
  // choosing a master drills in; above lg: the class exists but the stylesheet
  // ignores it and the layout is the tab strip it has always been.
  document.getElementById("view-masterdata")?.classList.add("is-drilled");
  const title = document.getElementById("master-detail-title");
  const btn = document.querySelector(`.master-tab[data-tab="${target}"]`);
  if (title && btn) title.textContent = btn.textContent.trim();

  refreshMasterTab();
}
window.switchMasterTab = switchMasterTab;

document.querySelectorAll(".master-tab").forEach((tab) => {
  tab.addEventListener("click", () => switchMasterTab(tab.dataset.tab));
});

document.getElementById("master-back")?.addEventListener("click", () => {
  document.getElementById("view-masterdata")?.classList.remove("is-drilled");
});

document.getElementById("master-search")?.addEventListener(
  "input",
  debounce((e) => {
    _masterSearch = normalizeSearchText(e.target.value);
    refreshMasterTab();
  }),
);

/**
 * Row counts across every table Pusat Data governs.
 *
 * Deliberately includes the tables this screen does NOT edit (aset, riwayat,
 * sparepart) so "Pusat Data" reads as a view of the whole database rather than
 * of the four tables that happen to have forms.
 */
async function loadMasterCounts() {
  const mount = document.getElementById("master-counts");
  if (!mount) return;

  const tile = (label, value, icon, tone) => `
    <div class="stat-card">
      <p class="stat-label">${label}</p>
      <h3 class="stat-value ${tone}">${value}</h3>
      <i class="fas ${icon} stat-icon"></i>
    </div>`;

  // Everything here is already cached or cheap; nothing new is fetched for the
  // counts alone.
  const [varianRes, gudangRes, partsRes] = await Promise.all([
    apiFetch("/master/varian", { background: true }).catch(() => null),
    apiFetch("/inventaris/gudang?include_inactive=true", { background: true }).catch(() => null),
    apiFetch("/inventaris/parts", { background: true }).catch(() => null),
  ]);
  const varian = varianRes?.ok ? (await varianRes.json()).length : 0;
  const gudang = gudangRes?.ok ? (await gudangRes.json()).length : 0;
  const parts = partsRes?.ok ? (await partsRes.json()).length : 0;

  mount.innerHTML = [
    tile("Alat Kerja", alatKerjaData.length, "fa-gears", "text-purple-500"),
    tile("Model/Type", varian, "fa-screwdriver-wrench", "text-rose-500"),
    tile("Lokasi", lokasiData.length, "fa-map", "text-teal-500"),
    tile("UPT", uptDatabase.length, "fa-sitemap", "text-cyan-600"),
    tile("Gudang", gudang, "fa-warehouse", "text-amber-600"),
    tile("Suku Cadang", parts, "fa-boxes", "text-kai-blue dark:text-blue-400"),
  ].join("");
}

// ── LOAD FUNCTIONS ────────────────────────────────────────────────

function syncNewUserRegion() {
  const roleEl = document.getElementById("new-user-role");
  const regionEl = document.getElementById("new-user-region");
  if (!roleEl || !regionEl) return;

  const isSA = roleEl.value === "SUPER_ADMIN";
  if (isSA) {
    regionEl.disabled = true;
    regionEl.innerHTML =
      '<option value="">Semua Region (tidak diperlukan)</option>';
  } else {
    regionEl.disabled = false;
    regionEl.innerHTML = lokasiData
      .map((l) => `<option value="${l.code}">${l.name} (${l.code})</option>`)
      .join("");
    if (!regionEl.value && lokasiData.length)
      regionEl.value = lokasiData[0].code;
  }
}

async function loadMasterUsers() {
  const tbody = document.getElementById("table-users");
  if (!tbody) return;

  syncNewUserRegion();

  const addFormWrap = document.getElementById("form-add-user");
  if (addFormWrap) {
    addFormWrap.classList.toggle("hidden", _currentRole !== "SUPER_ADMIN");
  }

  // Skeleton in place of the blanking overlay: the table keeps its shape and
  // the page keeps its scroll position while the rows are refetched.
  skeletonRows("table-users", 5);

  try {
    const res = await apiFetch("/users", { background: true });
    if (!res.ok) throw new Error();
    const all = await res.json();

    const data = all.filter((u) =>
      masterRowMatches([u.username, u.role, u.nama_lokasi, u.id_lokasi], {
        lokasiIdentity: {
          uptCode: u.id_lokasi || "",
          parentCode: getParentLokasiCode(u.id_lokasi) || u.id_lokasi || "",
          uptName: u.nama_lokasi || "",
          parentName: u.nama_lokasi || "",
        },
      }),
    );
    setMasterSearchCount(data.length, all.length);

    if (!data.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-state">${
        all.length ? "Tidak ada pengguna yang cocok." : "Belum ada data pengguna."
      }</td></tr>`;
      return;
    }

    const roleColors = {
      SUPER_ADMIN:
        "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
      ADMIN_WILAYAH:
        "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
      TEKNISI:
        "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
    };

    tbody.innerHTML = data
      .map(
        (u) => `
            <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td class="px-4 py-3 font-semibold font-mono">${u.username}</td>
                <td class="px-4 py-3">
                    <span class="text-xs px-2 py-0.5 rounded-full font-bold ${roleColors[u.role] || "bg-gray-100 text-gray-700"}">
                        ${u.role}
                    </span>
                </td>
                <td class="px-4 py-3 text-sm text-gray-500 font-mono">${u.nama_lokasi || u.id_lokasi || "—"}</td>
                <td class="px-4 py-3">${_presenceCell(u)}</td>
                <td class="px-4 py-3 text-right whitespace-nowrap">
                    <button onclick="window.openMasterEdit('users',${u.id_pengguna},'${u.username}','${u.role}','${u.id_lokasi || ""}')"
                        class="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-3 py-1 rounded-lg font-bold hover:bg-blue-200 transition">
                        <i class="fas fa-edit mr-1"></i> Edit
                    </button>
                    <button onclick="window.openResetPassword(${u.id_pengguna}, ${JSON.stringify(u.username)})"
                        title="${u.has_password ? "Setel ulang password" : "Akun ini belum punya password dan tidak bisa masuk"}"
                        class="ml-1 text-xs ${
                          u.has_password
                            ? "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200"
                            : "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 hover:bg-amber-200"
                        } px-3 py-1 rounded-lg font-bold transition">
                        <i class="fas ${u.has_password ? "fa-key" : "fa-triangle-exclamation"} mr-1"></i>${
                          u.has_password ? "Password" : "Belum ada password"
                        }
                    </button>
                </td>
            </tr>
        `,
      )
      .join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" class="px-4 py-6 text-center text-red-400 text-sm">Gagal memuat data pengguna.</td></tr>`;
  }
}

// Friendly names for the view ids reported over the WebSocket, so the Pengguna
// list reads "sedang di Kelola Inventaris" rather than "inventaris".
const VIEW_LABEL = {
  dashboard: "Dashboard",
  input: "Kelola Aset Alat Kerja",
  inventaris: "Kelola Inventaris",
  database: "Kelola Data Aset",
  history: "Pantau Riwayat Aset",
  "history-detail": "Detail Riwayat Aset",
  edit: "Pembaruan Kondisi",
  laporan: "Proses Laporan",
  masterdata: "Pusat Data",
  afkir: "Pulihkan Aset Afkir",
};

// Presence is a dot PLUS a word — never colour alone, so the state is readable
// for a colour-blind user and in a printed export.
function _presenceCell(u) {
  const view = u.last_view ? VIEW_LABEL[u.last_view] || u.last_view : null;
  if (u.online) {
    return `
      <span class="inline-flex items-center gap-1.5 text-[11px] font-bold text-green-600 dark:text-green-400">
        <span class="w-2 h-2 rounded-full bg-green-500 shrink-0"></span>Online
      </span>
      <p class="text-[10px] text-gray-400 mt-0.5">${view ? `di ${view}` : "sedang menjelajah"}</p>`;
  }
  return `
    <span class="inline-flex items-center gap-1.5 text-[11px] font-bold text-gray-400">
      <span class="w-2 h-2 rounded-full bg-gray-300 dark:bg-gray-600 shrink-0"></span>Offline
    </span>
    <p class="text-[10px] text-gray-400 mt-0.5">${
      u.last_seen ? `terakhir ${u.last_seen}` : "belum pernah masuk"
    }</p>`;
}

// Called by the WebSocket REFRESH_PRESENCE broadcast. Only refetches when the
// Pengguna tab is actually on screen — presence churns constantly and every
// connected client would otherwise poll it.
window.refreshPresenceIfVisible = function refreshPresenceIfVisible() {
  const view = document.getElementById("view-masterdata");
  if (!view?.classList.contains("is-visible")) return;
  const panel = document.getElementById("master-panel-users");
  if (!panel || panel.classList.contains("hidden")) return;
  loadMasterUsers();
};

// Cached variants, keyed by kode_alat, so the table can show each tool's
// technical specs without a request per row.
let _varianByAlat = {};

async function loadAlatVarian() {
  try {
    const res = await apiFetch("/master/varian", { background: true });
    if (!res.ok) return;
    const rows = await res.json();
    _varianByAlat = {};
    rows.forEach((v) => {
      (_varianByAlat[v.kode_alat] ||= []).push(v);
    });
  } catch (_) { /* the table degrades to "—" */ }
}
window.loadAlatVarian = loadAlatVarian;

// -- Tool-type documents (Dokumen Umum) ----------------------------
//
// These live on `kategori_alat`, not on a Model/Type, because that is how the
// client files them: "Spektek Genset, Pompa Air, Shear Wrench dan Impact
// Wrench.pdf" is ONE file describing FOUR tools, and several cover tools that
// have no Model/Type row at all. Every model with no sheet of its own inherits
// from here -- see `_varian_payload()` in main.py -- which is the only way a
// spec sheet reaches an asset whose model was never filled in.
function _dokumenAlatChip(kode, jenis, url, isUpload, icon, label) {
  if (!url) {
    return `<button type="button" onclick="window.pilihDokumenAlat('${kode}','${jenis}')"
              title="Unggah ${label} untuk ${kode}"
              class="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded
                     border border-dashed border-gray-300 dark:border-gray-600
                     text-gray-400 hover:border-kai-blue hover:text-kai-blue transition mr-1 mb-1">
              <i class="fas fa-plus text-[8px]"></i>${label}
            </button>`;
  }
  const open = isUpload
    ? `window.bukaDokumenModel('${url}','${label}')`
    : `window.open('${url}','_blank','noopener')`;
  return `<span class="inline-flex items-center gap-1 text-[10px] font-semibold
                       bg-emerald-50 dark:bg-emerald-900/25 text-emerald-700 dark:text-emerald-300
                       px-1.5 py-0.5 rounded mr-1 mb-1">
            <button type="button" onclick="${open}" title="Buka ${label}"
                    class="inline-flex items-center gap-1 hover:underline">
              <i class="fas ${icon} text-[9px]"></i>${label}
            </button>
            <button type="button" onclick="window.hapusDokumenAlat('${kode}','${jenis}','${label}')"
                    aria-label="Hapus ${label}" title="Hapus ${label}"
                    class="opacity-60 hover:opacity-100 hover:text-red-600 transition">
              <i class="fas fa-xmark text-[9px]"></i>
            </button>
          </span>`;
}

function _dokumenAlatCell(a) {
  return (
    _dokumenAlatChip(a.kode_alat, "spek", a.spek, a.spek_is_upload,
                     "fa-file-lines", "Spek") +
    _dokumenAlatChip(a.kode_alat, "manual", a.manual, a.manual_is_upload,
                     "fa-book", "Manual")
  );
}

// ONE hidden <input type="file"> reused by every chip, rather than 208 of them
// in the DOM (104 alat kerja x 2 document kinds).
window.pilihDokumenAlat = function (kode, jenis) {
  let input = document.getElementById("dokumen-alat-picker");
  if (!input) {
    input = document.createElement("input");
    input.type = "file";
    input.id = "dokumen-alat-picker";
    input.accept = ".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.webp";
    input.className = "hidden";
    document.body.appendChild(input);
  }
  input.value = "";
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    try {
      // apiFetch skips the JSON Content-Type for FormData on purpose -- only
      // the browser knows the multipart boundary.
      const res = await apiFetch(
        `/master/alat/${encodeURIComponent(kode)}/dokumen?jenis=${jenis}`,
        { method: "POST", body: form },
      );
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Gagal mengunggah dokumen.");
      }
      showToast(`Dokumen ${jenis} untuk ${kode} diunggah.`, "success");
      await loadMasterAlat();
      window.invalidateVarianCache && window.invalidateVarianCache();
    } catch (err) {
      if (err.message !== "Unauthorized") showToast(err.message, "error");
    }
  };
  input.click();
};

window.hapusDokumenAlat = async function (kode, jenis, label) {
  const ok = await customConfirm(
    `Hapus ${label} untuk ${kode}?\n\nSetiap Model/Type yang tidak punya dokumen sendiri akan kehilangan tautannya.`,
  );
  if (!ok) return;
  try {
    const res = await apiFetch(
      `/master/alat/${encodeURIComponent(kode)}/dokumen?jenis=${jenis}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Gagal menghapus dokumen.");
    }
    showToast(`Dokumen ${label} untuk ${kode} dihapus.`, "success");
    await loadMasterAlat();
    window.invalidateVarianCache && window.invalidateVarianCache();
  } catch (err) {
    if (err.message !== "Unauthorized") showToast(err.message, "error");
  }
};

async function loadMasterAlat() {
  const tbody = document.getElementById("table-alat");
  if (!tbody) return;
  // The table has FOUR columns; this used to emit five <td> under three <th>
  // with colspan="4" empty states matching neither, so every row was misaligned.
  // Skeleton rather than the blanking overlay — the table keeps its
  // shape and the page keeps its scroll position on a refresh.
  skeletonRows("table-alat", 4);
  try {
    await loadAlatVarian();
    const res = await apiFetch("/master/alat", { background: true });
    const all = await res.json();

    // Variant names are searchable too: looking up "GX390" should find the
    // GENSET row that carries it.
    const data = all.filter((a) =>
      masterRowMatches([
        a.kode_alat,
        a.nama_alat,
        ...(_varianByAlat[a.kode_alat] || []).map((v) => v.nama_varian),
      ]),
    );
    setMasterSearchCount(data.length, all.length);

    if (!data.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-state">${
        all.length ? "Tidak ada alat yang cocok." : "Belum ada data alat."
      }</td></tr>`;
      return;
    }

    tbody.innerHTML = data
      .map((a) => {
        // Model/Type rows — the models that are NOT
        // interchangeable for sparepart purposes, e.g. GX270 vs GX390.
        const varian = _varianByAlat[a.kode_alat] || [];
        const varianCell = varian.length
          ? varian
              .map(
                (v) =>
                  `<span class="inline-block text-[10px] font-semibold bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-1.5 py-0.5 rounded mr-1 mb-1" title="${v.keterangan || v.nama_varian}">${v.nama_varian}</span>`,
              )
              .join("")
          : '<span class="text-gray-300 dark:text-gray-600">—</span>';
        return `
            <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td class="px-4 py-3 font-mono font-bold text-blue-600 dark:text-blue-400">${a.kode_alat}</td>
                <td class="px-4 py-3 font-semibold">${a.nama_alat}</td>
                <td class="px-4 py-3 text-xs max-w-[280px]">${varianCell}</td>
                <td class="px-4 py-3 text-xs">${_dokumenAlatCell(a)}</td>
                <td class="px-4 py-3 text-right">
                    <button onclick="window.openMasterEdit('alat','${a.kode_alat}','${a.nama_alat}','','')"
                        class="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-3 py-1 rounded-lg font-bold hover:bg-blue-200 transition">
                        <i class="fas fa-edit mr-1"></i> Edit
                    </button>
                </td>
            </tr>`;
      })
      .join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" class="px-4 py-6 text-center text-red-400 text-sm">Gagal memuat data.</td></tr>`;
  }
}

async function loadMasterLokasi() {
  const tbody = document.getElementById("table-lokasi");
  if (!tbody) return;
  // Skeleton rather than the blanking overlay — the table keeps its
  // shape and the page keeps its scroll position on a refresh.
  skeletonRows("table-lokasi", 4);
  try {
    const res = await apiFetch(
      "/master/lokasi?tipe=DAOP&tipe=DIVRE&tipe=BALAIYASA&tipe=PUSAT",
      { background: true },
    );
    const all = await res.json();

    // Region-aware: typing "DAOP 1" must match DAOP 1 and not DAOP 10.
    const data = all.filter((l) =>
      masterRowMatches([l.id_lokasi, l.nama_lokasi, l.tipe], {
        lokasiIdentity: {
          uptCode: l.id_lokasi,
          parentCode: l.id_lokasi,
          uptName: l.nama_lokasi,
          parentName: l.nama_lokasi,
        },
      }),
    );
    setMasterSearchCount(data.length, all.length);

    if (!data.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-state">${
        all.length ? "Tidak ada lokasi yang cocok." : "Belum ada data lokasi."
      }</td></tr>`;
      return;
    }

    tbody.innerHTML = data
      .map(
        (l) => `
            <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td class="px-4 py-3 font-mono font-bold text-blue-600 dark:text-blue-400">${l.id_lokasi}</td>
                <td class="px-4 py-3 font-semibold">${l.nama_lokasi}</td>
                <td class="px-4 py-3">
                    <span class="text-xs px-2 py-0.5 rounded-full font-bold
                        ${
                          l.tipe === "DAOP"
                            ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                            : l.tipe === "DIVRE"
                              ? "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
                              : l.tipe === "PUSAT"
                                ? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300"
                                : "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300"
                        }">
                        <!--  
                        ${l.tipe == "BALAIYASA" ? "KANTOR PUSAT" : l.tipe}
                        -->
                        ${l.tipe}
                    </span>
                </td>
                <td class="px-4 py-3 text-right">
                    <button onclick="window.openMasterEdit('lokasi','${l.id_lokasi}','${l.nama_lokasi}','${l.tipe}')"
                        class="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-3 py-1 rounded-lg font-bold hover:bg-blue-200 transition">
                        <i class="fas fa-edit mr-1"></i> Edit
                    </button>
                </td>
            </tr>
        `,
      )
      .join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-red-400 text-sm">Gagal memuat data.</td></tr>`;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// PUSAT DATA ▸ MODEL/TYPE (alat_varian)
//
// The endpoints existed with no UI, so models — and the spec block the public
// QR card renders — could only be created by running seed.py.
// ══════════════════════════════════════════════════════════════════════════

let _masterVarianRows = [];

async function loadMasterVarian() {
  const tbody = document.getElementById("table-varian");
  if (!tbody) return;
  // Skeleton rather than the blanking overlay — the table keeps its
  // shape and the page keeps its scroll position on a refresh.
  skeletonRows("table-varian", 6);
  const alatSel = document.getElementById("new-varian-alat");
  if (alatSel && alatKerjaData.length) {
    const keep = alatSel.value;
    alatSel.innerHTML =
      '<option value="">— Pilih alat kerja —</option>' +
      alatKerjaData
        .map((a) => `<option value="${a.code}">${a.code} — ${a.name}</option>`)
        .join("");
    alatSel.value = keep;
  }

  try {
    const res = await apiFetch("/master/varian", { background: true });
    if (!res.ok) throw new Error();
    _masterVarianRows = await res.json();
    resetPage("master-varian");
    renderMasterVarian();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state is-error">Gagal memuat Model/Type.</td></tr>`;
  }
}

function renderMasterVarian() {
  const tbody = document.getElementById("table-varian");
  if (!tbody) return;

  const alatName = (kode) =>
    alatKerjaData.find((a) => a.code === kode)?.name || kode;

  const rows = _masterVarianRows.filter((v) =>
    masterRowMatches([
      v.kode_alat, alatName(v.kode_alat), v.nama_varian,
      v.merk, v.tipe_model, v.kapasitas, v.daya, v.keterangan,
    ]),
  );
  setMasterSearchCount(rows.length, _masterVarianRows.length);

  if (!rows.length) {
    renderPagerBar("master-varian-pager", paginateList("master-varian", rows), renderMasterVarian);
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">${
      _masterVarianRows.length
        ? "Tidak ada Model/Type yang cocok."
        : "Belum ada Model/Type."
    }</td></tr>`;
    return;
  }

  const page = paginateList("master-varian", rows);
  renderPagerBar("master-varian-pager", page, renderMasterVarian);

  const dash = (v) => v || '<span class="text-gray-300 dark:text-gray-600">—</span>';
  const esc = window.spekEscape;
  tbody.innerHTML = page.items
    .map((v) => {
      // A thumbnail, or a neutral placeholder of the same footprint so the row
      // height does not jump between models that have a photo and models that
      // do not — "IMAGE (required)" in the Rekap means the gaps are work to do.
      const foto = v.foto
        ? `<img src="${esc(v.foto)}" alt="" loading="lazy"
             class="w-10 h-10 object-contain rounded border border-gray-200 dark:border-gray-600 bg-white" />`
        : `<div class="w-10 h-10 rounded border border-dashed border-gray-200 dark:border-gray-600
             flex items-center justify-center text-gray-300 dark:text-gray-600" title="Foto belum ada">
             <i class="fas fa-camera text-xs"></i></div>`;
      const spek = (v.spesifikasi || [])
        .slice(0, 3)
        .map(
          (s) =>
            `<span class="inline-block text-[10px] bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-1.5 py-0.5 rounded mr-1 mb-1"
               title="${esc(s.label)}: ${esc(s.nilai)}">${esc(s.label)}</span>`,
        )
        .join("");
      const extra = (v.spesifikasi || []).length > 3
        ? `<span class="text-[10px] text-gray-400">+${v.spesifikasi.length - 3}</span>`
        : "";
      return `
      <tr>
        <td>${foto}</td>
        <td><span class="font-mono font-bold text-kai-blue dark:text-blue-400">${esc(v.kode_alat)}</span>
            <span class="block text-[10px] text-gray-400">${esc(alatName(v.kode_alat))}</span></td>
        <td class="font-semibold">${esc(v.tipe_model || v.nama_varian)}
            <span class="block text-[10px] text-gray-400 font-normal">${esc(v.nama_varian)}</span></td>
        <td class="text-xs">${dash(esc(v.merk || ""))}</td>
        <td class="text-xs max-w-[240px]">${spek + extra || dash("")}</td>
        <td class="text-right whitespace-nowrap">
          <button class="btn-icon" title="Ubah" onclick="window.editMasterVarian(${v.id_varian})">
            <i class="fas fa-pen text-[11px]"></i></button>
          <button class="btn-icon btn-icon-danger" title="Hapus" onclick="window.deleteMasterVarian(${v.id_varian})">
            <i class="fas fa-trash-alt text-[11px]"></i></button>
        </td>
      </tr>`;
    })
    .join("");
}

// Scalar text fields ↔ payload keys. The five spec PAIRS are handled
// separately below because they are always sent, including as null, so that
// clearing a slot actually clears it (update_alat_varian uses exclude_unset).
const _VARIAN_FORM_FIELDS = {
  "new-varian-merk": "merk",
  "new-varian-tipe": "tipe_model",
  "new-varian-foto-url": "foto_url",
  "new-varian-url-spek": "url_spek",
  "new-varian-url-manual": "url_manual",
  "new-varian-keterangan": "keterangan",
};

function _varianSpekInputs() {
  const out = [];
  for (let i = 1; i <= 5; i++) {
    out.push([
      document.getElementById(`new-varian-spek${i}-label`),
      document.getElementById(`new-varian-spek${i}-nilai`),
      `spek${i}_label`,
      `spek${i}_nilai`,
    ]);
  }
  return out;
}

window.editMasterVarian = function (id) {
  const v = _masterVarianRows.find((x) => x.id_varian === id);
  if (!v) return;
  document.getElementById("varian-edit-id").value = id;
  document.getElementById("new-varian-alat").value = v.kode_alat;
  // kode_alat is part of the uniqueness constraint and the API has no move
  // path, so it is locked while editing.
  document.getElementById("new-varian-alat").disabled = true;
  document.getElementById("new-varian-nama").value = v.nama_varian || "";
  Object.entries(_VARIAN_FORM_FIELDS).forEach(([elId, key]) => {
    const n = document.getElementById(elId);
    if (n) n.value = v[key] || "";
  });
  _varianSpekInputs().forEach(([lab, val, kLab, kVal]) => {
    if (lab) lab.value = v[kLab] || "";
    if (val) val.value = v[kVal] || "";
  });
  _setVarianFotoPreview(v.foto, !!v.foto_file);
  document.getElementById("varian-submit-label").textContent = "Simpan Perubahan";
  document.getElementById("varian-cancel-edit")?.classList.remove("hidden");
  document.getElementById("form-add-varian")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
};

function _setVarianFotoPreview(url, isUpload) {
  const img = document.getElementById("varian-foto-preview");
  const del = document.getElementById("varian-foto-hapus");
  if (img) {
    if (url) {
      img.src = url;
      img.classList.remove("hidden");
    } else {
      img.removeAttribute("src");
      img.classList.add("hidden");
    }
  }
  // Only an UPLOADED photo has a file to delete; a pasted URL is cleared by
  // emptying its text field.
  del?.classList.toggle("hidden", !isUpload);
}

function _resetVarianForm() {
  document.getElementById("varian-edit-id").value = "";
  const alatSel = document.getElementById("new-varian-alat");
  if (alatSel) { alatSel.disabled = false; alatSel.value = ""; }
  const nama = document.getElementById("new-varian-nama");
  if (nama) nama.value = "";
  Object.keys(_VARIAN_FORM_FIELDS).forEach((id) => {
    const n = document.getElementById(id);
    if (n) n.value = "";
  });
  _varianSpekInputs().forEach(([lab, val]) => {
    if (lab) lab.value = "";
    if (val) val.value = "";
  });
  ["new-varian-foto-file", "new-varian-spek-file", "new-varian-manual-file"].forEach(
    (id) => {
      const n = document.getElementById(id);
      if (n) n.value = "";
    },
  );
  _setVarianFotoPreview(null, false);
  const label = document.getElementById("varian-submit-label");
  if (label) label.textContent = "Simpan Model/Type";
  document.getElementById("varian-cancel-edit")?.classList.add("hidden");
}

// The Rekap's own title rule: "[MERK] [MODEL/TYPE]", max 50 characters. Filled
// in as the two fields are typed so the admin rarely has to touch it, but left
// editable — and never overwritten once they do.
function _autofillVarianNama() {
  const nama = document.getElementById("new-varian-nama");
  if (!nama || nama.dataset.touched === "1") return;
  const merk = document.getElementById("new-varian-merk")?.value.trim() || "";
  const tipe = document.getElementById("new-varian-tipe")?.value.trim() || "";
  nama.value = `${merk} ${tipe}`.trim().slice(0, 50);
}
document.getElementById("new-varian-merk")?.addEventListener("input", _autofillVarianNama);
document.getElementById("new-varian-tipe")?.addEventListener("input", _autofillVarianNama);
document.getElementById("new-varian-nama")?.addEventListener("input", (e) => {
  e.target.dataset.touched = e.target.value ? "1" : "0";
});

// Jumped to from the KDAK forms' "+ Tambah Model/Type baru…" option, with the
// alat kerja already chosen so the admin lands on a half-filled form rather
// than an empty one.
window.openMasterVarianFor = function (kodeAlat) {
  if (typeof window.switchMasterTab === "function") window.switchMasterTab("varian");
  setTimeout(() => {
    _resetVarianForm();
    const sel = document.getElementById("new-varian-alat");
    if (sel) sel.value = kodeAlat || "";
    document.getElementById("new-varian-merk")?.focus();
    document
      .getElementById("form-add-varian")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 60);
};

document.getElementById("varian-foto-hapus")?.addEventListener("click", async () => {
  const id = document.getElementById("varian-edit-id")?.value;
  if (!id) return;
  if (!(await customConfirm("Hapus foto Model/Type ini?"))) return;
  const res = await apiFetch(`/master/varian/${id}/foto`, { method: "DELETE" });
  if (!res.ok) {
    const p = await res.json().catch(() => ({}));
    showToast(p.detail || "Gagal menghapus foto.", "error");
    return;
  }
  _setVarianFotoPreview(null, false);
  showToast("Foto dihapus.", "success");
  await loadMasterVarian();
  await loadAlatVarian();
});

window.deleteMasterVarian = async function (id) {
  const v = _masterVarianRows.find((x) => x.id_varian === id);
  if (!(await customConfirm(`Hapus Model/Type "${v?.nama_varian || id}"?\n\nAset dan sparepart yang memakai Model/Type ini akan kehilangan kaitannya (datanya sendiri tetap aman).`)))
    return;
  try {
    const res = await apiFetch(`/master/varian/${id}`, { method: "DELETE" });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(payload.detail || "Gagal menghapus Model/Type.", "error");
      return;
    }
    showToast("Model/Type dihapus.", "success");
    await loadMasterVarian();
    await loadAlatVarian();
  } catch (e) {
    if (e.message !== "Unauthorized") showToast(e.message, "error");
  }
};

document.getElementById("varian-cancel-edit")?.addEventListener("click", _resetVarianForm);

document.getElementById("form-add-varian")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const editId = document.getElementById("varian-edit-id")?.value;
  const kodeAlat = document.getElementById("new-varian-alat")?.value;
  const namaVarian = document.getElementById("new-varian-nama")?.value.trim();
  const merk = document.getElementById("new-varian-merk")?.value.trim();
  const tipe = document.getElementById("new-varian-tipe")?.value.trim();

  if (!kodeAlat) return showToast("Alat kerja wajib dipilih.", "warning");
  // Rows 1–2 of the Rekap template. Checked here as well as on the server so
  // the admin is told before the round trip.
  if (!merk) return showToast("Merk wajib diisi.", "warning");
  if (!tipe) return showToast("Model/Type wajib diisi.", "warning");
  if (!namaVarian) return showToast("Nama tampilan wajib diisi.", "warning");

  const body = { nama_varian: namaVarian };
  Object.entries(_VARIAN_FORM_FIELDS).forEach(([id, key]) => {
    body[key] = document.getElementById(id)?.value.trim() || null;
  });
  // Always send all ten slots, including nulls: update_alat_varian uses
  // `exclude_unset`, so an omitted slot is left alone and a cleared field
  // would silently keep its old value.
  _varianSpekInputs().forEach(([lab, val, kLab, kVal]) => {
    body[kLab] = lab?.value.trim() || null;
    body[kVal] = val?.value.trim() || null;
  });
  if (!editId) body.kode_alat = kodeAlat;

  try {
    const res = editId
      ? await apiFetch(`/master/varian/${editId}`, { method: "PUT", body: JSON.stringify(body) })
      : await apiFetch("/master/varian", { method: "POST", body: JSON.stringify(body) });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(payload.detail || "Gagal menyimpan Model/Type.", "error");
      return;
    }

    // Two-step create-then-attach, the same contract as calibration
    // certificates: the row exists first, then the files are posted against
    // its id. Upload failures are reported but do NOT discard the saved row.
    const id = editId || payload.id_varian;
    const uploaded = await _uploadVarianFiles(id);

    showToast(
      (editId ? "Model/Type diperbarui." : "Model/Type ditambahkan.") +
        (uploaded ? ` ${uploaded} berkas diunggah.` : ""),
      "success",
    );
    _resetVarianForm();
    await loadMasterVarian();
    await loadAlatVarian();
  } catch (err) {
    if (err.message !== "Unauthorized") showToast(err.message, "error");
  }
});

/** Post whichever of the three file inputs the admin filled. → count uploaded. */
async function _uploadVarianFiles(idVarian) {
  if (!idVarian) return 0;
  const jobs = [
    ["new-varian-foto-file", `/master/varian/${idVarian}/foto`, "Foto"],
    ["new-varian-spek-file", `/master/varian/${idVarian}/dokumen?jenis=spek`, "Spek Lengkap"],
    ["new-varian-manual-file", `/master/varian/${idVarian}/dokumen?jenis=manual`, "Manual"],
  ];
  let n = 0;
  for (const [inputId, endpoint, label] of jobs) {
    const file = document.getElementById(inputId)?.files?.[0];
    if (!file) continue;
    const fd = new FormData();
    fd.append("file", file);
    // apiFetch deliberately omits the JSON Content-Type for FormData — only
    // the browser knows the multipart boundary.
    const res = await apiFetch(endpoint, { method: "POST", body: fd });
    if (!res.ok) {
      const p = await res.json().catch(() => ({}));
      showToast(`${label}: ${p.detail || "gagal diunggah."}`, "error");
      continue;
    }
    n += 1;
  }
  return n;
}

// ══════════════════════════════════════════════════════════════════════════
// PUSAT DATA ▸ GUDANG
//
// The only master table with no UI whatsoever, and a hard blocker: with no
// warehouses, every stock movement was refused client-side before it reached
// the server.
// ══════════════════════════════════════════════════════════════════════════

let _masterGudangRows = [];

async function loadMasterGudang() {
  const tbody = document.getElementById("table-gudang");
  if (!tbody) return;
  // Skeleton rather than the blanking overlay — the table keeps its
  // shape and the page keeps its scroll position on a refresh.
  skeletonRows("table-gudang", 5);
  try {
    // include_inactive so a deactivated warehouse can be found and reactivated
    // rather than disappearing from the only screen that manages it.
    const res = await apiFetch("/inventaris/gudang?include_inactive=true", { background: true });
    if (!res.ok) throw new Error();
    _masterGudangRows = await res.json();
    renderMasterGudang();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state is-error">Gagal memuat data gudang.</td></tr>`;
  }
}

function renderMasterGudang() {
  const tbody = document.getElementById("table-gudang");
  if (!tbody) return;

  const rows = _masterGudangRows.filter((g) =>
    masterRowMatches([g.kode, g.nama, g.keterangan]),
  );
  setMasterSearchCount(rows.length, _masterGudangRows.length);

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">${
      _masterGudangRows.length
        ? "Tidak ada gudang yang cocok."
        : "Belum ada gudang. Tambahkan minimal satu sebelum mencatat pergerakan stok."
    }</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map(
      (g) => `
      <tr>
        <td><span class="font-mono font-bold text-kai-blue dark:text-blue-400">${g.kode}</span></td>
        <td class="font-semibold">${g.nama}</td>
        <td class="text-xs text-gray-500">${g.keterangan || "—"}</td>
        <td><span class="badge ${g.is_active ? "badge-so" : "badge-neutral"}">${g.is_active ? "Aktif" : "Nonaktif"}</span></td>
        <td class="text-right whitespace-nowrap">
          <button class="btn-icon" title="Ubah" onclick="window.editMasterGudang(${g.id_gudang})">
            <i class="fas fa-pen text-[11px]"></i></button>
          <button class="btn-icon btn-icon-danger" title="Hapus" onclick="window.deleteMasterGudang(${g.id_gudang})">
            <i class="fas fa-trash-alt text-[11px]"></i></button>
        </td>
      </tr>`,
    )
    .join("");
}

window.editMasterGudang = function (id) {
  const g = _masterGudangRows.find((x) => x.id_gudang === id);
  if (!g) return;
  document.getElementById("gudang-edit-id").value = id;
  document.getElementById("new-gudang-kode").value = g.kode || "";
  document.getElementById("new-gudang-nama").value = g.nama || "";
  document.getElementById("new-gudang-keterangan").value = g.keterangan || "";
  document.getElementById("gudang-submit-label").textContent = "Simpan Perubahan";
  document.getElementById("gudang-cancel-edit")?.classList.remove("hidden");
  document.getElementById("form-add-gudang")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
};

function _resetGudangMasterForm() {
  ["gudang-edit-id", "new-gudang-kode", "new-gudang-nama", "new-gudang-keterangan"]
    .forEach((id) => { const n = document.getElementById(id); if (n) n.value = ""; });
  const label = document.getElementById("gudang-submit-label");
  if (label) label.textContent = "Simpan Gudang";
  document.getElementById("gudang-cancel-edit")?.classList.add("hidden");
}

window.deleteMasterGudang = async function (id) {
  const g = _masterGudangRows.find((x) => x.id_gudang === id);
  if (!(await customConfirm(`Hapus gudang "${g?.nama || id}"?\n\nJika gudang masih memiliki riwayat stok, gudang hanya akan dinonaktifkan agar riwayat tidak menjadi yatim.`)))
    return;
  try {
    const res = await apiFetch(`/inventaris/gudang/${id}`, { method: "DELETE" });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(payload.detail || "Gagal menghapus gudang.", "error");
      return;
    }
    showToast(payload.message || "Gudang dihapus.", "success");
    await loadMasterGudang();
  } catch (e) {
    if (e.message !== "Unauthorized") showToast(e.message, "error");
  }
};

document.getElementById("gudang-cancel-edit")?.addEventListener("click", _resetGudangMasterForm);

document.getElementById("form-add-gudang")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const editId = document.getElementById("gudang-edit-id")?.value;
  const kode = document.getElementById("new-gudang-kode")?.value.trim().toUpperCase();
  const nama = document.getElementById("new-gudang-nama")?.value.trim();
  const keterangan = document.getElementById("new-gudang-keterangan")?.value.trim() || null;
  if (!kode || !nama)
    return showToast("Kode dan nama gudang wajib diisi.", "warning");

  try {
    const res = editId
      ? await apiFetch(`/inventaris/gudang/${editId}`, {
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
    showToast(editId ? "Gudang diperbarui." : "Gudang ditambahkan.", "success");
    _resetGudangMasterForm();
    await loadMasterGudang();
  } catch (err) {
    if (err.message !== "Unauthorized") showToast(err.message, "error");
  }
});

async function loadMasterUpt() {
  const tbody = document.getElementById("table-upt");
  if (!tbody) return;
  // Skeleton rather than the blanking overlay — the table keeps its
  // shape and the page keeps its scroll position on a refresh.
  skeletonRows("table-upt", 4);
  const lokasiSel = document.getElementById("new-upt-lokasi");
  if (lokasiSel && lokasiData.length) {
    lokasiSel.innerHTML = lokasiData
      .map((l) => `<option value="${l.code}">${l.name} (${l.code})</option>`)
      .join("");
  }

  try {
    const res = await apiFetch("/master/lokasi?tipe=upt", { background: true });
    _masterUptRows = await res.json();
    resetPage("master-upt");
    renderMasterUpt();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-red-400 text-sm">Gagal memuat data.</td></tr>`;
  }
}

// Cached so paging re-renders without re-fetching all 205 rows.
let _masterUptRows = [];

function renderMasterUpt() {
  const tbody = document.getElementById("table-upt");
  if (!tbody) return;

  // Region-aware search: "DAOP 1" lists JR1.x and excludes JR10.x, using the
  // same matcher the asset views use.
  const rows = _masterUptRows.filter((u) => {
    const parentCode = getParentLokasiCode(u.id_lokasi) || u.id_lokasi;
    return masterRowMatches([u.id_lokasi, u.nama_lokasi], {
      lokasiIdentity: {
        uptCode: u.id_lokasi,
        parentCode,
        uptName: u.nama_lokasi,
        parentName: lokasiData.find((l) => l.code === parentCode)?.name || parentCode,
      },
    });
  });
  setMasterSearchCount(rows.length, _masterUptRows.length);

  if (!rows.length) {
    renderPagerBar("master-upt-pager", paginateList("master-upt", rows), renderMasterUpt);
    tbody.innerHTML = `<tr><td colspan="4" class="empty-state">${
      _masterUptRows.length ? "Tidak ada UPT yang cocok." : "Belum ada data UPT."
    }</td></tr>`;
    return;
  }

  const page = paginateList("master-upt", rows);
  renderPagerBar("master-upt-pager", page, renderMasterUpt);

  {
    tbody.innerHTML = page.items
      .map((u) => {
        // Try regex-based derivation first, then fall back to lokasiData lookup via uptDatabase
        let parentCode = getParentLokasiCode(u.id_lokasi) || "";
        let parentName = "";
        if (parentCode) {
          const parentEntry = lokasiData.find((l) => l.code === parentCode);
          parentName = parentEntry ? parentEntry.name : parentCode;
        } else {
          // Fallback: check if uptDatabase already has this UPT mapped to a parent
          const uptEntry = uptDatabase.find((u2) => u2.upt === u.id_lokasi);
          if (uptEntry) {
            parentCode = uptEntry.lokasi || "—";
            const parentEntry = lokasiData.find((l) => l.code === parentCode);
            parentName = parentEntry ? parentEntry.name : parentCode;
          } else {
            parentCode = "—";
            parentName = "—";
          }
        }
        return `
                <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td class="px-4 py-3 text-gray-600 dark:text-gray-300 font-mono font-bold">${u.id_lokasi}</td>
                    <td class="px-4 py-3 font-semibold">${u.nama_lokasi}</td>
                    <td class="px-4 py-3 text-sm text-gray-600 dark:text-gray-300 font-mono font-medium">${parentName} <span class="text-gray-400">(${parentCode})</span></td>
                    <td class="px-4 py-3 text-right">
                        <button onclick="window.openMasterEdit('upt', '${u.id_lokasi}', '${u.nama_lokasi}', '${parentCode}')"
                            class="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-3 py-1 rounded-lg font-bold hover:bg-blue-200 transition">
                            <i class="fas fa-edit mr-1"></i> Edit
                        </button>
                    </td>
                </tr>`;
      })
      .join("");
  }
}

// NOTE: the real #btn-apply-sort handler lives further up (it builds
// _sortFilters as well). A second listener used to be registered here; both
// fired on every click, rendering twice and overwriting _sortField with the raw
// select value — blanking it whenever no criterion was chosen.

// ── ADD FORMS ─────────────────────────────────────────────────────

document
  .getElementById("form-add-user")
  ?.addEventListener("submit", async (e) => {
    e.preventDefault();

    const username = document.getElementById("new-user-username").value.trim();
    const password = document.getElementById("new-user-password")?.value || "";
    const role = document.getElementById("new-user-role").value;
    const region = document.getElementById("new-user-region").value;

    if (!username)
      return showToast("Nama pengguna tidak boleh kosong.", "warning");
    // Mirrors PASSWORD_MIN_LEN in main.py. Checked here too so the admin sees
    // the problem before the round trip, not because the server trusts this.
    if (password.length < 8)
      return showToast("Password minimal 8 karakter.", "warning");

    try {
      const res = await apiFetch("/users/create", {
        method: "POST",
        body: JSON.stringify({
          username,
          password,
          role,
          id_lokasi: region || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Gagal menambahkan pengguna.");
      }
      showToast(
        `Pengguna "${username}" dibuat. Sampaikan passwordnya sekarang — tidak dapat dilihat lagi.`,
        "success",
      );
      document.getElementById("form-add-user").reset();
      syncNewUserRegion();
      await loadMasterUsers();
    } catch (err) {
      if (err.message !== "Unauthorized") showToast(err.message, "error");
    }
  });

// Twelve characters from an unambiguous alphabet — no O/0, no l/1/I, because
// this string gets read aloud down a phone line to a resort.
const _PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generatePassword(length = 12) {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(
    bytes,
    (n) => _PASSWORD_ALPHABET[n % _PASSWORD_ALPHABET.length],
  ).join("");
}
window.generatePassword = generatePassword;

document.getElementById("btn-gen-password")?.addEventListener("click", () => {
  const el = document.getElementById("new-user-password");
  if (!el) return;
  el.value = generatePassword();
  el.focus();
  el.select();
});

// ── Reset password (SUPER_ADMIN) ──────────────────────────────────
// The only way out of the "akun belum memiliki password" state, which every
// seeded and pre-migration row starts in. The server re-checks the role.
let _resetPasswordTarget = null;

window.openResetPassword = function openResetPassword(idPengguna, username) {
  _resetPasswordTarget = idPengguna;
  const nameEl = document.getElementById("reset-password-username");
  if (nameEl) nameEl.textContent = username;
  const valEl = document.getElementById("reset-password-value");
  if (valEl) valEl.value = generatePassword();
  document.getElementById("reset-password-modal")?.classList.remove("hidden");
  // Focus is moved into the dialog by a11y-modal.js; select the value so the
  // admin can copy it immediately.
  setTimeout(() => valEl?.select(), 50);
};

function _closeResetPassword() {
  _resetPasswordTarget = null;
  document.getElementById("reset-password-modal")?.classList.add("hidden");
}

["close-reset-password-modal", "reset-password-cancel"].forEach((id) =>
  document.getElementById(id)?.addEventListener("click", _closeResetPassword),
);

document
  .getElementById("reset-password-gen")
  ?.addEventListener("click", () => {
    const el = document.getElementById("reset-password-value");
    if (!el) return;
    el.value = generatePassword();
    el.focus();
    el.select();
  });

document
  .getElementById("reset-password-submit")
  ?.addEventListener("click", async () => {
    if (_resetPasswordTarget == null) return;
    const password = document.getElementById("reset-password-value")?.value || "";
    if (password.length < 8)
      return showToast("Password minimal 8 karakter.", "warning");

    try {
      const res = await apiFetch(`/users/${_resetPasswordTarget}/password`, {
        method: "POST",
        body: JSON.stringify({ password_baru: password }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Gagal menyetel password.");
      }
      showToast(
        "Password diperbarui. Sampaikan sekarang — tidak dapat dilihat lagi.",
        "success",
      );
      _closeResetPassword();
      await loadMasterUsers();
    } catch (err) {
      if (err.message !== "Unauthorized") showToast(err.message, "error");
    }
  });

document
  .getElementById("form-add-alat")
  ?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const kode = document
      .getElementById("new-alat-kode")
      .value.trim()
      .toUpperCase();
    const nama = document.getElementById("new-alat-nama").value.trim();
    if (!kode || !nama)
      return showToast("Kode dan Nama wajib diisi.", "warning");

    try {
      const res = await apiFetch("/master/alat", {
        method: "POST",
        body: JSON.stringify({ kode_alat: kode, nama_alat: nama }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail);
      }
      showToast("Alat berhasil ditambahkan.", "success");
      e.target.reset();
      await loadMasterAlat();
      await fetchMasterData(); // refresh dropdowns
    } catch (err) {
      showToast(err.message, "error");
    }
  });

document
  .getElementById("form-add-lokasi")
  ?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const kode_lokasi = document
      .getElementById("new-lokasi-kode")
      .value.trim()
      .toUpperCase();
    const nama_lokasi = document.getElementById("new-lokasi-nama").value.trim();
    const tipe_lokasi = document.getElementById("new-lokasi-tipe").value;
    if (!kode_lokasi || !nama_lokasi)
      return showToast("Kode dan Nama wajib diisi.", "warning");

    try {
      const res = await apiFetch("/master/lokasi", {
        method: "POST",
        body: JSON.stringify({
          id_lokasi: kode_lokasi,
          nama_lokasi,
          tipe: tipe_lokasi,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail);
      }
      showToast("Lokasi berhasil ditambahkan.", "success");
      e.target.reset();
      await loadMasterLokasi();
      await fetchMasterData();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

document
  .getElementById("form-add-upt")
  ?.addEventListener("submit", async (e) => {
    e.preventDefault();
      const kode_upt = document.getElementById("new-upt-kode").value.trim().toUpperCase();
      const nama_upt = document.getElementById("new-upt-nama").value.trim();
      const kode_lokasi = document.getElementById("new-upt-lokasi").value;
      if (!kode_upt || !nama_upt || !kode_lokasi)
        return showToast("Kode UPT, Nama UPT, dan Lokasi wajib diisi.", "warning");

      try {
        const res = await apiFetch("/master/lokasi", {
          method: "POST",
          body: JSON.stringify({
            id_lokasi: kode_upt,
            nama_lokasi: nama_upt,
            tipe: "UPT",
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.detail || "Gagal menambahkan UPT.");
        }
        showToast("UPT berhasil ditambahkan.", "success");
        e.target.reset();
        await loadMasterUpt();
        await fetchMasterData();
      } catch (err) {
        showToast(err.message, "error");
      }
  });

// A Balaiyasa is a workshop and has no resorts under it, so picking one as the
// parent must block the form. This ran inside the SUBMIT handler above, where
// `e.target` is the <form> and `e.target.value` is undefined — so the guard
// resolved nothing and always took the "enable" branch. It belongs on the
// select's own change event.
document
  .getElementById("new-upt-lokasi")
  ?.addEventListener("change", (e) => {
    const loc = lokasiData.find((l) => l.code === e.target.value);
    // Type, not a name substring: a resort legitimately named "… BALAIYASA"
    // is not itself a Balaiyasa.
    const isBalaiyasa = (loc?.tipe || "").toUpperCase() === "BALAIYASA";
    const namaInput = document.getElementById("new-upt-nama");
    const submitBtn = document.querySelector(
      '#form-add-upt button[type="submit"]',
    );
    if (isBalaiyasa) {
      if (namaInput) {
        namaInput.disabled = true;
        namaInput.placeholder = "Tidak berlaku untuk Balaiyasa";
      }
      if (submitBtn) submitBtn.disabled = true;
      showToast("Lokasi Balaiyasa tidak memiliki UPT terkait.", "warning");
    } else {
      if (namaInput) {
        namaInput.disabled = false;
        namaInput.placeholder = "Nama UPT";
      }
      if (submitBtn) submitBtn.disabled = false;
    }
  });

// ── EDIT MODAL ────────────────────────────────────────────────────

let _masterEditCtx = null; // { type, id, ... }

window.openMasterEdit = (type, id, val1, val2, val3) => {
  _masterEditCtx = { type, id, val1, val2, val3 };
  const title = document.getElementById("master-edit-title");
  const fields = document.getElementById("master-edit-fields");
  const deactivateBtn = document.getElementById("btn-master-edit-delete");
  if (!deactivateBtn) return;

  // Reset deactivate button label
  deactivateBtn.innerHTML = '<i class="fas fa-ban mr-1"></i> Nonaktifkan';

  if (type === "users") {
    title.textContent = `Edit Pengguna: ${val1}`;
    deactivateBtn.innerHTML =
      '<i class="fas fa-user-slash mr-1"></i> Hapus User';
    fields.innerHTML = `
            <div>
                <label class="block text-xs font-semibold mb-1">Username</label>
                <input value="${val1}" disabled
                    class="w-full p-2 border rounded-md bg-gray-100 dark:bg-gray-600 dark:border-gray-500 text-gray-500 cursor-not-allowed">
            </div>
            <div>
                <label class="block text-xs font-semibold mb-1">Role</label>
                <select id="edit-field-role" class="w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600">
                    ${["TEKNISI", "ADMIN_WILAYAH", "SUPER_ADMIN"]
                      .map(
                        (r) =>
                          `<option value="${r}" ${val2 === r ? "selected" : ""}>${r}</option>`,
                      )
                      .join("")}
                </select>
            </div>
            <div>
                <label class="block text-xs font-semibold mb-1">Region</label>
                <select id="edit-field-region" class="w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600">
                    ${lokasiData
                      .map(
                        (l) =>
                          `<option value="${l.code}" ${val3 === l.code ? "selected" : ""}>${l.name} (${l.code})</option>`,
                      )
                      .join("")}
                </select>
            </div>
        `;

    // Wire role change to disable region — mirrors login page behaviour
    const roleEl = document.getElementById("edit-field-role");
    const regionEl = document.getElementById("edit-field-region");
    function syncRegionState() {
      const isSA = roleEl?.value === "SUPER_ADMIN";
      if (regionEl) {
        if (isSA) {
          regionEl.disabled = true;
          regionEl.innerHTML =
            '<option value="">Semua Region (tidak diperlukan)</option>';
        } else {
          regionEl.disabled = false;
          // Repopulate with lokasi options, keeping current selection or defaulting to first
          const currentVal =
            regionEl.dataset.currentVal || lokasiData[0]?.code || "";
          regionEl.innerHTML = lokasiData
            .map(
              (l) =>
                `<option value="${l.code}" ${l.code === currentVal ? "selected" : ""}>${l.name} (${l.code})</option>`,
            )
            .join("");
          if (!regionEl.value && lokasiData.length)
            regionEl.value = lokasiData[0].code;
        }
      }
    }
    // Store the original region value so repopulate can restore it
    if (regionEl) regionEl.dataset.currentVal = val3 || "";
    roleEl?.addEventListener("change", syncRegionState);
    syncRegionState(); // run on open

    // Hide delete button for SUPER_ADMIN users
    if (val2 === "SUPER_ADMIN") {
      deactivateBtn.classList.add("hidden");
    } else {
      deactivateBtn.classList.remove("hidden");
    }
  } else if (type === "alat") {
    title.textContent = `Edit Alat: ${id}`;
    fields.innerHTML = `
            <div>
                <label class="block text-xs font-semibold mb-1">Nama Alat</label>
                <input id="edit-field-nama" value="${val1}"
                    class="consolas-input w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600">
            </div>
        `;
  } else if (type === "lokasi") {
    title.textContent = `Edit Lokasi: ${id}`;
    fields.innerHTML = `
            <div>
                <label class="block text-xs font-semibold mb-1">Nama Lokasi</label>
                <input id="edit-field-nama" value="${val1}"
                    class="consolas-input w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600">
            </div>
            <div>
                <label class="block text-xs font-semibold mb-1">Tipe</label>
                <select id="edit-field-tipe" class="w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600">
                    ${["DAOP", "DIVRE", "PUSAT"]
                      .map(
                        (t) =>
                          `<option value="${t}" ${val2 === t ? "selected" : ""}>${t}</option>`,
                      )
                      .join("")}
                </select>
            </div>
        `;
  } else if (type === "upt") {
    // id=id_lokasi (e.g. "JR6.3"), val1=nama_lokasi, val2=parent code (e.g. "JR6"), val3=unused
    title.textContent = `Edit UPT: ${val1}`;
    fields.innerHTML = `
            <div>
                <label class="block text-xs font-semibold mb-1">Nama UPT</label>
                <input id="edit-field-nama" value="${val1}"
                    class="consolas-input w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600">
            </div>
            <div>
                <label class="block text-xs font-semibold mb-1">Induk Lokasi (DAOP/DIVRE/BALAIYASA)</label>
                <select id="edit-field-lokasi" class="w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600">
                    ${lokasiData
                      .map(
                        (l) =>
                          `<option value="${l.code}" ${val2 === l.code ? "selected" : ""}>${l.name}</option>`,
                      )
                      .join("")}
                </select>
            </div>
        `;
  }

  document.getElementById("master-edit-modal").classList.remove("hidden");
};

document.getElementById("close-master-edit")?.addEventListener("click", () => {
  document.getElementById("master-edit-modal").classList.add("hidden");
  _masterEditCtx = null;
});

document
  .getElementById("btn-master-edit-save")
  ?.addEventListener("click", async () => {
    if (!_masterEditCtx) return;
    const { type, id } = _masterEditCtx;

    try {
      let res;
      if (type === "users") {
        const role = document.getElementById("edit-field-role").value;
        const region = document.getElementById("edit-field-region").value;
        res = await apiFetch(`/users/${id}`, {
          method: "PUT",
          body: JSON.stringify({
            username: _masterEditCtx.val1,
            role,
            id_lokasi: region,
          }),
        });
      } else if (type === "alat") {
        const nama = document.getElementById("edit-field-nama").value.trim();
        res = await apiFetch(`/master/alat/${id}`, {
          method: "PUT",
          body: JSON.stringify({ kode_alat: id, nama_alat: nama }),
        });
      } else if (type === "lokasi") {
        const nama_lokasi = document
          .getElementById("edit-field-nama")
          .value.trim();
        const tipe_lokasi = document.getElementById("edit-field-tipe").value;
        res = await apiFetch(`/master/lokasi/${id}`, {
          method: "PUT",
          body: JSON.stringify({
            id_lokasi: id,
            nama_lokasi,
            tipe: tipe_lokasi,
          }),
        });
      } else if (type === "upt") {
        const parentLokasi =
          document.getElementById("edit-field-lokasi")?.value ||
          _masterEditCtx.val2 ||
          "";
        res = await apiFetch(`/master/lokasi/${id}`, {
          method: "PUT",
          body: JSON.stringify({
            id_lokasi: id,
            nama_lokasi:
              document.getElementById("edit-field-nama")?.value ||
              _masterEditCtx.val1,
            tipe: "UPT",
          }),
        });
      }

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail);
      }
      showToast("Data berhasil diperbarui.", "success");
      document.getElementById("master-edit-modal").classList.add("hidden");
      _masterEditCtx = null;

      if (type === "users") {
        await loadMasterUsers();
      }
      if (type === "alat") {
        await loadMasterAlat();
        await fetchMasterData();
      }
      if (type === "lokasi") {
        await loadMasterLokasi();
        await fetchMasterData();
      }
      if (type === "upt") {
        await loadMasterUpt();
        await fetchMasterData();
      }
    } catch (err) {
      showToast(err.message, "error");
    }
  });

document
  .getElementById("btn-master-edit-delete")
  ?.addEventListener("click", async () => {
    if (!_masterEditCtx) return;
    const { type, id, val1 } = _masterEditCtx;

    const confirmed = await customConfirm(
      type === "users"
        ? `Hapus akun "${val1}" secara permanen? Tindakan ini tidak dapat dibatalkan.`
        : `Nonaktifkan "${val1}"?\n\nData yang sudah menggunakan referensi ini tidak akan terpengaruh, tapi tidak bisa dipilih untuk entri baru.`,
    );
    if (!confirmed) return;

    try {
      let res;
      if (type === "users")
        res = await apiFetch(`/users/${id}`, { method: "DELETE" });
      if (type === "alat")
        res = await apiFetch(`/master/alat/${id}`, { method: "DELETE" });
      if (type === "lokasi")
        res = await apiFetch(`/master/lokasi/${id}`, { method: "DELETE" });
      if (type === "upt")
        res = await apiFetch(`/master/lokasi/${id}`, { method: "DELETE" });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail);
      }
      showToast("Data berhasil dinonaktifkan.", "success");
      document.getElementById("master-edit-modal").classList.add("hidden");
      _masterEditCtx = null;

      if (type === "users") {
        await loadMasterUsers();
      }
      if (type === "alat") {
        await loadMasterAlat();
        await fetchMasterData();
      }
      if (type === "lokasi") {
        await loadMasterLokasi();
        await fetchMasterData();
      }
      if (type === "upt") {
        await loadMasterUpt();
        await fetchMasterData();
      }
    } catch (err) {
      showToast(err.message, "error");
    }
  });
