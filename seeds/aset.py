"""
Import the real fleet from `modules/Template_Import_Aset_RAMCES.xlsx`.

1,121 rows across four sheets that were maintained separately and disagree about
almost everything — see `seed_aset_real.py`, which still owns the reading and
cleaning. This module owns the WRITING.

── The idempotency bug this module was written to fix ──

`seed_aset_real()` issued each asset a sequence number from the sheet, and on
collision re-issued it from `max(urutan) + 1`. That is correct for two sheets
that number independently. It is catastrophic on a SECOND RUN: every row already
imported collides with itself, gets a fresh number, and is inserted again under
a new id. Running `seed.py` twice therefore DOUBLED the entire real fleet
silently — the database this was written against held 2,242 assets for a
1,121-row workbook, and nothing anywhere reported it.

The fix is to key on IDENTITY rather than on sequence. A workbook row is
identified by everything about it that is not the sequence number:

    (kode_alat, id_pengadaan, tahun, unit, parent, id_lokasi)

Identities are COUNTED, not just matched: a bucket holding three identical
workbook rows imports three assets the first time and none the second. Only
genuinely new rows are issued a sequence number, and only then does the
collision handling apply.

This is imperfect in one direction and deliberately so: a workbook that lists
two physically distinct but otherwise identical machines at the same resort
imports as one on a re-run. That is the right trade — a missed duplicate is
visible and correctable, whereas a silently doubled fleet corrupts every count,
every dashboard and every availability percentage with no signal at all.

See `_identity()` for why the Model column is not part of the key.
"""

import os

import models
from seed_aset_real import PERUNTUKAN_MAP, PROSES_NOTE, WORKBOOK, read_rows


def _identity(row) -> tuple:
    """
    What makes a workbook row the same row on a later import.

    The Model column is deliberately NOT part of this. It looks like it should
    be — it is the most specific field on the row — but it is the one field that
    does not survive a round trip: `resolve_model()` matches loosely (three
    passes, then containment) because the sheets' model strings are free text
    typed by four different people, so "HONDA GX 160" in the workbook can
    legitimately resolve to an `alat_varian` row named something else entirely.
    Comparing the workbook text against the stored `nama_varian` therefore
    reported 255 of 1,121 rows as new on every re-run.

    Dropping it costs nothing measurable here: the workbook has 400 distinct
    buckets with the model included and 400 without, and not one bucket contains
    two rows that differ only by model. If a future workbook does list two
    different models of the same tool, same year, same resort, same unit, they
    will import as one on a re-run — a missed duplicate, which is visible and
    correctable, rather than a doubled fleet, which is not.
    """
    return (
        row["kode_alat"],
        row["id_pengadaan"],
        row["tanggal"].year,
        row["unit"],
        row["parent"],
        row["id_lokasi"],
    )


def _existing_identities(db) -> dict:
    """
    Identities already in the database, built from the asset rows themselves.

    The id encodes kode/pengadaan/year/unit/parent; `id_lokasi` comes from the
    column. `<urutan>.<kode>.<pengadaan>.<yy>.<unit>.<lokasi>`,
    where the location segment may itself contain dots (JR1.1), so the tail is
    re-joined exactly as `decodeAsetId()` does on the client.
    """
    out = {}
    q = db.query(
        models.Aset.id_aset,
        models.Aset.id_lokasi,
        models.Aset.tanggal_pembelian,
        models.Aset.kode_alat,
        models.Aset.sumber_pengadaan,
        models.Aset.peruntukan,
    )

    letter_of = {v: k for k, v in PERUNTUKAN_MAP.items()}
    for id_aset, id_lokasi, tanggal, kode, pengadaan, peruntukan in q:
        parts = str(id_aset).split(".")
        if len(parts) < 6:
            continue  # legacy dash-form id, not something this importer wrote
        parent = ".".join(parts[5:])
        key = (
            kode,
            1 if (pengadaan or "").upper().startswith("PUSAT") else 2,
            tanggal.year if tanggal else None,
            letter_of.get(peruntukan, "A"),
            parent,
            id_lokasi,
        )
        out.setdefault(key, 0)
        out[key] += 1
    return out


