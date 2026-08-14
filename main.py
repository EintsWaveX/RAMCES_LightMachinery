import asyncio
import os
import re
import secrets
import shutil
from dotenv import load_dotenv
from fastapi import (
    FastAPI,
    Depends,
    File,
    HTTPException,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
    Query,
    Request,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.security import OAuth2PasswordBearer
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session, joinedload
from datetime import datetime, timedelta, date
from typing import List, Optional
from sqlalchemy import or_, func, case, extract, select, distinct, text as sa_text
import bcrypt
import jwt

# ── IMPORTS ────────────────────────────────────────────────────────
import models
from database import engine, SessionLocal
from pydantic import BaseModel


# Inisialisasi Database
models.Base.metadata.create_all(bind=engine)
load_dotenv()


def _ensure_schema():
    """
    Idempotent DDL for databases created before these columns/indexes existed.

    `create_all()` creates missing TABLES but never ALTERs an existing one, so a
    populated schema silently misses every column added after it was first
    created. There is no Alembic in this project, so these additive statements
    are the migration. All are `IF NOT EXISTS` / `IF EXISTS` guarded and safe to
    re-run on every boot.
    """
    statements = [
        # ── Indexes ──
        "CREATE INDEX IF NOT EXISTS ix_rk_aset_waktu "
        "ON riwayat_kondisi (id_aset, waktu_lapor, id_riwayat)",
        "CREATE INDEX IF NOT EXISTS ix_rk_waktu ON riwayat_kondisi (waktu_lapor)",
        "CREATE INDEX IF NOT EXISTS ix_rk_lokasi ON riwayat_kondisi (id_lokasi)",
        "CREATE INDEX IF NOT EXISTS ix_aset_lokasi_status "
        "ON aset (id_lokasi, status_terakhir)",
        "CREATE INDEX IF NOT EXISTS ix_stok_part_lokasi "
        "ON sparepart_stok (id_part, id_lokasi)",
        # ── Presence ──
        "ALTER TABLE pengguna ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP",
        "ALTER TABLE pengguna ADD COLUMN IF NOT EXISTS last_view VARCHAR(50)",
        # ── Spesifikasi teknis (varian) ──
        "ALTER TABLE aset ADD COLUMN IF NOT EXISTS id_varian INTEGER "
        "REFERENCES alat_varian(id_varian)",
        "CREATE INDEX IF NOT EXISTS ix_aset_varian ON aset (id_varian)",
        # Serial number is per physical unit, so it hangs off `aset`, not the
        # shared variant row.
        "ALTER TABLE aset ADD COLUMN IF NOT EXISTS nomor_seri VARCHAR(100)",
        # Spec fields rendered on the public asset card. Adding a column here
        # WITHOUT the matching models.py change (or vice versa) is the failure
        # mode this list exists to prevent — keep the two in step.
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS merk VARCHAR(100)",
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS tipe_model VARCHAR(100)",
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS kapasitas VARCHAR(100)",
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS daya VARCHAR(100)",
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS dimensi VARCHAR(100)",
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS berat VARCHAR(50)",
        # ── Calibration certificate ──
        "ALTER TABLE riwayat_kalibrasi ADD COLUMN IF NOT EXISTS "
        "file_sertifikat VARCHAR(255)",
        # ── Warehouse ── (column first; the index below depends on it)
        "ALTER TABLE sparepart_stok ADD COLUMN IF NOT EXISTS id_gudang INTEGER "
        "REFERENCES gudang(id_gudang)",
        "CREATE INDEX IF NOT EXISTS ix_stok_part_gudang "
        "ON sparepart_stok (id_part, id_gudang)",
        # tipe_gerakan widened from 10 to 20 chars for RETUR_VENDOR / ADJ_OUT.
        #
        # GUARDED, unlike the rest of this list, because `ALTER COLUMN … TYPE`
        # is NOT a no-op when the type already matches: PostgreSQL takes an
        # ACCESS EXCLUSIVE lock and rewrites the whole table plus every index on
        # it. This runs at import, so it happened on every restart and once per
        # uvicorn worker — seconds of total lockout on a 100k-row ledger,
        # minutes at 1M.
        """
        DO $$ BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'sparepart_stok'
              AND column_name = 'tipe_gerakan'
              AND character_maximum_length < 20
          ) THEN
            ALTER TABLE sparepart_stok ALTER COLUMN tipe_gerakan TYPE VARCHAR(20);
          END IF;
        END $$
        """,
        # The old CHECK only permitted IN|OUT — replace it with the wider set.
        # Also guarded: ADD CONSTRAINT … CHECK validates every existing row
        # under an ACCESS EXCLUSIVE lock, so re-running it each boot re-scanned
        # the entire ledger for nothing.
        """
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'sparepart_stok_gerakan_check'
          ) THEN
            ALTER TABLE sparepart_stok ADD CONSTRAINT sparepart_stok_gerakan_check
              CHECK (tipe_gerakan IN
                ('IN','OUT','RETUR_VENDOR','RETUR_CUST','ADJ_IN','ADJ_OUT'));
          END IF;
        END $$
        """,

        # ── Indexes added after the performance audit ──
        #
        # riwayat_mutasi had NO index at all beyond its primary key, and is
        # queried per-asset inside the export loops — so every one of those
        # lookups was a sequential scan of the whole table. The composite also
        # serves the `ORDER BY waktu_mutasi` those queries all carry.
        "CREATE INDEX IF NOT EXISTS ix_rm_aset_waktu "
        "ON riwayat_mutasi (id_aset, waktu_mutasi)",
        "CREATE INDEX IF NOT EXISTS ix_rm_lokasi_asal "
        "ON riwayat_mutasi (id_lokasi_asal)",
        "CREATE INDEX IF NOT EXISTS ix_rm_lokasi_tujuan "
        "ON riwayat_mutasi (id_lokasi_tujuan)",
        # Partial: the repair dashboards filter kondisi='TSO' constantly, and
        # ix_rk_aset_waktu leads with id_aset so it cannot serve that predicate.
        "CREATE INDEX IF NOT EXISTS ix_rk_tso ON riwayat_kondisi "
        "(id_aset, waktu_lapor) WHERE kondisi = 'TSO'",
        "CREATE INDEX IF NOT EXISTS ix_rk_kondisi_aset "
        "ON riwayat_kondisi (kondisi, id_aset)",
        # Turns _last_out_map's full ledger scan into an index-only scan.
        "CREATE INDEX IF NOT EXISTS ix_stok_gerakan_part_waktu "
        "ON sparepart_stok (tipe_gerakan, id_part, waktu DESC)",
        "CREATE INDEX IF NOT EXISTS ix_stok_ref_transfer "
        "ON sparepart_stok (id_ref_transfer) WHERE id_ref_transfer IS NOT NULL",
        # create_aset counts assets of the same kode_alat on every insert.
        "CREATE INDEX IF NOT EXISTS ix_aset_kode_alat ON aset (kode_alat)",
        "CREATE INDEX IF NOT EXISTS ix_kal_aset_tanggal "
        "ON riwayat_kalibrasi (id_aset, tanggal_kalibrasi, waktu_input)",
        # Unindexed FKs, each of which forces a scan of the child table whenever
        # the parent row is deleted.
        "CREATE INDEX IF NOT EXISTS ix_rk_pengguna ON riwayat_kondisi (id_pengguna)",
        "CREATE INDEX IF NOT EXISTS ix_rm_pengguna ON riwayat_mutasi (id_pengguna)",
        "CREATE INDEX IF NOT EXISTS ix_stok_pengguna ON sparepart_stok (id_pengguna)",
        "CREATE INDEX IF NOT EXISTS ix_pengguna_lokasi ON pengguna (id_lokasi)",
        "CREATE INDEX IF NOT EXISTS ix_sparepart_kategori ON sparepart (id_kategori)",
        "CREATE INDEX IF NOT EXISTS ix_sparepart_kode_alat ON sparepart (kode_alat)",

        # ── Normalise status_terakhir ──
        #
        # Five queries wrapped this column in func.upper(), which makes both
        # declared indexes on it unusable, while six others compared it raw —
        # so half the code was wrong whichever way the data actually looked.
        # Normalising once here lets every comparison be a plain indexed
        # equality. Idempotent: the WHERE means a clean database updates zero
        # rows and the statement costs one index scan.
        "UPDATE aset SET status_terakhir = UPPER(status_terakhir) "
        "WHERE status_terakhir IS NOT NULL AND status_terakhir <> UPPER(status_terakhir)",
        "UPDATE riwayat_kondisi SET kondisi = UPPER(kondisi) "
        "WHERE kondisi IS NOT NULL AND kondisi <> UPPER(kondisi)",
    ]
    for stmt in statements:
        # Each in its own transaction: one failure (e.g. a constraint that
        # already exists in a different form) must not roll back the rest.
        try:
            with engine.begin() as conn:
                conn.execute(sa_text(stmt))
        except Exception as exc:  # never block startup on schema touch-up
            print(f"[warn] schema step skipped: {stmt[:60]}… → {exc}")


_ensure_schema()

app = FastAPI(title="SIMA-KAI Asset API")

# Everything this app serves is text: app.js was 470 KB on the wire, index.html
# 383 KB, and /api/history/summary 98.6 KB — all uncompressed. This JSON and JS
# compresses roughly 8:1, which makes one line of middleware the single largest
# performance win available here.
#
# `minimum_size` skips tiny responses where the gzip header costs more than it
# saves. WebSocket frames bypass HTTP middleware entirely, so /ws/updates is
# unaffected.
app.add_middleware(GZipMiddleware, minimum_size=1000)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Cache policy ──────────────────────────────────────────────────
# FileResponse already emits ETag and Last-Modified, but without Cache-Control
# the browser revalidates nothing and re-downloads on every navigation.
#
# Code and markup use `no-cache`, which does NOT mean "don't cache" — it means
# "cache, but revalidate": the browser sends If-None-Match and usually gets a
# 304 with an empty body. That keeps deploys instant while still avoiding the
# transfer. Images and fonts are content that only changes under a new filename,
# so they get a year.
_CACHE_REVALIDATE = "no-cache"
_CACHE_IMMUTABLE = "public, max-age=31536000, immutable"
_LONG_CACHE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".svg", ".woff", ".woff2"}


def _cache_control_for(ext: str) -> str:
    return _CACHE_IMMUTABLE if ext in _LONG_CACHE_EXT else _CACHE_REVALIDATE

# ==================================================================
# ── LOKASI HIERARCHY HELPERS ──────────────────────────────────────
# ==================================================================
# The `lokasi` table is flat — there is no parent_id column. The parent of a
# UPT/resort is encoded in its id: "JR1.3" belongs to DAOP "D1", "JRIII.7" to
# DIVRE "VIII", "BY1A" to Balaiyasa "BY1". The same rule lives in seed.py
# (get_parent_lokasi_code) and js/core.js (getParentLokasiCode); keep all three
# in step when changing it.

# Only I–IV exist in the seeded master data, but the regex below accepts up to
# IX. Without the V–IX rows a "JRV.1"-style code resolved to a code on the
# client (js/core.js) and to None here, so the same asset landed in two
# different buckets depending on which side did the maths. Keep this table
# byte-identical to `romanMap` in js/core.js and `_ROMAN_MAP` in seed.py.
_ROMAN_TO_DIVRE = {
    "I": "VI",
    "II": "VII",
    "III": "VIII",
    "IV": "VIV",
    "V": "VV",
    "VI": "VVI",
    "VII": "VVII",
    "VIII": "VVIII",
    "IX": "VIX",
}
_RE_UPT_ARAB = re.compile(r"^JR(\d+)\.", re.IGNORECASE)
_RE_UPT_ROMAN = re.compile(r"^JR(IV|IX|VIII|VII|VI|V|I{1,3})\.", re.IGNORECASE)
_RE_UPT_BALAIYASA = re.compile(r"^(BY\d+)[A-Z]+$", re.IGNORECASE)


def get_parent_lokasi_code(id_lokasi: Optional[str]) -> Optional[str]:
    """UPT code → its DAOP/DIVRE/BALAIYASA parent code. None if already a parent."""
    if not id_lokasi:
        return None
    m = _RE_UPT_ARAB.match(id_lokasi)
    if m:
        return f"D{m.group(1)}"
    m = _RE_UPT_ROMAN.match(id_lokasi)
    if m:
        return _ROMAN_TO_DIVRE.get(m.group(1).upper())
    m = _RE_UPT_BALAIYASA.match(id_lokasi)
    if m:
        return m.group(1).upper()
    return None


def resolve_lokasi_scope(db: Session, id_lokasi: Optional[str]):
    """
    Resolve a region filter into the concrete set of lokasi ids it covers.

    Returns (lokasi_ids, parent_row, child_rows):
      - id_lokasi falsy          → (None, None, [])  = no filter, global scope
      - id_lokasi is a UPT       → ([itself], its row, [its row])
      - id_lokasi is a parent    → ([parent] + children, parent row, child rows)
      - id_lokasi unknown to DB  → ([id_lokasi], None, [])

    Replaces `Lokasi.id_lokasi.like(f"{id_lokasi}%")`, which was wrong twice
    over: LIKE 'D1%' never matched 'JR1.3' (DAOP filters returned nothing), and
    LIKE 'VI%' matched VI/VII/VIII/VIV (DIVRE I silently aggregated all four).

    The parent code itself stays in the list because riwayat/aset rows may carry
    it directly; unlike a LIKE prefix, an exact IN () cannot over-match.
    """
    if not id_lokasi:
        return None, None, []

    parent = db.query(models.Lokasi).filter_by(id_lokasi=id_lokasi).first()
    if parent is not None and (parent.tipe or "").upper() == "UPT":
        return [parent.id_lokasi], parent, [parent]

    # ~250 rows — one scan in Python beats duplicating the roman-numeral map in
    # an unindexable SQL CASE expression.
    target = id_lokasi.upper()
    children = [
        l
        for l in db.query(models.Lokasi).all()
        if get_parent_lokasi_code(l.id_lokasi) == target
    ]
    return [id_lokasi] + [l.id_lokasi for l in children], parent, children


def balaiyasa_lokasi_ids(db: Session) -> set:
    """
    Every lokasi id on the workshop side of the tree: the BALAIYASA rows
    themselves plus their UPT-typed children (BY1A → BY1).

    A Balaiyasa is a workshop, not an operating region. An asset visits one for
    repair but is never based at one, and a repair performed there still belongs
    to the DAOP/DIVRE that owns the asset. Filtering these ids out is what keeps
    "BALAIYASA CIREBONPRUNJAKAN" from appearing as a row in the resort tables of
    Laporan Perbaikan. Mirrors `_is_balaiyasa_side()` in seed.py.
    """
    rows = db.query(models.Lokasi).all()
    parents = {
        l.id_lokasi for l in rows if (l.tipe or "").upper() == "BALAIYASA"
    }
    return parents | {
        l.id_lokasi for l in rows if get_parent_lokasi_code(l.id_lokasi) in parents
    }


def resolve_home_lokasi(db: Session, aset) -> Optional[str]:
    """
    Where an asset BELONGS, as opposed to where it currently sits.

    `aset.id_lokasi` is normally the answer, but an asset mutated to a workshop
    for repair carries the workshop code until it is sent back. In that window
    the owning region is the origin of the first mutation that moved it there —
    the same value the summary endpoint exposes as `original_lokasi_code`.
    Returns None only if the asset has no location at all.
    """
    current = aset.id_lokasi
    if not current or current not in balaiyasa_lokasi_ids(db):
        return current

    first = (
        db.query(models.RiwayatMutasi)
        .filter(models.RiwayatMutasi.id_aset == aset.id_aset)
        .order_by(models.RiwayatMutasi.waktu_mutasi.asc())
        .first()
    )
    return (first.id_lokasi_asal if first else None) or current


