from sqlalchemy import Column, Integer, String, Text, Boolean, Date, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from datetime import datetime
from database import Base


class User(Base):
    __tablename__ = "users"

    id              = Column(Integer, primary_key=True, index=True)
    username        = Column(String(50), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=True)
    role            = Column(String(20))  # 'SUPER_ADMIN', 'ADMIN_DAOP', 'TEKNISI'
    assigned_region = Column(String(10), nullable=True)  # FK-like to lokasi.kode_lokasi


class Lokasi(Base):
    __tablename__ = "lokasi"

    kode_lokasi = Column(String(10), primary_key=True, index=True)
    nama_lokasi = Column(String(100), nullable=False)
    tipe_lokasi = Column(String(50), nullable=False)  # 'PUSAT', 'DAOP', 'DIVRE', 'BALAIYASA'
    aktif       = Column(Boolean, default=True)

    asets = relationship("Aset", back_populates="lokasi_ref")
    upts  = relationship("MasterUPT", back_populates="lokasi_ref")


class MasterAlat(Base):
    __tablename__ = "master_alat"

    kode      = Column(String(10),  primary_key=True, index=True)
    nama      = Column(String(100), nullable=False)
    deskripsi = Column(Text, nullable=True)
    aktif     = Column(Boolean, default=True)

    asets = relationship("Aset", back_populates="alat_ref")


class MasterUPT(Base):
    __tablename__ = "master_upt"

    id          = Column(Integer, primary_key=True, index=True, autoincrement=True)
    nama_upt    = Column(String(100), nullable=False)
    kode_lokasi = Column(String(10), ForeignKey("lokasi.kode_lokasi"), nullable=False)
    aktif       = Column(Boolean, default=True)

    lokasi_ref = relationship("Lokasi", back_populates="upts")


class Aset(Base):
    __tablename__ = "aset"

    # uid: internal surrogate key (e.g. WH-ABC12345)
    # kode_id: human-readable asset code (e.g. BOR-1-26-A-D2), unique
    uid             = Column(String(50), primary_key=True, index=True)
    kode_id         = Column(String(50), unique=True, nullable=False, index=True)

    kode_alat       = Column(String(10), ForeignKey("master_alat.kode"))
    kode_lokasi     = Column(String(10), ForeignKey("lokasi.kode_lokasi"))

    pengadaan       = Column(String(20))   # '1' = PUSAT, '2' = DAOP/DIVRE
    tahun_pembelian = Column(Integer)
    unit_peruntukan = Column(String(10))   # 'A', 'B', 'C', 'D'
    status_kondisi  = Column(String(20), default="BARU")  # 'BARU', 'SO', 'TSO'
    is_afkir        = Column(Boolean, default=False)
    created_at      = Column(DateTime, default=datetime.utcnow)
    creator         = Column(String(50))

    alat_ref   = relationship("MasterAlat",       back_populates="asets")
    lokasi_ref = relationship("Lokasi",           back_populates="asets")
    riwayat    = relationship("RiwayatPerbaikan", back_populates="aset_ref")
    mutasi     = relationship("RiwayatMutasi",    back_populates="aset_ref")


class RiwayatPerbaikan(Base):
    """Repair and condition log — one row per technician report."""
    __tablename__ = "riwayat_perbaikan"

    id                = Column(Integer, primary_key=True, index=True)
    aset_uid          = Column(String(50), ForeignKey("aset.uid"))
    tanggal_perbaikan = Column(DateTime, nullable=False)
    lokasi_perbaikan  = Column(String(10), nullable=True)   # DAOP/DIVRE code
    upt_perbaikan     = Column(String(100), nullable=True)  # UPT name string
    teknisi           = Column(String(100), nullable=False)
    status_baru       = Column(String(20), nullable=False)  # 'SO' or 'TSO'
    keterangan        = Column(Text)
    created_at        = Column(DateTime, default=datetime.utcnow)

    aset_ref = relationship("Aset", back_populates="riwayat")


class RiwayatMutasi(Base):
    """Asset transfer/relocation log — absorbed from SQL riwayat_mutasi."""
    __tablename__ = "riwayat_mutasi"

    id               = Column(Integer, primary_key=True, index=True, autoincrement=True)
    aset_uid         = Column(String(50), ForeignKey("aset.uid"), nullable=False)
    kode_lokasi_asal = Column(String(10), ForeignKey("lokasi.kode_lokasi"), nullable=False)
    kode_lokasi_tuju = Column(String(10), ForeignKey("lokasi.kode_lokasi"), nullable=False)
    dilakukan_oleh   = Column(String(50), nullable=False)  # username, not FK — same as creator pattern
    alasan           = Column(Text, nullable=True)
    created_at       = Column(DateTime, default=datetime.utcnow)

    aset_ref     = relationship("Aset",   back_populates="mutasi")
    lokasi_asal  = relationship("Lokasi", foreign_keys=[kode_lokasi_asal])
    lokasi_tuju  = relationship("Lokasi", foreign_keys=[kode_lokasi_tuju])