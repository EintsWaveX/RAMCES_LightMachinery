"""
Simulated operational history, marked, reversible, and off by default.

A default `manage.py seed` produces a system that is entirely green: all 1,121
assets `SO`, one opening condition row each, and zero mutations, calibrations or
part usage. Five dashboard panels are therefore empty or meaningless on a fresh
install, Matriks Kesiapan, Grafik Ketersediaan, Tren Perbaikan, Laporan
Perbaikan and Kurva MCF.

This module fills them. It exists in tension with a rule the rest of this
package enforces hard, *the imported fleet is REAL, and repair records invented
against it are indistinguishable from fact a year later*, so it resolves that
tension rather than ignoring it:

  * **Every fabricated row is attributed to a dedicated `SIMULASI` account** and
    every `keterangan` is tagged `[SIMULASI]`. `id_pengguna` already exists on
    `riwayat_kondisi`, `riwayat_mutasi`, `riwayat_kalibrasi` and
    `sparepart_stok`, so one join finds all of it. `pemakaian_sparepart` has no
    such column but is reached through `id_riwayat` and `id_stok`.
  * **A user sees it without being told.** The history screens print who filed
    each entry, so a simulated repair reads "SIMULASI" beside a tagged note.
  * **It cannot become a live identity.** `hashed_password` stays NULL, exactly
    like the `SYSTEM` importer account, so nobody can log in as it.
  * **It is exactly reversible.** See `hapus()`.

── Why the undo needs no snapshot table ──

`seeds/aset.py` writes each asset's opening `RiwayatKondisi` with
`id_lokasi = <the import location>` and `id_pengguna = SYSTEM`, and
`seeds/dummy.py` does the same for its demo assets. That row is never touched by
this module. So undoing is: delete everything attributed to SIMULASI, then
restore each asset's `status_terakhir` and `id_lokasi` from its surviving
opening row. Nothing else has to be remembered.

── One generator, not two ──

The state machine below used to live inside `seeds/dummy.py`'s creation loop,
which is why it only ever ran against the 100 demo assets. It carries four rules
that took three rounds to get right, the Balaiyasa attribution rule, the
peruntukan redistribution rule, calibration gated on the katalog flag, and the
"never home an asset at a workshop" safety net. Writing a second copy for the
real fleet would have duplicated all four. `dummy.py` imports this instead, so
its history is marked too: it is equally fabricated, and until now was
indistinguishable from a technician's entry.
"""

import random
from datetime import datetime, time, timedelta

import models
from seeds.katalog import get_parent_lokasi_code

# ── The marker ────────────────────────────────────────────────────────
SIMULASI_USERNAME = "SIMULASI"
SIMULASI_TAG = "[SIMULASI]"


def tag(text: str) -> str:
    """Prefix a keterangan so it is recognisable in the UI without a join."""
    return f"{SIMULASI_TAG} {text}"


# Fixed seed, for the same reason `seeds/inventaris.py` and `seeds/dummy.py`
# have one: two runs from the same reset must produce identical data, or the
# verification harness cannot hold a baseline and no two demos look alike.
_SIM_RNG_SEED = 20260816

