"""
The mutation path, end to end — the half the read-only smoke test cannot reach.

    py -3.10 mutate.py [base_url]

Exercises, and then UNDOES:

  1. create gudang -> sparepart -> opening stock          (api/inventaris.py)
  2. create an asset, checking the minted id_aset          (api/aset.py)
  3. POST /api/perbaikan WITH a `pemakaian` array          (api/riwayat.py)
     - the single transaction that writes the condition report AND consumes
       parts, via _record_pemakaian -> _net_stok_map, which is the one
       cross-module call edge the split created (riwayat -> inventaris)
     - and the broadcasts it must emit, collected over a live WebSocket
  4. a deliberate OVER-consumption, which must 400 AND roll the report back
  5. mutasi, kalibrasi
  6. delete everything and assert the row counts return to their seeded values

Every HTTP call goes through asyncio.to_thread: `requests` is blocking, and
calling it directly from this coroutine starves the WebSocket reader, so
broadcasts pile up in the socket buffer and get attributed to whichever step
happens to await next.

Every row this creates is removed before it exits. Test data left in a seeded
database is indistinguishable from demo data later.
"""

import asyncio
import json
import os
import sys
from datetime import date

import requests
import websockets

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8017"
WS = BASE.replace("http://", "ws://").replace("https://", "wss://") + "/ws/updates"
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

# The CLEAN-IMPORT baseline: what a `manage.py seed` with no optional steps
# produces. `lokasi` went 259 -> 273 when the 14 MEKANIK resorts the katalog
# always had finally reached the database, and `sparepart_stok` is stable at 973
# because seeds/inventaris.py seeds its RNG — before that, every full reset
# produced a different ledger size and this assertion was unusable.
#
# ⚠️ It is INFORMATIONAL once optional data is present. `--simulasi` adds
# condition rows, stock movements and the SIMULASI account; `--with-history`
# adds 100 assets. Both are legitimate states for a working database, so a
# mismatch against this table is not a failure.
#
# The assertion that actually matters is the SNAPSHOT one below — every count
# returns to whatever it was when this script started. That is what proves the
# mutation path leaves nothing behind, and it holds in every one of those
# states.
EXPECTED_COUNTS = {
    "kategori_alat": 104,
    "lokasi": 273,
    "alat_varian": 87,
    "aset": 1121,
    "riwayat_kondisi": 1121,
    "pengguna": 2,
    "gudang": 3,
    "sparepart": 203,
    "sparepart_stok": 973,
}


def _optional_data_present():
    """Which opt-in seed steps have been run — `--simulasi`, `--with-history`."""
    from sqlalchemy import text
    from database import engine

    found = []
    with engine.connect() as conn:
        try:
            if conn.execute(
                text("SELECT 1 FROM pengguna WHERE username = 'SIMULASI'")
            ).first():
                found.append("simulasi")
        except Exception:  # noqa: BLE001
            pass
        try:
            if conn.execute(
                text("SELECT 1 FROM aset WHERE nomor_seri LIKE 'DEMO-%'")
            ).first():
                found.append("aset demo")
        except Exception:  # noqa: BLE001
            pass
    return found


