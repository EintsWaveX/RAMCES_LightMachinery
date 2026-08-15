"""
Sparepart inventory: kategori, parts, gudang, the stock ledger and pemakaian.

**Inventory is an append-only ledger.** `sparepart_stok` holds one row per
movement, never a running balance. `SparePartStok.GERAKAN_MASUK` /
`GERAKAN_KELUAR` in models.py are the single source of truth for which movement
types add versus remove stock, and net stock and stock value are computed by
`_net_stok_expr()` / `_nilai_stok_expr()` below. Do not compute stock any other
way — `_net_stok_map()` in particular is imported by api/riwayat.py so that
`_record_pemakaian` checks sufficiency against the same implementation the
standalone movement endpoint uses, rather than a second one that can drift.

**`id_gudang` is the pool every balance is scoped by** — the movement form, the
opening balance on part creation and both halves of a transfer all write it.
`id_lokasi`/`site_from`/`site_to` are older region-tree fields kept only so
existing transfer history keeps rendering; an opening balance written against
`id_lokasi` alone is invisible to every warehouse-scoped screen and impossible
to issue.

`sparepart.id_varian` is the compatibility link, and **NULL means "fits every
model of this tool"** — the common case. `/api/inventaris/parts` therefore
returns model-specific parts PLUS the universal ones.

Two placements that are deliberate, and are about shared internals rather than
about the URL:

- **`GET /api/inventaris/dashboard` lives here, not in api/dashboard.py.** It
  calls `_scope_stok`, `_net_stok_map`, `_nilai_stok_map`, `_stok_status`,
  `STOK_STATUS_ORDER` and `GERAKAN_LABEL` — six internals of this module.
- **`GET /api/aset/{id_aset}/pemakaian` lives here despite its /api/aset/ path**,
  because it shares `_pemakaian_row` and `_PEMAKAIAN_EAGER` with
  `/api/inventaris/pemakaian`. Module membership is not URL prefix; the path is
  unchanged either way.

`trigger_seed`'s `from seeds.inventaris import seed_spareparts` stays
FUNCTION-LOCAL. The seeding pipeline is tracked now, but it imports
`seed_katalog.py`, which RAISES on a checkout without the client's `modules/`
drop — deliberately, because the alternative was importing cleanly and silently
producing an empty catalogue. A module-level import here would turn that into a
boot failure for everyone rather than a 500 on the one endpoint that seeds.
"""

from datetime import datetime, date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_, func, case, select
from sqlalchemy.orm import Session, joinedload

import models
from api.deps import (
    get_current_user,
    get_db,
    require_role,
    resolve_lokasi_scope,
)
from api.realtime import manager
from api.schemas import (
    GudangCreate,
    GudangUpdate,
    SparePartCreate,
    SparePartKategoriCreate,
    SparePartUpdate,
    StokAdjustCreate,
    StokTransferCreate,
)

router = APIRouter()


# ── Helper: compute net stock ──────────────────────────────────────

def _net_stok_expr():
    """
    Signed sum of a stock ledger slice.

    Movement types that ADD stock (IN, RETUR_CUST, ADJ_IN) count positive;
    everything else (OUT, RETUR_VENDOR, ADJ_OUT) counts negative. Driven off
    SparePartStok.GERAKAN_MASUK so the vocabulary lives in exactly one place.
    """
    return func.coalesce(
        func.sum(
            case(
                (
                    models.SparePartStok.tipe_gerakan.in_(
                        models.SparePartStok.GERAKAN_MASUK
                    ),
                    models.SparePartStok.jumlah,
                ),
                else_=-models.SparePartStok.jumlah,
            )
        ),
        0,
    )


def _nilai_stok_expr():
    """Same signed sum, weighted by the price snapshot → stock VALUE in rupiah."""
    qty_x_price = models.SparePartStok.jumlah * func.coalesce(
        models.SparePartStok.harga_satuan, 0
    )
    return func.coalesce(
        func.sum(
            case(
                (
                    models.SparePartStok.tipe_gerakan.in_(
                        models.SparePartStok.GERAKAN_MASUK
                    ),
                    qty_x_price,
                ),
                else_=-qty_x_price,
            )
        ),
        0,
    )


def _scope_stok(q, id_lokasi=None, id_gudang=None):
    """Apply the optional lokasi / gudang scope to a sparepart_stok query."""
    if isinstance(id_lokasi, (list, tuple, set)):
        ids = list(id_lokasi)
        if not ids:
            return None  # an empty scope selects nothing, not everything
        q = q.filter(models.SparePartStok.id_lokasi.in_(ids))
    elif id_lokasi is not None:
        q = q.filter(models.SparePartStok.id_lokasi == id_lokasi)
    if id_gudang is not None:
        q = q.filter(models.SparePartStok.id_gudang == id_gudang)
    return q


def _net_stok_map(db: Session, id_lokasi=None, id_gudang=None) -> dict:
    """
    Net stock for EVERY part in one grouped query → {id_part: qty}.

    Prefer this over calling _net_stok() in a loop: the callers iterate the whole
    parts catalog (and, for per_lokasi mode, every child lokasi of a DAOP), which
    otherwise fans out into hundreds of round trips.

    id_lokasi: None → all lokasi summed; a str → that one; a list/set → those summed.
    id_gudang: None → all warehouses summed; an int → that one warehouse.
    """
    q = _scope_stok(
        db.query(models.SparePartStok.id_part, _net_stok_expr()).group_by(
            models.SparePartStok.id_part
        ),
        id_lokasi,
        id_gudang,
    )
    if q is None:
        return {}
    return {row[0]: int(row[1] or 0) for row in q.all()}


def _nilai_stok_map(db: Session, id_lokasi=None, id_gudang=None) -> dict:
    """Stock VALUE per part in one grouped query → {id_part: rupiah}."""
    q = _scope_stok(
        db.query(models.SparePartStok.id_part, _nilai_stok_expr()).group_by(
            models.SparePartStok.id_part
        ),
        id_lokasi,
        id_gudang,
    )
    if q is None:
        return {}
    return {row[0]: int(row[1] or 0) for row in q.all()}


def _net_stok(
    db: Session,
    id_part: int,
    id_lokasi: Optional[str] = None,
    id_gudang: Optional[int] = None,
) -> int:
    """
    Net stock for a single part. Both scopes None → the global pool.

    Prefer `id_gudang`: it is the pool the movement form writes to and the one
    every dashboard figure is computed against.
    """
    q = db.query(_net_stok_expr()).filter(models.SparePartStok.id_part == id_part)
    if id_gudang is not None:
        q = q.filter(models.SparePartStok.id_gudang == id_gudang)
    if id_lokasi is not None:
        q = q.filter(models.SparePartStok.id_lokasi == id_lokasi)
    return int(q.scalar() or 0)


# ── Part Categories ────────────────────────────────────────────────

