// ═══════════════════════════════════════════════════════════════════════
// Every call to the backend: apiFetch (bearer token, loading overlay,
// 401 handling), the master-data bootstrap, and the asset list refresh.
//
// Part of the RAMCES frontend. These files are plain classic scripts
// loaded in a fixed order by index.html - no bundler, no modules. They
// share one global scope, so a top-level `let` or `const` declared twice
// across two files is a fatal SyntaxError; see CLAUDE.md.
// ═══════════════════════════════════════════════════════════════════════

async function fetchMasterData() {
  beginLoading("Memuat data master (alat kerja & lokasi)");
  try {
    const [alatRes, lokasiRes] = await Promise.all([
      fetch(`${API_BASE_URL}/master/alat`),
      fetch(`${API_BASE_URL}/master/lokasi`),
    ]);

    if (alatRes.ok) {
      alatKerjaData = (await alatRes.json()).map((a) => ({
        name: a.nama_alat,
        code: a.kode_alat,
      }));
    }

    if (lokasiRes.ok) {
      const allLokasi = await lokasiRes.json();

      // Regions: DAOP, DIVRE, PUSAT, BALAIYASA — top-level parent locations
      lokasiData = allLokasi
        .filter((l) => {
          const t = (l.tipe || "").toUpperCase();
          return (
            t === "DAOP" || t === "DIVRE" || t === "PUSAT" || t === "BALAIYASA"
          );
        })
        .map((l) => ({ name: l.nama_lokasi, code: l.id_lokasi, tipe: l.tipe }));

      // UPTs: everything else (JR*, or explicit tipe=UPT)
      const uptRaw = allLokasi.filter((l) => {
        const t = (l.tipe || "").toUpperCase();
        return (
          t !== "DAOP" && t !== "DIVRE" && t !== "PUSAT" && t !== "BALAIYASA"
        );
      });

      uptDatabase = uptRaw.map((u) => ({
        upt: u.id_lokasi,
        nama: u.nama_lokasi,
        lokasi: getParentLokasiCode(u.id_lokasi) || u.id_lokasi,
      }));

      // If no UPTs found, treat all regions as their own UPTs (flat fallback)
      if (!uptDatabase.length) {
        uptDatabase = lokasiData.map((l) => ({
          upt: l.code,
          nama: l.name,
          lokasi: l.code,
        }));
      }

      rebuildLokasiIndexes();
    }

    populateSelects(true); // Preserve user selections after async load
  } catch (e) {
    showToast(
      "Gagal memuat data master. Beberapa dropdown mungkin kosong.",
      "warning",
    );
  } finally {
    endLoading();
  }
}

// NOTE: fetchLoginRegions() used to live here, filling a region <select> on the
// login screen. Both it and the selector are gone: a user's region is a property
// of their account, read from the stored row by the server, not something chosen
// at sign-in. Choosing it (alongside choosing a role) was the escalation hole.
// The login screen now makes one unauthenticated call — none — and the region
// list is fetched after login by fetchMasterData().

// --- FETCH API WRAPPER ---
// opts.background — skip the loading overlay (used by the polling fallback, so
// a periodic refresh doesn't blank the screen while the user is working).
async function apiFetch(endpoint, options = {}) {
  if (!authToken) throw new Error("Token tidak tersedia");

  const headers = {
    Authorization: `Bearer ${authToken}`,
    ...options.headers,
  };

  if (
    options.body !== undefined &&
    options.body !== null &&
    !(options.body instanceof URLSearchParams) &&
    !(options.body instanceof FormData)
  ) {
    headers["Content-Type"] = "application/json";
  }

  const { background, ...fetchOptions } = options;
  if (!background) beginLoading();
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...fetchOptions,
      headers,
    });
  } finally {
    if (!background) endLoading();
  }

  if (response.status === 401) {
    showToast("Sesi Anda telah habis. Silakan login kembali.", "warning");
    forceLogout(false);
    throw new Error("Unauthorized");
  }

  return response;
}

// --- KOMUNIKASI DATABASE ---
// opts.silent — suppress the failure toast (used by the background poller so a
// transient network blip doesn't spam the user).
// How many rows to pull per request. Matches DEFAULT_PAGE in main.py.
const ASET_PAGE_SIZE = 1000;

