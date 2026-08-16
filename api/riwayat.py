"""
Condition reports, repairs, the history summary and the streaming exports.

**A repair consumes parts in ONE transaction.** `catat_perbaikan` takes a
`pemakaian: [...]` array on the SAME request body as the condition report, and
`_record_pemakaian` writes both before a single commit. Everything about that is
deliberate:

- One transaction, one commit. A short stock rolls the condition report back
  rather than recording a repair that consumed nothing — and equally, a failed
  report cannot have already taken parts out of the warehouse. The `db.flush()`
  inside `_record_pemakaian` is what makes it possible: `id_riwayat` is a serial
  and does not exist until the INSERT is issued.
- Quantities are summed per (part, gudang) BEFORE the check. Two lines for the
  same part in one submit must be checked against their combined total; one at a
  time would let 2 × 6 units pass against a stock of 10.
- It never computes stock itself. `_net_stok_map` is imported from
  api/inventaris.py — the same map the standalone movement endpoint uses — and
  each row points at the OUT movement it wrote via `id_stok`, so
  `sparepart_stok` stays the single source of truth.
- It broadcasts BOTH `REFRESH_ASSET_LIST` and `REFRESH_INVENTARIS`: the ledger
  changed, and inventory clients otherwise never learn.

**Balaiyasa is a workshop, never a reporting region.** `POST /api/perbaikan`
rewrites a workshop `id_lokasi` to `resolve_home_lokasi()` before inserting, so
a repair carried out at a Balaiyasa still belongs to the DAOP/DIVRE that owns
the asset.

Note `catat_perbaikan` carries TWO route decorators — `/api/perbaikan` and
`/api/riwayat-kondisi` — on one function. Both must survive any move.

The exports are `StreamingResponse` over a row-at-a-time JSON generator, and
they open their OWN `SessionLocal()`: a `Depends(get_db)` generator is closed
when the endpoint returns, which for a streaming response is before the body has
been produced. The wire format is byte-identical to the pre-streaming version,
so no client changed.
"""

import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from datetime import date, timedelta

from sqlalchemy import exists, func, select
from sqlalchemy.orm import Session, joinedload

import models
from database import SessionLocal
from api.deps import (
    MAX_PAGE,
    assert_aset_region_scope,
    balaiyasa_lokasi_ids,
    get_current_user,
    get_db,
    require_role,
    resolve_home_lokasi,
)
from api.inventaris import _net_stok_map
from api.query import (
    apply_aset_filters,
    apply_aset_sort,
    history_extra_conditions,
)
from api.realtime import manager
from api.schemas import PerbaikanCreate

router = APIRouter()


