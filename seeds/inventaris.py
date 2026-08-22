"""
Kelola Inventaris seed data: warehouses, part categories, the sparepart
catalogue, and the opening stock ledger.

The end-to-end flow is ORDERED and this module preserves that order:

    gudang → kategori → sparepart → pergerakan → stok

With no warehouse the movement form has nothing to write to and refuses every
submit, so `gudang` genuinely must come first.

`SPAREPART_CATALOG` is keyed by the OLD invented alat-kerja codes, because that
is how the client's parts PDF is organised. Every key goes through
`remap_kode()` onto a real katalog `kode_alat`, and `remap_model()` supplies the
Model/Type the parts belong to where the old code named one, which is what lets
the repair form narrow the picker to the machine in front of the technician.
See EXTRA_ALAT_REMAP in seed_katalog.py for why that remapping exists at all.
"""

import random
from datetime import datetime, timedelta

from sqlalchemy import false, true

import models
from database import SessionLocal
from seed_katalog import EXTRA_ALAT_REMAP

# Physical parts stores. Deliberately FLAT and independent of the DAOP/UPT tree:
# `id_gudang` is the pool every balance is scoped by.
GUDANG_DATA = [
    ("GA", "Gudang A", "Gudang utama sparepart mekanik"),
    ("GB", "Gudang B", "Gudang cadangan / overflow"),
    ("GC", "Gudang C", "Gudang consumables"),
]

# (SERI_PREFIX lived here, unused and byte-identical to the copy in
#  seeds/dummy.py that IS used. Removed rather than duplicated.)


# ══════════════════════════════════════════════════════════════════════
# SPAREPART CATALOG SEED  (from PDF: DATA_PERBAIKAN_ALAT_KERJA 2026)
# ══════════════════════════════════════════════════════════════════════

# The 26-entry EXTRA_ALAT_DATA table that lived here is gone.
#
# It invented codes so the sparepart catalogue had something to hang off, but
# most of its entries are MODELS, not alat kerja, `HTT 220 V`, `HTT 3 PHASE`,
# `GEISMAR HTT` and `HTT PORTABLE` are four models of the single katalog entry
# `HTT HAND TIE TAMPER`, and four codes outright collided with a katalog code
# meaning something else. seed_katalog.EXTRA_ALAT_REMAP maps every one of them
# to (real kode_alat, model name); `remap_kode()` below is the single place
# SPAREPART_CATALOG's keys go through.


def remap_kode(kode: str) -> str:
    """Old catalogue key → the katalog `kode_alat` that actually owns it."""
    return EXTRA_ALAT_REMAP.get(kode, (kode, None))[0]


def remap_model(kode: str):
    """Old catalogue key → the model name it became, or None if it was already
    a real alat kerja. Used to attach parts to a specific Model/Type."""
    return EXTRA_ALAT_REMAP.get(kode, (None, None))[1]