# ── Tuning, and why it is not just "pick some weights" ────────────────
#
# The first cut reused the demo generator's numbers unchanged and produced a
# fleet that was **21% written off and 37% currently broken**. Those weights
# were fine for 100 demo machines bought 2015, 2023; against the real fleet,
# 1,055 of 1,121 bought in 2025 or 2026, they compound into a maintenance
# record that would be alarming rather than illustrative, and a demo nobody
# believes is worse than an empty one.
#
# Three corrections, each modelling something real:
#
#   * **Time-to-repair is not time-between-failures.** This was the interesting
#     one. A single event gap made every repair take two to thirteen months, so
#     a machine that broke usually had not been fixed by the time the simulation
#     reached today, and 37% of the fleet came out "currently under repair" no
#     matter how the failure weights were tuned. Availability is not really a
#     function of how often things break; it is a function of how fast they come
#     back. Splitting the two gaps moved SO from 60% to 85% on its own.
#   * **Write-off is BUDGET-CONSTRAINED, not per-machine random.** AFKIR is an
#     absorbing state, so any per-event probability compounds toward "eventually
#     everything is scrapped" as the simulated period lengthens, which is how
#     the first run reached 21%. A fleet-level quota is easier to reason about
#     and closer to how the decision is actually made.
#   * **A machine does not stay broken forever.** An asset left TSO by the last
#     event is repaired if that failure is old. `sedang` on the repair dashboard
#     is deliberately a point-in-time count, so a stale TSO corrupts exactly the
#     number that is hardest to sanity-check.
#
# Result: 85.0% SO · 11.1% TSO · 3.9% AFKIR, targets a rail maintenance fleet
# would recognise. `seeds/verify.py` asserts the result lands in that band, so a
# future retune cannot quietly produce nonsense again.
GAP_SEHAT_HARI = (60, 400)    # SO → next notable event
GAP_PERBAIKAN_HARI = (5, 40)  # TSO → repaired and back in service
AFKIR_QUOTA_PCT = 0.04        # of the whole fleet, not per asset
TSO_BASI_HARI = 90            # backstop: a failure older than this was dealt with

PELAKSANA_KALIBRASI = [
    "BALAI KALIBRASI KAI",
    "PT KAI BALAI YASA",
    "LAB METROLOGI BANDUNG",
    "BSN - KAN TERAKREDITASI",
]

KALIBRASI_KETERANGAN = {
    "LULUS": "Hasil kalibrasi sesuai toleransi.",
    "BERSYARAT": "Deviasi kecil, layak pakai dengan pemantauan.",
    "GAGAL": "Deviasi melebihi ambang; perlu perbaikan/kalibrasi ulang.",
}


def simulasi_user(db):
    """
    The account every fabricated row is attributed to.

    `hashed_password` is left NULL on purpose: `login()` refuses an account
    without one, so this marker can never be used to get into the system. Same
    arrangement as the `SYSTEM` importer account.
    """
    user = db.query(models.Pengguna).filter_by(username=SIMULASI_USERNAME).first()
    if not user:
        user = models.Pengguna(
            username=SIMULASI_USERNAME,
            hashed_password=None,
            role="TEKNISI",
            id_lokasi=None,
            status="NONAKTIF",
            nama_lengkap="Data simulasi (bukan pengguna nyata)",
        )
        db.add(user)
        db.flush()
    return user


# ══════════════════════════════════════════════════════════════════════
# Context, the lookups the state machine needs, built once
# ══════════════════════════════════════════════════════════════════════

