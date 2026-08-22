"""
Ingest the client's spektek and manual documents from `modules/` into
`uploads/dokumen_alat/`, and attach them to the alat kerja they describe.

── Why this exists ──

`modules/` carries 25 documents, ~40 MB: 20 technical specification PDFs under
`Spesifikasi Lengkap Alat Kerja/` and 5 manual books under `Manual Instruction
Alat Kerja/`. Until this module, NONE of them reached the database.
`uploads/dokumen_alat/` was empty, and the only "Spek Lengkap" a technician
could reach was a Google Drive link transcribed from `Rekap Spek RAMCES.docx`,
which needs a Google account and an internet connection, neither of which a
technician standing at a resort reliably has.

── Why they attach to the TOOL TYPE, not to a model ──

The client files these against alat kerja. Three facts follow from that and none
of them fit `alat_varian`:

  * One file covers FOUR tools: "Spektek Genset, Pompa Air, Shear Wrench dan
    Impact Wrench.pdf". Another covers three.
  * Several cover tools with no Model/Type row at all, nothing in the fleet has
    ever named a model for ALAT UKUR MUTU BETON, so there was no row to hang a
    document on.
  * A technician scanning a QR code gets whatever the asset's model resolves to,
    and 49 of the seeded models are bare rows the importer created from a
    free-text column. Those would have shown no document at all.

So the columns live on `kategori_alat` (added in `_ensure_schema()`), and
`_varian_payload()` in main.py falls back to them when a model's own slot is
empty, flagging the result `spek_from_katalog` so the UI can say the document
is the general one for the tool type rather than this exact model's.

── Idempotency ──

Files are copied under a deterministic slug and skipped when the destination
already matches by size. Re-running attaches nothing new and rewrites nothing.
"""

import os
import re
import shutil

import models

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODULES = os.path.join(ROOT, "modules")
DEST = os.path.join(ROOT, "uploads", "dokumen_alat")

SPEK_FASILITAS = os.path.join(MODULES, "Spesifikasi Lengkap Alat Kerja", "Spektek Fasilitas")
SPEK_JEMBATAN = os.path.join(MODULES, "Spesifikasi Lengkap Alat Kerja", "Spektek Jembatan")
MANUAL = os.path.join(MODULES, "Manual Instruction Alat Kerja")


# ══════════════════════════════════════════════════════════════════════
# The mapping: document → the alat kerja code(s) it describes
# ══════════════════════════════════════════════════════════════════════
#
# Hand-built from the file names and corroborated by the katalog's own
# `kelompok` column, which records which tools the client listed under each
# spektek folder. That cross-check is what makes this table auditable rather
# than a guess: all 13 JEMBATAN-tagged codes are covered here, and 10 of the 11
# FASILITAS-tagged ones (MESIN LAS PORTABLE is named in the katalog but the
# client supplied no file for it).
#
# A list of several codes means one file genuinely describes several tools; the
# same basename is then referenced by several rows, with one copy on disk.

