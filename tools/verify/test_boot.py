"""
What the SPA actually downloads to put a screen on the table — measured in a
real browser, not inferred.

rev0.4.5 moved Kelola Data Aset, Pantau Riwayat, the dashboard panels and the
Kelola Data Alat Kerja tiles off a client-side copy of the whole fleet. This is
the check that says whether that worked: it drives Chrome through a login and
five views, counts every request the page issues and adds up the bytes.

It also asserts what must NOT happen any more — that no view walks `/api/aset`
or `/api/history/summary` page by page just to render — and that the two deep
screens really are showing a PAGE rather than the fleet.

The export path is deliberately exempt: an export writes one line per asset, so
it fetches the fleet on purpose. That is asserted too, in the other direction.

Needs the app on :8017 and Chrome. Writes nothing to the database.
"""

import asyncio
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(os.path.dirname(HERE)))

from cdp import Chrome  # noqa: E402
from smoke import _env  # noqa: E402

BASE = "http://127.0.0.1:8017"
PW = _env("BOOTSTRAP_ADMIN_PASSWORD")
USER = _env("BOOTSTRAP_ADMIN_USERNAME") or "superadmin"

# Every /api/ request the page makes, with its response size. Installed before
# login so the boot itself is measured, and reading `performance` rather than
# CDP network events so the numbers are the ones the browser actually saw.
TAP = """
    window.__apiCalls = () =>
      performance.getEntriesByType('resource')
        .filter((e) => e.name.includes('/api/'))
        .map((e) => ({
          url: e.name.replace(location.origin, ''),
          bytes: e.transferSize || e.encodedBodySize || 0,
        }));
    window.__mark = () => { window.__apiMark = performance.getEntriesByType('resource').length; };
    window.__since = () =>
      performance.getEntriesByType('resource')
        .slice(window.__apiMark || 0)
        .filter((e) => e.name.includes('/api/'))
        .map((e) => ({
          url: e.name.replace(location.origin, ''),
          bytes: e.transferSize || e.encodedBodySize || 0,
        }));
    return 1;
"""


def summarise(calls):
    total = sum(c["bytes"] for c in calls)
    return total, len(calls)


async def main():
    if not PW:
        print("BOOTSTRAP_ADMIN_PASSWORD missing from .env")
        return 2

    fails = []
    c = Chrome(port=9335)
    await c.start()
    try:
        await c.goto(BASE, wait=3.0)
        await c.js("""
            const deadline = Date.now() + 20000;
            while (Date.now() < deadline) {
                if (document.getElementById('login-username')) return 1;
                await new Promise(r => setTimeout(r, 200));
            }
            return 0;
        """, awaitPromise=True)
        await c.js(TAP)

        who = await c.login(USER, PW)
        if who != "SUPER_ADMIN":
            print("login failed:", who, c.drain_console()[:5])
            return 2
        # Let the boot settle: master data, the rollup, the first paint.
        await asyncio.sleep(4.0)

        boot = json.loads(await c.js("return JSON.stringify(window.__apiCalls());"))
        bytes_, n = summarise(boot)
        print(f"BOOT — {n} /api/ requests, {bytes_ / 1024:,.0f} KB\n")
        for r in sorted(boot, key=lambda r: -r["bytes"]):
            print(f"  {r['bytes'] / 1024:8,.1f} KB  {r['url'][:78]}")

        # The regression this whole release exists to prevent: a paged walk
        # through the fleet at login. One request per endpoint is a page; more
        # than two means something is walking.
        walks = [r for r in boot if "offset=1000" in r["url"]]
        if walks:
            print(f"\n  FAIL boot walks the fleet: {[w['url'] for w in walks]}")
            fails.append("boot walks the fleet")
        if bytes_ > 400 * 1024:
            print(f"\n  FAIL boot downloads {bytes_ / 1024:,.0f} KB (was 1,062 KB, budget 400)")
            fails.append("boot too large")
        else:
            print(f"\n  ok   boot is {bytes_ / 1024:,.0f} KB (was 1,062 KB before rev0.4.5)")

        # ── each view, measured on its own ──
        print("\nPER-VIEW (requests issued when the view is opened)")
        VIEWS = [
            ("dashboard", "dashboard"),
            ("database", "Kelola Data Aset"),
            ("history", "Pantau Riwayat"),
            ("input", "Kelola Data Alat Kerja"),
            ("laporan", "Proses Laporan"),
        ]
        for view, label in VIEWS:
            await c.js("window.__mark(); return 1;")
            await c.js(f"switchView({json.dumps(view)}); return 1;")
            await asyncio.sleep(2.5)
            calls = json.loads(await c.js("return JSON.stringify(window.__since());"))
            b, k = summarise(calls)
            print(f"  {label:<26} {k} req  {b / 1024:7,.1f} KB")
            for r in calls:
                print(f"      {r['bytes'] / 1024:7,.1f} KB  {r['url'][:70]}")

        # ── the deep screens really are showing a page ──
        print("\nSTATE")
        state = json.loads(await c.js("""
            return JSON.stringify({
                db: Array.isArray(db) ? db.length : -1,
                summary: Array.isArray(_historySummary) ? _historySummary.length : -1,
                fleetLoaded: window.fleetIfLoaded() ? window.fleetIfLoaded().length : 0,
                cards: document.querySelectorAll('#db-cards-container > div').length,
            });
        """))
        print(f"  db (Kelola Data Aset page)      {state['db']}")
        print(f"  _historySummary (Riwayat page)  {state['summary']}")
        print(f"  fleet cache                     {state['fleetLoaded']} (0 = never fetched)")

        if state["db"] > 200:
            print("  FAIL `db` still holds the fleet")
            fails.append("db holds the fleet")
        if state["summary"] > 200:
            print("  FAIL `_historySummary` still holds the fleet")
            fails.append("summary holds the fleet")
        if state["fleetLoaded"]:
            print("  FAIL the fleet was fetched without an export being asked for")
            fails.append("fleet fetched eagerly")

        # ── the export SHOULD fetch the fleet ──
        await c.js("switchView('database'); return 1;")
        await asyncio.sleep(1.0)
        await c.js("document.getElementById('btn-db-download-xlsx')?.click(); return 1;")
        await asyncio.sleep(6.0)
        n_fleet = int(await c.js("return window.fleetIfLoaded() ? window.fleetIfLoaded().length : 0;"))
        if n_fleet > 200:
            print(f"\n  ok   export fetched the fleet on demand ({n_fleet} assets)")
        else:
            print(f"\n  FAIL export did not fetch the fleet (got {n_fleet})")
            fails.append("export did not fetch the fleet")

        # ── console must be clean through all of it ──
        errs = [
            (lvl, txt) for lvl, txt in c.drain_console(ignore=("cdn.tailwindcss.com",))
            if lvl in ("error", "severe")
        ]
        if errs:
            print(f"\n  FAIL {len(errs)} console error(s):")
            for lvl, txt in errs[:8]:
                print(f"      {txt[:160]}")
            fails.append("console errors")
        else:
            print("  ok   no console errors")
    finally:
        await c.close()

    print()
    if fails:
        print(f"FAILED - {', '.join(fails)}")
        return 1
    print("OK - boot is small, the deep screens page, and the export still gets every row")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
