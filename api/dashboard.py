"""
The two repair dashboards: Laporan Perbaikan and the MCF curve.

Both are filled by a single `load()` on the client
(js/views/repair-dashboard.js), so they share `_repair_year_counts` — the
`[{tahun, jumlah}]` shape both year pickers render, which is the server half of
the rule that a year dropdown only offers years that hold data.

Two things here are load-bearing and easy to undo:

- **Balaiyasa is a workshop, never a reporting region.** An asset visits one for
  repair but is never based at one, and the repair still belongs to the
  DAOP/DIVRE that owns the asset. `get_aset_perbaikan_dashboard` drops
  `balaiyasa_lokasi_ids()` from its resort buckets, and scopes `sedang` and
  `workshop_list` by `home_lokasi_expr` — `resolve_home_lokasi()` expressed in
  SQL — while still GROUPING by current position, so the row shows where the
  machine physically is. Keeping the filter and the grouping in step is what
  preserves `sedang == sum(workshop_list[].jumlah)`.
- **`home_lokasi_expr` is deliberately a LOCAL** inside
  `get_aset_perbaikan_dashboard`. Do not promote it to module level: its
  correctness is tied to the surrounding query, not to the expression alone.

`_scoped_repair_events` counts entries INTO the down state
(`kondisi='TSO' AND prev IS DISTINCT FROM 'TSO'`), not every TSO row. Counting
every row broke `masuk == selesai + diafkir + sedang` the moment anyone filed a
second fault report on a machine that was still down.

The LAG window is scanned ONCE per dashboard load. `_scoped_repair_events()`
returns a subquery EXPRESSION, and four `db.execute()` calls against it meant
four scans and four plannings of the same nested query; `_repair_facts()` now
runs it once, grouped by `(bucket, lokasi, alat)`, and the four figures are
summed out of that one result set in Python. Anything added here that needs the
window must read `facts`, not re-execute the subquery.
"""

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import Integer, cast, func, case, extract, select, text as sa_text
from sqlalchemy.orm import Session

import models
from api.deps import (
    balaiyasa_lokasi_ids,
    build_region_labels,
    get_current_user,
    get_db,
    resolve_lokasi_scope,
    short_lokasi_label,
    upt_sort_key,
)
from api.query import pengadaan_values

router = APIRouter()


# ── Aset Perbaikan Dashboard ───────────────────────────────────────

BULAN_SINGKAT = [
    "Jan", "Feb", "Mar", "Apr", "Mei", "Jun",
    "Jul", "Agu", "Sep", "Okt", "Nov", "Des",
]


def _repair_year_counts(db, lokasi_ids):
    """
    Years that hold repair events in this scope, newest first, each with its
    count: [{"tahun": 2025, "jumlah": 623}, ...].

    The count is what makes the year picker honest. The dropdowns used to walk
    from the oldest year present to the current one and label every gap
    "(kosong)"; the client asked for the inverse — only years with data, each
    saying how much. Sending the counts from here means the repair dashboard's
    two pickers show the same shape as every client-side one without
    re-deriving anything.

    Restricted to TSO rows on purpose: without it every PURCHASE year appears,
    because asset creation writes an SO row back-dated to tanggal_pembelian, and
    picking one of those years shows an empty dashboard.
    """
    RK = models.RiwayatKondisi
    AS = models.Aset
    yq = (
        select(
            extract("year", RK.waktu_lapor).label("tahun"),
            func.count().label("jumlah"),
        )
        .select_from(RK)
        .join(AS, AS.id_aset == RK.id_aset)
        .where(RK.kondisi == "TSO")
        .group_by(extract("year", RK.waktu_lapor))
    )
    if lokasi_ids:
        yq = yq.where(func.coalesce(RK.id_lokasi, AS.id_lokasi).in_(lokasi_ids))
    rows = [
        {"tahun": int(r[0]), "jumlah": int(r[1])}
        for r in db.execute(yq)
        if r[0] is not None
    ]
    rows.sort(key=lambda r: r["tahun"], reverse=True)
    return rows


def _repair_events_subquery():
    """
    Every riwayat_kondisi row tagged with the SAME asset's previous kondisi.

        lag(kondisi) OVER (PARTITION BY id_aset ORDER BY waktu_lapor, id_riwayat)

    This window is deliberately UNFILTERED. Filtering by year or lokasi before
    the LAG would break adjacency:
      - a TSO opened in Dec 2025 and closed in Jan 2026 would lose its
        predecessor and stop counting as a completed repair;
      - a repair closes at the Balaiyasa the asset was mutated to, so a lokasi
        pre-filter would sever the open/close pair.
    Filter AFTER the window, never inside it.
    """
    RK = models.RiwayatKondisi
    _order = (RK.waktu_lapor, RK.id_riwayat)
    return select(
        RK.id_aset.label("id_aset"),
        RK.kondisi.label("kondisi"),
        RK.waktu_lapor.label("waktu_lapor"),
        RK.id_lokasi.label("id_lokasi"),
        func.lag(RK.kondisi)
        .over(partition_by=RK.id_aset, order_by=_order)
        .label("prev_kondisi"),
        # The previous row's TIMESTAMP, over the identical window. MTBF and MTTR
        # are both a difference between adjacent events, so they cost one more
        # column on a scan that already happens rather than a scan of their own.
        func.lag(RK.waktu_lapor)
        .over(partition_by=RK.id_aset, order_by=_order)
        .label("prev_waktu"),
    ).subquery("ev")