# ── Subsystem groupings (Subsistem → part names) ─────────────────────
# Source: LIST_SPAREPART PDF
# Structure: { kode_alat: { subsistem: [part_names] } }
SPAREPART_CATALOG = {
    # ── GENSET 3 PHASE HTT (kode: HTTS / GEN shared) ─────────────────
    "HTTS": {
        "ELECTRIC": [
            "AVR 3 PHASE", "ROTOR GENSET 3 PHASE", "STATOR GENSET 3 PHASE",
            "CARBON BRUSH", "BREAKER 23A", "KABEL 3 PHASE", "COVER DINAMO",
            "SOCKET FEMALE", "KRAN BENSIN", "KABEL CABANG",
        ],
        "ENGINE": [
            "BUSI", "KOP BUSI", "KARBURATOR 390", "FILTER UDARA 390",
            "PACKING ENGINE 390", "KLEP 390", "RECOIL 390",
            "MOUNTING ENGINE GX390", "BLOK MESIN GX50", "PISTON GX50",
            "SELANG BENSIN", "STARTER PULLEY",
        ],
        "MECHANIC": [
            "GEARCASE", "BELIMBING", "STANG",
        ],
        "CONSUMABLES": [
            "OLI", "KARBU CLEANER", "GREASE", "PYLOX HITAM", "PYLOX KUNING",
        ],
    },

    # ── HTT 220 V ─────────────────────────────────────────────────────
    "HTT": {
        "ELECTRIC": [
            "MOTOR HTT 220V", "KABEL POWER", "SOCKET MALE", "SOCKET FEMALE",
            "KABEL 7 METER",
        ],
        "ENGINE": [
            "BUSI 2T", "KARBURATOR 2T", "RECOIL 2T", "FILTER UDARA",
            "PACKING ENGINE", "PISAU HTT", "KAMPAS KOPLING 2T",
            "BLOK MESIN 2T", "PISTON 2T", "MOUNTING ENGINE 2T",
            "SELANG BENSIN", "CAP BUSI 2T", "STARTER PULLEY",
        ],
        "MECHANIC": [
            "GEARCASE", "FLEKSIBEL", "RING NYLON", "BEARING 6206",
            "PISAU HTT", "TUTUP RING",
        ],
        "CONSUMABLES": [
            "OLI 2T", "KARBU CLEANER", "WD40", "PYLOX HITAM", "PYLOX KUNING",
        ],
    },

    # ── HTT PORTABLE ─────────────────────────────────────────────────
    "HTPE": {
        "ENGINE": [
            "BUSI 2T", "KARBURATOR 2T", "RECOIL 2T", "FILTER UDARA",
            "PACKING ENGINE", "KAMPAS KOPLING 2T", "SELANG BENSIN",
        ],
        "MECHANIC": [
            "GEARCASE", "FLEKSIBEL", "PISAU HTT", "RING NYLON",
        ],
        "CONSUMABLES": ["OLI 2T", "KARBU CLEANER"],
    },

    # ── MESIN POTONG/BABAT RUMPUT ─────────────────────────────────────
    "MPR": {
        "ENGINE": [
            "BUSI 4T", "KOP BUSI", "KARBURATOR 4T", "RECOIL 4T",
            "FILTER UDARA", "PACKING ENGINE", "KAMPAS KOPLING 4T",
            "KLEP", "MOUNTING ENGINE GX50", "BLOK MESIN GX50",
            "PISTON GX50", "SELANG BENSIN", "STARTER PULLEY", "CAP BUSI 4T",
        ],
        "MECHANIC": [
            "GEARCASE", "FLEKSIBEL", "TALI GENDONG", "COVER PISAU",
            "STANG", "AS ROLLER", "PER PEMBALIK",
        ],
        "CONSUMABLES": [
            "OLI 15W", "KARBU CLEANER", "GREASE",
        ],
    },

    # ── TRACK GAUGE ───────────────────────────────────────────────────
    "TRG": {
        "MECHANIC": [
            "RAKSA", "COVER AKRILIK", "COVER",
        ],
        "CONSUMABLES": [
            "BATERAI MILWAUKEE", "BATERAI DEWALT",
        ],
    },

    # ── DONGKRAK ANGKATAN MIN 10 TON ─────────────────────────────────
    "DKR": {
        "MECHANIC": [
            "GIGI VERTIKAL", "RING NYLON", "GREASE", "PLAT",
        ],
        "CONSUMABLES": ["GREASE", "WD40"],
    },

    # ── LORI DORONG 500 KG ────────────────────────────────────────────
    "LOR": {
        "MECHANIC": ["BEARING 6206", "RING NYLON", "BAUT SET M14"],
        "CONSUMABLES": ["GREASE"],
    },

    # ── MESIN BOR REL ─────────────────────────────────────────────────
    "BOR": {
        "ELECTRIC": ["KABEL POWER", "SOCKET FEMALE"],
        "ENGINE": [
            "BUSI 4T", "KARBURATOR", "RECOIL 4T", "FILTER UDARA",
            "SELANG BENSIN",
        ],
        "CONSUMABLES": ["OLI 15W", "KARBU CLEANER", "CUTTING DISC"],
    },

    # ── MESIN POTONG REL / CUTTING RAIL ──────────────────────────────
    "CRL": {
        "ENGINE": [
            "BUSI 4T", "KARBURATOR", "RECOIL 4T", "FILTER UDARA",
            "PACKING ENGINE",
        ],
        "MECHANIC": ["GEARCASE", "BEARING 6206"],
        "CONSUMABLES": ["CUTTING DISC", "OLI 15W", "WD40"],
    },

    # ── IMPACT WRENCH ─────────────────────────────────────────────────
    "IMP": {
        "ELECTRIC": [
            "CHARGER BATERAI MILWAUKEE", "CHARGER BATERAI DEWALT",
        ],
        "MECHANIC": [
            "SOCKET MALE", "LONG BOLT", "BAUT SET M17",
        ],
        "CONSUMABLES": [
            "BATERAI MILWAUKEE", "BATERAI DEWALT", "WD40",
        ],
    },

    # ── MESIN CHAINSAW ────────────────────────────────────────────────
    "CSW": {
        "ENGINE": [
            "BUSI 4T", "KARBURATOR", "RECOIL 4T", "FILTER UDARA",
            "SELANG BENSIN",
        ],
        "MECHANIC": [
            "GEARCASE", "RANTAI CHAINSAW", "COVER PISAU",
        ],
        "CONSUMABLES": ["OLI 15W", "KARBU CLEANER"],
    },

    # ── JACK HAMMER ───────────────────────────────────────────────────
    "JHM": {
        "MECHANIC": [
            "MATA BOR JACK HAMMER", "RING NYLON", "BAUT SET M8",
        ],
        "CONSUMABLES": ["GREASE", "WD40"],
    },

    # ── GENSET 1 PHASE (PENERANGAN) ───────────────────────────────────
    "GEN1": {
        "ELECTRIC": [
            "AVR 1 PHASE", "ROTOR GENSET 1 PHASE", "STATOR GENSET 1 PHASE",
            "CARBON BRUSH", "BREAKER 10A", "KABEL 1 PHASE", "SOCKET FEMALE",
        ],
        "ENGINE": [
            "BUSI", "KARBURATOR GX160", "RECOIL GX160", "FILTER UDARA",
            "PACKING ENGINE", "SELANG BENSIN", "KRAN BENSIN",
        ],
        "CONSUMABLES": ["OLI", "KARBU CLEANER", "PYLOX HITAM"],
    },

    # ── MESIN GERINDA MP 12 ───────────────────────────────────────────
    "GRD": {
        "ELECTRIC": ["KABEL POWER", "SOCKET MALE"],
        "MECHANIC": ["COVER AKRILIK", "MATA GERINDA"],
        "CONSUMABLES": ["CUTTING DISC", "GREASE"],
    },

    # ── MESIN GERINDA TANGAN ──────────────────────────────────────────
    "GRT": {
        "ELECTRIC": ["KABEL POWER"],
        "MECHANIC": ["COVER AKRILIK", "MATA GERINDA 4\"", "MATA GERINDA 7\""],
        "CONSUMABLES": ["CUTTING DISC", "WD40"],
    },

    # ── MESIN LAS ─────────────────────────────────────────────────────
    "MLS": {
        "ELECTRIC": ["KABEL LAS", "ELECTRODE HOLDER", "EARTH CLAMP"],
        "CONSUMABLES": ["KAWAT LAS", "GREASE"],
    },

    # ── LAMPU PENERANGAN / STAND ──────────────────────────────────────
    "LMP": {
        "ELECTRIC": ["LAMPU LED", "KABEL POWER", "FITTING LAMPU"],
        "MECHANIC": ["TIANG STAND", "KLEM TIANG"],
        "CONSUMABLES": ["BATERAI"],
    },

    # ── ALAT UKUR KEAUSAN REL ─────────────────────────────────────────
    "AUK": {
        "MECHANIC": ["RAKSA", "MISTAR UKUR", "COVER AKRILIK"],
        "CONSUMABLES": ["BATERAI"],
    },

    # ── MESIN SCRAP THERMIT ───────────────────────────────────────────
    "MST": {
        "MECHANIC": ["CETAKAN THERMIT", "KLEM THERMIT"],
        "CONSUMABLES": ["PASTA THERMIT", "KAWAT LAS", "WD40"],
    },
}

