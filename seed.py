"""
Seed / top up the RAMCES database. Non-destructive.

    py -3.10 seed.py                      # every default step, in order
    py -3.10 seed.py --only dokumen       # just re-attach the client's PDFs
    py -3.10 seed.py --only katalog,model # master data and Model/Type
    py -3.10 seed.py --list               # what the steps are
    py -3.10 seed.py --verify             # check without writing anything
    py -3.10 seed.py --with-history       # + 100 demo assets and a simulation

Every step is idempotent: running this twice changes nothing the second time,
and `--verify` asserts that. That property is new — the previous importer
renumbered on sequence collision instead of recognising a row it had already
imported, so a second run silently DOUBLED the real fleet. See seeds/aset.py.

The steps themselves live in `seeds/`, one module per concern. This file is only
the command line over them; `seed_katalog.py` remains the DATA (the
transcription of the client's spreadsheets and the Rekap) and holds no writers.

To wipe and start over instead, use `reset.py`.
"""

import argparse
import sys

# The Windows console defaults to cp1252, which cannot encode the ✓ / ✗ / ·
# markers or the Indonesian ▸ used throughout the seed output — every run
# ended in a UnicodeEncodeError from `print`, not from anything to do with the
# database. Force UTF-8 before importing anything that prints.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass  # already UTF-8, or a stream that does not support it

import seeds  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Seed / top up the RAMCES database (non-destructive).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--only",
        metavar="LANGKAH",
        help="jalankan hanya langkah ini (dipisah koma). Lihat --list.",
    )
    parser.add_argument("--list", action="store_true", help="tampilkan daftar langkah")
    parser.add_argument(
        "--verify",
        action="store_true",
        help="hanya jalankan verifikasi, tanpa menulis apa pun",
    )
    parser.add_argument(
        "--with-history",
        action="store_true",
        help=(
            "tambahkan 100 aset contoh beserta simulasi riwayat. MATI secara "
            "default: armada yang diimpor itu NYATA, dan riwayat perbaikan yang "
            "dikarang terhadapnya tidak bisa dibedakan dari fakta di kemudian "
            "hari. Tanpa ini, dashboard perbaikan, kurva MCF dan Laporan "
            "Perbaikan memang KOSONG."
        ),
    )
    parser.add_argument(
        "--aset",
        type=int,
        default=100,
        help="jumlah aset contoh saat --with-history (default: 100)",
    )
    args = parser.parse_args()

    if args.list:
        print("Langkah yang tersedia:\n")
        for name, _fn, desc, default_on in seeds.STEPS:
            mark = " " if default_on else "*"
            print(f"  {mark} {name:<12} {desc}")
        print("\n  * tidak dijalankan kecuali diminta (--only dummy / --with-history)")
        return 0

    if args.verify:
        return 0 if seeds.verify_all() else 1

    only = [s.strip() for s in args.only.split(",")] if args.only else None
    return seeds.run_steps(
        only=only, with_history=args.with_history, total_aset=args.aset
    )


if __name__ == "__main__":
    sys.exit(main())
