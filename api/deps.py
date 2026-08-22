"""
The hinge module: everything more than one router needs.

Four blocks, in this order:

1. **The lokasi hierarchy.** The `lokasi` table is flat, a UPT's parent is
   derived from its ID string. `resolve_lokasi_scope()` is the only sanctioned
   way to filter by region (never `LIKE 'D1%'`, which misses `JR1.3`, nor
   `LIKE 'VI%'`, which over-matches VI/VII/VIII/VIV), and `assert_region_scope` /
   `assert_aset_region_scope` are the only sanctioned way to enforce an
   ADMIN_WILAYAH's limit, never a bare `==`, because a token carries a parent
   code (`D1`) while assets live at UPT codes (`JR1.7`).

   The TTL cache is ONE unit: `_LokasiRow`, `_LOKASI_CACHE_TTL`, `_lokasi_cache`,
   `_lokasi_cache_lock`, `invalidate_lokasi_cache` and `lokasi_rows`. Splitting
   any part of it into another module gives you two caches, and a lokasi edit
   then invalidates the one nobody reads, stale scopes for 60 s, intermittently.
   api/master.py imports only the `invalidate_lokasi_cache` NAME.

2. **`get_db`.** It must be exactly one object across the whole application.
   FastAPI's per-request dependency cache keys on the callable, so a second
   definition anywhere would open two sessions for a request that touched both,
   and a handler reading through one while writing through the other would not
   see its own uncommitted rows.

3. **Security.** `SECRET_KEY` has no fallback and the app refuses to boot without
   it. `require_role([...])` covers the coarse role check; the regional limit is
   inline via the helpers in block 1, because a dependency cannot express it.

4. **Pagination.** `MAX_PAGE` is read by both `/api/aset` (api/aset.py) and
   `/api/history/summary` (api/riwayat.py), which is what puts the trio here
   rather than in either router.

`normalise_peruntukan` / `normalise_sumber_pengadaan` are aset-only callers, but
they stay in this module because they are the canonical gate for two closed sets
baked into the composite primary key, this is where a reader looks for them.
"""

import os
import re
import secrets
import threading
import time
from collections import namedtuple
from datetime import datetime, timedelta
from typing import List, Optional

import bcrypt
import jwt
from dotenv import load_dotenv
from fastapi import Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

import models
from database import SessionLocal

# database.py already calls this at import, and main.py calls it again; it is
# idempotent. Repeating it here makes this module safe to import from any entry
# point that is not main.py, a snapshot script, a REPL, before SECRET_KEY is
# read a few dozen lines below.
load_dotenv()


# ==================================================================
# ── LOKASI HIERARCHY HELPERS ──────────────────────────────────────
# ==================================================================
# The `lokasi` table is flat, there is no parent_id column. The parent of a
# UPT/resort is encoded in its id: "JR1.3" belongs to DAOP "D1", "JRIII.7" to
# DIVRE "VIII", "BY1A" to Balaiyasa "BY1". The same rule lives in seed.py
# (get_parent_lokasi_code) and js/core.js (getParentLokasiCode); keep all three
# in step when changing it.