# Unit defaults per part type keyword
def _guess_unit(nama: str) -> str:
    n = nama.upper()
    if any(k in n for k in ["KABEL", "SELANG", "TALI"]):
        return "Meter"
    if any(k in n for k in ["OLI", "KARBU CLEANER", "WD40", "GREASE"]):
        return "Liter"
    if any(k in n for k in ["DISC", "CUTTING", "KAWAT LAS"]):
        return "Pcs"
    if "BATERAI" in n:
        return "Unit"
    return "Pcs"

# Min-stock heuristic: consumables = 5, others = 2
def _min_stok(subsistem: str) -> int:
    return 5 if subsistem == "CONSUMABLES" else 2


# Indicative unit prices in rupiah, by subsystem. Without a price the stock
# dashboard's value KPIs are all Rp0, which makes the whole panel useless.
_HARGA_BAND = {
    "ELECTRIC":    (150_000, 2_500_000),
    "ENGINE":      (75_000, 1_800_000),
    "MECHANIC":    (50_000, 1_200_000),
    "CONSUMABLES": (25_000, 250_000),
    "PEKERJAAN":   (100_000, 750_000),
}


def _harga_satuan(subsistem: str) -> int:
    lo, hi = _HARGA_BAND.get(subsistem, (50_000, 500_000))
    # Round to the nearest 5k so the figures read like real price-list entries.
    return int(round(random.randint(lo, hi) / 5_000) * 5_000)


