"""
RAMCES seeding — an ordered registry of idempotent steps.

This replaced a single 1,274-line `seed.py` that mixed master data, the real
fleet import, a synthetic history generator, the sparepart catalogue, warehouses
and the opening stock ledger. Splitting it buys three things:

  * **Every step can be run alone.** `py -3.10 manage.py seed --only dokumen` re-attaches
    the client's PDFs without touching 1,121 asset rows.
  * **Every step is idempotent, and that is now ASSERTED.** The previous
    `seed_aset_real` renumbered on sequence collision instead of recognising a
    row it had already imported, so a second `seed.py` run silently DOUBLED the
    real fleet — the database this rewrite was written against held 2,242 assets
    for a 1,121-row workbook. `verify_all()` would have caught that on the first
    re-run.
  * **A new developer can find things.** One concern per module, named after the
    thing it seeds.

── Order matters ──

    lokasi → kategori_alat → dokumen → alat_varian → aset
           → sparepart → gudang → stok → pengguna

`alat_varian` must exist before the asset import, because each workbook row
names its model as free text that the importer resolves against that table.
`dokumen` runs early because it writes to `kategori_alat`, which the model rows
then inherit from.

`seed_katalog.py` keeps its separate role: it is the DATA — the transcription of
`KATALOG SFM.xlsx` and `Rekap Spek RAMCES.docx` — and holds no writers.
"""

import sys
import traceback

import models
from database import SessionLocal, engine

# Tables must exist before any step runs. `create_all` adds missing TABLES only;
# missing COLUMNS on an existing table are handled by `_ensure_schema()` in
# main.py, which is the project's migration mechanism.
models.Base.metadata.create_all(bind=engine)

from seeds import (  # noqa: E402  (import after create_all, deliberately)
    aset,
    dokumen,
    dummy,
    inventaris,
    katalog,
    model_type,
    pengguna,
)
from seeds.verify import verify_all  # noqa: E402


# ── The registry ──────────────────────────────────────────────────────
#
# (name, callable, description, default_on)
#
# `default_on=False` marks a step that is NOT part of a normal seed. There is
# exactly one: `dummy`, whose synthetic maintenance simulation is the only
# reason the repair dashboard, the MCF curve and Laporan Perbaikan have anything
# to plot. It stays off because the imported fleet is REAL, and repair records
# invented against real assets are indistinguishable from fact a year later.
STEPS = [
    # Counted from the workbook, not written down: this line said "UPT (240)"
    # for a whole release while the katalog sheet held 254, and nothing
    # contradicted it because the number was prose.
    (
        "katalog",
        katalog.run,
        f"Alat kerja ({len(katalog.ALL_ALAT)}), lokasi ({len(katalog.LOKASI_DATA)}), "
        f"UPT ({len(katalog.UPT_DATA_AS_LOKASI)})",
        True,
    ),
    ("dokumen", dokumen.run, "Spektek & manual dari modules/ ke uploads/", True),
    ("model", model_type.run, "Model/Type (alat_varian) dari Rekap Spek", True),
    ("aset", aset.run, "Armada nyata dari Template_Import_Aset_RAMCES.xlsx", True),
    ("inventaris", inventaris.run, "Gudang, kategori, sparepart, stok awal", True),
    ("pengguna", pengguna.run, "Akun SUPER_ADMIN awal", True),
    ("dummy", dummy.run, "100 aset contoh + simulasi riwayat perawatan", False),
]

STEP_NAMES = [name for name, _, _, _ in STEPS]


def run_steps(only=None, with_history: bool = False, total_aset: int = 100) -> int:
    """
    Execute the registry in order. Returns a process exit code.

    Each step gets its OWN session and commits itself, so a failure late in the
    list does not roll back the work that already succeeded — re-running picks
    up where it stopped rather than starting from nothing.
    """
    selected = set(only) if only else None
    if selected:
        unknown = selected - set(STEP_NAMES)
        if unknown:
            print(f"! langkah tidak dikenal: {sorted(unknown)}")
            print(f"  pilihan: {', '.join(STEP_NAMES)}")
            return 2

    failures = []
    for name, fn, desc, default_on in STEPS:
        if selected is not None:
            if name not in selected:
                continue
        elif not default_on:
            if not (name == "dummy" and with_history):
                continue

        print(f"\n── {name} · {desc}")
        db = SessionLocal()
        try:
            kwargs = {"total_aset": total_aset} if name == "dummy" else {}
            fn(db, **kwargs)
            db.commit()
        except Exception as exc:  # noqa: BLE001 — report and continue
            db.rollback()
            failures.append(name)
            print(f"  ! GAGAL: {exc}")
            traceback.print_exc(limit=3)
        finally:
            db.close()

    if failures:
        print(f"\n✗ {len(failures)} langkah gagal: {', '.join(failures)}")
        return 1

    print("\n" + "=" * 62)
    return 0 if verify_all() else 1


# `seed_all()` was kept as a backwards-compatible shim and had no callers —
# seed.py and reset.py both call run_steps() directly.
__all__ = ["STEPS", "STEP_NAMES", "run_steps", "verify_all"]
