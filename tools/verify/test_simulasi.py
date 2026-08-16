"""
The simulated-history step: marked, idempotent, and exactly reversible.

    py -3.10 tools/verify/test_simulasi.py     # needs a seeded database

⚠️ THIS SCRIPT WRITES TO THE REAL LOCAL DATABASE and then undoes it. It
snapshots every row count plus each asset's `(status_terakhir, id_lokasi)`
first, and fails if the restore is not byte-for-byte. Run it against the local
seeded database, never anything you care about.

What it is defending, in order of how badly each would hurt:

  1. **Reversibility.** Fabricated history on 1,121 REAL machines is only
     acceptable because it can be removed completely. If `hapus-simulasi` ever
     stops restoring exactly, the whole bargain is off.
  2. **Marking.** Every fabricated row must be attributable to the SIMULASI
     account, and that account must be unable to log in. A fabricated row that
     looks like a technician's entry is the thing the rest of `seeds/` exists to
     prevent.
  3. **Idempotency.** Running the step twice must add nothing. This is the bug
     class that grew the fleet 1121 → 1221 → 1321 while `--verify` reported PASS.
  4. **Plausibility.** The first cut produced 21% written off and 37% currently
     broken. Arithmetically fine, completely unbelievable — and a demo nobody
     believes is worse than an empty one.
  5. **The reconciling identity.** `masuk == selesai + diafkir + sedang` on
     "Semua Tahun", which is the claim the repair dashboard rests on and the one
     that broke last time anyone touched condition transitions.
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT)

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

import requests  # noqa: E402
from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(ROOT, ".env"))

from sqlalchemy import create_engine, text  # noqa: E402

from smoke import _env  # noqa: E402

BASE = "http://127.0.0.1:8017"
PW = _env("BOOTSTRAP_ADMIN_PASSWORD")
ENGINE = create_engine(os.environ["DATABASE_URL"])

TABLES = (
    "aset", "riwayat_kondisi", "riwayat_mutasi", "riwayat_kalibrasi",
    "pengguna", "sparepart_stok", "pemakaian_sparepart",
)

ok = fail = 0


def check(label, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  ok   {label}")
    else:
        fail += 1
        print(f"  FAIL {label}   {detail}")


def snapshot():
    """Row counts plus every asset's mutable state — the restore target."""
    snap = {"counts": {}, "aset": {}}
    with ENGINE.connect() as c:
        for t in TABLES:
            snap["counts"][t] = c.execute(text(f"select count(*) from {t}")).scalar()
        for r in c.execute(
            text("select id_aset, status_terakhir, id_lokasi from aset")
        ):
            snap["aset"][r[0]] = (r[1], r[2])
    return snap


