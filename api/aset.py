"""
Assets: CRUD, afkir/pulihkan, mutasi, kalibrasi, and the public QR card.

**Asset IDs are composite and both sides parse them.** The format is
`<urutan>.<kode_alat>.<pengadaan>.<yy>.<peruntukan>.<lokasi>` — e.g.
`6.RGM.1.24.A.D1` — generated in `create_aset` and decoded by `decodeAsetId()`
in js/search.js and again in landing.html.

Three consequences live in this module:

- **`peruntukan` and `sumber_pengadaan` are closed sets and are load-bearing.**
  Both are baked into the primary key, so a bad value is not a display bug — it
  is a malformed PK that cannot be corrected later without rewriting every child
  row. `normalise_peruntukan()` / `normalise_sumber_pengadaan()` (api/deps.py)
  are the only accepted way in and raise 400 rather than guessing. They replaced
  two silent fallbacks that minted an ID segment no decoder maps.
- **The sequence number comes from `max(urutan) + 1`, never a row count.** With
  count+1, deleting any asset of that `kode_alat` made the next create reuse a
  live number and fail the collision check permanently, since each retry
  recomputed the same count.
- **`update_aset` distinguishes "absent" from "explicitly null"** via
  `model_fields_set`, because `AsetUpdate` leaves `id_varian` and `nomor_seri`
  optional. A payload that does not mention them leaves them alone — the KDAK
  edit form used to send exactly such a payload, and every edit there destroyed
  the asset's specification and serial number.

**Balaiyasa is a workshop, never a reporting region.**
`assert_aset_region_scope()` resolves the HOME location before applying an
ADMIN_WILAYAH's limit, so a region is never locked out of assets it has itself
sent to a workshop — including recalling them.

`status_terakhir` ∈ SO / TSO / AFKIR. There is no `is_afkir` boolean: afkir is a
status value, and nearly every query filters `!= "AFKIR"`. Every status change
also appends a RiwayatKondisi row; the asset row is a denormalised cache of the
latest one.

Certificates are stored under uploads/sertifikat/ with a SERVER-generated
filename (never a client-supplied path) and download is Bearer-authenticated, so
a plain <a href> 401s — the client goes through apiFetch → blob → objectURL. The
flow is deliberately two-step: POST /api/kalibrasi returns id_kalibrasi, then
POST /api/kalibrasi/{id}/sertifikat attaches the file as FormData.

Route order note: `GET /api/kalibrasi/sertifikat/{nama_file}` is kept above
`GET /api/kalibrasi/{id_aset}`. They cannot actually collide — the first has
four path segments and `{id_aset}` will not match across a `/` — but the order
costs nothing and the reasoning is not obvious to the next reader.

`get_public_aset` is the only unauthenticated route here: landing.html is
reached by scanning a QR code with no session. It renders through
`_varian_payload` imported from api/master.py, so the QR card and the SPA cannot
drift apart.
"""

import asyncio
import os
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import or_, func, extract, select
from sqlalchemy.orm import Session, joinedload

import models
from api.deps import (
    MAX_PAGE,
    assert_aset_region_scope,
    assert_pengadaan_scope,
    assert_region_scope,
    get_current_user,
    get_db,
    get_parent_lokasi_code,
    lokasi_rows,
    normalise_peruntukan,
    normalise_sumber_pengadaan,
    require_role,
    resolve_lokasi_scope,
    _page_envelope,
)
from api.files import (
    ALLOWED_CERT_EXT,
    SERTIFIKAT_DIR,
    _drop_upload,
    _save_certificate,
)
from api.master import _varian_payload
from api.query import apply_aset_filters, apply_aset_sort, own_region_codes
from api.realtime import manager
from api.schemas import AsetCreate, AsetUpdate, KalibrasiCreate, MutasiCreate

router = APIRouter()




@router.post("/api/aset")
async def create_aset(
    aset_in: AsetCreate,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(
        require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"])
    ),
):
    # An ADMIN_WILAYAH may only create assets inside its own region. Both the
    # storage location and the parent stamped into the ID are checked, so a
    # region cannot be laundered by sending a home UPT it does not own.
    assert_region_scope(
        db, current_user, aset_in.id_lokasi,
        "Hanya bisa menambah aset di wilayah Anda.",
    )
    assert_region_scope(
        db, current_user, aset_in.parent_lokasi,
        "Hanya bisa menambah aset di wilayah Anda.",
    )

    peruntukan_norm, kode_peruntukan = normalise_peruntukan(aset_in.peruntukan)
    sumber_norm, id_pengadaan = normalise_sumber_pengadaan(aset_in.sumber_pengadaan)
    # "admin daerah hanya input pengadaan 2" — the client's own matrix. Checked
    # here rather than inside the normaliser, which is role-blind by design.
    assert_pengadaan_scope(current_user, id_pengadaan)

    # 1. Hitung urutan (Sequence) berdasarkan kode_alat
    #
    # Derived from the highest sequence number in use, NOT from a row count.
    # With count+1, deleting any asset of this type made the next create reuse a
    # number that still belonged to a live asset, and the collision check below
    # then rejected it — permanently, since retrying recomputed the same count.
    urutan_terpakai = [
        int(row[0].split(".")[0])
        for row in db.query(models.Aset.id_aset)
        .filter(models.Aset.kode_alat == aset_in.kode_alat)
        .all()
        if row[0].split(".")[0].isdigit()
    ]
    nomor_urut = (max(urutan_terpakai) + 1) if urutan_terpakai else 1

    # 2. Format komponen ID
    tahun = aset_in.tanggal_pembelian.year
    year_str = str(tahun)[-2:] if tahun >= 2000 else str(tahun)

    # 3. Rakit Final ID Aset
    # Format: nomor_urut.kode_alat.id_pengadaan.tahun.unit.parent_lokasi
    # Contoh: 6.RGM.1.24.A.D1
    generated_id_aset = f"{nomor_urut}.{aset_in.kode_alat}.{id_pengadaan}.{year_str}.{kode_peruntukan}.{aset_in.parent_lokasi}"

    # Pastikan tidak ada duplikasi akibat bentrok (meskipun sangat kecil kemungkinannya)
    if db.query(models.Aset).filter_by(id_aset=generated_id_aset).first():
        raise HTTPException(
            status_code=400, detail="Terjadi konflik ID. Silakan coba lagi."
        )

    # 4. Simpan ke database
    db_aset = models.Aset(
        id_aset=generated_id_aset,
        kode_alat=aset_in.kode_alat,
        id_lokasi=aset_in.id_lokasi,  # Disimpan dengan kode UPT asli (e.g. JR1.1)
        tanggal_pembelian=aset_in.tanggal_pembelian,
        sumber_pengadaan=sumber_norm,
        status_terakhir="SO",
        peruntukan=peruntukan_norm,
        id_varian=aset_in.id_varian,
        nomor_seri=(aset_in.nomor_seri or "").strip() or None,
    )
    db.add(db_aset)

    # Inisiasi Riwayat Awal (Sesuai perbaikan arsitektur sebelumnya)
    # id_lokasi/peruntukan are set here for parity with seed.py — without them
    # every dashboard query has to COALESCE back to the asset to place the row.
    inisiasi_riwayat = models.RiwayatKondisi(
        id_aset=generated_id_aset,
        id_pengguna=current_user.id_pengguna,
        kondisi="SO",
        keterangan="Aset Baru",
        id_lokasi=aset_in.id_lokasi,
        peruntukan=peruntukan_norm,
    )
    db.add(inisiasi_riwayat)

    db.commit()
    await manager.broadcast("REFRESH_ASSET_LIST")

    return {"message": "Aset berhasil ditambahkan", "id_aset": db_aset.id_aset}


