"""
Server-side paging parity: does `api/query.py` return exactly what
`js/search.js` would have?

rev0.4.5 moved Kelola Data Aset and Pantau Riwayat off the in-memory fleet and
onto server pages. That is only safe if the server's filters agree with the
client's matcher on every row — a filter that disagrees by one is a machine that
cannot be found by anyone who reads the card and types what it says.

So this script runs BOTH sides over the SAME fleet and compares id lists:

  client   real Chrome, calling `assetMatchesSearch` / `lokasiMatchesCode` /
           `_pengadaanMatches` / `decodeAsetId` and the view's own comparator —
           the shipped functions themselves, not a re-implementation
  server   the same query as URL parameters on /api/aset, unpaged

A mismatch prints the symmetric difference, so a failure names the assets.

── Why it loads its own copy of the fleet ──
It fetches the full fleet into `db` / `_historySummary` itself rather than
trusting whatever the app happens to be holding. After this release those two
arrays are a PAGE, not the fleet, so reading them would silently shrink the
client side of every comparison and the test would pass by agreeing about
nothing. The point here is the matcher's semantics, not the app's state.

Needs the app on :8017 and Chrome. Writes nothing to the database.
"""

import asyncio
import json
import os
import sys

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT)

from cdp import Chrome  # noqa: E402
from smoke import _env  # noqa: E402

BASE = "http://127.0.0.1:8017"
PW = _env("BOOTSTRAP_ADMIN_PASSWORD")
USER = _env("BOOTSTRAP_ADMIN_USERNAME") or "superadmin"

