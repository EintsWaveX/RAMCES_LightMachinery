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
    """
    A tool TYPE — the top of the two-level tool identity.

    The authoritative master is the client's `KATALOG SFM.xlsx ▸ KATALOG ALAT
    KERJA` sheet (103 rows). A specific make and model of one of these is an
    `AlatVarian` ("Model/Type"), NOT another row here — `HTT 220 V`,
    `HTT 3 PHASE` and `GEISMAR HTT` are three models of the single alat kerja
    `HTT HAND TIE TAMPER`.
    """

    __tablename__ = "kategori_alat"
    kode_alat = Column(String(10), primary_key=True, index=True)
    nama_alat = Column(String(100), nullable=False)

    # ── Katalog flags ──
    # `perlu_kalibrasi` is what gates the Kalibrasi tab: a genset is serviced,
    # not calibrated, so offering the form for one invites fictional records.
    # It replaced a hardcoded four-code set in seed.py.
    alat_ukur = Column(Boolean, nullable=False, server_default=text("false"))
    perlu_kalibrasi = Column(Boolean, nullable=False, server_default=text("false"))
    # FASILITAS | JEMBATAN | None — the katalog's two spektek groupings, which
    # mirror the two `Spesifikasi Lengkap Alat Kerja/` subfolders.
    kelompok = Column(String(20), nullable=True)

    # ── Documents that describe the TOOL TYPE, not one model of it ──
    #
    # The client's drop pairs its PDFs with alat kerja, not with models: one
    # file covers four tools ("Spektek Genset, Pompa Air, Shear Wrench dan
    # Impact Wrench.pdf") and several cover tools that have no `AlatVarian` row
    # at all. Storing them only on AlatVarian meant a technician scanning the QR
    # of a genset whose model was never filled in saw no spec sheet, even though
    # the client had supplied one.
    #
    # `_varian_payload()` falls back to these when a model's own slot is empty
    # and marks the result `spek_from_katalog` / `manual_from_katalog`, so the
    # UI can say the document is the general one for the tool type.
    #
    # Same convention as AlatVarian: a `url_*` is an external link, a `file_*`
    # is a basename inside `uploads/dokumen_alat/`, and the file wins.
    url_spek = Column(String(500), nullable=True)
    file_spek = Column(String(255), nullable=True)
    url_manual = Column(String(500), nullable=True)
    file_manual = Column(String(255), nullable=True)

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
    A "Model/Type" — one specific make and model of an alat kerja.

    One alat kerja has several field models that are NOT interchangeable for
    sparepart purposes — a GENSET 3 PHASE HTT is either GX270 or GX390 and each
    takes a different carburettor, and a brush cutter is 2T TASCO vs 4T PROQUIP
    vs 4T HONDA. The repair log records this per job, so it belongs on the asset.

    ── The spec block ──
    Shaped by the client's `Rekap Spek RAMCES.docx` template, which is fixed at
    seven rows: Merk, Model/Type, and five FREE-FORM "Spesifikasi Utama" rows
    whose labels differ per tool ("Max. Torque" on an impact wrench, "Runtime"
    on a work light, "Cutting Wheel" on a rail saw). That is why the five slots
    are label/value PAIRS rather than named columns — the previous fixed
    kapasitas/daya/dimensi/berat quartet fitted a genset and nothing else.

    `kapasitas`/`daya`/`dimensi`/`berat` are retained ONLY so the one-off
    backfill in `_ensure_schema()` has something to read; nothing writes or
    renders them any more. Do not add new consumers.
    """

    __tablename__ = "alat_varian"

    id_varian = Column(Integer, primary_key=True, index=True, autoincrement=True)
    kode_alat = Column(
        String(10), ForeignKey("kategori_alat.kode_alat"), nullable=False, index=True
    )
    nama_varian = Column(String(100), nullable=False)  # GX270, 2T TASCO, GEISMAR…
    keterangan = Column(Text, nullable=True)

    # ── Rows 1–2 of the template (required at the API layer) ──
    merk = Column(String(100), nullable=True)  # MILWAUKEE, HONDA, KERTZ…
    tipe_model = Column(String(100), nullable=True)  # M18 ONEFHIWF34, GX390…

    # ── Rows 3–7: five free-form spec pairs ──
    spek1_label = Column(String(60), nullable=True)
    spek1_nilai = Column(String(200), nullable=True)
    spek2_label = Column(String(60), nullable=True)
    spek2_nilai = Column(String(200), nullable=True)
    spek3_label = Column(String(60), nullable=True)
    spek3_nilai = Column(String(200), nullable=True)
    spek4_label = Column(String(60), nullable=True)
    spek4_nilai = Column(String(200), nullable=True)
    spek5_label = Column(String(60), nullable=True)
    spek5_nilai = Column(String(200), nullable=True)

    # ── Attachments ──
    # Each accepts either an external link (the Rekap cites manufacturer CDNs
    # and Google Drive) or a file uploaded into `uploads/`. `_varian_payload()`
    # resolves the pair to one URL, preferring the local file.
    #
    # The PHOTO is served publicly — landing.html is reached by scanning a QR
    # code with no session — while the two documents stay Bearer-authenticated
    # like calibration certificates. See main.py.
    foto_url = Column(String(500), nullable=True)
    foto_file = Column(String(255), nullable=True)  # basename in uploads/foto_alat/
    url_spek = Column(String(500), nullable=True)
    file_spek = Column(String(255), nullable=True)  # basename in uploads/dokumen_alat/
    url_manual = Column(String(500), nullable=True)
    file_manual = Column(String(255), nullable=True)

    # ── Superseded by the five spek pairs above; read only by the backfill ──
    kapasitas = Column(String(100), nullable=True)
    daya = Column(String(100), nullable=True)
    dimensi = Column(String(100), nullable=True)
    berat = Column(String(50), nullable=True)

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
    # Serial number is per PHYSICAL UNIT, so it lives here and not on
    # AlatVarian — two assets of the same variant have different serials.
    nomor_seri = Column(String(100), nullable=True)

    kategori = relationship("KategoriAlat", back_populates="asets")
    lokasi_ref = relationship("Lokasi", back_populates="asets")
    varian_ref = relationship("AlatVarian")
    riwayat_kondisi = relationship("RiwayatKondisi", back_populates="aset_ref")
    riwayat_mutasi = relationship("RiwayatMutasi", back_populates="aset_ref")


class RiwayatKondisi(Base):
    __tablename__ = "riwayat_kondisi"
    id_riwayat = Column(Integer, primary_key=True, index=True, autoincrement=True)
    id_aset = Column(String(50), ForeignKey("aset.id_aset", ondelete="CASCADE"))
    id_pengguna = Column(
        Integer, ForeignKey("pengguna.id_pengguna", ondelete="SET NULL")
    )
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
    id_aset = Column(String(50), ForeignKey("aset.id_aset", ondelete="CASCADE"))
    id_lokasi_asal = Column(String(10), ForeignKey("lokasi.id_lokasi"))
    id_lokasi_tujuan = Column(String(10), ForeignKey("lokasi.id_lokasi"))
    id_pengguna = Column(
        Integer, ForeignKey("pengguna.id_pengguna", ondelete="SET NULL")
    )
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
    # Nullable so the FK can carry ON DELETE SET NULL: deleting a user must not
    # delete the record of a calibration that genuinely happened, and NOT NULL
    # would make the database reject the cascade at runtime.
    id_pengguna = Column(
        Integer, ForeignKey("pengguna.id_pengguna", ondelete="SET NULL"), nullable=True
    )
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
    """
    Master sparepart catalog.

    ── Deliberately narrow ──
    A part is identified by WHAT IT IS and WHAT IT FITS: `nama_part`, its
    category, its alat kerja and (optionally) the Model/Type. There is no `sku`
    and no `part_number`; both were internal codes nobody in the field quoted,
    and `sku` in particular was auto-minted as `SP00001…` on create, so it
    carried no information the row did not already hold.

    Ten columns were dropped with the "Identifikasi" and "Informasi Tambahan"
    blocks of the Tambah Suku Cadang form: `sku`, `part_number`,
    `serial_numbers`, `lookup_tags`, `is_critical`, `linked_vehicle`,
    `warranty_months`, `supplier`, `ref_part`, `deskripsi`. Do not reintroduce
    one without a screen that reads it.

    Criticality is no longer stored. It is DERIVED from the ledger —
    `stok <= stok_min` — which is the only definition the dashboard, the status
    badges and the "Perlu segera dipesan" table ever actually used; the stored
    boolean was OR-ed into that expression and could never make a well-stocked
    part critical on its own.
    """
    __tablename__ = "sparepart"

    id_part      = Column(Integer, primary_key=True, index=True, autoincrement=True)
    nama_part    = Column(String(150), nullable=False)
    id_kategori  = Column(Integer, ForeignKey("sparepart_kategori.id_kategori"), nullable=True)
    kode_alat    = Column(String(10),  ForeignKey("kategori_alat.kode_alat"),    nullable=True)
    # Model-specific parts (a GX390 carburettor fits no other model). Null means
    # the part fits EVERY model of `kode_alat`, which is the common case — the
    # compatibility filter on the repair form reads it that way.
    id_varian    = Column(Integer, ForeignKey("alat_varian.id_varian"), nullable=True, index=True)
    unit         = Column(String(20),  nullable=False, server_default="Piece")
    harga_satuan = Column(Integer,     nullable=True)   # stored in IDR (integer rupiah)
    stok_min     = Column(Integer,     nullable=False, server_default="0")
    auto_demand  = Column(Boolean, nullable=False, server_default=text("false"))

    kategori_ref   = relationship("SparePartKategori", back_populates="parts")
    kategori_alat_ref = relationship("KategoriAlat")
    varian_ref     = relationship("AlatVarian")
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
    id_pengguna      = Column(Integer,    ForeignKey("pengguna.id_pengguna", ondelete="SET NULL"), nullable=True)
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


class PemakaianSparepart(Base):
    """
    One sparepart consumed by one repair — the link between the inventory
    ledger and the maintenance log.

    Written only by `catat_perbaikan()` in main.py, inside the SAME transaction
    as the `RiwayatKondisi` row it belongs to, so a short stock rolls the whole
    report back rather than recording a repair that consumed nothing.

    `id_stok` points at the `OUT` movement this usage wrote. That is what keeps
    `sparepart_stok` the single source of truth for stock: this table never
    computes a balance, it references the movement that changed one. Never
    subtract from stock here — go through the ledger.

    `id_aset` is denormalised off `riwayat_kondisi` because every report and
    rollup filters by asset first; joining through the history row for it would
    put a second join on every one of those queries.
    """

    __tablename__ = "pemakaian_sparepart"

    id_pakai = Column(Integer, primary_key=True, index=True, autoincrement=True)
    # CASCADE, because `delete_aset()` deletes the asset's riwayat_kondisi rows
    # directly. Without it, deleting any asset whose repair consumed spare parts
    # was rejected by PostgreSQL and surfaced as a 500 — the ondelete pass that
    # made every `id_aset` FK CASCADE reached this table through id_aset and
    # missed the link through id_riwayat.
    id_riwayat = Column(
        Integer,
        ForeignKey("riwayat_kondisi.id_riwayat", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    id_aset = Column(
        String(50),
        ForeignKey("aset.id_aset", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    id_part = Column(
        Integer, ForeignKey("sparepart.id_part"), nullable=False, index=True
    )
    id_stok = Column(Integer, ForeignKey("sparepart_stok.id_stok"), nullable=True)
    id_gudang = Column(Integer, ForeignKey("gudang.id_gudang"), nullable=True)
    jumlah = Column(Integer, nullable=False)
    # Snapshot at time of use, same rule as SparePartStok.harga_satuan: a later
    # price change must not re-price a repair that already happened.
    harga_satuan = Column(Integer, nullable=True)
    keterangan = Column(Text, nullable=True)
    waktu = Column(DateTime, server_default=text("CURRENT_TIMESTAMP"), index=True)

    riwayat_ref = relationship("RiwayatKondisi")
    aset_ref = relationship("Aset")
    part_ref = relationship("SparePart")
    stok_ref = relationship("SparePartStok")
    gudang_ref = relationship("Gudang")