def assert_region_scope(db: Session, current_user, id_lokasi: Optional[str], pesan: str):
    """
    Guard a write by an ADMIN_WILAYAH against a location outside its own region.

    The comparison MUST go through `resolve_lokasi_scope`, never `==`. A token
    only ever carries a PARENT code, because the login region selector lists
    DAOP/DIVRE/BALAIYASA rows and excludes UPTs (`fetchLoginRegions` in
    js/api.js) — while assets live at UPT codes like `JR1.7`. An exact-equality
    check therefore rejected an admin's own assets ('JR1.7' != 'D1') and, where
    no check existed at all, let it write into other regions. This helper is the
    single place that rule now lives, so both directions stay correct.

    SUPER_ADMIN and any user without a region are unrestricted.
    """
    if current_user.role != "ADMIN_WILAYAH" or not current_user.id_lokasi:
        return
    scope, _, _ = resolve_lokasi_scope(db, current_user.id_lokasi)
    if scope and id_lokasi not in scope:
        raise HTTPException(status_code=403, detail=pesan)


def assert_aset_region_scope(db: Session, current_user, aset, pesan: str):
    """
    Same guard, but for an existing asset — tested against where it BELONGS.

    An asset away at a Balaiyasa carries the workshop code in `id_lokasi`, which
    is in no DAOP's scope. Checking that raw value would lock the owning region
    out of the very assets it has sent for repair, including recalling them.
    """
    assert_region_scope(
        db, current_user, resolve_home_lokasi(db, aset) or aset.id_lokasi, pesan
    )


# `peruntukan` and `sumber_pengadaan` are closed sets that get baked into the
# asset's composite primary key. Both used to fall back silently — an unknown
# peruntukan became the literal "X" (an ID segment no decoder can map, invisible
# to every peruntukan filter) and anything that was not exactly "PUSAT" became
# procurement code 2, i.e. DAOP/DIVRE. An unchecked radio in the edit form was
# enough to trigger either. Reject instead: a malformed primary key cannot be
# corrected later without rewriting every child row.
PERUNTUKAN_KE_KODE = {
    "JALAN REL": "A",
    "JEMBATAN": "B",
    "MEKANIK": "C",
    "BALAIYASA": "D",
}
KODE_KE_PERUNTUKAN = {v: k for k, v in PERUNTUKAN_KE_KODE.items()}
SUMBER_PENGADAAN_KE_KODE = {"PUSAT": 1, "DAOP/DIVRE": 2, "DIVRE": 2, "DAOP": 2}


def normalise_peruntukan(nilai: Optional[str]) -> tuple:
    """('JALAN REL', 'A') for any accepted spelling; 400 for anything else."""
    key = (nilai or "").strip().upper()
    if key in KODE_KE_PERUNTUKAN:  # accept the single-letter form too
        key = KODE_KE_PERUNTUKAN[key]
    if key not in PERUNTUKAN_KE_KODE:
        raise HTTPException(
            status_code=400,
            detail="Peruntukan wajib dipilih: "
            + ", ".join(PERUNTUKAN_KE_KODE) + ".",
        )
    return key, PERUNTUKAN_KE_KODE[key]


def normalise_sumber_pengadaan(nilai: Optional[str]) -> tuple:
    """('PUSAT', 1) or ('DAOP/DIVRE', 2); 400 for anything else."""
    key = (nilai or "").strip().upper().replace(" ", "")
    if key not in SUMBER_PENGADAAN_KE_KODE:
        raise HTTPException(
            status_code=400,
            detail="Sumber pengadaan wajib dipilih: PUSAT atau DAOP/DIVRE.",
        )
    kode = SUMBER_PENGADAAN_KE_KODE[key]
    return ("PUSAT" if kode == 1 else "DAOP/DIVRE"), kode


# DIVRE nama_lokasi holds a province ("SUMATERA UTARA"), which reads wrong in a
# "<kota>, <tanggal>" dateline — pin the seat of each region explicitly.
REGION_KOTA_OVERRIDE = {
    "VI": "Medan",
    "VII": "Padang",
    "VIII": "Palembang",
    "VIV": "Tanjungkarang",
    "BY1": "Cirebon",
    "BY2": "Prabumulih",
    "BY3": "Bandung",
}
DEFAULT_KOTA = "Bandung"  # PT KAI HQ — used for the unscoped/global view

_RE_DAOP = re.compile(r"^DAOP\s+(\d+)\s+(.*)$", re.IGNORECASE)
_RE_DIVRE = re.compile(r"^DIVRE\s+([IVX]+)\s+(.*)$", re.IGNORECASE)
_RE_BALAIYASA = re.compile(r"^BALAI\s*YASA\s+(.*)$", re.IGNORECASE)
_RE_UPT_NAMA = re.compile(r"^JR\s*([\dIVX]+(?:\.\d+)?)\s+(.*)$", re.IGNORECASE)


def build_region_labels(parent, id_lokasi: Optional[str], db: Session = None):
    """→ (region_name, region_label, kota). D1 → DAOP 1 JAKARTA / DAERAH OPERASI 1 JAKARTA / Jakarta."""
    if parent is None:
        if id_lokasi:
            return id_lokasi, id_lokasi, DEFAULT_KOTA
        return (
            "SEMUA DAERAH OPERASI",
            "SELURUH WILAYAH PT KERETA API INDONESIA (PERSERO)",
            DEFAULT_KOTA,
        )

    nama = (parent.nama_lokasi or parent.id_lokasi).strip()

    # A UPT is not a region — a dateline of "Jr 1.3 Pasarsenen, 7 Agustus 2026"
    # is nonsense. Take the city from the UPT's own DAOP/DIVRE parent.
    if (parent.tipe or "").upper() == "UPT":
        label = short_lokasi_label(parent.id_lokasi, nama)
        kota = DEFAULT_KOTA
        grandparent_code = get_parent_lokasi_code(parent.id_lokasi)
        if grandparent_code and db is not None:
            gp = db.query(models.Lokasi).filter_by(id_lokasi=grandparent_code).first()
            if gp is not None:
                _n, _l, kota = build_region_labels(gp, grandparent_code, db)
        return nama, label, kota

    label, kota = nama, nama
    m = _RE_DAOP.match(nama)
    if m:
        label, kota = f"DAERAH OPERASI {m.group(1)} {m.group(2)}", m.group(2)
    else:
        m = _RE_DIVRE.match(nama)
        if m:
            label, kota = f"DIVISI REGIONAL {m.group(1)} {m.group(2)}", m.group(2)
        else:
            m = _RE_BALAIYASA.match(nama)
            if m:
                label, kota = f"BALAI YASA {m.group(1)}", m.group(1)

    kota = REGION_KOTA_OVERRIDE.get(parent.id_lokasi, kota.title())
    return nama, label, kota


def short_lokasi_label(id_lokasi: Optional[str], nama_lokasi: Optional[str]) -> str:
    """
    'JR 1.2 Tanjungpriuk' → '1.2 Tanjungpriuk'.

    The printed report uses station abbreviations ('1.2 TPK'), but no such
    column exists in the schema and the codes cannot be derived from the names.
    Stripping the JR prefix gives the same visual shape with no schema change.
    Keep this the ONLY location string the frontend renders, so adding a real
    abbreviation column later upgrades every chart by changing this one function.
    """
    if nama_lokasi:
        m = _RE_UPT_NAMA.match(nama_lokasi.strip())
        if m:
            return f"{m.group(1)} {m.group(2)}"
        return nama_lokasi
    return id_lokasi or "—"


def upt_sort_key(lokasi_row):
    """Natural resort ordering: 1.1, 1.2, ... 1.10, 1.25 — not lexicographic."""
    m = _RE_UPT_NAMA.match((lokasi_row.nama_lokasi or "").strip())
    seg = m.group(1) if m else (lokasi_row.id_lokasi or "")
    head, _, tail = seg.partition(".")
    return (head, int(tail) if tail.isdigit() else 0)


# ==================================================================
# ── PYDANTIC SCHEMAS (Pengganti schemas.py) ───────────────────────
# ==================================================================


class Token(BaseModel):
    access_token: str
    token_type: str


class LoginForm(BaseModel):
    username: str
    role: str = "TEKNISI"
    id_lokasi: Optional[str] = None


class UserCreate(BaseModel):
    username: str
    password: Optional[str] = None
    role: str
    id_lokasi: Optional[str] = None


class UserUpdate(BaseModel):
    role: str
    id_lokasi: Optional[str] = None


class MasterAlatCreate(BaseModel):
    kode_alat: str
    nama_alat: str


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


class PerbaikanCreate(BaseModel):
    id_aset: str
    kondisi: str
    keterangan: Optional[str] = "-"
    peruntukan: Optional[str] = None
    id_lokasi: Optional[str] = None


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


# ==================================================================
# ── DATABASE SESSION & WEBSOCKET ──────────────────────────────────
# ==================================================================


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class ConnectionManager:
    """
    Live-update fan-out, plus the presence registry.

    Sockets are keyed by username so "who is online" is answerable without a
    database round trip. A user may hold several sockets at once (two tabs), so
    each username maps to a SET — they go offline only when the last one drops.
    """

    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self._lock = asyncio.Lock()
        # username → set of sockets
        self.user_sockets: dict = {}
        # username → { "view": str, "since": datetime }
        self.presence: dict = {}

    async def connect(self, websocket: WebSocket, username: Optional[str] = None):
        await websocket.accept()
        async with self._lock:
            self.active_connections.append(websocket)
            if username:
                self.user_sockets.setdefault(username, set()).add(websocket)
                self.presence.setdefault(
                    username, {"view": None, "since": datetime.now()}
                )

    async def disconnect(self, websocket: WebSocket, username: Optional[str] = None):
        async with self._lock:
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)
            if username and username in self.user_sockets:
                self.user_sockets[username].discard(websocket)
                # Only truly offline once every tab has closed.
                if not self.user_sockets[username]:
                    self.user_sockets.pop(username, None)
                    self.presence.pop(username, None)

    async def set_view(self, username: str, view: Optional[str]):
        """Record which screen a user is looking at (for the Pengguna list)."""
        if not username:
            return
        async with self._lock:
            entry = self.presence.setdefault(
                username, {"view": None, "since": datetime.now()}
            )
            if entry.get("view") != view:
                entry["view"] = view
                entry["since"] = datetime.now()

    def online_usernames(self) -> set:
        return set(self.user_sockets.keys())

    def presence_of(self, username: str) -> dict:
        return self.presence.get(username) or {}

    async def broadcast(self, message: str):
        """
        Fan a message out to every connected socket, in parallel and bounded.

        This used to send SEQUENTIALLY with no timeout, and it is awaited inside
        every mutating endpoint — so one client on a stalled mobile connection
        with a full TCP send buffer blocked the POST response for the user who
        made the change, and delayed every other client behind it.

        Failures now prune the socket instead of being swallowed: the previous
        bare `except: pass` left half-open connections in the list forever, to
        be retried on every subsequent broadcast.
        """
        async with self._lock:
            connections = list(self.active_connections)
        if not connections:
            return

        async def _send(ws):
            try:
                await asyncio.wait_for(ws.send_text(message), timeout=2.0)
            except Exception:
                await self.disconnect(ws)

        await asyncio.gather(
            *(_send(c) for c in connections), return_exceptions=True
        )


manager = ConnectionManager()


@app.get("/api/config")
def get_config():
    # Externally-reachable base URL, used only to build QR/landing links when
    # the app is being viewed on localhost. Tunnel-agnostic (Tailscale Funnel,
    # ngrok, reverse proxy); NGROK_URL is kept as a legacy alias.
    public_url = (
        os.environ.get("PUBLIC_URL") or os.environ.get("NGROK_URL") or ""
    ).rstrip("/")
    return {"public_url": public_url, "ngrok_url": public_url}


# ==================================================================
# ── SECURITY & AUTHENTICATION ─────────────────────────────────────
# ==================================================================

SECRET_KEY = os.environ.get("SECRET_KEY", "KAI_warehouse_super_secret_key")
ALGORITHM = "HS256"

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/login")


def get_password_hash(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))


def create_access_token(data: dict) -> str:
    payload = data.copy()
    payload["exp"] = datetime.utcnow() + timedelta(hours=12)
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(
    token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)
) -> models.Pengguna:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username = payload.get("sub")
        if not username:
            raise HTTPException(status_code=401, detail="Token invalid")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Token invalid")

    user = (
        db.query(models.Pengguna).filter(models.Pengguna.username == username).first()
    )
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def require_role(allowed_roles: list):
    def checker(current_user: models.Pengguna = Depends(get_current_user)):
        if current_user.role not in allowed_roles:
            raise HTTPException(
                status_code=403,
                detail="Anda tidak memiliki izin untuk melakukan aksi ini.",
            )
        return current_user

    return checker


# ── AUTH ENDPOINTS ──


@app.post("/api/login", response_model=Token)
def login(form_data: LoginForm, db: Session = Depends(get_db)):
    user = db.query(models.Pengguna).filter_by(username=form_data.username).first()

    if not user:
        # Pendaftaran otomatis untuk login pertama (Sesuai alur UI sebelumnya)
        if not form_data.id_lokasi and form_data.role != "SUPER_ADMIN":
            raise HTTPException(
                status_code=400, detail="Region wajib diisi untuk pendaftaran pertama."
            )

        user = models.Pengguna(
            username=form_data.username,
            hashed_password=None,
            role=form_data.role,
            id_lokasi=form_data.id_lokasi if form_data.role != "SUPER_ADMIN" else None,
        )
        db.add(user)
        db.commit()
        db.refresh(user)

    user.last_seen = datetime.now()
    db.commit()

    return {
        "access_token": create_access_token(
            {
                "sub": user.username,
                "role": user.role,
                "id_pengguna": user.id_pengguna,
                "id_lokasi": user.id_lokasi,
            }
        ),
        "token_type": "bearer",
    }