// Normalise one server row into the shape every view reads.
function _decorateAset(a) {
  // Defensive: ensure id_lokasi_raw is actually a code, not a name
  // A code is typically short (like "D1", "JR1.1"), a name is longer ("DAOP 1 Jakarta")
  const rawLokasi = a.id_lokasi || "";
  const isProbablyCode = rawLokasi.length <= 10 && !rawLokasi.includes(" ");

  return {
    ...a,
    id_lokasi_raw: isProbablyCode
      ? rawLokasi
      : lokasiData.find((l) => l.name === rawLokasi)?.code ||
        uptDatabase.find((u) => u.nama === rawLokasi)?.upt ||
        rawLokasi,

    // Perbaikan: tangkap "lokasi_name" dari backend
    id_lokasi_display: a.lokasi_name || a.id_lokasi_name || rawLokasi,
    kode_alat_name: a.kode_alat_name || a.kode_alat,
  };
}

/**
 * Fetch every page of an endpoint that returns {total, limit, offset, items}.
 *
 * The alternative — one unbounded request — was ~4.5 MB for /api/aset and
 * ~16 MB for /api/history/summary at 10k assets, on every login AND after every
 * mutation, with nothing on screen until the last byte arrived.
 *
 * `onProgress` reports (loaded, total) so the overlay can count up instead of
 * showing an indeterminate spinner for several seconds.
 *
 * A hard page cap stops a server that ignores `offset` from looping forever.
 */
async function fetchAllPages(endpoint, { background, onProgress } = {}) {
  const items = [];
  let offset = 0;
  let total = null;
  const sep = endpoint.includes("?") ? "&" : "?";

  for (let page = 0; page < 200; page++) {
    const res = await apiFetch(
      `${endpoint}${sep}limit=${ASET_PAGE_SIZE}&offset=${offset}`,
      { background: !!background },
    );
    if (!res.ok) throw new Error(`Gagal mengambil data (${res.status})`);
    const body = await res.json();

    // Envelope expected; tolerate a bare array so an older/proxied response
    // cannot produce a silently empty list.
    const batch = Array.isArray(body) ? body : body.items || [];
    total = Array.isArray(body) ? batch.length : (body.total ?? batch.length);
    items.push(...batch);
    onProgress?.(items.length, total);

    if (Array.isArray(body) || batch.length < ASET_PAGE_SIZE) break;
    offset += batch.length;
    if (items.length >= total) break;
  }
  return items;
}
window.fetchAllPages = fetchAllPages;

async function fetchAsetFromServer(opts = {}) {
  try {
    const rows = await fetchAllPages("/aset", {
      background: !!opts.silent,
      onProgress: (loaded, total) => {
        if (!opts.silent && total > ASET_PAGE_SIZE)
          setLoadingMessage(
            `Memuat aset ${loaded.toLocaleString("id-ID")} / ${total.toLocaleString("id-ID")}`,
          );
      },
    });

    // Replaced wholesale, not mutated: rebuildSummaryIndex() and the Map
    // indexes in js/search.js key off the array identity being swapped.
    db = rows.map(_decorateAset);

    const isVisible = (id) =>
      !!document.getElementById(id)?.classList.contains("is-visible");

    updateDashboardStats();
    updateKdakStats();
    if (isVisible("view-input")) {
      renderKdakTable();
    }
    // Always refresh summary so badges are up to date everywhere
    loadHistorySummary().then(() => {
      if (isVisible("view-database")) {
        renderDbCards();
      }
      if (isVisible("view-history")) {
        if (_historyMode === "repair") renderHistoryCards();
        else if (_historyMode === "mutasi") renderMutasiCards();
        else if (_historyMode === "kalibrasi") renderKalibrasiCards();
      }
    });

    if (activeHistoryUid && isVisible("view-history-detail")) {
      window.openHistoryDetail(activeHistoryUid);
    }
  } catch (error) {
    if (!opts.silent) {
      showToast(
        "Koneksi ke server gagal! Mencoba menghubungkan kembali...",
        "error",
      );
    }
  }
}
