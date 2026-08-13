// ═══════════════════════════════════════════════════════════════════════
// Pantau Riwayat Aset - the perbaikan / kalibrasi / mutasi card tabs.
//
// Part of the RAMCES frontend. These files are plain classic scripts
// loaded in a fixed order by index.html - no bundler, no modules. They
// share one global scope, so a top-level `let` or `const` declared twice
// across two files is a fatal SyntaxError; see CLAUDE.md.
// ═══════════════════════════════════════════════════════════════════════

function renderHistoryCards() {
  const container = document.getElementById("history-repair-container");
  const searchInput = document.getElementById("search-history");
  if (!container) return;

  container.innerHTML = "";

  const searchQ = (searchInput?.value || "").toUpperCase();

  let filtered = _historySummary.filter((item) => {
    if (!_historySearchMatches(item, searchQ)) return false;
    return _historyFilterMatches(item, _histSortFilters);
  });

  filtered = filtered.sort(_historyComparator);

  if (!filtered.length) {
    renderPagerBar("history-repair-pager", paginateList("history-repair", filtered), renderHistoryCards);
    container.innerHTML = `<div class="col-span-2 text-center text-gray-400 py-12"><i class="fas fa-inbox text-3xl mb-2 block"></i>Belum ada riwayat perbaikan.</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();

  // Slice AFTER filter + sort, so paging never reorders the list.
  const _page = paginateList("history-repair", filtered);
  renderPagerBar("history-repair-pager", _page, renderHistoryCards);

  _page.items.forEach((item) => {
    const r = item.repair || {};
    const statusColor =
      item.status_terakhir === "SO"
        ? "text-green-500"
        : item.status_terakhir === "TSO"
          ? "text-red-500"
          : "text-blue-500";
    const kondisiColor =
      r.latest_kondisi === "SO"
        ? "text-green-500"
        : r.latest_kondisi === "TSO"
          ? "text-red-500"
          : "text-blue-400";

    const card = document.createElement("div");
    card.className =
      "bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-blue-200 dark:border-blue-900/30 flex flex-col justify-between hover:border-blue-500 transition-colors";
    card.innerHTML = `
            <div class="flex flex-col gap-3">
                <div class="flex justify-between items-start border-b dark:border-gray-700 pb-3">
                    <div>
                        <h3 class="text-base font-bold font-mono text-kai-blue dark:text-blue-400">${item.id_aset}</h3>
                        <p class="text-xs text-gray-500 dark:text-gray-200 mt-0.5">${item.kode_alat_name || item.kode_alat} — ${item.id_lokasi_name || item.id_lokasi}</p>
                    </div>
                    <span class="text-sm font-bold ${statusColor} shrink-0"><i class="fas fa-circle text-xs mr-1"></i>${item.status_terakhir}</span>
                </div>
                ${
                  r.latest_date
                    ? (() => {
                        // Ambil lokasi langsung dari data repair terbaru
                        const rawLokasiCode = item.id_lokasi_raw || item.id_lokasi;
                        const uptEntry = uptDatabase.find(
                          (u) => u.upt === rawLokasiCode,
                        );
                        const lokasiEntry = lokasiData.find(
                          (l) => l.code === rawLokasiCode,
                        );

                        const uptLabel = uptEntry
                          ? `${uptEntry.nama}`
                          :  "—";
                        const lokasiLabel = uptEntry
                          ? lokasiData.find((l) => l.code === uptEntry.lokasi)
                              ?.name || uptEntry.lokasi
                          : lokasiEntry
                            ? lokasiEntry.name
                            : "—";

                        const peruntukanLabel = item.peruntukan
                          ? item.peruntukan
                          : "—";

                        return `
                    <div class="space-y-1 text-xs text-gray-600 dark:text-gray-400">
                        <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Waktu Input</span>${formatUtcToLocal(r.latest_date)}</div>
                        <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Lokasi Pengirim</span><span class="font-bold">${lokasiLabel}</span></div>
                        <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">UPT Pengirim</span><span class="font-bold">${uptLabel}</span></div>
                        <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Peruntukan</span><span class="capitalize">${peruntukanLabel}</span></div>
                        <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Petugas</span><span>${r.latest_teknisi || "—"}</span></div>
                        <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Keterangan</span><span class="italic">${r.latest_keterangan || "—"}</span></div>
                        </div>`;
                      })()
                    : `
                <div class="space-y-1 text-xs text-gray-600 dark:text-gray-400">
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Waktu Input</span><span>—</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Peruntukan</span><span>—</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Lokasi Pengirim</span><span>—</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">UPT Pengirim</span><span>—</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Petugas</span><span>—</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Keterangan</span><span>—</span></div>
                </div>`
                }
            </div>
            <button onclick="window.openHistoryDetail('${item.id_aset}', 'repair')"
                class="mt-4 w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-kai-blue hover:bg-blue-800 active:bg-blue-900 text-white font-semibold rounded-lg transition text-sm shadow-sm">
                <i class="fas fa-list text-sm"></i> Lihat Riwayat Lengkap
            </button>
        `;

    fragment.appendChild(card);
  });

  container.appendChild(fragment);
}

// Shared search across the nine fields a Pantau Riwayat card actually shows.
// All three tabs use it, so searching by teknisi or lokasi behaves the same
// everywhere — Kalibrasi and Mutasi used to match on id_aset alone.
function _historySearchMatches(item, q) {
  if (!q) return true;
  // Location goes through assetMatchesSearch, which understands region labels;
  // the card-specific fields ride along as free text.
  return assetMatchesSearch(item, q, [
    // Perbaikan card
    item.repair?.latest_teknisi, item.repair?.latest_keterangan, item.repair?.latest_kondisi,
    // Kalibrasi card — searching "LULUS" or a certificate number should work on
    // the tab that actually displays them.
    item.kalibrasi?.latest_status, item.kalibrasi?.latest_nomor_sertifikat,
    item.kalibrasi?.latest_pelaksana, item.kalibrasi?.latest_keterangan,
    // Mutasi card
    item.mutasi?.latest_lokasi_tuju, item.mutasi?.latest_oleh,
    item.mutasi?.latest_alasan, item.mutasi?.original_lokasi_name,
  ]);
}

// Shared filter for the three Pantau Riwayat tabs — every criterion the sort
// modal can set, read in one place so no tab can silently ignore one.
function _historyFilterMatches(item, f) {
  if (f.alat && item.kode_alat !== f.alat) return false;
  if (!_pengadaanMatches(item.sumber_pengadaan, f.pengadaan)) return false;
  if (f.tahunFrom || f.tahunTo) {
    const yr = parseInt((item.tanggal_pembelian || "").slice(0, 4));
    if (f.tahunFrom && yr < parseInt(f.tahunFrom)) return false;
    if (f.tahunTo && yr > parseInt(f.tahunTo)) return false;
  }
  // Same identity the cards and the search use. This tab used to read
  // item.id_lokasi directly, so it disagreed with the other three views about
  // which location an asset belongs to.
  const ident = assetLokasiIdentity(item);
  if (!lokasiMatchesCode(ident, f.lokasi)) return false;
  if (f.upt && ident.uptCode !== f.upt) return false;
  if (f.peruntukan) {
    const dec = decodeAsetId(item.id_aset);
    if ((dec.peruntukan || "").toUpperCase() !== f.peruntukan) return false;
  }
  // The id range used to be honoured only on the Perbaikan tab.
  if (f.idFrom || f.idTo) {
    const num = parseInt((item.id_aset || "").split(".")[0]) || 0;
    if (f.idFrom && num < f.idFrom) return false;
    if (f.idTo && num > f.idTo) return false;
  }
  return true;
}

// Shared comparator covering all SIX directions. Kalibrasi implemented only
// asc/desc, so its four other buttons fell through to an A–Z compare and
// appeared to do nothing.
function _historyComparator(a, b) {
  if (_histSortDir === "date-desc")
    return new Date(b.tanggal_pembelian || 0) - new Date(a.tanggal_pembelian || 0);
  if (_histSortDir === "date-asc")
    return new Date(a.tanggal_pembelian || 0) - new Date(b.tanggal_pembelian || 0);
  if (_histSortDir === "count-desc") return _eventCount(b) - _eventCount(a);
  if (_histSortDir === "count-asc") return _eventCount(a) - _eventCount(b);
  const av = (a[_histSortField] || "").toString().toUpperCase();
  const bv = (b[_histSortField] || "").toString().toUpperCase();
  return _histSortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
}

function renderKalibrasiCards() {
  const container = document.getElementById("history-kalibrasi-container");
  const searchInput = document.getElementById("search-history");
  if (!container) return;

  container.innerHTML = "";

  const searchQ = (searchInput?.value || "").toUpperCase();

  let filtered = _historySummary.filter((item) => {
    if (!item.has_kalibrasi) return false;
    if (!_historySearchMatches(item, searchQ)) return false;
    return _historyFilterMatches(item, _histSortFilters);
  });

  filtered = filtered.sort(_historyComparator);

  if (!filtered.length) {
    renderPagerBar("history-kalibrasi-pager", paginateList("history-kalibrasi", filtered), renderKalibrasiCards);
    container.innerHTML = `<div class="col-span-2 text-center text-gray-400 py-12"><i class="fas fa-ruler-combined text-3xl mb-2 block"></i>Belum ada riwayat kalibrasi.</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();

  // Slice AFTER filter + sort, so paging never reorders the list.
  const _page = paginateList("history-kalibrasi", filtered);
  renderPagerBar("history-kalibrasi-pager", _page, renderKalibrasiCards);

  _page.items.forEach((item) => {
    const r = item.kalibrasi || {};
    const statusClass =
      r.latest_status === "LULUS"
        ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
        : r.latest_status === "GAGAL"
          ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
          : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";

    const card = document.createElement("div");
    card.className =
      "bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-cyan-200 dark:border-cyan-900/30 flex flex-col justify-between hover:border-cyan-500 transition-colors";

    card.innerHTML = `
            <div class="flex flex-col gap-3">
                <div class="flex justify-between items-start border-b dark:border-gray-700 pb-3">
                    <div>
                        <h3 class="text-base font-bold font-mono text-cyan-700 dark:text-cyan-400">${item.id_aset}</h3>
                        <p class="text-xs text-gray-500 dark:text-gray-200 mt-0.5">${item.kode_alat_name || item.kode_alat} — ${item.id_lokasi_name || item.id_lokasi}</p>
                    </div>
                    <span class="text-xs font-bold px-2 py-0.5 rounded-full ${statusClass}"><i class="fas fa-ruler-combined mr-1 text-[9px]"></i>${r.latest_status || "—"}</span>
                </div>
                <div class="space-y-1 text-xs text-gray-600 dark:text-gray-400">
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Waktu Input</span><span class="font-mono">${r.latest_waktu_input ? formatUtcToLocal(r.latest_waktu_input) : "—"}</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Tanggal Kalibrasi</span><span class="font-mono">${r.latest_tanggal_kalibrasi ? formatDateOnly(r.latest_tanggal_kalibrasi) : "—"}</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Tanggal Berlaku</span><span class="font-mono">${r.latest_berlaku ? formatDateOnly(r.latest_berlaku) : "—"}</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Pelaksana</span><span>${r.latest_pelaksana || "—"}</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">No. Sertifikat</span><span>${r.latest_nomor_sertifikat || "—"}</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Catatan</span><span class="italic">${r.latest_keterangan || "—"}</span></div>
                </div>
            </div>
            <button onclick="window.openHistoryDetail('${item.id_aset}', 'kalibrasi')"
                class="mt-4 w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-cyan-600 hover:bg-cyan-700 active:bg-cyan-800 text-white font-semibold rounded-lg transition text-sm shadow-sm">
                <i class="fas fa-list text-sm"></i> Lihat Riwayat Lengkap
            </button>
        `;
    fragment.appendChild(card);
  });

  container.appendChild(fragment);
}

function renderMutasiCards() {
  const container = document.getElementById("history-mutasi-container");
  const searchInput = document.getElementById("search-history");
  if (!container) return;

  container.innerHTML = "";

  const searchQ = (searchInput?.value || "").toUpperCase();

  // Only show assets that have at least one mutation
  let filtered = _historySummary.filter((item) => {
    if (!item.mutasi) return false;
    if (!_historySearchMatches(item, searchQ)) return false;
    return _historyFilterMatches(item, _histSortFilters);
  });

  filtered = filtered.sort(_historyComparator);

  if (!filtered.length) {
    renderPagerBar("history-mutasi-pager", paginateList("history-mutasi", filtered), renderMutasiCards);
    container.innerHTML = `<div class="col-span-2 text-center text-gray-400 py-12"><i class="fas fa-exchange-alt text-3xl mb-2 block"></i>Belum ada riwayat mutasi.</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();

  // Slice AFTER filter + sort, so paging never reorders the list.
  const _page = paginateList("history-mutasi", filtered);
  renderPagerBar("history-mutasi-pager", _page, renderMutasiCards);

  _page.items.forEach((item) => {
    const m = item.mutasi;
    const returnedBadge = m.sudah_kembali
      ? `<span class="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-xs px-2 py-0.5 rounded-full font-bold">✓ Sudah Kembali ke Lokasi Asal</span>`
      : `<span class="bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 text-xs px-2 py-0.5 rounded-full font-bold">⟳ Belum Kembali</span>`;

    const card = document.createElement("div");
    card.className =
      "bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-orange-200 dark:border-orange-900/30 flex flex-col justify-between hover:border-orange-500 transition-colors";
    card.innerHTML = `
            <div class="flex flex-col gap-3">
                <div class="flex justify-between items-start border-b dark:border-gray-700 pb-3">
                    <div>
                        <h3 class="text-base font-bold font-mono text-kai-orange dark:text-orange-400">${item.id_aset}</h3>
                        <p class="text-xs text-gray-500 dark:text-gray-200 mt-0.5">${item.kode_alat_name || item.kode_alat} — ${item.id_lokasi_name || item.id_lokasi}</p>
                    </div>
                    ${returnedBadge}
                </div>
                ${(() => {
                  const asal = resolveLokasi(m.original_lokasi_code || item.id_lokasi);
                  const kini = resolveLokasi(item.id_lokasi_raw || item.id_lokasi);

                  // Lama proses: dihitung dari mutasi terakhir hingga waktu sekarang
                  let lamaProses = "—";
                  if (m.latest_date) {
                    const latestMs = new Date(
                      m.latest_date.replace(" ", "T"),
                    ).getTime();
                    const diffDays = Math.floor(
                      (Date.now() - latestMs) / (1000 * 60 * 60 * 24),
                    );
                    lamaProses =
                      diffDays <= 0 ? "Hari ini" : `${diffDays} hari`;
                  }

                  return `
                <div class="space-y-1 text-xs text-gray-600 dark:text-gray-400">
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Lokasi Asal</span><span class="font-bold text-gray-700 dark:text-gray-200">${asal.parentName} (${asal.uptName !== "—" ? asal.uptName : "—"})</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Lokasi Kini</span><span class="font-bold text-gray-700 dark:text-gray-200">${kini.parentName} (${kini.uptName !== "—" ? kini.uptName : "—"})</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Tanggal Mutasi</span>${m.latest_date ? formatUtcToLocal(m.latest_date) : "—"}</div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Lama Proses</span><span class="font-bold">${lamaProses}</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Nama Petugas</span><span class="font-semibold">${m.latest_oleh || "—"}</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Alasan Mutasi</span><span class="italic">${m.latest_alasan || "—"}</span></div>
                    <div class="flex gap-2"><span class="text-gray-400 w-32 shrink-0">Total Mutasi</span><span class="font-bold">${m.count} kali</span></div>
                </div>`;
                })()}
            </div>
            <button onclick="window.openHistoryDetail('${item.id_aset}', 'mutasi')"
                class="mt-4 w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-kai-orange hover:bg-orange-600 active:bg-orange-700 text-white font-semibold rounded-lg transition text-sm shadow-sm">
                <i class="fas fa-route text-sm"></i> Lihat Timeline Mutasi
            </button>
        `;

    fragment.appendChild(card);
  });

  container.appendChild(fragment);
}
