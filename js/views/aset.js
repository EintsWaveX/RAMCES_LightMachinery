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
  const item = db.find((x) => x.id_aset === uid);
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
  const statusBadgeCls =
    item.status_terakhir === "SO"
      ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
      : item.status_terakhir === "TSO"
        ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
        : "bg-blue-100 text-blue-700";

  if (_v("edit-card-id")) _v("edit-card-id").textContent = item.id_aset;
  if (_v("edit-card-nama"))
    _v("edit-card-nama").textContent = item.kode_alat_name || item.kode_alat;
  if (_v("edit-card-lokasi")) _v("edit-card-lokasi").textContent = lokasiName;
  if (_v("edit-card-upt")) _v("edit-card-upt").textContent = uptDisplayForCard;
  if (_v("edit-card-tgl")) _v("edit-card-tgl").textContent = tanggalBeli;
  if (_v("edit-card-peruntukan"))
    _v("edit-card-peruntukan").textContent = peruntukanName;
  if (_v("edit-card-varian"))
    _v("edit-card-varian").textContent = item.nama_varian || "—";
  const statusEl = _v("edit-card-status");
  if (statusEl) {
    statusEl.textContent = item.status_terakhir;
    statusEl.className = `text-[10px] font-bold px-2 py-0.5 rounded-full ${statusBadgeCls}`;
  }

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
  _switchEditFormTab("perbaikan");

  switchView("edit");
};

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
  const item = summaryFor(uid) || db.find((x) => x.id_aset === uid);
  if (!item) return;

  document.getElementById("hist-detail-subtitle").innerText = `${item.id_aset}`;
  switchView("history-detail");
  switchDetailTab(tab, uid);
};

// NOTE: an earlier window.openQrModal was defined here and immediately shadowed
// by the async version further down (which uses drawQrOnCanvas/buildLandingUrl).
// It also still pointed QR links at the old tunnel variable.

window.deleteAset = async (uid) => {
  const item = db.find((x) => x.id_aset === uid);
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
    const btn = document.getElementById(`detail-tab-${t}`);
    if (!btn) return;
    ALL.forEach((c) => btn.classList.remove(c));
    (t === tab ? tabCfg[t].active : tabCfg[t].inactive).forEach((c) => btn.classList.add(c));
  });

  document.getElementById("detail-panel-repair")?.classList.toggle("hidden", tab !== "repair");
  document.getElementById("detail-panel-kalibrasi")?.classList.toggle("hidden", tab !== "kalibrasi");
  document.getElementById("detail-panel-mutasi")?.classList.toggle("hidden", tab !== "mutasi");

  if (tab === "repair") loadDetailRepair(uid);
  if (tab === "kalibrasi") loadDetailKalibrasi(uid);
  if (tab === "mutasi") loadDetailMutasi(uid);
}