class SimContext:
    """
    Everything `simulate_history()` needs that does not vary per asset.

    Built once per run. The stock map in particular is loaded ONCE and
    decremented in memory as the simulation consumes: calling `_net_stok_map()`
    per repair would be ~1,100 grouped queries over the whole ledger, and the
    simulation is the only writer while it runs.
    """

    def __init__(self, db, rng=None, populasi=None):
        self.db = db
        self.rng = rng or random.Random(_SIM_RNG_SEED)
        self.now = datetime.now()
        self.user = simulasi_user(db)
        self.id_pengguna = self.user.id_pengguna

        all_lokasi = db.query(models.Lokasi).all()
        self.balaiyasa_ids = [
            l.id_lokasi for l in all_lokasi if l.tipe.upper() == "BALAIYASA"
        ]
        parent_ids = [
            l.id_lokasi
            for l in all_lokasi
            if l.tipe.upper() in {"DAOP", "DIVRE", "PUSAT", "BALAIYASA"}
        ]
        operational = [
            l.id_lokasi
            for l in all_lokasi
            if l.tipe.upper() in {"DAOP", "DIVRE", "UPT"}
            and not self.is_balaiyasa_side(l.id_lokasi)
        ]
        self.bengkel_ids = self.balaiyasa_ids or parent_ids

        # Operational resorts bucketed by the peruntukan their code implies, so
        # a redistribution can stay inside its own unit. See the note in
        # seeds/dummy.py on UPT_PREFIX_TO_LETTER.
        from seeds.dummy import peruntukan_letter_for

        self._letter_of = peruntukan_letter_for
        self.redistribusi_pool: dict = {}
        for _id in operational:
            self.redistribusi_pool.setdefault(peruntukan_letter_for(_id), []).append(_id)

        # Which tool types actually get calibrated, straight from the katalog
        # flag rather than a hardcoded set, a genset is serviced, not
        # calibrated, and seeding certificates for one would be fiction.
        self.kalibrasi_codes = {
            row[0]
            for row in db.query(models.KategoriAlat.kode_alat)
            .filter(models.KategoriAlat.perlu_kalibrasi.is_(True))
            .all()
        }

        # ── Sparepart consumption ──
        # Parts that fit each tool type, and the live balance per (part, gudang).
        # `id_varian IS NULL` means "fits every model of this tool", the common
        # case, so it is included for every asset of that kode_alat.
        self.parts_by_alat: dict = {}
        for p in db.query(models.SparePart).all():
            if p.kode_alat:
                self.parts_by_alat.setdefault(p.kode_alat, []).append(p)

        from api.inventaris import _net_stok_map

        self.stok: dict = {}
        for id_gudang in [g.id_gudang for g in db.query(models.Gudang).all()]:
            for id_part, qty in _net_stok_map(db, id_gudang=id_gudang).items():
                self.stok[(id_part, id_gudang)] = qty

        # Write-off budget, scaled to the population ACTUALLY BEING SIMULATED.
        # AFKIR is an absorbing state, so a per-event probability compounds
        # toward scrapping everything as the simulated period lengthens; a quota
        # does not.
        #
        # `populasi` matters: sized against the whole fleet, a `--only dummy`
        # run let its 100 demo machines absorb a budget meant for 1,221 and came
        # out 29% scrapped. The cap has to mean "4% of what this run touches".
        n = populasi if populasi is not None else db.query(models.Aset).count()
        self.afkir_sisa = max(1, int(n * AFKIR_QUOTA_PCT))

        self.counts = {
            "kondisi": 0, "mutasi": 0, "kalibrasi": 0, "pemakaian": 0, "aset": 0,
        }

    def boleh_afkir(self) -> bool:
        """Spend one unit of the write-off budget, if there is any left."""
        if self.afkir_sisa <= 0:
            return False
        self.afkir_sisa -= 1
        return True

    def is_balaiyasa_side(self, id_lokasi: str) -> bool:
        """
        True for a Balaiyasa or anything parented by one.

        The `BY*A` rows are typed "UPT", so excluding them by tipe alone is not
        enough, they have to be resolved to their parent.
        """
        if id_lokasi in getattr(self, "balaiyasa_ids", []):
            return True
        parent = get_parent_lokasi_code(id_lokasi)
        return bool(parent) and parent in getattr(self, "balaiyasa_ids", [])


# ══════════════════════════════════════════════════════════════════════
# The state machine
# ══════════════════════════════════════════════════════════════════════