@router.post("/api/perbaikan")
@router.post("/api/riwayat-kondisi")
async def catat_perbaikan(
    laporan: PerbaikanCreate,
    db: Session = Depends(get_db),
    # TEKNISI keeps this, and keeps the `pemakaian` array that rides on the
    # same body. Consuming parts DURING a repair is the field task and is bound
    # to a riwayat_kondisi row, unlike the free adjustment at
    # POST /api/inventaris/stok which moved to PETUGAS_GUDANG in rev0.5.2.
    # Tightening this to exclude TEKNISI would break the one-transaction
    # contract this handler exists for — and taking stock-write away there
    # while leaving this open would make that restriction cosmetic anyway.
    current_user: models.Pengguna = Depends(
        require_role(["SUPER_ADMIN", "ADMIN_WILAYAH", "TEKNISI"])
    ),
):
    aset = db.query(models.Aset).filter_by(id_aset=laporan.id_aset).first()
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")

    # A condition report rewrites `aset.status_terakhir`, so it is a mutation and
    # falls under the same regional limit as editing or transferring. TEKNISI is
    # deliberately unscoped here — condition reporting is its whole job, and it
    # files against whichever asset it has physically been sent to.
    assert_aset_region_scope(
        db, current_user, aset,
        "Hanya bisa melaporkan kondisi aset dari wilayah Anda.",
    )

    # # NORMALISASI INPUT PERUNTUKAN DI SINI
    # if laporan.peruntukan:
    #     p_val = laporan.peruntukan.strip().upper()
    #     # Pemetaan ketat jika frontend mengirimkan A, B, C, D alih-alih teks penuh
    #     peruntukan_map = {
    #         "a": "JALAN REL",
    #         "b": "JEMBATAN",
    #         "c": "MEKANIK",
    #         "d": "BALAIYASA",
    #     }
    #     # Gunakan mapping, atau gunakan nilai aslinya jika sudah berupa teks penuh
    #     aset.peruntukan = peruntukan_map.get(p_val, p_val)

    # Normalise peruntukan for per-row storage (accepts A/B/C/D or full text)
    peruntukan_row = None
    if laporan.peruntukan:
        p_val = laporan.peruntukan.strip().upper()
        peruntukan_map_row = {
            "A": "JALAN REL", "B": "JEMBATAN", "C": "MEKANIK", "D": "BALAIYASA",
            "JALAN REL": "JALAN REL", "JEMBATAN": "JEMBATAN", "MEKANIK": "MEKANIK", "BALAIYASA": "BALAIYASA"
        }
        peruntukan_row = peruntukan_map_row.get(p_val, laporan.peruntukan.upper())

    # Resolve lokasi: prefer the sent id_lokasi, fall back to aset's current lokasi
    id_lokasi_row = laporan.id_lokasi or aset.id_lokasi

    # A repair carried out at a Balaiyasa still belongs to the region that owns
    # the asset. Stamping the workshop here is what used to make Laporan
    # Perbaikan grow a "BALAIYASA …" row and under-count every DAOP's completed
    # repairs, since the closing row fell outside the DAOP's lokasi scope.
    if id_lokasi_row and id_lokasi_row in balaiyasa_lokasi_ids(db):
        id_lokasi_row = resolve_home_lokasi(db, aset) or id_lokasi_row

    riwayat = models.RiwayatKondisi(
        id_aset=laporan.id_aset,
        id_pengguna=current_user.id_pengguna,
        kondisi=laporan.kondisi,
        keterangan=laporan.keterangan,
        id_lokasi=id_lokasi_row,
        peruntukan=peruntukan_row,
    )
    db.add(riwayat)
    aset.status_terakhir = laporan.kondisi

    # ── Spareparts consumed by this repair ──────────────────────────
    #
    # Deliberately inside the SAME transaction as the condition report. A short
    # stock must roll the report back rather than leave a repair on record that
    # consumed nothing — and equally, a failed report must not have already
    # taken parts out of the warehouse.
    #
    # `flush()` is what makes it work: RiwayatKondisi.id_riwayat is a serial and
    # does not exist until the INSERT is issued, and PemakaianSparepart needs it.
    dipakai = _record_pemakaian(db, riwayat, aset, laporan.pemakaian, current_user)

    db.commit()

    await manager.broadcast("REFRESH_ASSET_LIST")
    if dipakai:
        # The ledger changed too. Without this, every Kelola Inventaris tab
        # open elsewhere keeps showing the pre-repair stock until it is
        # reloaded by hand.
        await manager.broadcast("REFRESH_INVENTARIS")

    return {
        "message": "Laporan kondisi berhasil dicatat.",
        "id_riwayat": riwayat.id_riwayat,
        "pemakaian": dipakai,
    }


def _record_pemakaian(db, riwayat, aset, items, current_user) -> list:
    """
    Write the OUT movements and the pemakaian rows for one repair.

    Does NOT commit — the caller owns the transaction, which is the whole point
    (see catat_perbaikan). Returns a summary list for the response.

    Stock sufficiency is checked with the same `_net_stok_map()` the standalone
    movement endpoint uses, rather than a second implementation that could
    disagree about which movement types count.
    """
    if not items:
        return []

    # Quantities first, so two lines for the same part in one submit are
    # checked against their COMBINED total. Checking them one at a time would
    # let 2 × 6 units pass against a stock of 10.
    wanted: dict = {}
    for it in items:
        if it.jumlah is None or it.jumlah <= 0:
            raise HTTPException(
                status_code=400, detail="Jumlah pemakaian harus lebih dari nol."
            )
        wanted[(it.id_part, it.id_gudang)] = (
            wanted.get((it.id_part, it.id_gudang), 0) + it.jumlah
        )

    # One net-stock query per distinct warehouse, not per line.
    stok_by_gudang: dict = {}
    for _part, id_gudang in wanted:
        if id_gudang not in stok_by_gudang:
            stok_by_gudang[id_gudang] = _net_stok_map(db, id_gudang=id_gudang)

    parts = {
        p.id_part: p
        for p in db.query(models.SparePart)
        .filter(models.SparePart.id_part.in_({p for p, _ in wanted}))
        .all()
    }

    for (id_part, id_gudang), total in wanted.items():
        part = parts.get(id_part)
        if not part:
            raise HTTPException(
                status_code=404, detail=f"Sparepart id {id_part} tidak ditemukan."
            )
        if id_gudang is not None and not db.query(models.Gudang).filter_by(
            id_gudang=id_gudang
        ).first():
            raise HTTPException(status_code=404, detail="Gudang tidak ditemukan.")
        tersedia = stok_by_gudang[id_gudang].get(id_part, 0)
        if total > tersedia:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Stok {part.nama_part} tidak mencukupi. "
                    f"Tersedia {tersedia} {part.unit}, diminta {total}."
                ),
            )

    db.flush()  # riwayat.id_riwayat

    summary = []
    for it in items:
        part = parts[it.id_part]
        harga = part.harga_satuan
        gerak = models.SparePartStok(
            id_part=it.id_part,
            id_gudang=it.id_gudang,
            tipe_gerakan="OUT",
            jumlah=it.jumlah,
            harga_satuan=harga,
            keterangan=f"Pemakaian perbaikan {aset.id_aset}",
            id_pengguna=current_user.id_pengguna,
        )
        db.add(gerak)
        db.flush()  # gerak.id_stok

        db.add(
            models.PemakaianSparepart(
                id_riwayat=riwayat.id_riwayat,
                id_aset=aset.id_aset,
                id_part=it.id_part,
                id_stok=gerak.id_stok,
                id_gudang=it.id_gudang,
                jumlah=it.jumlah,
                harga_satuan=harga,
                keterangan=it.keterangan,
            )
        )
        summary.append(
            {
                "id_part": it.id_part,
                "nama_part": part.nama_part,
                "jumlah": it.jumlah,
                "harga_satuan": harga or 0,
                "subtotal": (harga or 0) * it.jumlah,
            }
        )
    return summary