async function loadDetailRepair(uid) {
  const tbody = document.getElementById("hist-repair-tbody");
  tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-gray-500"><i class="fas fa-spinner fa-spin mr-2"></i>Mengambil data...</td></tr>`;
  try {
    const res = await apiFetch(`/riwayat-kondisi/${uid}`);
    if (!res.ok) throw new Error("Gagal mengambil riwayat.");
    const history = await res.json();
    if (!history.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="p-4 text-center text-gray-500">Belum ada riwayat perbaikan.</td></tr>`;
      return;
    }

    // Filter out KALIBRASI entries — they belong to the Kalibrasi tab only
    const repairEntries = history.filter((h) => h.kondisi !== "KALIBRASI");

    if (!repairEntries.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="p-4 text-center text-gray-500">Belum ada riwayat perbaikan (SO/TSO).</td></tr>`;
      return;
    }

    const asetTerkait = db.find((x) => x.id_aset === uid);

    const resolveLokasiCode = (kode) => {
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
    };

    tbody.innerHTML = repairEntries
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
                <td class="p-3 text-xs text-gray-500 whitespace-pre-wrap">${h.keterangan || "—"}</td>
            </tr>`;
      })
      .join("");
  } catch (e) {
    if (e.message !== "Unauthorized")
      tbody.innerHTML = `<tr><td colspan="8" class="p-4 text-center text-red-500">${e.message}</td></tr>`;
  }
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
  if (!confirm("Hapus berkas sertifikat dari catatan kalibrasi ini?")) return;
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
  tbody.innerHTML = `<tr><td colspan="${COLS}" class="p-4 text-center text-gray-500"><i class="fas fa-spinner fa-spin mr-2"></i>Mengambil data...</td></tr>`;
  try {
    const res = await apiFetch(`/kalibrasi/${uid}`);
    if (!res.ok) throw new Error("Gagal mengambil riwayat kalibrasi.");
    const history = await res.json();
    if (!history.length) {
      tbody.innerHTML = `<tr><td colspan="${COLS}" class="p-4 text-center text-gray-500">Belum ada riwayat kalibrasi.</td></tr>`;
      return;
    }
    const canDelete =
      _currentRole === "SUPER_ADMIN" || _currentRole === "ADMIN_WILAYAH";

    tbody.innerHTML = history
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
  } catch (e) {
    if (e.message !== "Unauthorized")
      tbody.innerHTML = `<tr><td colspan="${COLS}" class="p-4 text-center text-red-500">${e.message}</td></tr>`;
  }
}

async function loadDetailMutasi(uid) {
  const timeline = document.getElementById("mutasi-timeline");
  const originBar = document.getElementById("mutasi-origin-bar");
  timeline.innerHTML = `<div class="text-center text-gray-400 py-6"><i class="fas fa-spinner fa-spin mr-2"></i>Mengambil data...</div>`;
  originBar.innerHTML = "";

  try {
    const res = await apiFetch(`/mutasi/${uid}`);
    if (!res.ok) throw new Error("Gagal mengambil riwayat mutasi.");
    const data = await res.json();

    const returnedBadge = data.sudah_kembali
      ? `<span class="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-3 py-1 rounded-full text-xs font-bold">✓ Sudah Kembali ke Lokasi Awal</span>`
      : `<span class="bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 px-3 py-1 rounded-full text-xs font-bold">⟳ Belum Kembali ke Asal</span>`;

    const asal = resolveLokasi(data.original_lokasi);
    const kini = resolveLokasi(data.lokasi_sekarang);

    originBar.innerHTML = `
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

    if (!data.mutasi || !data.mutasi.length) {
      timeline.innerHTML = `<div class="text-center text-gray-400 py-6">Belum ada riwayat mutasi.</div>`;
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
  // O(1). This is called from inside sort comparators, so the old linear scan
  // made "urutkan menurut jumlah" O(n^2 log n).
  const s = summaryFor(item.id_aset);
  if (!s) return 0;
  return (s.repair?.count || 0) + (s.mutasi?.count || 0);
}

// KPI tiles for Kelola Data Aset. Deliberately scoped to the filtered list
// rather than the whole fleet: the tiles sit directly above the cards they
// summarise, so a figure describing a different set would simply read as wrong.
function _renderDbStats(items, mode, myRegion) {
  const set = (id, value) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  };
  const total = items.length;
  const so = items.filter((i) => (i.status_terakhir || "").toUpperCase() === "SO").length;
  const tso = items.filter((i) => (i.status_terakhir || "").toUpperCase() === "TSO").length;

  set("db-stat-total", total.toLocaleString("id-ID"));
  set("db-stat-so", so.toLocaleString("id-ID"));
  set("db-stat-tso", tso.toLocaleString("id-ID"));
  set("db-stat-avail", total ? `${((so / total) * 100).toFixed(1)}%` : "—");
  set("db-stat-total-note", `dari ${db.length.toLocaleString("id-ID")} terdaftar`);

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

function renderDbCards() {
  const container = document.getElementById("db-cards-container");
  const searchInput = document.getElementById("search-db");
  const modeSelect = document.getElementById("filter-mode");
  if (!container) return;

  container.innerHTML = "";

  const isTeknisi = _currentRole === "TEKNISI";
  if (modeSelect) modeSelect.style.display = isTeknisi ? "none" : "";

  const searchQ = (searchInput?.value || "").toUpperCase();
  // "Aset Saya" narrows the list to the region the logged-in user belongs to.
  // (This select was previously read into an unused variable, so the control
  // did nothing at all.)
  const mode = isTeknisi ? "public" : modeSelect ? modeSelect.value : "public";
  const myLokasiRaw = getJwtPayload(authToken)?.id_lokasi || "";
  const myRegion = getParentLokasiCode(myLokasiRaw) || myLokasiRaw;
  const isAdmin =
    _currentRole === "SUPER_ADMIN" || _currentRole === "ADMIN_WILAYAH";

  const filteredItems = db.filter((item) => {
    // One identity per row, reused by the region scope, the search and the
    // Lokasi/UPT filters — so all three agree with the label on the card.
    const ident = assetLokasiIdentity(item);

    if (mode === "local" && myRegion) {
      if (ident.parentCode !== myRegion && ident.uptCode !== myLokasiRaw)
        return false;
    }
    if (!assetMatchesSearch(item, searchQ)) return false;

    // Apply custom sort filters
    const f = _sortFilters;
    if (f.alat && item.kode_alat !== f.alat)
        return false;
    if (!_pengadaanMatches(item.sumber_pengadaan, f.pengadaan)) return false;
    if (f.peruntukan) {
      const dec = decodeAsetId(item.id_aset);
      if (dec.peruntukan !== f.peruntukan)
        return false;
    }
    if (!lokasiMatchesCode(ident, f.lokasi)) return false;
    if (f.upt && ident.uptCode !== f.upt) return false;
    if (f.tahunFrom || f.tahunTo) {
      const yr = parseInt((item.tanggal_pembelian || "").slice(0, 4));
      if (f.tahunFrom && yr < parseInt(f.tahunFrom))
        return false;
      if (f.tahunTo && yr > parseInt(f.tahunTo))
        return false;
    }
    if (f.idFrom || f.idTo) {
      const num = parseInt((item.id_aset || "").split(".")[0]) || 0;
      if (f.idFrom && num < f.idFrom)
        return false;
      if (f.idTo && num > f.idTo)
        return false;
    }
    return true;
  });

  // Stats describe the whole FILTERED set, not the current page — they answer
  // "how much matches", which paging must not change. Updated before the
  // empty-state return, or a search that matches nothing would leave the
  // previous filter's numbers standing.
  _renderDbStats(filteredItems, mode, myRegion);

  if (!filteredItems.length) {
    renderPagerBar("db-pager", paginateList("db", filteredItems), renderDbCards);
    container.innerHTML = `<div class="col-span-full text-center text-gray-400 py-12"><i class="fas fa-inbox text-3xl mb-2 block"></i>Tidak ada aset alat kerja yang cocok dengan filter ini.</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();

  // Sort the FULL filtered list first, then slice — paging an unsorted list
  // shows the right number of the wrong cards.
  const _dbSorted = filteredItems
    .sort((a, b) => {
      if (_sortDir === "date-desc") {
        return new Date(b.tanggal_pembelian || 0) - new Date(a.tanggal_pembelian || 0);
      }
      if (_sortDir === "date-asc") {
        return new Date(a.tanggal_pembelian || 0) - new Date(b.tanggal_pembelian || 0);
      }
      // Real event counts. This used to count how many SUMMARY ROWS matched the
      // asset — and the summary holds exactly one row per asset, so every score
      // was 1 and the two "jumlah" directions did nothing at all.
      if (_sortDir === "count-desc") return _eventCount(b) - _eventCount(a);
      if (_sortDir === "count-asc") return _eventCount(a) - _eventCount(b);
      const av = (a[_sortField] || "").toString().toUpperCase();
      const bv = (b[_sortField] || "").toString().toUpperCase();
      return _sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    });

  const _dbPage = paginateList("db", _dbSorted);
  renderPagerBar("db-pager", _dbPage, renderDbCards);

  _dbPage.items
    .forEach((item) => {
      const isSuperAdmin = _currentRole === "SUPER_ADMIN";
      const isAdminWilayah = _currentRole === "ADMIN_WILAYAH";
      const canDelete = isSuperAdmin || isAdminWilayah;

      const summaryItem = summaryFor(item.id_aset);

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
        ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"><i class="fas fa-circle text-[6px]"></i>SO</span>`
        : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"><i class="fas fa-circle text-[6px]"></i>TSO</span>`;

      // Badge 2: Kalibrasi status
      const kalibStatus = summaryItem?.kalibrasi?.latest_status;
      const kalibBadge = kalibStatus === "LULUS"
        ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"><i class="fas fa-circle text-[6px]"></i>LULUS</span>`
        : kalibStatus === "BERSYARAT"
        ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"><i class="fas fa-circle text-[6px]"></i>BERSYARAT</span>`
        : kalibStatus === "GAGAL"
        ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400"><i class="fas fa-circle text-[6px]"></i>GAGAL</span>`
        : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-gray-100 text-gray-400 dark:bg-gray-700 dark:text-gray-500"><i class="fas fa-circle text-[6px]"></i>BLM KALIBRASI</span>`;

      // Badge 3: Mutasi status
      const mutasiInfo = summaryItem?.mutasi;
      const mutasiBadge = (mutasiInfo && mutasiInfo.count > 0)
        ? mutasiInfo.sudah_kembali
          ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"><i class="fas fa-circle text-[6px]"></i>DI LOKASI ASAL</span>`
          : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"><i class="fas fa-circle text-[6px]"></i>SEDANG TERMUTASI</span>`
        : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-gray-100 text-gray-400 dark:bg-gray-700 dark:text-gray-500"><i class="fas fa-circle text-[6px]"></i>TIDAK TERMUTASI</span>`;

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
                    ${row("Spesifikasi Teknis", item.nama_varian || "—")}
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
  const item = db.find((x) => x.id_aset === uid);
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
  const item = db.find((x) => x.id_aset === uid);
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