# Each case is (label, client spec, server query string).
#
# Location terms are the point of the exercise, and the values are chosen from
# what the real fleet actually contains — a case that returns 0 rows on both
# sides agrees about nothing and proves nothing. The seeded fleet has DAOP 1–9
# and DIVRE I–IV (codes D1…D9, VI/VII/VIII/VIV), so the roman branch is what
# exercises the over-match guard: "VI" must not drag in VII/VIII/VIV, which a
# `LIKE 'VI%'` would. The arabic pair is kept anyway, cheap and self-documenting.
CASES = [
    ("no filter", {}, ""),
    # ── location: region labels ──
    ("q=DAOP 1 (excludes DAOP 10)", {"q": "DAOP 1"}, "q=DAOP+1"),
    ("q=DAOP 8", {"q": "DAOP 8"}, "q=DAOP+8"),
    ("q=DIVRE I (excludes II/III/IV)", {"q": "DIVRE I"}, "q=DIVRE+I"),
    ("q=DIVRE II", {"q": "DIVRE II"}, "q=DIVRE+II"),
    ("q=DIVRE III", {"q": "DIVRE III"}, "q=DIVRE+III"),
    ("q=DIVRE IV", {"q": "DIVRE IV"}, "q=DIVRE+IV"),
    ("q=BALAIYASA", {"q": "BALAIYASA"}, "q=BALAIYASA"),
    # ── location: bare codes ──
    ("q=D1 (bare code, excludes D10)", {"q": "D1"}, "q=D1"),
    ("q=D8", {"q": "D8"}, "q=D8"),
    # "VI" is a bare CODE for the location half, but it is also a substring of
    # every id_aset ending `.VIII` / `.VIV`, and the text half of
    # assetMatchesSearch matches those. So this case pins the OR of the two
    # halves, not the roman exclusion — `filter lokasi VI` below is what pins
    # that, because lokasiMatchesCode has no text half to fall through to.
    ("q=VI (code half + id substring)", {"q": "VI"}, "q=VI"),
    ("q=VIII", {"q": "VIII"}, "q=VIII"),
    ("q=BY3", {"q": "BY3"}, "q=BY3"),
    ("q=JBIII.1 (bare UPT code)", {"q": "JBIII.1"}, "q=JBIII.1"),
    # ── location: free text over names ──
    ("q=SURABAYA (name substring)", {"q": "SURABAYA"}, "q=SURABAYA"),
    ("q=KIARACONDONG", {"q": "KIARACONDONG"}, "q=KIARACONDONG"),
    ("q=PALEMBANG", {"q": "PALEMBANG"}, "q=PALEMBANG"),
    # ── the non-location half ──
    ("q=PBT (kode alat)", {"q": "PBT"}, "q=PBT"),
    ("q=TSO (status as text)", {"q": "TSO"}, "q=TSO"),
    ("q=2024 (date as text)", {"q": "2024"}, "q=2024"),
    ("q=MILWAUKEE (model/type)", {"q": "MILWAUKEE"}, "q=MILWAUKEE"),
    ("q=PUSAT (pengadaan as text)", {"q": "PUSAT"}, "q=PUSAT"),
    ("q=ZZZQQQ (matches nothing)", {"q": "ZZZQQQ"}, "q=ZZZQQQ"),
    # ── the sort-modal filters ──
    ("filter alat PBT", {"alat": "PBT"}, "alat=PBT"),
    ("filter alat IMP", {"alat": "IMP"}, "alat=IMP"),
    ("filter pengadaan PUSAT", {"pengadaan": "PUSAT"}, "pengadaan=PUSAT"),
    ("filter pengadaan DAOP/DIVRE", {"pengadaan": "DAOP/DIVRE"},
     "pengadaan=DAOP%2FDIVRE"),
    ("filter peruntukan A", {"peruntukan": "A"}, "peruntukan=A"),
    ("filter peruntukan B", {"peruntukan": "B"}, "peruntukan=B"),
    ("filter peruntukan D (rare)", {"peruntukan": "D"}, "peruntukan=D"),
    ("filter lokasi D1", {"lokasi": "D1"}, "lokasi=D1"),
    # The roman over-match guard, cleanly: VI must return DIVRE I only, not the
    # union of VI/VII/VIII/VIV that `LIKE 'VI%'` would give.
    ("filter lokasi VI (excludes VII/VIII/VIV)", {"lokasi": "VI"}, "lokasi=VI"),
    ("filter lokasi VII", {"lokasi": "VII"}, "lokasi=VII"),
    ("filter lokasi VIII", {"lokasi": "VIII"}, "lokasi=VIII"),
    ("filter lokasi VIV", {"lokasi": "VIV"}, "lokasi=VIV"),
    ("filter lokasi BY3", {"lokasi": "BY3"}, "lokasi=BY3"),
    ("filter upt JBIII.1", {"upt": "JBIII.1"}, "upt=JBIII.1"),
    ("filter upt JB6.2", {"upt": "JB6.2"}, "upt=JB6.2"),
    ("filter tahun 2024-2025", {"tahunFrom": "2024", "tahunTo": "2025"},
     "tahun_from=2024&tahun_to=2025"),
    ("filter tahun 2026-2026", {"tahunFrom": "2026", "tahunTo": "2026"},
     "tahun_from=2026&tahun_to=2026"),
    ("filter id range 1-20", {"idFrom": 1, "idTo": 20}, "id_from=1&id_to=20"),
    ("filter id range 50-120", {"idFrom": 50, "idTo": 120}, "id_from=50&id_to=120"),
    ("status TSO", {"status": "TSO"}, "status=TSO"),
    ("status SO", {"status": "SO"}, "status=SO"),
    ("combined", {"q": "DAOP 1", "peruntukan": "A", "pengadaan": "PUSAT"},
     "q=DAOP+1&peruntukan=A&pengadaan=PUSAT"),
    ("combined 2", {"alat": "PBT", "lokasi": "VIII", "tahunFrom": "2025"},
     "alat=PBT&lokasi=VIII&tahun_from=2025"),
]

# An id SET can agree while the page ORDER does not, and a wrong order is what
# makes paging show the right number of the wrong cards.
ORDER_CASES = [
    ("id_aset asc", "id_aset", "asc"),
    ("id_aset desc", "id_aset", "desc"),
    ("kode_alat_name asc", "kode_alat_name", "asc"),
    ("sumber_pengadaan desc", "sumber_pengadaan", "desc"),
    ("peruntukan asc", "peruntukan", "asc"),
    ("id_lokasi asc", "id_lokasi", "asc"),
    ("date-desc", "id_aset", "date-desc"),
    ("date-asc", "id_aset", "date-asc"),
    ("count-desc", "id_aset", "count-desc"),
    ("count-asc", "id_aset", "count-asc"),
]

