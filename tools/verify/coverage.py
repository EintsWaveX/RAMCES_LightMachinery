"""
modules/ -> database coverage. Every row and every file in the client's drop,
counted on both sides.
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
os.chdir(ROOT)

from sqlalchemy import text  # noqa: E402
from database import engine  # noqa: E402
import seed_katalog_sfm as sfm  # noqa: E402
import seed_aset_real as sar  # noqa: E402


def main():
    k = sfm.read_katalog()
    rows, skipped = sar.read_rows()
    gaps = []

    def line(label, sheet_n, db_n, note=""):
        ok = sheet_n == db_n
        if not ok:
            gaps.append(f"{label}: modules={sheet_n} db={db_n}")
        print(f"  {'OK ' if ok else 'GAP'}  {label:<42} {sheet_n:>5} -> {db_n:>5}  {note}")

    with engine.connect() as c:
        q = lambda s: c.execute(text(s)).scalar()

        print("KATALOG SFM.xlsx")
        line("KATALOG ALAT KERJA rows", len(k.alat), q("SELECT count(*) FROM kategori_alat") - 1,
             "(db has +1: BKC, marked 'Tidak Ditemukan' in the sheet)")
        line("  ...with alat_ukur = TRUE", sum(1 for r in k.alat if r[2]),
             q("SELECT count(*) FROM kategori_alat WHERE alat_ukur"))
        line("  ...with kalibrasi = TRUE", sum(1 for r in k.alat if r[3]),
             q("SELECT count(*) FROM kategori_alat WHERE perlu_kalibrasi"))
        line("  ...kelompok tags (H/I side table)", len(k.kelompok),
             q("SELECT count(*) FROM kategori_alat WHERE kelompok IS NOT NULL"))
        line("KATALOG LOKASI rows", len(k.lokasi),
             q("SELECT count(*) FROM lokasi WHERE tipe <> 'UPT'"))
        line("KATALOG UPT rows", len(k.upt),
             q("SELECT count(*) FROM lokasi WHERE tipe = 'UPT'") - 3,
             "(db has +3: BY*A workshop rows, not in the sheet)")
        for unit, pre in (("JALAN REL", "JR"), ("JEMBATAN", "JB"), ("MEKANIK", "ME")):
            line(f"  ...UNIT = {unit}",
                 sum(1 for r in k.upt if r[4] == unit),
                 q(f"SELECT count(*) FROM lokasi WHERE tipe='UPT' AND id_lokasi LIKE '{pre}%'"))

        print("\nTemplate_Import_Aset_RAMCES.xlsx")
        line("asset rows (4 sheets)", len(rows), q("SELECT count(*) FROM aset"))
        line("  ...opening RiwayatKondisi", len(rows), q("SELECT count(*) FROM riwayat_kondisi"))
        for p in ("JALAN REL", "JEMBATAN", "MEKANIK", "BALAIYASA"):
            line(f"  ...peruntukan {p}",
                 sum(1 for r in rows if r["peruntukan"] == p),
                 q(f"SELECT count(*) FROM aset WHERE peruntukan = '{p}'"))
        print(f"  --   rows skipped on import                      {skipped}")

        print("\nDocuments on disk")
        docs = []
        for sub in ("Manual Instruction Alat Kerja", "Spesifikasi Lengkap Alat Kerja"):
            for dirpath, _d, names in os.walk(os.path.join("modules", sub)):
                docs += [os.path.join(dirpath, n) for n in names]
        # Counted from `dokumen_alat`, NOT from kategori_alat.file_spek /
        # file_manual. Those are one column each, so when a tool is covered by
        # two documents the second overwrote the first — AMB, IMP and LMP each
        # lost one that way, 5.6 MB reachable by nothing. Counting the columns
        # therefore reported the loss as normal and could never have flagged it.
        # The DISK side is what makes this a real check.
        on_disk_uploads = (
            len(os.listdir("uploads/dokumen_alat"))
            if os.path.isdir("uploads/dokumen_alat")
            else 0
        )
        served = q("SELECT count(DISTINCT nama_file) FROM dokumen_alat")
        line("documents reachable from a dokumen_alat row", on_disk_uploads, served,
             f"({len(docs)} source files in modules/, {on_disk_uploads - served} unreachable)")
        line("...primary document per (alat, jenis)",
             q("SELECT count(DISTINCT (kode_alat, jenis)) FROM dokumen_alat"),
             q("SELECT count(*) FROM dokumen_alat WHERE utama"))

    print()
    if gaps:
        print(f"REMAINING GAPS ({len(gaps)}):")
        for g in gaps:
            print(f"  - {g}")
    else:
        print("NO GAPS — every row in modules/ is in the database")
    return 0


if __name__ == "__main__":
    sys.exit(main())
