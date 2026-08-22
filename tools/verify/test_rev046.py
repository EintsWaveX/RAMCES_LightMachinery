"""
rev0.4.6 — the three client-matrix features, verified against real behaviour.

  MTBF / MTTR           recomputed independently from riwayat_kondisi and
                        compared to the endpoint, because a reliability number
                        that is plausible but wrong is worse than none
  Calibration reminder  the due list, the tab gate and the card badge must all
                        name the SAME machines
  Stock opname          open -> count -> post, and the one case that is easy to
                        get wrong and invisible in a quiet test: a movement
                        landing WHILE the count is open

Run against a `manage.py seed --simulasi` database. MTBF/MTTR read zero on a
clean import, so a clean-import run would pass while proving nothing.

Writes to the database and cleans up after itself: every opname session, every
adjustment row it caused, and the test part it created.
"""

import os
import statistics
import sys
import time

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT)

from smoke import _env  # noqa: E402

BASE = "http://127.0.0.1:8017"
PW = _env("BOOTSTRAP_ADMIN_PASSWORD")
USER = _env("BOOTSTRAP_ADMIN_USERNAME") or "superadmin"

ok, fail = [], []


def check(cond, label, detail=""):
    (ok if cond else fail).append(label)
    print(f"  {'ok  ' if cond else 'FAIL'} {label}{('   ' + detail) if detail else ''}")


