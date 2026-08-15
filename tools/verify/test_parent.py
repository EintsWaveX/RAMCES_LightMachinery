"""
The parent-derivation rule is duplicated in FOUR places. This proves all four
agree, on every real code plus the edge cases that make the rule fragile.

  1. api/deps.py            (the server)
  2. seeds/katalog.py       (the seed)
  3. js/core.js             (the SPA)          <- driven in real Chrome
  4. landing.html           (the QR card)      <- driven in real Chrome

Copies 3 and 4 are evaluated IN THE PAGE, not re-implemented here, because a
Python transliteration of a JS regex would only prove that my transliteration
agrees with itself. landing.html in particular had drifted for a whole release
and no checker reads it.
"""

import asyncio
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
os.chdir(ROOT)

from cdp import Chrome  # noqa: E402

BASE = "http://127.0.0.1:8017"

# Codes whose answer is fixed by the rule, not by the catalogue. The MEIV case
# is the one the `$` anchor exists for: drop the anchor and it returns VI.
EDGE = {
    "ME1.1": "D1", "ME1.2": "D1", "ME2": "D2", "ME9": "D9",
    "MEI": "VI", "MEII": "VII", "MEIII": "VIII", "MEIV": "VIV",
    "JR1.3": "D1", "JB1.1": "D1", "JBII": "VII", "JRIII.7": "VIII",
    "BY1A": "BY1", "BY3A": "BY3",
    "D1": None, "VIII": None, "BY1": None, "": None, "MEKANIK": None,
}


async def main():
    from seed_katalog import KATALOG_UPT
    from seeds.katalog import get_parent_lokasi_code as seed_rule
    from api.deps import get_parent_lokasi_code as server_rule

    codes = [k for k, _n, _p in KATALOG_UPT] + list(EDGE)
    expected_sheet = {k: p for k, _n, p in KATALOG_UPT}

    py_seed = {c: seed_rule(c) for c in codes}
    py_server = {c: server_rule(c) for c in codes}

    fails = []

    # ── the two Python copies, against the sheet and each other ──
    for c in codes:
        if py_seed[c] != py_server[c]:
            fails.append(f"{c}: seed={py_seed[c]} server={py_server[c]}")
    print(f"1&2. seeds/katalog.py vs api/deps.py over {len(codes)} codes: "
          f"{'AGREE' if not fails else str(len(fails)) + ' DISAGREE'}")

    wrong_sheet = [
        f"{c}: got {py_server[c]} want {expected_sheet[c]}"
        for c in expected_sheet if py_server[c] != expected_sheet[c]
    ]
    print(f"     vs the katalog's own Induk column ({len(expected_sheet)} rows): "
          f"{'OK' if not wrong_sheet else wrong_sheet[:4]}")
    fails += wrong_sheet

    wrong_edge = [
        f"{c}: got {py_server[c]!r} want {v!r}"
        for c, v in EDGE.items() if py_server[c] != v
    ]
    print(f"     vs {len(EDGE)} edge cases: {'OK' if not wrong_edge else wrong_edge}")
    fails += wrong_edge

    # ── the two JavaScript copies, in the browser ──
    c = Chrome(port=9335)
    await c.start()
    try:
        payload = json.dumps(codes)

        await c.goto(BASE, wait=3.0)
        js_spa = await c.js(
            f"const out={{}}; for (const k of {payload}) out[k]=getParentLokasiCode(k)||null; return out;"
        )
        uid = await c.js("return null;")

        await c.goto(f"{BASE}/landing.html?uid=1.ACK.1.24.A.VIII", wait=3.0)
        js_qr = await c.js(
            f"const out={{}}; for (const k of {payload}) out[k]=getParentLokasiCode(k)||null; return out;"
        )

        for label, got in (("3. js/core.js", js_spa), ("4. landing.html", js_qr)):
            bad = [
                f"{k}: js={got.get(k)!r} py={py_server[k]!r}"
                for k in codes if got.get(k) != py_server[k]
            ]
            print(f"{label:<20} vs api/deps.py over {len(codes)} codes: "
                  f"{'AGREE' if not bad else str(len(bad)) + ' DISAGREE'}")
            for b in bad[:6]:
                print(f"      {b}")
            fails += bad

        errs = c.drain_console(ignore=("tailwindcss", "favicon", "404"))
        print(f"\nconsole errors: {len(errs)}")
        for lvl, txt in errs[:4]:
            print(f"   [{lvl}] {txt[:150]}")
    finally:
        await c.close()

    print()
    if fails:
        print(f"FAILED ({len(fails)})")
        for f in fails[:12]:
            print(f"  - {f}")
        return 1
    print(f"OK — all FOUR copies agree on {len(codes)} codes "
          f"({len(expected_sheet)} real + {len(EDGE)} edge)")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