# Pantau Riwayat runs the same filters over `_historySummary`, plus a per-tab
# gate and eleven extra search fields the asset payload does not carry. Each
# case is (label, tab, client spec, server query string).
HISTORY_CASES = [
    ("repair tab, no filter", "repair", {}, ""),
    ("kalibrasi tab", "kalibrasi", {}, "punya=kalibrasi"),
    ("mutasi tab", "mutasi", {}, "punya=mutasi"),
    ("q=SIMULASI (teknisi name)", "repair", {"q": "SIMULASI"}, "q=SIMULASI"),
    ("q=[SIMULASI] (keterangan)", "repair", {"q": "[SIMULASI]"}, "q=%5BSIMULASI%5D"),
    ("q=LULUS (kalibrasi status)", "kalibrasi", {"q": "LULUS"},
     "punya=kalibrasi&q=LULUS"),
    ("q=KAL/2025 (certificate no)", "kalibrasi", {"q": "KAL/2025"},
     "punya=kalibrasi&q=KAL%2F2025"),
    ("q=BALAI YASA (pelaksana)", "kalibrasi", {"q": "BALAI YASA"},
     "punya=kalibrasi&q=BALAI+YASA"),
    ("q=perbaikan (alasan mutasi)", "mutasi", {"q": "PERBAIKAN"},
     "punya=mutasi&q=PERBAIKAN"),
    ("q=DAOP 1 on mutasi tab", "mutasi", {"q": "DAOP 1"}, "punya=mutasi&q=DAOP+1"),
    ("q=ZZZQQQ", "repair", {"q": "ZZZQQQ"}, "q=ZZZQQQ"),
    ("filter alat PBT", "repair", {"alat": "PBT"}, "alat=PBT"),
    ("filter lokasi VIII", "repair", {"lokasi": "VIII"}, "lokasi=VIII"),
    ("filter peruntukan B", "repair", {"peruntukan": "B"}, "peruntukan=B"),
    ("filter tahun 2025", "repair", {"tahunFrom": "2025", "tahunTo": "2025"},
     "tahun_from=2025&tahun_to=2025"),
    ("combined on kalibrasi tab", "kalibrasi", {"alat": "PBT", "lokasi": "D1"},
     "punya=kalibrasi&alat=PBT&lokasi=D1"),
]

HISTORY_JS = """
    const spec = %s, tab = %s;
    const rows = _historySummary.filter((item) => {
        if (tab === "kalibrasi" && !item.has_kalibrasi) return false;
        if (tab === "mutasi" && !item.mutasi) return false;
        if (spec.q && !_historySearchMatches(item, spec.q.toUpperCase())) return false;
        return _historyFilterMatches(item, {
            alat: spec.alat || "", pengadaan: spec.pengadaan || "",
            peruntukan: spec.peruntukan || "", lokasi: spec.lokasi || "",
            upt: spec.upt || "", tahunFrom: spec.tahunFrom || "",
            tahunTo: spec.tahunTo || "", idFrom: spec.idFrom || null,
            idTo: spec.idTo || null,
        });
    });
    return JSON.stringify(rows.map((x) => x.id_aset));
"""

FILTER_JS = """
    const spec = %s;
    return JSON.stringify(db.filter((item) => {
        const ident = assetLokasiIdentity(item);
        if (spec.q && !assetMatchesSearch(item, spec.q.toUpperCase())) return false;
        if (spec.alat && item.kode_alat !== spec.alat) return false;
        if (!_pengadaanMatches(item.sumber_pengadaan, spec.pengadaan || "")) return false;
        if (spec.peruntukan) {
            if (decodeAsetId(item.id_aset).peruntukan !== spec.peruntukan) return false;
        }
        if (!lokasiMatchesCode(ident, spec.lokasi || "")) return false;
        if (spec.upt && ident.uptCode !== spec.upt) return false;
        if (spec.status && (item.status_terakhir || "").toUpperCase() !== spec.status)
            return false;
        if (spec.tahunFrom || spec.tahunTo) {
            const yr = parseInt((item.tanggal_pembelian || "").slice(0, 4));
            if (spec.tahunFrom && yr < parseInt(spec.tahunFrom)) return false;
            if (spec.tahunTo && yr > parseInt(spec.tahunTo)) return false;
        }
        if (spec.idFrom || spec.idTo) {
            const num = parseInt((item.id_aset || "").split(".")[0]) || 0;
            if (spec.idFrom && num < spec.idFrom) return false;
            if (spec.idTo && num > spec.idTo) return false;
        }
        return true;
    }).map((x) => x.id_aset));
"""

# The SHIPPED comparator, not a copy of it.
#
# `_historyComparator` reads the module-level `_histSortField` / `_histSortDir`,
# so the case is driven by setting those and calling it — which is exactly how
# Pantau Riwayat drove it before rev0.4.5 moved sorting to the server. Writing
# the comparison out again here would be the "second copy of the rule" this
# codebase keeps deleting, and it would agree with the server right up until
# somebody changed one of them.
ORDER_JS = """
    _histSortField = %s;
    _histSortDir = %s;
    const rows = db.slice().sort(_historyComparator);
    return JSON.stringify(rows.map((x) => x.id_aset));
"""


