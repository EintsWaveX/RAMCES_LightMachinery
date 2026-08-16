"""
RAMCES database management — the one command line over `seeds/`.

    py -3.10 manage.py seed                    # every default step, in order
    py -3.10 manage.py seed --only dokumen     # just re-attach the client's PDFs
    py -3.10 manage.py seed --with-history     # + 100 demo assets and a simulation
    py -3.10 manage.py list                    # what the steps are
    py -3.10 manage.py verify                  # check without writing anything
    py -3.10 manage.py reset                   # DESTRUCTIVE: drop, recreate, reseed
    py -3.10 manage.py status                  # row counts, no writes

`seed.py` and `reset.py` used to be two loose root scripts holding nothing but
argparse — 229 lines between them, with `reset.py` duplicating the seed's
console-encoding fix, its own `--aset` handling and its own summary printing.
Merging them removes the duplication and, more usefully, puts the DESTRUCTIVE
verb behind a subcommand instead of behind a filename one tab-completion away
from the safe one.

Three things live at the repo root beside this file and stay there deliberately:
`seed_katalog.py`, `seed_katalog_sfm.py` and `seed_aset_real.py`. They are the
reviewable "what the client's spreadsheets actually say" layer and none of them
writes to the database — a change in any of them should show up in review as a
data change, which it cannot do from inside a package of writers.

Requires `.env` (DATABASE_URL, SECRET_KEY) and, for anything that seeds real
data, the client's `modules/` drop.
"""

import argparse
import sys

# The Windows console defaults to cp1252, which cannot encode the ✓ / ✗ / ·
# markers or the Indonesian ▸ used throughout the seed output — every run used
# to end in a UnicodeEncodeError from `print`, not from anything to do with the
# database. Force UTF-8 before importing anything that prints.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass  # already UTF-8, or a stream that does not support it

from sqlalchemy import inspect, text as sa_text  # noqa: E402

import models  # noqa: E402
from database import engine  # noqa: E402

RESET_DOC = """
Drop every table, recreate the schema, and reseed from scratch.

DESTRUCTIVE and irreversible: every asset, condition record, mutation,
calibration row, stock movement and user account is deleted. It refuses to run
without typing RESET, so it cannot be triggered by an editor's run button.

Uploaded files under uploads/ are NOT touched. The rows referencing them are
gone, so they become orphans on disk — delete the directory by hand for a truly
clean slate, or leave it and re-run `manage.py seed --only dokumen`.
"""


# ── Shared helpers ────────────────────────────────────────────────────

def _table_summary() -> str:
    """Row counts, so the reset prompt states the stakes and `status` is useful."""
    inspector = inspect(engine)
    names = sorted(inspector.get_table_names())
    if not names:
        return "  (database kosong — tidak ada tabel)"

    lines = []
    with engine.connect() as conn:
        for name in names:
            try:
                count = conn.execute(sa_text(f'SELECT COUNT(*) FROM "{name}"')).scalar()
                lines.append(f"  {name:<24} {count:>8,} baris")
            except Exception as exc:  # noqa: BLE001 — a summary must not raise
                lines.append(f"  {name:<24} (gagal dihitung: {exc})")
    return "\n".join(lines)


