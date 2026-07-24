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
)
from sqlalchemy.orm import relationship, backref
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

    id_lokasi = Column(String(10), primary_key=True)
    id_induk = Column(String(10), ForeignKey("lokasi.id_lokasi"), nullable=True)
    unit_peruntukan = Column(String(20), nullable=True)

    # Gunakan string "Lokasi.id_lokasi" pada remote_side
    sub_lokasi = relationship(
        "Lokasi", backref=backref("induk", remote_side="Lokasi.id_lokasi")
    )


class Pengguna(Base):
    __tablename__ = "pengguna"
    id_pengguna = Column(Integer, primary_key=True, index=True, autoincrement=True)
    username = Column(String(50), unique=True, nullable=False)
    hashed_password = Column(String(255), nullable=True)  # Wajib untuk autentikasi
    role = Column(String(20), nullable=False)  # SUPER_ADMIN, ADMIN_WILAYAH, TEKNISI
    id_lokasi = Column(String(10), ForeignKey("lokasi.id_lokasi"), nullable=True)

    lokasi_ref = relationship("Lokasi")


class Aset(Base):
    __tablename__ = "aset"
    id_aset = Column(String(50), primary_key=True, index=True)
    kode_alat = Column(String(10), ForeignKey("kategori_alat.kode_alat"))
    id_lokasi = Column(String(10), ForeignKey("lokasi.id_lokasi"))
    tanggal_pembelian = Column(Date, nullable=False)
    sumber_pengadaan = Column(String(50), nullable=False)
    status_terakhir = Column(String(20), server_default="SO")
    # HAPUS BARIS is_afkir DISINI
    waktu_update = Column(
        DateTime,
        server_default=text("CURRENT_TIMESTAMP"),
        onupdate=datetime.now(timezone.utc),
    )

    kategori = relationship("KategoriAlat", back_populates="asets")
    lokasi_ref = relationship("Lokasi", back_populates="asets")
    riwayat_kondisi = relationship("RiwayatKondisi", back_populates="aset_ref")
    riwayat_mutasi = relationship("RiwayatMutasi", back_populates="aset_ref")


class RiwayatKondisi(Base):
    __tablename__ = "riwayat_kondisi"
    id_riwayat = Column(Integer, primary_key=True, index=True, autoincrement=True)
    id_aset = Column(String(50), ForeignKey("aset.id_aset"))
    id_pengguna = Column(Integer, ForeignKey("pengguna.id_pengguna"))
    kondisi = Column(String(20), nullable=False)
    keterangan = Column(Text)
    waktu_lapor = Column(DateTime, server_default=text("CURRENT_TIMESTAMP"))

    aset_ref = relationship("Aset", back_populates="riwayat_kondisi")
    pengguna_ref = relationship("Pengguna")


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