async def main():
    if not PW:
        print("BOOTSTRAP_ADMIN_PASSWORD missing from .env")
        return 2

    s = requests.Session()
    r = s.post(f"{BASE}/api/login", json={"username": USER, "password": PW})
    if r.status_code != 200:
        print(f"login failed: {r.status_code} {r.text[:200]}")
        return 2
    H = {"Authorization": f"Bearer {r.json()['access_token']}"}

    fails = []
    c = Chrome(port=9333)
    await c.start()
    try:
        await c.goto(BASE, wait=3.0)
        # Tailwind is a JIT compiler that rewrites the DOM, so the login form
        # is not necessarily present at navigate+3s. Wait for it rather than
        # guessing a sleep long enough.
        await c.js("""
            const deadline = Date.now() + 20000;
            while (Date.now() < deadline) {
                if (document.getElementById('login-username')) return 1;
                if (sessionStorage.getItem('authToken')) return 2;
                await new Promise(r => setTimeout(r, 200));
            }
            return 0;
        """, awaitPromise=True)
        who = await c.login(USER, PW)
        if who != "SUPER_ADMIN":
            print("login in browser failed:", who, c.drain_console()[:5])
            return 2

        # Load a FULL copy deliberately — see the module docstring.
        n = await c.js("""
            db = (await fetchAllPages('/aset', { background: true })).map(_decorateAset);
            _historySummary = await fetchAllPages('/history/summary', { background: true });
            rebuildSummaryIndex();
            return db.length;
        """, awaitPromise=True)
        print(f"client fleet loaded: {n} assets\n")

        print("-- filter parity --")
        for label, spec, qs in CASES:
            client = json.loads(await c.js(FILTER_JS % json.dumps(spec)))
            url = f"{BASE}/api/aset?limit=5000" + (f"&{qs}" if qs else "")
            server = [x["id_aset"] for x in s.get(url, headers=H).json()["items"]]

            cs, ss = set(client), set(server)
            if cs == ss:
                print(f"  ok   {label:<38} {len(cs)} rows")
            else:
                print(f"  FAIL {label:<38} client {len(cs)} vs server {len(ss)}")
                if cs - ss:
                    print(f"         client only: {sorted(cs - ss)[:6]}")
                if ss - cs:
                    print(f"         server only: {sorted(ss - cs)[:6]}")
                fails.append(label)

        print("\n-- pantau riwayat parity --")
        for label, tab, spec, qs in HISTORY_CASES:
            client = json.loads(
                await c.js(HISTORY_JS % (json.dumps(spec), json.dumps(tab)))
            )
            url = f"{BASE}/api/history/summary?limit=5000" + (f"&{qs}" if qs else "")
            server = [x["id_aset"] for x in s.get(url, headers=H).json()["items"]]

            cs, ss = set(client), set(server)
            if cs == ss:
                print(f"  ok   {label:<38} {len(cs)} rows")
            else:
                print(f"  FAIL {label:<38} client {len(cs)} vs server {len(ss)}")
                if cs - ss:
                    print(f"         client only: {sorted(cs - ss)[:6]}")
                if ss - cs:
                    print(f"         server only: {sorted(ss - cs)[:6]}")
                fails.append(f"history:{label}")

        print("\n-- order parity --")
        for label, field, direction in ORDER_CASES:
            client = json.loads(
                await c.js(ORDER_JS % (json.dumps(field), json.dumps(direction)))
            )
            url = f"{BASE}/api/aset?limit=5000&sort={field}&dir={direction}"
            server = [x["id_aset"] for x in s.get(url, headers=H).json()["items"]]

            if client == server:
                print(f"  ok   {label:<38} {len(server)} rows, same order")
            else:
                i = next(
                    (i for i, (a, b) in enumerate(zip(client, server)) if a != b), None
                )
                print(f"  FAIL {label:<38} first difference at index {i}")
                if i is not None:
                    print(f"         client {client[i:i + 4]}")
                    print(f"         server {server[i:i + 4]}")
                fails.append(f"order:{label}")
    finally:
        await c.close()

    print()
    if fails:
        print(f"FAILED - {len(fails)} case(s): {', '.join(fails)}")
        return 1
    print(
        f"OK - {len(CASES)} filter, {len(HISTORY_CASES)} riwayat and "
        f"{len(ORDER_CASES)} order cases agree"
    )
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
