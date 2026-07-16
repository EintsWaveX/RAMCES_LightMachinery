from pydantic import BaseModel
from typing import Optional
from datetime import date, datetime


# ── AUTH & USER ───────────────────────────────────────────────────

class LoginForm(BaseModel):
    username:        str
    role:            str = "TEKNISI"
    assigned_region: Optional[str] = None

class UserCreate(BaseModel):
    username:        str
    password:        Optional[str] = None
    role:            str = "TEKNISI"
    assigned_region: Optional[str] = None

class UserResponse(BaseModel):
    id:              int
    username:        str
    role:            str
    assigned_region: Optional[str] = None
    class Config:
        from_attributes = True

class Token(BaseModel):
    access_token: str
    token_type:   str


# ── MASTER DATA ───────────────────────────────────────────────────

class MasterAlatCreate(BaseModel):
    kode:      str
    nama:      str
    deskripsi: Optional[str] = None

class MasterAlatResponse(BaseModel):
    kode:      str
    nama:      str
    deskripsi: Optional[str] = None
    aktif:     bool
    class Config:
        from_attributes = True


class LokasiCreate(BaseModel):
    kode_lokasi: str
    nama_lokasi: str
    tipe_lokasi: str  # 'PUSAT', 'DAOP', 'DIVRE', 'BALAIYASA'

class LokasiResponse(BaseModel):
    kode_lokasi: str
    nama_lokasi: str
    tipe_lokasi: str
    aktif:       bool
    class Config:
        from_attributes = True


class MasterUPTCreate(BaseModel):
    nama_upt:    str
    kode_lokasi: str

class MasterUPTResponse(BaseModel):
    id:          int
    nama_upt:    str
    kode_lokasi: str
    aktif:       bool
    class Config:
        from_attributes = True


# ── ASET ──────────────────────────────────────────────────────────

class AsetCreate(BaseModel):
    kode_id:         str
    kode_alat:       str
    kode_lokasi:     str
    pengadaan:       str
    tahun_pembelian: int
    unit_peruntukan: str
    # creator injected server-side from JWT

class AsetResponse(BaseModel):
    uid:             str
    kode_id:         str
    kode_alat:       str
    kode_lokasi:     str
    pengadaan:       str
    tahun_pembelian: int
    unit_peruntukan: str
    status_kondisi:  str
    status:          Optional[str] = None   # alias of status_kondisi → item.status
    is_afkir:        bool
    creator:         Optional[str] = None
    created_at:      datetime
    alat:            Optional[str] = None   # resolved from MasterAlat.nama
    lokasi:          Optional[str] = None   # resolved from Lokasi.nama_lokasi
    class Config:
        from_attributes = True


# ── RIWAYAT PERBAIKAN ─────────────────────────────────────────────

class PerbaikanCreate(BaseModel):
    aset_uid:          str
    tanggal_perbaikan: date
    lokasi_perbaikan:  Optional[str] = None
    upt_perbaikan:     Optional[str] = None
    teknisi:           str
    status_baru:       str
    keterangan:        Optional[str] = "-"

class RiwayatPerbaikanResponse(BaseModel):
    no:         int
    date:       str
    lokasi:     Optional[str] = None
    upt:        Optional[str] = None
    teknisi:    str
    kondisi:    str
    keterangan: Optional[str] = "-"
    class Config:
        from_attributes = True


# ── RIWAYAT MUTASI ────────────────────────────────────────────────

class MutasiCreate(BaseModel):
    aset_uid:         str
    kode_lokasi_tuju: str
    alasan:           Optional[str] = None
    # kode_lokasi_asal and dilakukan_oleh injected server-side

class MutasiResponse(BaseModel):
    id:               int
    aset_uid:         str
    kode_lokasi_asal: str
    kode_lokasi_tuju: str
    dilakukan_oleh:   str
    alasan:           Optional[str] = None
    created_at:       datetime
    # resolved display names
    lokasi_asal_nama: Optional[str] = None
    lokasi_tuju_nama: Optional[str] = None
    class Config:
        from_attributes = True