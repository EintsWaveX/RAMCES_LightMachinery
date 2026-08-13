// ═══════════════════════════════════════════════════════════════════════
// Application shell: authentication, view switching, the global event
// wiring, and the WebSocket / presence / polling-fallback channel.
//
// Part of the RAMCES frontend. These files are plain classic scripts
// loaded in a fixed order by index.html - no bundler, no modules. They
// share one global scope, so a top-level `let` or `const` declared twice
// across two files is a fatal SyntaxError; see CLAUDE.md.
// ═══════════════════════════════════════════════════════════════════════

// --- LOGIKA AUTENTIKASI ---
async function checkAuth() {
  if (currentUser && authToken) {
    const payload = getJwtPayload(authToken);
    const role = payload ? payload.role : "TEKNISI";

    _currentRole = role;

    const filterModeEl = document.getElementById("filter-mode");
    if (filterModeEl)
      filterModeEl.style.display = role === "TEKNISI" ? "none" : "";

    document.getElementById("auth-view").classList.add("hidden");
    const mainApp = document.getElementById("main-app");
    if (mainApp) {
      mainApp.style.display = "flex";
      mainApp.classList.remove("hidden");
    }

    const topbarUsername = document.getElementById("topbar-username");
    const topbarRole = document.getElementById("topbar-role");
    if (topbarUsername) topbarUsername.innerText = currentUser;
    if (topbarRole) topbarRole.innerText = role.replace("_", " ");

    if (role === "SUPER_ADMIN") {
      const navMaster = document.getElementById("nav-masterdata");
      const navAfkir = document.getElementById("nav-afkir");
      const adminHelper = document.getElementById("admin-helper");
      if (navMaster) navMaster.classList.remove("hidden");
      if (navAfkir) navAfkir.classList.remove("hidden");
      if (adminHelper) adminHelper.classList.remove("hidden");
    }
    if (role === "TEKNISI") {
      const navInput = document.getElementById("nav-input");
      if (navInput) navInput.classList.add("hidden");
    }

    const welcomeMsg = document.getElementById("dashboard-welcome");
    if (welcomeMsg) welcomeMsg.innerText = `Selamat Datang, ${currentUser}`;

    switchView("dashboard");

    toggleSidebar();
    setupProfileModal();
    startTopbarClock();

    await fetchMasterData();
    setupWebSocket();
    await fetchAsetFromServer();
  } else {
    const mainAppEl = document.getElementById("main-app");
    if (mainAppEl) {
      mainAppEl.style.display = "none";
      mainAppEl.classList.add("hidden");
    }
  }
}