SPEK_MAP = [
    # ── Spektek Fasilitas ──
    (SPEK_FASILITAS, "Alat ukur flens roda_spektek.pdf", ["AUF"]),
    (SPEK_FASILITAS, "Dongkrak 10 Ton_ spektek.pdf", ["DRJ"]),
    (SPEK_FASILITAS, "KGC-55 HP Petrol Compactor Hand Stamper.pdf", ["HNS"]),
    (SPEK_FASILITAS, "Kertz-Gasoline Jack Hammer[1].pdf", ["JCK"]),
    # "Railway Grinding Cutting" covers both the rail saw and the rail grinder.
    (SPEK_FASILITAS, "Kertz_Railway Grinding Cutting.pdf", ["MPR", "RGM"]),
    (SPEK_FASILITAS, "Lampu Penerangan_spektek.pdf", ["LMP"]),
    # TRACK GAUGE (TRG) and ALAT UKUR LEBAR SEPUR (ALS) are the same measurement
    # under two katalog names; the Rekap files its Geismar RCA under ALS.
    (SPEK_FASILITAS, "SPESIFIKASI TEKNIK TRACK GAUGE.PDF", ["ALS", "TRG"]),
    (SPEK_FASILITAS, "Spektek Mesin Bor Rel.pdf", ["MBR"]),
    (SPEK_FASILITAS, "Spektek Mesin Portable Balas.pdf", ["PBT"]),
    (SPEK_FASILITAS, "Spektek thermometer dua laser.pdf", ["TMG"]),
    (SPEK_FASILITAS, "spektek Impact wrench Milwawkee.pdf", ["IMP"]),
    # ── Spektek Jembatan ──
    (SPEK_JEMBATAN, "Spektek Airless Spraypack.pdf", ["MSC"]),
    (SPEK_JEMBATAN, "Spektek Alat Uji Beton.pdf", ["AMB"]),
    (
        SPEK_JEMBATAN,
        "Spektek Genset, Pompa Air, Shear Wrench dan Impact Wrench.pdf",
        ["GEN", "MPA", "SHW", "IMP"],
    ),
    (SPEK_JEMBATAN, "Spesifikasi Coating Thickness.pdf", ["ACK"]),
    (
        SPEK_JEMBATAN,
        "Spesifikasi Hammer Test, Hardness Test, dan Dew Point Meter.pdf",
        ["AMB", "AKB", "DPC"],
    ),
    (SPEK_JEMBATAN, "Spesifikasi Kompresor Angin.pdf", ["KOM"]),
    (SPEK_JEMBATAN, "Spesifikasi Lampu Penerangan.pdf", ["LMP"]),
    (SPEK_JEMBATAN, "Spesifikasi SSPC VIS 3.pdf", ["BKC"]),
    # KUNCI MOMEN is the katalog's JEMBATAN-tagged torque wrench; KUNCI TORSI is
    # the same instrument under the facilities naming.
    (SPEK_JEMBATAN, "Spesifikasi Torque Wrench.pdf", ["KCM", "TOR"]),
]

MANUAL_MAP = [
    (MANUAL, "Buku Manual Mesin Pemotong Rel.pdf", ["MPR"]),
    (MANUAL, "MANUAL BOOK RFD.pdf", ["RFD"]),
    (MANUAL, "Manual Book HTT.pdf", ["HTT"]),
    (MANUAL, "Manual book impact wrench.pdf", ["IMP"]),
    (MANUAL, "SOP PERAWATAN PORTABLE BALLAST TAMPER.docx", ["PBT"]),
]


def _slug(text: str) -> str:
    """Filesystem-safe, lower-case, no spaces. 'Kertz-Gasoline Jack Hammer[1]'
    → 'kertz-gasoline-jack-hammer-1'."""
    text = re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-").lower()
    return re.sub(r"-{2,}", "-", text)[:60]


def _copy(src_dir: str, filename: str, prefix: str, kode: str):
    """
    Copy one document into uploads/ under a deterministic name.

    Returns the destination basename, or None when the source is missing,
    `modules/` is gitignored, so a checkout without it must still seed.
    """
    src = os.path.join(src_dir, filename)
    if not os.path.exists(src):
        return None

    stem, ext = os.path.splitext(filename)
    dest_name = f"{prefix}_{kode}_{_slug(stem)}{ext.lower()}"
    dest = os.path.join(DEST, dest_name)

    # Size comparison rather than a hash: these are 0.1, 8 MB binaries that never
    # change in place, and re-hashing 40 MB on every boot buys nothing.
    if os.path.exists(dest) and os.path.getsize(dest) == os.path.getsize(src):
        return dest_name

    os.makedirs(DEST, exist_ok=True)
    shutil.copy2(src, dest)
    return dest_name


