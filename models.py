from sqlalchemy import (
    Column,
    String,
    Integer,
    Date,
    DateTime,
    ForeignKey,
    Boolean,
    text,
    Text,
    CheckConstraint,
    UniqueConstraint,
)
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from database import Base


class KategoriAlat(Base):
    __tablename__ = "kategori_alat"
    kode_alat = Column(String(10), primary_key=True, index=True)
    nama_alat = Column(String(100), nullable=False)

    asets = relationship("Aset", back_populates="kategori")


class Lokasi(Base):
    __tablename__ = "lokasi"
    id_lokasi = Column(String(10), primary_key=True, index=True)
    nama_lokasi = Column(String(100), nullable=False)
    tipe = Column(String(20), nullable=False)  # PUSAT, DAOP, DIVRE

    asets = relationship("Aset", back_populates="lokasi_ref")


class Pengguna(Base):
    __tablename__ = "pengguna"
    id_pengguna = Column(Integer, primary_key=True, index=True, autoincrement=True)
    username = Column(String(50), unique=True, nullable=False)
    hashed_password = Column(String(255), nullable=True)  # Wajib untuk autentikasi
    role = Column(String(20), nullable=False)  # SUPER_ADMIN, ADMIN_WILAYAH, TEKNISI
    id_lokasi = Column(String(10), ForeignKey("lokasi.id_lokasi"), nullable=True)
    # Presence — stamped on login and on every authenticated request. "Online" is
    # derived from an active WebSocket, not from this column; last_seen is what
    # remains once the socket closes.
    last_seen = Column(DateTime, nullable=True)
    last_view = Column(String(50), nullable=True)  # which screen they are on

    lokasi_ref = relationship("Lokasi")


class AlatVarian(Base):
    """
    Technical spec / variant of a work tool ("spesifikasi teknis").

    One alat kerja has several field variants that are NOT interchangeable for
    sparepart purposes — a GENSET 3 PHASE HTT is either GX270 or GX390 and each
    takes a different carburettor, and a brush cutter is 2T TASCO vs 4T PROQUIP
    vs 4T HONDA. The repair log records this per job, so it belongs on the asset.
    """

    __tablename__ = "alat_varian"

    id_varian = Column(Integer, primary_key=True, index=True, autoincrement=True)
    kode_alat = Column(
        String(10), ForeignKey("kategori_alat.kode_alat"), nullable=False, index=True
    )
    nama_varian = Column(String(100), nullable=False)  # GX270, 2T TASCO, GEISMAR…
    keterangan = Column(Text, nullable=True)

    kategori_alat_ref = relationship("KategoriAlat")

    __table_args__ = (
        UniqueConstraint("kode_alat", "nama_varian", name="uq_alat_varian"),
    )


class Gudang(Base):
    """
    Physical parts warehouse.

    Deliberately FLAT and independent of the `lokasi` DAOP/UPT hierarchy: stock
    is held in a handful of named stores ("Gudang A", "Gudang B") that do not
    map onto the operational region tree.
    """

    __tablename__ = "gudang"

    id_gudang = Column(Integer, primary_key=True, index=True, autoincrement=True)
    kode = Column(String(20), unique=True, nullable=False, index=True)
    nama = Column(String(100), nullable=False)
    keterangan = Column(Text, nullable=True)
    is_active = Column(Boolean, nullable=False, server_default=text("true"))


class Aset(Base):
    __tablename__ = "aset"
    id_aset = Column(String(50), primary_key=True, index=True)
    kode_alat = Column(
        String(10), ForeignKey("kategori_alat.kode_alat"), nullable=False
    )
    id_lokasi = Column(String(10), ForeignKey("lokasi.id_lokasi"))
    tanggal_pembelian = Column(Date, nullable=False)
    sumber_pengadaan = Column(String(50), nullable=False)
    status_terakhir = Column(String(20), server_default="SO", index=True)
    # HAPUS BARIS is_afkir DISINI
    waktu_update = Column(
        DateTime,
        server_default=text("CURRENT_TIMESTAMP"),
        onupdate=text("CURRENT_TIMESTAMP"),
    )
    peruntukan = Column(String(20), nullable=False)
    # Technical spec / variant (GX270 vs GX390, 2T TASCO vs 4T PROQUIP, …).
    # Nullable: legacy assets predate the field and not every tool has variants.
    id_varian = Column(
        Integer, ForeignKey("alat_varian.id_varian"), nullable=True, index=True
    )

    kategori = relationship("KategoriAlat", back_populates="asets")
    lokasi_ref = relationship("Lokasi", back_populates="asets")
    varian_ref = relationship("AlatVarian")
    riwayat_kondisi = relationship("RiwayatKondisi", back_populates="aset_ref")
    riwayat_mutasi = relationship("RiwayatMutasi", back_populates="aset_ref")


