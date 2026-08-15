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
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import or_, func, extract
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
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    The active fleet, paginated.

    Every filter here is OPTIONAL and every one is a superset gate — see the
    note above `_page_envelope`. `q` in particular matches only the two fields
    a substring test cannot get wrong (`id_aset`, `nomor_seri`) plus the tool
    name; location terms are left entirely to the client matcher, because
    "DAOP 1" must not match DAOP 10 and SQL LIKE cannot express that rule.
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
    if status:
        query = query.filter(models.Aset.status_terakhir == status.upper())
    if tahun:
        query = query.filter(extract("year", models.Aset.tanggal_pembelian) == tahun)
    if id_lokasi:
        # resolve_lokasi_scope, never LIKE: 'D1%' misses JR1.3 and 'VI%'
        # over-matches VI/VII/VIII/VIV.
        scope, _parent, _children = resolve_lokasi_scope(db, id_lokasi)
        if scope:
            query = query.filter(models.Aset.id_lokasi.in_(scope))
    if q:
        term = f"%{q.strip()}%"
        query = query.outerjoin(models.Aset.kategori).filter(
            or_(
                models.Aset.id_aset.ilike(term),
                models.Aset.nomor_seri.ilike(term),
                models.KategoriAlat.nama_alat.ilike(term),
            )
        )

    # Stable order so page N is the same rows on every request; without it
    # PostgreSQL may return a different arrangement per page and the paged
    # bootstrap in js/api.js would both duplicate and miss rows.
    query = query.order_by(models.Aset.id_aset)

    def serialise(a):
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
        }

    return _page_envelope(query, limit, offset, serialise)


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