def main():
    if not PW:
        print("BOOTSTRAP_ADMIN_PASSWORD missing from .env")
        return 2

    s = requests.Session()
    r = s.post(f"{BASE}/api/login", json={"username": USER, "password": PW})
    if r.status_code != 200:
        print(f"login failed: {r.status_code}")
        return 2
    H = {"Authorization": f"Bearer {r.json()['access_token']}"}

    # ════════════════════════════════════════════════════════════════
    print("\n1. MTBF / MTTR")
    # ════════════════════════════════════════════════════════════════
    from dotenv import load_dotenv
    load_dotenv(os.path.join(ROOT, ".env"))
    from database import SessionLocal
    from sqlalchemy import text

    db = SessionLocal()
    rows = list(db.execute(text(
        "SELECT id_aset, kondisi, waktu_lapor FROM riwayat_kondisi "
        "ORDER BY id_aset, waktu_lapor, id_riwayat"
    )))
    by_aset = {}
    for id_aset, kondisi, waktu in rows:
        by_aset.setdefault(id_aset, []).append((kondisi, waktu))

    # The same two definitions, walked by hand.
    d_rep = d_up = 0.0
    n_rep = n_up = 0
    for evs in by_aset.values():
        for i in range(1, len(evs)):
            pk, pt = evs[i - 1]
            k, t = evs[i]
            gap = (t - pt).total_seconds()
            if k in ("SO", "AFKIR") and pk == "TSO":
                d_rep += gap
                n_rep += 1
            if k == "TSO" and pk != "TSO":
                d_up += gap
                n_up += 1

    mine_mttr = round(d_rep / n_rep / 3600.0, 1) if n_rep else None
    mine_mtbf = round(d_up / n_up / 3600.0, 1) if n_up else None

    d = s.get(f"{BASE}/api/aset/dashboard/perbaikan?all_years=true", headers=H).json()
    check(d["mttr_jam"] == mine_mttr, "MTTR matches an independent walk",
          f"{d['mttr_jam']} vs {mine_mttr}")
    check(d["mtbf_jam"] == mine_mtbf, "MTBF matches an independent walk",
          f"{d['mtbf_jam']} vs {mine_mtbf}")
    check(d["mttr_n"] == n_rep and d["mtbf_n"] == n_up,
          "sample sizes match", f"{d['mttr_n']}/{d['mtbf_n']} vs {n_rep}/{n_up}")

    # The identity that breaks whenever condition transitions are touched.
    check(d["masuk"] == d["selesai"] + d["diafkir"] + d["sedang"],
          "masuk == selesai + diafkir + sedang (Semua Tahun)",
          f"{d['masuk']} == {d['selesai']}+{d['diafkir']}+{d['sedang']}")

    # ONE window scan, still. The durations ride on the existing pass; a second
    # scan would show up as the endpoint roughly doubling.
    def med(path):
        s.get(f"{BASE}{path}", headers=H)
        ts = []
        for _ in range(7):
            t0 = time.perf_counter()
            s.get(f"{BASE}{path}", headers=H)
            ts.append((time.perf_counter() - t0) * 1000)
        return statistics.median(ts)

    t_perb = med("/api/aset/dashboard/perbaikan?all_years=true")
    t_mcf = med("/api/aset/dashboard/mcf?all_years=true")
    check(t_perb < 100, "perbaikan still under 100 ms", f"{t_perb:.1f} ms")
    check(t_mcf < 40, "mcf did NOT grow a window scan of its own", f"{t_mcf:.1f} ms")

    # ════════════════════════════════════════════════════════════════
    print("\n2. Calibration reminder")
    # ════════════════════════════════════════════════════════════════
    jt = s.get(f"{BASE}/api/kalibrasi/jatuh-tempo?hari=30", headers=H).json()
    check(
        jt["jumlah_perlu_tindakan"] == jt["jumlah_lewat"] + jt["jumlah_segera"],
        "perlu_tindakan == lewat + segera (excludes belum_pernah)",
        f"{jt['jumlah_perlu_tindakan']} = {jt['jumlah_lewat']}+{jt['jumlah_segera']}",
    )

    tab = s.get(
        f"{BASE}/api/history/summary?punya=kalibrasi-jatuh-tempo"
        f"&jatuh_tempo_hari=30&limit=1000", headers=H).json()
    due_ids = {i["id_aset"] for i in jt["items"] if i["tanggal_berlaku"]}
    tab_ids = {i["id_aset"] for i in tab["items"]}
    check(due_ids == tab_ids,
          "the due list and the Kalibrasi tab gate name the same assets",
          f"{len(due_ids)} vs {len(tab_ids)}")

    # The card badge is driven by kalibrasi_berlaku, which must be present.
    page = s.get(f"{BASE}/api/aset?limit=1000", headers=H).json()["items"]
    with_date = [a for a in page if a.get("kalibrasi_berlaku")]
    check(all("kalibrasi_berlaku" in a for a in page),
          "/api/aset carries kalibrasi_berlaku on every row")
    card_overdue = {
        a["id_aset"] for a in with_date
        if a["id_aset"] in due_ids
    }
    check(card_overdue == due_ids & {a["id_aset"] for a in page},
          "every due asset on a card carries its own due date",
          f"{len(card_overdue)} cards")

    # A wider window can only ever add.
    wide = s.get(f"{BASE}/api/kalibrasi/jatuh-tempo?hari=365", headers=H).json()
    check(wide["jumlah_perlu_tindakan"] >= jt["jumlah_perlu_tindakan"],
          "a wider window is a superset",
          f"365d={wide['jumlah_perlu_tindakan']} >= 30d={jt['jumlah_perlu_tindakan']}")

    # ════════════════════════════════════════════════════════════════
    print("\n3. Stock opname")
    # ════════════════════════════════════════════════════════════════
    gudang = s.get(f"{BASE}/api/inventaris/gudang", headers=H).json()
    gid = (gudang if isinstance(gudang, list) else gudang["items"])[0]["id_gudang"]

    # A part of our own, so the test never disturbs seeded balances.
    kat = s.get(f"{BASE}/api/inventaris/kategori", headers=H).json()
    kid = (kat if isinstance(kat, list) else kat["items"])[0]["id_kategori"]
    made = s.post(f"{BASE}/api/inventaris/parts", headers=H, json={
        "nama_part": "ZZ-OPNAME-TEST", "id_kategori": kid, "unit": "pcs",
        "harga_satuan": 1000, "stok_min": 0, "jumlah_awal": 100,
        "id_gudang_awal": gid,
    })
    check(made.status_code == 200, "test part created", str(made.status_code))
    pid = made.json()["id_part"]

    sesi_ids = []
    try:
        def net():
            row = s.get(f"{BASE}/api/inventaris/parts/{pid}", headers=H).json()
            for g in row.get("per_gudang", []):
                if g.get("id_gudang") == gid:
                    return g.get("stok", g.get("stok_sekarang", 0))
            return row.get("stok_sekarang", 0)

        check(net() == 100, "opening balance is 100", str(net()))

        # ── a plain count with a variance ──
        o = s.post(f"{BASE}/api/inventaris/opname", headers=H,
                   json={"id_gudang": gid, "keterangan": "uji rev0.4.6"})
        check(o.status_code == 200, "opname opened", str(o.status_code))
        oid = o.json()["id_opname"]
        sesi_ids.append(oid)

        dup = s.post(f"{BASE}/api/inventaris/opname", headers=H, json={"id_gudang": gid})
        check(dup.status_code == 409,
              "a second DRAFT for the same gudang is refused", str(dup.status_code))

        s.put(f"{BASE}/api/inventaris/opname/{oid}/baris", headers=H,
              json={"baris": [{"id_part": pid, "stok_fisik": 93,
                               "keterangan": "hilang 7"}]})
        posted = s.post(f"{BASE}/api/inventaris/opname/{oid}/selesai", headers=H,
                        json={}).json()
        check(posted["jumlah_penyesuaian"] == 1 and posted["total_turun"] == 7,
              "variance posted as ONE ADJ_OUT of 7", str(posted["penyesuaian"]))
        check(net() == 93, "net stock now equals the physical count", str(net()))

        again = s.post(f"{BASE}/api/inventaris/opname/{oid}/selesai", headers=H, json={})
        check(again.status_code == 400, "posting twice is refused", str(again.status_code))

        # ── THE case: a movement lands WHILE the count is open ──
        #
        # Snapshot says 93. The counter finds 93 on the shelf. Meanwhile 10 are
        # issued to a repair, so the ledger says 83. Posting against the OPENING
        # snapshot would write +0 and leave the books at 83 while the shelf
        # holds 93 — or worse, silently reverse the issue. Posting against the
        # CURRENT balance writes +10 and both agree at 93.
        o2 = s.post(f"{BASE}/api/inventaris/opname", headers=H, json={"id_gudang": gid})
        oid2 = o2.json()["id_opname"]
        sesi_ids.append(oid2)

        s.post(f"{BASE}/api/inventaris/stok", headers=H, json={
            "id_part": pid, "tipe_gerakan": "OUT", "jumlah": 10,
            "id_gudang": gid, "keterangan": "keluar saat opname berjalan",
        })
        check(net() == 83, "10 issued mid-count", str(net()))

        s.put(f"{BASE}/api/inventaris/opname/{oid2}/baris", headers=H,
              json={"baris": [{"id_part": pid, "stok_fisik": 93}]})
        p2 = s.post(f"{BASE}/api/inventaris/opname/{oid2}/selesai",
                    headers=H, json={}).json()
        adj = next((x for x in p2["penyesuaian"] if x["id_part"] == pid), None)
        check(adj is not None and adj["selisih"] == 10,
              "variance measured against the CURRENT balance, not the snapshot",
              f"selisih={adj['selisih'] if adj else None} (want 10)")
        check(net() == 93, "ledger and shelf agree after posting", str(net()))

        # ── an abandoned count writes nothing ──
        o3 = s.post(f"{BASE}/api/inventaris/opname", headers=H, json={"id_gudang": gid})
        oid3 = o3.json()["id_opname"]
        sesi_ids.append(oid3)
        s.put(f"{BASE}/api/inventaris/opname/{oid3}/baris", headers=H,
              json={"baris": [{"id_part": pid, "stok_fisik": 1}]})
        s.post(f"{BASE}/api/inventaris/opname/{oid3}/batal", headers=H)
        check(net() == 93, "BATAL writes nothing to the ledger", str(net()))
        st = s.get(f"{BASE}/api/inventaris/opname/{oid3}", headers=H).json()
        check(st["status"] == "BATAL", "abandoned session is KEPT, not deleted",
              st["status"])

    finally:
        # ── cleanup ──
        db.execute(text("DELETE FROM opname_baris WHERE id_opname = ANY(:ids)"),
                   {"ids": sesi_ids or [0]})
        db.execute(text("DELETE FROM opname_sesi WHERE id_opname = ANY(:ids)"),
                   {"ids": sesi_ids or [0]})
        db.execute(text("DELETE FROM sparepart_stok WHERE id_part = :p"), {"p": pid})
        db.execute(text("DELETE FROM sparepart WHERE id_part = :p"), {"p": pid})
        db.commit()
        left = db.execute(
            text("SELECT count(*) FROM opname_sesi"),
        ).scalar()
        parts_left = db.execute(
            text("SELECT count(*) FROM sparepart WHERE nama_part = 'ZZ-OPNAME-TEST'")
        ).scalar()
        check(left == 0 and parts_left == 0,
              "cleanup: nothing left behind",
              f"opname_sesi={left} test parts={parts_left}")
        db.close()

    print(f"\n{len(ok)} ok, {len(fail)} FAIL")
    if fail:
        print("FAILED:", ", ".join(fail))
        return 1
    print("OK - MTBF/MTTR, the calibration reminder and stock opname all behave")
    return 0


if __name__ == "__main__":
    sys.exit(main())