async function handleLogin() {
  const user = document.getElementById("login-username").value.trim();
  const role = document.getElementById("login-role")?.value || "TEKNISI";
  const region = document.getElementById("login-region")?.value || "";
  const regionText =
    document.getElementById("login-region")?.selectedOptions[0]?.text || region;
  const roleText =
    document.getElementById("auth-display-role")?.textContent || role;

  if (!user) {
    showToast("Username tidak boleh kosong!", "warning");
    return;
  }

  const confirmed = await customConfirm(
    `Masuk sebagai "${user}"?\nRole: ${roleText}\nRegion: ${regionText}`,
  );
  if (!confirmed) return;

  beginLoading("Memverifikasi akun");
  try {
    const response = await fetch(`${API_BASE_URL}/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
      },
      body: JSON.stringify({
        username: user,
        role: role,
        id_lokasi: region || null,
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.detail || "Login gagal.");
    }

    const data = await response.json();
    currentUser = user;
    authToken = data.access_token;
    sessionStorage.setItem("activeUser", user);
    sessionStorage.setItem("authToken", authToken);

    showToast(
      data.already_existed
        ? `Berhasil masuk sebagai ${user}!`
        : `Berhasil membuat akun dan masuk sebagai "${user}"!`,
      "success",
    );
    document.getElementById("login-username").value = "";
    document.getElementById("auth-step-1")?.classList.remove("hidden");
    document.getElementById("auth-step-2")?.classList.add("hidden");
    document.getElementById("auth-step-3")?.classList.add("hidden");
    if (document.getElementById("login-role"))
      document.getElementById("login-role").value = "";

    await checkAuth();
    fetchAsetFromServer();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    endLoading();
  }
}

function forceLogout(reloadPage = false) {
  currentUser = null;
  authToken = null;
  sessionStorage.removeItem("activeUser");
  sessionStorage.removeItem("authToken");
  resetLoading();
  stopPollingFallback();
  if (window._wsReconnectTimer) clearTimeout(window._wsReconnectTimer);
  if (window._wsHeartbeat) clearInterval(window._wsHeartbeat);
  try {
    window._ws?.close();
  } catch (_) {}

  if (reloadPage) {
    window.location.href = window.location.pathname;
    return;
  }

  const mainApp2 = document.getElementById("main-app");
  if (mainApp2) {
    mainApp2.style.display = "none";
    mainApp2.classList.add("hidden");
  }

  const authView = document.getElementById("auth-view");
  authView.classList.remove("hidden");

  const u = document.getElementById("login-username");
  if (u) u.value = "";

  document.getElementById("auth-step-1")?.classList.remove("hidden");
  document.getElementById("auth-step-2")?.classList.add("hidden");
  document.getElementById("auth-step-3")?.classList.add("hidden");
  document.getElementById("login-role") &&
    (document.getElementById("login-role").value = "");

  activeHistoryUid = null;

  if (window._wsHeartbeat) clearInterval(window._wsHeartbeat);
  if (window._ws && window._ws.readyState === WebSocket.OPEN) {
    window._ws.close();
  }
  window._ws = null;
}

// NOTE: an unreferenced afkirAset() used to live here, duplicating
// window.deleteAset() with a weaker single confirmation. deleteAset is the one
// the card trash icon calls.

// --- UI UTILITIES & EVENT LISTENERS ---
function populateSelects(preserveValues = false) {
  const alatHTML = alatKerjaData
    .map((d) => `<option value="${d.code}">${d.name}</option>`)
    .join("");
  const lokasiHTML = lokasiData
    .map((d) => `<option value="${d.code}">${d.name}</option>`)
    .join("");

  const inAlat = document.getElementById("in-alat");
  const inLokasi = document.getElementById("in-lokasi");
  const inUpt = document.getElementById("in-upt");
  const editLokasi = document.getElementById("edit-lokasi");
  const editUpt = document.getElementById("edit-upt");

  // Helper to repopulate while preserving selected value if valid
  function repopulateSelect(selectEl, newHTML, defaultOptionHTML, preserve) {
    if (!selectEl) return;
    const oldValue = selectEl.value;
    selectEl.innerHTML = defaultOptionHTML + newHTML;
    if (
      preserve &&
      oldValue &&
      selectEl.querySelector(`option[value="${oldValue}"]`)
    ) {
      selectEl.value = oldValue;
    }
  }

  if (inAlat) repopulateSelect(inAlat, alatHTML, `<option value="">— Pilih Alat Kerja —</option>`, preserveValues);

  // Lokasi: regions only, blank default
  if (inLokasi)
    repopulateSelect(
      inLokasi,
      lokasiHTML,
      `<option value="">— Pilih Lokasi/Wilayah —</option>`,
      preserveValues,
    );

  // UPT: locked until lokasi chosen — only reset if not preserving or no valid value
  if (inUpt) {
    const currentUpt = inUpt.value;
    const currentLokasi = inLokasi?.value;
    const hasValidUpt = preserveValues && currentUpt && currentLokasi;

    if (!hasValidUpt) {
      inUpt.innerHTML = `<option value="">— Pilih Lokasi terlebih dahulu —</option>`;
      inUpt.disabled = true;
    } else {
      // Re-apply UPT options for current lokasi
      applyUptSelect(currentLokasi, inUpt);
      if (inUpt.querySelector(`option[value="${currentUpt}"]`)) {
        inUpt.value = currentUpt;
      }
    }
  }

  // Edit form (Kondisi Perbaikan)
  if (editLokasi)
    repopulateSelect(
      editLokasi,
      lokasiHTML,
      `<option value="" disabled selected>Pilih Lokasi</option>`,
      preserveValues,
    );
  if (editUpt) {
    const currentEditUpt = editUpt.value;
    const currentEditLokasi = editLokasi?.value;
    const hasValidEditUpt =
      preserveValues && currentEditUpt && currentEditLokasi;

    if (!hasValidEditUpt) {
      editUpt.innerHTML = `<option value="" disabled selected>Pilih UPT</option>`;
      editUpt.disabled = true;
    } else {
      applyUptSelect(currentEditLokasi, editUpt);
      if (editUpt.querySelector(`option[value="${currentEditUpt}"]`)) {
        editUpt.value = currentEditUpt;
      }
    }
  }

  // Kalibrasi form
  const kalibLokasi = document.getElementById("kalib-lokasi");
  const kalibUpt = document.getElementById("kalib-upt");
  if (kalibLokasi)
    repopulateSelect(
      kalibLokasi,
      lokasiHTML,
      `<option value="" disabled selected>Pilih Lokasi</option>`,
      preserveValues,
    );
  if (kalibUpt) {
    const currentKalibUpt = kalibUpt.value;
    const currentKalibLokasi = kalibLokasi?.value;
    const hasValidKalibUpt =
      preserveValues && currentKalibUpt && currentKalibLokasi;

    if (!hasValidKalibUpt) {
      kalibUpt.innerHTML = `<option value="" disabled selected>Pilih UPT</option>`;
      kalibUpt.disabled = true;
    } else {
      applyUptSelect(currentKalibLokasi, kalibUpt);
      if (kalibUpt.querySelector(`option[value="${currentKalibUpt}"]`)) {
        kalibUpt.value = currentKalibUpt;
      }
    }
  }
}

function switchView(viewId) {
  document.querySelectorAll(".view-section").forEach((el) => {
    el.classList.remove("is-visible", "is-flex");
  });

  const targetView = document.getElementById(`view-${viewId}`);
  if (targetView) {
    targetView.classList.add("is-visible");
  }

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    if (btn.dataset.view === viewId) btn.classList.add("is-active");
    else btn.classList.remove("is-active");
  });

  const pageMeta = {
    dashboard: {
      title: "Dashboard",
      subtitle: "Pantau Kesiapan dan Kondisi Aset Alat Kerja",
    },
    input: {
      title: "Kelola Aset Alat Kerja",
      subtitle: "Pantau, Registrasi, dan Kelola Inventaris Aset Alat Kerja",
    },
    inventaris: {
      title: "Kelola Inventaris",
      subtitle: "Kelola Suku Cadang dan Riwayat Transfer Inventaris",
    },
    database: {
      title: "Kelola Data Aset",
      subtitle: "Daftar Seluruh Aset Alat Kerja yang Terdaftar",
    },
    history: {
      title: "Pantau Riwayat Aset",
      subtitle: "Riwayat Perbaikan dan Mutasi Aset",
    },
    "history-detail": {
      title: "Detail Riwayat Aset",
      subtitle: "Rincian Riwayat Perbaikan dan Mutasi Aset",
    },
    edit: {
      title: "Pembaruan Kondisi",
      subtitle: "Perbarui Status Kondisi Aset Alat Kerja",
    },
    laporan: {
      title: "Proses Laporan",
      subtitle: "Filter dan Ekspor Data Aset ke Excel atau PDF",
    },
    masterdata: {
      title: "Pusat Data",
      subtitle: "Kelola Data Master Sistem (SUPER ADMIN)",
    },
    afkir: {
      title: "Pulihkan Aset Afkir",
      subtitle: "Lihat dan Pulihkan Aset yang Telah di-Afkir",
    },
  };
  const meta = pageMeta[viewId];
  if (meta) {
    const t = document.getElementById("topbar-page-title");
    const s = document.getElementById("topbar-page-subtitle");
    if (t) t.textContent = meta.title;
    if (s) s.textContent = meta.subtitle;
  }

  const breadcrumb = document.getElementById("breadcrumb-label");
  if (breadcrumb && meta) breadcrumb.textContent = meta.title;

  if (viewId === "database" || viewId === "history" || viewId === "afkir") {
    const tv = document.getElementById(`view-${viewId}`);
    if (tv) tv.classList.add("is-flex");
  }
  if (viewId === "database" || viewId === "history") {
    // This already calls loadHistorySummary() and re-renders whichever view is
    // visible, so History must not fetch the summary a second time — it used to
    // request /history/summary twice on every visit.
    fetchAsetFromServer();
  }
  if (viewId === "input") {
    // KDAK used to render ONLY from inside fetchAsetFromServer(), and only when
    // this view already happened to be visible — so arriving here from any other
    // view showed an empty table until some unrelated refresh fired. The data is
    // already cached in `db`, so render it directly.
    updateKdakStats();
    renderKdakTable();
  }
  if (viewId === "laporan") {
    initLaporanView();
  }
  if (viewId === "masterdata") {
    loadMasterCounts();
    setTimeout(() => {
      document.querySelector('.master-tab[data-tab="users"]')?.click();
    }, 50);
  }
  if (viewId === "afkir") {
    loadAfkirCards();
  }
  if (viewId === "inventaris") {
    // Boots the lokasi/tahun dropdowns and loads the dashboard. Deferred to
    // here because it needs an auth token, which does not exist at script-eval.
    window.initInvView?.();
  }

  // Let other sessions see where this user is working.
  reportCurrentView(viewId);
}

function setupEventListeners() {
  // Navigasi Sidebar
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  // Auth — multi-step login
  document.getElementById("btn-next-step")?.addEventListener("click", () => {
    const username = document.getElementById("login-username").value.trim();
    if (!username) {
      showToast("Username tidak boleh kosong!", "warning");
      return;
    }
    document.getElementById("auth-display-username").innerText = username;
    document.getElementById("auth-step-1").classList.add("hidden");
    document.getElementById("auth-step-2").classList.remove("hidden");
  });

  document
    .getElementById("login-username")
    ?.addEventListener("keypress", (e) => {
      if (e.key === "Enter") document.getElementById("btn-next-step")?.click();
    });

  document.getElementById("btn-back-step1")?.addEventListener("click", () => {
    document.getElementById("auth-step-2").classList.add("hidden");
    document.getElementById("auth-step-1").classList.remove("hidden");
  });

  document.getElementById("btn-back-step2")?.addEventListener("click", () => {
    document.getElementById("auth-step-3").classList.add("hidden");
    document.getElementById("auth-step-2").classList.remove("hidden");
  });

  document.querySelectorAll(".division-card").forEach((card) => {
    card.addEventListener("click", () => {
      const division = card.dataset.division;
      const labels = {
        TEKNISI: "Teknisi (TraKSI)",
        ADMIN_WILAYAH: "Admin Wilayah",
        SUPER_ADMIN: "Super Admin (RAMCES)",
      };

      // Normalize legacy values to the backend role contract.
      const roleVal = division === "ADMIN_DAOP" ? "ADMIN_WILAYAH" : division;

      document.getElementById("login-role").value = roleVal;
      document.getElementById("auth-display-role").innerText =
        labels[roleVal] || labels[division] || division;

      const regionSel = document.getElementById("login-region");
      if (roleVal === "SUPER_ADMIN") {
        regionSel.disabled = true;
        regionSel.innerHTML =
          '<option value="">Semua Region (tidak diperlukan)</option>';
      } else {
        regionSel.disabled = false;
        fetchLoginRegions();
      }

      document.getElementById("auth-step-2").classList.add("hidden");
      document.getElementById("auth-step-3").classList.remove("hidden");
    });
  });

  document.getElementById("btn-login")?.addEventListener("click", handleLogin);
  document.getElementById("login-region")?.addEventListener("keypress", (e) => {
    if (e.key === "Enter") handleLogin();
  });

  // Sidebar & Theme
  document
    .getElementById("mobile-menu-btn")
    ?.addEventListener("click", toggleSidebar);
  document
    .getElementById("sidebar-toggle-btn")
    ?.addEventListener("click", toggleSidebar);
  document
    .getElementById("sidebar-overlay")
    ?.addEventListener("click", toggleSidebar);
  document.getElementById("theme-toggle-btn")?.addEventListener("click", () => {
    const html = document.documentElement;
    html.classList.toggle("dark");
    const isDark = html.classList.contains("dark");
    localStorage.setItem("theme", isDark ? "dark" : "light");
    // Charts bake their palette in at construction time, so anything currently
    // drawn has to be told to re-render against the new surface.
    window.dispatchEvent(
      new CustomEvent("kai-theme-change", { detail: { dark: isDark } }),
    );
  });

  // Profile modal
  document
    .getElementById("profile-btn")
    ?.addEventListener("click", openProfileModal);
  document
    .getElementById("close-profile-modal")
    ?.addEventListener("click", closeProfileModal);
  document.getElementById("profile-modal")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("profile-modal"))
      closeProfileModal();
  });
  document
    .getElementById("profile-logout-btn")
    ?.addEventListener("click", () => {
      closeProfileModal();
      forceLogout(true);
    });
  document
    .getElementById("profile-delete-btn")
    ?.addEventListener("click", async () => {
      closeProfileModal();
      const confirmed = await customConfirm(
        `Apakah Anda yakin ingin menghapus akun "${currentUser}"?\nTindakan ini tidak dapat dibatalkan.`,
      );
      if (!confirmed) return;
      const reconfirmed = await customConfirm(
        `Konfirmasi terakhir: akun "${currentUser}" akan dihapus permanen dari sistem.`,
      );
      if (!reconfirmed) return;
      try {
        const response = await apiFetch("/users/me", { method: "DELETE" });
        if (!response.ok) throw new Error("Gagal menghapus akun.");
        showToast("Akun berhasil dihapus.", "success");
        setTimeout(() => forceLogout(true), 1500);
      } catch (error) {
        showToast(error.message, "error");
      }
    });

  // Search & Filter.
  // Every one of these changes the SIZE of the result set, so the current page
  // number stops meaning anything — reset to page 1 before re-rendering, or a
  // search from page 7 lands the user on an empty page.
  //
  // Debounced: each keystroke re-filters, re-sorts and re-renders the whole
  // list, and at typing speed all but the last of those renders is thrown away.
  document.getElementById("search-db")?.addEventListener(
    "input",
    debounce(() => {
      resetPage("db");
      renderDbCards();
    }),
  );
  document.getElementById("search-history")?.addEventListener(
    "input",
    debounce(() => {
      // Three history modes, not two: dispatching kalibrasi to renderMutasiCards
      // meant typing in the search box swapped the Kalibrasi tab's own contents.
      resetPage(`history-${_historyMode}`);
      if (_historyMode === "repair") renderHistoryCards();
      else if (_historyMode === "kalibrasi") renderKalibrasiCards();
      else renderMutasiCards();
    }),
  );
  document.getElementById("filter-mode")?.addEventListener("change", () => {
    resetPage("db");
    renderDbCards();
  });

  // Data Aset quick-download buttons
  document
    .getElementById("btn-db-download-xlsx")
    ?.addEventListener("click", async () => {
      if (!db.length) {
        showToast("Belum ada aset yang terdaftar.", "warning");
        return;
      }
      if (!(await ensureXLSX())) return;
      const rows = db.map((item) => ({
        "ID Aset": item.id_aset,
        "Kode Alat": item.kode_alat,
        Lokasi: item.id_lokasi,
        Status: item.status_terakhir,
        Pengadaan: item.sumber_pengadaan,
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Data Aset");
      XLSX.writeFile(
        wb,
        `DataAset_${new Date().toISOString().slice(0, 10)}.xlsx`,
      );
      showToast("File Excel berhasil diunduh.", "success");
    });

  document
    .getElementById("btn-db-download-pdf")
    ?.addEventListener("click", async () => {
      if (!db.length) {
        showToast("Belum ada aset yang terdaftar.", "warning");
        return;
      }
      if (!(await ensureJsPDF())) return;
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: "landscape" });
      doc.setFontSize(13);
      doc.setFont("helvetica", "bold");
      doc.text("RAMCES Light Machinery — Data Aset", 14, 14);
      doc.setFontSize(8);
      doc.setFont("helvetica", "normal");
      doc.text(
        `Dicetak: ${new Date().toLocaleString("id-ID")}  |  Total: ${db.length} aset`,
        14,
        20,
      );
      doc.autoTable({
        head: [["ID Aset", "Kode Alat", "Lokasi", "Status"]],
        body: db.map((item) => [
          item.id_aset,
          item.kode_alat,
          item.id_lokasi,
          item.status_terakhir,
        ]),
        startY: 25,
        styles: { fontSize: 7, cellPadding: 2 },
        headStyles: {
          fillColor: [22, 76, 129],
          textColor: 255,
          fontStyle: "bold",
        },
        alternateRowStyles: { fillColor: [249, 250, 251] },
        didParseCell(data) {
          if (data.section === "body" && data.column.index === 3) {
            const v = data.cell.raw;
            data.cell.styles.textColor =
              v === "SO" ? [21, 128, 61] : [185, 28, 28];
            data.cell.styles.fontStyle = "bold";
          }
        },
      });
      doc.save(`DataAset_${new Date().toISOString().slice(0, 10)}.pdf`);
      showToast("File PDF berhasil diunduh.", "success");
    });

  // Import Alat Excel
  // ── Master Bulk Import: shared logic for Alat / Lokasi / UPT ──
  function _wireMasterBulk(prefix, sampleFn, importFn) {
    const toggleBtn = document.getElementById(`${prefix}-bulk-toggle`);
    const dropdown  = document.getElementById(`${prefix}-bulk-dropdown`);
    const modal     = document.getElementById(`${prefix}-bulk-modal`);
    const actionSel = document.getElementById(`${prefix}-bulk-action`);
    const fileArea  = document.getElementById(`${prefix}-bulk-file-area`);
    const fileInput = document.getElementById(`${prefix}-bulk-file-input`);
    const fileName  = document.getElementById(`${prefix}-bulk-filename`);

    toggleBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown?.classList.toggle("hidden");
    });
    document.addEventListener("click", () => dropdown?.classList.add("hidden"));

    document.getElementById(`${prefix}-btn-sample-excel`)?.addEventListener("click", () => {
      dropdown?.classList.add("hidden");
      if (actionSel) actionSel.value = "sample";
      fileArea?.classList.add("hidden");
      modal?.classList.remove("hidden");
    });
    document.getElementById(`${prefix}-btn-import-excel`)?.addEventListener("click", () => {
      dropdown?.classList.add("hidden");
      if (actionSel) actionSel.value = "import";
      fileArea?.classList.remove("hidden");
      modal?.classList.remove("hidden");
    });

    actionSel?.addEventListener("change", (e) => {
      fileArea?.classList.toggle("hidden", e.target.value !== "import");
    });
    fileInput?.addEventListener("change", (e) => {
      if (fileName) fileName.textContent = e.target.files[0]?.name || "Belum ada file dipilih";
    });
    document.getElementById(`close-${prefix}-bulk-modal`)?.addEventListener("click", () => modal?.classList.add("hidden"));
    document.getElementById(`${prefix}-bulk-cancel`)?.addEventListener("click", () => modal?.classList.add("hidden"));
    document.getElementById(`${prefix}-bulk-confirm`)?.addEventListener("click", async () => {
      const action = actionSel?.value;
      if (!action) { showToast("Pilih tindakan terlebih dahulu.", "warning"); return; }
      // Single gate for all six master-data sample/import paths — SheetJS is
      // loaded on demand rather than in <head>, so this is the one place it has
      // to be awaited before any XLSX.* call downstream.
      if (!(await ensureXLSX())) return;
      if (action === "sample") {
        sampleFn();
        modal?.classList.add("hidden");
      } else if (action === "import") {
        const file = fileInput?.files[0];
        if (!file) { showToast("Pilih file Excel terlebih dahulu.", "warning"); return; }
        modal?.classList.add("hidden");
        await importFn(file);
      }
    });
  }

  // ── Sample Excel generators for master tabs ──
  function downloadMasterAlatSample() {
    const wb = XLSX.utils.book_new();
    const headers = ["Kode Alat", "Nama Alat"];
    const sample  = [["RGM", "Rel Grinding Machine"], ["CWL", "Crane Wire Long"]];
    const ws = XLSX.utils.aoa_to_sheet([headers, ...sample]);
    ws["!cols"] = [{ wch: 14 }, { wch: 30 }];
    const instr = [
      ["Petunjuk Pengisian"],
      ["Kolom Kode Alat: alphanumerik, max 10 karakter, unik, WAJIB"],
      ["Kolom Nama Alat: teks deskriptif, max 100 karakter, WAJIB"],
    ];
    const wsI = XLSX.utils.aoa_to_sheet(instr);
    wsI["!cols"] = [{ wch: 60 }];
    XLSX.utils.book_append_sheet(wb, ws, "Data Alat Kerja");
    XLSX.utils.book_append_sheet(wb, wsI, "Petunjuk");
    XLSX.writeFile(wb, "Template_Import_MasterAlat.xlsx");
  }

  function downloadMasterLokasiSample() {
    const wb = XLSX.utils.book_new();
    const headers = ["Kode Lokasi", "Nama Lokasi", "Tipe"];
    const sample  = [["D1", "DAOP 1 Jakarta", "DAOP"], ["VI", "DIVRE VI Medan", "DIVRE"]];
    const ws = XLSX.utils.aoa_to_sheet([headers, ...sample]);
    ws["!cols"] = [{ wch: 14 }, { wch: 30 }, { wch: 14 }];
    const instr = [
      ["Petunjuk Pengisian"],
      ["Kode Lokasi: alphanumerik, max 10 karakter, unik, WAJIB"],
      ["Nama Lokasi: teks, max 100 karakter, WAJIB"],
      ["Tipe: salah satu dari PUSAT / DAOP / DIVRE / BALAIYASA, WAJIB"],
    ];
    const wsI = XLSX.utils.aoa_to_sheet(instr);
    wsI["!cols"] = [{ wch: 60 }];
    XLSX.utils.book_append_sheet(wb, ws, "Data Lokasi");
    XLSX.utils.book_append_sheet(wb, wsI, "Petunjuk");
    XLSX.writeFile(wb, "Template_Import_MasterLokasi.xlsx");
  }

  function downloadMasterUptSample() {
    const wb = XLSX.utils.book_new();
    const headers = ["Kode UPT", "Nama UPT", "Kode Induk Lokasi"];
    const sample  = [["JR1.1", "UPT Jalan Rel 1.1", "D1"], ["JR2.3", "UPT Jalan Rel 2.3", "D2"]];
    const ws = XLSX.utils.aoa_to_sheet([headers, ...sample]);
    ws["!cols"] = [{ wch: 14 }, { wch: 30 }, { wch: 20 }];
    const instr = [
      ["Petunjuk Pengisian"],
      ["Kode UPT: alphanumerik, max 10 karakter, unik (misal: JR1.1), WAJIB"],
      ["Nama UPT: teks, max 100 karakter, WAJIB"],
      ["Kode Induk Lokasi: harus sudah terdaftar di tabel Lokasi (misal: D1, VI), WAJIB"],
    ];
    const wsI = XLSX.utils.aoa_to_sheet(instr);
    wsI["!cols"] = [{ wch: 60 }];
    XLSX.utils.book_append_sheet(wb, ws, "Data UPT");
    XLSX.utils.book_append_sheet(wb, wsI, "Petunjuk");
    XLSX.writeFile(wb, "Template_Import_MasterUPT.xlsx");
  }

  // ── Import processors for master tabs ──
  async function processMasterAlatImport(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const wb = XLSX.read(e.target.result, { type: "array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
          const dataRows = rows.slice(1).filter((r) => r[0] && r[1]);
          if (!dataRows.length) { showToast("File tidak memiliki baris data.", "warning"); return resolve(0); }
          let success = 0, failed = 0;
          for (const row of dataRows) {
            const kode = String(row[0]).trim().toUpperCase();
            const nama = String(row[1]).trim();
            if (!kode || !nama) { failed++; continue; }
            try {
              const res = await apiFetch("/master/alat", { method: "POST", body: JSON.stringify({ kode_alat: kode, nama_alat: nama }) });
              if (res.ok) success++; else failed++;
            } catch { failed++; }
          }
          showToast(`Import Alat selesai: ${success} berhasil${failed ? `, ${failed} gagal` : ""}.`, success > 0 ? "success" : "error");
          await loadMasterAlat();
          await fetchMasterData();
          resolve(success);
        } catch (err) { showToast("Gagal membaca file Excel.", "error"); reject(err); }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  async function processMasterLokasiImport(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const wb = XLSX.read(e.target.result, { type: "array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
          const dataRows = rows.slice(1).filter((r) => r[0] && r[1] && r[2]);
          if (!dataRows.length) { showToast("File tidak memiliki baris data.", "warning"); return resolve(0); }
          let success = 0, failed = 0;
          for (const row of dataRows) {
            try {
              const res = await apiFetch("/master/lokasi", { method: "POST", body: JSON.stringify({ id_lokasi: String(row[0]).trim().toUpperCase(), nama_lokasi: String(row[1]).trim(), tipe: String(row[2]).trim().toUpperCase() }) });
              if (res.ok) success++; else failed++;
            } catch { failed++; }
          }
          showToast(`Import Lokasi selesai: ${success} berhasil${failed ? `, ${failed} gagal` : ""}.`, success > 0 ? "success" : "error");
          await fetchMasterData();
          resolve(success);
        } catch (err) { showToast("Gagal membaca file Excel.", "error"); reject(err); }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  async function processMasterUptImport(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const wb = XLSX.read(e.target.result, { type: "array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
          const dataRows = rows.slice(1).filter((r) => r[0] && r[1] && r[2]);
          if (!dataRows.length) { showToast("File tidak memiliki baris data.", "warning"); return resolve(0); }
          let success = 0, failed = 0;
          for (const row of dataRows) {
            try {
              const res = await apiFetch("/master/lokasi", { method: "POST", body: JSON.stringify({ id_lokasi: String(row[0]).trim(), nama_lokasi: String(row[1]).trim(), tipe: "UPT", parent_lokasi: String(row[2]).trim() }) });
              if (res.ok) success++; else failed++;
            } catch { failed++; }
          }
          showToast(`Import UPT selesai: ${success} berhasil${failed ? `, ${failed} gagal` : ""}.`, success > 0 ? "success" : "error");
          await fetchMasterData();
          await loadMasterUpt();
          resolve(success);
        } catch (err) { showToast("Gagal membaca file Excel.", "error"); reject(err); }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  // Wire all three master bulk panels
  _wireMasterBulk("master-alat",   downloadMasterAlatSample,   processMasterAlatImport);
  _wireMasterBulk("master-lokasi", downloadMasterLokasiSample, processMasterLokasiImport);
  _wireMasterBulk("master-upt",    downloadMasterUptSample,    processMasterUptImport);

  document.getElementById("btn-import-alat-submit")?.addEventListener("click", async () => {
      const fileInput = document.getElementById("import-alat-file");
      const file = fileInput.files[0];
      if (!file) {
        showToast("Pilih file Excel terlebih dahulu.", "warning");
        return;
      }

      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const wb = XLSX.read(e.target.result, { type: "array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

          let dataRows = rows.filter((r) =>
            r.some((c) => String(c).trim() !== ""),
          );
          if (!dataRows.length) {
            showToast("File kosong atau tidak terbaca.", "error");
            return;
          }

          const firstRow = dataRows[0].map((c) =>
            String(c).toUpperCase().trim(),
          );
          if (firstRow.some((c) => c.includes("kode") || c.includes("nama"))) {
            dataRows = dataRows.slice(1);
          }

          const parsed = [];
          for (const row of dataRows) {
            const cells = row
              .map((c) => String(c).trim())
              .filter((_, i) => row[i] !== "");
            if (cells.length < 2) continue;

            let startIdx = 0;
            if (/^\d+$/.test(cells[0])) startIdx = 1;

            const kode = cells[startIdx];
            const nama = cells[startIdx + 1];

            if (!kode || !nama) {
              showToast(
                `Baris tidak valid ditemukan: "${row.join(", ")}". Format harus: Kode, Nama Alat.`,
                "error",
              );
              return;
            }
            if (/[^A-Za-z0-9_\-]/.test(kode)) {
              showToast(
                `Kode tidak valid: "${kode}". Hanya huruf, angka, - dan _ yang diperbolehkan.`,
                "error",
              );
              return;
            }

            parsed.push({ kode_alat: kode.toUpperCase(), nama_alat: nama });
          }

          if (!parsed.length) {
            showToast(
              "Tidak ada data valid yang ditemukan dalam file.",
              "warning",
            );
            return;
          }

          let success = 0,
            failed = 0;
          for (const item of parsed) {
            try {
              const res = await apiFetch("/master/alat", {
                method: "POST",
                body: JSON.stringify({
                  kode_alat: item.kode_alat,
                  nama_alat: item.nama_alat,
                }),
              });
              if (res.ok) success++;
              else failed++;
            } catch {
              failed++;
            }
          }

          document.getElementById("import-alat-modal").classList.add("hidden");
          showToast(
            `Import selesai: ${success} berhasil${failed ? `, ${failed} gagal` : ""}.`,
            success ? "success" : "error",
          );
          await loadMasterAlat();
          await fetchMasterData();
        } catch (err) {
          showToast(
            "Gagal membaca file. Pastikan format file adalah .xlsx yang valid.",
            "error",
          );
        }
      };
      reader.readAsArrayBuffer(file);
    });

  // Import Lokasi
  document.getElementById("btn-import-lokasi")?.addEventListener("click", () => {
    document.getElementById("import-lokasi-file").value = "";
    document.getElementById("import-lokasi-filename").textContent = "Belum ada file dipilih";
    document.getElementById("import-lokasi-modal").classList.remove("hidden");
  });
  document.getElementById("close-import-lokasi-modal")?.addEventListener("click", () => {
    document.getElementById("import-lokasi-modal").classList.add("hidden");
  });
  document.getElementById("import-lokasi-file")?.addEventListener("change", (e) => {
    document.getElementById("import-lokasi-filename").textContent = e.target.files[0]?.name || "Belum ada file dipilih";
  });
  document.getElementById("btn-import-lokasi-submit")?.addEventListener("click", async () => {
    const file = document.getElementById("import-lokasi-file").files[0];
    if (!file) { showToast("Pilih file Excel terlebih dahulu.", "warning"); return; }
    document.getElementById("import-lokasi-modal").classList.add("hidden");
    await processMasterLokasiImport(file);
  });

  // Import UPT
  document.getElementById("btn-import-upt")?.addEventListener("click", () => {
    document.getElementById("import-upt-file").value = "";
    document.getElementById("import-upt-filename").textContent = "Belum ada file dipilih";
    document.getElementById("import-upt-modal").classList.remove("hidden");
  });
  document.getElementById("close-import-upt-modal")?.addEventListener("click", () => {
    document.getElementById("import-upt-modal").classList.add("hidden");
  });
  document.getElementById("import-upt-file")?.addEventListener("change", (e) => {
    document.getElementById("import-upt-filename").textContent = e.target.files[0]?.name || "Belum ada file dipilih";
  });
  document.getElementById("btn-import-upt-submit")?.addEventListener("click", async () => {
    const file = document.getElementById("import-upt-file").files[0];
    if (!file) { showToast("Pilih file Excel terlebih dahulu.", "warning"); return; }
    document.getElementById("import-upt-modal").classList.add("hidden");
    await processMasterUptImport(file);
  });

  // Close buttons
  document
    .getElementById("close-edit-btn")
    ?.addEventListener("click", () => switchView("database"));
  document.getElementById("close-hist-btn")?.addEventListener("click", () => {
    activeHistoryUid = null;
    switchView("history");
  });

  // Dynamic UPT Select
  document.getElementById("edit-lokasi")?.addEventListener("change", (e) => {
    applyUptSelect(e.target.value, document.getElementById("edit-upt"));
  });

  document.getElementById("in-lokasi")?.addEventListener("change", (e) => {
    applyUptSelect(e.target.value, document.getElementById("in-upt"));
  });

  // SO / TSO buttons (scoped to perbaikan panel only)
  document.querySelectorAll("#panel-perbaikan .status-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const status = e.currentTarget.dataset.status;
      document.getElementById("edit-kondisi").value = status;

      document.querySelectorAll("#panel-perbaikan .status-btn").forEach((b) => {
        b.classList.remove("is-so", "is-tso", "is-idle");
        if (b.dataset.status === status) {
          b.classList.add(status === "SO" ? "is-so" : "is-tso");
        } else {
          b.classList.add("is-idle");
        }
      });
    });
  });

  // ── Edit form tab switcher ──────────────────────────────────────────────
  document.getElementById("edit-tab-perbaikan")?.addEventListener("click", () => {
      _switchEditFormTab("perbaikan");
    });
  document.getElementById("edit-tab-kalibrasi")?.addEventListener("click", () => {
      _switchEditFormTab("kalibrasi");
    });

  // ── Kalib lokasi/UPT dynamic selects ──────────────────────────────────
  document.getElementById("kalib-lokasi")?.addEventListener("change", (e) => {
    applyUptSelect(e.target.value, document.getElementById("kalib-upt"));
  });

  // ── Close kalibrasi button ─────────────────────────────────────────────
  document.getElementById("close-kalib-btn")?.addEventListener("click", () => {
    switchView("database");
  });

  // ── FORM SUBMISSIONS ────────────────────────────────────────────────────
  document
    .getElementById("form-input-baru")
    ?.addEventListener("submit", async function (e) {
      e.preventDefault();

      const alat = document.getElementById("in-alat").value;
      const pengadaan = document.querySelector(
        'input[name="in-pengadaan"]:checked',
      ).value;
      const tanggal = document.getElementById("in-tanggal").value;
      const unitRaw = document.querySelector(
        'input[name="in-unit"]:checked',
      ).value;
      const peruntukanMap = {
        A: "JALAN REL",
        B: "JEMBATAN",
        C: "MEKANIK",
        D: "BALAIYASA",
      };
      const peruntukanVal = peruntukanMap[unitRaw] || "JALAN REL";
      const lokasi = document.getElementById("in-lokasi").value; // Parent (misal: D1)
      const uptName = document.getElementById("in-upt")?.value || ""; // UPT (misal: JR1.1)

      if (!lokasi) {
        showToast("Pilih Lokasi/Wilayah terlebih dahulu.", "warning");
        return;
      }
      // UPT is optional — aset can be assigned to a parent lokasi without a specific UPT

      // Payload mentah. Tidak ada pembuatan id_aset di sini.
      const payload = {
        kode_alat: alat,
        id_lokasi: uptName || lokasi, // UPT if chosen, otherwise parent lokasi
        parent_lokasi: lokasi,
        tanggal_pembelian: tanggal,
        sumber_pengadaan: pengadaan,
        peruntukan: peruntukanVal,
      };

      try {
        const response = await apiFetch("/aset", {
          method: "POST",
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.detail || "Gagal menyimpan data ke database.");
        }

        const result = await response.json();

        // Ambil ID yang dihasilkan dari respons backend
        showToast(`Berhasil disimpan! ID Aset: ${result.id_aset}`, "success");

        this.reset();

        const inUpt = document.getElementById("in-upt");
        const inLokasi = document.getElementById("in-lokasi");
        if (inLokasi) inLokasi.value = "";
        if (inUpt) {
          inUpt.innerHTML = `<option value="">— Pilih Lokasi terlebih dahulu —</option>`;
          inUpt.disabled = true;
        }
        fetchAsetFromServer();
      } catch (error) {
        if (error.message !== "Unauthorized") showToast(error.message, "error");
      }
    });

  document
    .getElementById("form-edit")
    ?.addEventListener("submit", async function (e) {
      e.preventDefault();

      const kondisi    = document.getElementById("edit-kondisi").value;
      const keterangan = document.getElementById("edit-keterangan").value || "-";
      const uptVal     = document.getElementById("edit-upt")?.value || "";
      const lokasiVal  = document.getElementById("edit-lokasi")?.value || "";

      // Radio values are A/B/C/D — map to full name before sending
      const _PERUNTUKAN_SUBMIT = { A: "JALAN REL", B: "JEMBATAN", C: "MEKANIK", D: "BALAIYASA" };
      const unitRaw    = document.querySelector('input[name="edit-unit"]:checked')?.value || "";
      const peruntukan = _PERUNTUKAN_SUBMIT[unitRaw] || unitRaw || "";

      if (!kondisi)
        return showToast("Pilih Kondisi Alat Kerja (SO/TSO)!", "warning");
      if (!peruntukan)
        return showToast("Pilih Unit Peruntukan terlebih dahulu!", "warning");

      const payload = {
        id_aset:    document.getElementById("edit-uid").value,
        kondisi,
        keterangan,
        peruntukan,
        id_lokasi:  uptVal || lokasiVal || "",
      };

      try {
        const response = await apiFetch("/riwayat-kondisi", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error("Gagal menyimpan riwayat perbaikan.");

        showToast("Berhasil memperbarui kondisi", "success");
        switchView("database");
        fetchAsetFromServer();
      } catch (error) {
        if (error.message !== "Unauthorized") showToast(error.message, "error");
      }
    });

  document
    .getElementById("form-kalib")
    ?.addEventListener("submit", async function (e) {
      e.preventDefault();

      const uid = document.getElementById("edit-uid").value;
      const tanggalKalibrasi = document.getElementById("kalib-tanggal")?.value || "";
      const tanggalBerlaku   = document.getElementById("kalib-berlaku")?.value || tanggalKalibrasi;
      const statusKalibrasi  = document.getElementById("kalib-status")?.value || "LULUS";
      const pelaksana        = document.getElementById("kalib-teknisi")?.value?.trim() || null;
      const nomorSertifikat  = document.getElementById("kalib-nomor")?.value?.trim() || null;
      const keterangan       = document.getElementById("kalib-keterangan")?.value?.trim() || null;

      const payload = {
        id_aset: uid,
        tanggal_kalibrasi: tanggalKalibrasi,
        tanggal_berlaku: tanggalBerlaku || tanggalKalibrasi,
        status: statusKalibrasi,
        pelaksana_kalibrasi: pelaksana,
        nomor_sertifikat: nomorSertifikat,
        keterangan: keterangan,
      };

      try {
        const response = await apiFetch("/kalibrasi", {
          method: "POST",
          body: JSON.stringify(payload),
        });

        if (!response.ok) throw new Error("Gagal menyimpan laporan kalibrasi.");

        // Upload is a deliberate SECOND step: the file is attached to the
        // id_kalibrasi the create returns. This response used to be discarded
        // entirely, throwing away the only value the upload needs.
        const created = await response.json().catch(() => ({}));
        const fileInput = document.getElementById("kalib-file");
        const file = fileInput?.files?.[0];
        if (file && created.id_kalibrasi) {
          const fd = new FormData();
          fd.append("file", file);
          // apiFetch leaves FormData alone so the browser can set the
          // multipart boundary itself.
          const up = await apiFetch(
            `/kalibrasi/${created.id_kalibrasi}/sertifikat`,
            { method: "POST", body: fd },
          );
          if (!up.ok) {
            const detail =
              (await up.json().catch(() => ({}))).detail ||
              "berkas sertifikat gagal diunggah.";
            // The record saved — this is a partial success, not a failure.
            showToast(`Kalibrasi tersimpan, tetapi ${detail}`, "warning");
          }
        }
        if (fileInput) fileInput.value = "";

        showToast("Laporan kalibrasi berhasil disimpan", "success");
        switchView("database");
        fetchAsetFromServer();
      } catch (error) {
        if (error.message !== "Unauthorized") showToast(error.message, "error");
      }
    });

  // ── QR MODAL LISTENERS ───────────────────────────────────────────────────

  document
    .getElementById("btn-copy-link")
    ?.addEventListener("click", async () => {
      const linkText = document.getElementById(
        "qr-landing-link-text",
      )?.textContent;
      if (!linkText) return;

      try {
        await navigator.clipboard.writeText(linkText);
        const btn = document.getElementById("btn-copy-link");
        btn.innerHTML = '<i class="fas fa-check"></i>';
        btn.title = "Tersalin!";
        setTimeout(() => {
          btn.innerHTML = '<i class="fas fa-copy"></i>';
          btn.title = "Salin link";
        }, 2000);
      } catch {
        showToast("Salin manual: " + linkText, "info");
      }
    });

  document
    .getElementById("close-qr-modal")
    ?.addEventListener("click", closeQrModal);
  document.getElementById("qr-modal")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("qr-modal")) closeQrModal();
  });

  document
    .getElementById("btn-qr-download-png")
    ?.addEventListener("click", downloadQrPng);
  document
    .getElementById("btn-qr-download-pdf")
    ?.addEventListener("click", downloadQrPdf);

  // ── HISTORY UI CONTROLS LISTENERS ────────────────────────────────────────

  document.getElementById("hist-tab-repair")?.addEventListener("click", () => {
    _historyMode = "repair";
    _setHistoryTab("repair");
    renderHistoryCards();
  });

  document.getElementById("hist-tab-kalibrasi")?.addEventListener("click", () => {
      _historyMode = "kalibrasi";
      _setHistoryTab("kalibrasi");
      renderKalibrasiCards();
    });

  document.getElementById("hist-tab-mutasi")?.addEventListener("click", () => {
    _historyMode = "mutasi";
    _setHistoryTab("mutasi");
    renderMutasiCards();
  });

  function _setHistoryTab(active) {
    const ACTIVE_REPAIR   = ["bg-kai-blue", "text-white", "font-semibold", "shadow-sm"];
    const INACTIVE_REPAIR = ["text-gray-500", "dark:text-gray-400", "font-medium", "hover:bg-blue-100", "hover:text-kai-blue", "dark:hover:bg-blue-900/20", "dark:hover:text-blue-300"];
    const ACTIVE_KALIB    = ["bg-cyan-600", "text-white", "font-semibold", "shadow-sm"];
    const INACTIVE_KALIB  = ["text-gray-500", "dark:text-gray-400", "font-medium", "hover:bg-cyan-100", "hover:text-cyan-700", "dark:hover:bg-cyan-900/20", "dark:hover:text-cyan-300"];
    const ACTIVE_MUTASI   = ["bg-kai-orange", "text-white", "font-semibold", "shadow-sm"];
    const INACTIVE_MUTASI = ["text-gray-500", "dark:text-gray-400", "font-medium", "hover:bg-orange-100", "hover:text-kai-orange", "dark:hover:bg-orange-900/20", "dark:hover:text-orange-300"];

    const ALL = [...ACTIVE_REPAIR, ...INACTIVE_REPAIR, ...ACTIVE_KALIB, ...INACTIVE_KALIB, ...ACTIVE_MUTASI, ...INACTIVE_MUTASI];

    const tabCfg = {
      repair:    { active: ACTIVE_REPAIR,  inactive: INACTIVE_REPAIR  },
      kalibrasi: { active: ACTIVE_KALIB,   inactive: INACTIVE_KALIB   },
      mutasi:    { active: ACTIVE_MUTASI,  inactive: INACTIVE_MUTASI  },
    };

    ["repair", "kalibrasi", "mutasi"].forEach((t) => {
      const btn = document.getElementById(`hist-tab-${t}`);
      if (!btn) return;
      ALL.forEach((c) => btn.classList.remove(c));
      (t === active ? tabCfg[t].active : tabCfg[t].inactive).forEach((c) => btn.classList.add(c));
    });

    document.getElementById("history-repair-container")?.classList.toggle("hidden", active !== "repair");
    document.getElementById("history-kalibrasi-container")?.classList.toggle("hidden", active !== "kalibrasi");
    document.getElementById("history-mutasi-container")?.classList.toggle("hidden", active !== "mutasi");
    // Each tab keeps its own page, so each carries its own pager bar; they hide
    // and show with the grid they belong to.
    document.getElementById("history-repair-pager")?.classList.toggle("hidden", active !== "repair");
    document.getElementById("history-kalibrasi-pager")?.classList.toggle("hidden", active !== "kalibrasi");
    document.getElementById("history-mutasi-pager")?.classList.toggle("hidden", active !== "mutasi");
  }

  document
    .getElementById("detail-tab-repair")
    ?.addEventListener("click", () => {
      switchDetailTab("repair", activeHistoryUid);
    });
  document
    .getElementById("detail-tab-kalibrasi")
    ?.addEventListener("click", () => {
      switchDetailTab("kalibrasi", activeHistoryUid);
    });
  document
    .getElementById("detail-tab-mutasi")
    ?.addEventListener("click", () => {
      switchDetailTab("mutasi", activeHistoryUid);
    });

  // Mutasi modal
  document
    .getElementById("close-mutasi-modal")
    ?.addEventListener("click", () => {
      document.getElementById("mutasi-modal").classList.add("hidden");
    });
  document.getElementById("mutasi-modal")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("mutasi-modal"))
      document.getElementById("mutasi-modal").classList.add("hidden");
  });

  document
    .getElementById("btn-submit-mutasi")
    ?.addEventListener("click", async () => {
      const uid        = document.getElementById("mutasi-uid").value;
      const lokasiTuju = document.getElementById("mutasi-lokasi-tuju").value;
      const uptTuju    = document.getElementById("mutasi-upt-tuju")?.value || "";
      const alasan     = document.getElementById("mutasi-alasan").value.trim();

      // Field value takes priority; fall back to logged-in username when blank
      const petugasVal = (document.getElementById("mutasi-petugas")?.value || "").trim()
        || currentUser || "";

      if (!lokasiTuju)
        return showToast("Pilih lokasi tujuan terlebih dahulu.", "warning");

      // UPT is optional — use UPT when chosen, otherwise use the parent lokasi code
      const idLokasiTujuan = uptTuju || lokasiTuju;

      const btn  = document.getElementById("btn-submit-mutasi");
      const orig = btn.innerHTML;
      btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Memproses...`;
      btn.disabled = true;

      try {
        const res = await apiFetch("/mutasi", {
          method: "POST",
          body: JSON.stringify({
            id_aset: uid,
            id_lokasi_tujuan: idLokasiTujuan,
            alasan_mutasi: alasan || null,
            nama_petugas: petugasVal,
          }),
        });

        const data = await res.json();

        if (!res.ok) throw new Error(data.detail || "Gagal memproses mutasi.");

        showToast(data.message || "Mutasi berhasil", "success");
        document.getElementById("mutasi-modal").classList.add("hidden");
        await fetchAsetFromServer();
        await loadHistorySummary();
      } catch (e) {
        showToast(e.message, "error");
      } finally {
        btn.innerHTML = orig;
        btn.disabled = false;
      }
    });
}

