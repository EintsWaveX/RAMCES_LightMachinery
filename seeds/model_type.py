"""
Model/Type rows (`alat_varian`), the second level of tool identity.

The data comes from `seed_katalog.iter_all_models()`, which merges three
sources in order: the 14 fully-specified models transcribed from
`Rekap Spek RAMCES.docx`, the legacy models reshaped onto the Rekap's five
free-form label/value spec pairs, and the ex-alat-kerja codes rescued by
`EXTRA_ALAT_REMAP` (things like `HTT 220 V` that were never alat kerja at all,
only models of `HTT HAND TIE TAMPER`).
"""

import models
from seed_katalog import iter_all_models

# Written on every run so a shorter spec CLEARS a slot it no longer fills,
# except that a None is never written over an existing value, see below.
SPEC_FIELDS = [
    f"spek{i}_{part}" for i in range(1, 6) for part in ("label", "nilai")
] + ["merk", "tipe_model", "foto_url", "url_spek", "url_manual", "keterangan"]


def run(db):
    known = {row[0] for row in db.query(models.KategoriAlat.kode_alat).all()}
    added = updated = skipped = 0

    for m in iter_all_models():
        if m["kode_alat"] not in known:
            skipped += 1
            continue

        row = (
            db.query(models.AlatVarian)
            .filter_by(kode_alat=m["kode_alat"], nama_varian=m["nama_varian"])
            .first()
        )
        if row is None:
            db.add(models.AlatVarian(**m))
            added += 1
            continue

        changed = False
        for field in SPEC_FIELDS:
            # Never overwrite a hand-entered value with None, an admin who
            # filled a slot the seed leaves blank must not lose it on the next
            # run. This is why the seed can be re-run against a live database.
            new = m.get(field)
            if new is not None and getattr(row, field) != new:
                setattr(row, field, new)
                changed = True
        updated += 1 if changed else 0

    print(f"  alat_varian   : {added} baru, {updated} diperbarui")
    if skipped:
        print(f"  ! {skipped} model dilewati — kode alat induk tidak ada")