def run(db, path: str = WORKBOOK):
    if not os.path.exists(path):
        print(f"  ! {path} tidak ditemukan — impor aset dilewati.")
        return

    from seed_aset_real import resolve_model

    rows, skipped = read_rows(path)

    # `aset.id_lokasi` is a foreign key, so an unknown code aborts the whole
    # insert batch rather than skipping one row. Validate against the real table
    # and fall back to the asset's parent region, which always exists — a resort
    # we cannot place is still better recorded at its DAOP than lost.
    known_lokasi = {r[0] for r in db.query(models.Lokasi.id_lokasi).all()}
    unplaced = {}
    for row in rows:
        if row["id_lokasi"] not in known_lokasi:
            unplaced[row["id_lokasi"]] = unplaced.get(row["id_lokasi"], 0) + 1
            row["id_lokasi"] = row["parent"]
    if unplaced:
        print(f"  ! kode lokasi tidak dikenal, dipulangkan ke induk: {unplaced}")

    # ── The idempotency gate ──
    present = _existing_identities(db)

    # Highest sequence already in use per kode_alat, so new rows top up rather
    # than colliding. Taken from max(), never from a row COUNT: with count + 1,
    # deleting any asset of that kode_alat made the next create reuse a live
    # number and fail the collision check permanently.
    used = {}
    for (id_aset,) in db.query(models.Aset.id_aset).all():
        head, _, tail = str(id_aset).partition(".")
        kode = tail.split(".")[0] if tail else ""
        if head.isdigit():
            used.setdefault(kode, set()).add(int(head))

    system_user = (
        db.query(models.Pengguna).filter_by(username="SYSTEM").first()
        or db.query(models.Pengguna).order_by(models.Pengguna.id_pengguna).first()
    )
    if system_user is None:
        system_user = models.Pengguna(username="SYSTEM", role="SUPER_ADMIN")
        db.add(system_user)
        db.flush()

    cache = {}
    created = existing = provisional = renumbered = 0

    for row in rows:
        key = _identity(row)
        if present.get(key):
            present[key] -= 1
            existing += 1
            continue

        kode = row["kode_alat"]
        taken = used.setdefault(kode, set())
        urut = row["urut"]
        if urut is None or urut in taken:
            urut = (max(taken) + 1) if taken else 1
            renumbered += 1
        taken.add(urut)

        year_str = str(row["tanggal"].year)[-2:]
        id_aset = (
            f"{urut}.{kode}.{row['id_pengadaan']}.{year_str}."
            f"{row['unit']}.{row['parent']}"
        )

        varian = resolve_model(db, kode, row["model"], cache)

        db.add(
            models.Aset(
                id_aset=id_aset,
                kode_alat=kode,
                id_lokasi=row["id_lokasi"],
                tanggal_pembelian=row["tanggal"],
                sumber_pengadaan=row["sumber_pengadaan"],
                status_terakhir="SO",
                peruntukan=row["peruntukan"],
                id_varian=varian.id_varian if varian else None,
            )
        )
        db.add(
            models.RiwayatKondisi(
                id_aset=id_aset,
                id_pengguna=system_user.id_pengguna,
                kondisi="SO",
                keterangan=PROSES_NOTE if row["tanggal_provisional"] else "Aset Baru",
                id_lokasi=row["id_lokasi"],
                peruntukan=row["peruntukan"],
            )
        )
        created += 1
        provisional += 1 if row["tanggal_provisional"] else 0

    print(f"  aset          : {created} baru, {existing} sudah ada  (dari {len(rows)} baris)")
    if renumbered:
        print(f"                  {renumbered} nomor urut diterbitkan ulang (bentrok antar sheet)")
    if provisional:
        print(f"                  {provisional} tanggal pembelian provisional (kolom 'PROSES')")
    if skipped["kode_tidak_dikenal"]:
        print(f"  ! kode alat tidak dikenal: {skipped['kode_tidak_dikenal']}")
    if skipped["tanpa_parent"]:
        print(f"  ! {skipped['tanpa_parent']} baris tanpa Parent Lokasi, dilewati")
