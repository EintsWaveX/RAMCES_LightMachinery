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

/**
 * ONE page of /api/aset, with the filters and sort applied by the SERVER.
 *
 * `params` is a URLSearchParams the caller has already filled from its own
 * filter state. The response envelope carries `ringkas` — SO/TSO over the whole
 * filtered set, not the page — because the KPI tiles above the cards answer
 * "how much matches", which paging must not change.
 *
 * Every row is written into the by-id cache on the way past, so a modal opened
 * from this page can still find its asset after the page has moved on.
 */
async function fetchAsetPage(params, { background = true } = {}) {
  const res = await apiFetch(`/aset?${params}`, { background });
  if (!res.ok) throw new Error(`Gagal mengambil data aset (${res.status})`);
  const body = await res.json();
  const items = (body.items || []).map(_decorateAset);
  cacheAset(items);
  return {
    items,
    total: body.total ?? items.length,
    ringkas: body.ringkas || { so: 0, tso: 0 },
  };
}
window.fetchAsetPage = fetchAsetPage;

// ── The whole fleet, fetched ONLY when something genuinely needs every row ──
//
// Three things do, and no amount of server paging changes that: the Excel/PDF
// export writes one line per asset, the Kelola Data Alat Kerja grouping modals
// roll the fleet up by alat and by lokasi, and Proses Laporan joins every
// export row back to its asset.
//
// The difference from rev0.4.4 is WHEN. This used to run at login, for every
// user, whether or not they ever opened any of those — 1.06 MB and 460 ms
// before the dashboard appeared. Now it runs when one of them is actually
// asked for, and the result is cached until a mutation invalidates it.
let _fleetCache = null;
let _fleetPromise = null;

async function ensureFleet(opts = {}) {
  if (_fleetCache) return _fleetCache;
  // Concurrent callers share one request rather than starting a second walk.
  if (_fleetPromise) return _fleetPromise;

  _fleetPromise = (async () => {
    const rows = await fetchAllPages("/aset", {
      background: !!opts.silent,
      onProgress: (loaded, total) => {
        if (!opts.silent && total > ASET_PAGE_SIZE)
          setLoadingMessage(
            `Memuat aset ${loaded.toLocaleString("id-ID")} / ${total.toLocaleString("id-ID")}`,
          );
      },
    });
    _fleetCache = rows.map(_decorateAset);
    cacheAset(_fleetCache);
    return _fleetCache;
  })();

  try {
    return await _fleetPromise;
  } finally {
    _fleetPromise = null;
  }
}

/** Drop the cached fleet. Called by every REFRESH_ASSET_LIST broadcast. */
function invalidateFleet() {
  _fleetCache = null;
}

/**
 * The fleet IF it has already been fetched, otherwise null — never a fetch.
 *
 * The KDAK id preview needs max(urutan) over every asset sharing a kode_alat,
 * and would rather print a placeholder than trigger a megabyte download while
 * someone is typing into a form.
 */
function fleetIfLoaded() {
  return _fleetCache;
}
window.fleetIfLoaded = fleetIfLoaded;

window.ensureFleet = ensureFleet;
window.invalidateFleet = invalidateFleet;

/**
 * "The asset data changed — show the new state."
 *
 * Called from every mutation handler and from the WebSocket refresh. It used to
 * re-download the fleet into `db`; it now invalidates the caches and re-renders
 * whichever view is actually on screen, each of which fetches its own page.
 */
async function fetchAsetFromServer(opts = {}) {
  try {
    invalidateFleet();
    invalidateRingkasan();

    const isVisible = (id) =>
      !!document.getElementById(id)?.classList.contains("is-visible");

    await updateDashboardStats();
    await updateKdakStats();
    if (isVisible("view-input")) await renderKdakTable();
    if (isVisible("view-database")) await renderDbCards();
    if (isVisible("view-history")) {
      if (_historyMode === "repair") await renderHistoryCards();
      else if (_historyMode === "mutasi") await renderMutasiCards();
      else if (_historyMode === "kalibrasi") await renderKalibrasiCards();
    }

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
