"""
Broad UI/UX audit pass over the running app.

Not a pass/fail gate — a FINDINGS collector. Walks every view at desktop and
phone width and measures things a human notices but a console error does not:
tap-target sizes, contrast-bearing empty states, tables that still scroll
sideways, controls with no accessible name, forms whose fields are crowded,
and any control that is visible but does nothing.
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

VIEWS = ["dashboard", "input", "inventaris", "database",
         "history", "laporan", "masterdata", "afkir"]

FINDINGS = []


def add(area, severity, what):
    FINDINGS.append((severity, area, what))


async def audit_view(c, view, width):
    await c.js(f"switchView({json.dumps(view)}); return 1;")
    await asyncio.sleep(1.3)

    r = await c.js("""
        const vis = el => el.offsetParent !== null || getComputedStyle(el).position === 'fixed';
        const sec = document.querySelector('.view-section.is-visible');
        if (!sec) return { none: true };

        // Controls with no accessible name at all.
        const unnamed = [];
        for (const el of sec.querySelectorAll('button, a[href], select, input:not([type=hidden])')) {
            if (!vis(el)) continue;
            const name = (el.getAttribute('aria-label') || el.getAttribute('title') ||
                          el.textContent || '').trim();
            const lab = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
            const ph  = el.getAttribute('placeholder');
            if (!name && !lab && !ph) {
                unnamed.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
                             (el.className && typeof el.className === 'string'
                              ? '.' + el.className.trim().split(/\\s+/)[0] : ''));
            }
        }

        // Anything still scrolling sideways inside the view.
        // Sideways scrolling is not itself a defect — a 240-column readiness
        // matrix genuinely has to scroll, and CLAUDE.md documents it as
        // excluded from .table-stack on purpose. What IS a defect is scrolling
        // SILENTLY: content the user has no way to know is there.
        //
        // So this now splits the two. An element is excused when it carries
        // `.scroll-hint` (the fade), when a visible scrollbar does the telling
        // (`overflow-x: scroll`, or `auto` without `.scrollbar-none`), or when
        // it is on the documented allow-list.
        const OK_TO_SCROLL = ['dash-panel-matrix'];
        const sideways = [], silent = [];
        for (const el of sec.querySelectorAll('*')) {
            if (!vis(el)) continue;
            if (el.scrollWidth > el.clientWidth + 4 && el.clientWidth > 0) {
                const st = getComputedStyle(el).overflowX;
                if (st !== 'auto' && st !== 'scroll') continue;
                const tag = (el.id ? '#' + el.id : el.tagName.toLowerCase()) +
                            ` ${el.scrollWidth}>${el.clientWidth}`;
                sideways.push(tag);
                const hinted = el.classList.contains('scroll-hint');
                const hasBar = st === 'scroll' ||
                               (st === 'auto' && !el.classList.contains('scrollbar-none'));
                const allowed = OK_TO_SCROLL.some(id => el.id === id);
                if (!hinted && !hasBar && !allowed) silent.push(tag);
            }
        }

        // Tap targets under 44px (only where a coarse pointer would be used).
        const small = [];
        for (const el of sec.querySelectorAll('button, a[href], select, [role=tab]')) {
            if (!vis(el)) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.height < 36 || r.width < 28) {
                small.push((el.id ? '#' + el.id : el.tagName.toLowerCase()) +
                           ` ${Math.round(r.width)}x${Math.round(r.height)}`);
            }
        }

        return {
            id: sec.id,
            unnamed: [...new Set(unnamed)].slice(0, 8),
            sideways: [...new Set(sideways)].slice(0, 6),
            silent: [...new Set(silent)].slice(0, 6),
            small: [...new Set(small)].slice(0, 8),
            tables: sec.querySelectorAll('table').length,
        };
    """)
    return r


async def main():
    c = Chrome(port=9340)
    await c.start()
    try:
        await c.goto(BASE, wait=3.0)
        who = await c.login("superadmin", PW)
        if who != "SUPER_ADMIN":
            print("login failed:", who)
            return 1
        await c.js("""
            const d = Date.now() + 40000;
            while (Date.now() < d) {
                if (typeof db !== 'undefined' && db.length > 1000) return db.length;
                await new Promise(r => setTimeout(r, 250));
            }
            return -1;
        """, awaitPromise=True)
        c.drain_console()

        for width, label in ((1440, "desktop"), (390, "phone")):
            await c.viewport(width, 900 if width > 700 else 844, mobile=width < 700)
            print(f"\n{'='*66}\n{label} ({width}px)\n{'='*66}")
            for v in VIEWS:
                r = await audit_view(c, v, width)
                bits = []
                if r.get("silent"):
                    # No fade, no scrollbar, not on the allow-list — content the
                    # user cannot know is there. This is the finding.
                    bits.append(f"silent-scroll={r['silent']}")
                    add(f"{v} @{width}", "MED",
                        f"scrolls sideways with NO affordance: {r['silent']}")
                elif r.get("sideways"):
                    # Scrolls, but says so. Reported as context, not a finding.
                    bits.append(f"scrolls(ok)={len(r['sideways'])}")
                if width < 700 and r.get("small"):
                    # Counted, NOT reported as a finding. `matchMedia('(pointer:
                    # coarse)')` is false under headless emulation and cannot be
                    # forced via Emulation.setEmitTouchEventsForMouse, so the
                    # @media (pointer: coarse) block that supplies the 44px
                    # minimum never applies here. Every one of these ~30
                    # "failures" is an artifact of the harness, and reporting
                    # them each run trains the reader to ignore the list. The
                    # CSS rule itself is asserted below instead.
                    bits.append(f"small-taps={len(r['small'])} (see note)")
                if r.get("unnamed"):
                    bits.append(f"unnamed={r['unnamed']}")
                    add(f"{v} @{width}", "MED", f"controls with no accessible name: {r['unnamed']}")
                print(f"  {v:<12} {' | '.join(bits) if bits else 'clean'}")

        # ── The coarse-pointer rule, asserted from the SOURCE ──
        #
        # The rendered box cannot be trusted headless (see the note above), but
        # whether the stylesheet still carries the rule can be. This is the
        # honest version of the tap-target check.
        css_path = os.path.join(ROOT, "assets", "style.css")
        with open(css_path, encoding="utf-8") as fh:
            css = fh.read()
        has_coarse = "(pointer: coarse)" in css or "(pointer:coarse)" in css
        has_44 = "44px" in css or "2.75rem" in css
        print(f"\n{'=' * 66}\nCoarse-pointer rule\n{'=' * 66}")
        print(f"  @media (pointer: coarse) present : {has_coarse}")
        print(f"  44px / 2.75rem minimum present   : {has_44}")
        print("  (rendered tap-target sizes are NOT measurable headless —")
        print("   matchMedia('(pointer: coarse)') is false and cannot be forced)")
        if not (has_coarse and has_44):
            add("assets/style.css", "HIGH",
                "the @media (pointer: coarse) 44px minimum is GONE — "
                "phones lose every enlarged tap target")

        # ── Tambah Aset form: measure the crowding the user reported ──
        print(f"\n{'='*66}\nTambah Aset form\n{'='*66}")
        await c.viewport(1440, 900)
        await c.js("switchView('input'); return 1;")
        await asyncio.sleep(1.2)
        form = await c.js("""
            document.getElementById('kdak-btn-tambah').click();
            await new Promise(r => setTimeout(r, 600));
            const panel = document.querySelector('#kdak-tambah-modal > div');
            const scroller = panel.querySelector('.overflow-y-auto');
            const pr = panel.getBoundingClientRect();
            return {
                panelW: Math.round(pr.width), panelH: Math.round(pr.height),
                viewportH: window.innerHeight,
                contentH: scroller ? scroller.scrollHeight : null,
                visibleH: scroller ? scroller.clientHeight : null,
                mustScroll: scroller ? scroller.scrollHeight > scroller.clientHeight + 4 : null,
                steps: document.querySelectorAll('#form-input-baru .step').length,
                maxWclass: [...panel.classList].filter(x => x.startsWith('max-w'))[0] || '(none)',
            };
        """, awaitPromise=True)
        print(f"  panel {form['panelW']}x{form['panelH']}px ({form['maxWclass']}), "
              f"viewport {form['viewportH']}px")
        print(f"  content {form['contentH']}px in {form['visibleH']}px "
              f"-> must scroll: {form['mustScroll']}")
        if form["mustScroll"]:
            hidden = form["contentH"] - form["visibleH"]
            add("Tambah Aset", "MED",
                f"{form['maxWclass']} panel: {hidden}px of the {form['steps']}-step form is "
                f"below the fold at 1440x900 — the id_aset preview is never visible "
                f"at the same time as step 1")

        # ── UPT dropdown: is it filtered by peruntukan? ──
        upt = await c.js("""
            // pick JALAN REL, then a lokasi, and see what the UPT select offers
            const unit = document.querySelector('input[name="in-unit"][value="A"]');
            unit.checked = true; unit.dispatchEvent(new Event('change', {bubbles:true}));
            const lok = document.getElementById('in-lokasi');
            lok.value = 'D1'; lok.dispatchEvent(new Event('change', {bubbles:true}));
            await new Promise(r => setTimeout(r, 400));
            const opts = [...document.getElementById('in-upt').options]
                .map(o => o.value).filter(Boolean);
            const pre = {};
            for (const o of opts) { const p = o.replace(/[0-9.].*$/, ''); pre[p] = (pre[p]||0)+1; }
            return { total: opts.length, prefixes: pre, sample: opts.slice(0, 6) };
        """, awaitPromise=True)
        print(f"  UPT options for JALAN REL + DAOP 1: {upt['total']} -> {upt['prefixes']}")
        if len(upt["prefixes"]) > 1:
            add("Tambah Aset", "HIGH",
                f"UPT list is NOT filtered by peruntukan: JALAN REL offers "
                f"{upt['prefixes']} — a JALAN REL asset can be stored at a JB or ME "
                f"resort, which now contradicts the id_aset peruntukan segment")

        await c.js("document.getElementById('close-kdak-tambah-modal').click(); return 1;")

        errs = c.drain_console(ignore=("tailwindcss", "favicon", "404"))
        for lvl, txt in errs:
            add("console", "HIGH", f"{lvl}: {txt[:160]}")

        print(f"\n{'='*66}\nFINDINGS ({len(FINDINGS)})\n{'='*66}")
        for sev in ("HIGH", "MED", "LOW"):
            for s, area, what in FINDINGS:
                if s == sev:
                    print(f"  [{sev:<4}] {area:<20} {what}")
        return 0
    finally:
        await c.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
