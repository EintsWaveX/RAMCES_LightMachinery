from sqlalchemy import Column, Integer, String, Text, Boolean, Date, DateTime, ForeignKey
from sqlalchemy.orm import relationship, backref
from datetime import datetime, timezone
from database import Base


class User(Base):
    __tablename__ = "users"

    id              = Column(Integer, primary_key=True, index=True)
    username        = Column(String(50), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=True)
    role            = Column(String(20))  # 'SUPER_ADMIN', 'ADMIN_DAOP', 'TEKNISI'
    assigned_region = Column(String(10), ForeignKey("lokasi.kode_lokasi"), nullable=True)  # FK-like to lokasi.kode_lokasi
    
    region_ref      = relationship("Lokasi", foreign_keys=[assigned_region])


class Lokasi(Base):
    __tablename__ = "lokasi"

    parent_kode = Column(String(10), ForeignKey("lokasi.kode_lokasi"), nullable=True)
    kode_lokasi = Column(String(10), primary_key=True, index=True)
    nama_lokasi = Column(String(100), nullable=False)
    tipe_lokasi = Column(String(50), nullable=False)  # 'PUSAT', 'DAOP', 'DIVRE', 'BALAIYASA'
    aktif       = Column(Boolean, default=True)

    children    = relationship("Lokasi", foreign_keys="[Lokasi.parent_kode]", backref=backref("parent", remote_side="Lokasi.kode_lokasi"))
    asets       = relationship("Aset", back_populates="lokasi_ref", foreign_keys="[Aset.kode_lokasi]")


class MasterAlat(Base):
    __tablename__ = "master_alat"

    kode                = Column(String(10),  primary_key=True, index=True)
    nama                = Column(String(100), nullable=False)
    tanggal_didaftarkan = Column(Date, nullable=True)
    deskripsi           = Column(Text, nullable=True)
    aktif               = Column(Boolean, default=True)

    asets               = relationship("Aset", back_populates="alat_ref")


class Aset(Base):
    __tablename__ = "aset"

    # uid: internal surrogate key (e.g. WH-ABC12345)
    # kode_id: human-readable asset code (e.g. BOR-1-26-A-D2), unique
    uid                  = Column(String(50), primary_key=True, index=True)
    kode_id              = Column(String(50), unique=True, nullable=False, index=True)

    kode_alat            = Column(String(10), ForeignKey("master_alat.kode"))
    kode_lokasi          = Column(String(10), ForeignKey("lokasi.kode_lokasi"))
    original_kode_lokasi = Column(String(10), ForeignKey("lokasi.kode_lokasi"), nullable=True)

    pengadaan            = Column(String(20))   # 'PUSAT' || 'DAOP/DIVRE/BALAIYASA'
    tahun_pembelian      = Column(Integer)
    unit_peruntukan      = Column(String(10))   # 'A', 'B', 'C', 'D'
    status_kondisi       = Column(String(20), default="BARU")  # 'BARU', 'SO', 'TSO'
    is_afkir             = Column(Boolean, default=False)
    created_at           = Column(DateTime, default=datetime.now(timezone.utc))
    creator_id           = Column(Integer, ForeignKey("users.id"), nullable=True)

    alat_ref             = relationship("MasterAlat",       back_populates="asets")
    lokasi_ref           = relationship("Lokasi",           back_populates="asets", foreign_keys=[kode_lokasi])
    original_lokasi_ref  = relationship("Lokasi",           foreign_keys=[original_kode_lokasi])
    riwayat              = relationship("RiwayatPerbaikan", back_populates="aset_ref")
    mutasi               = relationship("RiwayatMutasi",    back_populates="aset_ref")
    creator_ref          = relationship("User", foreign_keys=[creator_id])


class RiwayatPerbaikan(Base):
    """Repair and condition log — one row per technician report."""
    __tablename__ = "riwayat_perbaikan"

    id                 = Column(Integer, primary_key=True, index=True)
    aset_uid           = Column(String(50), ForeignKey("aset.uid"))
    tanggal_perbaikan  = Column(DateTime, nullable=False)
    dicatat_pada       = Column(DateTime, default=datetime.now(timezone.utc))
    teknisi            = Column(String(100), nullable=False)
    status_baru        = Column(String(20), nullable=False)  # 'SO' or 'TSO'
    keterangan         = Column(Text)

    kode_upt_perbaikan = Column(String(10), ForeignKey("lokasi.kode_lokasi"), nullable=True)
    upt_ref            = relationship("Lokasi", foreign_keys=[kode_upt_perbaikan])
    aset_ref           = relationship("Aset", back_populates="riwayat")


class RiwayatMutasi(Base):
    """Asset transfer/relocation log — absorbed from SQL riwayat_mutasi."""
    __tablename__ = "riwayat_mutasi"

    id               = Column(Integer, primary_key=True, index=True)
    aset_uid         = Column(String(50), ForeignKey("aset.uid"), nullable=False)
    kode_lokasi_asal = Column(String(10), ForeignKey("lokasi.kode_lokasi"), nullable=False)
    kode_lokasi_tuju = Column(String(10), ForeignKey("lokasi.kode_lokasi"), nullable=False)
    dilakukan_oleh   = Column(String(50), nullable=False)  # username, not FK — same as creator pattern
    alasan           = Column(Text, nullable=True)
    tanggal_mutasi   = Column(DateTime, default=datetime.now(timezone.utc))

    aset_ref         = relationship("Aset",   back_populates="mutasi")
    lokasi_asal      = relationship("Lokasi", foreign_keys=[kode_lokasi_asal])
    lokasi_tuju      = relationship("Lokasi", foreign_keys=[kode_lokasi_tuju])