@router.get("/api/riwayat-kondisi/{id_aset}")
def get_riwayat_aset(
    id_aset: str,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    riwayat = (
        db.query(models.RiwayatKondisi)
        # The row loop reads pengguna_ref.username and lokasi_ref.nama_lokasi;
        # without these that was two queries per history row on a screen users
        # open constantly.
        .options(
            joinedload(models.RiwayatKondisi.pengguna_ref),
            joinedload(models.RiwayatKondisi.lokasi_ref),
        )
        .filter(
            models.RiwayatKondisi.id_aset == id_aset,
            models.RiwayatKondisi.kondisi != "KALIBRASI",
        )
        .order_by(models.RiwayatKondisi.waktu_lapor.asc())
        .all()
    )
    
    return [
        {
            "no": i,
            # Needed to attach each row's sparepart usage — /api/aset/{id}/pemakaian
            # groups by exactly this key.
            "id_riwayat": r.id_riwayat,
            "waktu_lapor": r.waktu_lapor.strftime("%Y-%m-%d %H:%M:%S")
            if r.waktu_lapor
            else None,
            "id_pengguna": r.pengguna_ref.username if r.pengguna_ref else r.id_pengguna,
            "kondisi": r.kondisi,
            "keterangan": r.keterangan or "—",
            "id_lokasi": r.id_lokasi or "",
            "nama_lokasi": r.lokasi_ref.nama_lokasi if r.lokasi_ref else (r.id_lokasi or "—"),
            "peruntukan": r.peruntukan or "",
        }
        for i, r in enumerate(riwayat, start=1)
    ]


@router.get("/api/history/summary")
def get_history_summary(
    id_aset: Optional[str] = None,
    limit: Optional[int] = Query(None, ge=1, le=MAX_PAGE),
    offset: int = Query(0, ge=0),
    # ── The Pantau Riwayat filter set, added in rev0.4.5 ──
    q: Optional[str] = None,
    alat: Optional[str] = None,
    pengadaan: Optional[str] = None,
    peruntukan: Optional[str] = None,
    lokasi: Optional[str] = None,
    upt: Optional[str] = None,
    status: Optional[str] = None,
    tahun_from: Optional[int] = None,
    tahun_to: Optional[int] = None,
    id_from: Optional[int] = None,
    id_to: Optional[int] = None,
    punya: Optional[str] = None,
    jatuh_tempo_hari: int = Query(30, ge=1, le=365),
    sort: Optional[str] = None,
    dir: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    Per-asset rollup of repair / calibration / mutation history.

    `id_aset` narrows the response to a single asset. The QR landing page needs
    exactly one row, and without this parameter it downloaded the entire fleet
    summary — 98.6 KB at 200 assets, megabytes at scale — and then `.find()`-ed
    one entry out of it, four times per page view, on a phone in the field.

    Returns the standard {total, limit, offset, items} envelope. This is the
    heaviest response the app produces per asset (~636 B against ~366 B for
    /api/aset), so it is the one that most needed paging: every one of the six
    batch queries below is scoped to the ids on the CURRENT PAGE, which is what
    makes the cost proportional to the page rather than to the fleet.

    ── Filtering, added in rev0.4.5 ──
    Pantau Riwayat now renders from a page of this endpoint rather than from a
    client-side copy of the whole fleet, so the filters have to be exact. They
    are the same set `/api/aset` takes and go through the same `api/query.py`
    port of `js/search.js` — plus two things only this screen has:

      q       also matches the eleven fields the history CARDS show and the
              asset payload does not: the technician who filed the last report,
              the certificate number and pelaksana, the reason for the last
              transfer, the origin it was transferred from
      punya   the tab gate. 'kalibrasi' keeps assets with a calibration record
              (the client's `has_kalibrasi`), 'mutasi' keeps assets with a
              transfer (its `item.mutasi` truthiness), and
              'kalibrasi-jatuh-tempo' narrows the first of those to the ones
              whose certificate has expired or is within `jatuh_tempo_hari`
              days of doing so. Absent keeps everything, which is the
              Perbaikan tab.

    `id_aset` bypasses all of it: landing.html asks for one row by name.
    """
    from sqlalchemy.orm import joinedload
    from sqlalchemy import func

    # Batch load all assets with their relationships
    base = (
        db.query(models.Aset)
        .options(joinedload(models.Aset.kategori), joinedload(models.Aset.lokasi_ref))
        .filter(models.Aset.status_terakhir != "AFKIR")
    )
    if id_aset:
        base = base.filter(models.Aset.id_aset == id_aset)
    else:
        base = apply_aset_filters(
            base,
            db,
            q=q,
            alat=alat,
            pengadaan=pengadaan,
            peruntukan=peruntukan,
            lokasi=lokasi,
            upt=upt,
            status=status,
            tahun_from=tahun_from,
            tahun_to=tahun_to,
            id_from=id_from,
            id_to=id_to,
            extra_q=history_extra_conditions,
        )
        if punya == "kalibrasi":
            base = base.filter(
                exists().where(
                    models.RiwayatKalibrasi.id_aset == models.Aset.id_aset
                )
            )
        elif punya == "kalibrasi-jatuh-tempo":
            # The actionable subset of the Kalibrasi tab: assets whose LATEST
            # certificate has expired or is about to.
            #
            # "Latest" is the same row_number the summary payload and
            # `_card_facts()` pick, so the list and the badge on each card can
            # never name different records. The comparison is against a
            # correlated MAX rather than a join, because a join to the latest
            # row would need the whole row_number subquery inlined into a
            # filter — this asks the narrower question directly.
            RKAL = models.RiwayatKalibrasi
            terbaru = (
                select(func.max(RKAL.tanggal_berlaku))
                .where(RKAL.id_aset == models.Aset.id_aset)
                .correlate(models.Aset)
                .scalar_subquery()
            )
            base = base.filter(
                terbaru.isnot(None),
                terbaru <= date.today() + timedelta(days=jatuh_tempo_hari),
            )
        elif punya == "mutasi":
            base = base.filter(
                exists().where(models.RiwayatMutasi.id_aset == models.Aset.id_aset)
            )

    # Same stable ordering as /api/aset, for the same reason: without it a paged
    # view can receive one row twice and another never.
    total = base.order_by(None).count()
    base = (
        apply_aset_sort(base, sort, dir)
        if (sort or dir)
        else base.order_by(models.Aset.id_aset)
    )
    if limit is not None:
        base = base.limit(limit).offset(offset)
    asets = base.all()

    envelope = {"total": total, "limit": limit, "offset": offset}

    if not asets:
        return {**envelope, "items": []}

    aset_ids = [a.id_aset for a in asets]

    # Batch load latest repair per asset using window function approach
    latest_repair_subq = (
        db.query(
            models.RiwayatKondisi.id_aset,
            models.RiwayatKondisi.kondisi,
            models.RiwayatKondisi.keterangan,
            models.RiwayatKondisi.waktu_lapor,
            models.RiwayatKondisi.id_pengguna,
            models.RiwayatKondisi.id_lokasi,
            func.row_number()
            .over(
                partition_by=models.RiwayatKondisi.id_aset,
                order_by=models.RiwayatKondisi.waktu_lapor.desc(),
            )
            .label("rn"),
        )
        .filter(models.RiwayatKondisi.id_aset.in_(aset_ids))
        .subquery()
    )

    latest_repairs = (
        db.query(latest_repair_subq).filter(latest_repair_subq.c.rn == 1).all()
    )
    repair_map = {r.id_aset: r for r in latest_repairs}

    # How many repair events each asset has had. The frontend's "urutkan by
    # jumlah perbaikan" had nothing to sort on: the summary carries one row per
    # asset, so counting rows client-side always returned 1. Only TSO rows count
    # — an SO row is a repair being CLOSED, and counting both double-counts every
    # completed job.
    repair_count_map = {
        r[0]: int(r[1] or 0)
        for r in db.query(
            models.RiwayatKondisi.id_aset, func.count()
        )
        .filter(
            models.RiwayatKondisi.id_aset.in_(aset_ids),
            models.RiwayatKondisi.kondisi == "TSO",
        )
        .group_by(models.RiwayatKondisi.id_aset)
        .all()
    }

    # Batch load all mutasi for these assets
    all_mutasi = (
        db.query(models.RiwayatMutasi)
        .options(
            joinedload(models.RiwayatMutasi.lokasi_asal),
            joinedload(models.RiwayatMutasi.lokasi_tujuan),
            joinedload(models.RiwayatMutasi.pengguna_ref),
        )
        .filter(models.RiwayatMutasi.id_aset.in_(aset_ids))
        .order_by(models.RiwayatMutasi.waktu_mutasi.asc())
        .all()
    )

    # Group mutasi by asset
    mutasi_map = {}
    for m in all_mutasi:
        if m.id_aset not in mutasi_map:
            mutasi_map[m.id_aset] = []
        mutasi_map[m.id_aset].append(m)

    # Batch load pengguna for repairs
    pengguna_ids = list(set(r.id_pengguna for r in latest_repairs if r.id_pengguna))
    pengguna_map = {}
    if pengguna_ids:
        penggunas = (
            db.query(models.Pengguna)
            .filter(models.Pengguna.id_pengguna.in_(pengguna_ids))
            .all()
        )
        pengguna_map = {p.id_pengguna: p for p in penggunas}

    # Calibration: scoped to the assets in this response, ordered so the LAST
    # element of each list is the latest.
    #
    # This was `db.query(models.RiwayatKalibrasi).all()` — every calibration row
    # ever written, including for the AFKIR assets excluded 200 lines above,
    # fully hydrated into ORM objects, on every request, just to keep the newest
    # one per asset. It was the only un-batched query in an otherwise carefully
    # batched endpoint.
    kalibrasi_map = {}
    if aset_ids:
        kal_q = (
            db.query(models.RiwayatKalibrasi)
            .filter(models.RiwayatKalibrasi.id_aset.in_(aset_ids))
            .order_by(
                models.RiwayatKalibrasi.id_aset,
                models.RiwayatKalibrasi.tanggal_kalibrasi.asc(),
                models.RiwayatKalibrasi.waktu_input.asc(),
            )
        )
        for kal in kal_q.yield_per(2000):
            kalibrasi_map.setdefault(kal.id_aset, []).append(kal)

    results = []
    for a in asets:
        latest_repair = repair_map.get(a.id_aset)
        all_mutasi_for_a = mutasi_map.get(a.id_aset, [])
        latest_mutasi = all_mutasi_for_a[-1] if all_mutasi_for_a else None
        all_kalibrasi_for_a = kalibrasi_map.get(a.id_aset, [])
        latest_kalibrasi = all_kalibrasi_for_a[-1] if all_kalibrasi_for_a else None

        results.append(
            {
                "id_aset": a.id_aset,
                # Same field contract as GET /api/aset: kode_alat is the CODE and
                # kode_alat_name the display name. This used to return the NAME in
                # `kode_alat`, which made the history sort modal's alat filter (a
                # code-valued dropdown) match nothing at all.
                "kode_alat": a.kode_alat,
                "kode_alat_name": a.kategori.nama_alat if a.kategori else a.kode_alat,
                "id_lokasi": a.id_lokasi,
                "peruntukan": a.peruntukan,
                # Needed by the history sort modal's Pengadaan + Tahun Beli filters,
                # which previously read undefined and silently dropped every row.
                "sumber_pengadaan": a.sumber_pengadaan,
                "tanggal_pembelian": str(a.tanggal_pembelian)
                if a.tanggal_pembelian
                else None,
                "id_lokasi_name": a.lokasi_ref.nama_lokasi
                if a.lokasi_ref
                else a.id_lokasi,
                "status_terakhir": a.status_terakhir,
                "repair": {
                    "count": repair_count_map.get(a.id_aset, 0),
                    "latest_date": latest_repair.waktu_lapor.strftime(
                        "%Y-%m-%d %H:%M:%S"
                    )
                    if latest_repair and latest_repair.waktu_lapor
                    else None,
                    "latest_kondisi": latest_repair.kondisi
                    if latest_repair
                    else a.status_terakhir,
                    "latest_keterangan": latest_repair.keterangan
                    if latest_repair
                    else None,
                    "latest_teknisi": pengguna_map.get(
                        latest_repair.id_pengguna
                    ).username
                    if latest_repair and latest_repair.id_pengguna in pengguna_map
                    else (str(latest_repair.id_pengguna) if latest_repair else None),
                    # app.js reads this to show where the last report was filed;
                    # the column had been commented out of the subquery, so the
                    # field was always undefined on the client.
                    "latest_id_lokasi": latest_repair.id_lokasi
                    if latest_repair
                    else None,
                },
                "has_kalibrasi": bool(all_kalibrasi_for_a),
                "kalibrasi": {
                    "latest_date": latest_kalibrasi.tanggal_kalibrasi.strftime(
                        "%Y-%m-%d"
                    )
                    if latest_kalibrasi and latest_kalibrasi.tanggal_kalibrasi
                    else None,
                    "latest_tanggal_kalibrasi": latest_kalibrasi.tanggal_kalibrasi.strftime(
                        "%Y-%m-%d"
                    )
                    if latest_kalibrasi and latest_kalibrasi.tanggal_kalibrasi
                    else None,
                    "latest_berlaku": latest_kalibrasi.tanggal_berlaku.strftime(
                        "%Y-%m-%d"
                    )
                    if latest_kalibrasi and latest_kalibrasi.tanggal_berlaku
                    else None,
                    "latest_waktu_input": latest_kalibrasi.waktu_input.strftime(
                        "%Y-%m-%d %H:%M:%S"
                    )
                    if latest_kalibrasi and latest_kalibrasi.waktu_input
                    else None,
                    "latest_status": latest_kalibrasi.status if latest_kalibrasi else None,
                    "latest_pelaksana": latest_kalibrasi.pelaksana_kalibrasi
                    if latest_kalibrasi and latest_kalibrasi.pelaksana_kalibrasi
                    else (
                        pengguna_map.get(latest_kalibrasi.id_pengguna).username
                        if latest_kalibrasi and latest_kalibrasi.id_pengguna in pengguna_map
                        else None
                    ),
                    "latest_nomor_sertifikat": latest_kalibrasi.nomor_sertifikat
                    if latest_kalibrasi
                    else None,
                    "latest_keterangan": latest_kalibrasi.keterangan
                    if latest_kalibrasi
                    else None,
                    # Basename of the uploaded certificate, or None. The Riwayat
                    # cards use it to show an attachment indicator without
                    # re-fetching /api/kalibrasi/{id_aset} per card.
                    "latest_id_kalibrasi": latest_kalibrasi.id_kalibrasi
                    if latest_kalibrasi
                    else None,
                    "latest_file_sertifikat": latest_kalibrasi.file_sertifikat
                    if latest_kalibrasi
                    else None,
                }
                if latest_kalibrasi
                else None,
                "mutasi": {
                    "count": len(all_mutasi_for_a),
                    "latest_date": latest_mutasi.waktu_mutasi.strftime(
                        "%Y-%m-%d %H:%M:%S"
                    )
                    if latest_mutasi and latest_mutasi.waktu_mutasi
                    else None,
                    "latest_lokasi_tuju": latest_mutasi.lokasi_tujuan.nama_lokasi
                    if latest_mutasi and latest_mutasi.lokasi_tujuan
                    else None,
                    "latest_oleh": latest_mutasi.pengguna_ref.username
                    if latest_mutasi and latest_mutasi.pengguna_ref
                    else None,
                    "latest_alasan": latest_mutasi.alasan_mutasi
                    if latest_mutasi
                    else None,
                    "sudah_kembali": a.id_lokasi
                    == (
                        all_mutasi_for_a[0].id_lokasi_asal
                        if all_mutasi_for_a
                        else a.id_lokasi
                    ),
                    "original_lokasi_code": all_mutasi_for_a[0].id_lokasi_asal
                    if all_mutasi_for_a and all_mutasi_for_a[0].id_lokasi_asal
                    else a.id_lokasi,
                    "original_lokasi_name": all_mutasi_for_a[0].lokasi_asal.nama_lokasi
                    if all_mutasi_for_a and all_mutasi_for_a[0].lokasi_asal
                    else (
                        a.lokasi_ref.nama_lokasi if a.lokasi_ref else a.id_lokasi
                    ),
                }
                if all_mutasi_for_a
                else None,
            }
        )
    return {**envelope, "items": results}


# ==================================================================
# ── EXPORT ────────────────────────────────────────────────────────
# ==================================================================


# ── Streaming JSON helpers for the export endpoints ───────────────────
#
# The exports are the largest responses this app produces. Assembling them as
# one Python list and handing that to FastAPI's JSON encoder held the whole
# payload in memory twice — once as dicts, once as the encoded bytes — and sent
# nothing until the last row was formatted.
#
# These emit the SAME bytes a normal JSON response would, one row at a time.
# GZipMiddleware compresses the stream chunk by chunk, so the wire size is
# unchanged too. Nothing on the client needs to know.


def _json_bytes(obj) -> bytes:
    # `default=str` covers date/datetime/Decimal, matching what FastAPI's
    # encoder would have produced for these rows.
    return json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")


def _stream_json_array(key: str, rows, first: bool = False):
    """Yield `{"key":[...` (or `,"key":[...`) for one section of an object."""
    yield (b"{" if first else b",") + _json_bytes(key) + b":["
    for i, row in enumerate(rows):
        if i:
            yield b","
        yield _json_bytes(row)
    yield b"]"


def _stream_json_rows(rows):
    """Yield a bare top-level JSON array, one row at a time."""
    yield b"["
    for i, row in enumerate(rows):
        if i:
            yield b","
        yield _json_bytes(row)
    yield b"]"


@router.get("/api/export/riwayat")
def export_riwayat(
    # Proses Laporan is hidden from TEKNISI, so without a guard here the menu
    # gating would be decorative — the endpoint stays one fetch away.
    current_user: models.Pengguna = Depends(
        require_role(
            ["SUPER_ADMIN", "ADMIN_WILAYAH", "PETUGAS_GUDANG", "PIMPINAN"]
        )
    ),
):
    """
    Every asset x every condition report, as {"active": [...], "afkir": [...]}.

    STREAMED, not built in memory. At 100k history rows the assembled list was
    ~30 MB of Python dicts plus the same again once FastAPI serialised it — one
    request could double the process's resident memory, and the client waited
    for the whole thing before receiving a byte.

    The wire format is unchanged, so `js/views/laporan.js` still calls
    `res.json()`; only the server's memory profile differs.

    The Session is created HERE rather than injected: a `Depends(get_db)`
    generator is closed when the endpoint function returns, which for a
    StreamingResponse is BEFORE the body has been produced.
    """

    def build_rows(db, asets):
        """
        One query for the whole batch, grouped in Python.

        This used to issue one SELECT per asset — and `pengguna_ref` was not in
        the joinedload, so it lazy-loaded a second time per riwayat ROW. At 10k
        assets and 100k history rows that is ~110,000 round trips for a single
        request. Now it is exactly one, regardless of fleet size.
        """
        rows = []
        if not asets:
            return rows

        riwayat_by_aset: dict = {}
        q = (
            db.query(models.RiwayatKondisi)
            .options(
                joinedload(models.RiwayatKondisi.lokasi_ref),
                joinedload(models.RiwayatKondisi.pengguna_ref),
            )
            .filter(models.RiwayatKondisi.id_aset.in_([a.id_aset for a in asets]))
            .order_by(
                models.RiwayatKondisi.id_aset,
                models.RiwayatKondisi.waktu_lapor.asc(),
            )
        )
        # yield_per keeps the result set streaming rather than materialising
        # every ORM instance at once.
        for r in q.yield_per(2000):
            riwayat_by_aset.setdefault(r.id_aset, []).append(r)

        for a in asets:
            nama_alat = a.kategori.nama_alat if a.kategori else a.kode_alat
            nama_lokasi = a.lokasi_ref.nama_lokasi if a.lokasi_ref else a.id_lokasi
            riwayat = riwayat_by_aset.get(a.id_aset, [])

            if not riwayat:
                default_upt = a.lokasi_ref.nama_lokasi if a.lokasi_ref else (a.id_lokasi or "—")
                rows.append(
                    {
                        "no": None,
                        "tanggal": "—",
                        "id_aset": a.id_aset,
                        "kode_alat": nama_alat,
                        "id_lokasi": a.id_lokasi,
                        "peruntukan": a.peruntukan,
                        "id_lokasi_asal": nama_lokasi,
                        "upt": default_upt,
                        "id_pengguna": "—",
                        "kondisi": a.status_terakhir,
                        "keterangan": "Belum ada riwayat",
                    }
                )
            else:
                for i, r in enumerate(riwayat, start=1):
                    # Direct database lookup for UPT/lokasi name instead of text parsing
                    upt_name = (
                        r.lokasi_ref.nama_lokasi 
                        if r.lokasi_ref 
                        else (r.id_lokasi or "—")
                    )
                    
                    rows.append(
                        {
                            "no": i,
                            "tanggal": r.waktu_lapor.strftime("%Y-%m-%d %H:%M:%S")
                            if r.waktu_lapor
                            else "—",
                            "id_aset": a.id_aset,
                            "kode_alat": nama_alat,
                            "id_lokasi": r.id_lokasi,
                            "peruntukan": r.peruntukan,
                            "id_lokasi_asal": nama_lokasi,
                            "upt": upt_name,
                            "id_pengguna": r.pengguna_ref.username
                            if r.pengguna_ref
                            else str(r.id_pengguna),
                            "kondisi": r.kondisi,
                            "keterangan": r.keterangan or "—",
                        }
                    )
        return rows

    def generate():
        db = SessionLocal()
        try:
            for i, (key, afkir) in enumerate((("active", False), ("afkir", True))):
                # Was a `hasattr(models.Aset, "status_terlahir")` ternary — a typo
                # of `status_terakhir` that only worked because hasattr returned
                # False and the else-branch happened to be correct.
                q = (
                    db.query(models.Aset)
                    .options(
                        joinedload(models.Aset.lokasi_ref),
                        joinedload(models.Aset.kategori),
                    )
                    .filter(
                        models.Aset.status_terakhir == "AFKIR"
                        if afkir
                        else models.Aset.status_terakhir != "AFKIR"
                    )
                )
                yield from _stream_json_array(key, build_rows(db, q.all()), first=i == 0)
            yield b"}"
        finally:
            db.close()

    return StreamingResponse(generate(), media_type="application/json")


@router.get("/api/export/mutasi")
def export_mutasi(
    current_user: models.Pengguna = Depends(
        require_role(
            ["SUPER_ADMIN", "ADMIN_WILAYAH", "PETUGAS_GUDANG", "PIMPINAN"]
        )
    ),
):
    """Every transfer, as a flat JSON array. Streamed — see export_riwayat."""

    def build_rows(db):
        # Two queries total, not O(assets x mutations).
        #
        # This endpoint had NO eager loading at all: it lazy-loaded `kategori` and
        # `lokasi_ref` once per asset, ran a SELECT per asset for its mutations, and
        # then lazy-loaded `lokasi_asal`, `lokasi_tujuan` and `pengguna_ref` per
        # mutation row. Worse, riwayat_mutasi had no index on id_aset (added in
        # _ensure_schema now), so each of those per-asset lookups was a sequential
        # scan of the whole table.
        asets = (
            db.query(models.Aset)
            .options(
                joinedload(models.Aset.kategori),
                joinedload(models.Aset.lokasi_ref),
            )
            .filter(models.Aset.status_terakhir != "AFKIR")
            .all()
        )
        if not asets:
            return []

        mutasi_by_aset: dict = {}
        mq = (
            db.query(models.RiwayatMutasi)
            .options(
                joinedload(models.RiwayatMutasi.lokasi_asal),
                joinedload(models.RiwayatMutasi.lokasi_tujuan),
                joinedload(models.RiwayatMutasi.pengguna_ref),
            )
            .filter(models.RiwayatMutasi.id_aset.in_([a.id_aset for a in asets]))
            .order_by(
                models.RiwayatMutasi.id_aset,
                models.RiwayatMutasi.waktu_mutasi.asc(),
            )
        )
        for m in mq.yield_per(2000):
            mutasi_by_aset.setdefault(m.id_aset, []).append(m)

        rows = []
        for a in asets:
            nama_alat = a.kategori.nama_alat if a.kategori else a.kode_alat
            nama_lokasi = a.lokasi_ref.nama_lokasi if a.lokasi_ref else a.id_lokasi
            mutasi_list = mutasi_by_aset.get(a.id_aset)
            if not mutasi_list:
                continue
            for i, m in enumerate(mutasi_list, start=1):
                rows.append(
                    {
                        "no": i,
                        "id_aset": a.id_aset,
                        "kode_alat": nama_alat,
                        "lokasi_asal": m.lokasi_asal.nama_lokasi
                        if m.lokasi_asal
                        else m.id_lokasi_asal,
                        "lokasi_tujuan": m.lokasi_tujuan.nama_lokasi
                        if m.lokasi_tujuan
                        else m.id_lokasi_tujuan,
                        # The raw CODES, alongside the display names. Proses Laporan
                        # used to reverse-look-up a code from the name against the
                        # parent list only, which cannot resolve a UPT name — so its
                        # asal/tujuan filters silently matched nothing. Names are for
                        # display; codes are what filters compare.
                        "id_lokasi_asal": m.id_lokasi_asal,
                        "id_lokasi_tujuan": m.id_lokasi_tujuan,
                        "waktu_mutasi": m.waktu_mutasi.strftime("%Y-%m-%d %H:%M:%S")
                        if m.waktu_mutasi
                        else "—",
                        "oleh": m.pengguna_ref.username
                        if m.pengguna_ref
                        else str(m.id_pengguna),
                        "alasan": m.alasan_mutasi or "—",
                    }
                )
        return rows

    def generate():
        # Own Session: a Depends(get_db) generator is closed when the endpoint
        # returns, which for a StreamingResponse is before the body is produced.
        db = SessionLocal()
        try:
            yield from _stream_json_rows(build_rows(db))
        finally:
            db.close()

    return StreamingResponse(generate(), media_type="application/json")