def manage(*args):
    """Run a manage.py subcommand and return its stdout."""
    r = subprocess.run(
        [sys.executable, "manage.py", *args],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    return (r.stdout or "") + (r.returncode and f"\n[exit {r.returncode}]" or "")


def q(sql, **kw):
    with ENGINE.connect() as c:
        return c.execute(text(sql), kw).scalar()


def main():
    print("0. Baseline")
    pre = snapshot()
    already = q("select count(*) from pengguna where username = 'SIMULASI'")
    if already:
        print("  ! SIMULASI data already present — removing it first so the")
        print("    restore target is a clean import.")
        manage("hapus-simulasi")
        pre = snapshot()
    print(f"  counts: {pre['counts']}")

    # ── 1. Generate ──
    print("\n1. manage.py seed --only simulasi")
    out = manage("seed", "--only", "simulasi")
    check("step ran", "simulasi" in out and "VERIFIKASI" in out, out[-300:])
    post = snapshot()

    for t in ("riwayat_kondisi", "riwayat_mutasi", "riwayat_kalibrasi"):
        check(f"{t} grew", post["counts"][t] > pre["counts"][t],
              f"{pre['counts'][t]} -> {post['counts'][t]}")
    # pemakaian_sparepart had NO writer in the seed pipeline before this — only
    # the live repair endpoint ever produced a row.
    check("pemakaian_sparepart now has rows (nothing seeded it before)",
          post["counts"]["pemakaian_sparepart"] > 0,
          post["counts"]["pemakaian_sparepart"])
    check("aset count unchanged — history only, no new machines",
          post["counts"]["aset"] == pre["counts"]["aset"],
          f"{pre['counts']['aset']} -> {post['counts']['aset']}")

    # ── 2. Marking ──
    print("\n2. Every fabricated row is marked")
    uid = q("select id_pengguna from pengguna where username = 'SIMULASI'")
    check("SIMULASI account exists", bool(uid), uid)
    check("...and cannot log in (no password hash)",
          q("select hashed_password is null from pengguna where id_pengguna = :u", u=uid) is True)
    r = requests.post(f"{BASE}/api/login",
                      json={"username": "SIMULASI", "password": "apapun"})
    check("...proven against the real login endpoint", r.status_code in (401, 403),
          f"{r.status_code} {r.text[:90]}")

    # Everything after an asset's OPENING row must be simulated. If anything
    # else appears there, some other writer is producing history that is not
    # marked and would not be removed by the undo.
    unowned = q(
        "select count(*) from riwayat_kondisi r where r.id_pengguna <> :u "
        "and r.waktu_lapor > (select min(r2.waktu_lapor) from riwayat_kondisi r2 "
        "where r2.id_aset = r.id_aset)", u=uid)
    check("every row after the opening one is attributed to SIMULASI",
          unowned == 0, f"{unowned} rows")

    # …and the marker must come AFTER the registration, not before it.
    terbalik = q(
        "select count(*) from riwayat_kondisi r join pengguna p on p.id_pengguna=r.id_pengguna "
        "where p.username = 'SYSTEM' and r.waktu_lapor > "
        "(select min(r2.waktu_lapor) from riwayat_kondisi r2 where r2.id_aset = r.id_aset)")
    check("the registration row is still each asset's earliest",
          terbalik == 0, f"{terbalik} assets have history before registration")

    untagged = q(
        "select count(*) from riwayat_kondisi where id_pengguna = :u "
        "and keterangan not like '[SIMULASI]%'", u=uid)
    check("every simulated keterangan carries the [SIMULASI] tag",
          untagged == 0, f"{untagged} rows")

    # ── 3. Idempotency ──
    print("\n3. Running it twice adds nothing")
    manage("seed", "--only", "simulasi")
    twice = snapshot()
    drift = {k: (post["counts"][k], twice["counts"][k])
             for k in TABLES if post["counts"][k] != twice["counts"][k]}
    check("second run is a no-op", not drift, drift)

    # ── 4. Plausibility ──
    print("\n4. The spread is one a real fleet would recognise")
    total = twice["counts"]["aset"]
    spread = {}
    with ENGINE.connect() as c:
        for r_ in c.execute(
            text("select status_terakhir, count(*) from aset group by 1")
        ):
            spread[r_[0]] = r_[1] / total * 100
    so, tso, afkir = spread.get("SO", 0), spread.get("TSO", 0), spread.get("AFKIR", 0)
    print(f"       SO {so:.1f}%  TSO {tso:.1f}%  AFKIR {afkir:.1f}%")
    check("availability is plausible (SO 75-95%)", 75 <= so <= 95, f"{so:.1f}%")
    check("not everything is broken (TSO <= 18%)", tso <= 18, f"{tso:.1f}%")
    check("not everything is scrapped (AFKIR <= 8%)", afkir <= 8, f"{afkir:.1f}%")
    check("all three states are represented", so and tso and afkir, spread)

    # ── 5. The reconciling identity, and the workshop rule ──
    print("\n5. The dashboard still reconciles")
    tok = requests.post(f"{BASE}/api/login",
                        json={"username": "superadmin", "password": PW}).json()
    H = {"Authorization": f"Bearer {tok['access_token']}"}
    # `all_years`, NOT `tahun=all` — the latter is not a valid int and silently
    # falls back to the current year, which cannot satisfy the identity because
    # `sedang` is a point-in-time count.
    d = requests.get(f"{BASE}/api/aset/dashboard/perbaikan?all_years=true",
                     headers=H).json()
    kanan = d["selesai"] + d["diafkir"] + d["sedang"]
    check(f"masuk {d['masuk']} == selesai {d['selesai']} + afkir {d['diafkir']}"
          f" + sedang {d['sedang']}", d["masuk"] == kanan, f"right side = {kanan}")

    by_rows = [x for x in (d.get("per_resort") or []) if "BALAIYASA" in str(x).upper()]
    check("no BALAIYASA row in Laporan Perbaikan", not by_rows, by_rows[:1])

    salah = q("""
        select count(*) from riwayat_kondisi r join aset a on a.id_aset = r.id_aset
        where r.id_lokasi in (select id_lokasi from lokasi where upper(tipe) = 'BALAIYASA')
          and a.id_lokasi not in (select id_lokasi from lokasi where upper(tipe) = 'BALAIYASA')
    """)
    check("no DAOP-owned repair attributed to a workshop", salah == 0, f"{salah} rows")

    mcf = requests.get(f"{BASE}/api/aset/dashboard/mcf?all_years=true",
                       headers=H).json()
    check("Kurva MCF now has something to plot",
          mcf.get("total_perbaikan", 0) > 0, mcf.get("total_perbaikan"))

    # ── 6. The undo ──
    print("\n6. manage.py hapus-simulasi restores EXACTLY")
    manage("hapus-simulasi")
    after = snapshot()

    bad_counts = {k: (pre["counts"][k], after["counts"][k])
                  for k in TABLES if pre["counts"][k] != after["counts"][k]}
    check("every row count back to its pre-simulation value", not bad_counts, bad_counts)

    changed = [a for a in pre["aset"] if pre["aset"][a] != after["aset"].get(a)]
    check("every asset's status and lokasi restored", not changed,
          [(a, pre['aset'][a], after['aset'].get(a)) for a in changed[:3]])
    check("the SIMULASI account is gone too",
          q("select count(*) from pengguna where username = 'SIMULASI'") == 0)

    print(f"\n{ok} ok, {fail} FAIL")
    if fail:
        print("\n✗ the simulation is not safe to run against real data")
        return 1
    print("\nOK — marked, idempotent, plausible, and exactly reversible")
    return 0


if __name__ == "__main__":
    sys.exit(main())