def _consume_parts(ctx, riwayat, aset):
    """
    Spend a few compatible spareparts on one completed repair.

    Writes an `OUT` movement and the `pemakaian_sparepart` row that links it to
    the repair, the same pairing `catat_perbaikan()` produces at runtime, which
    is what makes Laporan Perbaikan's `top_sparepart` and the fast/slow
    classification reflect consumption that actually happened.

    Availability comes from the balance map seeded by `_net_stok_map()`, so this
    agrees with `SparePartStok.GERAKAN_MASUK`/`GERAKAN_KELUAR` rather than
    inventing a second rule for what adds versus removes stock. **A short part
    is skipped, never forced**: driving a balance negative would produce a
    `MINUS` status, which the dashboard correctly reports as a data fault.
    """
    candidates = ctx.parts_by_alat.get(aset.kode_alat) or []
    if not candidates:
        return

    rng = ctx.rng
    # `flush`, not `commit`: `id_riwayat` is a serial and does not exist until
    # the INSERT is issued, and pemakaian_sparepart needs it. Same reason
    # _record_pemakaian() flushes.
    ctx.db.flush()

    for part in rng.sample(candidates, k=min(len(candidates), rng.randint(1, 2))):
        # Where this part actually has stock right now.
        pockets = [
            (g, q) for (p, g), q in ctx.stok.items() if p == part.id_part and q > 0
        ]
        if not pockets:
            continue
        id_gudang, tersedia = rng.choice(pockets)
        qty = rng.randint(1, max(1, min(3, tersedia)))
        if qty > tersedia:
            continue

        stok_row = models.SparePartStok(
            id_part=part.id_part,
            id_gudang=id_gudang,
            tipe_gerakan="OUT",
            jumlah=qty,
            harga_satuan=part.harga_satuan,
            keterangan=tag(f"Pemakaian perbaikan {aset.id_aset}"),
            id_pengguna=ctx.id_pengguna,
            waktu=riwayat.waktu_lapor,
        )
        ctx.db.add(stok_row)
        ctx.db.flush()

        ctx.db.add(models.PemakaianSparepart(
            id_riwayat=riwayat.id_riwayat,
            id_aset=aset.id_aset,
            id_part=part.id_part,
            id_stok=stok_row.id_stok,
            id_gudang=id_gudang,
            jumlah=qty,
            harga_satuan=part.harga_satuan,
            keterangan=tag("Penggantian saat perbaikan"),
            waktu=riwayat.waktu_lapor,
        ))
        ctx.stok[(part.id_part, id_gudang)] = tersedia - qty
        ctx.counts["pemakaian"] += 1