class RiwayatKondisi(Base):
    __tablename__ = "riwayat_kondisi"
    id_riwayat = Column(Integer, primary_key=True, index=True, autoincrement=True)
    id_aset = Column(String(50), ForeignKey("aset.id_aset"))
    id_pengguna = Column(Integer, ForeignKey("pengguna.id_pengguna"))
    kondisi = Column(String(20), nullable=False)
    keterangan = Column(Text)
    waktu_lapor = Column(DateTime, server_default=text("CURRENT_TIMESTAMP"), index=True)
    id_lokasi = Column(
        String(10), ForeignKey("lokasi.id_lokasi"), nullable=True, index=True
    )
    peruntukan = Column(String(20), nullable=True)

    aset_ref = relationship("Aset", back_populates="riwayat_kondisi")
    pengguna_ref = relationship("Pengguna")
    lokasi_ref = relationship("Lokasi")


class RiwayatMutasi(Base):
    __tablename__ = "riwayat_mutasi"
    id_mutasi = Column(Integer, primary_key=True, index=True, autoincrement=True)
    id_aset = Column(String(50), ForeignKey("aset.id_aset"))
    id_lokasi_asal = Column(String(10), ForeignKey("lokasi.id_lokasi"))
    id_lokasi_tujuan = Column(String(10), ForeignKey("lokasi.id_lokasi"))
    id_pengguna = Column(Integer, ForeignKey("pengguna.id_pengguna"))
    alasan_mutasi = Column(Text)
    waktu_mutasi = Column(DateTime, server_default=text("CURRENT_TIMESTAMP"))

    aset_ref = relationship("Aset", back_populates="riwayat_mutasi")
    lokasi_asal = relationship("Lokasi", foreign_keys=[id_lokasi_asal])
    lokasi_tujuan = relationship("Lokasi", foreign_keys=[id_lokasi_tujuan])
    pengguna_ref = relationship("Pengguna")


