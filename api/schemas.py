"""
Every Pydantic request model in the application.

One module rather than one per router, for three reasons:

- `PemakaianItem` is nested inside `PerbaikanCreate` — a repair reports its
  condition and consumes its spare parts in ONE request body — while belonging
  conceptually to inventaris. Per-router placement would force a riwayat →
  inventaris import purely for a data class.
- FastAPI derives OpenAPI component names from `__name__`. Keeping them in one
  module makes collisions impossible and keeps `components.schemas` stable,
  which is the gate this refactor is verified against.
- They are pure data: `pydantic`, `typing` and `datetime` are the only imports,
  so this module creates no edges at all.

Note two shapes that carry real behaviour and are documented at their class:
`LoginForm.role`/`id_lokasi` are IGNORED by `login()`, and `AsetUpdate` leaves
`id_varian`/`nomor_seri` optional so `update_aset()` can tell "absent" from
"explicitly null" via `model_fields_set`.
"""

from datetime import date
from typing import List, Optional

from pydantic import BaseModel


class Token(BaseModel):
    access_token: str
    token_type: str


class LoginForm(BaseModel):
    username: str
    password: str
    # Kept only so an older client's payload still parses. `login()` IGNORES
    # both and reads role/region from the stored row — a client that picks its
    # own role is not authenticated, it is self-declared.
    role: Optional[str] = None
    id_lokasi: Optional[str] = None
    # OPTIONAL, and enforced in the handler instead.
    #
    # Login asks for a captcha PROGRESSIVELY — only once a rate-limit bucket has
    # tripped — so most sign-ins never send one. Making these required on the
    # model would 422 every ordinary login from any client that does not send
    # them, which is exactly how landing.html's sign-in was broken: it posted a
    # payload missing a field the model insisted on, and every QR-page sign-in
    # failed with a validation error rather than a message anyone could act on.
    captcha_token: Optional[str] = None
    captcha_answer: Optional[str] = None


class RegisterForm(BaseModel):
    """
    Self-registration. Note what is NOT here: `role` and `id_lokasi`.

    A registrant never picks either. Letting the client choose its own role was
    the privilege escalation removed in rev0.5.0 — an unauthenticated form that
    accepted `role` would be the same hole with a friendlier label. The account
    is created PENDING with an inert role and no region, and an admin assigns
    both at approval.
    """

    username: str
    password: str
    nama_lengkap: Optional[str] = None
    captcha_token: str
    captcha_answer: str


class UserApprove(BaseModel):
    """
    What an admin assigns AT the moment of approval.

    Approval is its own endpoint rather than a `status` field on `UserUpdate`,
    because this is the moment privilege is granted — it deserves a route that
    can be found, guarded and audited on its own, not a value smuggled through
    the general-purpose edit form.
    """

    role: str
    id_lokasi: Optional[str] = None


class UserCreate(BaseModel):
    username: str
    password: str
    role: str
    id_lokasi: Optional[str] = None
    nama_lengkap: Optional[str] = None


class UserUpdate(BaseModel):
    role: str
    id_lokasi: Optional[str] = None
    # AKTIF | NONAKTIF only. Approval and rejection have their own endpoints and
    # are not reachable from here; see UserApprove.
    status: Optional[str] = None


class PasswordSet(BaseModel):
    """Used by both password paths: a user changing their own, and a SUPER_ADMIN
    resetting someone else's. `password_lama` is required only for the former."""

    password_baru: str
    password_lama: Optional[str] = None


class MasterAlatCreate(BaseModel):
    kode_alat: str
    nama_alat: str
    # Katalog SFM flags. `perlu_kalibrasi` gates the Kalibrasi form for every
    # asset of this type, so it is data, not decoration.
    alat_ukur: bool = False
    perlu_kalibrasi: bool = False
    kelompok: Optional[str] = None


class LokasiCreate(BaseModel):
    id_lokasi: str
    nama_lokasi: str
    tipe: str


class AsetCreate(BaseModel):
    # id_aset: str
    kode_alat: str
    id_lokasi: str
    tanggal_pembelian: date
    sumber_pengadaan: str
    parent_lokasi: str
    peruntukan: str
    # Spesifikasi teknis: the shared variant, plus this unit's own serial.
    id_varian: Optional[int] = None
    nomor_seri: Optional[str] = None


class AsetUpdate(BaseModel):
    kode_alat: str
    id_lokasi: str
    tanggal_pembelian: date
    sumber_pengadaan: str
    parent_lokasi: str
    peruntukan: str
    id_varian: Optional[int] = None
    nomor_seri: Optional[str] = None


class PemakaianItem(BaseModel):
    """One sparepart consumed by the repair being reported."""

    id_part: int
    jumlah: int
    id_gudang: Optional[int] = None
    keterangan: Optional[str] = None


class PerbaikanCreate(BaseModel):
    id_aset: str
    kondisi: str
    keterangan: Optional[str] = "-"
    peruntukan: Optional[str] = None
    id_lokasi: Optional[str] = None
    # Parts consumed. Rides on the SAME request as the condition report so both
    # land in one transaction — see catat_perbaikan().
    pemakaian: Optional[List[PemakaianItem]] = None