def _add_seed_flags(parser: argparse.ArgumentParser) -> None:
    """The two flags `seed` and `reset` share, defined once."""
    parser.add_argument(
        "--with-history",
        action="store_true",
        help=(
            "tambahkan aset contoh beserta simulasi riwayat. MATI secara "
            "default: armada yang diimpor itu NYATA, dan riwayat perbaikan yang "
            "dikarang terhadapnya tidak bisa dibedakan dari fakta di kemudian "
            "hari. Tanpa ini, dashboard perbaikan, kurva MCF dan Laporan "
            "Perbaikan memang KOSONG."
        ),
    )
    parser.add_argument(
        "--simulasi",
        action="store_true",
        help=(
            "tambahkan riwayat operasional ke setiap aset yang belum punya: "
            "kondisi SO/TSO/AFKIR beserta transisinya, mutasi, kalibrasi dan "
            "pemakaian sparepart. MATI secara default. SETIAP BARIS DITANDAI "
            "atas nama pengguna 'SIMULASI' dan diberi awalan [SIMULASI], dan "
            "bisa dihapus seluruhnya lagi dengan `manage.py hapus-simulasi`."
        ),
    )
    parser.add_argument(
        "--aset",
        type=int,
        default=100,
        metavar="N",
        help=(
            "jumlah aset contoh yang dituju saat --with-history (default: 100). "
            "Ini TARGET populasi, bukan jumlah yang ditambahkan: menjalankannya "
            "dua kali tidak menggandakan apa pun."
        ),
    )


# ── Subcommands ───────────────────────────────────────────────────────

def cmd_seed(args) -> int:
    import seeds

    only = [s.strip() for s in args.only.split(",")] if args.only else None

    # `--aset` without `--with-history` used to be a silent no-op: reset.py
    # threaded the number all the way into run_steps(), which then skipped the
    # dummy step entirely because with_history was False. Nothing was written
    # and nothing was said. Refuse the combination instead — a flag that is
    # quietly ignored is worse than one that is rejected.
    if args.aset != 100 and not (args.with_history or (only and "dummy" in only)):
        print(
            "! --aset hanya berlaku untuk langkah `dummy`, yang tidak aktif.\n"
            "  Tambahkan --with-history (atau --only dummy), atau hapus --aset."
        )
        return 2

    return seeds.run_steps(
        only=only,
        with_history=args.with_history,
        total_aset=args.aset,
        simulasi_on=args.simulasi,
    )


def cmd_hapus_simulasi(_args) -> int:
    """
    Remove every simulated row and restore each asset's opening state.

    Not destructive the way `reset` is: it touches ONLY rows attributed to the
    SIMULASI account, and restores `status_terakhir` / `id_lokasi` from the
    opening `RiwayatKondisi` the importer wrote — a row the simulation never
    touches. Real data, and anything a user actually filed, is out of reach by
    construction, which is why this needs no confirmation prompt.
    """
    from database import SessionLocal
    from seeds import simulasi

    db = SessionLocal()
    try:
        simulasi.hapus(db)
    finally:
        db.close()
    return 0


def cmd_list(_args) -> int:
    import seeds

    print("Langkah yang tersedia:\n")
    for name, _fn, desc, default_on in seeds.STEPS:
        mark = " " if default_on else "*"
        print(f"  {mark} {name:<12} {desc}")
    print("\n  * tidak dijalankan kecuali diminta (--only dummy / --with-history)")
    return 0


def cmd_verify(_args) -> int:
    import seeds

    return 0 if seeds.verify_all() else 1


def cmd_status(_args) -> int:
    print(f"Database: {engine.url}\n")
    print(_table_summary())

    # Simulated rows are called out SEPARATELY, so a database carrying
    # fabricated history can never be mistaken for one that does not. This is
    # the whole bargain that makes the simulation acceptable against a real
    # fleet: it is marked, it is countable, and it is removable.
    with engine.connect() as conn:
        try:
            uid = conn.execute(
                sa_text("SELECT id_pengguna FROM pengguna WHERE username = 'SIMULASI'")
            ).scalar()
        except Exception:  # noqa: BLE001 — a status view must not raise
            uid = None
        if uid:
            print("\n  Data SIMULASI (bertanda, dapat dihapus):")
            for tbl in (
                "riwayat_kondisi",
                "riwayat_mutasi",
                "riwayat_kalibrasi",
                "sparepart_stok",
            ):
                try:
                    n = conn.execute(
                        sa_text(f"SELECT COUNT(*) FROM {tbl} WHERE id_pengguna = :u"),
                        {"u": uid},
                    ).scalar()
                    print(f"    {tbl:<24} {n:>8,} baris")
                except Exception:  # noqa: BLE001
                    pass
            print("    → hapus dengan: py -3.10 manage.py hapus-simulasi")
    return 0