@router.get("/api/inventaris/kategori")
def get_inv_kategori(
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    rows = db.query(models.SparePartKategori).order_by(
        models.SparePartKategori.subsistem, models.SparePartKategori.nama
    ).all()
    return [
        {
            "id_kategori": r.id_kategori,
            "nama": r.nama,
            "subsistem": r.subsistem,
            "kode_alat": r.kode_alat,
        }
        for r in rows
    ]


@router.post("/api/inventaris/kategori",
          dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH", "PETUGAS_GUDANG"]))])
async def create_inv_kategori(
    data: SparePartKategoriCreate, db: Session = Depends(get_db)
):
    if db.query(models.SparePartKategori).filter_by(nama=data.nama).first():
        raise HTTPException(status_code=400, detail="Kategori sudah ada.")
    row = models.SparePartKategori(
        nama=data.nama, subsistem=data.subsistem, kode_alat=data.kode_alat
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    await manager.broadcast("REFRESH_INVENTARIS")
    return {"message": "Kategori ditambahkan.", "id_kategori": row.id_kategori}


@router.put("/api/inventaris/kategori/{id_kategori}",
         dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH", "PETUGAS_GUDANG"]))])
async def update_inv_kategori(
    id_kategori: int,
    data: SparePartKategoriCreate,
    db: Session = Depends(get_db),
):
    """
    Rename / re-classify a category.

    Without this the only way to fix a typo was delete-and-recreate, which
    silently unlinks every part that pointed at the old row (SparePart.
    id_kategori is nullable, so the FK does not stop it).
    """
    row = db.query(models.SparePartKategori).filter_by(id_kategori=id_kategori).first()
    if not row:
        raise HTTPException(status_code=404, detail="Kategori tidak ditemukan.")

    clash = (
        db.query(models.SparePartKategori)
        .filter(
            models.SparePartKategori.nama == data.nama,
            models.SparePartKategori.id_kategori != id_kategori,
        )
        .first()
    )
    if clash:
        raise HTTPException(status_code=400, detail="Nama kategori sudah dipakai.")

    row.nama = data.nama
    row.subsistem = data.subsistem
    row.kode_alat = data.kode_alat
    db.commit()
    await manager.broadcast("REFRESH_INVENTARIS")
    return {"message": "Kategori diperbarui."}


@router.delete("/api/inventaris/kategori/{id_kategori}",
            dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH", "PETUGAS_GUDANG"]))])
async def delete_inv_kategori(id_kategori: int, db: Session = Depends(get_db)):
    row = db.query(models.SparePartKategori).filter_by(id_kategori=id_kategori).first()
    if not row:
        raise HTTPException(status_code=404, detail="Kategori tidak ditemukan.")

    # Detach the parts first. Deleting the category out from under them leaves
    # rows whose id_kategori points at nothing, which the parts list renders as
    # a blank subsistem column with no way to tell it apart from "never set".
    dipakai = (
        db.query(models.SparePart)
        .filter(models.SparePart.id_kategori == id_kategori)
        .count()
    )
    db.query(models.SparePart).filter(
        models.SparePart.id_kategori == id_kategori
    ).update({models.SparePart.id_kategori: None}, synchronize_session=False)

    db.delete(row)
    db.commit()
    await manager.broadcast("REFRESH_INVENTARIS")
    return {
        "message": "Kategori dihapus."
        + (f" {dipakai} suku cadang dilepas dari kategori ini." if dipakai else "")
    }


# ── Parts CRUD ─────────────────────────────────────────────────────

def _stok_status(stok: int, stok_min: int, stok_max: Optional[int]) -> str:
    """
    Items Master status vocabulary, in priority order.

    MINUS is checked before KOSONG because a negative balance is a data fault
    that must not be reported as merely "empty".
    """
    if stok < 0:
        return "MINUS"
    if stok == 0:
        return "KOSONG"
    if stok_min and stok < stok_min:
        return "KRITIS"
    if stok_min and stok == stok_min:
        return "DI BAWAH MIN"
    # RESERVED, and currently unreachable: `SparePart` has no `stok_max` column,
    # so every caller passes None. Kept rather than deleted because the branch is
    # correct and costs nothing — but it is deliberately absent from
    # STOK_STATUS_ORDER, so nothing renders a bucket that can only ever be zero.
    # Adding the column would be inventing a requirement: the client asked for a
    # minimum stock level, not a maximum.
    if stok_max and stok > stok_max:
        return "DI ATAS MAX"
    return "AMAN"


def _movement_breakdown(db: Session, id_lokasi=None, id_gudang=None, sejak=None) -> dict:
    """
    Per-part movement totals split by type → {id_part: {tipe: qty}}.

    One grouped query for the whole catalog; feeds the Items Master columns
    (Masuk, Keluar, Retur ke Vendor, Retur dari Customer, Penyesuaian ±).

    `sejak` restricts to movements at or after that datetime. Defaults to None —
    all time — so the Items Master columns, which are lifetime totals, are
    unaffected. The fast/slow classification passes a window, because a
    consumption rate with no period is not a rate.
    """
    q = _scope_stok(
        db.query(
            models.SparePartStok.id_part,
            models.SparePartStok.tipe_gerakan,
            func.coalesce(func.sum(models.SparePartStok.jumlah), 0),
        ).group_by(models.SparePartStok.id_part, models.SparePartStok.tipe_gerakan),
        id_lokasi,
        id_gudang,
    )
    if q is None:
        return {}
    if sejak is not None:
        q = q.filter(models.SparePartStok.waktu >= sejak)
    out: dict = {}
    for id_part, tipe, qty in q.all():
        out.setdefault(id_part, {})[tipe] = int(qty or 0)
    return out


def _last_out_map(db: Session) -> dict:
    """{id_part: last OUT timestamp} — drives 'Tanggal Terakhir Barang Keluar'."""
    rows = (
        db.query(
            models.SparePartStok.id_part,
            func.max(models.SparePartStok.waktu),
        )
        .filter(models.SparePartStok.tipe_gerakan.in_(models.SparePartStok.GERAKAN_KELUAR))
        .group_by(models.SparePartStok.id_part)
        .all()
    )
    return {r[0]: r[1] for r in rows}


@router.get("/api/inventaris/parts")
def get_inv_parts(
    id_lokasi: Optional[str] = None,
    id_gudang: Optional[int] = None,
    id_kategori: Optional[int] = None,
    kode_alat: Optional[str] = None,
    id_varian: Optional[int] = None,
    mode: str = "global",   # global | per_lokasi
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    Parts catalog with the full Items Master column set.

    `kode_alat` + `id_varian` together are the COMPATIBILITY filter the repair
    form uses to narrow the picker to the machine in front of the technician.
    Passing `id_varian` returns parts for that exact model PLUS the parts that
    fit any model of the tool (`id_varian IS NULL`) — a generic air filter is
    as valid for a GX390 as a GX390-specific carburettor, and excluding it
    would hide most of the catalogue from the form.
    """
    # The row loop reads p.kategori_ref, p.kategori_alat_ref and p.varian_ref,
    # which were lazy loads per part. get_inv_dashboard already eager-loads the
    # first two, so this was an inconsistency rather than a decision; varian_ref
    # joined the list when `nama_varian` replaced `sku` as the part's on-screen
    # identity, and would otherwise be a third N+1 over the whole catalogue.
    q = db.query(models.SparePart).options(
        joinedload(models.SparePart.kategori_ref),
        joinedload(models.SparePart.kategori_alat_ref),
        joinedload(models.SparePart.varian_ref),
    )
    if id_kategori:
        q = q.filter(models.SparePart.id_kategori == id_kategori)
    if kode_alat:
        q = q.filter(models.SparePart.kode_alat == kode_alat)
    if id_varian:
        q = q.filter(
            or_(
                models.SparePart.id_varian == id_varian,
                models.SparePart.id_varian.is_(None),
            )
        )
    parts = q.order_by(models.SparePart.nama_part).all()

    scope_lokasi = id_lokasi if mode == "per_lokasi" else None
    # Four grouped queries for the whole catalog, not four per part.
    stok_map = _net_stok_map(db, scope_lokasi, id_gudang)
    nilai_map = _nilai_stok_map(db, scope_lokasi, id_gudang)
    gerak_map = _movement_breakdown(db, scope_lokasi, id_gudang)
    last_out = _last_out_map(db)
    now = datetime.now()

    result = []
    for p in parts:
        stok = stok_map.get(p.id_part, 0)
        g = gerak_map.get(p.id_part, {})
        kat = p.kategori_ref
        alat = p.kategori_alat_ref
        masuk = g.get("IN", 0)
        keluar = g.get("OUT", 0)
        nilai_masuk = masuk * (p.harga_satuan or 0)
        nilai_keluar = keluar * (p.harga_satuan or 0)
        lo = last_out.get(p.id_part)
        # "Barang Tidak Bergerak" — days since the last issue. Never issued is
        # reported as None rather than 0, so the UI can say "belum pernah keluar"
        # instead of implying it moved today.
        idle_days = (now - lo).days if lo else None
        status = _stok_status(stok, p.stok_min or 0, None)
        result.append({
            "id_part": p.id_part,
            "nama_part": p.nama_part,
            "id_kategori": p.id_kategori,
            "nama_kategori": kat.nama if kat else None,
            "subsistem": kat.subsistem if kat else None,
            "kode_alat": p.kode_alat,
            "nama_alat": alat.nama_alat if alat else None,
            # Null means "fits every model of this tool" — the picker labels it
            # as universal rather than leaving the column blank.
            "id_varian": p.id_varian,
            # The model's NAME, not just its id. With `sku` gone, "nama_part +
            # alat kerja + Model/Type" is what identifies a part on screen — and
            # it is exactly the triple the seed dedupes on, so it is unique by
            # construction. The transaction form's combobox keys on it.
            "nama_varian": p.varian_ref.nama_varian if p.varian_ref else None,
            "unit": p.unit,
            "harga_satuan": p.harga_satuan,
            "stok_min": p.stok_min,
            "stok_sekarang": stok,
            # DERIVED, never stored. The dropped `is_critical` boolean was only
            # ever OR-ed into this same comparison, so it could not make a
            # well-stocked part critical on its own.
            "is_critical": stok <= p.stok_min and p.stok_min > 0,
            "auto_demand": p.auto_demand,
            # ── Items Master columns ──
            "map": p.harga_satuan or 0,          # moving average price
            "masuk": masuk,
            "keluar": keluar,
            "retur_vendor": g.get("RETUR_VENDOR", 0),
            "retur_customer": g.get("RETUR_CUST", 0),
            "penyesuaian_masuk": g.get("ADJ_IN", 0),
            "penyesuaian_keluar": g.get("ADJ_OUT", 0),
            "nilai_inventory": nilai_map.get(p.id_part, 0),
            "nilai_masuk": nilai_masuk,
            "nilai_keluar": nilai_keluar,
            "status_stok": status,
            "tanggal_terakhir_keluar": lo.strftime("%Y-%m-%d") if lo else None,
            "hari_tidak_bergerak": idle_days,
        })
    return result


@router.post("/api/inventaris/parts",
          dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH", "PETUGAS_GUDANG"]))])
async def create_inv_part(
    data: SparePartCreate,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    # No SKU to mint or check for collisions. It used to be auto-generated here
    # as `SP{count + 1:05d}` — a code derived from a row COUNT, which is the
    # same defect the asset `urutan` had: deleting any part made the next create
    # reuse a live number and fail the uniqueness check permanently, since every
    # retry recomputed the same count. A part is now identified by what it is
    # and what it fits, so there is nothing left to collide.
    part = models.SparePart(
        nama_part=data.nama_part, id_kategori=data.id_kategori,
        kode_alat=data.kode_alat, unit=data.unit, harga_satuan=data.harga_satuan,
        stok_min=data.stok_min, auto_demand=data.auto_demand,
    )
    db.add(part)
    db.flush()

    if data.jumlah_awal > 0:
        # The opening balance MUST carry id_gudang. Every balance query scopes
        # by warehouse (_scope_stok), so a row with only id_lokasi set was
        # invisible the moment a gudang filter was applied and could never be
        # issued — an OUT validates against the warehouse pool and saw 0.
        if not data.id_gudang_awal:
            raise HTTPException(
                status_code=400,
                detail="Gudang wajib dipilih saat mengisi stok awal.",
            )
        if not db.query(models.Gudang).filter_by(
            id_gudang=data.id_gudang_awal
        ).first():
            raise HTTPException(status_code=404, detail="Gudang tidak ditemukan.")

        db.add(models.SparePartStok(
            id_part=part.id_part,
            id_gudang=data.id_gudang_awal,
            id_lokasi=data.id_lokasi_awal,
            tipe_gerakan="IN",
            jumlah=data.jumlah_awal,
            harga_satuan=data.harga_satuan,
            keterangan="Stok awal",
            id_pengguna=current_user.id_pengguna,
        ))

    db.commit()
    db.refresh(part)
    await manager.broadcast("REFRESH_INVENTARIS")
    return {"message": "Part berhasil ditambahkan.", "id_part": part.id_part}


@router.get("/api/inventaris/parts/{id_part}")
def get_inv_part_detail(
    id_part: int,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    One part: identity, and its balance broken down PER GUDANG.

    The Kartu Riwayat card needs both. `/api/inventaris/parts` already carries
    the identity but only a single summed `stok_sekarang`, and the movement
    ledger at `/api/inventaris/stok?id_part=` carries the timeline but no
    identity — so this fills the one gap rather than duplicating either.

    ── Why per gudang, and per gudang only ──

    `id_gudang` is the pool every balance is scoped by: the movement form, the
    opening balance on part creation, and both halves of a transfer all write
    it. `id_lokasi` / `site_from` / `site_to` on `sparepart_stok` are older
    region-tree columns kept only so existing transfer history keeps rendering —
    a balance grouped by those would not match what any issuing screen shows.

    Read-only and open to any authenticated role: a technician needs to know
    where a part is before asking for it, and this writes nothing.
    """
    p = (
        db.query(models.SparePart)
        .options(
            joinedload(models.SparePart.kategori_ref),
            joinedload(models.SparePart.kategori_alat_ref),
            joinedload(models.SparePart.varian_ref),
        )
        .filter(models.SparePart.id_part == id_part)
        .first()
    )
    if not p:
        raise HTTPException(status_code=404, detail="Suku cadang tidak ditemukan.")

    # One grouped query rather than _net_stok_map() once per warehouse. Same
    # expression either way, so the total below cannot drift from the Items
    # Master figure.
    rows = (
        db.query(
            models.SparePartStok.id_gudang,
            models.Gudang.nama,
            _net_stok_expr(),
        )
        .outerjoin(models.Gudang, models.Gudang.id_gudang == models.SparePartStok.id_gudang)
        .filter(models.SparePartStok.id_part == id_part)
        .group_by(models.SparePartStok.id_gudang, models.Gudang.nama)
        .order_by(models.Gudang.nama)
        .all()
    )
    per_gudang = [
        {
            "id_gudang": g,
            # Movements written before `id_gudang` existed have none. Saying so
            # is better than folding them into an arbitrary warehouse.
            "nama": nama or "(tanpa gudang)",
            "stok": int(qty or 0),
        }
        for g, nama, qty in rows
    ]
    total = sum(x["stok"] for x in per_gudang)
    kat = p.kategori_ref

    return {
        "id_part": p.id_part,
        "nama_part": p.nama_part,
        "unit": p.unit,
        "harga_satuan": p.harga_satuan,
        "stok_min": p.stok_min,
        "stok_sekarang": total,
        "status_stok": _stok_status(total, p.stok_min or 0, None),
        "auto_demand": p.auto_demand,
        "nama_kategori": kat.nama if kat else None,
        "subsistem": kat.subsistem if kat else None,
        "kode_alat": p.kode_alat,
        "nama_alat": p.kategori_alat_ref.nama_alat if p.kategori_alat_ref else None,
        # NULL means "fits every model of this tool" — the common case.
        "id_varian": p.id_varian,
        "nama_varian": p.varian_ref.nama_varian if p.varian_ref else None,
        "universal": p.id_varian is None,
        "per_gudang": per_gudang,
    }


@router.put("/api/inventaris/parts/{id_part}",
         dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH", "PETUGAS_GUDANG"]))])
async def update_inv_part(
    id_part: int, data: SparePartUpdate, db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    part = db.query(models.SparePart).filter_by(id_part=id_part).first()
    if not part:
        raise HTTPException(status_code=404, detail="Part tidak ditemukan.")
    for field, val in data.dict(exclude_unset=True).items():
        setattr(part, field, val)
    db.commit()
    await manager.broadcast("REFRESH_INVENTARIS")
    return {"message": "Part diperbarui."}


@router.delete("/api/inventaris/parts/{id_part}",
            dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH", "PETUGAS_GUDANG"]))])
async def delete_inv_part(
    id_part: int, db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    part = db.query(models.SparePart).filter_by(id_part=id_part).first()
    if not part:
        raise HTTPException(status_code=404, detail="Part tidak ditemukan.")
    db.delete(part)
    db.commit()
    await manager.broadcast("REFRESH_INVENTARIS")
    return {"message": "Part dihapus."}


# ── Stock: Transfer ────────────────────────────────────────────────

@router.post("/api/inventaris/transfer",
          dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH", "PETUGAS_GUDANG"]))])
async def create_transfer(
    data: StokTransferCreate, db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    Move stock between two warehouses as a linked OUT/IN pair.

    Warehouse-to-warehouse is the real movement — stock lives in a gudang, and
    that is the pool every balance query scopes by. The id_lokasi_* form is
    still accepted for older callers and is recorded on both rows so existing
    transfer history keeps rendering, but when gudang ids are supplied they are
    what the availability check and the ledger rows use.
    """
    part = db.query(models.SparePart).filter_by(id_part=data.id_part).first()
    if not part:
        raise HTTPException(status_code=404, detail="Part tidak ditemukan.")
    if data.jumlah <= 0:
        raise HTTPException(status_code=400, detail="Jumlah harus lebih dari 0.")

    pakai_gudang = data.id_gudang_asal is not None or data.id_gudang_tujuan is not None
    if pakai_gudang:
        if data.id_gudang_asal is None or data.id_gudang_tujuan is None:
            raise HTTPException(
                status_code=400, detail="Gudang asal dan tujuan wajib diisi."
            )
        if data.id_gudang_asal == data.id_gudang_tujuan:
            raise HTTPException(
                status_code=400, detail="Gudang asal dan tujuan tidak boleh sama."
            )
        gudang_rows = {
            g.id_gudang: g
            for g in db.query(models.Gudang)
            .filter(
                models.Gudang.id_gudang.in_(
                    [data.id_gudang_asal, data.id_gudang_tujuan]
                )
            )
            .all()
        }
        if len(gudang_rows) != 2:
            raise HTTPException(status_code=404, detail="Gudang tidak ditemukan.")
        label_asal = gudang_rows[data.id_gudang_asal].nama
        label_tujuan = gudang_rows[data.id_gudang_tujuan].nama
    else:
        label_asal = data.id_lokasi_asal or "GLOBAL"
        label_tujuan = data.id_lokasi_tujuan or "GLOBAL"

    # Check available stock at source, in whichever pool the caller is using.
    stok_asal = _net_stok(
        db,
        data.id_part,
        id_lokasi=None if pakai_gudang else data.id_lokasi_asal,
        id_gudang=data.id_gudang_asal if pakai_gudang else None,
    )
    if stok_asal < data.jumlah:
        raise HTTPException(
            status_code=400,
            detail=f"Stok tidak mencukupi. Tersedia: {stok_asal}, diminta: {data.jumlah}."
        )

    now = datetime.now()
    shared = dict(
        id_part=data.id_part,
        harga_satuan=part.harga_satuan,
        id_pengguna=current_user.id_pengguna,
        waktu=now,
        site_from=data.id_lokasi_asal,
        site_to=data.id_lokasi_tujuan,
        transfer_by=data.transfer_by or current_user.username,
        transfer_to=data.transfer_to,
        catatan=data.catatan,
        jumlah=data.jumlah,
    )

    # OUT from source
    out_row = models.SparePartStok(
        id_gudang=data.id_gudang_asal,
        id_lokasi=data.id_lokasi_asal,
        tipe_gerakan="OUT",
        keterangan=f"Transfer ke {label_tujuan}",
        **shared,
    )
    db.add(out_row)
    db.flush()

    # IN to destination
    in_row = models.SparePartStok(
        id_gudang=data.id_gudang_tujuan,
        id_lokasi=data.id_lokasi_tujuan,
        tipe_gerakan="IN",
        keterangan=f"Transfer dari {label_asal}",
        id_ref_transfer=out_row.id_stok,
        **shared,
    )
    db.add(in_row)
    db.commit()
    await manager.broadcast("REFRESH_INVENTARIS")
    return {"message": "Transfer berhasil.", "id_out": out_row.id_stok, "id_in": in_row.id_stok}


@router.get("/api/inventaris/transfer")
def get_transfer_history(
    id_lokasi: Optional[str] = None,
    id_gudang: Optional[int] = None,
    id_part: Optional[int] = None,
    limit: int = Query(200, ge=1, le=2000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    Transfer ledger, newest first.

    Genuinely server-paged: this table is append-only and unbounded, unlike the
    asset/parts payloads which are small enough to cache client-side. Returns an
    envelope so the UI can render "showing X of Y".
    """
    SS = models.SparePartStok

    # A transfer is the OUT half of a linked pair. Region-tree transfers are
    # identified by site_from; warehouse transfers leave site_from NULL, so they
    # are identified by the IN row that points back at them. Testing only
    # site_from — as this did — hid every gudang-to-gudang move.
    paired = select(SS.id_ref_transfer).where(SS.id_ref_transfer.isnot(None))
    q = db.query(SS).filter(
        SS.tipe_gerakan == "OUT",
        or_(SS.site_from.isnot(None), SS.id_stok.in_(paired)),
    )
    if id_lokasi:
        q = q.filter(
            (models.SparePartStok.site_from == id_lokasi) |
            (models.SparePartStok.site_to == id_lokasi)
        )
    if id_gudang:
        # Match a transfer if the warehouse is either end of it: the OUT row
        # carries the source, and the IN row that references it the destination.
        q = q.filter(
            or_(
                SS.id_gudang == id_gudang,
                SS.id_stok.in_(
                    select(SS.id_ref_transfer).where(SS.id_gudang == id_gudang)
                ),
            )
        )
    if id_part:
        q = q.filter(models.SparePartStok.id_part == id_part)

    total = q.count()
    rows = (
        # Eager-load everything the row loop touches. Without these the loop
        # below lazy-loaded part_ref, site_from_ref, site_to_ref and
        # part_ref.kategori_alat_ref — four round trips per row, so 800 for a
        # single default page of 200.
        q.options(
            joinedload(SS.part_ref).joinedload(models.SparePart.kategori_alat_ref),
            joinedload(SS.site_from_ref),
            joinedload(SS.site_to_ref),
        )
        .order_by(models.SparePartStok.waktu.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    # Destination warehouse lives on the paired IN row, so resolve those in one
    # query rather than lazy-loading per row.
    out_ids = [r.id_stok for r in rows]
    pair_gudang_by_out = {}
    if out_ids:
        for ref, gid in db.execute(
            select(SS.id_ref_transfer, SS.id_gudang).where(SS.id_ref_transfer.in_(out_ids))
        ):
            pair_gudang_by_out[ref] = gid
    gudang_names = {g.id_gudang: g.nama for g in db.query(models.Gudang).all()}

    result = []
    for r in rows:
        p = r.part_ref
        sf = r.site_from_ref
        st = r.site_to_ref
        g_from = gudang_names.get(r.id_gudang)
        g_to = gudang_names.get(pair_gudang_by_out.get(r.id_stok))
        result.append({
            "id_stok": r.id_stok,
            "waktu": r.waktu.strftime("%Y-%m-%d %H:%M") if r.waktu else None,
            "nama_part": p.nama_part if p else str(r.id_part),
            "jumlah": r.jumlah,
            "unit": p.unit if p else "",
            "nama_alat": p.kategori_alat_ref.nama_alat if p and p.kategori_alat_ref else "",
            # Prefer the warehouse names; fall back to the region-tree fields so
            # transfers recorded before gudang existed still read correctly.
            "site_from": g_from or (sf.nama_lokasi if sf else (r.site_from or "GLOBAL")),
            "site_to": g_to or (st.nama_lokasi if st else (r.site_to or "GLOBAL")),
            "transfer_by": r.transfer_by or "—",
            "transfer_to": r.transfer_to or "—",
            "catatan": r.catatan or "—",
        })
    return {"total": total, "limit": limit, "offset": offset, "items": result}


# ── Gudang (warehouse) ─────────────────────────────────────────────
# Flat, deliberately NOT part of the DAOP/UPT lokasi hierarchy: parts live in a
# handful of named stores that don't map onto the operational region tree.

@router.get("/api/inventaris/gudang")
def get_gudang(
    include_inactive: bool = False,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    q = db.query(models.Gudang)
    if not include_inactive:
        q = q.filter(models.Gudang.is_active.is_(True))
    rows = q.order_by(models.Gudang.kode).all()
    return [
        {
            "id_gudang": g.id_gudang,
            "kode": g.kode,
            "nama": g.nama,
            "keterangan": g.keterangan,
            "is_active": g.is_active,
        }
        for g in rows
    ]


@router.post(
    "/api/inventaris/gudang",
    dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH", "PETUGAS_GUDANG"]))],
)
async def create_gudang(data: GudangCreate, db: Session = Depends(get_db)):
    kode = data.kode.strip().upper()
    if not kode:
        raise HTTPException(status_code=400, detail="Kode gudang wajib diisi.")
    if not (data.nama or "").strip():
        raise HTTPException(status_code=400, detail="Nama gudang wajib diisi.")
    if db.query(models.Gudang).filter_by(kode=kode).first():
        raise HTTPException(status_code=400, detail="Kode gudang sudah dipakai.")
    row = models.Gudang(
        kode=kode,
        nama=data.nama.strip(),
        keterangan=data.keterangan,
        is_active=data.is_active,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    # Without this a new warehouse stays missing from every other client's
    # movement dropdown until they navigate away and back.
    await manager.broadcast("REFRESH_INVENTARIS")
    return {"message": "Gudang ditambahkan.", "id_gudang": row.id_gudang}


@router.put(
    "/api/inventaris/gudang/{id_gudang}",
    dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH", "PETUGAS_GUDANG"]))],
)
async def update_gudang(
    id_gudang: int, data: GudangUpdate, db: Session = Depends(get_db)
):
    row = db.query(models.Gudang).filter_by(id_gudang=id_gudang).first()
    if not row:
        raise HTTPException(status_code=404, detail="Gudang tidak ditemukan.")

    payload = data.model_dump(exclude_unset=True)
    if "kode" in payload and payload["kode"]:
        kode = payload["kode"].strip().upper()
        clash = (
            db.query(models.Gudang)
            .filter(models.Gudang.kode == kode, models.Gudang.id_gudang != id_gudang)
            .first()
        )
        if clash:
            raise HTTPException(status_code=400, detail="Kode gudang sudah dipakai.")

    for field, value in payload.items():
        setattr(row, field, value.strip().upper() if field == "kode" else value)
    db.commit()
    await manager.broadcast("REFRESH_INVENTARIS")
    return {"message": "Gudang diperbarui."}


@router.delete(
    "/api/inventaris/gudang/{id_gudang}",
    dependencies=[Depends(require_role(["SUPER_ADMIN"]))],
)
async def delete_gudang(id_gudang: int, db: Session = Depends(get_db)):
    row = db.query(models.Gudang).filter_by(id_gudang=id_gudang).first()
    if not row:
        raise HTTPException(status_code=404, detail="Gudang tidak ditemukan.")
    # Never orphan ledger rows — deactivate instead of deleting if stock moved.
    used = (
        db.query(models.SparePartStok)
        .filter(models.SparePartStok.id_gudang == id_gudang)
        .first()
    )
    if used:
        row.is_active = False
        db.commit()
        await manager.broadcast("REFRESH_INVENTARIS")
        return {"message": "Gudang dinonaktifkan (masih punya riwayat stok)."}
    db.delete(row)
    db.commit()
    await manager.broadcast("REFRESH_INVENTARIS")
    return {"message": "Gudang dihapus."}


# ── Stock movement (Transaksi Barang) ──────────────────────────────

@router.post(
    "/api/inventaris/stok",
    dependencies=[
        Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH", "PETUGAS_GUDANG"]))
    ],
)
async def create_stok_movement(
    data: StokAdjustCreate,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    Log one stock movement.

    This is the capability that closes the loop on the parts module: until now
    stock could be created with a part and transferred between sites, but never
    consumed, restocked, returned or corrected.

    A TEKNISI may record movements (they are the ones consuming parts) but not
    edit the catalogue; the explicit role list is there so the endpoint fails
    closed for any role added later, rather than defaulting to open.
    """
    tipe = (data.tipe_gerakan or "").strip().upper()
    valid = models.SparePartStok.GERAKAN_MASUK + models.SparePartStok.GERAKAN_KELUAR
    if tipe not in valid:
        raise HTTPException(
            status_code=400,
            detail=f"Tipe gerakan tidak dikenal. Pilihan: {', '.join(valid)}.",
        )
    if data.jumlah is None or data.jumlah <= 0:
        raise HTTPException(status_code=400, detail="Jumlah harus lebih dari nol.")

    part = db.query(models.SparePart).filter_by(id_part=data.id_part).first()
    if not part:
        raise HTTPException(status_code=404, detail="Part tidak ditemukan.")

    if data.id_gudang is not None:
        if not db.query(models.Gudang).filter_by(id_gudang=data.id_gudang).first():
            raise HTTPException(status_code=404, detail="Gudang tidak ditemukan.")

    # Refuse to drive stock negative — a warehouse cannot issue what it lacks.
    if tipe in models.SparePartStok.GERAKAN_KELUAR:
        current = _net_stok_map(
            db, id_lokasi=data.id_lokasi, id_gudang=data.id_gudang
        ).get(data.id_part, 0)
        if data.jumlah > current:
            raise HTTPException(
                status_code=400,
                detail=f"Stok tidak mencukupi. Tersedia {current} {part.unit}.",
            )

    row = models.SparePartStok(
        id_part=data.id_part,
        id_gudang=data.id_gudang,
        id_lokasi=data.id_lokasi,
        tipe_gerakan=tipe,
        jumlah=data.jumlah,
        # Snapshot the price at entry time so historical value never re-prices.
        harga_satuan=data.harga_satuan
        if data.harga_satuan is not None
        else part.harga_satuan,
        keterangan=data.keterangan,
        id_pengguna=current_user.id_pengguna,
    )
    if data.tanggal:
        row.waktu = datetime.combine(data.tanggal, datetime.min.time())
    db.add(row)
    db.commit()
    db.refresh(row)

    await manager.broadcast("REFRESH_INVENTARIS")
    stok_baru = _net_stok_map(
        db, id_lokasi=data.id_lokasi, id_gudang=data.id_gudang
    ).get(data.id_part, 0)
    return {
        "message": "Transaksi barang dicatat.",
        "id_stok": row.id_stok,
        "stok_sekarang": stok_baru,
    }


@router.get("/api/inventaris/stok")
def get_stok_movements(
    id_part: Optional[int] = None,
    id_gudang: Optional[int] = None,
    tipe_gerakan: Optional[str] = None,
    limit: int = Query(100, ge=1, le=2000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """Movement ledger for the Transaksi Barang running table."""
    q = db.query(models.SparePartStok).filter(
        models.SparePartStok.site_from.is_(None)  # exclude transfer legs
    )
    if id_part:
        q = q.filter(models.SparePartStok.id_part == id_part)
    if id_gudang:
        q = q.filter(models.SparePartStok.id_gudang == id_gudang)
    if tipe_gerakan:
        q = q.filter(models.SparePartStok.tipe_gerakan == tipe_gerakan.upper())

    total = q.count()
    rows = (
        q.options(
            # `.kategori_ref` is nested: the row loop reads
            # p.kategori_ref.subsistem, which was one extra query per row —
            # 100 per default page — despite part_ref itself being eager.
            joinedload(models.SparePartStok.part_ref).joinedload(
                models.SparePart.kategori_ref
            ),
            joinedload(models.SparePartStok.gudang_ref),
            joinedload(models.SparePartStok.pengguna_ref),
        )
        .order_by(models.SparePartStok.waktu.desc(), models.SparePartStok.id_stok.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    items = []
    for r in rows:
        p = r.part_ref
        harga = r.harga_satuan or 0
        items.append(
            {
                "id_stok": r.id_stok,
                "waktu": r.waktu.strftime("%Y-%m-%d %H:%M") if r.waktu else None,
                "id_part": r.id_part,
                "nama_part": p.nama_part if p else str(r.id_part),
                "unit": p.unit if p else "",
                "jenis": p.kategori_ref.subsistem if p and p.kategori_ref else None,
                "tipe_gerakan": r.tipe_gerakan,
                "jumlah": r.jumlah,
                "harga_satuan": harga,
                "amount": harga * r.jumlah,
                "id_gudang": r.id_gudang,
                "gudang": r.gudang_ref.nama if r.gudang_ref else "—",
                "user": r.pengguna_ref.username if r.pengguna_ref else "—",
                "keterangan": r.keterangan or "—",
            }
        )
    return {"total": total, "limit": limit, "offset": offset, "items": items}

# ══════════════════════════════════════════════════════════════════
# ── PEMAKAIAN SPAREPART (inventory ↔ pemeliharaan) ────────────────
# ══════════════════════════════════════════════════════════════════


def _pemakaian_row(p) -> dict:
    """One shape for a usage row, shared by both read routes below."""
    part = p.part_ref
    harga = p.harga_satuan or 0
    return {
        "id_pakai": p.id_pakai,
        "id_riwayat": p.id_riwayat,
        "id_aset": p.id_aset,
        "id_part": p.id_part,
        "nama_part": part.nama_part if part else str(p.id_part),
        "unit": part.unit if part else "",
        "jumlah": p.jumlah,
        "harga_satuan": harga,
        "subtotal": harga * p.jumlah,
        "id_gudang": p.id_gudang,
        "gudang": p.gudang_ref.nama if p.gudang_ref else "—",
        "keterangan": p.keterangan or "—",
        "waktu": p.waktu.strftime("%Y-%m-%d %H:%M") if p.waktu else None,
    }


_PEMAKAIAN_EAGER = (
    joinedload(models.PemakaianSparepart.part_ref),
    joinedload(models.PemakaianSparepart.gudang_ref),
)


@router.get("/api/aset/{id_aset}/pemakaian")
def get_pemakaian_aset(
    id_aset: str,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    Parts consumed by this asset, grouped by the repair that consumed them.

    Keyed by `id_riwayat` so the detail screen and landing.html can hang each
    group under its own row in the Pemeliharaan table without a second lookup.
    """
    rows = (
        db.query(models.PemakaianSparepart)
        .options(*_PEMAKAIAN_EAGER)
        .filter(models.PemakaianSparepart.id_aset == id_aset)
        .order_by(models.PemakaianSparepart.waktu.asc())
        .all()
    )
    by_riwayat: dict = {}
    total = 0
    for r in rows:
        item = _pemakaian_row(r)
        total += item["subtotal"]
        by_riwayat.setdefault(str(r.id_riwayat), []).append(item)
    return {
        "id_aset": id_aset,
        "total_biaya": total,
        "total_item": len(rows),
        "per_riwayat": by_riwayat,
    }


@router.get("/api/inventaris/pemakaian")
def get_pemakaian_list(
    id_part: Optional[int] = None,
    id_aset: Optional[str] = None,
    id_gudang: Optional[int] = None,
    dari: Optional[date] = None,
    sampai: Optional[date] = None,
    limit: int = Query(100, ge=1, le=2000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    Consumption ledger — which part went into which machine, and what it cost.

    Same `{total, limit, offset, items}` envelope as `get_stok_movements` and
    `get_transfer_history`, so the frontend paginator needs no special case.
    """
    q = db.query(models.PemakaianSparepart)
    if id_part:
        q = q.filter(models.PemakaianSparepart.id_part == id_part)
    if id_aset:
        q = q.filter(models.PemakaianSparepart.id_aset == id_aset)
    if id_gudang:
        q = q.filter(models.PemakaianSparepart.id_gudang == id_gudang)
    if dari:
        q = q.filter(models.PemakaianSparepart.waktu >= datetime.combine(dari, datetime.min.time()))
    if sampai:
        q = q.filter(models.PemakaianSparepart.waktu <= datetime.combine(sampai, datetime.max.time()))

    total = q.count()
    # Summed over the WHOLE filtered set, not the page: a per-page total would
    # change every time the user clicked "next" and mean nothing.
    total_biaya = (
        q.with_entities(
            func.coalesce(
                func.sum(
                    models.PemakaianSparepart.jumlah
                    * func.coalesce(models.PemakaianSparepart.harga_satuan, 0)
                ),
                0,
            )
        ).scalar()
        or 0
    )
    rows = (
        q.options(*_PEMAKAIAN_EAGER)
        .order_by(
            models.PemakaianSparepart.waktu.desc(),
            models.PemakaianSparepart.id_pakai.desc(),
        )
        .offset(offset)
        .limit(limit)
        .all()
    )
    return {
        "total": total,
        "total_biaya": int(total_biaya),
        "limit": limit,
        "offset": offset,
        "items": [_pemakaian_row(r) for r in rows],
    }


# ── Dasbor Inventaris (stock dashboard) ────────────────────────────

# "DI ATAS MAX" is NOT in this list, and its absence is the point.
#
# `SparePart` has no `stok_max` column, so `_stok_status()` is only ever called
# with `stok_max=None` and can never return it. Listing it here made the
# dashboard's status chart carry a permanent zero segment and print a legend
# entry for a category that cannot exist — a tile that reads as real data and is
# structurally incapable of being non-zero.
#
# The status itself stays in `_stok_status()`, documented as reserved. The
# client's poster asks for MINIMUM stock, not maximum, so adding the column to
# make this reachable would be inventing a requirement rather than meeting one.
STOK_STATUS_ORDER = ["MINUS", "KOSONG", "KRITIS", "DI BAWAH MIN", "AMAN"]

# Human labels for the movement vocabulary, in the order the printed report
# lists them under "TRANSAKSI BARANG PER PERIODE".
GERAKAN_LABEL = [
    ("IN", "Masuk"),
    ("OUT", "Keluar"),
    ("RETUR_CUST", "Retur dari Customer"),
    ("RETUR_VENDOR", "Retur ke Vendor"),
    ("ADJ_IN", "Penyesuaian Masuk"),
    ("ADJ_OUT", "Penyesuaian Keluar"),
]


@router.get("/api/inventaris/hirarki")
def get_hirarki_part(
    kode_alat: Optional[str] = None,
    id_gudang: Optional[int] = None,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    The BOM tree: alat kerja → subsistem → kategori → part.

    The client's matrix asks for this as *"Hierarki Part ▸ Tree ▸ Struktur BOM,
    input Jenis alat, output Tree, klik part buka detail & history"* — the one
    line marked High that had no implementation at all.

    Two call shapes:

      * **no `kode_alat`** → the INDEX for the selector: every tool type that
        actually has spareparts, with its part count.
      * **`kode_alat=XXX`** → the tree for that tool.

    ── Why the index only lists tools that HAVE parts ──

    17 of the 104 katalog tool types have any sparepart registered. A selector
    offering all 104 would leave 87 choices rendering an empty tree, which reads
    as a broken feature rather than as an answer — so the list is the 17, and
    `cakupan` carries both numbers so the UI can state the gap plainly. The
    missing 87 are data yet to be entered, and saying so is more useful than
    hiding it or pretending it is a fault.

    ── Stock is not recomputed here ──

    `_net_stok_map()` and `_stok_status()` are the same helpers the Items Master
    uses, so a part's stock in the tree cannot disagree with its stock in the
    table. `SparePartStok.GERAKAN_MASUK` / `GERAKAN_KELUAR` remain the single
    source of truth for what adds versus removes; a second implementation here
    would be a second thing to keep correct.

    ── Three levels here, often two on screen ──

    The payload keeps `subsistem → kategori → part` because that is the true
    shape of the data. But in the catalogue as it stands, EVERY
    (kode_alat, subsistem) pair has exactly one kategori, and that kategori is
    named "SUBSISTEM — TOOL NAME" — so drawing it would add a level that always
    has one child and whose label restates its parent. That looks like structure
    while carrying no information.

    So the renderer collapses any kategori level with a single child, which is a
    rule about the SHAPE rather than about today's data: if the catalogue is ever
    split so a tool has two categories under one subsistem, the level reappears
    on its own. Flattening it here instead would have thrown that away
    permanently.
    """
    total_alat = db.query(models.KategoriAlat).count()

    # ── The selector index ──
    if not kode_alat:
        rows = (
            db.query(
                models.SparePart.kode_alat,
                models.KategoriAlat.nama_alat,
                func.count(models.SparePart.id_part),
            )
            .join(
                models.KategoriAlat,
                models.KategoriAlat.kode_alat == models.SparePart.kode_alat,
            )
            .filter(models.SparePart.kode_alat.isnot(None))
            .group_by(models.SparePart.kode_alat, models.KategoriAlat.nama_alat)
            .order_by(models.KategoriAlat.nama_alat)
            .all()
        )
        return {
            "alat": [
                {"kode_alat": k, "nama_alat": n, "jumlah_part": int(c)}
                for k, n, c in rows
            ],
            "cakupan": {"dengan_part": len(rows), "total_alat": total_alat},
        }

    alat = db.query(models.KategoriAlat).filter_by(kode_alat=kode_alat).first()
    if not alat:
        raise HTTPException(status_code=404, detail="Alat kerja tidak ditemukan.")

    parts = (
        db.query(models.SparePart)
        .options(
            joinedload(models.SparePart.kategori_ref),
            joinedload(models.SparePart.varian_ref),
        )
        .filter(models.SparePart.kode_alat == kode_alat)
        .order_by(models.SparePart.nama_part)
        .all()
    )

    stok_map = _net_stok_map(db, None, id_gudang)

    # subsistem → kategori → [part]. Both levels are grouped in Python rather
    # than by a nested query: it is ~200 rows at most for one tool, and one pass
    # keeps the ordering rules (below) in a single readable place.
    tree: dict = {}
    for p in parts:
        kat = p.kategori_ref
        sub = (kat.subsistem if kat else None) or "LAIN-LAIN"
        kat_nama = (kat.nama if kat else None) or "Tanpa Kategori"
        stok = int(stok_map.get(p.id_part, 0))
        node = {
            "id_part": p.id_part,
            "nama_part": p.nama_part,
            "unit": p.unit,
            "harga_satuan": p.harga_satuan,
            "stok_min": p.stok_min,
            "stok_sekarang": stok,
            "status_stok": _stok_status(stok, p.stok_min or 0, None),
            # NULL is the COMMON case and means "fits every model of this tool".
            # The renderer must say so — leaving it blank reads as missing data
            # about a part when it is a positive fact about its compatibility.
            "id_varian": p.id_varian,
            "nama_varian": p.varian_ref.nama_varian if p.varian_ref else None,
            "universal": p.id_varian is None,
        }
        tree.setdefault(sub, {}).setdefault(kat_nama, []).append(node)

    # Subsistems in a fixed order so the tree does not reshuffle between tools;
    # anything unrecognised sorts after the four known ones rather than being
    # dropped.
    SUB_ORDER = ["ENGINE", "ELECTRIC", "MECHANIC", "CONSUMABLES"]
    def _sub_key(name):
        return (SUB_ORDER.index(name) if name in SUB_ORDER else len(SUB_ORDER), name)

    subsistem = []
    for sub in sorted(tree, key=_sub_key):
        kategori = [
            {"nama": nama, "parts": items, "jumlah_part": len(items)}
            for nama, items in sorted(tree[sub].items())
        ]
        subsistem.append({
            "nama": sub,
            "kategori": kategori,
            "jumlah_part": sum(k["jumlah_part"] for k in kategori),
        })

    return {
        "kode_alat": alat.kode_alat,
        "nama_alat": alat.nama_alat,
        "kelompok": alat.kelompok,
        "jumlah_part": len(parts),
        "subsistem": subsistem,
        "cakupan": {"total_alat": total_alat},
    }


@router.get("/api/inventaris/dashboard")
def get_inv_dashboard(
    id_lokasi: Optional[str] = None,     # parent lokasi filter (DAOP/DIVRE)
    id_gudang: Optional[int] = None,     # single warehouse
    mode: str = "global",                # global | per_lokasi
    dari: Optional[date] = None,         # period start (movement stats only)
    sampai: Optional[date] = None,       # period end
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    Aggregated stock stats for the Kelola Inventaris dashboard.

    Two different time semantics live here, deliberately:
      - STOCK figures (value now, status counts) are point-in-time — the whole
        ledger up to today, never windowed, or the balance would be wrong.
      - MOVEMENT figures (nilai masuk/keluar, transaksi per periode) ARE
        windowed by dari/sampai, because that is what the printed report shows.
    """
    all_parts = db.query(models.SparePart).options(
        joinedload(models.SparePart.kategori_ref),
        joinedload(models.SparePart.kategori_alat_ref),
    ).all()

    # UPT ids do NOT start with their parent code ("JR1.1" belongs to "D1"), so a
    # LIKE prefix match is wrong in both directions — see resolve_lokasi_scope().
    child_lokasi_ids, _parent_row, _child_rows = resolve_lokasi_scope(db, id_lokasi)
    scope_lokasi = (
        child_lokasi_ids if (mode == "per_lokasi" and child_lokasi_ids) else None
    )

    # Default the period to the current month, matching the report's DARI/KE.
    today = date.today()
    if not dari:
        dari = today.replace(day=1)
    if not sampai:
        sampai = today

    # ── Point-in-time stock ──
    stok_map = _net_stok_map(db, scope_lokasi, id_gudang)
    nilai_map = _nilai_stok_map(db, scope_lokasi, id_gudang)

    total_parts = len(all_parts)
    total_types = len(set(p.kode_alat for p in all_parts if p.kode_alat))
    total_value = 0
    auto_demand_count = sum(1 for p in all_parts if p.auto_demand)
    critical_list = []
    top_value_list = []
    by_subsistem: dict = {}
    by_alat: dict = {}
    by_status: dict = {k: 0 for k in STOK_STATUS_ORDER}

    for p in all_parts:
        stok = stok_map.get(p.id_part, 0)
        nilai = nilai_map.get(p.id_part, 0)
        total_value += max(nilai, 0)

        kat = p.kategori_ref
        sub = (kat.subsistem if kat else None) or "LAINNYA"
        by_subsistem[sub] = by_subsistem.get(sub, 0) + 1

        alat_key = (
            p.kategori_alat_ref.nama_alat if p.kategori_alat_ref else p.kode_alat
        ) or "LAINNYA"
        by_alat[alat_key] = by_alat.get(alat_key, 0) + 1

        status = _stok_status(stok, p.stok_min or 0, None)
        by_status[status] = by_status.get(status, 0) + 1

        if status in ("MINUS", "KOSONG", "KRITIS", "DI BAWAH MIN"):
            critical_list.append({
                "id_part": p.id_part,
                "nama_part": p.nama_part,
                "stok_sekarang": stok,
                "stok_min": p.stok_min,
                "unit": p.unit,
                "status_stok": status,
                "kode_alat": p.kode_alat,
                "nama_alat": p.kategori_alat_ref.nama_alat if p.kategori_alat_ref else None,
            })

        if nilai > 0:
            top_value_list.append({
                "id_part": p.id_part,
                "nama_part": p.nama_part,
                "stok_sekarang": stok,
                "unit": p.unit,
                "nilai": nilai,
                "nama_alat": p.kategori_alat_ref.nama_alat if p.kategori_alat_ref else p.kode_alat,
            })

    top_value_list.sort(key=lambda x: -x["nilai"])

    # ── Windowed movement stats ──
    win_start = datetime.combine(dari, datetime.min.time())
    win_end = datetime.combine(sampai, datetime.max.time())

    gerak_q = _scope_stok(
        db.query(
            models.SparePartStok.tipe_gerakan,
            func.coalesce(func.sum(models.SparePartStok.jumlah), 0),
            func.coalesce(
                func.sum(
                    models.SparePartStok.jumlah
                    * func.coalesce(models.SparePartStok.harga_satuan, 0)
                ),
                0,
            ),
        )
        .filter(models.SparePartStok.waktu >= win_start)
        .filter(models.SparePartStok.waktu <= win_end)
        .group_by(models.SparePartStok.tipe_gerakan),
        scope_lokasi,
        id_gudang,
    )
    gerak_rows = gerak_q.all() if gerak_q is not None else []
    qty_by_tipe = {r[0]: int(r[1] or 0) for r in gerak_rows}
    val_by_tipe = {r[0]: int(r[2] or 0) for r in gerak_rows}

    transaksi_periode = [
        {"tipe": tipe, "label": label, "jumlah": qty_by_tipe.get(tipe, 0)}
        for tipe, label in GERAKAN_LABEL
    ]
    nilai_masuk = sum(
        val_by_tipe.get(t, 0) for t in models.SparePartStok.GERAKAN_MASUK
    )
    nilai_keluar = sum(
        val_by_tipe.get(t, 0) for t in models.SparePartStok.GERAKAN_KELUAR
    )

    # ── Monthly usage trend (last 12 months, issues only) ──
    twelve_ago = datetime.now() - timedelta(days=365)
    monthly_q = _scope_stok(
        db.query(
            # to_char, not strftime — strftime is SQLite-only and raises on PostgreSQL.
            func.to_char(models.SparePartStok.waktu, "YYYY-MM").label("bulan"),
            func.sum(models.SparePartStok.jumlah).label("jumlah"),
        ).filter(
            models.SparePartStok.tipe_gerakan.in_(models.SparePartStok.GERAKAN_KELUAR),
            models.SparePartStok.waktu >= twelve_ago,
        ),
        scope_lokasi,
        id_gudang,
    )
    monthly_data = (
        monthly_q.group_by("bulan").order_by("bulan").all() if monthly_q is not None else []
    )

    # ── Fast Moving / Slow Moving ─────────────────────────────────────
    #
    # The client's poster asks for it under Inventory Monitoring. It is a
    # CONSUMPTION RATE, so it needs a window: an all-time total would rank a
    # part bought in bulk three years ago above one issued weekly.
    #
    # The window is fixed at 12 months rather than following the Dari/Sampai
    # filter above, because that filter drives the TRANSACTION figures and is
    # routinely set to a single month — a classification computed over 30 days
    # would reshuffle every time someone changed the date box, which is not what
    # "slow moving" means. `pergerakan.sejak` is returned so the panel can state
    # the period; a classification whose period is invisible is not
    # interpretable.
    FAST_SLOW_BULAN = 12
    sejak_fs = datetime.now() - timedelta(days=FAST_SLOW_BULAN * 30)
    keluar_window = _movement_breakdown(db, id_lokasi, id_gudang, sejak=sejak_fs)

    konsumsi = []
    for p in all_parts:
        g = keluar_window.get(p.id_part, {})
        # Outbound only, and returns to a vendor are NOT consumption — they are
        # stock leaving because it was wrong, not because it was used.
        qty = int(g.get("OUT", 0) or 0)
        konsumsi.append((p, qty))

    bergerak = sorted(
        [(p, q) for p, q in konsumsi if q > 0], key=lambda x: x[1], reverse=True
    )
    diam = [p for p, q in konsumsi if q == 0]

    # Terciles over the parts that MOVED. Ranking the whole catalogue would put
    # everything that never moved into "slow" and make the boundary meaningless.
    n = len(bergerak)
    cut = max(1, n // 3) if n else 0

    def _fs_row(p, q):
        return {
            "id_part": p.id_part,
            "nama_part": p.nama_part,
            "unit": p.unit,
            "kode_alat": p.kode_alat,
            "nama_alat": p.kategori_alat_ref.nama_alat if p.kategori_alat_ref else None,
            "stok_sekarang": int(stok_map.get(p.id_part, 0)),
            "keluar": q,
        }

    pergerakan = {
        "bulan": FAST_SLOW_BULAN,
        "sejak": sejak_fs.strftime("%Y-%m-%d"),
        "fast_count": len(bergerak[:cut]),
        "slow_count": len(bergerak[cut:]),
        # Named for what it IS. "Dead stock" is a judgement — a spare for a
        # rarely-failing machine that has not been needed in a year is doing
        # exactly its job, and calling it dead invites someone to write it off.
        "diam_count": len(diam),
        "fast": [_fs_row(p, q) for p, q in bergerak[:cut]][:15],
        "slow": [_fs_row(p, q) for p, q in bergerak[cut:]][-15:],
        "diam": [_fs_row(p, 0) for p in diam][:15],
    }

    return {
        "periode": {"dari": str(dari), "sampai": str(sampai)},

        # Headline value KPIs
        "total_value": total_value,
        "nilai_masuk": nilai_masuk,
        "nilai_keluar": nilai_keluar,

        # Status counters (the six coloured boxes on the printed report)
        "status_counts": {k: by_status.get(k, 0) for k in STOK_STATUS_ORDER},

        "total_parts": total_parts,
        "total_types": total_types,
        "auto_demand": auto_demand_count,
        # No "total_suppliers": `sparepart.supplier` was dropped with the form's
        # "Informasi Tambahan" block, so the count had nothing to count. The
        # "Pemasok" tile that read it is gone from index.html too.
        "critical_count": len(critical_list),
        "critical_list": critical_list[:50],
        "pergerakan": pergerakan,
        "top_value": top_value_list[:15],
        "by_subsistem": by_subsistem,
        "by_alat": by_alat,
        "transaksi_periode": transaksi_periode,
        "monthly_usage": [
            {"bulan": r.bulan, "jumlah": int(r.jumlah or 0)} for r in monthly_data
        ],
    }




# ── One-time Seed Trigger (SUPER_ADMIN only) ───────────────────────

@router.post("/api/inventaris/seed",
          dependencies=[Depends(require_role(["SUPER_ADMIN"]))])
def trigger_seed(db: Session = Depends(get_db)):
    """Triggers the sparepart catalog seed. Safe to call multiple times."""
    try:
        # `seeds.inventaris`, not `seed` — the writer moved into the seeds/
        # package and this import kept naming the old module, so the endpoint
        # returned 500 unconditionally. seed.py is now only a CLI.
        from seeds.inventaris import seed_spareparts
        seed_spareparts()
        return {"message": "Seed sparepart selesai."}
    except ImportError as e:
        # seeds/ is gitignored and absent from a fresh checkout; say so rather
        # than reporting it as a seeding failure.
        raise HTTPException(
            status_code=503,
            detail=f"Paket seeds/ tidak tersedia di server ini: {e}",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