// ── WEBSOCKET ──────────────────────────────────────────────────────────────

const WS_MAX_RETRIES = 10;
const WS_BASE_DELAY = 3000;
const WS_MAX_DELAY = 60000;

function setupWebSocket() {
  if (window._wsHeartbeat) clearInterval(window._wsHeartbeat);
  if (window._wsReconnectTimer) clearTimeout(window._wsReconnectTimer);

  // Derive the scheme from the PAGE, not from any tunnel config. Behind a
  // TLS-terminating tunnel (Tailscale Funnel, Cloudflare, ngrok) the page is
  // https:// and a ws:// socket is blocked by the browser as mixed content.
  // The backend serves this SPA itself, so the socket is always same-origin.
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  // The token rides as a query param because the browser WebSocket API cannot
  // set an Authorization header. It identifies the socket for presence; the
  // server still accepts anonymous sockets for broadcasts.
  const qs = authToken ? `?token=${encodeURIComponent(authToken)}` : "";
  const ws = new WebSocket(`${protocol}://${window.location.host}/ws/updates${qs}`);

  ws.onopen = () => {
    _wsRetryCount = 0;
    _wsNgrokFailed = false; // Reset on successful connection
    updateWsDot(true);
    stopPollingFallback(); // Socket is live — no need to poll
    // Re-announce the current screen: on a reconnect the server has forgotten it.
    reportCurrentView();
    window._wsHeartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, 30000);
  };

  ws.onmessage = (event) => {
    if (event.data === "pong") return; // heartbeat ack
    if (event.data === "REFRESH_ASSET_LIST") {
      fetchAsetFromServer();
      if (typeof window.refreshAfkirIfVisible === "function")
        window.refreshAfkirIfVisible();
    } else if (event.data === "REFRESH_PRESENCE") {
      if (typeof window.refreshPresenceIfVisible === "function")
        window.refreshPresenceIfVisible();
    } else if (event.data === "REFRESH_INVENTARIS") {
      window.dispatchEvent(
        new CustomEvent("ws-message", { detail: event.data }),
      );
    }
  };

  ws.onclose = () => {
    clearInterval(window._wsHeartbeat);
    updateWsDot(false);

    if (!authToken) return; // Don't reconnect if logged out

    // Socket is down — keep the UI fresh by polling until it comes back.
    startPollingFallback();

    if (_wsRetryCount >= WS_MAX_RETRIES) {
      showToast(
        "Live-sync terputus. Data tetap diperbarui secara berkala.",
        "warning",
      );
      return;
    }

    // Exponential backoff with jitter
    const delay = Math.min(
      WS_BASE_DELAY * Math.pow(2, _wsRetryCount),
      WS_MAX_DELAY,
    );
    const jitter = Math.random() * 1000;
    _wsRetryCount++;

    window._wsReconnectTimer = setTimeout(setupWebSocket, delay + jitter);
  };

  ws.onerror = () => {
    if (!_wsNgrokFailed) {
      _wsNgrokFailed = true;
      console.warn(
        `WebSocket gagal terhubung ke ${protocol}://${window.location.host}/ws/updates`,
      );
    }
    ws.close();
  };

  window._ws = ws;
}

