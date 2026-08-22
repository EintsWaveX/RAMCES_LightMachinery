"""
Master data: alat kerja, lokasi, UPT, Model/Type, and their documents.

Two levels of tool identity live here and conflating them is the mistake this
codebase already made once:

- **Alat kerja** (`kategori_alat`) is the tool TYPE — 104 rows, mastered by the
  client's KATALOG SFM spreadsheet. Its `perlu_kalibrasi` flag is what gates the
  Kalibrasi form; a genset is serviced, not calibrated.
- **Model/Type** (`alat_varian`) is a specific make and model of that tool.

`_varian_payload()` is the ONE shape for a model and lives here: it collapses the
five free-form `Spesifikasi Utama` slots into `spesifikasi: [{label, nilai}]`,
precomputes `judul`, and resolves each attachment to a single URL. `/api/master/varian`,
the create/update responses and `get_public_aset` (api/aset.py, which imports it)
all go through it — one directed edge, master → nothing.

**Documents belong to the ALAT KERJA, and models inherit them.** The client files
its spektek and manual PDFs against tool types: one file covers four tools,
several cover tools with no Model/Type row at all, and 49 of the 87 seeded models
are bare rows the importer created from a free-text column. So `kategori_alat`
carries `url_spek`/`file_spek`/`url_manual`/`file_manual` too, and
`_varian_payload()` falls back to them, flagging the result
`spek_from_katalog`/`manual_from_katalog` so the card can label it `(umum)`.

**Photos are public; documents are not.** `GET /uploads/foto_alat/{nama_file}`
is unauthenticated because landing.html is reached by scanning a QR code with no
session — which is exactly why photos live in their own directory. It is
registered in this router, and this router is included before main.py's
catch-all, which hard-404s the whole `uploads/` tree.

`invalidate_lokasi_cache` is imported by NAME from api.deps and called by the
three lokasi mutations. The cache state itself must stay whole in deps.py: two
copies means a lokasi edit clears the one nobody reads.
"""

import asyncio
import os
from typing import List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session, joinedload

import models
from api.deps import (
    get_current_user,
    get_db,
    invalidate_lokasi_cache,
    require_role,
)
from api.files import (
    ALLOWED_DOK_EXT,
    ALLOWED_IMAGE_EXT,
    DOKUMEN_ALAT_DIR,
    FOTO_ALAT_DIR,
    _MEDIA_TYPES,
    _drop_upload,
    _save_upload,
    file_response_conditional,
)
from api.realtime import manager
from api.schemas import (
    AlatVarianCreate,
    AlatVarianUpdate,
    LokasiCreate,
    MasterAlatCreate,
)

router = APIRouter()


# ==================================================================
# ── MASTER DATA ENDPOINTS ─────────────────────────────────────────
# ==================================================================


@router.get("/api/master/alat")
def get_master_alat(db: Session = Depends(get_db)):
    """
    The alat kerja master, sourced from `KATALOG SFM.xlsx`.

    Returned explicitly rather than as bare ORM rows so the two katalog flags
    are part of the contract: the frontend gates the Kalibrasi tab on
    `perlu_kalibrasi`, and a silently missing key would read as False and hide
    the form for every measuring instrument.
    """
    rows = db.query(models.KategoriAlat).order_by(models.KategoriAlat.nama_alat).all()
    return [
        {
            "kode_alat": r.kode_alat,
            "nama_alat": r.nama_alat,
            "alat_ukur": bool(r.alat_ukur),
            "perlu_kalibrasi": bool(r.perlu_kalibrasi),
            "kelompok": r.kelompok,
            # Tool-type documents. Resolved to a URL the same way
            # `_varian_payload()` does — an upload wins over a pasted link —
            # so Pusat Data can show and manage what every model inherits.
            "spek": (
                f"/api/master/varian/dokumen/{r.file_spek}"
                if r.file_spek
                else (r.url_spek or None)
            ),
            "manual": (
                f"/api/master/varian/dokumen/{r.file_manual}"
                if r.file_manual
                else (r.url_manual or None)
            ),
            "spek_is_upload": bool(r.file_spek),
            "manual_is_upload": bool(r.file_manual),
            "file_spek": r.file_spek,
            "url_spek": r.url_spek,
            "file_manual": r.file_manual,
            "url_manual": r.url_manual,
        }
        for r in rows
    ]


