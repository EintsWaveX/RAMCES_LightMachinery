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

async function fetchLoginRegions() {
  beginLoading();
  try {
    const res = await fetch("/api/master/lokasi");
    if (!res.ok) return;
    const data = await res.json();
    const sel = document.getElementById("login-region");
    if (!sel) return;
    // Only show parent-level locations; exclude UPTs (JR* codes)
    const parentTypes = ["DAOP", "DIVRE", "PUSAT", "BALAIYASA"];
    const parents = data.filter((l) =>
      parentTypes.includes((l.tipe || "").toUpperCase()),
    );
    sel.innerHTML = parents
      .map((l) => `<option value="${l.id_lokasi}">${l.nama_lokasi}</option>`)
      .join("");
  } catch (e) {
    // master data not seeded yet
  } finally {
    endLoading();
  }
}

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
async function fetchAsetFromServer(opts = {}) {
  try {
    const response = await apiFetch("/aset", { background: !!opts.silent });
    if (!response.ok) throw new Error("Gagal mengambil data aset");

    db = (await response.json()).map((a) => {
      // Defensive: ensure id_lokasi_raw is actually a code, not a name
      // A code is typically short (like "D1", "JR1.1"), a name is longer ("DAOP 1 Jakarta")
      const rawLokasi = a.id_lokasi || "";
      const isProbablyCode = rawLokasi.length <= 10 && !rawLokasi.includes(" ");

      // Cari blok ini di dalam fetchAsetFromServer() dan ganti menjadi:
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
    });

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