# ══════════════════════════════════════════════════════════════════════
# Pagination
# ══════════════════════════════════════════════════════════════════════
#
# `/api/aset` and `/api/history/summary` returned the ENTIRE fleet — roughly
# 4.5 MB and 16 MB at 10,000 assets — on every login and again after every
# mutation. They now carry the same {total, limit, offset, items} envelope that
# `get_transfer_history` and `get_stok_movements` already used.
#
# ── Why the client still filters ──
# `js/search.js` holds the ONE matcher for this app (assetLokasiIdentity,
# lokasiMatchesTerm, assetMatchesSearch); its whole reason for existing is that
# location matching has three distinct term shapes and re-implementing it
# anywhere else reintroduces the bug class it was written to kill. So the
# server-side filters below are deliberately a SUPERSET gate: they narrow the
# rows sent over the wire, and the client's matcher still runs last and decides.
# A looser server filter can cost bytes; it cannot produce a wrong result.



@router.get("/api/aset")
def get_all_aset(
    limit: Optional[int] = Query(None, ge=1, le=MAX_PAGE),
    offset: int = Query(0, ge=0),
    q: Optional[str] = None,
    kode_alat: Optional[str] = None,
    id_lokasi: Optional[str] = None,
    status: Optional[str] = None,
    tahun: Optional[int] = None,
    # ── The sort-modal filter set, added in rev0.4.5 ──
    alat: Optional[str] = None,
    pengadaan: Optional[str] = None,
    peruntukan: Optional[str] = None,
    lokasi: Optional[str] = None,
    upt: Optional[str] = None,
    tahun_from: Optional[int] = None,
    tahun_to: Optional[int] = None,
    id_from: Optional[int] = None,
    id_to: Optional[int] = None,
    milik_saya: bool = False,
    sort: Optional[str] = None,
    dir: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    The active fleet, paginated, filtered and sorted.

    ── This used to be a superset gate; it is now the whole answer ──
    Until rev0.4.5 these filters only narrowed what went over the wire and the
    client's matcher ran last and decided. That was correct but it meant the
    client had to hold the entire fleet — 1.06 MB and 460 ms at 1,121 assets, on
    every login and after every mutation. Kelola Data Aset now renders straight
    from a page of this endpoint, so the filters have to be EXACT.

    `api/query.py` is the line-by-line port of `js/search.js` that makes them
    exact, and `tools/verify/test_paging.py` asserts the two agree by running
    both over the real fleet and comparing the id sets. In particular:

      q            the full matcher — a region label resolves to an explicit
                   code set ("DAOP 1" never matches DAOP 10), a bare code
                   compares exactly, free text is a substring over NAMES only
      lokasi/upt   compared against the asset's IDENTITY location, which is the
                   origin of its first transfer rather than where it sits today
      peruntukan   read out of the composite id, not the column — see
                   `peruntukan_letter_expr()`
      milik_saya   "Aset Saya": the caller's own region, from the token

    `kode_alat`, `id_lokasi`, `status` and `tahun` are the ORIGINAL superset
    parameters and are kept working unchanged — `landing.html` and the export
    paths still send them.
    """
    query = (
        db.query(models.Aset)
        .options(
            joinedload(models.Aset.kategori),
            joinedload(models.Aset.lokasi_ref),
            # Spesifikasi teknis. Eager-loaded so surfacing it on the asset cards
            # costs no extra query per row.
            joinedload(models.Aset.varian_ref),
        )
        # Raw comparison, not func.upper(): _ensure_schema() normalises the
        # column on boot, and wrapping it in a function makes both indexes on it
        # unusable — this filter was a sequential scan of `aset`.
        .filter(models.Aset.status_terakhir != "AFKIR")
    )

    if kode_alat:
        query = query.filter(models.Aset.kode_alat == kode_alat)
    if tahun:
        query = query.filter(extract("year", models.Aset.tanggal_pembelian) == tahun)
    if id_lokasi:
        # resolve_lokasi_scope, never LIKE: 'D1%' misses JR1.3 and 'VI%'
        # over-matches VI/VII/VIII/VIV.
        scope, _parent, _children = resolve_lokasi_scope(db, id_lokasi)
        if scope:
            query = query.filter(models.Aset.id_lokasi.in_(scope))

    query = apply_aset_filters(
        query,
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
        scope_codes=own_region_codes(db, current_user) if milik_saya else None,
    )

    # Stable order so page N is the same rows on every request; without it
    # PostgreSQL may return a different arrangement per page and a paged view
    # would both duplicate and miss rows. Every branch of apply_aset_sort ends
    # in id_aset for exactly that reason.
    query = apply_aset_sort(query, sort, dir) if (sort or dir) else query.order_by(
        models.Aset.id_aset
    )

    # `total` before paging, then the page itself. Not `_page_envelope()`: the
    # card facts below are batched over the page's ids, which needs the rows in
    # hand — the same shape /api/history/summary uses, and for the same reason.
    total = query.order_by(None).count()

    # SO/TSO for the WHOLE filtered set, not the page. The KPI tiles above the
    # Kelola Data Aset cards describe "how much matches", which paging must not
    # change — they used to be computed from a client-side copy of the fleet.
    st_rows = db.execute(
        query.order_by(None)
        .with_entities(models.Aset.status_terakhir, func.count())
        .group_by(models.Aset.status_terakhir)
    ).all()
    ringkas = {"so": 0, "tso": 0}
    for r in st_rows:
        if (r[0] or "").upper() == "SO":
            ringkas["so"] += int(r[1])
        elif (r[0] or "").upper() == "TSO":
            ringkas["tso"] += int(r[1])

    if limit is not None:
        query = query.limit(limit).offset(offset)
    rows = query.all()
    facts = _card_facts(db, [a.id_aset for a in rows])
    names = {r.id_lokasi: r.nama_lokasi for r in lokasi_rows(db)}

    def serialise(a):
        f = facts.get(a.id_aset, {})
        ident = f.get("identitas_lokasi") or a.id_lokasi
        return {
            "id_aset": a.id_aset,
            "kode_alat": a.kode_alat,
            "kode_alat_name": a.kategori.nama_alat if a.kategori else a.kode_alat,
            "id_lokasi": a.id_lokasi,
            "lokasi_name": a.lokasi_ref.nama_lokasi if a.lokasi_ref else a.id_lokasi,
            "peruntukan": a.peruntukan,
            "status_terakhir": a.status_terakhir,
            "sumber_pengadaan": a.sumber_pengadaan,
            "tanggal_pembelian": str(a.tanggal_pembelian)
            if a.tanggal_pembelian
            else None,
            "id_varian": a.id_varian,
            "nama_varian": a.varian_ref.nama_varian if a.varian_ref else None,
            "nomor_seri": a.nomor_seri,
            # Gates the Kalibrasi tab in the SPA, which renders from this
            # cached list rather than re-fetching the category per asset.
            "perlu_kalibrasi": bool(a.kategori.perlu_kalibrasi) if a.kategori else False,
            # The owning DAOP/DIVRE code. Derived here so the client's search
            # index, its card labels and its region filters all agree on one
            # value instead of each re-deriving it from a different field.
            "parent_lokasi": get_parent_lokasi_code(a.id_lokasi) or a.id_lokasi,
            # ── The card facts, added in rev0.4.5 ──
            # Kelola Data Aset used to read all five out of `_historySummary`,
            # a second full-fleet download held only so its cards could show
            # three badges and its location label. They ride here instead, one
            # batched query each over the ids on this page.
            #
            # `identitas_lokasi` in particular is `assetLokasiIdentity().uptCode`
            # — the origin of the asset's first transfer — so the client no
            # longer derives it, and the label on the card is by construction
            # the value the server filtered on.
            "identitas_lokasi": ident,
            "identitas_lokasi_name": names.get(ident) or ident,
            "jumlah_kejadian": f.get("jumlah_kejadian", 0),
            "kalibrasi_status": f.get("kalibrasi_status"),
            "kalibrasi_berlaku": f.get("kalibrasi_berlaku"),
            "mutasi_count": f.get("mutasi_count", 0),
            "mutasi_sudah_kembali": a.id_lokasi == ident,
        }

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "ringkas": ringkas,
        "items": [serialise(a) for a in rows],
    }


def _card_facts(db: Session, ids):
    """
    The per-asset facts a Kelola Data Aset card shows that `aset` does not hold:
    the identity location, the recorded-activity count the "jumlah" sort uses,
    the latest calibration verdict and the transfer count.

    Four batched queries scoped to ONE PAGE of ids — never the fleet. Written
    the same way `/api/history/summary` batches its six, because the alternative
    (correlated subqueries inside the ORM serialiser) is per-row and invisible.
    """
    if not ids:
        return {}

    RM = models.RiwayatMutasi
    RK = models.RiwayatKondisi
    RKAL = models.RiwayatKalibrasi
    out = {i: {} for i in ids}

    # First transfer per asset → the identity location, and the count.
    rn = func.row_number().over(
        partition_by=RM.id_aset, order_by=RM.waktu_mutasi.asc()
    ).label("rn")
    first = (
        db.query(RM.id_aset.label("id_aset"), RM.id_lokasi_asal.label("asal"), rn)
        .filter(RM.id_aset.in_(ids))
        .subquery()
    )
    for r in db.execute(select(first).where(first.c.rn == 1)):
        if r.asal:
            out[r.id_aset]["identitas_lokasi"] = r.asal

    mut_count = dict(
        db.query(RM.id_aset, func.count())
        .filter(RM.id_aset.in_(ids))
        .group_by(RM.id_aset)
        .all()
    )
    # TSO rows only — an SO row is a repair being CLOSED, and counting both
    # double-counts every completed job. Same rule as `repair_count_map`.
    rep_count = dict(
        db.query(RK.id_aset, func.count())
        .filter(RK.id_aset.in_(ids), RK.kondisi == "TSO")
        .group_by(RK.id_aset)
        .all()
    )
    for i in ids:
        m = int(mut_count.get(i, 0))
        out[i]["mutasi_count"] = m
        out[i]["jumlah_kejadian"] = int(rep_count.get(i, 0)) + m

    krn = func.row_number().over(
        partition_by=RKAL.id_aset,
        order_by=(RKAL.tanggal_kalibrasi.desc(), RKAL.waktu_input.desc()),
    ).label("rn")
    kal = (
        db.query(
            RKAL.id_aset.label("id_aset"),
            RKAL.status.label("status"),
            # The due date, so the card can say JATUH TEMPO / SEGERA without a
            # second request. One more column on a query that already runs.
            RKAL.tanggal_berlaku.label("berlaku"),
            krn,
        )
        .filter(RKAL.id_aset.in_(ids))
        .subquery()
    )
    for r in db.execute(select(kal).where(kal.c.rn == 1)):
        out[r.id_aset]["kalibrasi_status"] = r.status
        out[r.id_aset]["kalibrasi_berlaku"] = str(r.berlaku) if r.berlaku else None

    return out


@router.get("/api/aset/afkir", dependencies=[Depends(require_role(["SUPER_ADMIN"]))])
def get_afkir_aset(db: Session = Depends(get_db)):
    asets = (
        db.query(models.Aset)
        .options(joinedload(models.Aset.kategori), joinedload(models.Aset.lokasi_ref))
        .filter(models.Aset.status_terakhir == "AFKIR")
        .all()
    )
    afkir_ids = [a.id_aset for a in asets]

    # Recorded activity per scrapped asset. /api/history/summary deliberately
    # excludes AFKIR rows, so the afkir screen had no counts to sort by at all
    # and its "Terbanyak / Tersedikit" buttons could never do anything. Two
    # grouped queries for the whole list, not two per asset.
    repair_counts: dict = {}
    mutasi_counts: dict = {}
    if afkir_ids:
        repair_counts = {
            r[0]: int(r[1] or 0)
            for r in db.query(models.RiwayatKondisi.id_aset, func.count())
            .filter(
                models.RiwayatKondisi.id_aset.in_(afkir_ids),
                # TSO only — an SO row closes a repair, so counting both would
                # double-count every completed job.
                models.RiwayatKondisi.kondisi == "TSO",
            )
            .group_by(models.RiwayatKondisi.id_aset)
            .all()
        }
        mutasi_counts = {
            r[0]: int(r[1] or 0)
            for r in db.query(models.RiwayatMutasi.id_aset, func.count())
            .filter(models.RiwayatMutasi.id_aset.in_(afkir_ids))
            .group_by(models.RiwayatMutasi.id_aset)
            .all()
        }

    # Same field contract as GET /api/aset: id_lokasi and kode_alat are CODES,
    # with the human-readable names in the *_name fields. The frontend filters
    # and lokasi/UPT lookups all key off the codes.
    return [
        {
            "id_aset": a.id_aset,
            "kode_alat": a.kode_alat,
            "kode_alat_name": a.kategori.nama_alat if a.kategori else a.kode_alat,
            "id_lokasi": a.id_lokasi,
            "lokasi_name": a.lokasi_ref.nama_lokasi if a.lokasi_ref else a.id_lokasi,
            "peruntukan": a.peruntukan,
            "sumber_pengadaan": a.sumber_pengadaan,
            "status_terakhir": a.status_terakhir,
            "tanggal_pembelian": str(a.tanggal_pembelian)
            if a.tanggal_pembelian
            else None,
            "waktu_update": a.waktu_update.strftime("%Y-%m-%d %H:%M:%S")
            if a.waktu_update
            else None,
            "repair_count": repair_counts.get(a.id_aset, 0),
            "mutasi_count": mutasi_counts.get(a.id_aset, 0),
        }
        for a in asets
    ]


@router.post("/api/aset/afkir/{id_aset}")
async def afkir_aset(
    id_aset: str,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(
        require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"])
    ),
):
    aset = db.query(models.Aset).filter_by(id_aset=id_aset).first()
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")
    aset.status_terakhir = "AFKIR"
    # Record the transition — without a riwayat row the afkir is invisible to
    # every history/export/dashboard query.
    db.add(
        models.RiwayatKondisi(
            id_aset=id_aset,
            id_pengguna=current_user.id_pengguna,
            kondisi="AFKIR",
            keterangan="Aset di-afkir",
            id_lokasi=aset.id_lokasi,
            peruntukan=aset.peruntukan,
        )
    )
    db.commit()
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Aset berhasil di-afkir."}


@router.post("/api/aset/pulihkan/{id_aset}")
async def pulihkan_aset(
    id_aset: str,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(require_role(["SUPER_ADMIN"])),
):
    aset = db.query(models.Aset).filter_by(id_aset=id_aset).first()
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")
    if aset.status_terakhir != "AFKIR":
        raise HTTPException(
            status_code=400, detail="Aset ini tidak dalam status AFKIR."
        )
    aset.status_terakhir = "SO"
    # Record the recovery, mirroring afkir_aset — an AFKIR→SO transition with no
    # riwayat row leaves a hole in the asset's timeline.
    db.add(
        models.RiwayatKondisi(
            id_aset=id_aset,
            id_pengguna=current_user.id_pengguna,
            kondisi="SO",
            keterangan="Aset dipulihkan dari afkir",
            id_lokasi=aset.id_lokasi,
            peruntukan=aset.peruntukan,
        )
    )
    db.commit()
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": f"Aset {id_aset} berhasil dipulihkan."}




@router.post("/api/mutasi")
async def submit_mutasi(
    mutasi: MutasiCreate,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(
        require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"])
    ),
):
    aset = (
        db.query(models.Aset)
        .filter(
            models.Aset.id_aset == mutasi.id_aset,
            models.Aset.status_terakhir != "AFKIR",
        )
        .first()
    )
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")

    if aset.id_lokasi == mutasi.id_lokasi_tujuan:
        raise HTTPException(status_code=400, detail="Lokasi tujuan sama dengan asal.")

    assert_aset_region_scope(
        db, current_user, aset,
        "Hanya bisa memindahkan aset dari wilayah sendiri.",
    )

    db.add(
        models.RiwayatMutasi(
            id_aset=mutasi.id_aset,
            id_lokasi_asal=aset.id_lokasi,
            id_lokasi_tujuan=mutasi.id_lokasi_tujuan,
            id_pengguna=current_user.id_pengguna,
            alasan_mutasi=mutasi.alasan_mutasi,
        )
    )

    db.query(models.Aset).filter(models.Aset.id_aset == mutasi.id_aset).update(
        {"id_lokasi": mutasi.id_lokasi_tujuan}, synchronize_session=False
    )

    db.commit()
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Aset berhasil dimutasi."}


@router.post("/api/kalibrasi")
async def create_kalibrasi(
    data: KalibrasiCreate,
    db: Session = Depends(get_db),
    # Was open to every logged-in user. Recording a calibration is a
    # field task like reporting a condition, so it carries the same
    # audience — PETUGAS_GUDANG and PIMPINAN have no business filing one.
    current_user: models.Pengguna = Depends(
        require_role(["SUPER_ADMIN", "ADMIN_WILAYAH", "TEKNISI"])
    ),
):
    aset = db.query(models.Aset).filter_by(id_aset=data.id_aset).first()
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")

    assert_aset_region_scope(
        db, current_user, aset,
        "Hanya bisa mencatat kalibrasi aset dari wilayah Anda.",
    )

    if data.status not in {"LULUS", "GAGAL", "BERSYARAT"}:
        raise HTTPException(status_code=400, detail="Status kalibrasi tidak valid.")

    tanggal_berlaku = data.tanggal_berlaku or data.tanggal_kalibrasi

    record = models.RiwayatKalibrasi(
        id_aset=data.id_aset,
        id_pengguna=current_user.id_pengguna,
        tanggal_kalibrasi=data.tanggal_kalibrasi,
        tanggal_berlaku=tanggal_berlaku,
        status=data.status,
        pelaksana_kalibrasi=data.pelaksana_kalibrasi,
        nomor_sertifikat=data.nomor_sertifikat,
        keterangan=data.keterangan,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Laporan kalibrasi berhasil disimpan.", "id_kalibrasi": record.id_kalibrasi}


# ── Calibration certificate upload ─────────────────────────────────
# Kept as a separate "attach" step rather than folding multipart into
# POST /api/kalibrasi, so the existing JSON contract stays intact: the client
# creates the record, then uploads the file against the returned id.

# The upload directories, the extension allowlists and _save_upload /
# _save_certificate / _drop_upload are imported from api/files.py at the top of
# this module — they are shared with the master routes, which attach documents
# and photos to alat kerja and Model/Type rows.


@router.post("/api/kalibrasi/{id_kalibrasi}/sertifikat")
async def upload_sertifikat_kalibrasi(
    id_kalibrasi: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    # Step two of the deliberately two-step upload. It MUST carry the
    # same guard as step one, or the record is creatable by one audience
    # and attachable by another.
    current_user: models.Pengguna = Depends(
        require_role(["SUPER_ADMIN", "ADMIN_WILAYAH", "TEKNISI"])
    ),
):
    record = (
        db.query(models.RiwayatKalibrasi).filter_by(id_kalibrasi=id_kalibrasi).first()
    )
    if not record:
        raise HTTPException(status_code=404, detail="Data kalibrasi tidak ditemukan.")

    # Off the event loop: this writes up to MAX_CERT_BYTES (10 MB) synchronously,
    # and the handler is `async`, so on a slow or network-mounted disk it froze
    # the whole worker for the duration of the write.
    stored = await asyncio.to_thread(_save_certificate, file, id_kalibrasi)

    # Replacing an existing certificate — drop the old file so uploads don't pile up.
    _drop_upload(SERTIFIKAT_DIR, record.file_sertifikat)

    record.file_sertifikat = stored
    db.commit()
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Sertifikat berhasil diunggah.", "file_sertifikat": stored}


@router.get("/api/kalibrasi/jatuh-tempo")
def get_kalibrasi_jatuh_tempo(
    hari: int = Query(30, ge=1, le=365),
    id_lokasi: Optional[str] = None,
    limit: Optional[int] = Query(200, ge=1, le=MAX_PAGE),
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    Alat kerja whose calibration has expired, is about to, or was never done.

    ── Why this is a STATE and not a notification ──
    The bell is session-scoped on purpose: there is no notifications table, and
    inventing one means deciding what "read" means per user across devices. A
    calibration due date does not need that decision. It is not an event that
    happened once — it is a condition that is either true right now or is not,
    and it stops being true when somebody calibrates the machine. So this
    endpoint answers the condition, every caller re-reads it, and nothing is
    ever marked read or goes stale.

    Three buckets, and the third is the one an event feed could never produce:

      lewat         tanggal_berlaku is in the past
      segera        tanggal_berlaku falls within `hari` days
      belum_pernah  the katalog flags the tool type as needing calibration and
                    there is NO riwayat_kalibrasi row at all

    `belum_pernah` is gated on `kategori_alat.perlu_kalibrasi`, the same flag
    that decides whether the Kalibrasi form is offered at all. A genset is
    serviced, not calibrated, and listing one as overdue would be noise that
    teaches people to ignore the list.

    Scoped with `resolve_lokasi_scope()` so an ADMIN_WILAYAH sees its own
    region — never a bare `==`, which misses every UPT under the parent.
    """
    AS = models.Aset
    KA = models.KategoriAlat
    RKAL = models.RiwayatKalibrasi

    hari_ini = date.today()
    batas = hari_ini + timedelta(days=hari)

    # An admin's own region wins over the parameter, for the same reason
    # `milik_saya` reads the token: a scope a caller can widen is not a scope.
    scope_code = id_lokasi
    if current_user.role == "ADMIN_WILAYAH":
        scope_code = current_user.id_lokasi
    lokasi_ids, _parent, _children = resolve_lokasi_scope(db, scope_code)

    # Latest calibration per asset — the same row_number the card facts and the
    # history summary pick, so all three agree on which record is "latest".
    rn = func.row_number().over(
        partition_by=RKAL.id_aset,
        order_by=(RKAL.tanggal_kalibrasi.desc(), RKAL.waktu_input.desc()),
    ).label("rn")
    latest = (
        db.query(
            RKAL.id_aset.label("id_aset"),
            RKAL.tanggal_berlaku.label("berlaku"),
            RKAL.status.label("status"),
            rn,
        ).subquery()
    )
    last = select(latest).where(latest.c.rn == 1).subquery()

    q = (
        db.query(AS, KA.nama_alat, last.c.berlaku, last.c.status)
        .join(KA, KA.kode_alat == AS.kode_alat)
        .outerjoin(last, last.c.id_aset == AS.id_aset)
        .options(joinedload(models.Aset.lokasi_ref))
        .filter(AS.status_terakhir != "AFKIR", KA.perlu_kalibrasi.is_(True))
    )
    if lokasi_ids:
        q = q.filter(AS.id_lokasi.in_(lokasi_ids))

    lewat, segera, belum = [], [], []
    for aset, nama_alat, berlaku, status in q.all():
        row = {
            "id_aset": aset.id_aset,
            "kode_alat": aset.kode_alat,
            "kode_alat_name": nama_alat,
            "id_lokasi": aset.id_lokasi,
            "lokasi_name": aset.lokasi_ref.nama_lokasi if aset.lokasi_ref else aset.id_lokasi,
            "tanggal_berlaku": str(berlaku) if berlaku else None,
            "status_kalibrasi": status,
            "sisa_hari": (berlaku - hari_ini).days if berlaku else None,
        }
        if berlaku is None:
            belum.append(row)
        elif berlaku < hari_ini:
            lewat.append(row)
        elif berlaku <= batas:
            segera.append(row)

    # Soonest first within each bucket, and the most urgent bucket first — the
    # list is a work queue, so its order is the order to act in.
    lewat.sort(key=lambda r: r["tanggal_berlaku"])
    segera.sort(key=lambda r: r["tanggal_berlaku"])
    belum.sort(key=lambda r: r["id_aset"])

    items = (lewat + segera + belum)[:limit]
    return {
        "hari": hari,
        "jumlah_lewat": len(lewat),
        "jumlah_segera": len(segera),
        "jumlah_belum_pernah": len(belum),
        # What the bell prints. Deliberately EXCLUDES belum_pernah: a machine
        # that has never been calibrated is already flagged on every card as
        # "BLM KALIBRASI", and folding it in here would make the count read as
        # a sudden backlog on a fresh install.
        "jumlah_perlu_tindakan": len(lewat) + len(segera),
        "items": items,
    }


@router.get("/api/kalibrasi/sertifikat/{nama_file}")
def download_sertifikat(
    nama_file: str,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    Serve a stored certificate. Authenticated, and deliberately NOT routed
    through the public static handler — certificates are not public assets.
    """
    # basename() strips any traversal attempt before it reaches the filesystem.
    safe = os.path.basename(nama_file)
    if os.path.splitext(safe)[1].lower() not in ALLOWED_CERT_EXT:
        raise HTTPException(status_code=400, detail="Jenis berkas tidak diizinkan.")

    path = os.path.join(SERTIFIKAT_DIR, safe)
    # Belt and braces: confirm the resolved path really is inside the upload dir.
    if not os.path.realpath(path).startswith(os.path.realpath(SERTIFIKAT_DIR)):
        raise HTTPException(status_code=400, detail="Path tidak valid.")
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Sertifikat tidak ditemukan.")
    return FileResponse(path, filename=safe)


@router.delete("/api/kalibrasi/{id_kalibrasi}/sertifikat")
async def delete_sertifikat_kalibrasi(
    id_kalibrasi: int,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(
        require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"])
    ),
):
    record = (
        db.query(models.RiwayatKalibrasi).filter_by(id_kalibrasi=id_kalibrasi).first()
    )
    if not record:
        raise HTTPException(status_code=404, detail="Data kalibrasi tidak ditemukan.")
    if record.file_sertifikat:
        _drop_upload(SERTIFIKAT_DIR, record.file_sertifikat)
        record.file_sertifikat = None
        db.commit()
    return {"message": "Sertifikat dihapus."}


@router.get("/api/kalibrasi/{id_aset}")
def get_kalibrasi_by_aset(
    id_aset: str,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    riwayat = (
        db.query(models.RiwayatKalibrasi)
        .filter(models.RiwayatKalibrasi.id_aset == id_aset)
        .order_by(models.RiwayatKalibrasi.tanggal_kalibrasi.asc(), models.RiwayatKalibrasi.waktu_input.asc())
        .all()
    )

    pengguna_ids = {r.id_pengguna for r in riwayat if r.id_pengguna}
    pengguna_map = {
        p.id_pengguna: p.username
        for p in db.query(models.Pengguna).filter(models.Pengguna.id_pengguna.in_(pengguna_ids)).all()
    }

    return [
        {
            "no": i,
            "id_kalibrasi": r.id_kalibrasi,
            "tanggal_kalibrasi": str(r.tanggal_kalibrasi) if r.tanggal_kalibrasi else None,
            "tanggal_berlaku": str(r.tanggal_berlaku) if r.tanggal_berlaku else None,
            "status": r.status,
            "pelaksana_kalibrasi": r.pelaksana_kalibrasi or "—",
            "nomor_sertifikat": r.nomor_sertifikat or "—",
            "keterangan": r.keterangan or "—",
            "file_sertifikat": r.file_sertifikat,
            "waktu_input": r.waktu_input.strftime("%Y-%m-%d %H:%M:%S") if r.waktu_input else None,
            "id_pengguna": pengguna_map.get(r.id_pengguna, str(r.id_pengguna) if r.id_pengguna else "—"),
        }
        for i, r in enumerate(riwayat, start=1)
    ]


@router.get("/api/mutasi/{id_aset}")
def get_mutasi_by_aset(
    id_aset: str,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    mutasi = (
        db.query(models.RiwayatMutasi)
        # The row loop reads all three of these; without eager loading it was
        # three queries per mutation row.
        .options(
            joinedload(models.RiwayatMutasi.lokasi_asal),
            joinedload(models.RiwayatMutasi.lokasi_tujuan),
            joinedload(models.RiwayatMutasi.pengguna_ref),
        )
        .filter_by(id_aset=id_aset)
        .order_by(models.RiwayatMutasi.waktu_mutasi.asc())
        .all()
    )

    aset = db.query(models.Aset).filter_by(id_aset=id_aset).first()
    # original_lokasi should be the parent region code, not UPT code
    # For mutations, use the asal lokasi; for no mutations, use asset's current parent
    if mutasi:
        original_lokasi = mutasi[0].id_lokasi_asal
    elif aset:
        # Try to get parent from UPT code, fallback to asset's lokasi
        # This requires a helper or we just send the code and let frontend resolve
        original_lokasi = aset.id_lokasi
    else:
        original_lokasi = "—"

    results = []
    for m in mutasi:
        results.append(
            {
                "id_lokasi_asal": m.id_lokasi_asal,
                "id_lokasi_asal_name": m.lokasi_asal.nama_lokasi
                if m.lokasi_asal
                else m.id_lokasi_asal,
                "id_lokasi_tujuan": m.id_lokasi_tujuan,
                "id_lokasi_tujuan_name": m.lokasi_tujuan.nama_lokasi
                if m.lokasi_tujuan
                else m.id_lokasi_tujuan,
                "waktu_mutasi": m.waktu_mutasi.strftime("%Y-%m-%d %H:%M:%S")
                if m.waktu_mutasi
                else None,
                "nama_petugas": m.pengguna_ref.username
                if m.pengguna_ref
                else (str(m.id_pengguna) if m.id_pengguna else "—"),
                "alasan_mutasi": m.alasan_mutasi or "—",
            }
        )
        
    original_lokasi_obj = (
        db.query(models.Lokasi).filter_by(id_lokasi=original_lokasi).first()
        if original_lokasi and original_lokasi != "—"
        else None
    )
    return {
        "mutasi": results,
        "original_lokasi": original_lokasi,
        "original_lokasi_name": original_lokasi_obj.nama_lokasi if original_lokasi_obj else original_lokasi,
        "sudah_kembali": aset.id_lokasi == original_lokasi if aset else False,
        "lokasi_sekarang": aset.id_lokasi if aset else "—",
        "lokasi_sekarang_name": aset.lokasi_ref.nama_lokasi
        if aset and aset.lokasi_ref
        else "—",
    }




@router.delete("/api/aset/{id_aset}")
async def delete_aset(
    id_aset: str,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(
        require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"])
    ),
):
    aset = db.query(models.Aset).filter_by(id_aset=id_aset).first()
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")

    assert_aset_region_scope(
        db, current_user, aset,
        "Hanya bisa menghapus aset dari wilayah Anda.",
    )

    # Cascade delete child records first
    db.query(models.RiwayatKondisi).filter_by(id_aset=id_aset).delete()
    db.query(models.RiwayatMutasi).filter_by(id_aset=id_aset).delete()
    db.delete(aset)
    db.commit()
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": f"Aset {id_aset} berhasil dihapus permanen."}


@router.put("/api/aset/{id_aset}")
async def update_aset(
    id_aset: str,
    aset_in: AsetUpdate,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(
        require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"])
    ),
):
    old_aset = db.query(models.Aset).filter_by(id_aset=id_aset).first()
    if not old_aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")

    # Both the asset as it stands and where the edit would move it must be
    # inside the admin's region, or an edit becomes a way to push an asset out.
    assert_aset_region_scope(
        db, current_user, old_aset,
        "Hanya bisa mengedit aset dari wilayah Anda.",
    )
    assert_region_scope(
        db, current_user, aset_in.id_lokasi,
        "Hanya bisa memindahkan aset di dalam wilayah Anda.",
    )

    # Rebuild the generated ID from updated fields
    peruntukan_norm, kode_peruntukan = normalise_peruntukan(aset_in.peruntukan)
    sumber_norm, id_pengadaan = normalise_sumber_pengadaan(aset_in.sumber_pengadaan)
    # Also on EDIT, not just create: the segment is part of the primary key, so
    # an ADMIN_WILAYAH editing an asset to PUSAT would regenerate the key and
    # rewrite every child row into a state it may not author.
    assert_pengadaan_scope(current_user, id_pengadaan)
    tahun = aset_in.tanggal_pembelian.year
    year_str = str(tahun)[-2:] if tahun >= 2000 else str(tahun)

    # Preserve original sequence number from the old ID
    old_parts = id_aset.split(".")
    nomor_urut = old_parts[0] if old_parts[0].isdigit() else "1"

    new_id_aset = f"{nomor_urut}.{aset_in.kode_alat}.{id_pengadaan}.{year_str}.{kode_peruntukan}.{aset_in.parent_lokasi}"

    # `id_varian` and `nomor_seri` are optional in the schema, so a payload that
    # simply does not mention them used to null both out — the Kelola Data Alat
    # Kerja edit form sends exactly such a payload, and every edit there quietly
    # destroyed the asset's serial number and specification. Treat "absent" as
    # "leave alone" and only write what the caller actually sent.
    dikirim = aset_in.model_fields_set
    varian_baru = aset_in.id_varian if "id_varian" in dikirim else old_aset.id_varian
    seri_baru = (
        ((aset_in.nomor_seri or "").strip() or None)
        if "nomor_seri" in dikirim
        else old_aset.nomor_seri
    )

    if new_id_aset == id_aset:
        # ID unchanged — simple field update
        old_aset.kode_alat = aset_in.kode_alat
        old_aset.id_lokasi = aset_in.id_lokasi
        old_aset.tanggal_pembelian = aset_in.tanggal_pembelian
        old_aset.sumber_pengadaan = sumber_norm
        old_aset.peruntukan = peruntukan_norm
        old_aset.id_varian = varian_baru
        old_aset.nomor_seri = seri_baru
        db.commit()
        await manager.broadcast("REFRESH_ASSET_LIST")
        return {"message": "Aset berhasil diperbarui.", "id_aset": new_id_aset}

    # ID changes — check for collision
    if db.query(models.Aset).filter_by(id_aset=new_id_aset).first():
        raise HTTPException(
            status_code=400,
            detail=f"ID baru '{new_id_aset}' sudah digunakan oleh aset lain."
        )

    # 1. Insert new aset row first so FK target exists before child records point to it
    new_aset = models.Aset(
        id_aset=new_id_aset,
        kode_alat=aset_in.kode_alat,
        id_lokasi=aset_in.id_lokasi,
        tanggal_pembelian=aset_in.tanggal_pembelian,
        sumber_pengadaan=sumber_norm,
        status_terakhir=old_aset.status_terakhir,
        peruntukan=peruntukan_norm,
        id_varian=varian_baru,
        nomor_seri=seri_baru,
    )
    db.add(new_aset)
    db.flush()  # write new_aset row; FK target now exists in DB

    # 2. Re-parent all child records to the new ID (FK target now valid)
    db.query(models.RiwayatKondisi).filter_by(id_aset=id_aset).update(
        {"id_aset": new_id_aset}, synchronize_session=False
    )
    db.query(models.RiwayatMutasi).filter_by(id_aset=id_aset).update(
        {"id_aset": new_id_aset}, synchronize_session=False
    )
    db.query(models.RiwayatKalibrasi).filter_by(id_aset=id_aset).update(
        {"id_aset": new_id_aset}, synchronize_session=False
    )

    # 3. Now safe to delete the old aset row (no children reference it anymore)
    db.delete(old_aset)
    db.commit()

    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Aset berhasil diperbarui.", "id_aset": new_id_aset}


# The whole sparepart inventory — kategori, parts, gudang, the append-only stok
# ledger, transfers, pemakaian and the stock dashboard — moved to
# api/inventaris.py. api/riwayat.py imports `_net_stok_map` from it so a repair
# checks sufficiency against the same implementation the standalone movement
# endpoint uses.

# `_varian_payload` is the ONE shape for a Model/Type and now lives in
# api/master.py. `get_public_aset` below is its other caller — the QR card must
# render the identical spec block the SPA does — so it is imported rather than
# reimplemented. (This route moves to api/aset.py, which takes the import with it.)
from api.master import _varian_payload, dokumen_payload  # noqa: E402

# `_record_pemakaian` (still below, moving to api/riwayat.py) checks stock
# sufficiency with the SAME map the standalone movement endpoint uses, rather
# than a second implementation that can drift from the ledger.
from api.inventaris import _net_stok_map  # noqa: E402



# ==================================================================
# ── PUBLIC ENDPOINTS (Landing Page / QR) ──────────────────────────
# ==================================================================


@router.get("/api/public/aset/{id_aset}")
def get_public_aset(id_aset: str, db: Session = Depends(get_db)):
    """
    The payload behind the QR landing card.

    Historically this returned five keys, two of which lied: `kode_alat` carried
    the tool's display NAME and `id_lokasi` carried `nama_lokasi`. The landing
    page fed that name into a code→name resolver, which naturally failed, which
    is why its "UPT" row was permanently "—". Codes and names are now separate
    keys, and the old two are kept as aliases so nothing that reads them breaks.
    """
    aset = (
        db.query(models.Aset)
        .filter(models.Aset.id_aset == id_aset, models.Aset.status_terakhir != "AFKIR")
        .first()
    )
    if not aset:
        raise HTTPException(
            status_code=404, detail="Aset tidak ditemukan atau di-afkir."
        )

    nama_alat = aset.kategori.nama_alat if aset.kategori else aset.kode_alat
    nama_lokasi = aset.lokasi_ref.nama_lokasi if aset.lokasi_ref else None

    # The card shows both levels: the owning DAOP/DIVRE and the resort inside it.
    parent_code = get_parent_lokasi_code(aset.id_lokasi)
    parent_row = (
        db.query(models.Lokasi).filter_by(id_lokasi=parent_code).first()
        if parent_code
        else aset.lokasi_ref
    )

    # One shape for the spec block, shared with /api/master/varian and the SPA
    # spec card — the three used to be built separately and drifted.
    v = aset.varian_ref
    spesifikasi = _varian_payload(v) if v is not None else None

    # Also surfaced OUTSIDE `spesifikasi`, because 49 of the 87 seeded models
    # are bare rows and plenty of assets resolve to no model at all — and those
    # are precisely the machines whose only documentation is the tool-type
    # spektek. Hanging the list off the model would have hidden it from exactly
    # the technicians who need it most.
    dokumen = dokumen_payload(aset.kategori)

    return {
        "id_aset": aset.id_aset,
        # ── Jenis alat ──
        "kode_alat_code": aset.kode_alat,
        "nama_alat": nama_alat,
        "kode_alat": nama_alat,  # legacy alias — carries the NAME, not the code
        # Katalog flags. `perlu_kalibrasi` is what lets the landing page hide
        # its Kalibrasi tab for a tool that is serviced but never calibrated,
        # instead of offering a form that would only ever produce fiction.
        "perlu_kalibrasi": bool(aset.kategori.perlu_kalibrasi) if aset.kategori else False,
        "alat_ukur": bool(aset.kategori.alat_ukur) if aset.kategori else False,
        # ── Lokasi ──
        "id_lokasi_code": aset.id_lokasi,
        "nama_lokasi": nama_lokasi,
        "parent_code": parent_code or aset.id_lokasi,
        "parent_nama": (parent_row.nama_lokasi if parent_row else None) or nama_lokasi,
        # `parent_code` is None when the asset is homed directly at a DAOP rather
        # than a resort; in that case there is no separate UPT to show.
        "upt_nama": nama_lokasi if parent_code else None,
        "id_lokasi": nama_lokasi or aset.id_lokasi,  # legacy alias — the NAME
        # ── Status & pengadaan ──
        "status_terakhir": aset.status_terakhir,
        "peruntukan": aset.peruntukan,
        "sumber_pengadaan": aset.sumber_pengadaan,
        "tanggal_pembelian": aset.tanggal_pembelian,
        "waktu_update": aset.waktu_update,
        "nomor_seri": aset.nomor_seri,
        "spesifikasi": spesifikasi,
        "dokumen": dokumen,
    }