def _scoped_repair_events(year: int, lokasi_ids):
    """
    The window subquery joined to aset, restricted to `year` and `lokasi_ids`,
    reduced to three flags:

      f_masuk   — a machine ENTERED the down state (kondisi = 'TSO' AND prev <> 'TSO')
      f_selesai — a repair was completed          (kondisi = 'SO'    AND prev = 'TSO')
      f_afkir   — a repair ended in scrapping     (kondisi = 'AFKIR' AND prev = 'TSO')

    `prev_kondisi` is NULL for an asset's first row, and `NULL = 'TSO'` is NULL,
    so the CASE falls through. That is what stops the automatic "Aset Baru" /
    "Pencatatan aset baru" creation rows from inflating `selesai` — no keterangan
    string-matching needed, which matters because the two creation paths write
    different keterangan values.

    ── Why `f_masuk` checks `prev` at all ──
    It used to be a bare `kondisi = 'TSO'`, counting every fault REPORT rather
    than every entry INTO the down state. That silently broke the reconciling
    identity `masuk == selesai + diafkir + sedang`: filing TSO on a machine
    that is already TSO — an ordinary second fault report on a machine still
    awaiting parts — added one to `masuk` while `sedang`, a point-in-time count
    of assets in the state, could not move. `selesai` and `diafkir` were
    already transition-based; `masuk` was the odd one out.

    `IS DISTINCT FROM` rather than `<>`, so the NULL first row still counts:
    an asset whose very first record is TSO did enter the down state.

    The seeded data contains zero consecutive TSO pairs, so this changes no
    existing figure — it stops the identity from breaking once technicians can
    file repeat reports, which recording sparepart usage makes routine.
    """
    ev = _repair_events_subquery()
    AS = models.Aset

    # create_aset writes its seed riwayat row with id_lokasi = NULL; coalesce to
    # the asset's own lokasi so those rows land in a real bucket, not a NULL one.
    eff_lokasi = func.coalesce(ev.c.id_lokasi, AS.id_lokasi).label("eff_lokasi")

    sel = (
        select(
            ev.c.waktu_lapor.label("waktu_lapor"),
            eff_lokasi,
            AS.kode_alat.label("kode_alat"),
            case(
                (
                    (ev.c.kondisi == "TSO")
                    & ev.c.prev_kondisi.is_distinct_from("TSO"),
                    1,
                ),
                else_=0,
            ).label("f_masuk"),
            case(
                ((ev.c.kondisi == "SO") & (ev.c.prev_kondisi == "TSO"), 1), else_=0
            ).label("f_selesai"),
            case(
                ((ev.c.kondisi == "AFKIR") & (ev.c.prev_kondisi == "TSO"), 1), else_=0
            ).label("f_afkir"),
            # ── Durations, for MTTR and MTBF (rev0.4.6) ──
            #
            # Both are the gap between this event and the SAME asset's previous
            # one, in seconds. NULL where the pair does not exist, so SUM skips
            # them rather than counting a zero.
            #
            #   d_repair   TSO -> SO/AFKIR   how long the machine was DOWN
            #   d_uptime   anything -> TSO   how long it was UP before failing
            #
            # `d_uptime` requires prev_kondisi IS NOT NULL, so an asset's very
            # first row contributes nothing — there is no interval before it.
            # The first interval that DOES count is registration -> first
            # failure, i.e. purchase -> first failure, which is real because
            # rev0.4.4 stamps the registration row at tanggal_pembelian rather
            # than at seed time. That is time-to-first-failure, and it belongs
            # in MTBF for a repairable fleet.
            case(
                (
                    ev.c.kondisi.in_(("SO", "AFKIR")) & (ev.c.prev_kondisi == "TSO"),
                    extract("epoch", ev.c.waktu_lapor - ev.c.prev_waktu),
                ),
                else_=None,
            ).label("d_repair"),
            case(
                (
                    (ev.c.kondisi == "TSO")
                    & ev.c.prev_kondisi.is_distinct_from("TSO")
                    & ev.c.prev_kondisi.isnot(None),
                    extract("epoch", ev.c.waktu_lapor - ev.c.prev_waktu),
                ),
                else_=None,
            ).label("d_uptime"),
        )
        .select_from(ev)
        .join(AS, AS.id_aset == ev.c.id_aset)
    )
    # year=None is the "Semua Tahun" case: keep every event. The window above is
    # still unfiltered either way, so open/close adjacency is never broken.
    if year is not None:
        sel = sel.where(extract("year", ev.c.waktu_lapor) == year)
    base = sel.subquery("base")

    scoped = select(base)
    if lokasi_ids:
        scoped = scoped.where(base.c.eff_lokasi.in_(lokasi_ids))
    return scoped.subquery("s")


