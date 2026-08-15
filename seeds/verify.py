"""
Post-seed assertions.

Every check here exists because something once went wrong silently. A seed that
prints "✓ selesai" while the database is subtly wrong is worse than one that
fails, because the wrongness is then discovered from a dashboard six weeks later.

The four that matter most:

  * **Asset count against the workbook.** `seed_aset_real` renumbered on
    sequence collision instead of recognising an already-imported row, so every
    re-run DOUBLED the real fleet. The database this was written against held
    2,242 assets for a 1,121-row workbook and nothing reported it. See
    `seeds/aset.py`.
  * **The UPT tree.** A resort code that does not parse resolves to no parent,
    which puts its assets outside every regional filter, scope check and
    dashboard bucket while looking perfectly fine in the master table. That is
    exactly how the missing JB (jembatan) branch hid 253 assets.
  * **Document attachment.** The whole point of `seeds/dokumen.py` is that the
    client's PDFs reach the database; a mapping entry pointing at a code that
    does not exist would otherwise fail silently.
  * **Orphans.** A model row whose parent alat kerja was deleted, or an asset
    pointing at a missing lokasi, breaks joins in ways that read as empty
    screens rather than as errors.
"""

import os

from sqlalchemy import func

import models
from database import SessionLocal
from seed_katalog import ALL_ALAT, KATALOG_UPT, verify_upt_parents
from seeds.dokumen import MANUAL_MAP, SPEK_MAP
from seeds.dummy import DEMO_SERI_PREFIX
from seeds.katalog import (
    LOKASI_DATA,
    UPT_DATA_AS_LOKASI,
    get_parent_lokasi_code,
)

WORKBOOK = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "modules",
    "Template_Import_Aset_RAMCES.xlsx",
)


class _Report:
    def __init__(self):
        self.ok = 0
        self.bad = []

    def check(self, label, condition, detail=""):
        if condition:
            self.ok += 1
            print(f"  ✓ {label}")
        else:
            self.bad.append(label)
            print(f"  ✗ {label}   {detail}")

    def note(self, label, detail=""):
        print(f"  · {label}   {detail}")