def seed_spareparts():
    """
    Seeds sparepart_kategori and sparepart tables from the PDF catalog.

    The catalogue is keyed by the OLD invented codes, so every key goes through
    `remap_kode()` onto a real katalog `kode_alat`, and `remap_model()` gives
    the Model/Type the parts belong to where the old code named one, which is
    what lets the repair form filter parts down to the machine in front of the
    technician. Safe to run multiple times (skips existing rows).
    """
    db = SessionLocal()
    try:
        # ── 1. Resolve each catalogue key to (kode_alat, id_varian) ────
        # kategori_alat is no longer extended here: seed_master_alat() owns it,
        # and the codes this used to invent were models all along.
        #
        # `id_varian` is set ONLY where the old code named one of SEVERAL
        # competing models of the same tool, the HTT family (HTT 220 V,
        # HTT 3 PHASE, GEISMAR HTT, HTT PORTABLE) is the case the column exists
        # for, since a 220 V carburettor genuinely does not fit the 3-phase unit.
        #
        # Where an old code maps 1:1 onto a tool with no sibling (LMP → LMP,
        # DSM → DSM, MBK → MBK), the parts were catalogued against the TOOL
        # TYPE, not against a verified model. Claiming model-specificity there
        # is an over-claim, and a damaging one: real assets carry models from
        # the Rekap and the import workbook, so pinning the catalogue to the
        # remapped legacy model made the repair form's compatibility filter
        # return nothing at all for almost every machine in the fleet.
        # Leaving id_varian NULL means "fits every model of this tool", which
        # is both true and useful.
        sources_per_kode: dict = {}
        for old_kode in SPAREPART_CATALOG:
            sources_per_kode.setdefault(remap_kode(old_kode), []).append(old_kode)

        model_id: dict = {}
        for old_kode in SPAREPART_CATALOG:
            kode = remap_kode(old_kode)
            nama_model = remap_model(old_kode)
            if not nama_model or len(sources_per_kode[kode]) < 2:
                continue  # tool-generic, see above
            row = (
                db.query(models.AlatVarian)
                .filter_by(kode_alat=kode, nama_varian=nama_model)
                .first()
            )
            if row:
                model_id[old_kode] = row.id_varian
        print(
            f"✓ katalog sparepart dipetakan: {len(model_id)} kunci spesifik "
            f"Model/Type, sisanya berlaku untuk semua model alatnya."
        )

        # ── 2. Build SparePartKategori (one row per kode_alat+subsistem) ─
        kat_cache: dict[tuple, int] = {}  # (kode_alat, subsistem) → id_kategori

        for old_kode, subsystems in SPAREPART_CATALOG.items():
            kode_alat = remap_kode(old_kode)
            for subsistem in subsystems:
                key = (kode_alat, subsistem)
                existing = (
                    db.query(models.SparePartKategori)
                    .filter_by(subsistem=subsistem, kode_alat=kode_alat)
                    .first()
                )
                if existing:
                    kat_cache[key] = existing.id_kategori
                else:
                    # nama = "ENGINE, MESIN POTONG REL" style
                    alat_row = db.query(models.KategoriAlat).filter_by(kode_alat=kode_alat).first()
                    alat_nama = alat_row.nama_alat if alat_row else kode_alat
                    nama_kat = f"{subsistem} – {alat_nama}"
                    new_kat = models.SparePartKategori(
                        nama=nama_kat,
                        subsistem=subsistem,
                        kode_alat=kode_alat,
                    )
                    db.add(new_kat)
                    db.flush()
                    kat_cache[key] = new_kat.id_kategori
        db.commit()
        print("✓ sparepart_kategori seeded.")

        # ── 3. Seed SparePart rows ────────────────────────────────────
        #
        # No SKU is minted any more. `sparepart.sku` was dropped along with the
        # "Identifikasi" and "Informasi Tambahan" blocks of the Tambah Suku
        # Cadang form; a part is identified by (nama_part, kode_alat, id_varian),
        # which is exactly what the dedupe below keys on, so the identity the
        # catalogue relies on is unchanged.
        inserted_parts = 0
        skipped_parts = 0

        for old_kode, subsystems in SPAREPART_CATALOG.items():
            kode_alat = remap_kode(old_kode)
            id_varian = model_id.get(old_kode)
            for subsistem, parts in subsystems.items():
                id_kat = kat_cache.get((kode_alat, subsistem))
                for nama_part in parts:
                    # Dedupe on the MODEL too, not just the tool type. Four old
                    # catalogue keys collapse onto HTT alone, and each is a
                    # different machine, a "BUSI" for the 220 V unit is not the
                    # same row as the 3-phase one. Keying on kode_alat only
                    # would have silently dropped every part after the first.
                    existing = (
                        db.query(models.SparePart)
                        .filter_by(
                            nama_part=nama_part,
                            kode_alat=kode_alat,
                            id_varian=id_varian,
                        )
                        .first()
                    )
                    if existing:
                        skipped_parts += 1
                        continue

                    db.add(models.SparePart(
                        nama_part=nama_part,
                        id_kategori=id_kat,
                        kode_alat=kode_alat,
                        id_varian=id_varian,
                        unit=_guess_unit(nama_part),
                        harga_satuan=_harga_satuan(subsistem),
                        stok_min=_min_stok(subsistem),
                        auto_demand=true() if subsistem == "CONSUMABLES" else false(),
                    ))
                    inserted_parts += 1

        db.commit()
        print(f"✓ sparepart seeded: {inserted_parts} inserted, {skipped_parts} skipped.")
        print("Seed spareparts selesai.")

    except Exception as e:
        db.rollback()
        print(f"Error saat seed_spareparts: {e}")
        raise
    finally:
        db.close()


