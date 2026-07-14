from pydantic import BaseModel
from typing import Optional
from datetime import date, datetime

# --- AUTH & USER ---

class UserCreate(BaseModel):
    username: str
    password: str
    role: str = "TEKNISI"
    assigned_region: Optional[str] = None  # e.g. 'D1', 'D2' — required for non-SUPER_ADMIN

class UserResponse(BaseModel):
    id: int
    username: str
    role: str
    assigned_region: Optional[str] = None

    class Config:
        from_attributes = True

class Token(BaseModel):
    access_token: str
    token_type: str

# --- ASET ---

class AsetCreate(BaseModel):
    kode_id: str
    kode_alat: str
    kode_lokasi: str
    pengadaan: str
    tahun_pembelian: int
    unit_peruntukan: str
    # creator is injected server-side from the JWT token, not sent by the client

class AsetResponse(BaseModel):
    uid: str
    kode_id: str
    kode_alat: str
    kode_lokasi: str
    pengadaan: str
    tahun_pembelian: int
    unit_peruntukan: str
    status_kondisi: str          # mapped to `item.status` on the frontend
    is_afkir: bool
    creator: Optional[str] = None
    created_at: datetime

    # Resolved display names from joined tables (populated manually in the endpoint)
    alat: Optional[str] = None   # from MasterKatalog.nama_alat  → item.alat
    lokasi: Optional[str] = None # from Lokasi.nama_lokasi        → item.lokasi
    status: Optional[str] = None # alias of status_kondisi        → item.status

    class Config:
        from_attributes = True

# --- RIWAYAT PERBAIKAN ---

class PerbaikanCreate(BaseModel):
    aset_uid: str
    tanggal_perbaikan: date
    lokasi_perbaikan: Optional[str] = None
    upt_perbaikan: Optional[str] = None
    teknisi: str
    status_baru: str
    keterangan: Optional[str] = "-"

class RiwayatPerbaikanResponse(BaseModel):
    no: int                      # row number (enumerated in the endpoint)
    date: str                    # tanggal_perbaikan formatted as string → h.date
    lokasi: Optional[str] = None    # DAOP/DIVRE level  → displayed as location context
    upt: Optional[str] = None       # UPT level         → h.upt in the frontend table
    teknisi: str                 #                                       → h.teknisi
    kondisi: str                 # status_baru                           → h.kondisi
    keterangan: Optional[str] = "-"  #                                   → h.keterangan

    class Config:
        from_attributes = True