class RiwayatKalibrasi(Base):
    __tablename__ = "riwayat_kalibrasi"

    id_kalibrasi = Column(Integer, primary_key=True, index=True)
    id_aset = Column(
        String(50),
        ForeignKey("aset.id_aset", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    id_pengguna = Column(Integer, ForeignKey("pengguna.id_pengguna"), nullable=False)
    tanggal_kalibrasi = Column(Date, nullable=False)
    tanggal_berlaku = Column(Date, nullable=False)
    status = Column(String(20), nullable=False, index=True)  # LULUS, GAGAL, BERSYARAT
    pelaksana_kalibrasi = Column(String(100))
    nomor_sertifikat = Column(String(100))
    keterangan = Column(Text)
    # Stored filename of the uploaded certificate, relative to UPLOAD_DIR.
    # Never a client-supplied path — see save_upload() in main.py.
    file_sertifikat = Column(String(255), nullable=True)
    waktu_input = Column(DateTime, default=func.now())

    __table_args__ = (
        CheckConstraint(
            status.in_(["LULUS", "GAGAL", "BERSYARAT"]),
            name="riwayat_kalibrasi_status_check",
        ),
    )


# ══════════════════════════════════════════════════════════════════════
# INVENTARIS — Sparepart Management
# ══════════════════════════════════════════════════════════════════════

class SparePartKategori(Base):
    """Part categories / subsystems (ELECTRIC, ENGINE, MECHANIC, CONSUMABLES, etc.)"""
    __tablename__ = "sparepart_kategori"

    id_kategori = Column(Integer, primary_key=True, index=True, autoincrement=True)
    nama         = Column(String(100), nullable=False, unique=True)
    subsistem    = Column(String(50),  nullable=True)   # e.g. ELECTRIC, ENGINE
    kode_alat    = Column(String(10),  ForeignKey("kategori_alat.kode_alat"), nullable=True)

    kategori_alat_ref = relationship("KategoriAlat")
    parts = relationship("SparePart", back_populates="kategori_ref")


class SparePart(Base):
    """Master sparepart catalog."""
    __tablename__ = "sparepart"

    id_part      = Column(Integer, primary_key=True, index=True, autoincrement=True)
    sku          = Column(String(50),  unique=True, nullable=False, index=True)
    nama_part    = Column(String(150), nullable=False)
    id_kategori  = Column(Integer, ForeignKey("sparepart_kategori.id_kategori"), nullable=True)
    kode_alat    = Column(String(10),  ForeignKey("kategori_alat.kode_alat"),    nullable=True)
    unit         = Column(String(20),  nullable=False, server_default="Piece")
    harga_satuan = Column(Integer,     nullable=True)   # stored in IDR (integer rupiah)
    stok_min     = Column(Integer,     nullable=False, server_default="0")
    auto_demand  = Column(Boolean, nullable=False, server_default=text("false"))
    supplier     = Column(String(100), nullable=True)
    deskripsi    = Column(Text,        nullable=True)
    part_number  = Column(String(100), nullable=True)
    is_critical  = Column(Boolean, nullable=False, server_default=text("false"))
    serial_numbers = Column(Text,      nullable=True)   # comma-separated list
    lookup_tags    = Column(Text,      nullable=True)   # comma-separated list
    linked_vehicle = Column(String(100), nullable=True)
    warranty_months = Column(Integer,  nullable=True)
    ref_part       = Column(String(100), nullable=True)

    kategori_ref   = relationship("SparePartKategori", back_populates="parts")
    kategori_alat_ref = relationship("KategoriAlat")
    stok_entries   = relationship("SparePartStok", back_populates="part_ref",
                                  foreign_keys="SparePartStok.id_part")


class SparePartStok(Base):
    """
    Stock ledger — one row per movement.

    `tipe_gerakan` vocabulary (matches the printed Items Master report):
      IN           — goods received
      OUT          — goods issued / consumed
      RETUR_VENDOR — returned to supplier   (reduces stock)
      RETUR_CUST   — returned from the field (increases stock)
      ADJ_IN       — stock-take adjustment up
      ADJ_OUT      — stock-take adjustment down

    Location model: `id_gudang` is the warehouse the stock physically sits in and
    is what the movement-entry form writes. `id_lokasi`/`site_from`/`site_to`
    are the older region-tree fields kept for the existing transfer history.
    """
    __tablename__ = "sparepart_stok"

    id_stok          = Column(Integer, primary_key=True, index=True, autoincrement=True)
    id_part          = Column(Integer, ForeignKey("sparepart.id_part"), nullable=False, index=True)
    id_gudang        = Column(Integer, ForeignKey("gudang.id_gudang"), nullable=True, index=True)
    id_lokasi        = Column(String(10), ForeignKey("lokasi.id_lokasi"), nullable=True, index=True)
    tipe_gerakan     = Column(String(20), nullable=False)
    jumlah           = Column(Integer,    nullable=False)
    harga_satuan     = Column(Integer,    nullable=True)    # snapshot at time of entry
    keterangan       = Column(Text,       nullable=True)
    id_pengguna      = Column(Integer,    ForeignKey("pengguna.id_pengguna"), nullable=True)
    waktu            = Column(DateTime,   server_default=text("CURRENT_TIMESTAMP"), index=True)
    id_ref_transfer  = Column(Integer,    ForeignKey("sparepart_stok.id_stok"), nullable=True)
    site_from        = Column(String(10), ForeignKey("lokasi.id_lokasi"), nullable=True)
    site_to          = Column(String(10), ForeignKey("lokasi.id_lokasi"), nullable=True)
    transfer_by      = Column(String(100), nullable=True)
    transfer_to      = Column(String(100), nullable=True)
    catatan          = Column(Text,        nullable=True)

    part_ref    = relationship("SparePart", back_populates="stok_entries",
                               foreign_keys=[id_part])
    gudang_ref  = relationship("Gudang", foreign_keys=[id_gudang])
    lokasi_ref  = relationship("Lokasi", foreign_keys=[id_lokasi])
    site_from_ref = relationship("Lokasi", foreign_keys=[site_from])
    site_to_ref   = relationship("Lokasi", foreign_keys=[site_to])
    pengguna_ref  = relationship("Pengguna", foreign_keys=[id_pengguna])
    pair_ref      = relationship("SparePartStok", remote_side=[id_stok],
                                 foreign_keys=[id_ref_transfer])

    # Movements that ADD stock vs REMOVE it — the single source of truth for
    # every net-stock and stock-value calculation.
    GERAKAN_MASUK = ("IN", "RETUR_CUST", "ADJ_IN")
    GERAKAN_KELUAR = ("OUT", "RETUR_VENDOR", "ADJ_OUT")

    __table_args__ = (
        CheckConstraint(
            tipe_gerakan.in_(
                ["IN", "OUT", "RETUR_VENDOR", "RETUR_CUST", "ADJ_IN", "ADJ_OUT"]
            ),
            name="sparepart_stok_gerakan_check",
        ),
    )