def _judul(filename: str) -> str:
    """
    A printable title from the client's own filename.

    The stored names are what the client sent, "Kertz-Gasoline Jack
    Hammer[1].pdf", "SPESIFIKASI TEKNIK TRACK GAUGE.PDF", so the extension,
    the duplicate marker and the shouting all come off before it reaches a link
    label. Nothing else is invented: the words are the client's.
    """
    stem = os.path.splitext(filename)[0]
    stem = re.sub(r"\[\d+\]$", "", stem).replace("_", " ").strip()
    stem = re.sub(r"\s{2,}", " ", stem)
    # ALL CAPS reads as an error in a list of mixed-case links; anything with
    # lower-case letters in it is left exactly as the client typed it.
    return stem.title() if stem.isupper() else stem


def run(db):
    if not os.path.isdir(MODULES):
        print(f"  ! {MODULES} tidak ada — impor dokumen dilewati.")
        print("    (modules/ adalah drop sumber dari klien dan tidak ikut di git)")
        return

    katalog = {row.kode_alat: row for row in db.query(models.KategoriAlat).all()}
    copied = attached = 0
    missing_files, unknown_codes = [], set()

    # Every (kode, jenis) pair already carrying rows, so a re-run neither
    # duplicates nor rewrites. Keyed by the triple the unique index uses.
    existing = {
        (d.kode_alat, d.jenis, d.nama_file): d
        for d in db.query(models.DokumenAlat).all()
    }
    # The FIRST document listed for a (kode, jenis) is the primary one, the one
    # mirrored onto kategori_alat.file_spek / file_manual for
    # `_varian_payload()`'s tool-type fallback. Table order is the client's own
    # ordering, and for the three tools with two documents the first is the one
    # named after the tool itself rather than the one that bundles it in with
    # three others.
    seen_utama = set()
    rows_new = 0

    for field, jenis, prefix, table in (
        ("file_spek", "SPEK", "spektek", SPEK_MAP),
        ("file_manual", "MANUAL", "manual", MANUAL_MAP),
    ):
        for src_dir, filename, codes in table:
            if not os.path.exists(os.path.join(src_dir, filename)):
                missing_files.append(filename)
                continue
            for kode in codes:
                row = katalog.get(kode)
                if row is None:
                    unknown_codes.add(kode)
                    continue
                dest_name = _copy(src_dir, filename, prefix, kode)
                if not dest_name:
                    continue
                copied += 1

                is_utama = (kode, jenis) not in seen_utama
                seen_utama.add((kode, jenis))

                # ── The row that makes the SECOND document reachable ──
                #
                # kategori_alat has one column per kind, so before dokumen_alat
                # existed this loop wrote the second document over the first and
                # 5.6 MB across three files became unreachable: AMB, IMP and LMP
                # are each covered by two PDFs.
                key = (kode, jenis, dest_name)
                dok = existing.get(key)
                if dok is None:
                    dok = models.DokumenAlat(
                        kode_alat=kode, jenis=jenis, nama_file=dest_name
                    )
                    db.add(dok)
                    existing[key] = dok
                    rows_new += 1
                dok.judul = _judul(filename)
                dok.kelompok = row.kelompok
                dok.utama = is_utama

                # The primary document is still duplicated onto the parent, so
                # `_varian_payload()` and landing.html's spec card work exactly
                # as before. Only the primary, writing every document here is
                # what caused the overwrite in the first place.
                if is_utama and getattr(row, field) != dest_name:
                    setattr(row, field, dest_name)
                    attached += 1

    total = sum(len(c) for _, _, c in SPEK_MAP) + sum(len(c) for _, _, c in MANUAL_MAP)
    print(f"  dokumen       : {copied}/{total} lampiran siap, {attached} baru ditautkan")
    print(
        f"                  ({len(SPEK_MAP)} spektek + {len(MANUAL_MAP)} manual "
        f"→ uploads/dokumen_alat/), {rows_new} baris dokumen_alat baru"
    )
    if missing_files:
        print(f"  ! {len(missing_files)} berkas tidak ditemukan: {missing_files[:3]}")
    if unknown_codes:
        print(f"  ! kode alat tidak dikenal, dilewati: {sorted(unknown_codes)}")