@app.get("/api/me")
def get_me(
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    The logged-in user plus their resolved home region.

    `default_region` is the DAOP/DIVRE/BALAIYASA the UI should preselect: a user
    may be assigned a UPT code (JR1.3), a parent code (D1), or nothing at all.
    Resolving it here keeps the parent-derivation rule in one place instead of
    making the frontend re-implement it.
    """
    own = current_user.id_lokasi or ""
    default_region = get_parent_lokasi_code(own) or own
    _ids, parent, _children = resolve_lokasi_scope(db, default_region)
    region_name, region_label, kota = build_region_labels(parent, default_region, db)
    return {
        "username": current_user.username,
        "role": current_user.role,
        "id_pengguna": current_user.id_pengguna,
        "id_lokasi": current_user.id_lokasi,
        "default_region": default_region,
        "region_name": region_name,
        "region_label": region_label,
        "kota": kota,
    }


@app.post("/api/users/create")
def create_user(
    user_data: UserCreate,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(
        require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"])
    ),
):
    if db.query(models.Pengguna).filter_by(username=user_data.username).first():
        raise HTTPException(status_code=400, detail="Username sudah terdaftar.")

    if current_user.role == "ADMIN_WILAYAH":
        if user_data.role != "TEKNISI":
            raise HTTPException(
                status_code=403, detail="ADMIN_WILAYAH hanya bisa membuat akun TEKNISI."
            )
        region = current_user.id_lokasi
    else:
        region = user_data.id_lokasi

    db.add(
        models.Pengguna(
            username=user_data.username,
            hashed_password=get_password_hash(user_data.password)
            if user_data.password
            else None,
            role=user_data.role,
            id_lokasi=region,
        )
    )
    db.commit()
    return {"message": f"User {user_data.username} berhasil dibuat."}


@app.get("/api/users")
def get_all_users(
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    if current_user.role == "TEKNISI":
        raise HTTPException(status_code=403, detail="Akses ditolak.")

    query = db.query(models.Pengguna)
    if current_user.role == "ADMIN_WILAYAH":
        query = query.filter(
            models.Pengguna.id_lokasi == current_user.id_lokasi,
            models.Pengguna.role.in_(["ADMIN_WILAYAH", "TEKNISI"]),
        )

    users = query.order_by(models.Pengguna.role, models.Pengguna.username).all()

    # "Online" means an open WebSocket right now — not a recent last_seen, which
    # would keep showing people as present long after they closed the tab.
    online = manager.online_usernames()
    lokasi_names = {
        l.id_lokasi: l.nama_lokasi for l in db.query(models.Lokasi).all()
    }

    result = []
    for u in users:
        pres = manager.presence_of(u.username)
        result.append(
            {
                "id_pengguna": u.id_pengguna,
                "username": u.username,
                "role": u.role,
                "id_lokasi": u.id_lokasi,
                "nama_lokasi": lokasi_names.get(u.id_lokasi) or u.id_lokasi,
                "online": u.username in online,
                "last_seen": u.last_seen.strftime("%Y-%m-%d %H:%M:%S")
                if u.last_seen
                else None,
                # Live view wins over the persisted one: the column is only a
                # fallback for someone who is currently offline.
                "last_view": pres.get("view") or u.last_view,
                "aktif_sejak": pres.get("since").strftime("%Y-%m-%d %H:%M:%S")
                if pres.get("since")
                else None,
            }
        )
    return result


@app.put("/api/users/{user_id}")
def update_user(
    user_id: int,
    data: UserUpdate,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    if current_user.role == "TEKNISI":
        raise HTTPException(status_code=403, detail="Akses ditolak.")

    target = db.query(models.Pengguna).filter_by(id_pengguna=user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User tidak ditemukan.")

    if current_user.role == "ADMIN_WILAYAH":
        if target.id_lokasi != current_user.id_lokasi:
            raise HTTPException(
                status_code=403, detail="Hanya bisa mengedit user di region Anda."
            )
        data.id_lokasi = current_user.id_lokasi

    if current_user.id_pengguna == target.id_pengguna:
        raise HTTPException(
            status_code=400, detail="Tidak bisa mengedit akun sendiri dari menu ini."
        )

    target.role = data.role
    target.id_lokasi = data.id_lokasi
    db.commit()
    return {"message": "User berhasil diperbarui."}


@app.delete("/api/users/{user_id}")
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    if current_user.role == "TEKNISI":
        raise HTTPException(status_code=403, detail="Akses ditolak.")
    target = db.query(models.Pengguna).filter_by(id_pengguna=user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User tidak ditemukan.")
    if current_user.id_pengguna == target.id_pengguna:
        raise HTTPException(
            status_code=400, detail="Tidak bisa menghapus akun sendiri dari sini."
        )

    db.delete(target)
    db.commit()
    return {"message": "User berhasil dihapus."}


@app.delete("/api/users/me")
def delete_own_account(
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    db.delete(current_user)
    db.commit()
    return {"message": "Akun berhasil dihapus."}


# ==================================================================
# ── WEBSOCKET ─────────────────────────────────────────────────────
# ==================================================================


def _username_from_token(token: Optional[str]) -> Optional[str]:
    """Decode a JWT for the WebSocket handshake. Returns None if unusable."""
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload.get("sub")
    except jwt.PyJWTError:
        return None


def _touch_last_seen(username: Optional[str], view: Optional[str] = None):
    """Stamp presence on the user row using a short-lived standalone session."""
    if not username:
        return
    db = SessionLocal()
    try:
        user = db.query(models.Pengguna).filter_by(username=username).first()
        if user:
            user.last_seen = datetime.now()
            if view:
                user.last_view = view
            db.commit()
    except Exception:
        db.rollback()
    finally:
        db.close()


# Last time each user's row was actually written. The heartbeat fires every 30s
# per open tab, and `last_seen` is only ever read to render "online N minutes
# ago" — so writing it that often was pure load for no visible difference.
_LAST_STAMP: dict = {}
_STAMP_INTERVAL_SECONDS = 60


async def _touch_last_seen_async(username: Optional[str], view: Optional[str] = None):
    """
    Presence stamp, off the event loop and throttled.

    `_touch_last_seen` is blocking psycopg2, and every caller of it lives inside
    the `async` WebSocket handler — so a connect, SELECT, UPDATE and COMMIT ran
    on the event loop, stalling every other request and socket on the worker. It
    also opened its own session outside `get_db()`, competing for the same pool;
    when that pool was exhausted the loop froze for the full pool timeout.

    A view change always writes (it is a real state change the Pengguna list
    shows); a bare heartbeat writes at most once a minute.
    """
    if not username:
        return
    now = datetime.now()
    if view is None:
        last = _LAST_STAMP.get(username)
        if last and (now - last).total_seconds() < _STAMP_INTERVAL_SECONDS:
            return
    _LAST_STAMP[username] = now
    await asyncio.to_thread(_touch_last_seen, username, view)


@app.websocket("/ws/updates")
async def websocket_endpoint(websocket: WebSocket, token: Optional[str] = None):
    """
    Live-update channel, now identity-aware.

    The token arrives as a query param because the browser WebSocket API cannot
    set an Authorization header. It is optional: an anonymous socket still gets
    broadcasts (so nothing regresses), it simply doesn't register presence.

    Client → server messages:
      "ping"        → "pong"  (heartbeat)
      "view:<name>" → records which screen the user is on
    """
    username = _username_from_token(token)
    await manager.connect(websocket, username)
    if username:
        await _touch_last_seen_async(username)
        await manager.broadcast("REFRESH_PRESENCE")
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
                # The heartbeat doubles as the liveness stamp — throttled, so a
                # room full of open tabs is not a room full of UPDATEs.
                await _touch_last_seen_async(username)
            elif data.startswith("view:") and username:
                view = data.split(":", 1)[1][:50] or None
                await manager.set_view(username, view)
                await _touch_last_seen_async(username, view)
                await manager.broadcast("REFRESH_PRESENCE")
    except WebSocketDisconnect:
        await manager.disconnect(websocket, username)
        if username:
            # Force the final stamp past the throttle: this is the timestamp
            # "terakhir aktif" will show from now on.
            _LAST_STAMP.pop(username, None)
            await _touch_last_seen_async(username)
            await manager.broadcast("REFRESH_PRESENCE")
    except Exception:
        # Never let a malformed frame leak a socket from the registry.
        await manager.disconnect(websocket, username)


# ==================================================================
# ── MASTER DATA ENDPOINTS ─────────────────────────────────────────
# ==================================================================


@app.get("/api/master/alat")
def get_master_alat(db: Session = Depends(get_db)):
    return db.query(models.KategoriAlat).all()


@app.post("/api/master/alat", dependencies=[Depends(require_role(["SUPER_ADMIN"]))])
def create_master_alat(data: MasterAlatCreate, db: Session = Depends(get_db)):
    if db.query(models.KategoriAlat).filter_by(kode_alat=data.kode_alat).first():
        raise HTTPException(status_code=400, detail="Kode alat sudah ada.")
    db.add(models.KategoriAlat(kode_alat=data.kode_alat, nama_alat=data.nama_alat))
    db.commit()
    return {"message": "Alat berhasil ditambahkan."}


@app.put(
    "/api/master/alat/{kode}", dependencies=[Depends(require_role(["SUPER_ADMIN"]))]
)
def update_master_alat(
    kode: str, data: MasterAlatCreate, db: Session = Depends(get_db)
):
    item = db.query(models.KategoriAlat).filter_by(kode_alat=kode).first()
    if not item:
        raise HTTPException(status_code=404, detail="Kode alat tidak ditemukan.")
    item.nama_alat = data.nama_alat
    db.commit()
    return {"message": "Alat diperbarui."}


@app.delete(
    "/api/master/alat/{kode}", dependencies=[Depends(require_role(["SUPER_ADMIN"]))]
)
def delete_master_alat(kode: str, db: Session = Depends(get_db)):
    item = db.query(models.KategoriAlat).filter_by(kode_alat=kode).first()
    if not item:
        raise HTTPException(status_code=404, detail="Kode alat tidak ditemukan.")
    db.delete(item)
    db.commit()
    return {"message": "Alat dihapus."}


@app.get("/api/master/lokasi")
def get_master_lokasi(tipe: List[str] = Query(None), db: Session = Depends(get_db)):
    query = db.query(models.Lokasi)
    if tipe:
        # Exact match for known types, case-insensitive
        valid_types = {"PUSAT", "DAOP", "DIVRE", "BALAIYASA", "UPT"}
        filtered_types = [t.upper() for t in tipe if t.upper() in valid_types]
        if filtered_types:
            query = query.filter(models.Lokasi.tipe.in_(filtered_types))
    # return query.order_by(models.Lokasi.tipe, models.Lokasi.nama_lokasi).all()
    return query.all()


@app.post("/api/master/lokasi", dependencies=[Depends(require_role(["SUPER_ADMIN"]))])
def create_master_lokasi(data: LokasiCreate, db: Session = Depends(get_db)):
    if db.query(models.Lokasi).filter_by(id_lokasi=data.id_lokasi).first():
        raise HTTPException(status_code=400, detail="ID Lokasi sudah ada.")
    if (
        db.query(models.Lokasi)
        .filter(models.Lokasi.nama_lokasi.ilike(data.nama_lokasi))
        .first()
    ):
        raise HTTPException(status_code=400, detail="Nama lokasi sudah digunakan.")
    db.add(
        models.Lokasi(
            id_lokasi=data.id_lokasi, nama_lokasi=data.nama_lokasi, tipe=data.tipe
        )
    )
    db.commit()
    return {"message": "Lokasi berhasil ditambahkan."}


@app.put(
    "/api/master/lokasi/{kode}", dependencies=[Depends(require_role(["SUPER_ADMIN"]))]
)
def update_master_lokasi(kode: str, data: LokasiCreate, db: Session = Depends(get_db)):
    item = db.query(models.Lokasi).filter_by(id_lokasi=kode).first()
    if not item:
        raise HTTPException(status_code=404, detail="Lokasi tidak ditemukan.")
    item.nama_lokasi = data.nama_lokasi
    item.tipe = data.tipe
    db.commit()
    return {"message": "Lokasi diperbarui."}


@app.delete(
    "/api/master/lokasi/{kode}", dependencies=[Depends(require_role(["SUPER_ADMIN"]))]
)
def delete_master_lokasi(kode: str, db: Session = Depends(get_db)):
    item = db.query(models.Lokasi).filter_by(id_lokasi=kode).first()
    if not item:
        raise HTTPException(status_code=404, detail="Lokasi tidak ditemukan.")
    db.delete(item)
    db.commit()
    return {"message": "Lokasi dihapus."}


@app.get("/api/master/upt")
def get_master_upt(db: Session = Depends(get_db)):
    # Fallback/Legacy jika UI masih memanggil endpoint ini
    return db.query(models.Lokasi).filter_by(tipe="UPT").all()


# ==================================================================
# ── TRANSAKSIONAL ASET & RIWAYAT ──────────────────────────────────
# ==================================================================


@app.post("/api/aset")
async def create_aset(
    aset_in: AsetCreate,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(
        require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"])
    ),
):
    # An ADMIN_WILAYAH may only create assets inside its own region. Both the
    # storage location and the parent stamped into the ID are checked, so a
    # region cannot be laundered by sending a home UPT it does not own.
    assert_region_scope(
        db, current_user, aset_in.id_lokasi,
        "Hanya bisa menambah aset di wilayah Anda.",
    )
    assert_region_scope(
        db, current_user, aset_in.parent_lokasi,
        "Hanya bisa menambah aset di wilayah Anda.",
    )

    peruntukan_norm, kode_peruntukan = normalise_peruntukan(aset_in.peruntukan)
    sumber_norm, id_pengadaan = normalise_sumber_pengadaan(aset_in.sumber_pengadaan)

    # 1. Hitung urutan (Sequence) berdasarkan kode_alat
    #
    # Derived from the highest sequence number in use, NOT from a row count.
    # With count+1, deleting any asset of this type made the next create reuse a
    # number that still belonged to a live asset, and the collision check below
    # then rejected it — permanently, since retrying recomputed the same count.
    urutan_terpakai = [
        int(row[0].split(".")[0])
        for row in db.query(models.Aset.id_aset)
        .filter(models.Aset.kode_alat == aset_in.kode_alat)
        .all()
        if row[0].split(".")[0].isdigit()
    ]
    nomor_urut = (max(urutan_terpakai) + 1) if urutan_terpakai else 1

    # 2. Format komponen ID
    tahun = aset_in.tanggal_pembelian.year
    year_str = str(tahun)[-2:] if tahun >= 2000 else str(tahun)

    # 3. Rakit Final ID Aset
    # Format: nomor_urut.kode_alat.id_pengadaan.tahun.unit.parent_lokasi
    # Contoh: 6.RGM.1.24.A.D1
    generated_id_aset = f"{nomor_urut}.{aset_in.kode_alat}.{id_pengadaan}.{year_str}.{kode_peruntukan}.{aset_in.parent_lokasi}"

    # Pastikan tidak ada duplikasi akibat bentrok (meskipun sangat kecil kemungkinannya)
    if db.query(models.Aset).filter_by(id_aset=generated_id_aset).first():
        raise HTTPException(
            status_code=400, detail="Terjadi konflik ID. Silakan coba lagi."
        )

    # 4. Simpan ke database
    db_aset = models.Aset(
        id_aset=generated_id_aset,
        kode_alat=aset_in.kode_alat,
        id_lokasi=aset_in.id_lokasi,  # Disimpan dengan kode UPT asli (e.g. JR1.1)
        tanggal_pembelian=aset_in.tanggal_pembelian,
        sumber_pengadaan=sumber_norm,
        status_terakhir="SO",
        peruntukan=peruntukan_norm,
        id_varian=aset_in.id_varian,
        nomor_seri=(aset_in.nomor_seri or "").strip() or None,
    )
    db.add(db_aset)

    # Inisiasi Riwayat Awal (Sesuai perbaikan arsitektur sebelumnya)
    # id_lokasi/peruntukan are set here for parity with seed.py — without them
    # every dashboard query has to COALESCE back to the asset to place the row.
    inisiasi_riwayat = models.RiwayatKondisi(
        id_aset=generated_id_aset,
        id_pengguna=current_user.id_pengguna,
        kondisi="SO",
        keterangan="Aset Baru",
        id_lokasi=aset_in.id_lokasi,
        peruntukan=peruntukan_norm,
    )
    db.add(inisiasi_riwayat)

    db.commit()
    await manager.broadcast("REFRESH_ASSET_LIST")

    return {"message": "Aset berhasil ditambahkan", "id_aset": db_aset.id_aset}


@app.get("/api/aset")
def get_all_aset(
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    asets = (
        db.query(models.Aset)
        .options(
            joinedload(models.Aset.kategori),
            joinedload(models.Aset.lokasi_ref),
            # Spesifikasi teknis. Eager-loaded so surfacing it on the asset cards
            # costs no extra query per row.
            joinedload(models.Aset.varian_ref),
        )
        # Raw comparison, not func.upper(): _ensure_schema() normalises the
        # column on boot, and wrapping it in a function makes both indexes on it
        # unusable — this filter was a sequential scan of `aset`.
        .filter(models.Aset.status_terakhir != "AFKIR")
        .all()
    )

    return [
        {
            "id_aset": a.id_aset,
            "kode_alat": a.kode_alat,
            "kode_alat_name": a.kategori.nama_alat if a.kategori else a.kode_alat,
            "id_lokasi": a.id_lokasi,
            "lokasi_name": a.lokasi_ref.nama_lokasi if a.lokasi_ref else a.id_lokasi,
            "peruntukan": a.peruntukan,
            "status_terakhir": a.status_terakhir,
            "sumber_pengadaan": a.sumber_pengadaan,
            "tanggal_pembelian": str(a.tanggal_pembelian)
            if a.tanggal_pembelian
            else None,
            "id_varian": a.id_varian,
            "nama_varian": a.varian_ref.nama_varian if a.varian_ref else None,
            "nomor_seri": a.nomor_seri,
            # The owning DAOP/DIVRE code. Derived here so the client's search
            # index, its card labels and its region filters all agree on one
            # value instead of each re-deriving it from a different field.
            "parent_lokasi": get_parent_lokasi_code(a.id_lokasi) or a.id_lokasi,
        }
        for a in asets
    ]


@app.get("/api/aset/afkir", dependencies=[Depends(require_role(["SUPER_ADMIN"]))])
def get_afkir_aset(db: Session = Depends(get_db)):
    asets = (
        db.query(models.Aset)
        .options(joinedload(models.Aset.kategori), joinedload(models.Aset.lokasi_ref))
        .filter(models.Aset.status_terakhir == "AFKIR")
        .all()
    )
    afkir_ids = [a.id_aset for a in asets]

    # Recorded activity per scrapped asset. /api/history/summary deliberately
    # excludes AFKIR rows, so the afkir screen had no counts to sort by at all
    # and its "Terbanyak / Tersedikit" buttons could never do anything. Two
    # grouped queries for the whole list, not two per asset.
    repair_counts: dict = {}
    mutasi_counts: dict = {}
    if afkir_ids:
        repair_counts = {
            r[0]: int(r[1] or 0)
            for r in db.query(models.RiwayatKondisi.id_aset, func.count())
            .filter(
                models.RiwayatKondisi.id_aset.in_(afkir_ids),
                # TSO only — an SO row closes a repair, so counting both would
                # double-count every completed job.
                models.RiwayatKondisi.kondisi == "TSO",
            )
            .group_by(models.RiwayatKondisi.id_aset)
            .all()
        }
        mutasi_counts = {
            r[0]: int(r[1] or 0)
            for r in db.query(models.RiwayatMutasi.id_aset, func.count())
            .filter(models.RiwayatMutasi.id_aset.in_(afkir_ids))
            .group_by(models.RiwayatMutasi.id_aset)
            .all()
        }

    # Same field contract as GET /api/aset: id_lokasi and kode_alat are CODES,
    # with the human-readable names in the *_name fields. The frontend filters
    # and lokasi/UPT lookups all key off the codes.
    return [
        {
            "id_aset": a.id_aset,
            "kode_alat": a.kode_alat,
            "kode_alat_name": a.kategori.nama_alat if a.kategori else a.kode_alat,
            "id_lokasi": a.id_lokasi,
            "lokasi_name": a.lokasi_ref.nama_lokasi if a.lokasi_ref else a.id_lokasi,
            "peruntukan": a.peruntukan,
            "sumber_pengadaan": a.sumber_pengadaan,
            "status_terakhir": a.status_terakhir,
            "tanggal_pembelian": str(a.tanggal_pembelian)
            if a.tanggal_pembelian
            else None,
            "waktu_update": a.waktu_update.strftime("%Y-%m-%d %H:%M:%S")
            if a.waktu_update
            else None,
            "repair_count": repair_counts.get(a.id_aset, 0),
            "mutasi_count": mutasi_counts.get(a.id_aset, 0),
        }
        for a in asets
    ]


@app.post("/api/aset/afkir/{id_aset}")
async def afkir_aset(
    id_aset: str,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(
        require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"])
    ),
):
    aset = db.query(models.Aset).filter_by(id_aset=id_aset).first()
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")
    aset.status_terakhir = "AFKIR"
    # Record the transition — without a riwayat row the afkir is invisible to
    # every history/export/dashboard query.
    db.add(
        models.RiwayatKondisi(
            id_aset=id_aset,
            id_pengguna=current_user.id_pengguna,
            kondisi="AFKIR",
            keterangan="Aset di-afkir",
            id_lokasi=aset.id_lokasi,
            peruntukan=aset.peruntukan,
        )
    )
    db.commit()
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Aset berhasil di-afkir."}


@app.post("/api/aset/pulihkan/{id_aset}")
async def pulihkan_aset(
    id_aset: str,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(require_role(["SUPER_ADMIN"])),
):
    aset = db.query(models.Aset).filter_by(id_aset=id_aset).first()
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")
    if aset.status_terakhir != "AFKIR":
        raise HTTPException(
            status_code=400, detail="Aset ini tidak dalam status AFKIR."
        )
    aset.status_terakhir = "SO"
    # Record the recovery, mirroring afkir_aset — an AFKIR→SO transition with no
    # riwayat row leaves a hole in the asset's timeline.
    db.add(
        models.RiwayatKondisi(
            id_aset=id_aset,
            id_pengguna=current_user.id_pengguna,
            kondisi="SO",
            keterangan="Aset dipulihkan dari afkir",
            id_lokasi=aset.id_lokasi,
            peruntukan=aset.peruntukan,
        )
    )
    db.commit()
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": f"Aset {id_aset} berhasil dipulihkan."}


@app.post("/api/perbaikan")
@app.post("/api/riwayat-kondisi")
async def catat_perbaikan(
    laporan: PerbaikanCreate,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    aset = db.query(models.Aset).filter_by(id_aset=laporan.id_aset).first()
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")

    # A condition report rewrites `aset.status_terakhir`, so it is a mutation and
    # falls under the same regional limit as editing or transferring. TEKNISI is
    # deliberately unscoped here — condition reporting is its whole job, and it
    # files against whichever asset it has physically been sent to.
    assert_aset_region_scope(
        db, current_user, aset,
        "Hanya bisa melaporkan kondisi aset dari wilayah Anda.",
    )

    # # NORMALISASI INPUT PERUNTUKAN DI SINI
    # if laporan.peruntukan:
    #     p_val = laporan.peruntukan.strip().upper()
    #     # Pemetaan ketat jika frontend mengirimkan A, B, C, D alih-alih teks penuh
    #     peruntukan_map = {
    #         "a": "JALAN REL",
    #         "b": "JEMBATAN",
    #         "c": "MEKANIK",
    #         "d": "BALAIYASA",
    #     }
    #     # Gunakan mapping, atau gunakan nilai aslinya jika sudah berupa teks penuh
    #     aset.peruntukan = peruntukan_map.get(p_val, p_val)

    # Normalise peruntukan for per-row storage (accepts A/B/C/D or full text)
    peruntukan_row = None
    if laporan.peruntukan:
        p_val = laporan.peruntukan.strip().upper()
        peruntukan_map_row = {
            "A": "JALAN REL", "B": "JEMBATAN", "C": "MEKANIK", "D": "BALAIYASA",
            "JALAN REL": "JALAN REL", "JEMBATAN": "JEMBATAN", "MEKANIK": "MEKANIK", "BALAIYASA": "BALAIYASA"
        }
        peruntukan_row = peruntukan_map_row.get(p_val, laporan.peruntukan.upper())

    # Resolve lokasi: prefer the sent id_lokasi, fall back to aset's current lokasi
    id_lokasi_row = laporan.id_lokasi or aset.id_lokasi

    # A repair carried out at a Balaiyasa still belongs to the region that owns
    # the asset. Stamping the workshop here is what used to make Laporan
    # Perbaikan grow a "BALAIYASA …" row and under-count every DAOP's completed
    # repairs, since the closing row fell outside the DAOP's lokasi scope.
    if id_lokasi_row and id_lokasi_row in balaiyasa_lokasi_ids(db):
        id_lokasi_row = resolve_home_lokasi(db, aset) or id_lokasi_row

    db.add(
        models.RiwayatKondisi(
            id_aset=laporan.id_aset,
            id_pengguna=current_user.id_pengguna,
            kondisi=laporan.kondisi,
            keterangan=laporan.keterangan,
            id_lokasi=id_lokasi_row,
            peruntukan=peruntukan_row,
        )
    )
    aset.status_terakhir = laporan.kondisi
    db.commit()
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Laporan kondisi berhasil dicatat."}


@app.post("/api/mutasi")
async def submit_mutasi(
    mutasi: MutasiCreate,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(
        require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"])
    ),
):
    aset = (
        db.query(models.Aset)
        .filter(
            models.Aset.id_aset == mutasi.id_aset,
            models.Aset.status_terakhir != "AFKIR",
        )
        .first()
    )
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")

    if aset.id_lokasi == mutasi.id_lokasi_tujuan:
        raise HTTPException(status_code=400, detail="Lokasi tujuan sama dengan asal.")

    assert_aset_region_scope(
        db, current_user, aset,
        "Hanya bisa memindahkan aset dari wilayah sendiri.",
    )

    db.add(
        models.RiwayatMutasi(
            id_aset=mutasi.id_aset,
            id_lokasi_asal=aset.id_lokasi,
            id_lokasi_tujuan=mutasi.id_lokasi_tujuan,
            id_pengguna=current_user.id_pengguna,
            alasan_mutasi=mutasi.alasan_mutasi,
        )
    )

    db.query(models.Aset).filter(models.Aset.id_aset == mutasi.id_aset).update(
        {"id_lokasi": mutasi.id_lokasi_tujuan}, synchronize_session=False
    )

    db.commit()
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Aset berhasil dimutasi."}


# ==================================================================
# ── DATA HISTORY & SUMMARY ────────────────────────────────────────
# ==================================================================


@app.get("/api/riwayat-kondisi/{id_aset}")
def get_riwayat_aset(
    id_aset: str,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    riwayat = (
        db.query(models.RiwayatKondisi)
        # The row loop reads pengguna_ref.username and lokasi_ref.nama_lokasi;
        # without these that was two queries per history row on a screen users
        # open constantly.
        .options(
            joinedload(models.RiwayatKondisi.pengguna_ref),
            joinedload(models.RiwayatKondisi.lokasi_ref),
        )
        .filter(
            models.RiwayatKondisi.id_aset == id_aset,
            models.RiwayatKondisi.kondisi != "KALIBRASI",
        )
        .order_by(models.RiwayatKondisi.waktu_lapor.asc())
        .all()
    )
    
    return [
        {
            "no": i,
            "waktu_lapor": r.waktu_lapor.strftime("%Y-%m-%d %H:%M:%S")
            if r.waktu_lapor
            else None,
            "id_pengguna": r.pengguna_ref.username if r.pengguna_ref else r.id_pengguna,
            "kondisi": r.kondisi,
            "keterangan": r.keterangan or "—",
            "id_lokasi": r.id_lokasi or "",
            "nama_lokasi": r.lokasi_ref.nama_lokasi if r.lokasi_ref else (r.id_lokasi or "—"),
            "peruntukan": r.peruntukan or "",
        }
        for i, r in enumerate(riwayat, start=1)
    ]


@app.post("/api/kalibrasi")
async def create_kalibrasi(
    data: KalibrasiCreate,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    aset = db.query(models.Aset).filter_by(id_aset=data.id_aset).first()
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")

    assert_aset_region_scope(
        db, current_user, aset,
        "Hanya bisa mencatat kalibrasi aset dari wilayah Anda.",
    )

    if data.status not in {"LULUS", "GAGAL", "BERSYARAT"}:
        raise HTTPException(status_code=400, detail="Status kalibrasi tidak valid.")

    tanggal_berlaku = data.tanggal_berlaku or data.tanggal_kalibrasi

    record = models.RiwayatKalibrasi(
        id_aset=data.id_aset,
        id_pengguna=current_user.id_pengguna,
        tanggal_kalibrasi=data.tanggal_kalibrasi,
        tanggal_berlaku=tanggal_berlaku,
        status=data.status,
        pelaksana_kalibrasi=data.pelaksana_kalibrasi,
        nomor_sertifikat=data.nomor_sertifikat,
        keterangan=data.keterangan,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Laporan kalibrasi berhasil disimpan.", "id_kalibrasi": record.id_kalibrasi}


# ── Calibration certificate upload ─────────────────────────────────
# Kept as a separate "attach" step rather than folding multipart into
# POST /api/kalibrasi, so the existing JSON contract stays intact: the client
# creates the record, then uploads the file against the returned id.

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
SERTIFIKAT_DIR = os.path.join(UPLOAD_DIR, "sertifikat")
ALLOWED_CERT_EXT = {".pdf", ".png", ".jpg", ".jpeg", ".webp"}
MAX_CERT_BYTES = 10 * 1024 * 1024  # 10 MB

os.makedirs(SERTIFIKAT_DIR, exist_ok=True)


def _save_certificate(upload: UploadFile, id_kalibrasi: int) -> str:
    """
    Persist an uploaded certificate and return the stored filename.

    The client-supplied name is used ONLY to read the extension — the stored
    name is generated from the record id plus a random token, so a hostile
    filename can never influence the path written to disk.
    """
    ext = os.path.splitext(upload.filename or "")[1].lower()
    if ext not in ALLOWED_CERT_EXT:
        raise HTTPException(
            status_code=400,
            detail=f"Format tidak didukung. Gunakan: {', '.join(sorted(ALLOWED_CERT_EXT))}.",
        )

    upload.file.seek(0, os.SEEK_END)
    size = upload.file.tell()
    upload.file.seek(0)
    if size == 0:
        raise HTTPException(status_code=400, detail="Berkas kosong.")
    if size > MAX_CERT_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"Berkas terlalu besar (maks {MAX_CERT_BYTES // (1024 * 1024)} MB).",
        )

    stored = f"kalibrasi_{id_kalibrasi}_{secrets.token_hex(8)}{ext}"
    dest = os.path.join(SERTIFIKAT_DIR, stored)
    with open(dest, "wb") as fh:
        shutil.copyfileobj(upload.file, fh)
    return stored


@app.post("/api/kalibrasi/{id_kalibrasi}/sertifikat")
async def upload_sertifikat_kalibrasi(
    id_kalibrasi: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    record = (
        db.query(models.RiwayatKalibrasi).filter_by(id_kalibrasi=id_kalibrasi).first()
    )
    if not record:
        raise HTTPException(status_code=404, detail="Data kalibrasi tidak ditemukan.")

    # Off the event loop: this writes up to MAX_CERT_BYTES (10 MB) synchronously,
    # and the handler is `async`, so on a slow or network-mounted disk it froze
    # the whole worker for the duration of the write.
    stored = await asyncio.to_thread(_save_certificate, file, id_kalibrasi)

    # Replacing an existing certificate — drop the old file so uploads don't pile up.
    if record.file_sertifikat:
        old = os.path.join(SERTIFIKAT_DIR, os.path.basename(record.file_sertifikat))
        if os.path.isfile(old):
            try:
                os.remove(old)
            except OSError:
                pass

    record.file_sertifikat = stored
    db.commit()
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Sertifikat berhasil diunggah.", "file_sertifikat": stored}


@app.get("/api/kalibrasi/sertifikat/{nama_file}")
def download_sertifikat(
    nama_file: str,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    Serve a stored certificate. Authenticated, and deliberately NOT routed
    through the public static handler — certificates are not public assets.
    """
    # basename() strips any traversal attempt before it reaches the filesystem.
    safe = os.path.basename(nama_file)
    if os.path.splitext(safe)[1].lower() not in ALLOWED_CERT_EXT:
        raise HTTPException(status_code=400, detail="Jenis berkas tidak diizinkan.")

    path = os.path.join(SERTIFIKAT_DIR, safe)
    # Belt and braces: confirm the resolved path really is inside the upload dir.
    if not os.path.realpath(path).startswith(os.path.realpath(SERTIFIKAT_DIR)):
        raise HTTPException(status_code=400, detail="Path tidak valid.")
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Sertifikat tidak ditemukan.")
    return FileResponse(path, filename=safe)


@app.delete("/api/kalibrasi/{id_kalibrasi}/sertifikat")
async def delete_sertifikat_kalibrasi(
    id_kalibrasi: int,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(
        require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"])
    ),
):
    record = (
        db.query(models.RiwayatKalibrasi).filter_by(id_kalibrasi=id_kalibrasi).first()
    )
    if not record:
        raise HTTPException(status_code=404, detail="Data kalibrasi tidak ditemukan.")
    if record.file_sertifikat:
        path = os.path.join(SERTIFIKAT_DIR, os.path.basename(record.file_sertifikat))
        if os.path.isfile(path):
            try:
                os.remove(path)
            except OSError:
                pass
        record.file_sertifikat = None
        db.commit()
    return {"message": "Sertifikat dihapus."}


@app.get("/api/kalibrasi/{id_aset}")
def get_kalibrasi_by_aset(
    id_aset: str,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    riwayat = (
        db.query(models.RiwayatKalibrasi)
        .filter(models.RiwayatKalibrasi.id_aset == id_aset)
        .order_by(models.RiwayatKalibrasi.tanggal_kalibrasi.asc(), models.RiwayatKalibrasi.waktu_input.asc())
        .all()
    )

    pengguna_ids = {r.id_pengguna for r in riwayat if r.id_pengguna}
    pengguna_map = {
        p.id_pengguna: p.username
        for p in db.query(models.Pengguna).filter(models.Pengguna.id_pengguna.in_(pengguna_ids)).all()
    }

    return [
        {
            "no": i,
            "id_kalibrasi": r.id_kalibrasi,
            "tanggal_kalibrasi": str(r.tanggal_kalibrasi) if r.tanggal_kalibrasi else None,
            "tanggal_berlaku": str(r.tanggal_berlaku) if r.tanggal_berlaku else None,
            "status": r.status,
            "pelaksana_kalibrasi": r.pelaksana_kalibrasi or "—",
            "nomor_sertifikat": r.nomor_sertifikat or "—",
            "keterangan": r.keterangan or "—",
            "file_sertifikat": r.file_sertifikat,
            "waktu_input": r.waktu_input.strftime("%Y-%m-%d %H:%M:%S") if r.waktu_input else None,
            "id_pengguna": pengguna_map.get(r.id_pengguna, str(r.id_pengguna) if r.id_pengguna else "—"),
        }
        for i, r in enumerate(riwayat, start=1)
    ]


@app.get("/api/mutasi/{id_aset}")
def get_mutasi_by_aset(
    id_aset: str,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    mutasi = (
        db.query(models.RiwayatMutasi)
        # The row loop reads all three of these; without eager loading it was
        # three queries per mutation row.
        .options(
            joinedload(models.RiwayatMutasi.lokasi_asal),
            joinedload(models.RiwayatMutasi.lokasi_tujuan),
            joinedload(models.RiwayatMutasi.pengguna_ref),
        )
        .filter_by(id_aset=id_aset)
        .order_by(models.RiwayatMutasi.waktu_mutasi.asc())
        .all()
    )

    aset = db.query(models.Aset).filter_by(id_aset=id_aset).first()
    # original_lokasi should be the parent region code, not UPT code
    # For mutations, use the asal lokasi; for no mutations, use asset's current parent
    if mutasi:
        original_lokasi = mutasi[0].id_lokasi_asal
    elif aset:
        # Try to get parent from UPT code, fallback to asset's lokasi
        # This requires a helper or we just send the code and let frontend resolve
        original_lokasi = aset.id_lokasi
    else:
        original_lokasi = "—"

    results = []
    for m in mutasi:
        results.append(
            {
                "id_lokasi_asal": m.id_lokasi_asal,
                "id_lokasi_asal_name": m.lokasi_asal.nama_lokasi
                if m.lokasi_asal
                else m.id_lokasi_asal,
                "id_lokasi_tujuan": m.id_lokasi_tujuan,
                "id_lokasi_tujuan_name": m.lokasi_tujuan.nama_lokasi
                if m.lokasi_tujuan
                else m.id_lokasi_tujuan,
                "waktu_mutasi": m.waktu_mutasi.strftime("%Y-%m-%d %H:%M:%S")
                if m.waktu_mutasi
                else None,
                "nama_petugas": m.pengguna_ref.username
                if m.pengguna_ref
                else (str(m.id_pengguna) if m.id_pengguna else "—"),
                "alasan_mutasi": m.alasan_mutasi or "—",
            }
        )
        
    original_lokasi_obj = (
        db.query(models.Lokasi).filter_by(id_lokasi=original_lokasi).first()
        if original_lokasi and original_lokasi != "—"
        else None
    )
    return {
        "mutasi": results,
        "original_lokasi": original_lokasi,
        "original_lokasi_name": original_lokasi_obj.nama_lokasi if original_lokasi_obj else original_lokasi,
        "sudah_kembali": aset.id_lokasi == original_lokasi if aset else False,
        "lokasi_sekarang": aset.id_lokasi if aset else "—",
        "lokasi_sekarang_name": aset.lokasi_ref.nama_lokasi
        if aset and aset.lokasi_ref
        else "—",
    }


@app.get("/api/history/summary")
def get_history_summary(
    id_aset: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    Per-asset rollup of repair / calibration / mutation history.

    `id_aset` narrows the response to a single asset. The QR landing page needs
    exactly one row, and without this parameter it downloaded the entire fleet
    summary — 98.6 KB at 200 assets, megabytes at scale — and then `.find()`-ed
    one entry out of it, four times per page view, on a phone in the field.

    The shape is unchanged either way: still a list, so callers that filter it
    themselves keep working.
    """
    from sqlalchemy.orm import joinedload
    from sqlalchemy import func

    # Batch load all assets with their relationships
    q = (
        db.query(models.Aset)
        .options(joinedload(models.Aset.kategori), joinedload(models.Aset.lokasi_ref))
        .filter(models.Aset.status_terakhir != "AFKIR")
    )
    if id_aset:
        q = q.filter(models.Aset.id_aset == id_aset)
    asets = q.all()

    if not asets:
        return []

    aset_ids = [a.id_aset for a in asets]

    # Batch load latest repair per asset using window function approach
    latest_repair_subq = (
        db.query(
            models.RiwayatKondisi.id_aset,
            models.RiwayatKondisi.kondisi,
            models.RiwayatKondisi.keterangan,
            models.RiwayatKondisi.waktu_lapor,
            models.RiwayatKondisi.id_pengguna,
            models.RiwayatKondisi.id_lokasi,
            func.row_number()
            .over(
                partition_by=models.RiwayatKondisi.id_aset,
                order_by=models.RiwayatKondisi.waktu_lapor.desc(),
            )
            .label("rn"),
        )
        .filter(models.RiwayatKondisi.id_aset.in_(aset_ids))
        .subquery()
    )

    latest_repairs = (
        db.query(latest_repair_subq).filter(latest_repair_subq.c.rn == 1).all()
    )
    repair_map = {r.id_aset: r for r in latest_repairs}

    # How many repair events each asset has had. The frontend's "urutkan by
    # jumlah perbaikan" had nothing to sort on: the summary carries one row per
    # asset, so counting rows client-side always returned 1. Only TSO rows count
    # — an SO row is a repair being CLOSED, and counting both double-counts every
    # completed job.
    repair_count_map = {
        r[0]: int(r[1] or 0)
        for r in db.query(
            models.RiwayatKondisi.id_aset, func.count()
        )
        .filter(
            models.RiwayatKondisi.id_aset.in_(aset_ids),
            models.RiwayatKondisi.kondisi == "TSO",
        )
        .group_by(models.RiwayatKondisi.id_aset)
        .all()
    }

    # Batch load all mutasi for these assets
    all_mutasi = (
        db.query(models.RiwayatMutasi)
        .options(
            joinedload(models.RiwayatMutasi.lokasi_asal),
            joinedload(models.RiwayatMutasi.lokasi_tujuan),
            joinedload(models.RiwayatMutasi.pengguna_ref),
        )
        .filter(models.RiwayatMutasi.id_aset.in_(aset_ids))
        .order_by(models.RiwayatMutasi.waktu_mutasi.asc())
        .all()
    )

    # Group mutasi by asset
    mutasi_map = {}
    for m in all_mutasi:
        if m.id_aset not in mutasi_map:
            mutasi_map[m.id_aset] = []
        mutasi_map[m.id_aset].append(m)

    # Batch load pengguna for repairs
    pengguna_ids = list(set(r.id_pengguna for r in latest_repairs if r.id_pengguna))
    pengguna_map = {}
    if pengguna_ids:
        penggunas = (
            db.query(models.Pengguna)
            .filter(models.Pengguna.id_pengguna.in_(pengguna_ids))
            .all()
        )
        pengguna_map = {p.id_pengguna: p for p in penggunas}

    # Calibration: scoped to the assets in this response, ordered so the LAST
    # element of each list is the latest.
    #
    # This was `db.query(models.RiwayatKalibrasi).all()` — every calibration row
    # ever written, including for the AFKIR assets excluded 200 lines above,
    # fully hydrated into ORM objects, on every request, just to keep the newest
    # one per asset. It was the only un-batched query in an otherwise carefully
    # batched endpoint.
    kalibrasi_map = {}
    if aset_ids:
        kal_q = (
            db.query(models.RiwayatKalibrasi)
            .filter(models.RiwayatKalibrasi.id_aset.in_(aset_ids))
            .order_by(
                models.RiwayatKalibrasi.id_aset,
                models.RiwayatKalibrasi.tanggal_kalibrasi.asc(),
                models.RiwayatKalibrasi.waktu_input.asc(),
            )
        )
        for kal in kal_q.yield_per(2000):
            kalibrasi_map.setdefault(kal.id_aset, []).append(kal)

    results = []
    for a in asets:
        latest_repair = repair_map.get(a.id_aset)
        all_mutasi_for_a = mutasi_map.get(a.id_aset, [])
        latest_mutasi = all_mutasi_for_a[-1] if all_mutasi_for_a else None
        all_kalibrasi_for_a = kalibrasi_map.get(a.id_aset, [])
        latest_kalibrasi = all_kalibrasi_for_a[-1] if all_kalibrasi_for_a else None

        results.append(
            {
                "id_aset": a.id_aset,
                # Same field contract as GET /api/aset: kode_alat is the CODE and
                # kode_alat_name the display name. This used to return the NAME in
                # `kode_alat`, which made the history sort modal's alat filter (a
                # code-valued dropdown) match nothing at all.
                "kode_alat": a.kode_alat,
                "kode_alat_name": a.kategori.nama_alat if a.kategori else a.kode_alat,
                "id_lokasi": a.id_lokasi,
                "peruntukan": a.peruntukan,
                # Needed by the history sort modal's Pengadaan + Tahun Beli filters,
                # which previously read undefined and silently dropped every row.
                "sumber_pengadaan": a.sumber_pengadaan,
                "tanggal_pembelian": str(a.tanggal_pembelian)
                if a.tanggal_pembelian
                else None,
                "id_lokasi_name": a.lokasi_ref.nama_lokasi
                if a.lokasi_ref
                else a.id_lokasi,
                "status_terakhir": a.status_terakhir,
                "repair": {
                    "count": repair_count_map.get(a.id_aset, 0),
                    "latest_date": latest_repair.waktu_lapor.strftime(
                        "%Y-%m-%d %H:%M:%S"
                    )
                    if latest_repair and latest_repair.waktu_lapor
                    else None,
                    "latest_kondisi": latest_repair.kondisi
                    if latest_repair
                    else a.status_terakhir,
                    "latest_keterangan": latest_repair.keterangan
                    if latest_repair
                    else None,
                    "latest_teknisi": pengguna_map.get(
                        latest_repair.id_pengguna
                    ).username
                    if latest_repair and latest_repair.id_pengguna in pengguna_map
                    else (str(latest_repair.id_pengguna) if latest_repair else None),
                    # app.js reads this to show where the last report was filed;
                    # the column had been commented out of the subquery, so the
                    # field was always undefined on the client.
                    "latest_id_lokasi": latest_repair.id_lokasi
                    if latest_repair
                    else None,
                },
                "has_kalibrasi": bool(all_kalibrasi_for_a),
                "kalibrasi": {
                    "latest_date": latest_kalibrasi.tanggal_kalibrasi.strftime(
                        "%Y-%m-%d"
                    )
                    if latest_kalibrasi and latest_kalibrasi.tanggal_kalibrasi
                    else None,
                    "latest_tanggal_kalibrasi": latest_kalibrasi.tanggal_kalibrasi.strftime(
                        "%Y-%m-%d"
                    )
                    if latest_kalibrasi and latest_kalibrasi.tanggal_kalibrasi
                    else None,
                    "latest_berlaku": latest_kalibrasi.tanggal_berlaku.strftime(
                        "%Y-%m-%d"
                    )
                    if latest_kalibrasi and latest_kalibrasi.tanggal_berlaku
                    else None,
                    "latest_waktu_input": latest_kalibrasi.waktu_input.strftime(
                        "%Y-%m-%d %H:%M:%S"
                    )
                    if latest_kalibrasi and latest_kalibrasi.waktu_input
                    else None,
                    "latest_status": latest_kalibrasi.status if latest_kalibrasi else None,
                    "latest_pelaksana": latest_kalibrasi.pelaksana_kalibrasi
                    if latest_kalibrasi and latest_kalibrasi.pelaksana_kalibrasi
                    else (
                        pengguna_map.get(latest_kalibrasi.id_pengguna).username
                        if latest_kalibrasi and latest_kalibrasi.id_pengguna in pengguna_map
                        else None
                    ),
                    "latest_nomor_sertifikat": latest_kalibrasi.nomor_sertifikat
                    if latest_kalibrasi
                    else None,
                    "latest_keterangan": latest_kalibrasi.keterangan
                    if latest_kalibrasi
                    else None,
                    # Basename of the uploaded certificate, or None. The Riwayat
                    # cards use it to show an attachment indicator without
                    # re-fetching /api/kalibrasi/{id_aset} per card.
                    "latest_id_kalibrasi": latest_kalibrasi.id_kalibrasi
                    if latest_kalibrasi
                    else None,
                    "latest_file_sertifikat": latest_kalibrasi.file_sertifikat
                    if latest_kalibrasi
                    else None,
                }
                if latest_kalibrasi
                else None,
                "mutasi": {
                    "count": len(all_mutasi_for_a),
                    "latest_date": latest_mutasi.waktu_mutasi.strftime(
                        "%Y-%m-%d %H:%M:%S"
                    )
                    if latest_mutasi and latest_mutasi.waktu_mutasi
                    else None,
                    "latest_lokasi_tuju": latest_mutasi.lokasi_tujuan.nama_lokasi
                    if latest_mutasi and latest_mutasi.lokasi_tujuan
                    else None,
                    "latest_oleh": latest_mutasi.pengguna_ref.username
                    if latest_mutasi and latest_mutasi.pengguna_ref
                    else None,
                    "latest_alasan": latest_mutasi.alasan_mutasi
                    if latest_mutasi
                    else None,
                    "sudah_kembali": a.id_lokasi
                    == (
                        all_mutasi_for_a[0].id_lokasi_asal
                        if all_mutasi_for_a
                        else a.id_lokasi
                    ),
                    "original_lokasi_code": all_mutasi_for_a[0].id_lokasi_asal
                    if all_mutasi_for_a and all_mutasi_for_a[0].id_lokasi_asal
                    else a.id_lokasi,
                    "original_lokasi_name": all_mutasi_for_a[0].lokasi_asal.nama_lokasi
                    if all_mutasi_for_a and all_mutasi_for_a[0].lokasi_asal
                    else (
                        a.lokasi_ref.nama_lokasi if a.lokasi_ref else a.id_lokasi
                    ),
                }
                if all_mutasi_for_a
                else None,
            }
        )
    return results


# ==================================================================
# ── EXPORT ────────────────────────────────────────────────────────
# ==================================================================


@app.get("/api/export/riwayat")
def export_riwayat(
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    def build_rows(asets):
        """
        One query for the whole batch, grouped in Python.

        This used to issue one SELECT per asset — and `pengguna_ref` was not in
        the joinedload, so it lazy-loaded a second time per riwayat ROW. At 10k
        assets and 100k history rows that is ~110,000 round trips for a single
        request. Now it is exactly one, regardless of fleet size.
        """
        rows = []
        if not asets:
            return rows

        riwayat_by_aset: dict = {}
        q = (
            db.query(models.RiwayatKondisi)
            .options(
                joinedload(models.RiwayatKondisi.lokasi_ref),
                joinedload(models.RiwayatKondisi.pengguna_ref),
            )
            .filter(models.RiwayatKondisi.id_aset.in_([a.id_aset for a in asets]))
            .order_by(
                models.RiwayatKondisi.id_aset,
                models.RiwayatKondisi.waktu_lapor.asc(),
            )
        )
        # yield_per keeps the result set streaming rather than materialising
        # every ORM instance at once.
        for r in q.yield_per(2000):
            riwayat_by_aset.setdefault(r.id_aset, []).append(r)

        for a in asets:
            nama_alat = a.kategori.nama_alat if a.kategori else a.kode_alat
            nama_lokasi = a.lokasi_ref.nama_lokasi if a.lokasi_ref else a.id_lokasi
            riwayat = riwayat_by_aset.get(a.id_aset, [])

            if not riwayat:
                default_upt = a.lokasi_ref.nama_lokasi if a.lokasi_ref else (a.id_lokasi or "—")
                rows.append(
                    {
                        "no": None,
                        "tanggal": "—",
                        "id_aset": a.id_aset,
                        "kode_alat": nama_alat,
                        "id_lokasi": a.id_lokasi,
                        "peruntukan": a.peruntukan,
                        "id_lokasi_asal": nama_lokasi,
                        "upt": default_upt,
                        "id_pengguna": "—",
                        "kondisi": a.status_terakhir,
                        "keterangan": "Belum ada riwayat",
                    }
                )
            else:
                for i, r in enumerate(riwayat, start=1):
                    # Direct database lookup for UPT/lokasi name instead of text parsing
                    upt_name = (
                        r.lokasi_ref.nama_lokasi 
                        if r.lokasi_ref 
                        else (r.id_lokasi or "—")
                    )
                    
                    rows.append(
                        {
                            "no": i,
                            "tanggal": r.waktu_lapor.strftime("%Y-%m-%d %H:%M:%S")
                            if r.waktu_lapor
                            else "—",
                            "id_aset": a.id_aset,
                            "kode_alat": nama_alat,
                            "id_lokasi": r.id_lokasi,
                            "peruntukan": r.peruntukan,
                            "id_lokasi_asal": nama_lokasi,
                            "upt": upt_name,
                            "id_pengguna": r.pengguna_ref.username
                            if r.pengguna_ref
                            else str(r.id_pengguna),
                            "kondisi": r.kondisi,
                            "keterangan": r.keterangan or "—",
                        }
                    )
        return rows

    return {
        "active": build_rows(
            db.query(models.Aset)
            .options(joinedload(models.Aset.lokasi_ref), joinedload(models.Aset.kategori))
            # Was a `hasattr(models.Aset, "status_terlahir")` ternary — a typo of
            # `status_terakhir` that only worked because hasattr returned False
            # and the else-branch happened to be correct.
            .filter(models.Aset.status_terakhir != "AFKIR")
            .all()
        ),
        "afkir": build_rows(
            db.query(models.Aset)
            .options(joinedload(models.Aset.lokasi_ref), joinedload(models.Aset.kategori))
            .filter(models.Aset.status_terakhir == "AFKIR")
            .all()
        ),
    }


@app.get("/api/export/mutasi")
def export_mutasi(
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    # Two queries total, not O(assets x mutations).
    #
    # This endpoint had NO eager loading at all: it lazy-loaded `kategori` and
    # `lokasi_ref` once per asset, ran a SELECT per asset for its mutations, and
    # then lazy-loaded `lokasi_asal`, `lokasi_tujuan` and `pengguna_ref` per
    # mutation row. Worse, riwayat_mutasi had no index on id_aset (added in
    # _ensure_schema now), so each of those per-asset lookups was a sequential
    # scan of the whole table.
    asets = (
        db.query(models.Aset)
        .options(
            joinedload(models.Aset.kategori),
            joinedload(models.Aset.lokasi_ref),
        )
        .filter(models.Aset.status_terakhir != "AFKIR")
        .all()
    )
    if not asets:
        return []

    mutasi_by_aset: dict = {}
    mq = (
        db.query(models.RiwayatMutasi)
        .options(
            joinedload(models.RiwayatMutasi.lokasi_asal),
            joinedload(models.RiwayatMutasi.lokasi_tujuan),
            joinedload(models.RiwayatMutasi.pengguna_ref),
        )
        .filter(models.RiwayatMutasi.id_aset.in_([a.id_aset for a in asets]))
        .order_by(
            models.RiwayatMutasi.id_aset,
            models.RiwayatMutasi.waktu_mutasi.asc(),
        )
    )
    for m in mq.yield_per(2000):
        mutasi_by_aset.setdefault(m.id_aset, []).append(m)

    rows = []
    for a in asets:
        nama_alat = a.kategori.nama_alat if a.kategori else a.kode_alat
        nama_lokasi = a.lokasi_ref.nama_lokasi if a.lokasi_ref else a.id_lokasi
        mutasi_list = mutasi_by_aset.get(a.id_aset)
        if not mutasi_list:
            continue
        for i, m in enumerate(mutasi_list, start=1):
            rows.append(
                {
                    "no": i,
                    "id_aset": a.id_aset,
                    "kode_alat": nama_alat,
                    "lokasi_asal": m.lokasi_asal.nama_lokasi
                    if m.lokasi_asal
                    else m.id_lokasi_asal,
                    "lokasi_tujuan": m.lokasi_tujuan.nama_lokasi
                    if m.lokasi_tujuan
                    else m.id_lokasi_tujuan,
                    # The raw CODES, alongside the display names. Proses Laporan
                    # used to reverse-look-up a code from the name against the
                    # parent list only, which cannot resolve a UPT name — so its
                    # asal/tujuan filters silently matched nothing. Names are for
                    # display; codes are what filters compare.
                    "id_lokasi_asal": m.id_lokasi_asal,
                    "id_lokasi_tujuan": m.id_lokasi_tujuan,
                    "waktu_mutasi": m.waktu_mutasi.strftime("%Y-%m-%d %H:%M:%S")
                    if m.waktu_mutasi
                    else "—",
                    "oleh": m.pengguna_ref.username
                    if m.pengguna_ref
                    else str(m.id_pengguna),
                    "alasan": m.alasan_mutasi or "—",
                }
            )
    return rows


@app.delete("/api/aset/{id_aset}")
async def delete_aset(
    id_aset: str,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(
        require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"])
    ),
):
    aset = db.query(models.Aset).filter_by(id_aset=id_aset).first()
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")

    assert_aset_region_scope(
        db, current_user, aset,
        "Hanya bisa menghapus aset dari wilayah Anda.",
    )

    # Cascade delete child records first
    db.query(models.RiwayatKondisi).filter_by(id_aset=id_aset).delete()
    db.query(models.RiwayatMutasi).filter_by(id_aset=id_aset).delete()
    db.delete(aset)
    db.commit()
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": f"Aset {id_aset} berhasil dihapus permanen."}


@app.put("/api/aset/{id_aset}")
async def update_aset(
    id_aset: str,
    aset_in: AsetUpdate,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(
        require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"])
    ),
):
    old_aset = db.query(models.Aset).filter_by(id_aset=id_aset).first()
    if not old_aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")

    # Both the asset as it stands and where the edit would move it must be
    # inside the admin's region, or an edit becomes a way to push an asset out.
    assert_aset_region_scope(
        db, current_user, old_aset,
        "Hanya bisa mengedit aset dari wilayah Anda.",
    )
    assert_region_scope(
        db, current_user, aset_in.id_lokasi,
        "Hanya bisa memindahkan aset di dalam wilayah Anda.",
    )

    # Rebuild the generated ID from updated fields
    peruntukan_norm, kode_peruntukan = normalise_peruntukan(aset_in.peruntukan)
    sumber_norm, id_pengadaan = normalise_sumber_pengadaan(aset_in.sumber_pengadaan)
    tahun = aset_in.tanggal_pembelian.year
    year_str = str(tahun)[-2:] if tahun >= 2000 else str(tahun)

    # Preserve original sequence number from the old ID
    old_parts = id_aset.split(".")
    nomor_urut = old_parts[0] if old_parts[0].isdigit() else "1"

    new_id_aset = f"{nomor_urut}.{aset_in.kode_alat}.{id_pengadaan}.{year_str}.{kode_peruntukan}.{aset_in.parent_lokasi}"

    # `id_varian` and `nomor_seri` are optional in the schema, so a payload that
    # simply does not mention them used to null both out — the Kelola Data Alat
    # Kerja edit form sends exactly such a payload, and every edit there quietly
    # destroyed the asset's serial number and specification. Treat "absent" as
    # "leave alone" and only write what the caller actually sent.
    dikirim = aset_in.model_fields_set
    varian_baru = aset_in.id_varian if "id_varian" in dikirim else old_aset.id_varian
    seri_baru = (
        ((aset_in.nomor_seri or "").strip() or None)
        if "nomor_seri" in dikirim
        else old_aset.nomor_seri
    )

    if new_id_aset == id_aset:
        # ID unchanged — simple field update
        old_aset.kode_alat = aset_in.kode_alat
        old_aset.id_lokasi = aset_in.id_lokasi
        old_aset.tanggal_pembelian = aset_in.tanggal_pembelian
        old_aset.sumber_pengadaan = sumber_norm
        old_aset.peruntukan = peruntukan_norm
        old_aset.id_varian = varian_baru
        old_aset.nomor_seri = seri_baru
        db.commit()
        await manager.broadcast("REFRESH_ASSET_LIST")
        return {"message": "Aset berhasil diperbarui.", "id_aset": new_id_aset}

    # ID changes — check for collision
    if db.query(models.Aset).filter_by(id_aset=new_id_aset).first():
        raise HTTPException(
            status_code=400,
            detail=f"ID baru '{new_id_aset}' sudah digunakan oleh aset lain."
        )

    # 1. Insert new aset row first so FK target exists before child records point to it
    new_aset = models.Aset(
        id_aset=new_id_aset,
        kode_alat=aset_in.kode_alat,
        id_lokasi=aset_in.id_lokasi,
        tanggal_pembelian=aset_in.tanggal_pembelian,
        sumber_pengadaan=sumber_norm,
        status_terakhir=old_aset.status_terakhir,
        peruntukan=peruntukan_norm,
        id_varian=varian_baru,
        nomor_seri=seri_baru,
    )
    db.add(new_aset)
    db.flush()  # write new_aset row; FK target now exists in DB

    # 2. Re-parent all child records to the new ID (FK target now valid)
    db.query(models.RiwayatKondisi).filter_by(id_aset=id_aset).update(
        {"id_aset": new_id_aset}, synchronize_session=False
    )
    db.query(models.RiwayatMutasi).filter_by(id_aset=id_aset).update(
        {"id_aset": new_id_aset}, synchronize_session=False
    )
    db.query(models.RiwayatKalibrasi).filter_by(id_aset=id_aset).update(
        {"id_aset": new_id_aset}, synchronize_session=False
    )

    # 3. Now safe to delete the old aset row (no children reference it anymore)
    db.delete(old_aset)
    db.commit()

    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Aset berhasil diperbarui.", "id_aset": new_id_aset}


# ==================================================================
# ── INVENTARIS — Sparepart Management ─────────────────────────────
# ==================================================================

# ── Pydantic Schemas ──

class SparePartKategoriCreate(BaseModel):
    nama: str
    subsistem: Optional[str] = None
    kode_alat: Optional[str] = None


class SparePartCreate(BaseModel):
    sku: Optional[str] = None
    nama_part: str
    id_kategori: Optional[int] = None
    kode_alat: Optional[str] = None
    unit: str = "Pcs"
    harga_satuan: Optional[int] = None
    stok_min: int = 0
    auto_demand: bool = False
    supplier: Optional[str] = None
    deskripsi: Optional[str] = None
    part_number: Optional[str] = None
    is_critical: bool = False
    serial_numbers: Optional[str] = None
    lookup_tags: Optional[str] = None
    linked_vehicle: Optional[str] = None
    warranty_months: Optional[int] = None
    ref_part: Optional[str] = None
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
    supplier: Optional[str] = None
    deskripsi: Optional[str] = None
    part_number: Optional[str] = None
    is_critical: Optional[bool] = None
    serial_numbers: Optional[str] = None
    lookup_tags: Optional[str] = None
    linked_vehicle: Optional[str] = None
    warranty_months: Optional[int] = None
    ref_part: Optional[str] = None


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


class AlatVarianCreate(BaseModel):
    kode_alat: str
    nama_varian: str
    keterangan: Optional[str] = None
    # Spesifikasi teknis — rendered on the public asset card.
    merk: Optional[str] = None
    tipe_model: Optional[str] = None
    kapasitas: Optional[str] = None
    daya: Optional[str] = None
    dimensi: Optional[str] = None
    berat: Optional[str] = None


class AlatVarianUpdate(BaseModel):
    nama_varian: Optional[str] = None
    keterangan: Optional[str] = None
    merk: Optional[str] = None
    tipe_model: Optional[str] = None
    kapasitas: Optional[str] = None
    daya: Optional[str] = None
    dimensi: Optional[str] = None
    berat: Optional[str] = None


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

@app.get("/api/inventaris/kategori")
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


@app.post("/api/inventaris/kategori",
          dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"]))])
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


@app.put("/api/inventaris/kategori/{id_kategori}",
         dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"]))])
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


@app.delete("/api/inventaris/kategori/{id_kategori}",
            dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"]))])
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
    if stok_max and stok > stok_max:
        return "DI ATAS MAX"
    return "AMAN"


def _movement_breakdown(db: Session, id_lokasi=None, id_gudang=None) -> dict:
    """
    Per-part movement totals split by type → {id_part: {tipe: qty}}.

    One grouped query for the whole catalog; feeds the Items Master columns
    (Masuk, Keluar, Retur ke Vendor, Retur dari Customer, Penyesuaian ±).
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


@app.get("/api/inventaris/parts")
def get_inv_parts(
    id_lokasi: Optional[str] = None,
    id_gudang: Optional[int] = None,
    id_kategori: Optional[int] = None,
    kode_alat: Optional[str] = None,
    mode: str = "global",   # global | per_lokasi
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """Parts catalog with the full Items Master column set."""
    # The row loop reads p.kategori_ref and p.kategori_alat_ref, which were two
    # lazy loads per part. get_inv_dashboard already eager-loads both, so this
    # was an inconsistency rather than a decision.
    q = db.query(models.SparePart).options(
        joinedload(models.SparePart.kategori_ref),
        joinedload(models.SparePart.kategori_alat_ref),
    )
    if id_kategori:
        q = q.filter(models.SparePart.id_kategori == id_kategori)
    if kode_alat:
        q = q.filter(models.SparePart.kode_alat == kode_alat)
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
            "sku": p.sku,
            "nama_part": p.nama_part,
            "id_kategori": p.id_kategori,
            "nama_kategori": kat.nama if kat else None,
            "subsistem": kat.subsistem if kat else None,
            "kode_alat": p.kode_alat,
            "nama_alat": alat.nama_alat if alat else None,
            "unit": p.unit,
            "harga_satuan": p.harga_satuan,
            "stok_min": p.stok_min,
            "stok_sekarang": stok,
            "is_critical": p.is_critical or (stok <= p.stok_min and p.stok_min > 0),
            "auto_demand": p.auto_demand,
            "supplier": p.supplier,
            "deskripsi": p.deskripsi,
            "part_number": p.part_number,
            "linked_vehicle": p.linked_vehicle,
            "warranty_months": p.warranty_months,
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


@app.post("/api/inventaris/parts",
          dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"]))])
async def create_inv_part(
    data: SparePartCreate,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    # Auto-generate SKU if not provided
    if not data.sku:
        count = db.query(models.SparePart).count()
        data.sku = f"SP{count + 1:05d}"
    if db.query(models.SparePart).filter_by(sku=data.sku).first():
        raise HTTPException(status_code=400, detail="SKU sudah ada.")

    part = models.SparePart(
        sku=data.sku, nama_part=data.nama_part, id_kategori=data.id_kategori,
        kode_alat=data.kode_alat, unit=data.unit, harga_satuan=data.harga_satuan,
        stok_min=data.stok_min, auto_demand=data.auto_demand, supplier=data.supplier,
        deskripsi=data.deskripsi, part_number=data.part_number,
        is_critical=data.is_critical, serial_numbers=data.serial_numbers,
        lookup_tags=data.lookup_tags, linked_vehicle=data.linked_vehicle,
        warranty_months=data.warranty_months, ref_part=data.ref_part,
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
    return {"message": "Part berhasil ditambahkan.", "id_part": part.id_part, "sku": part.sku}


@app.put("/api/inventaris/parts/{id_part}",
         dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"]))])
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


@app.delete("/api/inventaris/parts/{id_part}",
            dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"]))])
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

@app.post("/api/inventaris/transfer",
          dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH", "TEKNISI"]))])
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


@app.get("/api/inventaris/transfer")
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

@app.get("/api/inventaris/gudang")
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


@app.post(
    "/api/inventaris/gudang",
    dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"]))],
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


@app.put(
    "/api/inventaris/gudang/{id_gudang}",
    dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"]))],
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


@app.delete(
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

@app.post(
    "/api/inventaris/stok",
    dependencies=[
        Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH", "TEKNISI"]))
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


@app.get("/api/inventaris/stok")
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
                "sku": p.sku if p else None,
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


# ── Alat Varian (spesifikasi teknis) ───────────────────────────────

@app.get("/api/master/varian")
def get_alat_varian(
    kode_alat: Optional[str] = None,
    db: Session = Depends(get_db),
):
    q = db.query(models.AlatVarian)
    if kode_alat:
        q = q.filter(models.AlatVarian.kode_alat == kode_alat)
    rows = q.order_by(models.AlatVarian.kode_alat, models.AlatVarian.nama_varian).all()
    return [_varian_payload(v) for v in rows]


def _varian_payload(v) -> dict:
    """One shape for a variant, so the list, the create response and the public
    asset card cannot drift apart."""
    return {
        "id_varian": v.id_varian,
        "kode_alat": v.kode_alat,
        "nama_varian": v.nama_varian,
        "keterangan": v.keterangan,
        "merk": v.merk,
        "tipe_model": v.tipe_model,
        "kapasitas": v.kapasitas,
        "daya": v.daya,
        "dimensi": v.dimensi,
        "berat": v.berat,
    }


_VARIAN_SPEC_FIELDS = ("merk", "tipe_model", "kapasitas", "daya", "dimensi", "berat")


@app.post(
    "/api/master/varian",
    dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"]))],
)
async def create_alat_varian(data: AlatVarianCreate, db: Session = Depends(get_db)):
    if not db.query(models.KategoriAlat).filter_by(kode_alat=data.kode_alat).first():
        raise HTTPException(status_code=404, detail="Kode alat tidak ditemukan.")
    nama = (data.nama_varian or "").strip()
    if not nama:
        raise HTTPException(status_code=400, detail="Nama varian wajib diisi.")
    dupe = (
        db.query(models.AlatVarian)
        .filter_by(kode_alat=data.kode_alat, nama_varian=nama)
        .first()
    )
    if dupe:
        raise HTTPException(status_code=400, detail="Varian sudah ada untuk alat ini.")

    row = models.AlatVarian(
        kode_alat=data.kode_alat,
        nama_varian=nama,
        keterangan=data.keterangan,
        **{f: getattr(data, f) for f in _VARIAN_SPEC_FIELDS},
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Varian ditambahkan.", "id_varian": row.id_varian}


@app.put(
    "/api/master/varian/{id_varian}",
    dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"]))],
)
async def update_alat_varian(
    id_varian: int, data: AlatVarianUpdate, db: Session = Depends(get_db)
):
    """Edit a variant's name and its spesifikasi teknis."""
    row = db.query(models.AlatVarian).filter_by(id_varian=id_varian).first()
    if not row:
        raise HTTPException(status_code=404, detail="Varian tidak ditemukan.")

    payload = data.model_dump(exclude_unset=True)
    if "nama_varian" in payload:
        nama = (payload["nama_varian"] or "").strip()
        if not nama:
            raise HTTPException(status_code=400, detail="Nama varian wajib diisi.")
        clash = (
            db.query(models.AlatVarian)
            .filter(
                models.AlatVarian.kode_alat == row.kode_alat,
                models.AlatVarian.nama_varian == nama,
                models.AlatVarian.id_varian != id_varian,
            )
            .first()
        )
        if clash:
            raise HTTPException(
                status_code=400, detail="Varian sudah ada untuk alat ini."
            )
        payload["nama_varian"] = nama

    for field, value in payload.items():
        setattr(row, field, value)
    db.commit()
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Varian diperbarui."}


@app.delete(
    "/api/master/varian/{id_varian}",
    dependencies=[Depends(require_role(["SUPER_ADMIN"]))],
)
async def delete_alat_varian(id_varian: int, db: Session = Depends(get_db)):
    row = db.query(models.AlatVarian).filter_by(id_varian=id_varian).first()
    if not row:
        raise HTTPException(status_code=404, detail="Varian tidak ditemukan.")
    # Detach from any assets first so the FK cannot block the delete.
    db.query(models.Aset).filter(models.Aset.id_varian == id_varian).update(
        {models.Aset.id_varian: None}, synchronize_session=False
    )
    db.delete(row)
    db.commit()
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Varian dihapus."}


# ── Aset Perbaikan Dashboard ───────────────────────────────────────

BULAN_SINGKAT = [
    "Jan", "Feb", "Mar", "Apr", "Mei", "Jun",
    "Jul", "Agu", "Sep", "Okt", "Nov", "Des",
]


def _repair_events_subquery():
    """
    Every riwayat_kondisi row tagged with the SAME asset's previous kondisi.

        lag(kondisi) OVER (PARTITION BY id_aset ORDER BY waktu_lapor, id_riwayat)

    This window is deliberately UNFILTERED. Filtering by year or lokasi before
    the LAG would break adjacency:
      - a TSO opened in Dec 2025 and closed in Jan 2026 would lose its
        predecessor and stop counting as a completed repair;
      - a repair closes at the Balaiyasa the asset was mutated to, so a lokasi
        pre-filter would sever the open/close pair.
    Filter AFTER the window, never inside it.
    """
    RK = models.RiwayatKondisi
    return select(
        RK.id_aset.label("id_aset"),
        RK.kondisi.label("kondisi"),
        RK.waktu_lapor.label("waktu_lapor"),
        RK.id_lokasi.label("id_lokasi"),
        func.lag(RK.kondisi)
        .over(partition_by=RK.id_aset, order_by=(RK.waktu_lapor, RK.id_riwayat))
        .label("prev_kondisi"),
    ).subquery("ev")


def _scoped_repair_events(year: int, lokasi_ids):
    """
    The window subquery joined to aset, restricted to `year` and `lokasi_ids`,
    reduced to three flags:

      f_masuk   — a fault was reported            (kondisi = 'TSO')
      f_selesai — a repair was completed          (kondisi = 'SO'    AND prev = 'TSO')
      f_afkir   — a repair ended in scrapping     (kondisi = 'AFKIR' AND prev = 'TSO')

    `prev_kondisi` is NULL for an asset's first row, and `NULL = 'TSO'` is NULL,
    so the CASE falls through. That is what stops the automatic "Aset Baru" /
    "Pencatatan aset baru" creation rows from inflating `selesai` — no keterangan
    string-matching needed, which matters because the two creation paths write
    different keterangan values.
    """
    ev = _repair_events_subquery()
    AS = models.Aset

    # create_aset writes its seed riwayat row with id_lokasi = NULL; coalesce to
    # the asset's own lokasi so those rows land in a real bucket, not a NULL one.
    eff_lokasi = func.coalesce(ev.c.id_lokasi, AS.id_lokasi).label("eff_lokasi")

    sel = (
        select(
            ev.c.waktu_lapor.label("waktu_lapor"),
            eff_lokasi,
            AS.kode_alat.label("kode_alat"),
            case((ev.c.kondisi == "TSO", 1), else_=0).label("f_masuk"),
            case(
                ((ev.c.kondisi == "SO") & (ev.c.prev_kondisi == "TSO"), 1), else_=0
            ).label("f_selesai"),
            case(
                ((ev.c.kondisi == "AFKIR") & (ev.c.prev_kondisi == "TSO"), 1), else_=0
            ).label("f_afkir"),
        )
        .select_from(ev)
        .join(AS, AS.id_aset == ev.c.id_aset)
    )
    # year=None is the "Semua Tahun" case: keep every event. The window above is
    # still unfiltered either way, so open/close adjacency is never broken.
    if year is not None:
        sel = sel.where(extract("year", ev.c.waktu_lapor) == year)
    base = sel.subquery("base")

    scoped = select(base)
    if lokasi_ids:
        scoped = scoped.where(base.c.eff_lokasi.in_(lokasi_ids))
    return scoped.subquery("s")


@app.get("/api/aset/dashboard/perbaikan")
def get_aset_perbaikan_dashboard(
    id_lokasi: Optional[str] = None,
    year: Optional[int] = Query(None, ge=1950, le=2100),
    all_years: bool = False,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    Aggregated repair dashboard matching the printed UPT "Laporan Perbaikan
    Alat Kerja" report.

    id_lokasi — DAOP/DIVRE/BALAIYASA code (auto-includes its UPT children), or a
                single UPT code. Omit for a global view.
    year      — defaults to the current year, or the most recent year that has
                data if the current year has none.
    all_years — "Semua Tahun": aggregate every year instead of one. The trend
                series then carries one point per YEAR rather than per month,
                flagged by `trend_mode` so the chart can label its axis.
                Distinct from omitting `year`, which still resolves to a single
                default year.
    """
    RK = models.RiwayatKondisi
    AS = models.Aset
    KA = models.KategoriAlat
    LK = models.Lokasi

    lokasi_ids, parent_row, child_rows = resolve_lokasi_scope(db, id_lokasi)
    region_name, region_label, kota = build_region_labels(parent_row, id_lokasi, db)

    # ── Years that actually contain repair events, within the current scope ──
    # Restricted to TSO rows on purpose: without it, every purchase year appears
    # (asset creation writes an SO row back-dated to tanggal_pembelian) and
    # picking one of those years would show an empty dashboard.
    yq = (
        select(distinct(extract("year", RK.waktu_lapor)))
        .select_from(RK)
        .join(AS, AS.id_aset == RK.id_aset)
        .where(RK.kondisi == "TSO")
    )
    if lokasi_ids:
        yq = yq.where(func.coalesce(RK.id_lokasi, AS.id_lokasi).in_(lokasi_ids))
    available_years = sorted(
        {int(r[0]) for r in db.execute(yq) if r[0] is not None}, reverse=True
    )

    if all_years:
        year = None
    elif year is None:
        now_year = datetime.now().year
        if now_year in available_years or not available_years:
            year = now_year
        else:
            year = available_years[0]

    S = _scoped_repair_events(year, lokasi_ids)

    # ── Headline totals ──────────────────────────────────────────────────────
    totals = db.execute(
        select(
            func.coalesce(func.sum(S.c.f_masuk), 0),
            func.coalesce(func.sum(S.c.f_selesai), 0),
            func.coalesce(func.sum(S.c.f_afkir), 0),
        )
    ).one()
    masuk, selesai, diafkir = int(totals[0]), int(totals[1]), int(totals[2])

    # An asset's HOME region as a SQL expression: `id_lokasi` normally, but the
    # origin of its first mutation while it is away at a Balaiyasa. This is
    # `resolve_home_lokasi()` pushed into the query so the scope filters below
    # can use it per row.
    #
    # Scoping "sedang" by the raw `id_lokasi` meant sending a broken machine to a
    # workshop DELETED it from its own DAOP's under-repair count and moved it
    # under the Balaiyasa — the same misattribution the repair endpoint already
    # guards against, and the reason `masuk` (which is home-attributed) drifted
    # from `selesai + diafkir + sedang` exactly when workshop traffic was high.
    _by_ids = balaiyasa_lokasi_ids(db)
    _mutasi_pertama = (
        select(models.RiwayatMutasi.id_lokasi_asal)
        .where(models.RiwayatMutasi.id_aset == AS.id_aset)
        .order_by(models.RiwayatMutasi.waktu_mutasi.asc())
        .limit(1)
        .correlate(AS)
        .scalar_subquery()
    )
    home_lokasi_expr = (
        case(
            (
                AS.id_lokasi.in_(_by_ids),
                func.coalesce(_mutasi_pertama, AS.id_lokasi),
            ),
            else_=AS.id_lokasi,
        )
        if _by_ids
        else AS.id_lokasi
    )

    # SEDANG is point-in-time (assets currently TSO), not year-scoped — it is a
    # live workshop count, and must agree with sum(workshop_list[].jumlah).
    sedang_q = select(func.count()).select_from(AS).where(
        AS.status_terakhir == "TSO"
    )
    if lokasi_ids:
        sedang_q = sedang_q.where(home_lokasi_expr.in_(lokasi_ids))
    sedang = int(db.execute(sedang_q).scalar_one() or 0)

    persen_selesai = round(selesai / masuk * 100, 1) if masuk else 0.0

    # ── Trend ────────────────────────────────────────────────────────────────
    # One year selected → 12 monthly points, densified so the line always spans
    # the whole year. "Semua Tahun" → one point per year instead; 12 months
    # summed across a decade would be meaningless (every January added up).
    if year is None:
        y_col = extract("year", S.c.waktu_lapor).label("y")
        y_rows = db.execute(
            select(y_col, func.sum(S.c.f_masuk), func.sum(S.c.f_selesai))
            .group_by(y_col)
            .order_by(y_col)
        ).all()
        monthly_trend = [
            {
                "bulan": str(int(r[0])),
                "masuk": int(r[1] or 0),
                "selesai": int(r[2] or 0),
            }
            for r in y_rows
            if r[0] is not None
        ]
        trend_mode = "tahun"
    else:
        m_col = extract("month", S.c.waktu_lapor).label("m")
        m_rows = db.execute(
            select(m_col, func.sum(S.c.f_masuk), func.sum(S.c.f_selesai))
            .group_by(m_col)
            .order_by(m_col)
        ).all()
        m_map = {
            int(r[0]): (int(r[1] or 0), int(r[2] or 0))
            for r in m_rows
            if r[0] is not None
        }
        monthly_trend = [
            {
                "bulan": BULAN_SINGKAT[i],
                "masuk": m_map.get(i + 1, (0, 0))[0],
                "selesai": m_map.get(i + 1, (0, 0))[1],
            }
            for i in range(12)
        ]
        trend_mode = "bulan"

    # ── Per resort (UPT) ─────────────────────────────────────────────────────
    r_rows = db.execute(
        select(
            S.c.eff_lokasi,
            func.sum(S.c.f_masuk),
            func.sum(S.c.f_selesai),
        ).group_by(S.c.eff_lokasi)
    ).all()
    r_map = {
        r[0]: (int(r[1] or 0), int(r[2] or 0)) for r in r_rows if r[0] is not None
    }

    # A Balaiyasa is a workshop, not an operating region, so it must never be a
    # row in a resort table — "BALAIYASA CIREBONPRUNJAKAN" listed alongside
    # "1.3 Pasarsenen" is what this drops. seed.py now records every repair
    # against the asset's owning region, so in a freshly seeded database this
    # loop finds nothing; it is here so legacy rows written against a workshop
    # cannot reintroduce the leak. The one exception is an explicit Balaiyasa
    # scope, where the workshop IS the subject of the report.
    by_ids = balaiyasa_lokasi_ids(db)
    scope_is_balaiyasa = bool(lokasi_ids) and any(k in by_ids for k in lokasi_ids)
    if not scope_is_balaiyasa:
        r_map = {k: v for k, v in r_map.items() if k not in by_ids}

    # Full list = every resort in scope, zero-filled and positionally ordered
    # (1.1 → 1.25), so the full-width chart shows the whole region like the PDF.
    if child_rows:
        ordered = [l for l in child_rows if (l.tipe or "").upper() == "UPT"] or list(
            child_rows
        )
    else:
        known = {l.id_lokasi: l for l in db.query(LK).all()}
        ordered = [known[k] for k in r_map if k in known]

    per_resort = [
        {
            "resort": l.id_lokasi,
            "resort_label": short_lokasi_label(l.id_lokasi, l.nama_lokasi),
            "masuk": r_map.get(l.id_lokasi, (0, 0))[0],
            "selesai": r_map.get(l.id_lokasi, (0, 0))[1],
        }
        for l in sorted(ordered, key=upt_sort_key)
    ]
    # Buckets that are not a resort in scope (e.g. rows recorded directly against
    # the parent code, or an asset mutated to a Balaiyasa for repair).
    seen_resorts = {p["resort"] for p in per_resort}
    extra_codes = [k for k in r_map if k not in seen_resorts]
    if extra_codes:
        extra_names = {
            l.id_lokasi: l.nama_lokasi
            for l in db.query(LK).filter(LK.id_lokasi.in_(extra_codes)).all()
        }
        for k in extra_codes:
            mk, sl = r_map[k]
            per_resort.append(
                {
                    "resort": k,
                    "resort_label": short_lokasi_label(k, extra_names.get(k)),
                    "masuk": mk,
                    "selesai": sl,
                }
            )

    top_resort = sorted(per_resort, key=lambda x: -x["masuk"])[:10]

    # ── Per alat kerja ───────────────────────────────────────────────────────
    a_rows = db.execute(
        select(
            KA.nama_alat,
            func.sum(S.c.f_masuk).label("masuk"),
            func.sum(S.c.f_selesai).label("selesai"),
        )
        .select_from(S)
        .join(KA, KA.kode_alat == S.c.kode_alat)
        .group_by(KA.nama_alat)
        .order_by(func.sum(S.c.f_masuk).desc(), KA.nama_alat)
    ).all()
    per_alat = [
        {"nama_alat": r[0], "masuk": int(r[1] or 0), "selesai": int(r[2] or 0)}
        for r in a_rows
    ]
    top_alat = per_alat[:10]
    # Zero-count categories are dropped: a doughnut slice of 0 renders as an
    # invisible wedge with a visible legend entry.
    by_alat = {p["nama_alat"]: p["masuk"] for p in per_alat if p["masuk"] > 0}

    # ── Workshop list (assets currently under repair) ─────────────────────────
    wq = (
        select(KA.nama_alat, AS.id_lokasi, LK.nama_lokasi, func.count().label("jumlah"))
        .select_from(AS)
        .join(KA, KA.kode_alat == AS.kode_alat)
        .outerjoin(LK, LK.id_lokasi == AS.id_lokasi)
        .where(AS.status_terakhir == "TSO")
        .group_by(KA.nama_alat, AS.id_lokasi, LK.nama_lokasi)
        .order_by(func.count().desc(), KA.nama_alat)
    )
    if lokasi_ids:
        # Scoped by home so an asset away at a workshop stays in its owning
        # region's list, but still GROUPED by its current id_lokasi so the row
        # shows where the machine physically is ("BALAIYASA CIREBONPRUNJAKAN").
        # Keeping both in step is what preserves sedang == sum(jumlah).
        wq = wq.where(home_lokasi_expr.in_(lokasi_ids))
    workshop_list = [
        {
            "nama_alat": r[0],
            "id_lokasi": r[1],
            "lokasi_label": short_lokasi_label(r[1], r[2]),
            "jumlah": int(r[3]),
        }
        for r in db.execute(wq)
    ]

    return {
        # None when "Semua Tahun" is active — the client shows the label rather
        # than a number, and re-sends all_years on the next request.
        "tahun": year,
        "all_years": year is None,
        "trend_mode": trend_mode,
        "available_years": available_years,

        "masuk": masuk,
        "sedang": sedang,
        "selesai": selesai,
        # Repairs that ended in scrapping rather than a return to service. Without
        # this the report cannot explain why masuk != selesai + sedang.
        "diafkir": diafkir,
        "persen_selesai": persen_selesai,

        "region_code": id_lokasi or "",
        "region_name": region_name,
        "region_label": region_label,
        "kota": kota,

        "workshop_list": workshop_list,
        "per_resort": per_resort,
        "top_resort": top_resort,
        "per_alat": per_alat,
        "top_alat": top_alat,
        "by_alat": by_alat,
        "monthly_trend": monthly_trend,
    }


# ── Dasbor Inventaris (stock dashboard) ────────────────────────────

STOK_STATUS_ORDER = ["MINUS", "KOSONG", "KRITIS", "DI BAWAH MIN", "AMAN", "DI ATAS MAX"]

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


@app.get("/api/inventaris/dashboard")
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
    supplier_set: set = set()

    for p in all_parts:
        stok = stok_map.get(p.id_part, 0)
        nilai = nilai_map.get(p.id_part, 0)
        total_value += max(nilai, 0)

        if p.supplier:
            supplier_set.add(p.supplier)

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
                "sku": p.sku,
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
                "sku": p.sku,
                "nama_part": p.nama_part,
                "stok_sekarang": stok,
                "unit": p.unit,
                "nilai": nilai,
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
        "total_suppliers": len(supplier_set),
        "critical_count": len(critical_list),
        "critical_list": critical_list[:50],
        "top_value": top_value_list[:15],
        "by_subsistem": by_subsistem,
        "by_alat": by_alat,
        "transaksi_periode": transaksi_periode,
        "monthly_usage": [
            {"bulan": r.bulan, "jumlah": int(r.jumlah or 0)} for r in monthly_data
        ],
    }


# ── MCF — Mean Cumulative Function (repair trend) ──────────────────

@app.get("/api/aset/dashboard/mcf")
def get_mcf(
    id_lokasi: Optional[str] = None,
    year: Optional[int] = Query(None, ge=1950, le=2100),
    all_years: bool = False,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    Mean Cumulative Function for the repairable fleet (Nelson-Aalen).

    MCF(t) = cumulative number of repairs up to time t, divided by the number of
    assets at risk. It is the standard reliability curve for REPAIRABLE systems:
    a straight line means a constant failure rate, an upward bend means the fleet
    is degrading, a downward bend means maintenance is winning.

    Reported monthly, alongside the raw cumulative count so the reader can see
    both the normalised rate and the absolute workload.
    """
    RK = models.RiwayatKondisi
    AS = models.Aset

    lokasi_ids, parent_row, _children = resolve_lokasi_scope(db, id_lokasi)
    region_name, region_label, kota = build_region_labels(parent_row, id_lokasi, db)

    # Years that actually hold repair events in this scope. Same rule as the
    # repair dashboard: snapping to a year with data beats defaulting to the
    # calendar year and rendering a flat, empty curve.
    yq = (
        select(distinct(extract("year", RK.waktu_lapor)))
        .select_from(RK)
        .join(AS, AS.id_aset == RK.id_aset)
        .where(RK.kondisi == "TSO")
    )
    if lokasi_ids:
        yq = yq.where(func.coalesce(RK.id_lokasi, AS.id_lokasi).in_(lokasi_ids))
    available_years = sorted(
        {int(r[0]) for r in db.execute(yq) if r[0] is not None}, reverse=True
    )

    if all_years:
        year = None
    elif year is None:
        now_year = datetime.now().year
        if now_year in available_years or not available_years:
            year = now_year
        else:
            year = available_years[0]

    # Assets at risk = every non-scrapped asset in scope. Denominator of the MCF.
    risk_q = db.query(func.count()).select_from(AS).filter(
        AS.status_terakhir != "AFKIR"
    )
    if lokasi_ids:
        risk_q = risk_q.filter(AS.id_lokasi.in_(lokasi_ids))
    n_at_risk = int(db.execute(risk_q).scalar_one() or 0)

    # Repair events (TSO = a fault opened), bucketed by month within one year or
    # by year across the whole history when "Semua Tahun" is active. The MCF is
    # cumulative either way, so the curve keeps its meaning at both resolutions.
    bucket_col = (
        extract("year", RK.waktu_lapor) if year is None else extract("month", RK.waktu_lapor)
    ).label("b")
    ev_q = (
        select(bucket_col, func.count().label("n"))
        .select_from(RK)
        .join(AS, AS.id_aset == RK.id_aset)
        .where(RK.kondisi == "TSO")
    )
    if year is not None:
        ev_q = ev_q.where(extract("year", RK.waktu_lapor) == year)
    if lokasi_ids:
        ev_q = ev_q.where(func.coalesce(RK.id_lokasi, AS.id_lokasi).in_(lokasi_ids))
    ev_q = ev_q.group_by(bucket_col).order_by(bucket_col)

    per_bucket = {int(r[0]): int(r[1]) for r in db.execute(ev_q) if r[0] is not None}

    if year is None:
        labels = [(y, str(y)) for y in sorted(per_bucket.keys())]
    else:
        labels = [(i + 1, BULAN_SINGKAT[i]) for i in range(12)]

    series = []
    cumulative = 0
    for key, label in labels:
        n = per_bucket.get(key, 0)
        cumulative += n
        series.append({
            "bulan": label,
            "perbaikan": n,
            "kumulatif": cumulative,
            # MCF — repairs per asset. Rounded to 4dp: with a few hundred assets
            # a single month's increment is ~0.003, so 2dp would flatten the curve.
            "mcf": round(cumulative / n_at_risk, 4) if n_at_risk else 0.0,
        })

    return {
        "tahun": year,
        "all_years": year is None,
        "trend_mode": "tahun" if year is None else "bulan",
        "available_years": available_years,
        "aset_berisiko": n_at_risk,
        "total_perbaikan": cumulative,
        "mcf_akhir": round(cumulative / n_at_risk, 4) if n_at_risk else 0.0,
        "region_code": id_lokasi or "",
        "region_name": region_name,
        "region_label": region_label,
        "kota": kota,
        "series": series,
    }


# ── One-time Seed Trigger (SUPER_ADMIN only) ───────────────────────

@app.post("/api/inventaris/seed",
          dependencies=[Depends(require_role(["SUPER_ADMIN"]))])
def trigger_seed(db: Session = Depends(get_db)):
    """Triggers the sparepart catalog seed. Safe to call multiple times."""
    try:
        from seed import seed_spareparts
        seed_spareparts()
        return {"message": "Seed sparepart selesai."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================================================================
# ── PUBLIC ENDPOINTS (Landing Page / QR) ──────────────────────────
# ==================================================================


@app.get("/api/public/aset/{id_aset}")
def get_public_aset(id_aset: str, db: Session = Depends(get_db)):
    """
    The payload behind the QR landing card.

    Historically this returned five keys, two of which lied: `kode_alat` carried
    the tool's display NAME and `id_lokasi` carried `nama_lokasi`. The landing
    page fed that name into a code→name resolver, which naturally failed, which
    is why its "UPT" row was permanently "—". Codes and names are now separate
    keys, and the old two are kept as aliases so nothing that reads them breaks.
    """
    aset = (
        db.query(models.Aset)
        .filter(models.Aset.id_aset == id_aset, models.Aset.status_terakhir != "AFKIR")
        .first()
    )
    if not aset:
        raise HTTPException(
            status_code=404, detail="Aset tidak ditemukan atau di-afkir."
        )

    nama_alat = aset.kategori.nama_alat if aset.kategori else aset.kode_alat
    nama_lokasi = aset.lokasi_ref.nama_lokasi if aset.lokasi_ref else None

    # The card shows both levels: the owning DAOP/DIVRE and the resort inside it.
    parent_code = get_parent_lokasi_code(aset.id_lokasi)
    parent_row = (
        db.query(models.Lokasi).filter_by(id_lokasi=parent_code).first()
        if parent_code
        else aset.lokasi_ref
    )

    v = aset.varian_ref
    spesifikasi = None
    if v is not None:
        spesifikasi = {
            "nama_varian": v.nama_varian,
            "merk": v.merk,
            "tipe_model": v.tipe_model,
            "kapasitas": v.kapasitas,
            "daya": v.daya,
            "dimensi": v.dimensi,
            "berat": v.berat,
            "keterangan": v.keterangan,
        }

    return {
        "id_aset": aset.id_aset,
        # ── Jenis alat ──
        "kode_alat_code": aset.kode_alat,
        "nama_alat": nama_alat,
        "kode_alat": nama_alat,  # legacy alias — carries the NAME, not the code
        # ── Lokasi ──
        "id_lokasi_code": aset.id_lokasi,
        "nama_lokasi": nama_lokasi,
        "parent_code": parent_code or aset.id_lokasi,
        "parent_nama": (parent_row.nama_lokasi if parent_row else None) or nama_lokasi,
        # `parent_code` is None when the asset is homed directly at a DAOP rather
        # than a resort; in that case there is no separate UPT to show.
        "upt_nama": nama_lokasi if parent_code else None,
        "id_lokasi": nama_lokasi or aset.id_lokasi,  # legacy alias — the NAME
        # ── Status & pengadaan ──
        "status_terakhir": aset.status_terakhir,
        "peruntukan": aset.peruntukan,
        "sumber_pengadaan": aset.sumber_pengadaan,
        "tanggal_pembelian": aset.tanggal_pembelian,
        "waktu_update": aset.waktu_update,
        "nomor_seri": aset.nomor_seri,
        "spesifikasi": spesifikasi,
    }


# ==================================================================
# ── ASSET FILES ──────────────────────────────────────────────────
# ==================================================================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

assets_dir = os.path.join(BASE_DIR, "assets")
if os.path.exists(assets_dir):
    app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")


@app.middleware("http")
async def add_cache_headers(request, call_next):
    """
    Stamp Cache-Control on static responses.

    StaticFiles (the /assets mount) does not set it either, so this covers both
    that mount and the catch-all below in one place. API responses are left
    alone — they must never be cached.
    """
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/api/") or path.startswith("/ws/"):
        return response
    ext = os.path.splitext(path)[1].lower()
    if ext or path == "/":
        response.headers.setdefault("Cache-Control", _cache_control_for(ext))
    return response


# Starlette's FileResponse emits ETag and Last-Modified but never *reads*
# If-None-Match, so it always returns 200 with the whole body. Paired with the
# `no-cache` above — which asks the browser to revalidate on every load — that
# meant index.html and all fourteen js/ files were re-sent in full every time,
# even though the point of `no-cache` is to make revalidation cheap. Measured:
# /assets/style.css (the StaticFiles mount, which does check) answered 304 while
# /, /js/*.js and /landing.html all answered 200.
#
# StaticFiles owns the conditional-request logic; borrowing its comparison keeps
# the catch-all byte-for-byte consistent with the /assets mount rather than
# growing a second, subtly different implementation.
_conditional = StaticFiles(directory=BASE_DIR)


def file_response_conditional(request: Request, path: str, media_type: str = None):
    """FileResponse, downgraded to a bodyless 304 when the client's copy is current.

    `stat_result` must be passed explicitly: FileResponse only calls
    `set_stat_headers()` from its constructor when it already has one, otherwise
    it stats the file later inside `__call__`. Constructing it without one
    therefore leaves `response.headers` with no `etag` and no `last-modified` at
    all, and the comparison below silently has nothing to compare.
    """
    try:
        stat_result = os.stat(path)
    except OSError:
        raise HTTPException(status_code=404, detail="File not found.")
    response = FileResponse(path, media_type=media_type, stat_result=stat_result)
    if _conditional.is_not_modified(response.headers, request.headers):
        return Response(status_code=304, headers=response.headers)
    return response


@app.get("/")
async def serve_index(request: Request):
    return file_response_conditional(request, os.path.join(BASE_DIR, "index.html"))

@app.get("/{file_path:path}")
async def serve_static(file_path: str, request: Request):
    # Prevent directory traversal
    if ".." in file_path or file_path.startswith("/"):
        raise HTTPException(status_code=403, detail="Access denied.")
    
    allowed_extensions = {'.html', '.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp'}
    ext = os.path.splitext(file_path)[1].lower()
    if ext not in allowed_extensions:
        raise HTTPException(status_code=404, detail="File not found.")
    
    path = os.path.join(BASE_DIR, file_path)
    real_path = os.path.realpath(path)
    real_base = os.path.realpath(BASE_DIR)
    
    if not real_path.startswith(real_base):
        raise HTTPException(status_code=403, detail="Access denied.")
    
    if os.path.exists(real_path) and os.path.isfile(real_path):
        media_type = None
        if ext == '.svg':
            media_type = "image/svg+xml"
        elif ext == '.png':
            media_type = "image/png"
        elif ext == '.jpg' or ext == '.jpeg':
            media_type = "image/jpeg"
        elif ext == '.gif':
            media_type = "image/gif"
        elif ext == '.ico':
            media_type = "image/x-icon"
        elif ext == '.webp':
            media_type = "image/webp"
        elif ext == '.css':
            media_type = "text/css"
        elif ext == '.js':
            media_type = "application/javascript"
        
        return file_response_conditional(request, real_path, media_type=media_type)

    raise HTTPException(status_code=404, detail="File not found.")