# Only I, IV exist in the seeded master data, but the regex below accepts up to
# IX. Without the V, IX rows a "JRV.1"-style code resolved to a code on the
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
# `J[RB]`, not `JR`: the resort tree has TWO branches, JR (jalan rel) and JB
# (jembatan), and only JR was ever matched here. Every JB resort in
# `KATALOG SFM.xlsx ▸ KATALOG UPT` (38 of the 240) therefore resolved to no
# parent at all, which put its assets outside every regional filter, scope
# check and dashboard bucket. Keep byte-identical to seed.py and js/core.js.
_RE_UPT_ARAB = re.compile(r"^J[RB]\s*(\d+)\.", re.IGNORECASE)
# The dot is optional on the roman branch: the katalog's "JBII" (JB II Padang)
# is a whole DIVRE's jembatan resort and carries no sub-number. No parent code
# is shaped like this, so accepting the bare form cannot swallow one.
_RE_UPT_ROMAN = re.compile(
    r"^J[RB]\s*(IV|IX|VIII|VII|VI|V|I{1,3})(?:\.|$)", re.IGNORECASE
)
# MEKANIK, the THIRD branch of the resort tree. 14 rows in
# `KATALOG SFM.xlsx ▸ KATALOG UPT` (ME1.1, ME1.2, ME2..ME9, MEI..MEIV) that
# RAMCES had no rows for at all until rev0.5.2, the same hole the JB branch was
# in, and found the same way: by comparing the database against the workbook.
#
# THE `$` ANCHOR IS LOAD-BEARING. Alternation in both Python and JS is
# leftmost-first, not longest-first, so `I{1,3}` is tried before `IV`. With the
# anchor, "MEIV" fails on `I` and backtracks to the correct branch; without it,
# "MEIV" matches `I` and returns VI, MEKANIK DIVRE IV's assets land silently in
# DIVRE I, with no error and both regions' totals still summing correctly.
# If a future sheet adds "MEI.2", widen to `(?:\.\d+)?$`, never to a prefix match.
_RE_UPT_MEKANIK_ARAB = re.compile(r"^ME\s*(\d+)(?:\.\d+)?$", re.IGNORECASE)
_RE_UPT_MEKANIK_ROMAN = re.compile(
    r"^ME\s*(IV|IX|VIII|VII|VI|V|I{1,3})$", re.IGNORECASE
)
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
    m = _RE_UPT_MEKANIK_ARAB.match(id_lokasi)
    if m:
        return f"D{m.group(1)}"
    m = _RE_UPT_MEKANIK_ROMAN.match(id_lokasi)
    if m:
        return _ROMAN_TO_DIVRE.get(m.group(1).upper())
    m = _RE_UPT_BALAIYASA.match(id_lokasi)
    if m:
        return m.group(1).upper()
    return None


# ══════════════════════════════════════════════════════════════════════
# The lokasi table, cached
# ══════════════════════════════════════════════════════════════════════
#
# `resolve_lokasi_scope`, `balaiyasa_lokasi_ids` and `resolve_home_lokasi` each
# used to run their own `db.query(models.Lokasi).all()`. The repair dashboard
# alone loaded the whole table four times per request, and `resolve_home_lokasi`
# reloaded it once PER ASSET inside the export loops.
#
# It is ~250 rows and changes maybe monthly, so it is cached for 60 seconds.
#
# Two details that matter:
#
#   * Plain NAMED TUPLES, never ORM instances. A cached `models.Lokasi` belongs
#     to the Session that loaded it; once that session closes the instance is
#     detached and touching any attribute raises DetachedInstanceError. Callers
#     that genuinely need an ORM row still query for it directly.
#   * Invalidated explicitly by the lokasi CRUD endpoints, so an admin adding a
#     UPT sees it immediately rather than up to a minute later.

_LokasiRow = namedtuple("_LokasiRow", "id_lokasi nama_lokasi tipe")

_LOKASI_CACHE_TTL = 60.0
_lokasi_cache: dict = {"at": 0.0, "rows": None, "balaiyasa": None}
_lokasi_cache_lock = threading.Lock()


def invalidate_lokasi_cache() -> None:
    """Call after any INSERT/UPDATE/DELETE on `lokasi`."""
    with _lokasi_cache_lock:
        _lokasi_cache["at"] = 0.0
        _lokasi_cache["rows"] = None
        _lokasi_cache["balaiyasa"] = None