def simulate_history(ctx, aset, mulai=None, kondisi_awal="SO", pakai_sparepart=True):
    """
    Append a plausible operational history to ONE existing asset.

    Does NOT write the opening condition row, the caller already has one
    (`seeds/aset.py` for the imported fleet, `seeds/dummy.py` for demo assets),
    and that row is what `hapus()` restores from. Writing a second would break
    the undo and inflate `f_masuk`.

    Returns nothing; mutates `aset` in place and appends rows to the session.
    """
    rng = ctx.rng
    db = ctx.db

    lokasi_saat_ini = aset.id_lokasi
    # Where the asset BELONGS, as opposed to where it currently sits. A workshop
    # visit changes the latter but never the former.
    home_lokasi = aset.id_lokasi
    kondisi = kondisi_awal
    peruntukan = aset.peruntukan
    unit_letter = ctx._letter_of(home_lokasi)

    # AFTER the registration row, never before it.
    #
    # `seeds/aset.py` stamps the opening "Aset Baru" record at 08:00 on the
    # purchase date. Defaulting to midnight put every simulated history BEFORE
    # the registration it follows from, monitoring starting before the machine
    # was recorded, which is both nonsense to read and enough to make the
    # `LAG` in `_scoped_repair_events()` treat the registration as an event in
    # the middle of the asset's life. Keep this later than `JAM_REGISTRASI`
    # there; `seeds/dummy.py` passes its own `mulai` and orders by id_riwayat.
    waktu = mulai or datetime.combine(aset.tanggal_pembelian, time(9, 0))

    # ── The boundary marker, and the identity gate ────────────────────
    #
    # ONE row per asset, written unconditionally, saying where fabricated
    # history begins. It earns its place twice over:
    #
    #   * It is the visible line between imported fact and simulated
    #     illustration. Everything above it in Pantau Riwayat came from the
    #     client's workbook; everything below it was invented.
    #   * It makes the idempotency gate EXACT. Gating on "has any simulated
    #     condition row" was not enough: an asset can legitimately produce no
    #     events at all, `rng.randint(0, 15)` rolls zero, or the first gap
    #     already runs past today, which is the common case for the 326 assets
    #     bought in 2026. Those assets were then re-simulated on every run, and
    #     a second `--simulasi` added another 429 condition rows. That is the
    #     fleet-doubling bug class wearing different clothes.
    db.add(models.RiwayatKondisi(
        id_aset=aset.id_aset,
        id_pengguna=ctx.id_pengguna,
        kondisi=kondisi_awal,
        keterangan=tag("Awal periode pemantauan simulasi"),
        waktu_lapor=waktu,
        id_lokasi=home_lokasi,
        peruntukan=peruntukan,
    ))
    ctx.counts["kondisi"] += 1

    for _ in range(rng.randint(0, 15)):
        # A broken machine is attended to in weeks; a healthy one runs for
        # months before anything notable happens to it.
        gap = GAP_PERBAIKAN_HARI if kondisi == "TSO" else GAP_SEHAT_HARI
        waktu += timedelta(days=rng.randint(*gap), hours=rng.randint(1, 23))
        if waktu > ctx.now:
            break
        if kondisi == "AFKIR":
            break

        if kondisi == "TSO":
            is_bengkel = lokasi_saat_ini in ctx.bengkel_ids
            if not is_bengkel and ctx.bengkel_ids:
                tujuan = rng.choice(ctx.bengkel_ids)
                db.add(models.RiwayatMutasi(
                    id_aset=aset.id_aset,
                    id_lokasi_asal=lokasi_saat_ini,
                    id_lokasi_tujuan=tujuan,
                    id_pengguna=ctx.id_pengguna,
                    alasan_mutasi=tag("Pengiriman untuk perbaikan (TSO)"),
                    waktu_mutasi=waktu,
                ))
                ctx.counts["mutasi"] += 1
                lokasi_saat_ini = tujuan
            else:
                kondisi = rng.choices(["SO", "AFKIR"], weights=[92, 8])[0]
                if kondisi == "AFKIR" and not ctx.boleh_afkir():
                    kondisi = "SO"   # budget spent, repaired instead
                riwayat = models.RiwayatKondisi(
                    id_aset=aset.id_aset,
                    id_pengguna=ctx.id_pengguna,
                    kondisi=kondisi,
                    keterangan=tag(f"Hasil perbaikan: {kondisi}"),
                    waktu_lapor=waktu,
                    # NOT lokasi_saat_ini. The repair physically happens at a
                    # Balaiyasa, but it belongs to the region that OWNS the
                    # asset. Stamping the workshop here is what used to grow a
                    # "BALAIYASA …" row in Laporan Perbaikan and drop the
                    # completion out of the owning DAOP's scope, so `masuk`
                    # never reconciled against `selesai + sedang`. The mutation
                    # rows still record the physical trip.
                    id_lokasi=home_lokasi,
                    peruntukan=peruntukan,
                )
                db.add(riwayat)
                ctx.counts["kondisi"] += 1

                # A completed repair is where parts get consumed.
                if kondisi == "SO" and pakai_sparepart:
                    _consume_parts(ctx, riwayat, aset)

                # A repaired asset goes back to its operating resort. Without
                # this it would stay parked at the Balaiyasa forever, and the
                # write-back below would home it at a workshop.
                if kondisi == "SO" and lokasi_saat_ini != home_lokasi:
                    waktu += timedelta(days=rng.randint(1, 10))
                    db.add(models.RiwayatMutasi(
                        id_aset=aset.id_aset,
                        id_lokasi_asal=lokasi_saat_ini,
                        id_lokasi_tujuan=home_lokasi,
                        id_pengguna=ctx.id_pengguna,
                        alasan_mutasi=tag("Pengembalian setelah perbaikan"),
                        waktu_mutasi=waktu,
                    ))
                    ctx.counts["mutasi"] += 1
                    lokasi_saat_ini = home_lokasi

        elif kondisi == "SO":
            aksi = rng.choices(["MUTASI", "KONDISI"], weights=[30, 70])[0]
            # Redistribute only among resorts of the SAME peruntukan. A
            # redistribution is a permanent move, it rewrites `home_lokasi`,
            # and the write-back stamps that onto `aset.id_lokasi`. Choosing
            # freely parked a JALAN REL machine at a jembatan resort
            # permanently, which the peruntukan rule forbids and no real import
            # can produce.
            same_unit = ctx.redistribusi_pool.get(unit_letter) or []
            if aksi == "MUTASI" and len(same_unit) > 1:
                tujuan = rng.choice(same_unit)
                while tujuan == lokasi_saat_ini:
                    tujuan = rng.choice(same_unit)
                db.add(models.RiwayatMutasi(
                    id_aset=aset.id_aset,
                    id_lokasi_asal=lokasi_saat_ini,
                    id_lokasi_tujuan=tujuan,
                    id_pengguna=ctx.id_pengguna,
                    alasan_mutasi=tag("Redistribusi operasional"),
                    waktu_mutasi=waktu,
                ))
                ctx.counts["mutasi"] += 1
                lokasi_saat_ini = tujuan
                home_lokasi = tujuan
            else:
                kondisi = rng.choices(["TSO", "AFKIR"], weights=[94, 6])[0]
                if kondisi == "AFKIR" and not ctx.boleh_afkir():
                    kondisi = "TSO"  # budget spent, it breaks, but survives
                db.add(models.RiwayatKondisi(
                    id_aset=aset.id_aset,
                    id_pengguna=ctx.id_pengguna,
                    kondisi=kondisi,
                    keterangan=tag(f"Degradasi kondisi ke {kondisi}"),
                    waktu_lapor=waktu,
                    # Same rule as the repair-outcome row: condition history is
                    # attributed to the owning region, never to a workshop the
                    # asset is merely visiting.
                    id_lokasi=home_lokasi,
                    peruntukan=peruntukan,
                ))
                ctx.counts["kondisi"] += 1

    # ── Periodic calibration ──
    # Measuring tools are recalibrated roughly yearly. Without these rows the
    # Kalibrasi card grid, the asset detail tab and the Kalibrasi export are all
    # permanently empty.
    if aset.kode_alat in ctx.kalibrasi_codes:
        kal_tanggal = aset.tanggal_pembelian
        while True:
            kal_tanggal = kal_tanggal + timedelta(days=rng.randint(330, 400))
            if kal_tanggal >= ctx.now.date():
                break
            status_kal = rng.choices(
                ["LULUS", "BERSYARAT", "GAGAL"], weights=[80, 15, 5]
            )[0]
            db.add(models.RiwayatKalibrasi(
                id_aset=aset.id_aset,
                id_pengguna=ctx.id_pengguna,
                tanggal_kalibrasi=kal_tanggal,
                tanggal_berlaku=kal_tanggal + timedelta(days=365),
                status=status_kal,
                pelaksana_kalibrasi=rng.choice(PELAKSANA_KALIBRASI),
                nomor_sertifikat=f"KAL/{kal_tanggal.year}/{rng.randint(1000, 9999)}",
                keterangan=tag(KALIBRASI_KETERANGAN[status_kal]),
                waktu_input=datetime.combine(kal_tanggal, datetime.min.time()),
            ))
            ctx.counts["kalibrasi"] += 1

    # ── A machine does not stay broken forever ──
    #
    # The loop stops when it runs out of events or reaches today, so an asset
    # can be left TSO by a failure that happened a year ago. That is what pushed
    # the first run to 37% of the fleet "currently under repair", a figure that
    # says nothing except that the simulation stopped.
    #
    # `sedang` on the repair dashboard is deliberately a POINT-IN-TIME count, so
    # a stale TSO corrupts precisely the number that is hardest to sanity-check.
    # Resolve it: the repair completed, the machine went home.
    if kondisi == "TSO" and (ctx.now - waktu).days > TSO_BASI_HARI:
        waktu += timedelta(days=rng.randint(7, 45))
        if waktu > ctx.now:
            waktu = ctx.now - timedelta(days=rng.randint(1, 30))
        kondisi = "SO"
        db.add(models.RiwayatKondisi(
            id_aset=aset.id_aset,
            id_pengguna=ctx.id_pengguna,
            kondisi="SO",
            keterangan=tag("Hasil perbaikan: SO"),
            waktu_lapor=waktu,
            id_lokasi=home_lokasi,
            peruntukan=peruntukan,
        ))
        ctx.counts["kondisi"] += 1
        if lokasi_saat_ini != home_lokasi:
            db.add(models.RiwayatMutasi(
                id_aset=aset.id_aset,
                id_lokasi_asal=lokasi_saat_ini,
                id_lokasi_tujuan=home_lokasi,
                id_pengguna=ctx.id_pengguna,
                alasan_mutasi=tag("Pengembalian setelah perbaikan"),
                waktu_mutasi=waktu,
            ))
            ctx.counts["mutasi"] += 1
            lokasi_saat_ini = home_lokasi

    # Write the final state back.
    #
    # Safety net: an asset must never be HOMED at a workshop. If the simulation
    # ended mid-repair at a Balaiyasa we keep the condition (it really is under
    # repair) but record its owning resort.
    aset.status_terakhir = kondisi
    aset.id_lokasi = (
        home_lokasi if ctx.is_balaiyasa_side(lokasi_saat_ini) else lokasi_saat_ini
    )
    aset.waktu_update = waktu
    ctx.counts["aset"] += 1