def _repair_facts(db, year, lokasi_ids):
    """
    ONE pass over the window subquery, grouped finely enough that every figure
    the repair dashboard prints can be summed back out of it in Python.

    ── Why this exists ──
    `_scoped_repair_events()` returns a subquery EXPRESSION, not a result. It
    was consumed by four separate `db.execute()` calls — headline totals, the
    trend series, per-resort and per-alat — so PostgreSQL re-ran the whole
    thing four times per dashboard load, including the deliberately unfiltered
    `LAG` over every row of `riwayat_kondisi`, and planned the nested subquery
    four times as well.

    The cost was invisible while `riwayat_kondisi` held nothing but one
    registration row per asset. Measured at 3,218 rows (`manage.py seed
    --simulasi`), against the local database:

        four separate executes   64 ms (Semua Tahun) · 73 ms (one year)
        this single pass         25 ms               · 19 ms
        rows it returns        1,111                ·  367

    ── The grouping key ──
    `(bucket, eff_lokasi, kode_alat)`, where `bucket` is the YEAR when "Semua
    Tahun" is active and the MONTH otherwise — which is exactly the resolution
    the trend series is drawn at, so no finer key is needed. Every consumer is
    a sum over some projection of that key, so aggregating in Python is exact,
    not an approximation:

        totals      sum over everything
        trend       sum by bucket        (a NULL bucket is dropped, as before)
        per_resort  sum by eff_lokasi    (a NULL lokasi is dropped, as before)
        per_alat    sum by kode_alat, then merged by nama_alat

    The returned row count is bounded by the number of events, and is small:
    grouping the entire fleet's history, all years, is 1,111 tuples.

    Returns [(bucket|None, eff_lokasi, kode_alat, masuk, selesai, afkir)].
    """
    S = _scoped_repair_events(year, lokasi_ids)
    bucket = (
        extract("year", S.c.waktu_lapor)
        if year is None
        else extract("month", S.c.waktu_lapor)
    ).label("bucket")
    rows = db.execute(
        select(
            bucket,
            S.c.eff_lokasi,
            S.c.kode_alat,
            func.coalesce(func.sum(S.c.f_masuk), 0),
            func.coalesce(func.sum(S.c.f_selesai), 0),
            func.coalesce(func.sum(S.c.f_afkir), 0),
            # Seconds. NULL durations are skipped by SUM, so these are totals
            # over the pairs that exist, not over every row in the group.
            func.coalesce(func.sum(S.c.d_repair), 0),
            func.coalesce(func.sum(S.c.d_uptime), 0),
            # ...and the matching DENOMINATORS. `f_selesai + f_afkir` happens to
            # equal the number of d_repair values, but only because a repair
            # closes exactly once — counting the durations directly means the
            # two cannot drift apart if that ever stops being true.
            func.count(S.c.d_repair),
            func.count(S.c.d_uptime),
        ).group_by(bucket, S.c.eff_lokasi, S.c.kode_alat)
    ).all()
    return [
        (
            None if r[0] is None else int(r[0]),
            r[1],
            r[2],
            int(r[3] or 0),
            int(r[4] or 0),
            int(r[5] or 0),
            float(r[6] or 0.0),
            float(r[7] or 0.0),
            int(r[8] or 0),
            int(r[9] or 0),
        )
        for r in rows
    ]


