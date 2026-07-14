from sqlalchemy import Column, Integer, String, Text, Boolean, Date, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from datetime import datetime
from database import Base

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    role = Column(String(20)) # Roles: 'SUPER_ADMIN', 'ADMIN_DAOP', 'TEKNISI'
    assigned_region = Column(String(10), nullable=True) # e.g., 'D1', 'D2', 'D3', etc.

class MasterKatalog(Base):
    __tablename__ = "master_katalog"

    kode_alat = Column(String(10), primary_key=True, index=True)
    nama_alat = Column(String(100), nullable=False)
    deskripsi = Column(Text)

    # Establish a one-to-many relationship with Aset
    asets = relationship("Aset", back_populates="katalog")

class Lokasi(Base):
    __tablename__ = "lokasi"

    kode_lokasi = Column(String(10), primary_key=True, index=True)
    nama_lokasi = Column(String(100), nullable=False)
    tipe_lokasi = Column(String(50)) # 'DAOP', 'DIVRE', 'BALAIYASA'

    asets = relationship("Aset", back_populates="lokasi_ref") # From: lokasi_ref = relationship("Lokasi", back_populates="asets")

class Aset(Base):
    __tablename__ = "aset"

    uid = Column(String(50), primary_key=True, index=True)
    kode_id = Column(String(50), unique=True, nullable=False, index=True)
    
    # Foreign Keys linking to master tables
    kode_alat = Column(String(10), ForeignKey("master_katalog.kode_alat"))
    kode_lokasi = Column(String(10), ForeignKey("lokasi.kode_lokasi"))
    
    pengadaan = Column(String(20))
    tahun_pembelian = Column(Integer)
    unit_peruntukan = Column(String(50))
    status_kondisi = Column(String(20), default="BARU")
    is_afkir = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    creator = Column(String(50))

    # Bi-directional relationships
    katalog = relationship("MasterKatalog", back_populates="asets")
    lokasi_ref = relationship("Lokasi", back_populates="asets")
    riwayat = relationship("RiwayatPerbaikan", back_populates="aset_ref")

class RiwayatPerbaikan(Base):
    __tablename__ = "riwayat_perbaikan"

    id = Column(Integer, primary_key=True, index=True)
    aset_uid = Column(String(50), ForeignKey("aset.uid"))
    
    tanggal_perbaikan = Column(DateTime, nullable=False)
    lokasi_perbaikan = Column(String(10), nullable=True)
    upt_perbaikan = Column(String(100), nullable=True)
    teknisi = Column(String(100), nullable=False)
    status_baru = Column(String(20), nullable=False)
    keterangan = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow)

    aset_ref = relationship("Aset", back_populates="riwayat")