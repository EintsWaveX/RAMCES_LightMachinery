// ═══════════════════════════════════════════════════════════════════════
// Dashboard > Laporan Perbaikan, including the MCF curve.
//
// Part of the RAMCES frontend. These files are plain classic scripts
// loaded in a fixed order by index.html - no bundler, no modules. They
// share one global scope, so a top-level `let` or `const` declared twice
// across two files is a fatal SyntaxError; see CLAUDE.md.
// ═══════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════
// REPAIR DASHBOARD — Dashboard ▸ Laporan Perbaikan
// ════════════════════════════════════════════════════════════════════
// Moved out of Kelola Inventaris: it reports on the ASSET fleet, not on parts
// stock, so it belongs with the other fleet dashboards. Driven by
// GET /api/aset/dashboard/perbaikan and GET /api/aset/dashboard/mcf, which
// share this panel's Lokasi + Tahun filters.

(function setupRepairDashboard() {
  let _lokasiFilter = "";
  let _tahunFilter = null; // null until the backend resolves a year with data
  // Distinct from `_tahunFilter === null`: that means "let the server pick a
  // default year", this means "aggregate every year". Both send no `year`, so
  // they need a separate flag to stay distinguishable.
  let _semuaTahun = false;
  let _booted = false;

  const el = (id) => document.getElementById(id);

  // ── Filters ───────────────────────────────────────────────────────

  // The user's home region comes from GET /api/me (which resolves a UPT code
  // like JR1.3 up to its DAOP), falling back to the JWT claim if that call
  // fails. Preselected but never locked — every role can browse any region.
  async function resolveDefaultRegion() {
    try {
      const res = await apiFetch("/me");
      if (res.ok) {
        const me = await res.json();
        if (me.default_region) return me.default_region;
      }
    } catch (_) { /* fall through to the token */ }
    const raw = getJwtPayload(authToken)?.id_lokasi || "";
    if (!raw) return "";
    if (lokasiData.some((l) => l.code === raw)) return raw;
    return getParentLokasiCode(raw) || "";
  }

  async function loadLokasiOptions() {
    const sel = el("rd-lokasi");
    if (!sel) return;
    try {
      const res = await apiFetch("/master/lokasi?tipe=DAOP&tipe=DIVRE&tipe=PUSAT&tipe=BALAIYASA");
      if (!res.ok) return;
      const data = await res.json();
      sel.innerHTML = '<option value="">— Semua Lokasi —</option>' +
        data.map((l) => `<option value="${l.id_lokasi}">${l.nama_lokasi}</option>`).join("");
      const preferred = await resolveDefaultRegion();
      if (preferred && data.some((l) => l.id_lokasi === preferred)) {
        sel.value = preferred;
        _lokasiFilter = preferred;
      }
    } catch (_) { /* silent — the report falls back to the global view */ }
  }

  const MIN_TAHUN = 1950;

  // Rebuilt on every response: `available_years` is scope-dependent, so the
  // years that actually hold data change when the region changes. Years with
  // no data stay selectable but are marked, and the current pick is re-snapped
  // if the backend resolved a different year.
  function syncTahunOptions(resolvedYear, availableYears, isAllYears) {
    const sel = el("rd-tahun");
    if (!sel) return;
    const withData = new Set(availableYears || []);
    const oldest = withData.size ? Math.min(...withData) : new Date().getFullYear();
    const maxYear = Math.max(new Date().getFullYear(), resolvedYear || 0, ...withData);

    // "Semua Tahun" aggregates every year server-side (all_years=true) rather
    // than falling back to a default year, and the trend series then carries
    // one point per year instead of per month.
    const opts = ['<option value="">Semua Tahun</option>'];
    for (let y = maxYear; y >= Math.max(MIN_TAHUN, oldest); y--) {
      const has = withData.has(y);
      opts.push(
        `<option value="${y}"${has ? "" : ' class="text-gray-400"'}>${y}${has ? "" : " (kosong)"}</option>`,
      );
    }
    sel.innerHTML = opts.join("");
    sel.value = isAllYears ? "" : String(resolvedYear ?? "");
    _tahunFilter = isAllYears ? null : resolvedYear;
    _semuaTahun = !!isAllYears;
  }

  el("rd-lokasi")?.addEventListener("change", function () {
    _lokasiFilter = this.value;
    // Drop the year so the backend re-resolves the newest year that actually
    // holds data for the new region. Regions have different histories, and
    // carrying the old year over strands the user on an empty report.
    // "Semua Tahun" is a deliberate choice, so it survives a region change.
    if (!_semuaTahun) _tahunFilter = null;
    load();
  });

  el("rd-tahun")?.addEventListener("change", function () {
    _semuaTahun = this.value === "";
    _tahunFilter = _semuaTahun ? null : parseInt(this.value, 10) || null;
    load();
  });

  el("rd-refresh")?.addEventListener("click", () => load());

  // ── Chart handles ─────────────────────────────────────────────────
  let _chartResort = null;
  let _chartAlat = null;
  let _chartResortAll = null;
  let _chartAlatAll = null;
  let _chartTrend = null;
  let _chartPie = null;
  let _chartGauge = null;
  let _chartMcf = null;

  // ── Loader ────────────────────────────────────────────────────────
  async function load() {
    if (!authToken) return;
    const params = new URLSearchParams();
    if (_lokasiFilter) params.set("id_lokasi", _lokasiFilter);
    if (_semuaTahun) params.set("all_years", "true");
    else if (_tahunFilter) params.set("year", String(_tahunFilter));
    try {
      const res = await apiFetch(`/aset/dashboard/perbaikan?${params}`);
      if (!res.ok) {
        showToast("Gagal memuat laporan perbaikan.", "error");
        return;
      }
      render(await res.json());
      // MCF rides the year the repair report actually resolved to, so the two
      // halves of the panel can never disagree about which year is on screen.
      loadMcf();
    } catch (e) {
      console.warn("Repair dashboard load failed:", e);
    }
  }

  async function loadMcf() {
    const canvas = el("rd-chart-mcf");
    if (!canvas) return;
    const params = new URLSearchParams();
    if (_lokasiFilter) params.set("id_lokasi", _lokasiFilter);
    if (_semuaTahun) params.set("all_years", "true");
    else if (_tahunFilter) params.set("year", String(_tahunFilter));
    try {
      const res = await apiFetch(`/aset/dashboard/mcf?${params}`, { background: true });
      if (!res.ok) return;
      renderMcf(await res.json());
    } catch (e) {
      console.warn("MCF load failed:", e);
    }
  }

  function render(d) {
    const t = KAI_VIZ.theme();

    // ── Header ──
    syncTahunOptions(d.tahun, d.available_years, d.all_years);
    if (el("rd-kpi-year"))
      el("rd-kpi-year").textContent = d.all_years ? "Semua Tahun" : (d.tahun ?? "—");
    if (el("rd-region-name"))
      el("rd-region-name").textContent = d.region_label || "Semua Daerah Operasi";
    if (el("rd-dateline")) {
      const now = new Date();
      el("rd-dateline").textContent =
        `${d.kota || "Bandung"}, ${now.getDate()} ${BULAN_PANJANG[now.getMonth()]} ${now.getFullYear()}`;
    }

    // ── KPI strip ──
    if (el("rd-masuk")) el("rd-masuk").textContent = d.masuk ?? "—";
    if (el("rd-sedang")) el("rd-sedang").textContent = d.sedang ?? "—";
    if (el("rd-selesai")) el("rd-selesai").textContent = d.selesai ?? "—";
    if (el("rd-sedang-pct")) {
      // Deliberately NOT a percentage of `masuk`: sedang is a point-in-time
      // count that includes repairs opened in earlier years, so the ratio
      // against a single year's intake is meaningless (and can exceed 100%).
      el("rd-sedang-pct").textContent = d.sedang
        ? `${d.sedang} unit di workshop saat ini`
        : "tidak ada alat di workshop";
    }
    if (el("rd-diafkir")) {
      // Explains why masuk != selesai + sedang: some repairs end in scrapping.
      el("rd-diafkir").textContent = d.diafkir
        ? `${d.diafkir} berakhir afkir`
        : "kembali siap operasi";
    }

    // ── Completion gauge ──
    const pct = Number(d.persen_selesai || 0);
    if (el("rd-gauge-pct")) el("rd-gauge-pct").textContent = `${pct.toFixed(1)}%`;
    const gaugeCanvas = el("rd-chart-gauge");
    if (gaugeCanvas) {
      if (_chartGauge) _chartGauge.destroy();
      // Clamped for the arc only — a carry-over repair closed this year can push
      // the true ratio past 100%, and the ring must not wrap around itself.
      const arc = Math.max(0, Math.min(100, pct));
      _chartGauge = new Chart(gaugeCanvas, {
        type: "doughnut",
        data: {
          labels: ["Selesai", "Belum selesai"],
          datasets: [{
            data: [arc, 100 - arc],
            backgroundColor: [t.series.in, t.track],
            borderWidth: 0,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "72%",
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
        },
      });
    }

    // ── Workshop rail ──
    if (el("rd-workshop-badge")) el("rd-workshop-badge").textContent = d.sedang ?? 0;
    const wBody = el("rd-workshop-body");
    if (wBody) {
      if (!d.workshop_list || !d.workshop_list.length) {
        wBody.innerHTML =
          '<tr><td colspan="3" class="py-8 text-center text-gray-400 italic text-xs">Tidak ada alat sedang diperbaiki</td></tr>';
      } else {
        wBody.innerHTML = d.workshop_list.map((r, i) => `
          <tr class="border-b border-gray-50 dark:border-gray-700/50 hover:bg-amber-50 dark:hover:bg-amber-900/10 transition">
            <td class="px-2 py-1.5 text-gray-400 font-mono align-top">${i + 1}</td>
            <td class="px-2 py-1.5">
              <p class="font-semibold text-gray-700 dark:text-gray-200 leading-tight">${r.nama_alat}</p>
              <p class="text-[9px] text-gray-400">${r.lokasi_label || r.id_lokasi || "—"}</p>
            </td>
            <td class="px-2 py-1.5 text-right font-bold text-amber-600 align-top">${r.jumlah}</td>
          </tr>`).join("");
      }
    }

    // ── Top 10 Resort (grouped IN/OUT) ──
    const resortCanvas = el("rd-chart-resort");
    if (resortCanvas && d.top_resort) {
      if (_chartResort) _chartResort.destroy();
      _chartResort = new Chart(resortCanvas, {
        type: "bar",
        data: {
          labels: d.top_resort.map((r) => r.resort_label || r.resort),
          datasets: KAI_VIZ.inOutDatasets(t, d.top_resort.map((r) => r.masuk), d.top_resort.map((r) => r.selesai)),
        },
        options: KAI_VIZ.groupedBarOptions(t, { rotate: 45 }),
        plugins: [KAI_VIZ.barValueLabels],
      });
    }

    // ── Top 10 Alat (horizontal, single series — bar length carries the value,
    //    so no legend and no categorical hue is spent on identity) ──
    const alatCanvas = el("rd-chart-alat");
    if (alatCanvas && d.top_alat) {
      if (_chartAlat) _chartAlat.destroy();
      _chartAlat = new Chart(alatCanvas, {
        type: "bar",
        data: {
          labels: d.top_alat.map((a) => a.nama_alat),
          datasets: [{
            label: "Jumlah Perbaikan",
            data: d.top_alat.map((a) => a.masuk),
            backgroundColor: t.series.in,
            borderRadius: 4,
            borderSkipped: false,
          }],
        },
        options: {
          indexAxis: "y",
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } }, // single series — the title names it
          scales: {
            x: { ticks: { color: t.text, font: { size: 9 }, precision: 0 }, grid: { color: t.grid }, beginAtZero: true },
            y: {
              ticks: {
                color: t.text,
                font: { size: 9 },
                callback(v) {
                  const s = this.getLabelForValue(v);
                  return s.length > 22 ? s.slice(0, 21) + "…" : s;
                },
              },
              grid: { display: false },
            },
          },
        },
      });
    }

    // ── Full-width: every resort ──
    const resortAll = el("rd-chart-resort-all");
    if (resortAll && d.per_resort) {
      if (_chartResortAll) _chartResortAll.destroy();
      // Widen the scroll container so bars stay legible as resorts multiply.
      const wrap = el("rd-resort-all-wrap");
      if (wrap) wrap.style.minWidth = `${Math.max(720, d.per_resort.length * 46)}px`;
      if (el("rd-resort-count"))
        el("rd-resort-count").textContent = `${d.per_resort.length} resort`;
      _chartResortAll = new Chart(resortAll, {
        type: "bar",
        data: {
          labels: d.per_resort.map((r) => r.resort_label || r.resort),
          datasets: KAI_VIZ.inOutDatasets(t, d.per_resort.map((r) => r.masuk), d.per_resort.map((r) => r.selesai)),
        },
        options: KAI_VIZ.groupedBarOptions(t, { rotate: 55 }),
        plugins: [KAI_VIZ.barValueLabels],
      });
    }

    // ── Full-width: every alat kerja ──
    const alatAll = el("rd-chart-alat-all");
    if (alatAll && d.per_alat) {
      if (_chartAlatAll) _chartAlatAll.destroy();
      const wrap = el("rd-alat-all-wrap");
      if (wrap) wrap.style.minWidth = `${Math.max(720, d.per_alat.length * 56)}px`;
      if (el("rd-alat-count"))
        el("rd-alat-count").textContent = `${d.per_alat.length} jenis alat`;
      _chartAlatAll = new Chart(alatAll, {
        type: "bar",
        data: {
          labels: d.per_alat.map((a) =>
            a.nama_alat.length > 26 ? a.nama_alat.slice(0, 25) + "…" : a.nama_alat,
          ),
          datasets: KAI_VIZ.inOutDatasets(t, d.per_alat.map((a) => a.masuk), d.per_alat.map((a) => a.selesai)),
        },
        options: KAI_VIZ.groupedBarOptions(t, { rotate: 55 }),
        plugins: [KAI_VIZ.barValueLabels],
      });
    }

    // ── Monthly trend (line, matching the report) ──
    const trendCanvas = el("rd-chart-trend");
    if (trendCanvas && d.monthly_trend) {
      if (_chartTrend) _chartTrend.destroy();
      const line = (label, color, data) => ({
        label,
        data,
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        tension: 0.3,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointBackgroundColor: color,
        pointBorderColor: t.surface, // 2px surface ring on overlapping markers
        pointBorderWidth: 2,
      });
      _chartTrend = new Chart(trendCanvas, {
        type: "line",
        data: {
          labels: d.monthly_trend.map((m) => m.bulan),
          datasets: [
            line("Masuk (IN)", t.series.in, d.monthly_trend.map((m) => m.masuk)),
            line("Keluar (OUT)", t.series.out, d.monthly_trend.map((m) => m.selesai)),
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { labels: { color: t.text, font: { size: 10 }, boxWidth: 10, usePointStyle: true } },
          },
          scales: {
            x: { ticks: { color: t.text, font: { size: 9 } }, grid: { display: false } },
            y: { ticks: { color: t.text, font: { size: 9 }, precision: 0 }, grid: { color: t.grid }, beginAtZero: true },
          },
        },
      });
    }

    // ── Composition doughnut + direct-labeled legend ──
    const pieCanvas = el("rd-chart-pie");
    const legEl = el("rd-pie-legend");
    if (pieCanvas && d.by_alat) {
      if (_chartPie) _chartPie.destroy();
      const all = Object.entries(d.by_alat).sort((a, b) => b[1] - a[1]);
      const total = all.reduce((s, [, v]) => s + v, 0);
      // Part-to-whole reads at a glance only up to ~6 wedges; the rest folds
      // into "Lainnya". Nothing is lost — the per-alat bar chart above lists
      // every category individually.
      const top = all.slice(0, 6);
      const rest = all.slice(6).reduce((s, [, v]) => s + v, 0);
      const slices = rest > 0 ? [...top, ["Lainnya", rest]] : top;

      if (!total) {
        pieCanvas.parentElement?.classList.add("hidden");
        if (legEl) legEl.innerHTML =
          '<p class="text-center text-gray-400 italic py-4">Tidak ada data perbaikan</p>';
      } else {
        pieCanvas.parentElement?.classList.remove("hidden");
        _chartPie = new Chart(pieCanvas, {
          type: "doughnut",
          data: {
            labels: slices.map(([k]) => k),
            datasets: [{
              data: slices.map(([, v]) => v),
              backgroundColor: slices.map((_, i) => t.categorical[i]),
              borderWidth: 2,
              borderColor: t.surface,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: "58%",
            plugins: {
              legend: { display: false }, // replaced by the direct-labeled list below
              tooltip: {
                callbacks: {
                  label: (c) => `${c.label}: ${c.parsed} (${((c.parsed / total) * 100).toFixed(1)}%)`,
                },
              },
            },
          },
        });
        // Direct labels satisfy the relief rule for the lighter categorical
        // steps, which sit under 3:1 contrast on a white surface.
        if (legEl) {
          legEl.innerHTML = slices.map(([k, v], i) => `
            <div class="flex items-center gap-2">
              <span class="w-2.5 h-2.5 rounded-sm shrink-0" style="background:${t.categorical[i]}"></span>
              <span class="truncate" title="${k}">${k}</span>
              <span class="ml-auto shrink-0 tabular-nums font-bold text-gray-700 dark:text-gray-200">${((v / total) * 100).toFixed(1)}%</span>
            </div>`).join("");
        }
      }
    }
  }

  // ── MCF curve ─────────────────────────────────────────────────────
  // One measure on one axis. The absolute counts (`kumulatif`, `perbaikan`) are
  // a different scale entirely, so they ride in the tooltip and the stat strip
  // rather than on a second y-axis.
  function renderMcf(d) {
    const t = KAI_VIZ.theme();
    const canvas = el("rd-chart-mcf");
    if (!canvas) return;

    if (el("rd-mcf-risk")) el("rd-mcf-risk").textContent = (d.aset_berisiko ?? 0).toLocaleString("id-ID");
    if (el("rd-mcf-total")) el("rd-mcf-total").textContent = (d.total_perbaikan ?? 0).toLocaleString("id-ID");
    if (el("rd-mcf-akhir")) el("rd-mcf-akhir").textContent = Number(d.mcf_akhir || 0).toFixed(4);
    if (el("rd-mcf-caption")) {
      const periode = d.all_years ? "Semua Tahun" : d.tahun;
      el("rd-mcf-caption").textContent = d.aset_berisiko
        ? `${periode} · ${d.aset_berisiko} unit berisiko`
        : `${periode} · tidak ada aset dalam cakupan`;
    }

    const series = d.series || [];
    if (_chartMcf) _chartMcf.destroy();
    _chartMcf = new Chart(canvas, {
      type: "line",
      data: {
        labels: series.map((s) => s.bulan),
        datasets: [{
          label: "MCF (perbaikan per aset)",
          data: series.map((s) => s.mcf),
          borderColor: t.series.in,
          backgroundColor: t.isDark ? "rgba(16,135,237,0.14)" : "rgba(11,115,202,0.10)",
          borderWidth: 2,
          fill: true,
          tension: 0.25,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: t.series.in,
          pointBorderColor: t.surface,
          pointBorderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false }, // single series — the card title names it
          tooltip: {
            callbacks: {
              label: (c) => `MCF: ${Number(c.parsed.y).toFixed(4)}`,
              afterLabel: (c) => {
                const row = series[c.dataIndex] || {};
                return [
                  `Perbaikan bulan ini: ${row.perbaikan ?? 0}`,
                  `Kumulatif: ${row.kumulatif ?? 0}`,
                ];
              },
            },
          },
        },
        scales: {
          x: { ticks: { color: t.text, font: { size: 9 } }, grid: { display: false } },
          y: {
            ticks: {
              color: t.text,
              font: { size: 9 },
              // 4dp: with a few hundred assets a single month's increment is
              // ~0.003, so fewer decimals would render the curve flat.
              callback: (v) => Number(v).toFixed(3),
            },
            grid: { color: t.grid },
            beginAtZero: true,
          },
        },
      },
    });
  }

  // Charts bake their light/dark colors in at construction, so a theme flip
  // needs a re-render rather than a resize.
  window.addEventListener("kai-theme-change", () => {
    const panel = el("dash-panel-perbaikan");
    if (panel && !panel.classList.contains("hidden")) load();
  });

  // ── Entry point ───────────────────────────────────────────────────
  // Deliberately NOT run at script-eval time: apiFetch throws without a token,
  // so booting before login left the dropdowns and the report silently empty.
  // _renderDashActivePanel() calls this when the tab becomes active.
  window.initRepairDashboard = async function initRepairDashboard() {
    if (!authToken) return;
    if (!_booted) {
      _booted = true;
      await loadLokasiOptions();
    }
    load();
  };
})();