def lokasi_rows(db: Session) -> List[_LokasiRow]:
    """Every lokasi row as detached tuples. Cheap to call repeatedly."""
    now = time.monotonic()
    with _lokasi_cache_lock:
        rows = _lokasi_cache["rows"]
        if rows is not None and (now - _lokasi_cache["at"]) < _LOKASI_CACHE_TTL:
            return rows

    fresh = [
        _LokasiRow(r[0], r[1], r[2])
        for r in db.query(
            models.Lokasi.id_lokasi, models.Lokasi.nama_lokasi, models.Lokasi.tipe
        ).all()
    ]
    # Precomputed here rather than on each call: balaiyasa_lokasi_ids() is hit
    # once per asset by resolve_home_lokasi().
    parents = {r.id_lokasi for r in fresh if (r.tipe or "").upper() == "BALAIYASA"}
    balaiyasa = parents | {
        r.id_lokasi for r in fresh if get_parent_lokasi_code(r.id_lokasi) in parents
    }

    with _lokasi_cache_lock:
        _lokasi_cache["rows"] = fresh
        _lokasi_cache["balaiyasa"] = balaiyasa
        _lokasi_cache["at"] = time.monotonic()
    return fresh


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

    rows = lokasi_rows(db)
    by_code = {r.id_lokasi: r for r in rows}

    parent = by_code.get(id_lokasi)
    if parent is not None and (parent.tipe or "").upper() == "UPT":
        return [parent.id_lokasi], parent, [parent]

    # ~250 rows, one scan in Python beats duplicating the roman-numeral map in
    # an unindexable SQL CASE expression.
    target = id_lokasi.upper()
    children = [r for r in rows if get_parent_lokasi_code(r.id_lokasi) == target]
    return [id_lokasi] + [r.id_lokasi for r in children], parent, children


def balaiyasa_lokasi_ids(db: Session) -> set:
    """
    Every lokasi id on the workshop side of the tree: the BALAIYASA rows
    themselves plus their UPT-typed children (BY1A → BY1).

    A Balaiyasa is a workshop, not an operating region. An asset visits one for
    repair but is never based at one, and a repair performed there still belongs
    to the DAOP/DIVRE that owns the asset. Filtering these ids out is what keeps
    "BALAIYASA CIREBONPRUNJAKAN" from appearing as a row in the resort tables of
    Laporan Perbaikan. Mirrors `_is_balaiyasa_side()` in seeds/katalog.py.

    Precomputed by `lokasi_rows()` and served from the same 60 s cache: this is
    called once per asset by `resolve_home_lokasi()` inside the export loops.
    """
    lokasi_rows(db)  # populates/refreshes the cache
    return _lokasi_cache["balaiyasa"] or set()


def resolve_home_lokasi(db: Session, aset) -> Optional[str]:
    """
    Where an asset BELONGS, as opposed to where it currently sits.

    `aset.id_lokasi` is normally the answer, but an asset mutated to a workshop
    for repair carries the workshop code until it is sent back. In that window
    the owning region is the origin of the first mutation that moved it there,
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
    js/api.js), while assets live at UPT codes like `JR1.7`. An exact-equality
    check therefore rejected an admin's own assets ('JR1.7' != 'D1') and, where
    no check existed at all, let it write into other regions. This helper is the
    single place that rule now lives, so both directions stay correct.

    SUPER_ADMIN and any user without a region are unrestricted.
    """
    if current_user.role not in REGION_SCOPED_ROLES or not current_user.id_lokasi:
        return
    scope, _, _ = resolve_lokasi_scope(db, current_user.id_lokasi)
    if scope and id_lokasi not in scope:
        raise HTTPException(status_code=403, detail=pesan)


def assert_aset_region_scope(db: Session, current_user, aset, pesan: str):
    """
    Same guard, but for an existing asset, tested against where it BELONGS.

    An asset away at a Balaiyasa carries the workshop code in `id_lokasi`, which
    is in no DAOP's scope. Checking that raw value would lock the owning region
    out of the very assets it has sent for repair, including recalling them.
    """
    assert_region_scope(
        db, current_user, resolve_home_lokasi(db, aset) or aset.id_lokasi, pesan
    )