@router.get("/api/aset/dashboard/perbaikan")
def get_aset_perbaikan_dashboard(
    id_lokasi: Optional[str] = None,
    year: Optional[int] = Query(None, ge=1950, le=2100),
    all_years: bool = False,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    Aggregated repair dashboard matching the printed UPT "Laporan Perbaikan
    Alat Kerja" report.

    id_lokasi — DAOP/DIVRE/BALAIYASA code (auto-includes its UPT children), or a
                single UPT code. Omit for a global view.
    year      — defaults to the current year, or the most recent year that has
                data if the current year has none.
    all_years — "Semua Tahun": aggregate every year instead of one. The trend
                series then carries one point per YEAR rather than per month,
                flagged by `trend_mode` so the chart can label its axis.
                Distinct from omitting `year`, which still resolves to a single
                default year.
    """
    RK = models.RiwayatKondisi
    AS = models.Aset
    KA = models.KategoriAlat
    LK = models.Lokasi

    lokasi_ids, parent_row, child_rows = resolve_lokasi_scope(db, id_lokasi)
    region_name, region_label, kota = build_region_labels(parent_row, id_lokasi, db)

    # ── Years that actually contain repair events, within the current scope ──
    # Restricted to TSO rows on purpose: without it, every purchase year appears
    # (asset creation writes an SO row back-dated to tanggal_pembelian) and
    # picking one of those years would show an empty dashboard.
    available_years = _repair_year_counts(db, lokasi_ids)
    years_with_data = [row["tahun"] for row in available_years]

    if all_years:
        year = None
    elif year is None:
        now_year = datetime.now().year
        if now_year in years_with_data or not years_with_data:
            year = now_year
        else:
            year = years_with_data[0]

    # ONE scan of the LAG window, grouped by (bucket, lokasi, alat). The four
    # aggregations below are projections of that one result set — see
    # _repair_facts() for why they are no longer four queries.
    facts = _repair_facts(db, year, lokasi_ids)

    # ── Headline totals ──────────────────────────────────────────────────────
    masuk = sum(f[3] for f in facts)
    selesai = sum(f[4] for f in facts)
    diafkir = sum(f[5] for f in facts)

    # ── Reliability: MTBF and MTTR ───────────────────────────────────────────
    #
    # MTTR — mean time to repair: how long a machine stays DOWN, averaged over
    #        the repairs that actually closed (returned to service or scrapped).
    # MTBF — mean time between failures: how long it stays UP, averaged over the
    #        failures that had a preceding event to measure from.
    #
    # Both come out of `facts`, which is the SAME single window scan the four
    # aggregations above read — see `_repair_facts()`. Adding them to `get_mcf()`
    # instead would have put a second scan of `riwayat_kondisi` on the same page
    # load, which is exactly the cost rev0.4.5 removed.
    #
    # ── Two conventions, both deliberate ──
    # A repair opened in December and closed in January contributes its whole
    # duration to the CLOSING year, because the year filter is applied after the
    # window. That matches how `selesai` is already counted, and the pair is
    # never severed.
    #
    # An asset that has never failed contributes NO interval, so it cannot pull
    # MTBF up. The figure therefore describes the machines that do break, not the
    # fleet — which is what a maintenance planner wants, and what the tile says.
    detik_perbaikan = sum(f[6] for f in facts)
    detik_operasi = sum(f[7] for f in facts)
    n_perbaikan = sum(f[8] for f in facts)
    n_kegagalan = sum(f[9] for f in facts)

    _jam = lambda detik, n: round(detik / n / 3600.0, 1) if n else None
    mttr_jam = _jam(detik_perbaikan, n_perbaikan)
    mtbf_jam = _jam(detik_operasi, n_kegagalan)

    # An asset's HOME region as a SQL expression: `id_lokasi` normally, but the
    # origin of its first mutation while it is away at a Balaiyasa. This is
    # `resolve_home_lokasi()` pushed into the query so the scope filters below
    # can use it per row.
    #
    # Scoping "sedang" by the raw `id_lokasi` meant sending a broken machine to a
    # workshop DELETED it from its own DAOP's under-repair count and moved it
    # under the Balaiyasa — the same misattribution the repair endpoint already
    # guards against, and the reason `masuk` (which is home-attributed) drifted
    # from `selesai + diafkir + sedang` exactly when workshop traffic was high.
    _by_ids = balaiyasa_lokasi_ids(db)
    _mutasi_pertama = (
        select(models.RiwayatMutasi.id_lokasi_asal)
        .where(models.RiwayatMutasi.id_aset == AS.id_aset)
        .order_by(models.RiwayatMutasi.waktu_mutasi.asc())
        .limit(1)
        .correlate(AS)
        .scalar_subquery()
    )
    home_lokasi_expr = (
        case(
            (
                AS.id_lokasi.in_(_by_ids),
                func.coalesce(_mutasi_pertama, AS.id_lokasi),
            ),
            else_=AS.id_lokasi,
        )
        if _by_ids
        else AS.id_lokasi
    )

    # SEDANG is point-in-time (assets currently TSO), not year-scoped — it is a
    # live workshop count, and must agree with sum(workshop_list[].jumlah).
    sedang_q = select(func.count()).select_from(AS).where(
        AS.status_terakhir == "TSO"
    )
    if lokasi_ids:
        sedang_q = sedang_q.where(home_lokasi_expr.in_(lokasi_ids))
    sedang = int(db.execute(sedang_q).scalar_one() or 0)

    persen_selesai = round(selesai / masuk * 100, 1) if masuk else 0.0

    # ── Repair cost, from the parts actually consumed ────────────────────────
    #
    # Scoped by `home_lokasi_expr`, exactly like `sedang` and `workshop_list`
    # above, and for the same reason: a repair carried out at a Balaiyasa
    # belongs to the DAOP that owns the machine. Scoping by the raw
    # `aset.id_lokasi` would move the cost to the workshop the moment the asset
    # was sent there, which is the misattribution this whole file guards against.
    PS = models.PemakaianSparepart
    biaya_q = (
        select(
            func.coalesce(
                func.sum(PS.jumlah * func.coalesce(PS.harga_satuan, 0)), 0
            ),
            func.coalesce(func.sum(PS.jumlah), 0),
        )
        .select_from(PS)
        .join(AS, AS.id_aset == PS.id_aset)
    )
    if year is not None:
        biaya_q = biaya_q.where(extract("year", PS.waktu) == year)
    if lokasi_ids:
        biaya_q = biaya_q.where(home_lokasi_expr.in_(lokasi_ids))
    _biaya_row = db.execute(biaya_q).one()
    biaya_perbaikan, item_terpakai = int(_biaya_row[0] or 0), int(_biaya_row[1] or 0)

    # Which parts this scope burned the most money on. Feeds the "Sparepart
    # Terbanyak Dipakai" list beside the cost tile.
    top_parts_q = (
        select(
            models.SparePart.nama_part,
            func.sum(PS.jumlah).label("qty"),
            func.sum(PS.jumlah * func.coalesce(PS.harga_satuan, 0)).label("nilai"),
        )
        .select_from(PS)
        .join(AS, AS.id_aset == PS.id_aset)
        .join(models.SparePart, models.SparePart.id_part == PS.id_part)
        .group_by(models.SparePart.nama_part)
        .order_by(sa_text("nilai DESC"))
        .limit(8)
    )
    if year is not None:
        top_parts_q = top_parts_q.where(extract("year", PS.waktu) == year)
    if lokasi_ids:
        top_parts_q = top_parts_q.where(home_lokasi_expr.in_(lokasi_ids))
    top_sparepart = [
        {"nama_part": r[0], "jumlah": int(r[1] or 0), "nilai": int(r[2] or 0)}
        for r in db.execute(top_parts_q).all()
    ]

    # ── Trend ────────────────────────────────────────────────────────────────
    # One year selected → 12 monthly points, densified so the line always spans
    # the whole year. "Semua Tahun" → one point per year instead; 12 months
    # summed across a decade would be meaningless (every January added up).
    #
    # `bucket` is already the right resolution for whichever mode is active —
    # the year when "Semua Tahun" is on, the month otherwise.
    b_map = {}
    for bucket, _lok, _alat, mk, sl, *_ in facts:
        if bucket is None:
            continue  # a row with no waktu_lapor belongs to no point on the axis
        prev = b_map.get(bucket, (0, 0))
        b_map[bucket] = (prev[0] + mk, prev[1] + sl)

    if year is None:
        monthly_trend = [
            {
                "bulan": str(y),
                "masuk": b_map[y][0],
                "selesai": b_map[y][1],
            }
            for y in sorted(b_map)
        ]
        trend_mode = "tahun"
    else:
        m_map = b_map
        monthly_trend = [
            {
                "bulan": BULAN_SINGKAT[i],
                "masuk": m_map.get(i + 1, (0, 0))[0],
                "selesai": m_map.get(i + 1, (0, 0))[1],
            }
            for i in range(12)
        ]
        trend_mode = "bulan"

    # ── Per resort (UPT) ─────────────────────────────────────────────────────
    r_map = {}
    for _bucket, lok, _alat, mk, sl, *_ in facts:
        if lok is None:
            continue
        prev = r_map.get(lok, (0, 0))
        r_map[lok] = (prev[0] + mk, prev[1] + sl)

    # A Balaiyasa is a workshop, not an operating region, so it must never be a
    # row in a resort table — "BALAIYASA CIREBONPRUNJAKAN" listed alongside
    # "1.3 Pasarsenen" is what this drops. seed.py now records every repair
    # against the asset's owning region, so in a freshly seeded database this
    # loop finds nothing; it is here so legacy rows written against a workshop
    # cannot reintroduce the leak. The one exception is an explicit Balaiyasa
    # scope, where the workshop IS the subject of the report.
    by_ids = balaiyasa_lokasi_ids(db)
    scope_is_balaiyasa = bool(lokasi_ids) and any(k in by_ids for k in lokasi_ids)
    if not scope_is_balaiyasa:
        r_map = {k: v for k, v in r_map.items() if k not in by_ids}

    # Full list = every resort in scope, zero-filled and positionally ordered
    # (1.1 → 1.25), so the full-width chart shows the whole region like the PDF.
    if child_rows:
        ordered = [l for l in child_rows if (l.tipe or "").upper() == "UPT"] or list(
            child_rows
        )
    else:
        known = {l.id_lokasi: l for l in db.query(LK).all()}
        ordered = [known[k] for k in r_map if k in known]

    per_resort = [
        {
            "resort": l.id_lokasi,
            "resort_label": short_lokasi_label(l.id_lokasi, l.nama_lokasi),
            "masuk": r_map.get(l.id_lokasi, (0, 0))[0],
            "selesai": r_map.get(l.id_lokasi, (0, 0))[1],
        }
        for l in sorted(ordered, key=upt_sort_key)
    ]
    # Buckets that are not a resort in scope (e.g. rows recorded directly against
    # the parent code, or an asset mutated to a Balaiyasa for repair).
    seen_resorts = {p["resort"] for p in per_resort}
    extra_codes = [k for k in r_map if k not in seen_resorts]
    if extra_codes:
        extra_names = {
            l.id_lokasi: l.nama_lokasi
            for l in db.query(LK).filter(LK.id_lokasi.in_(extra_codes)).all()
        }
        for k in extra_codes:
            mk, sl = r_map[k]
            per_resort.append(
                {
                    "resort": k,
                    "resort_label": short_lokasi_label(k, extra_names.get(k)),
                    "masuk": mk,
                    "selesai": sl,
                }
            )

    top_resort = sorted(per_resort, key=lambda x: -x["masuk"])[:10]

    # ── Per alat kerja ───────────────────────────────────────────────────────
    # The name map stands in for the INNER JOIN this used to carry: a kode_alat
    # with no kategori_alat row was dropped from this list (and only this list),
    # and still is. 104 rows, one query — it does not re-scan the window.
    alat_names = dict(
        db.execute(select(KA.kode_alat, KA.nama_alat)).all()
    )
    a_map = {}
    for _bucket, _lok, kode, mk, sl, *_ in facts:
        nama = alat_names.get(kode)
        if nama is None:
            continue
        prev = a_map.get(nama, (0, 0))
        a_map[nama] = (prev[0] + mk, prev[1] + sl)
    per_alat = [
        {"nama_alat": nama, "masuk": v[0], "selesai": v[1]}
        for nama, v in sorted(a_map.items(), key=lambda kv: (-kv[1][0], kv[0]))
    ]
    top_alat = per_alat[:10]
    # Zero-count categories are dropped: a doughnut slice of 0 renders as an
    # invisible wedge with a visible legend entry.
    by_alat = {p["nama_alat"]: p["masuk"] for p in per_alat if p["masuk"] > 0}

    # ── Workshop list (assets currently under repair) ─────────────────────────
    wq = (
        select(KA.nama_alat, AS.id_lokasi, LK.nama_lokasi, func.count().label("jumlah"))
        .select_from(AS)
        .join(KA, KA.kode_alat == AS.kode_alat)
        .outerjoin(LK, LK.id_lokasi == AS.id_lokasi)
        .where(AS.status_terakhir == "TSO")
        .group_by(KA.nama_alat, AS.id_lokasi, LK.nama_lokasi)
        .order_by(func.count().desc(), KA.nama_alat)
    )
    if lokasi_ids:
        # Scoped by home so an asset away at a workshop stays in its owning
        # region's list, but still GROUPED by its current id_lokasi so the row
        # shows where the machine physically is ("BALAIYASA CIREBONPRUNJAKAN").
        # Keeping both in step is what preserves sedang == sum(jumlah).
        wq = wq.where(home_lokasi_expr.in_(lokasi_ids))
    workshop_list = [
        {
            "nama_alat": r[0],
            "id_lokasi": r[1],
            "lokasi_label": short_lokasi_label(r[1], r[2]),
            "jumlah": int(r[3]),
        }
        for r in db.execute(wq)
    ]

    return {
        # None when "Semua Tahun" is active — the client shows the label rather
        # than a number, and re-sends all_years on the next request.
        "tahun": year,
        "all_years": year is None,
        "trend_mode": trend_mode,
        "available_years": available_years,

        "masuk": masuk,
        "sedang": sedang,
        "selesai": selesai,
        # Repairs that ended in scrapping rather than a return to service. Without
        # this the report cannot explain why masuk != selesai + sedang.
        "diafkir": diafkir,
        "persen_selesai": persen_selesai,

        # Reliability. `null` rather than 0.0 when there is nothing to average:
        # a metric that reads "0.0 jam" looks like an answer and teaches the
        # reader to ignore the panel, which is hard to win back.
        "mtbf_jam": mtbf_jam,
        "mttr_jam": mttr_jam,
        "mtbf_hari": round(mtbf_jam / 24.0, 1) if mtbf_jam is not None else None,
        "mttr_hari": round(mttr_jam / 24.0, 1) if mttr_jam is not None else None,
        # The denominators, so the tiles can say what they averaged over rather
        # than presenting a bare number with no sample size.
        "mtbf_n": n_kegagalan,
        "mttr_n": n_perbaikan,

        # Cost of the parts consumed by repairs in this scope. Home-attributed,
        # so a Balaiyasa visit does not move the spend out of the owning DAOP.
        "biaya_perbaikan": biaya_perbaikan,
        "item_terpakai": item_terpakai,
        "top_sparepart": top_sparepart,

        "region_code": id_lokasi or "",
        "region_name": region_name,
        "region_label": region_label,
        "kota": kota,

        "workshop_list": workshop_list,
        "per_resort": per_resort,
        "top_resort": top_resort,
        "per_alat": per_alat,
        "top_alat": top_alat,
        "by_alat": by_alat,
        "monthly_trend": monthly_trend,
    }


# ── The fleet rollup that replaced a client-side copy of the fleet ─

@router.get("/api/aset/dashboard/ringkasan")
def get_aset_ringkasan(
    alat: Optional[str] = None,
    pengadaan: Optional[str] = None,
    tahun: Optional[int] = None,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    Every fleet-wide number the dashboard, the KPI strip and the Kelola Data
    Alat Kerja tiles print — as counts, not as assets.

    ── Why ──
    Four dashboard panels, two stat strips and three modals all reduced an
    in-memory copy of the whole fleet. That copy was the reason the SPA fetched
    1.06 MB at every login: Kelola Data Aset and Pantau Riwayat could page from
    the server, but `db` had to stay whole for these. Every one of them turns
    out to want only SO/TSO counts keyed by something, so one grouped query
    answers all of them and the response stops growing with the fleet.

    Measured on the seeded fleet: 1,077 assets → 1 request, ~6 KB, against
    395 KB for `/api/aset`.

    ── The groupings, and which screen each one feeds ──
      per_lokasi     Matriks Kesiapan, Grafik Ketersediaan, the bar chart —
                     all three key on the asset's CURRENT `id_lokasi`, never
                     the identity location the search uses. They roll UPT up
                     into the parent themselves; the raw per-code counts are
                     sent so that rollup stays exactly where it already is
      per_alat       the "Jenis Alat Kerja" modal and the KDAK alat filter
      per_bulan      Tren Kesiapan — twelve months of one year, by purchase
                     date (the panel reads `waktu_update || tanggal_pembelian`
                     and `/api/aset` has never carried `waktu_update`)
      tahun_counts   the year dropdowns, scoped by alat + pengadaan but NOT by
                     tahun, so the list does not collapse to the year already
                     chosen — same rule as `_renderDashFilterRow`
      bulan_ini      the KDAK "baru bulan ini" tile

    AFKIR is excluded throughout, exactly as `db` was.
    """
    AS = models.Aset

    def scoped(with_tahun: bool):
        conds = [AS.status_terakhir != "AFKIR"]
        if alat:
            conds.append(AS.kode_alat == alat)
        if pengadaan:
            vals = pengadaan_values(db, pengadaan)
            conds.append(AS.sumber_pengadaan.in_(vals or []))
        if with_tahun and tahun:
            conds.append(extract("year", AS.tanggal_pembelian) == tahun)
        return conds

    conds = scoped(with_tahun=True)
    st = func.upper(func.coalesce(AS.status_terakhir, ""))

    def counts_by(*cols):
        rows = db.execute(
            select(*cols, st.label("st"), func.count().label("n"))
            .where(*conds)
            .group_by(*cols, st)
        ).all()
        out = {}
        for r in rows:
            key = r[0] if len(cols) == 1 else tuple(r[: len(cols)])
            slot = out.setdefault(key, {"so": 0, "tso": 0})
            if r[-2] == "SO":
                slot["so"] += int(r[-1])
            elif r[-2] == "TSO":
                slot["tso"] += int(r[-1])
        return out

    per_lokasi = counts_by(AS.id_lokasi)
    per_alat = counts_by(AS.kode_alat)

    y = extract("year", AS.tanggal_pembelian).label("y")
    m = extract("month", AS.tanggal_pembelian).label("m")
    per_bulan = [
        {"tahun": int(k[0]), "bulan": int(k[1]), **v}
        for k, v in counts_by(y, m).items()
        if k[0] is not None and k[1] is not None
    ]

    # Year list: scoped by alat + pengadaan but NOT by the year itself.
    tahun_rows = db.execute(
        select(y, func.count())
        .where(*scoped(with_tahun=False))
        .group_by(y)
    ).all()
    tahun_counts = sorted(
        ({"tahun": int(r[0]), "jumlah": int(r[1])} for r in tahun_rows if r[0] is not None),
        key=lambda r: -r["tahun"],
    )

    so = sum(v["so"] for v in per_lokasi.values())
    tso = sum(v["tso"] for v in per_lokasi.values())

    # The sequence number `create_aset` would mint next, per kode_alat — what
    # the KDAK live id preview prints for the first segment.
    #
    # Deliberately NOT filtered by anything above: it must match `create_aset`'s
    # own rule exactly, which is max over EVERY asset of that kode_alat, AFKIR
    # included. The client used to derive this from its cached fleet, which
    # excludes AFKIR — so a scrapped asset holding the highest number made the
    # preview disagree with the id the server then minted. Answering it here
    # makes the preview exact rather than an estimate.
    urut = func.max(
        case(
            (
                func.split_part(AS.id_aset, ".", 1).op("~")("^[0-9]+$"),
                cast(func.split_part(AS.id_aset, ".", 1), Integer),
            ),
            else_=0,
        )
    )
    urutan_berikutnya = {
        r[0]: int(r[1] or 0) + 1
        for r in db.execute(select(AS.kode_alat, urut).group_by(AS.kode_alat))
    }

    now = datetime.now()
    bulan_ini = int(
        db.execute(
            select(func.count())
            .select_from(AS)
            .where(
                *conds,
                extract("year", AS.tanggal_pembelian) == now.year,
                extract("month", AS.tanggal_pembelian) == now.month,
            )
        ).scalar_one()
        or 0
    )

    return {
        # `total` is so + tso, NOT the row count: the KPI strip has always
        # printed the two states it shows, and a third status appearing in the
        # data must not make the tiles stop adding up.
        "total": so + tso,
        "so": so,
        "tso": tso,
        "jenis_unik": len(per_alat),
        "lokasi_unik": len(per_lokasi),
        "bulan_ini": bulan_ini,
        "per_lokasi": per_lokasi,
        "per_alat": per_alat,
        "per_bulan": per_bulan,
        "tahun_counts": tahun_counts,
        "urutan_berikutnya": urutan_berikutnya,
    }


# ── MCF — Mean Cumulative Function (repair trend) ──────────────────

@router.get("/api/aset/dashboard/mcf")
def get_mcf(
    id_lokasi: Optional[str] = None,
    year: Optional[int] = Query(None, ge=1950, le=2100),
    all_years: bool = False,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    Mean Cumulative Function for the repairable fleet (Nelson-Aalen).

    MCF(t) = cumulative number of repairs up to time t, divided by the number of
    assets at risk. It is the standard reliability curve for REPAIRABLE systems:
    a straight line means a constant failure rate, an upward bend means the fleet
    is degrading, a downward bend means maintenance is winning.

    Reported monthly, alongside the raw cumulative count so the reader can see
    both the normalised rate and the absolute workload.
    """
    RK = models.RiwayatKondisi
    AS = models.Aset

    lokasi_ids, parent_row, _children = resolve_lokasi_scope(db, id_lokasi)
    region_name, region_label, kota = build_region_labels(parent_row, id_lokasi, db)

    # Years that actually hold repair events in this scope. Same rule as the
    # repair dashboard: snapping to a year with data beats defaulting to the
    # calendar year and rendering a flat, empty curve.
    available_years = _repair_year_counts(db, lokasi_ids)
    years_with_data = [row["tahun"] for row in available_years]

    if all_years:
        year = None
    elif year is None:
        now_year = datetime.now().year
        if now_year in years_with_data or not years_with_data:
            year = now_year
        else:
            year = years_with_data[0]

    # Assets at risk = every non-scrapped asset in scope. Denominator of the MCF.
    risk_q = db.query(func.count()).select_from(AS).filter(
        AS.status_terakhir != "AFKIR"
    )
    if lokasi_ids:
        risk_q = risk_q.filter(AS.id_lokasi.in_(lokasi_ids))
    n_at_risk = int(db.execute(risk_q).scalar_one() or 0)

    # Repair events (TSO = a fault opened), bucketed by month within one year or
    # by year across the whole history when "Semua Tahun" is active. The MCF is
    # cumulative either way, so the curve keeps its meaning at both resolutions.
    bucket_col = (
        extract("year", RK.waktu_lapor) if year is None else extract("month", RK.waktu_lapor)
    ).label("b")
    ev_q = (
        select(bucket_col, func.count().label("n"))
        .select_from(RK)
        .join(AS, AS.id_aset == RK.id_aset)
        .where(RK.kondisi == "TSO")
    )
    if year is not None:
        ev_q = ev_q.where(extract("year", RK.waktu_lapor) == year)
    if lokasi_ids:
        ev_q = ev_q.where(func.coalesce(RK.id_lokasi, AS.id_lokasi).in_(lokasi_ids))
    ev_q = ev_q.group_by(bucket_col).order_by(bucket_col)

    per_bucket = {int(r[0]): int(r[1]) for r in db.execute(ev_q) if r[0] is not None}

    if year is None:
        labels = [(y, str(y)) for y in sorted(per_bucket.keys())]
    else:
        labels = [(i + 1, BULAN_SINGKAT[i]) for i in range(12)]

    series = []
    cumulative = 0
    for key, label in labels:
        n = per_bucket.get(key, 0)
        cumulative += n
        series.append({
            "bulan": label,
            "perbaikan": n,
            "kumulatif": cumulative,
            # MCF — repairs per asset. Rounded to 4dp: with a few hundred assets
            # a single month's increment is ~0.003, so 2dp would flatten the curve.
            "mcf": round(cumulative / n_at_risk, 4) if n_at_risk else 0.0,
        })

    return {
        "tahun": year,
        "all_years": year is None,
        "trend_mode": "tahun" if year is None else "bulan",
        "available_years": available_years,
        "aset_berisiko": n_at_risk,
        "total_perbaikan": cumulative,
        "mcf_akhir": round(cumulative / n_at_risk, 4) if n_at_risk else 0.0,
        "region_code": id_lokasi or "",
        "region_name": region_name,
        "region_label": region_label,
        "kota": kota,
        "series": series,
    }