def seed_gudang():
    """
    Seeds the flat warehouse list, and ONLY that.

    This function used to be `seed_gudang_dan_varian()` and did three unrelated
    things: create warehouses, assign a RANDOM Model/Type to every asset that
    lacked one, and stamp a RANDOM nomor_seri on every asset that lacked one.

    The latter two are now in `seeds/dummy.py`, where the rest of the invented
    data lives, because applying them to the imported fleet was fabrication of
    the worst kind: a serial number is what a technician reads off the machine's
    nameplate to confirm they are looking at the right unit, and a made-up one
    that RAMCES presents as fact is actively misleading in the field. The model
    assignment was the same problem one level up, the importer already resolves
    each workbook row's Model column and creates a visibly-incomplete row when it
    cannot, which is the honest outcome.
    """
    db = SessionLocal()
    try:
        added_g = 0
        for kode, nama, ket in GUDANG_DATA:
            if not db.query(models.Gudang).filter_by(kode=kode).first():
                db.add(models.Gudang(kode=kode, nama=nama, keterangan=ket))
                added_g += 1
        db.commit()
        print(f"✓ gudang seeded: {added_g} baru.")

    except Exception as e:
        db.rollback()
        print(f"Error saat seed_gudang: {e}")
        raise
    finally:
        db.close()


# Fixed seed, so `reset.py` is REPRODUCIBLE.
#
# This generator used the global `random`, which meant every full reset produced
# a different number of ledger rows (936 one day, 1021 the next) for identical
# inputs. `seed.py` was still idempotent, the step skips a populated table, but
# two resets could not be compared, which is precisely the check that catches a
# seeding regression.
#
# A private Random instance rather than `random.seed()`: seeding the global
# would silently make seeds/dummy.py's simulation deterministic too, which is a
# behaviour change in a module this one has no business reaching into.
_STOK_RNG_SEED = 20260815