def assert_pengadaan_scope(current_user, id_pengadaan: int):
    """
    An ADMIN_WILAYAH may only register assets procured by its own region.

    The client's own feature matrix states it: *"admin daerah hanya input
    pengadaan 2"*. Procurement code 1 is PUSAT, a national purchase, which a
    regional admin is not the one recording.

    ── Why this is a 400 and not a nudge ──

    `sumber_pengadaan` is baked into the asset's COMPOSITE PRIMARY KEY as its
    third segment (`6.RGM.1.24.A.D1`). A wrong value is therefore not a display
    problem that can be edited later, correcting it regenerates the key and
    rewrites every child row. Refusing at the boundary is much cheaper than any
    repair afterwards.

    Kept OUT of `normalise_sumber_pengadaan()` deliberately. That function has no
    user context and answers a different question, "is this a legal value?",
    while this one answers "may *you* write it?". Folding a scope rule into a
    validator is how the region checks went wrong before: it belongs beside
    `assert_region_scope`, which is exactly where it now is.
    """
    if current_user.role == "ADMIN_WILAYAH" and id_pengadaan == 1:
        raise HTTPException(
            status_code=400,
            detail=(
                "ADMIN WILAYAH hanya bisa mendaftarkan aset dengan sumber "
                "pengadaan DAOP/DIVRE. Aset pengadaan PUSAT didaftarkan oleh "
                "SUPER ADMIN."
            ),
        )


# `peruntukan` and `sumber_pengadaan` are closed sets that get baked into the
# asset's composite primary key. Both used to fall back silently, an unknown
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
# "<kota>, <tanggal>" dateline, pin the seat of each region explicitly.
REGION_KOTA_OVERRIDE = {
    "VI": "Medan",
    "VII": "Padang",
    "VIII": "Palembang",
    "VIV": "Tanjungkarang",
    "BY1": "Cirebon",
    "BY2": "Prabumulih",
    "BY3": "Bandung",
}
DEFAULT_KOTA = "Bandung"  # PT KAI HQ, used for the unscoped/global view

_RE_DAOP = re.compile(r"^DAOP\s+(\d+)\s+(.*)$", re.IGNORECASE)
_RE_DIVRE = re.compile(r"^DIVRE\s+([IVX]+)\s+(.*)$", re.IGNORECASE)
_RE_BALAIYASA = re.compile(r"^BALAI\s*YASA\s+(.*)$", re.IGNORECASE)
# Deliberately JR-only, unlike the parent regexes above. `short_lokasi_label()`
# strips this prefix, and the two branches reuse the same numbering, "JR 1.1
# Jakartakota" and "JB 1.1 Tanah Abang" are different places. Dropping the
# letter from a jembatan resort would print it as "1.1 Tanah Abang", visually a
# peer of the jalan-rel resorts. JB names fall through and render verbatim.
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

    # A UPT is not a region, a dateline of "Jr 1.3 Pasarsenen, 7 Agustus 2026"
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
    """Natural resort ordering: 1.1, 1.2... 1.10, 1.25, not lexicographic."""
    m = _RE_UPT_NAMA.match((lokasi_row.nama_lokasi or "").strip())
    seg = m.group(1) if m else (lokasi_row.id_lokasi or "")
    head, _, tail = seg.partition(".")
    return (head, int(tail) if tail.isdigit() else 0)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# The JWT signing key. There is deliberately NO fallback: a hardcoded default
# means every deployment that forgets to set one shares a key that is published
# in this file, and anyone holding it can mint a SUPER_ADMIN token without ever
# touching /api/login. Failing to boot is the only honest behaviour.
SECRET_KEY = os.environ.get("SECRET_KEY", "").strip()
if not SECRET_KEY:
    raise RuntimeError(
        "SECRET_KEY belum diset. Tambahkan baris berikut ke file .env "
        "(nilai acak, jangan dibagikan):\n\n"
        "    SECRET_KEY=" + secrets.token_urlsafe(48) + "\n\n"
        "Kunci ini menandatangani token login; tanpa nilai rahasia, siapa pun "
        "dapat membuat token SUPER_ADMIN sendiri."
    )
ALGORITHM = "HS256"