@router.post(
    "/api/master/alat/{kode}/dokumen",
    dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"]))],
)
async def upload_dokumen_alat(
    kode: str,
    jenis: str = Query(..., pattern="^(spek|manual)$"),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """
    Attach a Spek Lengkap / Manual Instruction to an ALAT KERJA.

    Distinct from the per-model route below it: these documents describe the
    tool TYPE and every model of that tool inherits them when it has none of its
    own (see `_varian_payload()`). That is how the client actually files them —
    one PDF covers four tools — and it is the only way a spec sheet reaches an
    asset whose Model/Type row was never filled in.
    """
    row = db.query(models.KategoriAlat).filter_by(kode_alat=kode).first()
    if not row:
        raise HTTPException(status_code=404, detail="Alat kerja tidak ditemukan.")

    field = "file_spek" if jenis == "spek" else "file_manual"
    stored = await asyncio.to_thread(
        _save_upload, file, DOKUMEN_ALAT_DIR, f"{jenis}_katalog_{kode}", ALLOWED_DOK_EXT
    )
    _drop_upload(DOKUMEN_ALAT_DIR, getattr(row, field))
    setattr(row, field, stored)
    db.commit()
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Dokumen alat kerja diunggah.", "kode_alat": kode}


@router.delete(
    "/api/master/alat/{kode}/dokumen",
    dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"]))],
)
async def delete_dokumen_alat(
    kode: str,
    jenis: str = Query(..., pattern="^(spek|manual)$"),
    db: Session = Depends(get_db),
):
    row = db.query(models.KategoriAlat).filter_by(kode_alat=kode).first()
    if not row:
        raise HTTPException(status_code=404, detail="Alat kerja tidak ditemukan.")

    field = "file_spek" if jenis == "spek" else "file_manual"
    url_field = "url_spek" if jenis == "spek" else "url_manual"
    _drop_upload(DOKUMEN_ALAT_DIR, getattr(row, field))
    setattr(row, field, None)
    setattr(row, url_field, None)
    db.commit()
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Dokumen alat kerja dihapus.", "kode_alat": kode}


@router.post("/api/master/alat", dependencies=[Depends(require_role(["SUPER_ADMIN"]))])
def create_master_alat(data: MasterAlatCreate, db: Session = Depends(get_db)):
    kode = (data.kode_alat or "").strip().upper()
    if not kode:
        raise HTTPException(status_code=400, detail="Kode alat wajib diisi.")
    if db.query(models.KategoriAlat).filter_by(kode_alat=kode).first():
        raise HTTPException(status_code=400, detail="Kode alat sudah ada.")
    db.add(
        models.KategoriAlat(
            kode_alat=kode,
            nama_alat=data.nama_alat,
            alat_ukur=data.alat_ukur,
            perlu_kalibrasi=data.perlu_kalibrasi,
            kelompok=data.kelompok,
        )
    )
    db.commit()
    return {"message": "Alat berhasil ditambahkan.", "kode_alat": kode}


@router.put(
    "/api/master/alat/{kode}", dependencies=[Depends(require_role(["SUPER_ADMIN"]))]
)
def update_master_alat(
    kode: str, data: MasterAlatCreate, db: Session = Depends(get_db)
):
    item = db.query(models.KategoriAlat).filter_by(kode_alat=kode).first()
    if not item:
        raise HTTPException(status_code=404, detail="Kode alat tidak ditemukan.")
    item.nama_alat = data.nama_alat
    item.alat_ukur = data.alat_ukur
    item.perlu_kalibrasi = data.perlu_kalibrasi
    item.kelompok = data.kelompok
    db.commit()
    return {"message": "Alat diperbarui."}


@router.delete(
    "/api/master/alat/{kode}", dependencies=[Depends(require_role(["SUPER_ADMIN"]))]
)
def delete_master_alat(kode: str, db: Session = Depends(get_db)):
    item = db.query(models.KategoriAlat).filter_by(kode_alat=kode).first()
    if not item:
        raise HTTPException(status_code=404, detail="Kode alat tidak ditemukan.")
    db.delete(item)
    db.commit()
    return {"message": "Alat dihapus."}


@router.get("/api/master/lokasi")
def get_master_lokasi(tipe: List[str] = Query(None), db: Session = Depends(get_db)):
    query = db.query(models.Lokasi)
    if tipe:
        # Exact match for known types, case-insensitive
        valid_types = {"PUSAT", "DAOP", "DIVRE", "BALAIYASA", "UPT"}
        filtered_types = [t.upper() for t in tipe if t.upper() in valid_types]
        if filtered_types:
            query = query.filter(models.Lokasi.tipe.in_(filtered_types))
    # return query.order_by(models.Lokasi.tipe, models.Lokasi.nama_lokasi).all()
    return query.all()


@router.post("/api/master/lokasi", dependencies=[Depends(require_role(["SUPER_ADMIN"]))])
def create_master_lokasi(data: LokasiCreate, db: Session = Depends(get_db)):
    if db.query(models.Lokasi).filter_by(id_lokasi=data.id_lokasi).first():
        raise HTTPException(status_code=400, detail="ID Lokasi sudah ada.")
    if (
        db.query(models.Lokasi)
        .filter(models.Lokasi.nama_lokasi.ilike(data.nama_lokasi))
        .first()
    ):
        raise HTTPException(status_code=400, detail="Nama lokasi sudah digunakan.")
    db.add(
        models.Lokasi(
            id_lokasi=data.id_lokasi, nama_lokasi=data.nama_lokasi, tipe=data.tipe
        )
    )
    db.commit()
    invalidate_lokasi_cache()
    return {"message": "Lokasi berhasil ditambahkan."}


@router.put(
    "/api/master/lokasi/{kode}", dependencies=[Depends(require_role(["SUPER_ADMIN"]))]
)
def update_master_lokasi(kode: str, data: LokasiCreate, db: Session = Depends(get_db)):
    item = db.query(models.Lokasi).filter_by(id_lokasi=kode).first()
    if not item:
        raise HTTPException(status_code=404, detail="Lokasi tidak ditemukan.")
    item.nama_lokasi = data.nama_lokasi
    item.tipe = data.tipe
    db.commit()
    invalidate_lokasi_cache()
    return {"message": "Lokasi diperbarui."}


@router.delete(
    "/api/master/lokasi/{kode}", dependencies=[Depends(require_role(["SUPER_ADMIN"]))]
)
def delete_master_lokasi(kode: str, db: Session = Depends(get_db)):
    item = db.query(models.Lokasi).filter_by(id_lokasi=kode).first()
    if not item:
        raise HTTPException(status_code=404, detail="Lokasi tidak ditemukan.")
    db.delete(item)
    db.commit()
    invalidate_lokasi_cache()
    return {"message": "Lokasi dihapus."}


@router.get("/api/master/upt")
def get_master_upt(db: Session = Depends(get_db)):
    # Fallback/Legacy jika UI masih memanggil endpoint ini
    return db.query(models.Lokasi).filter_by(tipe="UPT").all()


@router.get("/api/master/varian")
def get_alat_varian(
    kode_alat: Optional[str] = None,
    db: Session = Depends(get_db),
):
    # The parent alat kerja is eager-loaded because _varian_payload() reads it
    # for the tool-type document fallback; lazily it would be one extra SELECT
    # per model, and this endpoint returns all 87 at boot.
    #
    # Its `dokumen` collection rides along on a selectinload — ONE extra query
    # for the whole result set rather than 87. A joinedload would multiply the
    # model rows by their document count instead.
    q = db.query(models.AlatVarian).options(
        joinedload(models.AlatVarian.kategori_alat_ref).selectinload(
            models.KategoriAlat.dokumen
        )
    )
    if kode_alat:
        q = q.filter(models.AlatVarian.kode_alat == kode_alat)
    rows = q.order_by(models.AlatVarian.kode_alat, models.AlatVarian.nama_varian).all()
    return [_varian_payload(v) for v in rows]


def dokumen_payload(kat) -> list:
    """
    Every document filed against an alat kerja, primary one first.

    `kategori_alat.file_spek` / `file_manual` hold ONE basename each, so before
    `dokumen_alat` existed the seeder's second document for a tool overwrote its
    first and three files — 5.6 MB across AMB, IMP and LMP — were on disk and
    reachable by nothing. This is the list that makes them reachable; the single
    columns remain as the PRIMARY document and still drive `_varian_payload()`'s
    fallback, so nothing that already worked had to change.

    Every entry resolves to `/api/master/varian/dokumen/<basename>`, which is
    Bearer-authenticated — documents are not public, only photos are. The client
    must therefore route these through apiFetch, never a plain `<a href>`, which
    is why `is_upload` is stated rather than implied.
    """
    if kat is None:
        return []
    rows = getattr(kat, "dokumen", None) or []
    out = [
        {
            "id_dokumen": d.id_dokumen,
            "jenis": d.jenis,
            "judul": d.judul or d.nama_file,
            "nama_file": d.nama_file,
            "kelompok": d.kelompok,
            "utama": bool(d.utama),
            "url": f"/api/master/varian/dokumen/{d.nama_file}",
            "is_upload": True,
        }
        for d in rows
    ]
    # SPEK before MANUAL, primary before the rest — the order the spec card
    # prints them in, decided once here rather than in each of its two callers.
    out.sort(key=lambda d: (d["jenis"] != "SPEK", not d["utama"], d["judul"]))
    return out


def _varian_payload(v, katalog=None) -> dict:
    """
    One shape for a Model/Type, so the list, the create response, the public
    asset card and the spec card in the SPA cannot drift apart.

    Three things are resolved here rather than on the client:

      * `spesifikasi` — the five label/value slots collapsed into an ordered
        array with the empty ones dropped, because the labels differ per tool
        and no renderer should have to know the slot numbering.
      * `foto` / `spek` / `manual` — an uploaded file always WINS over a pasted
        link, so a model that has both resolves to the copy we control.
      * the TOOL-TYPE FALLBACK for the two documents. The client files its
        spektek and manual PDFs against alat kerja, not against models — one
        covers four tools at once, and several cover tools that have no model
        row at all. When this model carries neither a file nor a link, the
        parent `kategori_alat`'s document is used and the payload is flagged
        `spek_from_katalog` / `manual_from_katalog` so the UI can say the
        document is the general one for the tool type rather than this exact
        model's. See seeds/dokumen.py.

    `katalog` is the parent KategoriAlat row. Callers that already hold it pass
    it in; the relationship is used otherwise. Either way the fallback happens
    INSIDE this function, so no renderer has to know about it.
    """
    kat = katalog if katalog is not None else getattr(v, "kategori_alat_ref", None)

    def _resolve(kind):
        """→ (url, is_upload, from_katalog). `kind` is 'spek' or 'manual'."""
        own_file = getattr(v, f"file_{kind}", None)
        own_url = getattr(v, f"url_{kind}", None)
        if own_file:
            return f"/api/master/varian/dokumen/{own_file}", True, False
        if own_url:
            return own_url, False, False
        if kat is not None:
            kat_file = getattr(kat, f"file_{kind}", None)
            kat_url = getattr(kat, f"url_{kind}", None)
            if kat_file:
                return f"/api/master/varian/dokumen/{kat_file}", True, True
            if kat_url:
                return kat_url, False, True
        return None, False, False

    spek_url, spek_upload, spek_inherited = _resolve("spek")
    manual_url, manual_upload, manual_inherited = _resolve("manual")

    spesifikasi = []
    for i in range(1, 6):
        label = getattr(v, f"spek{i}_label", None)
        nilai = getattr(v, f"spek{i}_nilai", None)
        if label or nilai:
            spesifikasi.append({"label": label or "—", "nilai": nilai or "—"})

    return {
        "id_varian": v.id_varian,
        "kode_alat": v.kode_alat,
        "nama_varian": v.nama_varian,
        "keterangan": v.keterangan,
        "merk": v.merk,
        "tipe_model": v.tipe_model,
        # The Rekap's title rule, precomputed so every screen shows one string.
        "judul": f"{v.merk or ''} {v.tipe_model or ''}".strip()[:50]
        or v.nama_varian,
        "spesifikasi": spesifikasi,
        # ── Attachments, resolved to one URL each ──
        "foto": (
            f"/uploads/foto_alat/{v.foto_file}" if v.foto_file else (v.foto_url or None)
        ),
        "spek": spek_url,
        "manual": manual_url,
        # The document links above are Bearer-authenticated when they point at
        # an upload; the client needs to know which so it can route through
        # apiFetch instead of a plain <a href> that would 401.
        "spek_is_upload": spek_upload,
        "manual_is_upload": manual_upload,
        # True when the document belongs to the ALAT KERJA rather than to this
        # model. renderSpekCard() labels those "Spek umum alat kerja", so a
        # technician is never told a general sheet is their exact machine's.
        "spek_from_katalog": spek_inherited,
        "manual_from_katalog": manual_inherited,
        # EVERY document filed against the parent alat kerja, not just the one
        # that fitted in `file_spek`. See dokumen_payload().
        "dokumen": dokumen_payload(kat),
        # Raw halves, so the edit form can round-trip what was actually stored.
        "foto_url": v.foto_url,
        "foto_file": v.foto_file,
        "url_spek": v.url_spek,
        "file_spek": v.file_spek,
        "url_manual": v.url_manual,
        "file_manual": v.file_manual,
        **{
            f"spek{i}_{part}": getattr(v, f"spek{i}_{part}", None)
            for i in range(1, 6)
            for part in ("label", "nilai")
        },
    }


# Everything an admin may set through the JSON create/update routes. The
# uploads are handled separately, and the retired kapasitas/daya/dimensi/berat
# quartet is deliberately not here — writing it would resurrect a second,
# competing spec shape.
_VARIAN_SPEC_FIELDS = (
    "merk",
    "tipe_model",
    "foto_url",
    "url_spek",
    "url_manual",
) + tuple(
    f"spek{i}_{part}" for i in range(1, 6) for part in ("label", "nilai")
)


@router.post(
    "/api/master/varian",
    dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"]))],
)
async def create_alat_varian(data: AlatVarianCreate, db: Session = Depends(get_db)):
    if not db.query(models.KategoriAlat).filter_by(kode_alat=data.kode_alat).first():
        raise HTTPException(status_code=404, detail="Kode alat tidak ditemukan.")
    nama = (data.nama_varian or "").strip()
    if not nama:
        raise HTTPException(status_code=400, detail="Nama Model/Type wajib diisi.")

    # Rows 1 and 2 of the Rekap template are required. A model with no merk or
    # tipe_model renders as an empty spec card and cannot be matched against
    # the Model column of the import workbook.
    if not (data.merk or "").strip():
        raise HTTPException(status_code=400, detail="Merk wajib diisi.")
    if not (data.tipe_model or "").strip():
        raise HTTPException(status_code=400, detail="Model/Type wajib diisi.")

    dupe = (
        db.query(models.AlatVarian)
        .filter_by(kode_alat=data.kode_alat, nama_varian=nama)
        .first()
    )
    if dupe:
        raise HTTPException(
            status_code=400, detail="Model/Type sudah ada untuk alat kerja ini."
        )

    row = models.AlatVarian(
        kode_alat=data.kode_alat,
        nama_varian=nama,
        keterangan=data.keterangan,
        **{f: getattr(data, f) for f in _VARIAN_SPEC_FIELDS},
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {
        "message": "Model/Type ditambahkan.",
        "id_varian": row.id_varian,
        "varian": _varian_payload(row),
    }


@router.put(
    "/api/master/varian/{id_varian}",
    dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"]))],
)
async def update_alat_varian(
    id_varian: int, data: AlatVarianUpdate, db: Session = Depends(get_db)
):
    """
    Edit a Model/Type's name and its spec block.

    `exclude_unset` is what makes a spec slot CLEARABLE: sending
    `spek3_label: null` blanks it, while omitting the key leaves it alone. The
    form always sends all ten slots, so clearing works; a partial API caller
    keeps the "absent means untouched" behaviour.
    """
    row = db.query(models.AlatVarian).filter_by(id_varian=id_varian).first()
    if not row:
        raise HTTPException(status_code=404, detail="Model/Type tidak ditemukan.")

    payload = data.model_dump(exclude_unset=True)
    if "nama_varian" in payload:
        nama = (payload["nama_varian"] or "").strip()
        if not nama:
            raise HTTPException(status_code=400, detail="Nama Model/Type wajib diisi.")
        clash = (
            db.query(models.AlatVarian)
            .filter(
                models.AlatVarian.kode_alat == row.kode_alat,
                models.AlatVarian.nama_varian == nama,
                models.AlatVarian.id_varian != id_varian,
            )
            .first()
        )
        if clash:
            raise HTTPException(
                status_code=400, detail="Model/Type sudah ada untuk alat kerja ini."
            )
        payload["nama_varian"] = nama

    # Same two required rows as create, but only checked when the caller is
    # actually touching them — a partial update must not be forced to resend
    # fields it is not changing.
    for field, label in (("merk", "Merk"), ("tipe_model", "Model/Type")):
        if field in payload and not (payload[field] or "").strip():
            raise HTTPException(status_code=400, detail=f"{label} wajib diisi.")

    for field, value in payload.items():
        setattr(row, field, value)
    db.commit()
    db.refresh(row)
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Model/Type diperbarui.", "varian": _varian_payload(row)}


@router.delete(
    "/api/master/varian/{id_varian}",
    dependencies=[Depends(require_role(["SUPER_ADMIN"]))],
)
async def delete_alat_varian(id_varian: int, db: Session = Depends(get_db)):
    row = db.query(models.AlatVarian).filter_by(id_varian=id_varian).first()
    if not row:
        raise HTTPException(status_code=404, detail="Model/Type tidak ditemukan.")
    # Detach from any assets and parts first so neither FK can block the delete.
    db.query(models.Aset).filter(models.Aset.id_varian == id_varian).update(
        {models.Aset.id_varian: None}, synchronize_session=False
    )
    db.query(models.SparePart).filter(models.SparePart.id_varian == id_varian).update(
        {models.SparePart.id_varian: None}, synchronize_session=False
    )
    # Uploads are owned by the row; leaving them behind orphans files on disk
    # that nothing will ever reference again.
    _drop_upload(FOTO_ALAT_DIR, row.foto_file)
    _drop_upload(DOKUMEN_ALAT_DIR, row.file_spek)
    _drop_upload(DOKUMEN_ALAT_DIR, row.file_manual)
    db.delete(row)
    db.commit()
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Model/Type dihapus."}


# ── Model/Type attachments ─────────────────────────────────────────
# Two-step create-then-attach, the same contract as calibration certificates:
# the JSON route creates the row, then the file is posted against its id.


@router.post(
    "/api/master/varian/{id_varian}/foto",
    dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"]))],
)
async def upload_foto_varian(
    id_varian: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    row = db.query(models.AlatVarian).filter_by(id_varian=id_varian).first()
    if not row:
        raise HTTPException(status_code=404, detail="Model/Type tidak ditemukan.")

    # Off the event loop — this writes up to 10 MB synchronously and the
    # handler is async, so on a slow disk it would freeze the whole worker.
    stored = await asyncio.to_thread(
        _save_upload, file, FOTO_ALAT_DIR, f"foto_{id_varian}", ALLOWED_IMAGE_EXT
    )
    _drop_upload(FOTO_ALAT_DIR, row.foto_file)
    row.foto_file = stored
    db.commit()
    db.refresh(row)
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Foto diunggah.", "varian": _varian_payload(row)}


@router.delete(
    "/api/master/varian/{id_varian}/foto",
    dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"]))],
)
async def delete_foto_varian(id_varian: int, db: Session = Depends(get_db)):
    row = db.query(models.AlatVarian).filter_by(id_varian=id_varian).first()
    if not row:
        raise HTTPException(status_code=404, detail="Model/Type tidak ditemukan.")
    _drop_upload(FOTO_ALAT_DIR, row.foto_file)
    row.foto_file = None
    db.commit()
    db.refresh(row)
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Foto dihapus.", "varian": _varian_payload(row)}


@router.post(
    "/api/master/varian/{id_varian}/dokumen",
    dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"]))],
)
async def upload_dokumen_varian(
    id_varian: int,
    jenis: str = Query(..., pattern="^(spek|manual)$"),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Attach the Spek Lengkap or Manual Instruction document (`modules/` PDFs)."""
    row = db.query(models.AlatVarian).filter_by(id_varian=id_varian).first()
    if not row:
        raise HTTPException(status_code=404, detail="Model/Type tidak ditemukan.")

    field = "file_spek" if jenis == "spek" else "file_manual"
    stored = await asyncio.to_thread(
        _save_upload,
        file,
        DOKUMEN_ALAT_DIR,
        f"{jenis}_{id_varian}",
        ALLOWED_DOK_EXT,
    )
    _drop_upload(DOKUMEN_ALAT_DIR, getattr(row, field))
    setattr(row, field, stored)
    db.commit()
    db.refresh(row)
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Dokumen diunggah.", "varian": _varian_payload(row)}


@router.delete(
    "/api/master/varian/{id_varian}/dokumen",
    dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"]))],
)
async def delete_dokumen_varian(
    id_varian: int,
    jenis: str = Query(..., pattern="^(spek|manual)$"),
    db: Session = Depends(get_db),
):
    row = db.query(models.AlatVarian).filter_by(id_varian=id_varian).first()
    if not row:
        raise HTTPException(status_code=404, detail="Model/Type tidak ditemukan.")
    field = "file_spek" if jenis == "spek" else "file_manual"
    _drop_upload(DOKUMEN_ALAT_DIR, getattr(row, field))
    setattr(row, field, None)
    db.commit()
    db.refresh(row)
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Dokumen dihapus.", "varian": _varian_payload(row)}


@router.get("/uploads/foto_alat/{nama_file}")
async def serve_foto_varian(nama_file: str, request: Request):
    """
    Serve a Model/Type photo. DELIBERATELY UNAUTHENTICATED.

    landing.html is reached by scanning an asset's QR code, with no session and
    often by someone who has none — the spec card and its photo are the whole
    point of that page. Certificates and reference documents stay behind
    `get_current_user`; only this directory is public, which is why photos live
    in their own directory rather than alongside them.

    Note the sibling change in `serve_static()`: the catch-all used to serve
    ANY image under uploads/, so a certificate uploaded as .jpg was reachable
    without a token. It now refuses the whole uploads/ tree and this is the one
    sanctioned way in.
    """
    safe = os.path.basename(nama_file)
    ext = os.path.splitext(safe)[1].lower()
    if ext not in ALLOWED_IMAGE_EXT:
        raise HTTPException(status_code=400, detail="Jenis berkas tidak diizinkan.")
    path = os.path.join(FOTO_ALAT_DIR, safe)
    if not os.path.realpath(path).startswith(os.path.realpath(FOTO_ALAT_DIR)):
        raise HTTPException(status_code=400, detail="Path tidak valid.")
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Foto tidak ditemukan.")
    # Conditional so it answers 304 like every other static route; the
    # middleware stamps the year-long immutable Cache-Control for images.
    return file_response_conditional(request, path, media_type=_MEDIA_TYPES.get(ext))


@router.get("/api/master/varian/dokumen/{nama_file}")
def download_dokumen_varian(
    nama_file: str,
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    Serve a Spek Lengkap / Manual Instruction upload. AUTHENTICATED, matching
    calibration certificates — unlike the photo route below, these are
    internal reference documents and no anonymous QR scan needs them.
    """
    safe = os.path.basename(nama_file)
    if os.path.splitext(safe)[1].lower() not in ALLOWED_DOK_EXT:
        raise HTTPException(status_code=400, detail="Jenis berkas tidak diizinkan.")
    path = os.path.join(DOKUMEN_ALAT_DIR, safe)
    if not os.path.realpath(path).startswith(os.path.realpath(DOKUMEN_ALAT_DIR)):
        raise HTTPException(status_code=400, detail="Path tidak valid.")
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Dokumen tidak ditemukan.")
    return FileResponse(path, filename=safe)
