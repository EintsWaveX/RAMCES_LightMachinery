"""
Drop every table, recreate the schema, and reseed a clean demo database.

    py -3.10 reset.py

This is DESTRUCTIVE and irreversible: every asset, condition record, mutation,
calibration certificate row and stock movement is deleted, along with every
user account. It exists because the demo data grew inconsistencies that cannot
be patched in place — most notably repair history attributed to a Balaiyasa
workshop instead of the region that owns the asset, which made "BALAIYASA
CIREBONPRUNJAKAN" appear as a row in Laporan Perbaikan.

It refuses to run without an interactive confirmation, so it cannot be
triggered by accident from a script or an editor's run button. Pass --yes only
when you genuinely mean it (e.g. from a Makefile you control).

Note: uploaded certificate files under uploads/sertifikat/ are NOT touched.
The rows that referenced them are gone, so they become orphans on disk; delete
that directory by hand if you want a truly clean slate.
"""

import argparse
import sys

# The Windows console defaults to cp1252 and cannot encode the ✓ / ✗ markers the
# seed output uses; without this every run ends in a UnicodeEncodeError from
# `print` rather than from anything to do with the database.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

from sqlalchemy import inspect  # noqa: E402

import models
from database import engine


def _table_summary() -> str:
    """Row counts before the drop, so the confirmation prompt states the stakes."""
    inspector = inspect(engine)
    names = sorted(inspector.get_table_names())
    if not names:
        return "  (database kosong — tidak ada tabel)"

    lines = []
    with engine.connect() as conn:
        for name in names:
            try:
                from sqlalchemy import text as sa_text

                count = conn.execute(sa_text(f'SELECT COUNT(*) FROM "{name}"')).scalar()
                lines.append(f"  {name:<24} {count:>8,} baris")
            except Exception as exc:
                lines.append(f"  {name:<24} (gagal dihitung: {exc})")
    return "\n".join(lines)


def reset(total_aset: int = 100, with_history: bool = False) -> int:
    print("Menghapus seluruh tabel…")
    # drop_all only knows about tables declared in models.py. Anything created
    # outside it (a stray backup table, an old migration artefact) survives —
    # which is deliberate, since dropping unknown tables is not this script's
    # job.
    models.Base.metadata.drop_all(bind=engine)
    print("Membuat ulang skema…")
    models.Base.metadata.create_all(bind=engine)

    # Imported here, not at module scope: the seeds package runs create_all()
    # on import, and importing it before the drop would race the recreation.
    import seeds

    if with_history:
        print(
            f"Menyemai armada nyata dari modules/ + {total_aset} aset dummy "
            "berikut simulasi riwayat…\n"
        )
    else:
        print("Menyemai armada nyata dari modules/ (tanpa riwayat sintetis)…\n")
    code = seeds.run_steps(
        only=None, with_history=with_history, total_aset=total_aset
    )

    print(
        "\nSelesai. Akun SUPER_ADMIN awal dibuat oleh langkah `pengguna` — "
        "lihat keluarannya di atas untuk username dan password.\n"
        "Login TIDAK LAGI mendaftarkan pengguna baru secara otomatis, jadi itu "
        "adalah satu-satunya jalan masuk sampai admin membuat akun lain."
    )
    return code


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--aset",
        type=int,
        default=100,
        help="jumlah aset dummy yang dibuat (default: 100)",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="lewati konfirmasi interaktif (BERBAHAYA)",
    )
    parser.add_argument(
        "--with-history",
        action="store_true",
        help=(
            "tambahkan aset dummy beserta simulasi riwayat perbaikan/mutasi/"
            "kalibrasi. Tanpa ini, dashboard perbaikan dan kurva MCF kosong "
            "karena armada nyata belum punya riwayat apa pun."
        ),
    )
    args = parser.parse_args()

    print(__doc__)
    print(f"Database: {engine.url}\n")
    print("Isi saat ini:")
    print(_table_summary())
    print()

    if not args.yes:
        jawab = input('Ketik RESET untuk melanjutkan (apa pun yang lain membatalkan): ')
        if jawab.strip() != "RESET":
            print("Dibatalkan. Tidak ada yang diubah.")
            return 1

    return reset(args.aset, with_history=args.with_history)


if __name__ == "__main__":
    sys.exit(main())