# The closed set of roles. `require_role([...])` reads whatever list a route
# passes, so nothing previously stopped a typo'd role name from being stored on
# a user row and matching no guard anywhere, the account simply lost access to
# everything with no error at creation time.
#
# Five since rev0.5.2. The three-role model no longer described the application:
# TEKNISI could write stock movements and transfers, and there was no way to
# give somebody reporting access without also giving them asset write.
#
#   SUPER_ADMIN     everything, nationwide. Master data, afkir/pulihkan, users.
#   ADMIN_WILAYAH   everything inside its own region except master data.
#   PETUGAS_GUDANG  the warehouse. The only non-admin who may move stock.
#   TEKNISI         the field task: report kondisi, record kalibrasi, and
#                   consume parts as part of a repair. Reads the rest.
#   PIMPINAN        read-only, plus Proses Laporan. Writes nothing at all.
#
# No migration was needed to add them: `pengguna.role` is String(20) with no
# enum, FK or CHECK, existing values stay valid members of the widened tuple,
# and the longest new name is 14 characters.
ROLES = (
    "SUPER_ADMIN",
    "ADMIN_WILAYAH",
    "PETUGAS_GUDANG",
    "TEKNISI",
    "PIMPINAN",
)

# Roles whose writes are confined to their own region when the row carries one.
#
# This used to be the bare literal "ADMIN_WILAYAH" inside assert_region_scope,
# which meant a PETUGAS_GUDANG or PIMPINAN holding an id_lokasi would have been
# silently unrestricted, the widening would have quietly granted national
# scope to two brand-new roles. `id_lokasi IS NULL` still means nationwide, for
# all three.
REGION_SCOPED_ROLES = frozenset({"ADMIN_WILAYAH", "PETUGAS_GUDANG", "PIMPINAN"})

# Roles that may reach user administration at all. Written as an ALLOW-LIST,
# not as `!= "TEKNISI"`: a negative check silently admits every role added
# after it was written, which is exactly how a widening like this leaks.
USER_ADMIN_ROLES = ("SUPER_ADMIN", "ADMIN_WILAYAH")

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/login")


def get_password_hash(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    # Never raises: bcrypt rejects a malformed or truncated hash with ValueError,
    # and a corrupt stored hash must read as "wrong password", not as a 500 that
    # tells the caller the row exists.
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


# A real bcrypt hash of a value nothing can match, used to spend the same time
# on an unknown username as on a wrong password. Computed once at import.
_DUMMY_HASH = get_password_hash(secrets.token_urlsafe(32))


# Password rules, applied wherever a password is set. Deliberately minimal,
# a length floor catches the actual failure mode (one-character passwords on a
# shared workstation) without pushing technicians towards a sticky note.
PASSWORD_MIN_LEN = 8


def validate_password(password: Optional[str]) -> str:
    if not password or len(password) < PASSWORD_MIN_LEN:
        raise HTTPException(
            status_code=400,
            detail=f"Password minimal {PASSWORD_MIN_LEN} karakter.",
        )
    return password


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

    # Checked HERE, not only in login(). Tokens last 12 hours, so a status
    # enforced at sign-in alone would let a suspended or rejected account keep
    # working for the rest of the day on the token it already holds, which is
    # the whole window an admin suspends someone to close.
    #
    # 401 rather than 403 on purpose: `apiFetch` force-logs-out on 401 and
    # treats 403 as an ordinary response, so 403 would leave a suspended user
    # sitting in the app watching every request fail.
    if (user.status or "AKTIF").upper() != "AKTIF":
        raise HTTPException(status_code=401, detail="Akun Anda tidak aktif.")
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

# Page size. Chosen so the 1,121-asset production fleet arrives in two requests
# while a 10k fleet still streams in visible increments.
DEFAULT_PAGE = 1000
MAX_PAGE = 5000


def _page_envelope(query, limit: Optional[int], offset: int, serialise):
    """Run `query` for one page and wrap it. `total` is the count BEFORE paging."""
    total = query.order_by(None).count()
    if limit is not None:
        query = query.limit(limit).offset(offset)
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "items": [serialise(row) for row in query.all()],
    }
