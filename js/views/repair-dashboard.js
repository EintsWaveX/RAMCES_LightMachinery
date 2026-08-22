// ═══════════════════════════════════════════════════════════════════════
// Dashboard > Laporan Perbaikan, including the MCF curve.
//
// Part of the RAMCES frontend. These files are plain classic scripts
// loaded in a fixed order by index.html - no bundler, no modules. They
// share one global scope, so a top-level `let` or `const` declared twice
// across two files is a fatal SyntaxError; see CLAUDE.md.
// ═══════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════
// REPAIR DASHBOARD, Dashboard ▸ Laporan Perbaikan
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
  // fails. Preselected but never locked, every role can browse any region.
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

  // The Laporan Perbaikan and Kurva MCF tabs each carry their own filter row.
  // There is still exactly one copy of the state (`_lokasiFilter`,
  // `_tahunFilter`, `_semuaTahun`); these helpers just keep both rows showing
  // it, so switching tabs never appears to change the filter.
  const LOKASI_SELECTS = ["rd-lokasi", "rd-mcf-lokasi"];
  const TAHUN_SELECTS = ["rd-tahun", "rd-mcf-tahun"];
  const eachSel = (ids, fn) => ids.forEach((id) => { const e = el(id); if (e) fn(e); });

  async function loadLokasiOptions() {
    if (!el("rd-lokasi") && !el("rd-mcf-lokasi")) return;
    try {
      const res = await apiFetch("/master/lokasi?tipe=DAOP&tipe=DIVRE&tipe=PUSAT&tipe=BALAIYASA");
      if (!res.ok) return;
      const data = await res.json();
      const escL = window.spekEscape;
      const html = '<option value="">— Semua Lokasi —</option>' +
        data.map((l) => `<option value="${escL(l.id_lokasi)}">${escL(l.nama_lokasi)}</option>`).join("");
      eachSel(LOKASI_SELECTS, (e) => { e.innerHTML = html; });
      const preferred = await resolveDefaultRegion();
      if (preferred && data.some((l) => l.id_lokasi === preferred)) {
        _lokasiFilter = preferred;
        eachSel(LOKASI_SELECTS, (e) => { e.value = preferred; });
      }
    } catch (_) { /* silent, the report falls back to the global view */ }
  }

  // Rebuilt on every response: `available_years` is scope-dependent, so the
  // years that hold repair events change when the region changes.
  //
  // Same rule as every client-side year picker (see fillYearSelect in
  // js/views/sort-modals.js): ONLY years with data, each labelled with its
  // count. This used to walk from the oldest year present to the current one
  // and render every gap as a selectable "2019 (kosong)", on a region with two
  // active years that is a column of dead options, and picking one produced an
  // empty report with no explanation.
  //
  // `availableYears` arrives as [{tahun, jumlah}] from _repair_year_counts().
  function syncTahunOptions(resolvedYear, availableYears, isAllYears) {
    if (!el("rd-tahun") && !el("rd-mcf-tahun")) return;

    const rows = (availableYears || []).map((y) =>
      // Tolerate the old bare-number shape so a cached client cannot blank the
      // picker against a newer server, or vice versa.
      typeof y === "number" ? { tahun: y, jumlah: 0 } : y,
    );

    // The resolved year always appears even when it holds nothing, so the box
    // never shows a value that is missing from its own list.
    if (resolvedYear && !rows.some((r) => r.tahun === resolvedYear)) {
      rows.push({ tahun: resolvedYear, jumlah: 0 });
      rows.sort((a, b) => b.tahun - a.tahun);
    }

    // "Semua Tahun" aggregates every year server-side (all_years=true) rather
    // than falling back to a default year, and the trend series then carries
    // one point per year instead of per month.
    const opts = ['<option value="">Semua Tahun</option>'];
    rows.forEach((r) => {
      opts.push(
        `<option value="${r.tahun}">${r.tahun} (${Number(r.jumlah || 0).toLocaleString("id-ID")})</option>`,
      );
    });

    const html = opts.join("");
    const picked = isAllYears ? "" : String(resolvedYear ?? "");
    eachSel(TAHUN_SELECTS, (e) => {
      e.innerHTML = html;
      e.value = picked;
      if (e.selectedIndex < 0) e.selectedIndex = 0;
    });
    _tahunFilter = isAllYears ? null : resolvedYear;
    _semuaTahun = !!isAllYears;
  }

  eachSel(LOKASI_SELECTS, (sel) => {
    sel.addEventListener("change", function () {
      _lokasiFilter = this.value;
      eachSel(LOKASI_SELECTS, (e) => { e.value = _lokasiFilter; });
      // Drop the year so the backend re-resolves the newest year that actually
      // holds data for the new region. Regions have different histories, and
      // carrying the old year over strands the user on an empty report.
      // "Semua Tahun" is a deliberate choice, so it survives a region change.
      if (!_semuaTahun) _tahunFilter = null;
      load();
    });
  });

  eachSel(TAHUN_SELECTS, (sel) => {
    sel.addEventListener("change", function () {
      _semuaTahun = this.value === "";
      _tahunFilter = _semuaTahun ? null : parseInt(this.value, 10) || null;
      eachSel(TAHUN_SELECTS, (e) => { e.value = this.value; });
      load();
    });
  });

  // Both buttons trigger the SAME load() (MCF always rides the year the
  // repair report resolves to, see its own comment below), but unlike the
  // four computed panels' reload button, which _renderDashFilterRow()
  // regenerates from scratch on every render, these two persist across a
  // refresh. So the spin has to be started and stopped explicitly around the
  // same await rather than relying on a fresh unspun node replacing it.
  ["rd-refresh", "rd-mcf-refresh"].forEach((id) =>
    el(id)?.addEventListener("click", async function () {
      const icon = this.querySelector("i");
      this.disabled = true;
      icon?.classList.add("fa-spin");
      try {
        await load();
      } finally {
        icon?.classList.remove("fa-spin");
        this.disabled = false;
      }
    }));

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

  /**
   * MTBF and MTTR tiles, on the Kurva MCF panel.
   *
   * Both are printed in DAYS with hours underneath, because a fleet MTBF of
   * 4,612 hours means nothing to a maintenance planner and 192 days means
   * "roughly twice a year".
   *
   * The note line carries the sample size and, for MTBF, what the average is
   * over. That matters: an asset that has never failed contributes no interval,
   * so MTBF describes the machines that DO break rather than the whole fleet.
   * A bare number invites the opposite reading.
   *
   * `null` (no repairs closed yet, no failures yet) renders an em dash, never
   * "0,0 hari", a reliability metric that reads zero looks like an answer and
   * teaches the reader to ignore the panel.
   */
  function _renderReliability(d) {
    const fmt = (hari, jam) =>
      hari == null ? "—" : `${hari.toLocaleString("id-ID")} hari`;
    const note = (hari, jam, n, apa) =>
      hari == null
        ? "belum ada data"
        : `${jam.toLocaleString("id-ID")} jam · dari ${n.toLocaleString("id-ID")} ${apa}`;

    if (el("rd-mtbf")) el("rd-mtbf").textContent = fmt(d.mtbf_hari, d.mtbf_jam);
    if (el("rd-mtbf-note"))
      el("rd-mtbf-note").textContent = note(
        d.mtbf_hari, d.mtbf_jam, d.mtbf_n, "kerusakan tercatat",
      );
    if (el("rd-mttr")) el("rd-mttr").textContent = fmt(d.mttr_hari, d.mttr_jam);
    if (el("rd-mttr-note"))
      el("rd-mttr-note").textContent = note(
        d.mttr_hari, d.mttr_jam, d.mttr_n, "perbaikan selesai",
      );
  }

  // Replays a small reveal fade on an element whose DOM node is persistent,
  // its textContent is overwritten in place by render()/renderMcf() rather
  // than being freshly inserted, so a plain "animate on mount" CSS keyframe
  // (the kind .dash-panel-fade / .dash-drill-region-body rely on) would only
  // ever play once. Removing the class, forcing a reflow and re-adding it
  // replays it on every call, including a Muat Ulang click, when the panel
  // is already visible and the shared tab-switch fade does not run again.
  // Scoped to #rd-kpi-card / #rd-mcf-card only; see the CSS for why.
  function _replayFade(id) {
    const node = el(id);
    if (!node) return;
    node.classList.remove("rd-panel-refresh");
    void node.offsetWidth; // force reflow so the animation restarts
    node.classList.add("rd-panel-refresh");
  }

  function render(d) {
    const t = KAI_VIZ.theme();
    const esc = window.spekEscape;
    _replayFade("rd-kpi-card");

    // ── Header ──
    syncTahunOptions(d.tahun, d.available_years, d.all_years);
    if (el("rd-kpi-year"))
      el("rd-kpi-year").textContent = d.all_years ? "Semua Tahun" : (d.tahun ?? "—");
    // The letterhead used to live inside this one tab's panel, so five of the
    // six dashboard tabs had no header at all. It now lives in a banner shared
    // above the whole tab strip, and this function only PUBLISHES into it
    // rather than owning it, hence the optional chain: this tab can render
    // before the chrome that defines `setDashBanner` has landed, and a missing
    // banner must be a harmless no-op, never a thrown error that kills the
    // rest of render().
    const now = new Date();
    window.setDashBanner?.({
      sub: d.region_label || "Semua Daerah Operasi",
      dateline: `${d.kota || "Bandung"}, ${now.getDate()} ${BULAN_PANJANG[now.getMonth()]} ${now.getFullYear()}`,
    });

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
    // Sparepart spend, from the parts each repair actually consumed.
    if (el("rd-biaya")) el("rd-biaya").textContent = KAI_VIZ.rupiah(d.biaya_perbaikan || 0);
    if (el("rd-biaya-item")) {
      const n = d.item_terpakai || 0;
      // Named explicitly when nothing has been recorded: a bare "Rp 0" reads as
      // free repairs rather than as parts usage not being logged yet.
      el("rd-biaya-item").textContent = n
        ? `${n} item sparepart terpakai`
        : "belum ada pemakaian tercatat";
    }

    // ── MTBF / MTTR ──
    //
    // Rendered into the Kurva MCF panel, not this one: MCF, MTBF and MTTR are
    // one reliability story and the client's matrix names them together. They
    // ride on THIS payload because `_repair_facts()` computes them off the same
    // single window scan the figures above come from, putting them on the MCF
    // endpoint would have meant a second scan of `riwayat_kondisi` per page.
    _renderReliability(d);

    // ── Completion gauge ──
    const pct = Number(d.persen_selesai || 0);
    if (el("rd-gauge-pct")) el("rd-gauge-pct").textContent = `${pct.toFixed(1)}%`;
    const gaugeCanvas = el("rd-chart-gauge");
    if (gaugeCanvas) {
      if (_chartGauge) _chartGauge.destroy();
      // Clamped for the arc only, a carry-over repair closed this year can push
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
          '<tr><td colspan="3" class="empty-state">Tidak ada alat sedang diperbaiki</td></tr>';
      } else {
        wBody.innerHTML = d.workshop_list.map((r, i) => `
          <tr class="rd-row-reveal border-b border-gray-50 dark:border-gray-700/50 hover:bg-amber-50 dark:hover:bg-amber-900/10 transition">
            <td class="px-2 py-1.5 text-gray-400 font-mono align-top">${i + 1}</td>
            <td class="px-2 py-1.5">
              <p class="font-semibold text-gray-700 dark:text-gray-200 leading-tight">${esc(r.nama_alat)}</p>
              <p class="text-[9px] text-gray-400">${esc(r.lokasi_label || r.id_lokasi || "—")}</p>
            </td>
            <td class="px-2 py-1.5 text-right font-bold text-amber-600 align-top">${r.jumlah}</td>
          </tr>`).join("");
      }
    }

    _renderTopSparepart(d.top_sparepart || []);

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

    // ── Top 10 Alat (horizontal, single series, bar length carries the value,
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
          plugins: { legend: { display: false } }, // single series, the title names it
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
      // into "Lainnya". Nothing is lost, the per-alat bar chart above lists
      // every category individually.
      const top = all.slice(0, 6);
      const rest = all.slice(6).reduce((s, [, v]) => s + v, 0);
      const slices = rest > 0 ? [...top, ["Lainnya", rest]] : top;

      if (!total) {
        pieCanvas.parentElement?.classList.add("hidden");
        if (legEl) legEl.innerHTML =
          '<p class="empty-state">Tidak ada data perbaikan</p>';
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
          // Full label wraps instead of truncating behind a title tooltip,
          // same reasoning as the sparepart rail above: title never fires on
          // touch, and an alat name can run well past what a single line fits.
          legEl.innerHTML = slices.map(([k, v], i) => `
            <div class="flex items-center gap-2 rd-row-reveal">
              <span class="w-2.5 h-2.5 rounded-sm shrink-0" style="background:${t.categorical[i]}"></span>
              <span class="break-words min-w-0 flex-1">${esc(k)}</span>
              <span class="ml-auto shrink-0 tabular-nums font-bold text-gray-700 dark:text-gray-200">${((v / total) * 100).toFixed(1)}%</span>
            </div>`).join("");
        }
      }
    }
  }

  // ── Sparepart terbanyak dipakai ───────────────────────────────────
  // A ranked bar list rather than a chart: eight rows with long Indonesian part
  // names and rupiah figures read better as text with a proportional bar behind
  // them than as an axis that would have to truncate every label.
  function _renderTopSparepart(rows) {
    const mount = el("rd-top-sparepart");
    if (!mount) return;
    if (!rows.length) {
      mount.innerHTML =
        '<p class="empty-state">Belum ada pemakaian sparepart</p>';
      return;
    }
    const max = Math.max(...rows.map((r) => r.nilai || 0), 1);
    const esc = window.spekEscape;
    mount.innerHTML = rows
      .map(
        (r) => `
        <div class="relative rounded-md overflow-hidden rd-row-reveal">
          <div class="absolute inset-y-0 left-0 bg-emerald-100/70 dark:bg-emerald-900/25"
               style="width:${Math.max(4, ((r.nilai || 0) / max) * 100)}%"></div>
          <div class="relative flex items-center justify-between gap-2 px-2 py-1.5">
            <!-- Full name is now always visible (wraps) instead of hidden behind
                 a truncate+title ellipsis — title never fires on touch, and this
                 rail is exactly the kind of screen a technician reads on a
                 phone. -->
            <span class="text-[10px] font-semibold text-gray-700 dark:text-gray-200 break-words min-w-0 flex-1">${esc(r.nama_part)}</span>
            <span class="text-[10px] font-bold text-emerald-700 dark:text-emerald-300 shrink-0 tabular-nums">
              ${r.jumlah}× · ${KAI_VIZ.rupiah(r.nilai)}
            </span>
          </div>
        </div>`,
      )
      .join("");
  }

  // ── MCF curve ─────────────────────────────────────────────────────
  // One measure on one axis. The absolute counts (`kumulatif`, `perbaikan`) are
  // a different scale entirely, so they ride in the tooltip and the stat strip
  // rather than on a second y-axis.
  function renderMcf(d) {
    const t = KAI_VIZ.theme();
    const canvas = el("rd-chart-mcf");
    if (!canvas) return;
    _replayFade("rd-mcf-card");

    if (el("rd-mcf-risk")) el("rd-mcf-risk").textContent = (d.aset_berisiko ?? 0).toLocaleString("id-ID");
    // (MTBF/MTTR are filled by _renderReliability from the perbaikan payload,
    // this endpoint deliberately does not carry them.)
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
          legend: { display: false }, // single series, the card title names it
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
    const visible = ["dash-panel-perbaikan", "dash-panel-mcf"]
      .map(el)
      .some((p) => p && !p.classList.contains("hidden"));
    if (visible) load();
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