# ══════════════════════════════════════════════════════════════════════
# The step, and the undo
# ══════════════════════════════════════════════════════════════════════

def _already_simulated(db, id_pengguna) -> set:
    """
    Assets that already carry simulated history, the identity gate.

    Exact, because  writes its boundary marker row for
    EVERY asset it touches, including the ones whose simulation legitimately
    produces no events. Keyed on riwayat_kondisi alone for that reason: any
    asset in this set has been through the generator, whatever came out.
    """
    return {
        row[0]
        for row in db.query(models.RiwayatKondisi.id_aset)
        .filter(models.RiwayatKondisi.id_pengguna == id_pengguna)
        .distinct()
        .all()
    }


def run(db):
    """
    Give every asset that does not yet have one a simulated history.

    IDEMPOTENT by identity, not by count: an asset with any SIMULASI condition
    row is skipped. This is the bug class that let the dummy step grow the fleet
    1121 → 1221 → 1321 while `--verify` reported PASS both times, so it is
    checked the same way `seeds/aset.py` checks its own.
    """
    done = _already_simulated(db, simulasi_user(db).id_pengguna)
    assets = db.query(models.Aset).all()
    todo = [a for a in assets if a.id_aset not in done]
    # Budget sized to this run's population, not the whole table.
    ctx = SimContext(db, populasi=len(todo) or None)
    if not todo:
        print(
            f"  simulasi      : {len(done)} aset sudah punya riwayat simulasi — "
            "tidak ada yang ditambahkan."
        )
        return

    for i, aset in enumerate(todo, 1):
        if not aset.tanggal_pembelian:
            continue
        simulate_history(ctx, aset)
        if i % 250 == 0:
            db.commit()
            print(f"    … {i}/{len(todo)} aset disimulasikan")

    db.commit()
    c = ctx.counts
    print(
        f"  simulasi      : {c['aset']} aset · {c['kondisi']} kondisi · "
        f"{c['mutasi']} mutasi · {c['kalibrasi']} kalibrasi · "
        f"{c['pemakaian']} pemakaian sparepart"
    )
    print(
        f"                  semuanya atas nama '{SIMULASI_USERNAME}' dan diberi "
        f"tanda {SIMULASI_TAG} — hapus dengan `manage.py hapus-simulasi`"
    )