class MutasiCreate(BaseModel):
    id_aset: str
    id_lokasi_tujuan: str
    alasan_mutasi: Optional[str] = None


class KalibrasiCreate(BaseModel):
    id_aset: str
    tanggal_kalibrasi: date
    tanggal_berlaku: Optional[date] = None
    status: str = "LULUS"
    pelaksana_kalibrasi: Optional[str] = None
    nomor_sertifikat: Optional[str] = None
    keterangan: Optional[str] = None


class SparePartKategoriCreate(BaseModel):
    nama: str
    subsistem: Optional[str] = None
    kode_alat: Optional[str] = None


class SparePartCreate(BaseModel):
    # A part is WHAT IT IS plus WHAT IT FITS. There is no sku/part_number and no
    # identification or supplier block any more — see models.SparePart for the
    # ten columns that were dropped and why.
    nama_part: str
    id_kategori: Optional[int] = None
    kode_alat: Optional[str] = None
    unit: str = "Pcs"
    harga_satuan: Optional[int] = None
    stok_min: int = 0
    auto_demand: bool = False
    # Initial stock. `id_gudang_awal` is the field that matters: every other
    # inventory screen scopes by warehouse, so an opening balance written
    # against a region instead was invisible everywhere and could never be
    # issued (an OUT validates against the warehouse pool and saw 0).
    # `id_lokasi_awal` is retained for older callers and is recorded alongside.
    jumlah_awal: int = 0
    id_gudang_awal: Optional[int] = None
    id_lokasi_awal: Optional[str] = None


class SparePartUpdate(BaseModel):
    nama_part: Optional[str] = None
    id_kategori: Optional[int] = None
    kode_alat: Optional[str] = None
    unit: Optional[str] = None
    harga_satuan: Optional[int] = None
    stok_min: Optional[int] = None
    auto_demand: Optional[bool] = None


class StokTransferCreate(BaseModel):
    id_part: int
    jumlah: int
    # Warehouse-to-warehouse is the real movement: stock physically lives in a
    # gudang, and that is what every balance query scopes by. The id_lokasi_*
    # pair is the older region-tree form, kept so existing transfer history and
    # any caller still sending it keep working.
    id_gudang_asal: Optional[int] = None
    id_gudang_tujuan: Optional[int] = None
    id_lokasi_asal: Optional[str] = None     # None = global pool
    id_lokasi_tujuan: Optional[str] = None   # None = global pool
    transfer_by: Optional[str] = None
    transfer_to: Optional[str] = None
    catatan: Optional[str] = None


class StokAdjustCreate(BaseModel):
    id_part: int
    tipe_gerakan: str   # IN | OUT | RETUR_VENDOR | RETUR_CUST | ADJ_IN | ADJ_OUT
    jumlah: int
    id_gudang: Optional[int] = None
    id_lokasi: Optional[str] = None
    harga_satuan: Optional[int] = None   # overrides the part's list price
    tanggal: Optional[date] = None       # back-dated entry; defaults to now
    keterangan: Optional[str] = None


class GudangCreate(BaseModel):
    kode: str
    nama: str
    keterangan: Optional[str] = None
    is_active: bool = True


class GudangUpdate(BaseModel):
    kode: Optional[str] = None
    nama: Optional[str] = None
    keterangan: Optional[str] = None
    is_active: Optional[bool] = None


# ── Model/Type (alat_varian) ───────────────────────────────────────
# Shaped by `Rekap Spek RAMCES.docx`: Merk, Model/Type, five free-form spec
# pairs, a photo and two reference documents. `kapasitas`/`daya`/`dimensi`/
# `berat` are deliberately ABSENT — they are superseded by the pairs and only
# still exist in the table for the one-off backfill in `_ensure_schema()`.
class _AlatVarianSpecBase(BaseModel):
    keterangan: Optional[str] = None
    merk: Optional[str] = None
    tipe_model: Optional[str] = None
    spek1_label: Optional[str] = None
    spek1_nilai: Optional[str] = None
    spek2_label: Optional[str] = None
    spek2_nilai: Optional[str] = None
    spek3_label: Optional[str] = None
    spek3_nilai: Optional[str] = None
    spek4_label: Optional[str] = None
    spek4_nilai: Optional[str] = None
    spek5_label: Optional[str] = None
    spek5_nilai: Optional[str] = None
    # Files are attached through the dedicated upload routes; these are the
    # "or paste a link" halves, which is how the Rekap's manufacturer CDN and
    # Google Drive references get in.
    foto_url: Optional[str] = None
    url_spek: Optional[str] = None
    url_manual: Optional[str] = None


class AlatVarianCreate(_AlatVarianSpecBase):
    kode_alat: str
    nama_varian: str


class AlatVarianUpdate(_AlatVarianSpecBase):
    nama_varian: Optional[str] = None

