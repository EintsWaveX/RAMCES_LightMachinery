"""
Drive the KDAK stepper and the live id_aset preview in a real browser.

The decisive assertion is the last one: build an asset through the form, read
the ID the preview claims, POST the same values, and compare against the ID the
server actually mints. A preview that is merely plausible is worse than none.
"""

import asyncio
import json
import os
import sys

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from cdp import Chrome  # noqa: E402
from smoke import _env  # noqa: E402

BASE = "http://127.0.0.1:8017"
PW = _env("BOOTSTRAP_ADMIN_PASSWORD")


async def main():
    c = Chrome(port=9331)
    fails = []
    await c.start()
    try:
        await c.goto(BASE, wait=3.0)
        who = await c.login("superadmin", PW)
        print("logged in as:", who)
        if who != "SUPER_ADMIN":
            print("console:", c.drain_console()[:5])
            return 1
        # The boot path fetches the whole fleet in pages; the preview reads `db`.
        await c.js("""
            const deadline = Date.now() + 30000;
            while (Date.now() < deadline) {
                if (typeof db !== 'undefined' && Array.isArray(db) && db.length > 1000) return db.length;
                await new Promise(r => setTimeout(r, 250));
            }
            return typeof db !== 'undefined' && Array.isArray(db) ? db.length : -1;
        """, awaitPromise=True)

        # ── open Kelola Data Alat Kerja and its Tambah form ────────
        await c.js("switchView('input'); return 1;")
        await asyncio.sleep(1.5)
        await c.js("document.getElementById('kdak-btn-tambah').click(); return 1;")
        await asyncio.sleep(0.8)

        state = await c.js("""
            const m = document.getElementById('kdak-tambah-modal');
            return {
                open: !m.classList.contains('hidden'),
                preview: document.getElementById('in-preview')?.innerText,
                steps: [...document.querySelectorAll('#form-input-baru .step')]
                    .map(s => ({ n: s.dataset.step,
                                 done: s.classList.contains('is-done'),
                                 active: s.classList.contains('is-active') })),
            };
        """)
        print(f"\nmodal open: {state['open']}")
        print(f"empty preview: {state['preview']!r}")
        active = [s["n"] for s in state["steps"] if s["active"]]
        print(f"steps active on open: {active}  (want ['1'])")
        if active != ["1"]:
            fails.append(f"on open, active step should be 1, got {active}")
        if "<no. urut>" not in (state["preview"] or ""):
            fails.append("empty preview does not show placeholder segments")

        # ── fill the form step by step, watching the preview ───────
        print("\nfilling the form:")
        steps = [
            ("in-alat", "RGM", "select"),
            ("in-pengadaan", "DAOP/DIVRE", "radio"),
            ("in-tanggal", "2026-08-15", "value"),
            ("in-unit", "B", "radio"),
            ("in-lokasi", "D1", "select"),
        ]
        for ident, val, kind in steps:
            if kind == "radio":
                await c.js(f"""
                    const r = document.querySelector('input[name="{ident}"][value={json.dumps(val)}]');
                    r.checked = true;
                    r.dispatchEvent(new Event('change', {{ bubbles: true }}));
                    return 1;
                """)
            else:
                await c.js(f"""
                    const el = document.getElementById({json.dumps(ident)});
                    el.value = {json.dumps(val)};
                    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                    return 1;
                """)
            await asyncio.sleep(0.25)
            prev = await c.js("return document.getElementById('in-preview')?.innerText;")
            print(f"   {ident:14} = {val:12} -> {prev}")

        final = await c.js("""
            return {
                preview: document.getElementById('in-preview')?.innerText,
                steps: [...document.querySelectorAll('#form-input-baru .step')]
                    .map(s => ({ n: s.dataset.step,
                                 done: s.classList.contains('is-done'),
                                 active: s.classList.contains('is-active') })),
                model: [...document.querySelectorAll('#in-model option')].map(o => o.textContent).slice(0,4),
            };
        """)
        print(f"\nfinal preview: {final['preview']!r}")
        print(f"model options after choosing RGM: {final['model']}")
        undone = [s["n"] for s in final["steps"] if not s["done"]]
        print(f"steps not done: {undone}  (1b and 6 are optional, so all should be done)")

        # ── the decisive check: does the server agree? ─────────────
        s = requests.Session()
        tok = s.post(f"{BASE}/api/login",
                     json={"username": "superadmin", "password": PW}).json()["access_token"]
        H = {"Authorization": f"Bearer {tok}"}
        r = s.post(f"{BASE}/api/aset", headers=H, json={
            "kode_alat": "RGM", "id_lokasi": "JR1.1", "parent_lokasi": "D1",
            "tanggal_pembelian": "2026-08-15", "sumber_pengadaan": "DAOP/DIVRE",
            "peruntukan": "JEMBATAN", "nomor_seri": "ZZ-PREVIEW-TEST",
        })
        actual = r.json().get("id_aset")
        predicted = (final["preview"] or "").strip()
        print(f"\npreview predicted : {predicted}")
        print(f"server minted     : {actual}")
        print(f"MATCH             : {predicted == actual}")
        if predicted != actual:
            fails.append(f"preview {predicted!r} != minted {actual!r}")

        # ── and the edit form shows the existing ID unchanged ──────
        await c.js("document.getElementById('close-kdak-tambah-modal').click(); return 1;")
        await asyncio.sleep(0.3)
        await c.js("await fetchAsetFromServer(); return 1;", awaitPromise=True)
        await asyncio.sleep(2.0)
        ed = await c.js(f"""
            openKdakEdit({json.dumps(actual)});
            await new Promise(r => setTimeout(r, 400));
            return {{
                preview: document.getElementById('kdak-edit-preview')?.innerText,
                warnHidden: document.getElementById('kdak-edit-preview-warn')?.classList.contains('hidden'),
                undone: [...document.querySelectorAll('#form-kdak-edit .step')]
                    .filter(s => !s.classList.contains('is-done')).map(s => s.dataset.step),
            }};
        """, awaitPromise=True)
        print(f"\nedit form preview : {ed['preview']}   (want {actual})")
        print(f"change warning hidden: {ed['warnHidden']}  (want True — nothing changed yet)")
        if (ed["preview"] or "").strip() != actual:
            fails.append(f"edit preview {ed['preview']!r} != {actual!r}")
        if not ed["warnHidden"]:
            fails.append("the ID-change warning shows before anything has changed")

        # change peruntukan -> the warning must appear and the ID must change
        await c.js("""
            const r = document.querySelector('input[name="kdak-edit-unit"][value="C"]');
            r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true }));
            return 1;
        """)
        await asyncio.sleep(0.3)
        ed2 = await c.js("""
            return {
                preview: document.getElementById('kdak-edit-preview')?.innerText,
                warnHidden: document.getElementById('kdak-edit-preview-warn')?.classList.contains('hidden'),
            };
        """)
        print(f"after changing peruntukan to MEKANIK: {ed2['preview']}  warning shown: {not ed2['warnHidden']}")
        if ed2["warnHidden"]:
            fails.append("changing peruntukan did not raise the ID-change warning")
        if ".C." not in (ed2["preview"] or ""):
            fails.append(f"peruntukan segment did not become C: {ed2['preview']!r}")

        # ── clean up the asset we created ──────────────────────────
        from sqlalchemy import text
        from database import engine
        with engine.begin() as conn:
            for t in ("riwayat_kalibrasi", "riwayat_mutasi", "riwayat_kondisi"):
                conn.execute(text(f"DELETE FROM {t} WHERE id_aset = :a"), {"a": actual})
            conn.execute(text("DELETE FROM aset WHERE id_aset = :a"), {"a": actual})
        with engine.connect() as conn:
            n = conn.execute(text("SELECT count(*) FROM aset")).scalar()
        print(f"\ncleanup: aset count back to {n} (want 1121)")
        if n != 1121:
            fails.append(f"aset count {n} != 1121 after cleanup")

        errs = c.drain_console(ignore=("favicon", "Tailwind CDN", "cdn.tailwindcss"))
        print(f"\nconsole errors/warnings: {len(errs)}")
        for lvl, txt in errs[:8]:
            print(f"   [{lvl}] {txt[:150]}")

        print()
        if fails:
            print(f"FAILED ({len(fails)})")
            for f in fails:
                print(f"  - {f}")
            return 1
        print("OK — stepper and live id_aset preview agree with the server")
        return 0
    finally:
        await c.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
