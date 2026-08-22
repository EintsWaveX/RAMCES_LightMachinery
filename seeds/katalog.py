"""
Master reference data: alat kerja, lokasi and the UPT/resort tree.

Everything here is transcribed from the client's `KATALOG SFM.xlsx` and lives in
`seed_katalog.py`; this module only WRITES it. Rows are upserted rather than
skipped, because the whole point of adopting the katalog was that four codes
previously meant something else — `MPR` was MESIN POTONG/BABAT RUMPUT and is now
MESIN POTONG REL — and skipping an existing row would leave the old meaning in
place.
"""

import re

import models
from seed_katalog import ALL_ALAT, KATALOG_UPT
from seed_katalog_sfm import read_katalog as _read_katalog

# ── The 16 parent regions ─────────────────────────────────────────────
# KATALOG SFM.xlsx ▸ KATALOG LOKASI, read rather than transcribed.
#
# The list that used to sit here spelled BY1 "BALAIYASA CIREBONPRUNJAKAN"; the
# sheet says "BALAIYASA CIREBON PRUJAKAN". Nothing compared them, so the wrong
# spelling was on every Balaiyasa report header. Reading the sheet is what makes
# that class of drift impossible rather than merely fixed once.
LOKASI_DATA = [
    (kode, nama, tipe) for kode, nama, tipe in _read_katalog().lokasi
]

# UPT / resort rows, folded into `lokasi` — the table is FLAT and a child's
# parent is derived from its id string, never stored (see CLAUDE.md).
#
# 240 rows from the katalog, up from the 203 hand-kept before it was adopted.
# The 37 new ones are almost entirely the JB (jembatan) branch, which RAMCES had
# no rows for at all even though 245 assets in the import workbook live on it.
#
# The three BY*A workshop rows are appended separately: they are not resorts and
# the katalog does not list them, but assets are mutated to them for repair.
UPT_DATA_AS_LOKASI = [
    (kode, nama, "UPT", parent) for kode, nama, parent in KATALOG_UPT
] + [
    ("BY1A", "BY Cirebon Prujakan", "UPT", "BY1"),
    ("BY2A", "BY Prabumulih", "UPT", "BY2"),
    ("BY3A", "BY Kiaracondong", "UPT", "BY3"),
]


# ══════════════════════════════════════════════════════════════════════
# The parent-derivation rule
# ══════════════════════════════════════════════════════════════════════
#
# DUPLICATED, deliberately and unavoidably, in three places that must stay
# byte-identical:
#
#     get_parent_lokasi_code()  main.py
#     get_parent_lokasi_code()  seeds/katalog.py   ← this one
#     getParentLokasiCode()     js/core.js
#
# `verify_upt_parents()` asserts the whole tree against the katalog on every
# seed, which is the only reason a drift between the three is survivable: the
# missing JB branch went unnoticed for as long as nobody compared them.
_ROMAN_MAP = {
    "I": "VI", "II": "VII", "III": "VIII", "IV": "VIV",
    "V": "VV", "VI": "VVI", "VII": "VVII", "VIII": "VVIII", "IX": "VIX",
}


def get_parent_lokasi_code(id_lokasi):
    """"JR1.3" → "D1" · "JRI.2" → "VI" · "BY1A" → "BY1" · "JR2" → None."""
    if not id_lokasi:
        return None
    # `J[RB]`, not `JR`: the resort tree has two branches — JR (jalan rel) and
    # JB (jembatan).
    arab = re.match(r"^J[RB]\s*(\d+)\.", id_lokasi, re.IGNORECASE)
    if arab:
        return f"D{arab.group(1)}"
    # Dot optional: the katalog's "JBII" (JB II Padang) has no sub-number.
    roman = re.match(
        r"^J[RB]\s*(IV|IX|VIII|VII|VI|V|I{1,3})(?:\.|$)", id_lokasi, re.IGNORECASE
    )
    if roman:
        return _ROMAN_MAP.get(roman.group(1).upper())
    # MEKANIK — the third branch. 14 resorts (ME1.1, ME1.2, ME2..ME9,
    # MEI..MEIV) that RAMCES had no rows for at all until rev0.5.2, exactly the
    # hole JB was in before it. The `$` anchor is load-bearing: without it
    # "MEIV" matches the `I{1,3}` alternative and returns VI, so MEKANIK
    # DIVRE IV's assets land silently in DIVRE I.
    mek_arab = re.match(r"^ME\s*(\d+)(?:\.\d+)?$", id_lokasi, re.IGNORECASE)
    if mek_arab:
        return f"D{mek_arab.group(1)}"
    mek_roman = re.match(
        r"^ME\s*(IV|IX|VIII|VII|VI|V|I{1,3})$", id_lokasi, re.IGNORECASE
    )
    if mek_roman:
        return _ROMAN_MAP.get(mek_roman.group(1).upper())
    balaiyasa = re.match(r"^(BY\d+)[A-Z]+$", id_lokasi, re.IGNORECASE)
    if balaiyasa:
        return balaiyasa.group(1).upper()
    return None


def _upsert(db, model, pk_field, pk_value, fields):
    """Insert or update one row. Returns 'added' | 'updated' | 'unchanged'."""
    row = db.query(model).filter_by(**{pk_field: pk_value}).first()
    if row is None:
        db.add(model(**{pk_field: pk_value}, **fields))
        return "added"
    changed = False
    for field, value in fields.items():
        if getattr(row, field) != value:
            setattr(row, field, value)
            changed = True
    return "updated" if changed else "unchanged"


def run(db):
    # ── Alat kerja ──
    counts = {"added": 0, "updated": 0, "unchanged": 0}
    for kode, nama, ukur, kalib, kelompok in ALL_ALAT:
        counts[
            _upsert(
                db, models.KategoriAlat, "kode_alat", kode,
                {
                    "nama_alat": nama,
                    "alat_ukur": ukur,
                    "perlu_kalibrasi": kalib,
                    "kelompok": kelompok,
                },
            )
        ] += 1
    print(
        f"  kategori_alat : {counts['added']} baru, {counts['updated']} diperbarui, "
        f"{counts['unchanged']} tetap  (total {len(ALL_ALAT)})"
    )

    # ── Lokasi + UPT ──
    counts = {"added": 0, "updated": 0, "unchanged": 0}
    rows = list(LOKASI_DATA)
    # The 4th element is the parent code from the katalog sheet. It is used only
    # by verify_upt_parents() to assert the derivation rule; parentage is
    # DERIVED from the id, never stored.
    rows += [(k, n, t) for k, n, t, _parent in UPT_DATA_AS_LOKASI]
    for kode, nama, tipe in rows:
        counts[
            _upsert(
                db, models.Lokasi, "id_lokasi", kode,
                {"nama_lokasi": nama, "tipe": tipe},
            )
        ] += 1
    print(
        f"  lokasi        : {counts['added']} baru, {counts['updated']} diperbarui, "
        f"{counts['unchanged']} tetap  (total {len(rows)})"
    )