// ── PRESENCE ───────────────────────────────────────────────────────────────
// Tells the server which screen this user is on, so the Pengguna list can show
// live activity. Cheap and fire-and-forget: a closed socket is simply skipped.
let _currentViewId = "";

function reportCurrentView(viewId) {
  if (viewId) _currentViewId = viewId;
  const sock = window._ws;
  if (sock && sock.readyState === WebSocket.OPEN && _currentViewId) {
    try {
      sock.send(`view:${_currentViewId}`);
    } catch (_) {
      /* socket closed mid-send — the next reconnect re-announces */
    }
  }
}

// ── LIVE-DATA POLLING FALLBACK ─────────────────────────────────────────────
// The WebSocket is the primary live-update channel. When it is unavailable
// (proxy drops the upgrade, network flap, retry budget exhausted) we fall back
// to periodic refetches so the page never shows stale data.
const POLL_INTERVAL_MS = 30000;

function startPollingFallback() {
  if (window._dataPollTimer || !authToken) return;
  window._dataPollTimer = setInterval(() => {
    if (!authToken) return stopPollingFallback();
    if (window._ws && window._ws.readyState === WebSocket.OPEN)
      return stopPollingFallback();
    if (document.visibilityState !== "visible") return; // don't poll hidden tabs
    fetchAsetFromServer({ silent: true });
    if (typeof window.refreshAfkirIfVisible === "function")
      window.refreshAfkirIfVisible();
  }, POLL_INTERVAL_MS);
}

function stopPollingFallback() {
  if (window._dataPollTimer) {
    clearInterval(window._dataPollTimer);
    window._dataPollTimer = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && currentUser) {
    fetchAsetFromServer();
    if (!window._ws || window._ws.readyState === WebSocket.CLOSED)
      setupWebSocket();
  }
});

window.addEventListener("resize", () => {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebar-overlay");
  const mainContent = document.getElementById("main-content-area");
  if (!sidebar) return;

  if (window.innerWidth >= 1024) {
    overlay?.classList.remove("active");
    if (sidebar.classList.contains("open")) {
      mainContent?.classList.add("sidebar-open");
    }
  } else {
    mainContent?.classList.remove("sidebar-open");
    if (sidebar.classList.contains("open")) {
      overlay?.classList.add("active");
    }
  }
});