def seed_stok_awal():
    """
    Seeds opening stock balances and a year of movement history.

    Without any ledger rows every part reports stok=0, which makes all 200+ of
    them "critical" and leaves the stock dashboard showing zero value. This
    creates a believable mix: most parts healthy, some low, a few empty.

    Reproducible: identical inputs give an identical ledger, so two resets can
    be compared row for row.
    """
    rng = random.Random(_STOK_RNG_SEED)
    db = SessionLocal()
    try:
        if db.query(models.SparePartStok).count() > 0:
            print("• sparepart_stok sudah terisi — dilewati.")
            return

        gudang_ids = [g.id_gudang for g in db.query(models.Gudang).all()]
        if not gudang_ids:
            print("! Tidak ada gudang — jalankan seed_gudang() dulu.")
            return

        user = db.query(models.Pengguna).first()
        uid = user.id_pengguna if user else None
        parts = db.query(models.SparePart).all()
        now = datetime.now()
        rows = 0

        for p in parts:
            gudang = rng.choice(gudang_ids)
            stok_min = p.stok_min or 2

            # Opening receipt, ~12 months ago.
            opening_qty = rng.randint(stok_min * 3, stok_min * 12)
            opening_at = now - timedelta(days=rng.randint(300, 400))
            db.add(models.SparePartStok(
                id_part=p.id_part, id_gudang=gudang, tipe_gerakan="IN",
                jumlah=opening_qty, harga_satuan=p.harga_satuan,
                keterangan="Stok awal", id_pengguna=uid, waktu=opening_at,
            ))
            rows += 1
            balance = opening_qty

            # A year of consumption, with the occasional restock.
            waktu = opening_at
            for _ in range(rng.randint(0, 8)):
                waktu += timedelta(days=rng.randint(15, 70))
                if waktu >= now:
                    break
                if rng.random() < 0.25:
                    qty = rng.randint(stok_min, stok_min * 5)
                    db.add(models.SparePartStok(
                        id_part=p.id_part, id_gudang=gudang, tipe_gerakan="IN",
                        jumlah=qty, harga_satuan=p.harga_satuan,
                        keterangan="Pembelian rutin", id_pengguna=uid, waktu=waktu,
                    ))
                    balance += qty
                    rows += 1
                elif balance > 0:
                    # Never issue more than is on hand, the ledger must not go
                    # negative, or the dashboard reports phantom MINUS rows.
                    qty = rng.randint(1, max(1, min(balance, stok_min * 3)))
                    db.add(models.SparePartStok(
                        id_part=p.id_part, id_gudang=gudang, tipe_gerakan="OUT",
                        jumlah=qty, harga_satuan=p.harga_satuan,
                        keterangan="Pemakaian perbaikan", id_pengguna=uid, waktu=waktu,
                    ))
                    balance -= qty
                    rows += 1

            # A small tail of parts is deliberately drained to empty so the
            # "Kosong" and "Kritis" counters are exercised.
            if balance > 0 and rng.random() < 0.12:
                db.add(models.SparePartStok(
                    id_part=p.id_part, id_gudang=gudang, tipe_gerakan="OUT",
                    jumlah=balance, harga_satuan=p.harga_satuan,
                    keterangan="Pemakaian perbaikan", id_pengguna=uid,
                    waktu=now - timedelta(days=rng.randint(1, 20)),
                ))
                rows += 1

        db.commit()
        print(f"✓ sparepart_stok seeded: {rows} pergerakan untuk {len(parts)} part.")

    except Exception as e:
        db.rollback()
        print(f"Error saat seed_stok_awal: {e}")
        raise
    finally:
        db.close()



def run(db):
    """Registry entry point. Each helper below opens its own session, which is
    why `db` is accepted but not threaded through, they predate the registry
    and their transactional boundaries are load-bearing (seed_stok_awal in
    particular must see the parts committed by seed_spareparts)."""
    seed_spareparts()
    seed_gudang()
    # Previously never called at all, which is why every part reported stok 0
    # and the whole catalogue showed as "Kritis" on a freshly seeded database.
    seed_stok_awal()