def cmd_reset(args) -> int:
    print(RESET_DOC)
    print(f"Database: {engine.url}\n")
    print("Isi saat ini:")
    print(_table_summary())
    print()

    if not args.yes:
        jawab = input("Ketik RESET untuk melanjutkan (apa pun yang lain membatalkan): ")
        if jawab.strip() != "RESET":
            print("Dibatalkan. Tidak ada yang diubah.")
            return 1

    if args.aset != 100 and not args.with_history:
        print(
            "! --aset hanya berlaku bersama --with-history. Dibatalkan sebelum "
            "menghapus apa pun."
        )
        return 2

    print("Menghapus seluruh tabel…")
    # drop_all only knows about tables declared in models.py. Anything created
    # outside it (a stray backup table, an old migration artefact) survives,
    # which is deliberate — dropping unknown tables is not this command's job.
    # It is also why every new table must be DECLARED in models.py and not
    # created by raw DDL in _ensure_schema() alone: a raw-DDL-only table
    # survives the drop and then collides with the recreate.
    models.Base.metadata.drop_all(bind=engine)
    print("Membuat ulang skema…")
    models.Base.metadata.create_all(bind=engine)

    # Imported HERE, not at module scope: `seeds` runs create_all() on import,
    # and importing it before the drop would race the recreation.
    import seeds

    if args.with_history:
        print(
            f"Menyemai armada nyata dari modules/ + {args.aset} aset contoh "
            "berikut simulasi riwayat…\n"
        )
    else:
        print("Menyemai armada nyata dari modules/ (tanpa riwayat sintetis)…\n")

    code = seeds.run_steps(
        only=None,
        with_history=args.with_history,
        total_aset=args.aset,
        simulasi_on=args.simulasi,
    )

    print(
        "\nSelesai. Akun SUPER_ADMIN awal dibuat oleh langkah `pengguna` — lihat "
        "keluarannya di atas untuk username dan password.\n"
        "Login TIDAK mendaftarkan pengguna baru secara otomatis; itu satu-satunya "
        "jalan masuk sampai admin membuat atau menyetujui akun lain."
    )
    return code


# ── Entry point ───────────────────────────────────────────────────────

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="manage.py",
        description="Kelola basis data RAMCES.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = parser.add_subparsers(dest="perintah", metavar="PERINTAH")

    p_seed = sub.add_parser("seed", help="isi / tambal basis data (tidak merusak)")
    p_seed.add_argument(
        "--only",
        metavar="LANGKAH",
        help="jalankan hanya langkah ini (dipisah koma). Lihat `manage.py list`.",
    )
    _add_seed_flags(p_seed)
    p_seed.set_defaults(func=cmd_seed)

    p_list = sub.add_parser("list", help="tampilkan daftar langkah seeding")
    p_list.set_defaults(func=cmd_list)

    p_verify = sub.add_parser("verify", help="jalankan verifikasi saja, tanpa menulis")
    p_verify.set_defaults(func=cmd_verify)

    p_status = sub.add_parser("status", help="tampilkan jumlah baris per tabel")
    p_status.set_defaults(func=cmd_status)

    p_hapus = sub.add_parser(
        "hapus-simulasi",
        help="hapus seluruh riwayat SIMULASI, pulihkan kondisi awal setiap aset",
    )
    p_hapus.set_defaults(func=cmd_hapus_simulasi)

    p_reset = sub.add_parser(
        "reset",
        help="HAPUS SEMUA, buat ulang skema, semai dari nol",
        description=RESET_DOC,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p_reset.add_argument(
        "--yes", action="store_true", help="lewati konfirmasi interaktif (BERBAHAYA)"
    )
    _add_seed_flags(p_reset)
    p_reset.set_defaults(func=cmd_reset)

    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 2
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
