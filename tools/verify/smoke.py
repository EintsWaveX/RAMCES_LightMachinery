"""
End-to-end smoke test against a running RAMCES instance.

    py -3.10 smoke.py [base_url]

Read-only by default: it logs in, then GETs every endpoint group the split
touches and reports status + a shape hint. The point is catching the failure the
route/openapi diffs cannot see — a handler that moved without the helper it
calls, which boots clean and 500s on first request.
"""

import io
import json
import os
import sys

import requests

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8017"
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# .env is not exported into this process; read the bootstrap password directly.
def _env(key):
    with open(os.path.join(ROOT, ".env"), encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def main():
    fails = []
    s = requests.Session()

    # ── static + conditional requests (api/files.py) ──
    r = s.get(f"{BASE}/js/core.js")
    ok = r.status_code == 200 and r.headers.get("Cache-Control") == "no-cache"
    print(f"  GET /js/core.js                 {r.status_code} cc={r.headers.get('Cache-Control')!r}")
    if not ok:
        fails.append("js/core.js 200 + no-cache")
    etag = r.headers.get("ETag")
    r2 = s.get(f"{BASE}/js/core.js", headers={"If-None-Match": etag or ""})
    print(f"  GET /js/core.js (If-None-Match) {r2.status_code}  <- must be 304")
    if r2.status_code != 304:
        fails.append("conditional 304 on /js/core.js")

    r = s.get(f"{BASE}/")
    print(f"  GET /                           {r.status_code}")
    if r.status_code != 200:
        fails.append("GET /")

    r = s.get(f"{BASE}/uploads/sertifikat/anything.jpg")
    print(f"  GET /uploads/... (catch-all)    {r.status_code}  <- must be 404")
    if r.status_code != 404:
        fails.append("uploads/ must be refused by the catch-all")

    # public foto_alat route, if any photo exists
    foto_dir = os.path.join(ROOT, "uploads", "foto_alat")
    names = [n for n in os.listdir(foto_dir)] if os.path.isdir(foto_dir) else []
    if names:
        r = s.get(f"{BASE}/uploads/foto_alat/{names[0]}")
        print(f"  GET /uploads/foto_alat/<f>      {r.status_code}  (public, no token)")
        if r.status_code != 200:
            fails.append("public foto_alat route")
    else:
        print("  GET /uploads/foto_alat/<f>      skipped (no photos on disk)")

    # ── auth ──
    pw = _env("BOOTSTRAP_ADMIN_PASSWORD")
    r = s.post(f"{BASE}/api/login", json={"username": "superadmin", "password": pw})
    print(f"  POST /api/login                 {r.status_code}")
    if r.status_code != 200:
        fails.append(f"login: {r.status_code} {r.text[:200]}")
        print("\n".join(f"  FAIL {f}" for f in fails))
        return 1
    token = r.json()["access_token"]
    H = {"Authorization": f"Bearer {token}"}

    r = s.post(f"{BASE}/api/login", json={"username": "superadmin", "password": "salah"})
    print(f"  POST /api/login (wrong pw)      {r.status_code} {r.json().get('detail')!r}")
    if r.status_code != 401 or r.json().get("detail") != "Username atau password salah.":
        fails.append("wrong-password message/status changed")

    r = s.get(f"{BASE}/api/aset?limit=2")
    print(f"  GET /api/aset (no token)        {r.status_code}  <- must be 401")
    if r.status_code != 401:
        fails.append("unauthenticated /api/aset must 401")

    # ── every read path, grouped by the module it will live in ──
    checks = [
        ("auth",       "/api/me", lambda j: j.get("role")),
        ("auth",       "/api/users", lambda j: f"{len(j)} users"),
        ("config",     "/api/config", lambda j: list(j)),
        ("master",     "/api/master/alat", lambda j: f"{len(j)} alat"),
        ("master",     "/api/master/lokasi", lambda j: f"{len(j)} lokasi"),
        ("master",     "/api/master/upt", lambda j: f"{len(j)} upt"),
        ("master",     "/api/master/varian", lambda j: f"{len(j)} varian"),
        ("aset",       "/api/aset?limit=3", lambda j: f"total={j['total']} items={len(j['items'])}"),
        ("aset",       "/api/aset/afkir", lambda j: f"{len(j)} afkir"),
        ("riwayat",    "/api/history/summary?limit=3", lambda j: f"total={j['total']} items={len(j['items'])}"),
        ("riwayat",    "/api/export/riwayat", lambda j: f"{len(j)} rows"),
        ("riwayat",    "/api/export/mutasi", lambda j: f"{len(j)} rows"),
        ("inventaris", "/api/inventaris/kategori", lambda j: f"{len(j)} kategori"),
        ("inventaris", "/api/inventaris/gudang", lambda j: f"{len(j)} gudang"),
        ("inventaris", "/api/inventaris/parts", lambda j: f"{len(j)} parts"),
        ("inventaris", "/api/inventaris/stok?limit=3", lambda j: f"total={j['total']}"),
        ("inventaris", "/api/inventaris/transfer", lambda j: f"total={j['total']}"),
        ("inventaris", "/api/inventaris/pemakaian", lambda j: f"{len(j)} pemakaian"),
        ("inventaris", "/api/inventaris/dashboard", lambda j: list(j)[:4]),
        # The reconciling identity holds exactly on "Semua Tahun" (all_years).
        # A single year cannot satisfy it: `sedang` is a point-in-time count of
        # currently-TSO assets, deliberately not year-scoped.
        ("dashboard",  "/api/aset/dashboard/perbaikan?tahun=all",
         lambda j: (f"masuk={j['masuk']} = selesai {j['selesai']} + afkir {j['diafkir']}"
                    f" + sedang {j['sedang']}"
                    + ("" if j["masuk"] == j["selesai"] + j["diafkir"] + j["sedang"]
                       else "   <<< IDENTITY BROKEN"))),
        ("dashboard",  "/api/aset/dashboard/mcf", lambda j: list(j)[:4]),
    ]
    print()
    for bucket, path, shape in checks:
        try:
            r = s.get(f"{BASE}{path}", headers=H, timeout=60)
            if r.status_code != 200:
                print(f"  FAIL [{bucket:10}] {path:42} {r.status_code} {r.text[:160]}")
                fails.append(f"{path} -> {r.status_code}")
                continue
            print(f"  ok   [{bucket:10}] {path:42} {shape(r.json())}")
        except Exception as e:
            print(f"  FAIL [{bucket:10}] {path:42} {type(e).__name__}: {e}")
            fails.append(f"{path} -> {e}")

    # ── one asset drill-down: the per-asset routes ──
    items = s.get(f"{BASE}/api/aset?limit=1", headers=H).json()["items"]
    if items:
        uid = items[0]["id_aset"]
        for path in [
            f"/api/riwayat-kondisi/{uid}",
            f"/api/kalibrasi/{uid}",
            f"/api/mutasi/{uid}",
            f"/api/aset/{uid}/pemakaian",
            f"/api/public/aset/{uid}",
        ]:
            r = s.get(f"{BASE}{path}", headers=H)
            print(f"  {'ok  ' if r.status_code == 200 else 'FAIL'} [asset     ] {path:42} {r.status_code}")
            if r.status_code != 200:
                fails.append(f"{path} -> {r.status_code} {r.text[:160]}")

    print()
    if fails:
        print(f"FAILED ({len(fails)})")
        for f in fails:
            print(f"  - {f}")
        return 1
    print("OK — all smoke checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
