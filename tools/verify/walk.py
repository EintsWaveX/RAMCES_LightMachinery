"""
Walk every view at both widths in both themes, collecting console errors and
horizontal overflow.

    py -3.10 walk.py

Two widths (1440x900 desktop, 390x844 phone) x two themes (light, dark) x every
view, plus landing.html. The 390px pass is the one that matters most: the whole
rev0.5.0 mobile layer exists so nothing scrolls sideways there, and this is the
only thing that actually checks it.
"""

import asyncio
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from cdp import Chrome  # noqa: E402
from smoke import _env  # noqa: E402

BASE = "http://127.0.0.1:8017"
PW = _env("BOOTSTRAP_ADMIN_PASSWORD")

VIEWS = [
    "dashboard", "input", "inventaris", "database",
    "history", "laporan", "masterdata", "afkir",
]

# Warnings that are true of the app as shipped and not this pass's business.
IGNORE = (
    "cdn.tailwindcss.com",
    "favicon",
    "Failed to load resource: the server responded with a status of 404",
)


async def sweep(c, label, width, height, dark):
    await c.viewport(width, height, mobile=width < 700)
    await c.js(f"""
        document.documentElement.classList.toggle('dark', {str(dark).lower()});
        localStorage.setItem('theme', {json.dumps('dark' if dark else 'light')});
        return 1;
    """)
    await asyncio.sleep(0.4)

    problems = []
    for v in VIEWS:
        await c.js(f"switchView({json.dumps(v)}); return 1;")
        await asyncio.sleep(1.4)

        errs = c.drain_console(ignore=IGNORE)
        for lvl, txt in errs:
            problems.append(f"[{label}] {v}: console {lvl}: {txt[:180]}")

        if width < 700:
            ov = await c.horizontal_overflow()
            if ov["docScrollW"] > ov["clientW"] + 1:
                names = ", ".join(o["sel"] for o in ov["overflows"][:5]) or "(none pinpointed)"
                problems.append(
                    f"[{label}] {v}: scrollWidth {ov['docScrollW']} > {ov['clientW']} — {names}"
                )
    return problems


async def main():
    c = Chrome(port=9333)
    all_problems = []
    await c.start()
    try:
        await c.goto(BASE, wait=3.0)
        who = await c.login("superadmin", PW)
        print(f"logged in as {who}")
        if who != "SUPER_ADMIN":
            return 1
        n = await c.js("""
            const deadline = Date.now() + 40000;
            while (Date.now() < deadline) {
                if (typeof db !== 'undefined' && Array.isArray(db) && db.length > 1000) return db.length;
                await new Promise(r => setTimeout(r, 250));
            }
            return typeof db !== 'undefined' ? db.length : -1;
        """, awaitPromise=True)
        print(f"fleet loaded: {n} assets\n")
        c.drain_console()

        for label, w, h, dark in [
            ("1440 light", 1440, 900, False),
            ("1440 dark", 1440, 900, True),
            (" 390 light", 390, 844, False),
            (" 390 dark", 390, 844, True),
        ]:
            probs = await sweep(c, label, w, h, dark)
            print(f"{label}: {'OK' if not probs else str(len(probs)) + ' problem(s)'}")
            for p in probs:
                print(f"    {p}")
            all_problems += probs

        # landing.html — the QR card, which imports only js/views/spektek.js
        print()
        for label, w, h in [("1440", 1440, 900), (" 390", 390, 844)]:
            await c.viewport(w, h, mobile=w < 700)
            uid = await c.js("return (db && db[0] && db[0].id_aset) || '';")
            await c.goto(f"{BASE}/landing.html?uid={uid}", wait=3.5)
            errs = c.drain_console(ignore=IGNORE)
            ov = await c.horizontal_overflow() if w < 700 else None
            bad = [f"console {l}: {t[:160]}" for l, t in errs]
            if ov and ov["docScrollW"] > ov["clientW"] + 1:
                bad.append(f"scrollWidth {ov['docScrollW']} > {ov['clientW']}")
            print(f"landing.html @{label}: {'OK' if not bad else bad}")
            all_problems += [f"landing {label}: {b}" for b in bad]
            await c.goto(BASE, wait=2.5)
            if w < 700:
                await c.login("superadmin", PW)
                await asyncio.sleep(3)

        print()
        if all_problems:
            print(f"FAILED ({len(all_problems)} problem(s))")
            return 1
        print("OK — 8 views x 2 widths x 2 themes plus landing.html, clean")
        return 0
    finally:
        await c.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