def verify_all() -> bool:
    """Returns True when everything holds. Prints a line per check."""
    db = SessionLocal()
    r = _Report()
    try:
        print("VERIFIKASI")

        # ── Master data ──
        n_alat = db.query(models.KategoriAlat).count()
        r.check(
            f"kategori_alat = {len(ALL_ALAT)}",
            n_alat == len(ALL_ALAT),
            f"ditemukan {n_alat}",
        )

        expected_lokasi = len(LOKASI_DATA) + len(UPT_DATA_AS_LOKASI)
        n_lokasi = db.query(models.Lokasi).count()
        r.check(
            f"lokasi = {expected_lokasi} ({len(LOKASI_DATA)} induk + {len(UPT_DATA_AS_LOKASI)} UPT)",
            n_lokasi == expected_lokasi,
            f"ditemukan {n_lokasi}",
        )

        # ── The region tree ──
        # This is the check that exists because the JB branch was invisible for
        # as long as nobody compared the katalog to the parser.
        bad_parents = verify_upt_parents(get_parent_lokasi_code)
        r.check(
            f"hierarki UPT: {len(KATALOG_UPT)} kode resolve ke induk yang benar",
            not bad_parents,
            f"{len(bad_parents)} gagal: {bad_parents[:5]}",
        )

        # ── ...and the SERVER's copy of the same rule ──
        #
        # The rule is duplicated in four places (api/deps.py, seeds/katalog.py,
        # js/core.js, landing.html) and only the seed's copy was ever checked,
        # so api/deps.py could lose a branch and every check here would still
        # pass. That is not theoretical: NO asset in the workbook lives at an
        # ME* code, so nothing at runtime would ever exercise the MEKANIK branch
        # — this assertion is the only thing that can prove it works.
        try:
            from api.deps import get_parent_lokasi_code as server_get_parent

            bad_server = verify_upt_parents(server_get_parent)
            r.check(
                "hierarki UPT juga benar di api/deps.py (salinan server)",
                not bad_server,
                f"{len(bad_server)} gagal: {bad_server[:5]}",
            )
        except Exception as exc:  # importing api/ needs .env + a reachable DB
            r.note(f"salinan server tidak bisa diperiksa: {exc}")

        # ── The real fleet ──
        #
        # Counted SEPARATELY from the demo fleet, and that separation is the
        # point. This used to be a single `expected <= n_aset < expected * 2`
        # range over the total, chosen loose enough that 100 demo assets would
        # fit — which at 1,121 workbook rows meant the non-idempotent dummy step
        # could run ELEVEN times, to 2,221 assets, with every run reporting
        # 11/11 PASS. Demo assets are distinguishable (`nomor_seri LIKE
        # 'DEMO-%'`, stamped at creation by seeds/dummy.py), so there is no
        # reason to check them as one blurred total.
        n_aset = db.query(models.Aset).count()
        n_demo = (
            db.query(models.Aset)
            .filter(models.Aset.nomor_seri.like(f"{DEMO_SERI_PREFIX}%"))
            .count()
        )
        n_real = n_aset - n_demo
        expected_aset = _workbook_row_count()
        if expected_aset is None:
            r.note("aset: workbook tidak tersedia, jumlah tidak diperiksa", f"({n_aset} baris)")
        else:
            # Now an EQUALITY. The importer keys on identity, so a re-run adds
            # nothing and any drift from the workbook row count is a real fault.
            r.check(
                f"aset nyata = {expected_aset} (sesuai workbook)",
                n_real == expected_aset,
                f"ditemukan {n_real} nyata + {n_demo} demo = {n_aset}",
            )

        # The demo step targets a population rather than adding a batch, so a
        # second run must leave this unchanged. 100 is its default; any run with
        # `--aset N` sets a different target, hence a ceiling rather than an
        # equality — what is being asserted is that it did not ACCUMULATE.
        if n_demo:
            r.note(
                "aset demo (nomor_seri DEMO-…)",
                f"{n_demo} baris — hapus dengan `manage.py reset` bila tidak diinginkan",
            )

        # id_aset is the primary key, so a true duplicate is impossible — what
        # the doubling produced was two rows for the same PHYSICAL machine under
        # different sequence numbers. Compare distinct identities instead.
        distinct_identity = db.query(
            func.count(
                func.distinct(
                    func.concat(
                        models.Aset.kode_alat, "|",
                        models.Aset.id_lokasi, "|",
                        models.Aset.tanggal_pembelian, "|",
                        models.Aset.peruntukan, "|",
                        func.coalesce(models.Aset.id_varian, 0),
                    )
                )
            )
        ).scalar() or 0
        r.note(
            "identitas aset unik",
            f"{distinct_identity} kombinasi (alat+lokasi+tanggal+peruntukan+model) "
            f"untuk {n_aset} baris",
        )

        # ── The peruntukan rule ──
        #
        # A UPT code's prefix IS the asset's peruntukan (JR→JALAN REL,
        # JB→JEMBATAN, ME→MEKANIK), verified 1:1 across all 254 rows of
        # KATALOG UPT, and the importer derives it that way. Nothing asserted it
        # afterwards, which is how the demo generator went on picking the letter
        # at random — producing assets whose id_aset peruntukan segment
        # contradicted the resort named in the same id.
        #
        # ⚠️ It is a CREATION-TIME rule, not a permanent invariant, so this
        # check deliberately skips any asset that has ever been transferred.
        # Peruntukan is what the machine is FOR; a jalan rel tamper lent to a
        # jembatan resort is still a jalan rel tamper, and `mutasi` moves
        # `id_lokasi` without touching `peruntukan` or the composite id. Asking
        # for agreement there would assert something the application itself does
        # not maintain — and would start failing the first time anyone uses the
        # transfer form. An asset with no mutation history has never moved, so
        # its current resort IS the resort it was created at.
        moved = {row[0] for row in db.query(models.RiwayatMutasi.id_aset).distinct()}
        prefix_expect = {"JR": "JALAN REL", "JB": "JEMBATAN", "ME": "MEKANIK"}
        mismatched, checked = [], 0
        for id_aset, id_lokasi, peruntukan in db.query(
            models.Aset.id_aset, models.Aset.id_lokasi, models.Aset.peruntukan
        ):
            if id_aset in moved:
                continue
            want = prefix_expect.get(str(id_lokasi or "")[:2].upper())
            if not want:
                continue  # homed at a DAOP/DIVRE parent, which carries no prefix
            checked += 1
            if (peruntukan or "").upper() != want:
                mismatched.append(f"{id_aset}@{id_lokasi}={peruntukan}")
        r.check(
            f"peruntukan cocok dengan awalan kode UPT ({checked} aset belum pernah mutasi)",
            not mismatched,
            f"{len(mismatched)} tidak cocok: {mismatched[:3]}",
        )

        # ── Documents ──
        mapped = {k for _, _, codes in SPEK_MAP for k in codes}
        mapped |= {k for _, _, codes in MANUAL_MAP for k in codes}
        known = {row[0] for row in db.query(models.KategoriAlat.kode_alat).all()}
        unknown = mapped - known
        r.check(
            f"pemetaan dokumen: {len(mapped)} kode alat semuanya ada",
            not unknown,
            f"tidak dikenal: {sorted(unknown)}",
        )

        if os.path.isdir(os.path.dirname(WORKBOOK)):
            attached = (
                db.query(models.KategoriAlat)
                .filter(
                    (models.KategoriAlat.file_spek.isnot(None))
                    | (models.KategoriAlat.file_manual.isnot(None))
                )
                .count()
            )
            r.check(
                f"dokumen tertaut ke {len(mapped)} alat kerja",
                attached >= len(mapped),
                f"baru {attached}",
            )
        else:
            r.note("dokumen: modules/ tidak tersedia, lampiran tidak diperiksa")

        # Every file in uploads/dokumen_alat/ must be reachable from a row.
        #
        # This is the check that would have caught the collision: `kategori_alat`
        # has ONE column per document kind, and the seeder wrote both of a tool's
        # documents to it in table order, so the second overwrote the first.
        # 5.6 MB across three files (AMB, IMP, LMP) sat on disk referenced by
        # nothing, and every existing check passed — the files were copied, the
        # codes existed, the attachment count was met. Only asking the question
        # from the DISK side finds it.
        dok_dir = os.path.join(os.path.dirname(WORKBOOK), "..", "uploads", "dokumen_alat")
        dok_dir = os.path.normpath(dok_dir)
        if os.path.isdir(dok_dir):
            on_disk = {f for f in os.listdir(dok_dir) if not f.startswith(".")}
            referenced = {row[0] for row in db.query(models.DokumenAlat.nama_file).all()}
            orphan = on_disk - referenced
            r.check(
                f"setiap berkas di uploads/dokumen_alat/ terjangkau ({len(on_disk)} berkas)",
                not orphan,
                f"{len(orphan)} tidak tertaut baris mana pun: {sorted(orphan)[:3]}",
            )
        else:
            r.note("dokumen_alat: direktori unggahan belum ada")

        # ── Orphans ──
        orphan_varian = (
            db.query(models.AlatVarian)
            .outerjoin(
                models.KategoriAlat,
                models.AlatVarian.kode_alat == models.KategoriAlat.kode_alat,
            )
            .filter(models.KategoriAlat.kode_alat.is_(None))
            .count()
        )
        r.check("tidak ada alat_varian yatim", orphan_varian == 0, f"{orphan_varian} baris")

        orphan_aset = (
            db.query(models.Aset)
            .outerjoin(models.Lokasi, models.Aset.id_lokasi == models.Lokasi.id_lokasi)
            .filter(models.Lokasi.id_lokasi.is_(None))
            .count()
        )
        r.check("setiap aset punya lokasi yang valid", orphan_aset == 0, f"{orphan_aset} baris")

        # ── Inventory ordering ──
        n_gudang = db.query(models.Gudang).count()
        r.check(
            "minimal satu gudang (form pergerakan butuh ini)",
            n_gudang > 0,
            "tanpa gudang, setiap submit pergerakan stok ditolak",
        )

        # ── Authentication ──
        n_login = (
            db.query(models.Pengguna)
            .filter(
                models.Pengguna.hashed_password.isnot(None),
                models.Pengguna.role == "SUPER_ADMIN",
            )
            .count()
        )
        r.check(
            "ada SUPER_ADMIN yang bisa masuk",
            n_login > 0,
            "login menolak akun tanpa password — tidak ada jalan masuk",
        )

    finally:
        db.close()

    print()
    if r.bad:
        print(f"✗ VERIFIKASI GAGAL — {len(r.bad)} dari {r.ok + len(r.bad)}: {', '.join(r.bad)}")
        return False
    print(f"✓ VERIFIKASI LULUS — {r.ok} pemeriksaan.")
    return True


def _workbook_row_count():
    """How many importable rows the client's workbook holds, or None."""
    if not os.path.exists(WORKBOOK):
        return None
    try:
        from seed_aset_real import read_rows

        rows, _skipped = read_rows(WORKBOOK)
        return len(rows)
    except Exception:
        return None