def hapus(db) -> dict:
    """
    Remove every simulated row and restore each asset's opening state.

    Exact, and needing no snapshot table: the opening `RiwayatKondisi` written
    by `seeds/aset.py` (and by `seeds/dummy.py` for demo assets) carries both
    the import location and the starting condition, and this module never
    touches it. Deleting the SIMULASI rows and reading that one back is a
    complete undo.

    Children first, `pemakaian_sparepart` points at both `riwayat_kondisi` and
    `sparepart_stok`, so it has to go before either.
    """
    user = db.query(models.Pengguna).filter_by(username=SIMULASI_USERNAME).first()
    if not user:
        print("  Tidak ada data simulasi.")
        return {}

    uid = user.id_pengguna
    removed = {}

    sim_riwayat = [
        r[0]
        for r in db.query(models.RiwayatKondisi.id_riwayat)
        .filter(models.RiwayatKondisi.id_pengguna == uid)
        .all()
    ]
    sim_stok = [
        r[0]
        for r in db.query(models.SparePartStok.id_stok)
        .filter(models.SparePartStok.id_pengguna == uid)
        .all()
    ]

    if sim_riwayat or sim_stok:
        q = db.query(models.PemakaianSparepart)
        if sim_riwayat:
            q = q.filter(models.PemakaianSparepart.id_riwayat.in_(sim_riwayat))
        removed["pemakaian_sparepart"] = q.delete(synchronize_session=False)

    removed["sparepart_stok"] = (
        db.query(models.SparePartStok)
        .filter(models.SparePartStok.id_pengguna == uid)
        .delete(synchronize_session=False)
    )
    removed["riwayat_kalibrasi"] = (
        db.query(models.RiwayatKalibrasi)
        .filter(models.RiwayatKalibrasi.id_pengguna == uid)
        .delete(synchronize_session=False)
    )
    removed["riwayat_mutasi"] = (
        db.query(models.RiwayatMutasi)
        .filter(models.RiwayatMutasi.id_pengguna == uid)
        .delete(synchronize_session=False)
    )
    removed["riwayat_kondisi"] = (
        db.query(models.RiwayatKondisi)
        .filter(models.RiwayatKondisi.id_pengguna == uid)
        .delete(synchronize_session=False)
    )
    db.flush()

    # Restore from the surviving opening row, the earliest one left for each
    # asset, which by construction is the import/creation record.
    opening = {}
    for r in (
        db.query(models.RiwayatKondisi)
        .order_by(models.RiwayatKondisi.id_aset, models.RiwayatKondisi.waktu_lapor)
        .all()
    ):
        opening.setdefault(r.id_aset, r)

    restored = 0
    for aset in db.query(models.Aset).all():
        row = opening.get(aset.id_aset)
        if not row:
            continue
        if aset.status_terakhir != row.kondisi or aset.id_lokasi != row.id_lokasi:
            aset.status_terakhir = row.kondisi
            aset.id_lokasi = row.id_lokasi or aset.id_lokasi
            restored += 1
    removed["aset dipulihkan"] = restored

    # The account goes too. It has no purpose once its rows are gone, and a
    # phantom user left behind in Pusat Data ▸ Pengguna is exactly the kind of
    # residue that puzzles someone six months later. `simulasi_user()` recreates
    # it on the next run. This is also what makes the undo EXACT: without it,
    # `pengguna` comes back as 3 where it started at 2.
    db.delete(user)
    removed["akun SIMULASI"] = 1

    db.commit()
    print("  Data simulasi dihapus:")
    for k, v in removed.items():
        print(f"    {k:24} {v}")
    return removed