def _env(key):
    with open(os.path.join(ROOT, ".env"), encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def counts():
    from sqlalchemy import text
    from database import engine
    out = {}
    with engine.connect() as c:
        for t in EXPECTED_COUNTS:
            out[t] = c.execute(text(f"SELECT count(*) FROM {t}")).scalar()
    return out


class Collector:
    """A live WebSocket, so broadcasts are asserted rather than assumed."""

    def __init__(self, token):
        self.token = token
        self.messages = []
        self._task = None

    async def _run(self, ready):
        try:
            async with websockets.connect(f"{WS}?token={self.token}") as ws:
                ready.set()
                while True:
                    m = await ws.recv()
                    self.messages.append(m)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # A reader that dies silently looks exactly like an endpoint that
            # forgot to broadcast. Say so instead.
            print(f"       [ws reader stopped: {type(exc).__name__}: {exc}]")

    async def start(self):
        ready = asyncio.Event()
        # Start the reader BEFORE any other traffic, or the first frames are
        # missed. KEEP THE REFERENCE: the event loop holds only a weak one, so
        # an unassigned create_task() can be garbage-collected mid-run — which
        # looks exactly like intermittently missing broadcasts.
        self._task = asyncio.create_task(self._run(ready))
        await asyncio.wait_for(ready.wait(), timeout=10)

    async def stop(self):
        if self._task:
            self._task.cancel()

    def drain(self):
        got, self.messages = list(self.messages), []
        return got


async def main():
    s = requests.Session()
    fails = []

    before = counts()
    drift0 = {k: v for k, v in before.items() if v != EXPECTED_COUNTS[k]}
    optional = _optional_data_present()
    if drift0 and optional:
        print(f"row counts before: {drift0}")
        print(f"                   (expected — {', '.join(optional)} present)")
    else:
        print("row counts before:", drift0 or "all 9 tables at their seeded values")

    r = await asyncio.to_thread(
        s.post, f"{BASE}/api/login",
        json={"username": "superadmin", "password": _env("BOOTSTRAP_ADMIN_PASSWORD")},
    )
    r.raise_for_status()
    token = r.json()["access_token"]
    H = {"Authorization": f"Bearer {token}"}

    ws = Collector(token)
    await ws.start()
    await asyncio.sleep(0.6)
    ws.drain()
    print("websocket connected\n")

    async def post(path, body, expect=200):
        r = await asyncio.to_thread(s.post, f"{BASE}{path}", json=body, headers=H)
        if r.status_code != expect:
            fails.append(f"POST {path} -> {r.status_code} (want {expect}) {r.text[:200]}")
            print(f"  FAIL POST {path}  {r.status_code}  {r.text[:160]}")
            return None
        print(f"  ok   POST {path}  {r.status_code}")
        return r.json() if r.text else {}

    async def get(path):
        r = await asyncio.to_thread(s.get, f"{BASE}{path}", headers=H)
        return r.json()

    async def broadcasts(label, want):
        await asyncio.sleep(1.0)
        got = set(ws.drain())
        missing = set(want) - got
        if missing:
            fails.append(f"{label}: missing broadcast(s) {sorted(missing)} (got {sorted(got)})")
            print(f"       FAIL broadcasts {sorted(got)} — missing {sorted(missing)}")
        else:
            print(f"       broadcasts {sorted(got)}")

    async def stock_now(id_part, id_gudang):
        for row in await get(f"/api/inventaris/parts?id_gudang={id_gudang}"):
            if row["id_part"] == id_part:
                return row["stok_sekarang"]
        return None

    # ── 1. gudang -> sparepart -> opening stock ────────────────────
    print("1. inventaris chain (gudang -> kategori -> sparepart -> stok)")
    g = await post("/api/inventaris/gudang", {"kode": "ZZTEST", "nama": "ZZ TEST GUDANG"})
    if not g:
        return 1
    id_gudang = g.get("id_gudang") or (g.get("gudang") or {}).get("id_gudang")
    if id_gudang is None:
        print(f"       (gudang response: {json.dumps(g)[:200]})")
        return 1
    await broadcasts("gudang create", {"REFRESH_INVENTARIS"})

    id_kategori = (await get("/api/inventaris/kategori"))[0]["id_kategori"]

    # `jumlah_awal` must be paired with `id_gudang_awal`: an opening balance
    # written against id_lokasi alone is invisible to every warehouse-scoped
    # screen and impossible to issue.
    p = await post("/api/inventaris/parts", {
        "nama_part": "ZZ TEST PART", "id_kategori": id_kategori,
        "unit": "Pcs", "harga_satuan": 1000, "stok_min": 1,
        "jumlah_awal": 10, "id_gudang_awal": id_gudang,
    })
    if not p:
        return 1
    id_part = p.get("id_part") or (p.get("part") or {}).get("id_part")
    if id_part is None:
        print(f"       (part response: {json.dumps(p)[:200]})")
        return 1
    await broadcasts("part create", {"REFRESH_INVENTARIS"})

    opening = await stock_now(id_part, id_gudang)
    print(f"       opening stock = {opening}  (want 10)")
    if opening != 10:
        fails.append(f"opening stock {opening} != 10")

    # ── 2. create an asset ─────────────────────────────────────────
    print("\n2. asset create")
    a = await post("/api/aset", {
        "kode_alat": "RGM", "id_lokasi": "JR1.1", "parent_lokasi": "D1",
        "tanggal_pembelian": str(date.today()),
        "sumber_pengadaan": "PUSAT", "peruntukan": "JALAN REL",
        "nomor_seri": "ZZ-TEST-SERIAL",
    })
    if not a:
        return 1
    uid = a["id_aset"]
    segs = uid.split(".")
    ok_id = segs[1] == "RGM" and segs[2] == "1" and segs[4] == "A" and segs[5] == "D1"
    print(f"       id_aset = {uid}   segments {'OK' if ok_id else 'WRONG'}")
    if not ok_id:
        fails.append(f"minted id_aset has wrong segments: {uid}")
    await broadcasts("aset create", {"REFRESH_ASSET_LIST"})

    # ── 3. repair consuming parts, ONE transaction ─────────────────
    print("\n3. repair + pemakaian (one transaction, two lines for the same part)")
    rep = await post("/api/perbaikan", {
        "id_aset": uid, "kondisi": "TSO", "keterangan": "ZZ TEST kerusakan",
        "pemakaian": [
            {"id_part": id_part, "jumlah": 2, "id_gudang": id_gudang},
            {"id_part": id_part, "jumlah": 3, "id_gudang": id_gudang},
        ],
    })
    if rep is None:
        return 1
    after = await stock_now(id_part, id_gudang)
    print(f"       stock 10 -> {after}   (want 5 — the two lines summed before the check)")
    if after != 5:
        fails.append(f"stock after repair {after} != 5")
    await broadcasts("perbaikan", {"REFRESH_ASSET_LIST", "REFRESH_INVENTARIS"})

    # ── 4. over-consumption must 400 AND roll the report back ──────
    print("\n4. short stock rolls the WHOLE transaction back")
    n_before = len(await get(f"/api/riwayat-kondisi/{uid}"))
    await post("/api/perbaikan", {
        "id_aset": uid, "kondisi": "TSO", "keterangan": "ZZ TEST kelebihan",
        "pemakaian": [{"id_part": id_part, "jumlah": 999, "id_gudang": id_gudang}],
    }, expect=400)
    n_after = len(await get(f"/api/riwayat-kondisi/{uid}"))
    stock_after = await stock_now(id_part, id_gudang)
    print(f"       riwayat rows {n_before} -> {n_after} (must not grow)   stock {stock_after} (must stay 5)")
    if n_after != n_before:
        fails.append("a short stock still recorded a condition report")
    if stock_after != 5:
        fails.append(f"stock moved on a rejected repair: {stock_after}")
    ws.drain()

    # ── 5. mutasi + kalibrasi ──────────────────────────────────────
    print("\n5. mutasi + kalibrasi")
    await post("/api/mutasi", {"id_aset": uid, "id_lokasi_tujuan": "JR1.3", "alasan_mutasi": "ZZ TEST"})
    await broadcasts("mutasi", {"REFRESH_ASSET_LIST"})
    k = await post("/api/kalibrasi", {
        "id_aset": uid, "tanggal_kalibrasi": str(date.today()),
        "status": "LULUS", "pelaksana_kalibrasi": "ZZ TEST",
    })
    id_kalibrasi = (k or {}).get("id_kalibrasi")
    if id_kalibrasi:
        print(f"       id_kalibrasi = {id_kalibrasi}  (two-step upload contract intact)")
    else:
        fails.append("POST /api/kalibrasi did not return id_kalibrasi")
    await broadcasts("kalibrasi", {"REFRESH_ASSET_LIST"})

    # ── 6. clean up ────────────────────────────────────────────────
    print("\n6. cleanup")
    from sqlalchemy import text
    from database import engine

    # Does the API's own delete cope with an asset that has usage recorded
    # against one of its repairs? Report it either way — this is worth knowing
    # independently of the cleanup succeeding.
    r = await asyncio.to_thread(s.delete, f"{BASE}/api/aset/{uid}", headers=H)
    print(f"       DELETE /api/aset/{uid} -> {r.status_code}"
          f"{'  ' + r.text[:120] if r.status_code != 200 else ''}")
    api_delete_ok = r.status_code == 200

    with engine.begin() as c:
        # pemakaian_sparepart references BOTH riwayat_kondisi(id_riwayat) and
        # sparepart_stok(id_stok), so the usage rows go first either way.
        c.execute(text("DELETE FROM pemakaian_sparepart WHERE id_part = :p"), {"p": id_part})
        if not api_delete_ok:
            c.execute(text("DELETE FROM riwayat_kalibrasi WHERE id_aset = :a"), {"a": uid})
            c.execute(text("DELETE FROM riwayat_mutasi   WHERE id_aset = :a"), {"a": uid})
            c.execute(text("DELETE FROM riwayat_kondisi  WHERE id_aset = :a"), {"a": uid})
            c.execute(text("DELETE FROM aset             WHERE id_aset = :a"), {"a": uid})
        c.execute(text("DELETE FROM sparepart_stok WHERE id_part = :p"), {"p": id_part})
        c.execute(text("DELETE FROM sparepart WHERE id_part = :p"), {"p": id_part})
        # The gudang DELETE endpoint is a soft deactivate; a deactivated
        # warehouse would still show in Pusat Data, so remove the row.
        c.execute(text("DELETE FROM gudang WHERE id_gudang = :g"), {"g": id_gudang})

    await ws.stop()

    after_counts = counts()
    left = {k: (before[k], after_counts[k]) for k in before if before[k] != after_counts[k]}
    if left:
        print(f"       ROWS LEFT BEHIND: {left}")
        fails.append(f"rows left behind: {left}")
    else:
        print("       every row count back to its starting value")
    mismatch = {k: (after_counts[k], v) for k, v in EXPECTED_COUNTS.items() if after_counts[k] != v}
    if not mismatch:
        print("       vs clean-import baseline: exact match on all 9 tables")
    elif optional:
        # A database carrying simulated history or a demo fleet is a legitimate
        # state, so this is reported and not failed. The snapshot check above is
        # the one that proves nothing was left behind.
        print(f"       vs clean-import baseline: differs, as expected ({', '.join(optional)})")
    else:
        print(f"       vs clean-import baseline: {mismatch}")
        fails.append(f"counts differ from the seeded expectation: {mismatch}")

    print()
    if fails:
        print(f"FAILED ({len(fails)})")
        for f in fails:
            print(f"  - {f}")
        return 1
    print("OK — mutation path intact, nothing left behind")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
