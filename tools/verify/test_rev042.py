"""
The rev0.4.2 frontend changes, driven in a real browser.

    py -3.10 tools/verify/test_rev042.py    # needs the app on :8017 + Chrome

Six things, each of which was a defect a console-error sweep could not see:

  1. **The registration panel and the progressive captcha.** The captcha must be
     ABSENT on the login form until the server asks for it, and the SVG must
     actually render — `js/captcha.js` is loaded by both pages and is an IIFE
     exporting one global for that reason.
  2. **Role gating.** `switchView()` now guards, because 34 template-string
     `onclick=` handlers call it directly and hiding a sidebar button does
     nothing about any of them.
  3. **The UPT list filters by peruntukan.** JALAN REL + DAOP 1 offered 31
     options — 25 JR, 4 JB, 2 ME — so six of them minted an asset whose id_aset
     peruntukan segment contradicted the resort named in the same id.
  4. **The Tambah Aset form fits.** It was 916px of content in a 737px scroller,
     so the live id_aset preview and step 1 could never be on screen together —
     which defeats the point of a live preview.
  5. **landing.html's sign-in works at all.** It posted no password against a
     required field, so every QR-page sign-in 422'd, and it asked the user to
     declare their own role and region.
  6. **`dokumen_alat` reaches the client.** Three PDFs were on disk and
     reachable by nothing.
  7. **The dashboard tab strip.** Section 7 asserts the rev0.4.7 dashboard-
     overhaul contract, not the rev0.4.2 one any more — see the comment at
     that section for why the assertion inverted from "it scrolls, and the
     fade tells you so" to "it does not scroll, so there is nothing left to
     hint at".

Writes nothing to the database.
"""

import asyncio
import json
import os
import re
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

from cdp import Chrome  # noqa: E402
from smoke import _env  # noqa: E402

BASE = "http://127.0.0.1:8017"
PW = _env("BOOTSTRAP_ADMIN_PASSWORD")

# True of the app as shipped and not this pass's business.
IGNORE = ("cdn.tailwindcss.com", "favicon", "status of 404")

ok = fail = 0


def check(label, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  ok   {label}")
    else:
        fail += 1
        print(f"  FAIL {label}   {detail}")


async def run():
    c = Chrome(port=9231)
    await c.start()
    try:
        # ── 1. Login screen: registration + progressive captcha ──
        print("\n1. Login screen, registration panel, captcha widget")
        await c.goto(f"{BASE}/", wait=1.0)
        # POLL, do not sleep. index.html is ~460 KB and pulls 23 scripts, so a
        # fixed wait is a race that is lost only occasionally — which is worse
        # than losing it always, because the failure reads as "the register
        # button is gone" rather than "the page had not parsed yet". Wait for
        # the last js/ file to have EVALUATED (RamcesCaptcha is the global that
        # js/captcha.js exports) rather than for a wall-clock guess.
        await c.wait_for(
            "document.readyState === 'complete'"
            " && !!document.getElementById('btn-open-register')"
            " && typeof window.RamcesCaptcha === 'object'",
            timeout=25.0,
        )
        check("login screen: 0 console errors", not c.drain_console(IGNORE))

        r = await c.js("""
          return {
            hasRegBtn: !!document.getElementById('btn-open-register'),
            regHidden: document.getElementById('form-register')?.classList.contains('hidden'),
            capWrapHidden: document.getElementById('login-captcha-wrap')?.classList.contains('hidden'),
            hasCaptchaGlobal: typeof window.RamcesCaptcha === 'object',
          };""")
        check("register entry point present", r["hasRegBtn"], r)
        check("register panel starts hidden", r["regHidden"] is True, r)
        # The whole point of "progressive": a normal sign-in never sees one.
        check("login captcha starts hidden", r["capWrapHidden"] is True, r)
        check("RamcesCaptcha global loaded", r["hasCaptchaGlobal"], r)

        r = await c.js("""
          document.getElementById('btn-open-register').click();
          await new Promise(r => setTimeout(r, 1500));
          const img = document.getElementById('reg-captcha-img');
          return {
            loginHidden: document.getElementById('form-login').classList.contains('hidden'),
            regShown: !document.getElementById('form-register').classList.contains('hidden'),
            svg: !!img && img.innerHTML.indexOf('<svg') >= 0,
            glyphs: (img ? img.querySelectorAll('text').length : 0),
          };""", awaitPromise=True)
        check("register panel opens and login hides", r["loginHidden"] and r["regShown"], r)
        check("captcha SVG renders in the browser", r["svg"], r)
        check("captcha shows 5 glyphs", r["glyphs"] == 5, r)
        check("register panel: 0 console errors", not c.drain_console(IGNORE))
        await c.js("document.getElementById('btn-back-login').click(); return 1;")

        role = await c.login("superadmin", PW)
        check("login through the real form", role == "SUPER_ADMIN", role)
        await asyncio.sleep(4)
        check("post-login: 0 console errors", not c.drain_console(IGNORE))

        # ── 2. Role gating ──
        print("\n2. Role gating (NAV_ACCESS / VIEW_ACCESS / WRITE_ACCESS)")
        r = await c.js("""
          return {
            saMaster: canView('masterdata', 'SUPER_ADMIN'),
            tekMaster: canView('masterdata', 'TEKNISI'),
            gudLaporan: canView('laporan', 'PETUGAS_GUDANG'),
            tekLaporan: canView('laporan', 'TEKNISI'),
            pimWriteAset: canWrite('aset', 'PIMPINAN'),
            gudWriteInv: canWrite('inventaris', 'PETUGAS_GUDANG'),
            unknownArea: canWrite('tidakada', 'SUPER_ADMIN'),
          };""")
        check("SUPER_ADMIN sees Pusat Data", r["saMaster"])
        check("TEKNISI does not", not r["tekMaster"])
        check("PETUGAS_GUDANG sees Proses Laporan", r["gudLaporan"])
        check("TEKNISI does not", not r["tekLaporan"])
        check("PIMPINAN cannot write assets", not r["pimWriteAset"])
        check("PETUGAS_GUDANG can write inventory", r["gudWriteInv"])
        # An unknown AREA must deny, not allow: a typo here would grant a button.
        check("unknown write area fails CLOSED", not r["unknownArea"])

        r = await c.js("""
          const prior = _currentRole;
          _currentRole = 'TEKNISI';
          switchView('masterdata');
          const landed = document.getElementById('view-masterdata')?.classList.contains('is-visible');
          const dash = document.getElementById('view-dashboard')?.classList.contains('is-visible');
          _currentRole = prior;
          switchView('dashboard');
          return { landed: !!landed, dash: !!dash };""")
        check("switchView() refuses a gated view", not r["landed"], r)
        # Redirect rather than do nothing: a click with no visible result reads
        # as a broken button.
        check("...and redirects to the dashboard", r["dash"], r)

        # ── 3. UPT list filtered by peruntukan ──
        print("\n3. UPT list filtered by peruntukan")
        r = await c.js("""
          const out = {};
          const sel = document.getElementById('in-upt');
          document.getElementById('in-lokasi').value = 'D1';
          const letters = ['A','B','C'];
          for (let i = 0; i < letters.length; i++) {
            const L = letters[i];
            document.querySelector('input[name="in-unit"][value="' + L + '"]').checked = true;
            window.kdakSyncUpt('tambah');
            const codes = [].slice.call(sel.options).map(function(o){return o.value;}).filter(Boolean);
            const pre = {};
            codes.forEach(function(x){ pre[x.slice(0,2).toUpperCase()] = 1; });
            out[L] = { n: codes.length, prefixes: Object.keys(pre).sort() };
          }
          window.applyUptSelect('D1', sel);
          out.ALL = [].slice.call(sel.options).map(function(o){return o.value;}).filter(Boolean).length;
          return out;""")
        check("unfiltered DAOP 1 still offers all 31", r["ALL"] == 31, r["ALL"])
        check("JALAN REL -> only JR resorts", r["A"]["prefixes"] == ["JR"], r["A"])
        check("JEMBATAN  -> only JB resorts", r["B"]["prefixes"] == ["JB"], r["B"])
        check("MEKANIK   -> only ME resorts", r["C"]["prefixes"] == ["ME"], r["C"])
        # Partitioned, not merely filtered: nothing is dropped or double-counted.
        check("the three filters PARTITION the unfiltered list",
              r["A"]["n"] + r["B"]["n"] + r["C"]["n"] == r["ALL"],
              (r["A"]["n"], r["B"]["n"], r["C"]["n"], r["ALL"]))

        r = await c.js("""
          const sel = document.getElementById('in-upt');
          document.getElementById('in-lokasi').value = 'D1';
          document.querySelector('input[name="in-unit"][value="D"]').checked = true;
          window.kdakSyncUpt('tambah');
          return { text: sel.options[0] ? sel.options[0].text : '',
                   n: [].slice.call(sel.options).map(function(o){return o.value;}).filter(Boolean).length,
                   disabled: sel.disabled };""")
        check("a pair with no resorts shows a real empty state",
              r["n"] == 0 and "BALAIYASA" in (r["text"] or "") and r["disabled"], r)

        # ── 4. The Tambah Aset form fits ──
        print("\n4. Tambah Aset form")
        await c.js("document.getElementById('kdak-btn-tambah').click(); return 1;")
        await asyncio.sleep(0.8)
        r = await c.js("""
          const panel = document.querySelector('#kdak-tambah-modal > div');
          const form  = document.getElementById('form-input-baru');
          const scroller = form.parentElement;
          const prev = document.getElementById('in-preview-wrap').getBoundingClientRect();
          const step1 = document.getElementById('step-in-alat').getBoundingClientRect();
          return {
            panelW: Math.round(panel.getBoundingClientRect().width),
            content: form.scrollHeight,
            visible: scroller.clientHeight,
            pairs: document.querySelectorAll('#form-input-baru .step-pair').length,
            bothVisible: step1.top >= 0 && prev.bottom <= window.innerHeight,
          };""")
        check("panel widened to max-w-2xl (672px)", r["panelW"] == 672, r["panelW"])
        check("steps 2/3 and 5/6 paired", r["pairs"] == 2, r["pairs"])
        check("content fits its scroller", r["content"] <= r["visible"],
              f"{r['content']}px in {r['visible']}px")
        # The actual requirement: the live preview is usable.
        check("id preview and step 1 on screen together", r["bothVisible"], r)
        await c.js("document.getElementById('kdak-tambah-cancel').click(); return 1;")
        check("KDAK interaction: 0 console errors", not c.drain_console(IGNORE))

        # ── 5. landing.html sign-in ──
        print("\n5. landing.html sign-in")
        await c.goto(f"{BASE}/landing.html?uid=1.ACK.1.24.B.VIII", wait=3.5)
        check("landing.html: 0 console errors", not c.drain_console(IGNORE))
        r = await c.js("""
          if (typeof showLoginGate === 'function') showLoginGate();
          await new Promise(r => setTimeout(r, 500));
          const p = document.getElementById('gate-pass');
          return {
            hasPass: !!p, passType: p ? p.type : null,
            roleSel: !!document.getElementById('gate-role'),
            regionSel: !!document.getElementById('gate-region'),
            capWrapHidden: document.getElementById('gate-captcha-wrap')?.classList.contains('hidden'),
            captchaGlobal: typeof window.RamcesCaptcha === 'object',
          };""", awaitPromise=True)
        check("the gate now HAS a password field", r["hasPass"] and r["passType"] == "password", r)
        # These two were the privilege escalation, not merely clutter.
        check("self-declared ROLE dropdown is gone", not r["roleSel"], r)
        check("self-declared REGION dropdown is gone", not r["regionSel"], r)
        check("captcha hidden until the server asks", r["capWrapHidden"] is True, r)
        check("landing loaded js/captcha.js", r["captchaGlobal"], r)

        r = await c.js("""
          document.getElementById('gate-user').value = 'superadmin';
          document.getElementById('gate-pass').value = %s;
          document.getElementById('gate-form').dispatchEvent(
            new Event('submit', {bubbles:true, cancelable:true}));
          const dl = Date.now() + 8000;
          while (Date.now() < dl) {
            if (sessionStorage.getItem('authToken')) return 'ok';
            await new Promise(r => setTimeout(r, 100));
          }
          const e = document.getElementById('gate-err');
          return 'timeout: ' + (e && !e.classList.contains('hidden') ? e.textContent : '(no error shown)');
        """ % json.dumps(PW), awaitPromise=True)
        check("QR-page sign-in SUCCEEDS (every one used to 422)", r == "ok", r)
        await asyncio.sleep(2.5)
        check("landing after login: 0 console errors", not c.drain_console(IGNORE))

        # ── 6. dokumen_alat reaches the client ──
        print("\n6. dokumen_alat on the QR card")
        r = await c.js("""
          const list = await (await fetch('/api/aset?limit=2000',
            {headers:{Authorization:'Bearer '+sessionStorage.getItem('authToken')}})).json();
          const a = (list.items||[]).find(function(x){return x.kode_alat==='IMP';});
          if (!a) return {err:'no IMP asset'};
          const d = await (await fetch('/api/public/aset/'+a.id_aset)).json();
          return { id: a.id_aset,
                   dok: (d.dokumen||[]).map(function(x){return {j:x.jenis,u:x.utama,t:x.judul};}) };
        """, awaitPromise=True)
        check("public asset payload carries the document list", len(r.get("dok", [])) >= 2, r)
        spek = [d for d in r.get("dok", []) if d["j"] == "SPEK"]
        # IMP is one of the three tools whose second PDF used to be overwritten.
        check("IMP has BOTH spektek PDFs", len(spek) == 2, spek)
        check("exactly one is marked primary", sum(1 for d in spek if d["u"]) == 1, spek)

        # ── 7. The dashboard tab strip: grid, not scroll ──
        print("\n7. Dashboard tab strip (rev0.4.7: fits, does not scroll)")
        # rev0.4.2 shipped `#dash-tab-bar` as a `.scroll-hint` horizontal
        # scroller — 925px of six tabs in a 308px box at 390px wide — and this
        # section used to assert exactly that: the strip DOES overflow, and the
        # fade tells you so. That was correct for the markup that existed then.
        #
        # The rev0.4.7 dashboard overhaul (see the plan's "Tab strip — equal
        # stretch, no clipping") replaces it with a non-scrolling CSS grid —
        # `grid-cols-3` over two rows under `sm:`, `grid-cols-6` in one row from
        # `sm:` up — and deletes `#dash-tab-prev`/`#dash-tab-next` and
        # `.scroll-hint` outright, because the sticky fade's own
        # `margin-inline:-1.75rem` pseudo-element was what clipped "Matriks
        # Kesiapan" at the left edge in the first place. So the assertion
        # INVERTS on purpose: the strip used to scroll and the fade was the
        # only affordance telling a phone user the other tabs existed; it now
        # fits entirely on screen, and a fade painted over a bar with nothing
        # left to reveal would be a lie rather than a weaker check. This is a
        # rewrite of the check to match a real, approved markup change — not a
        # relaxation. Until the dashboard-overhaul workstream lands this new
        # markup, every assertion below is EXPECTED to fail (old flex/overflow
        # markup is still in index.html).
        await c.goto(f"{BASE}/", wait=2.5)
        await c.login("superadmin", PW)
        await asyncio.sleep(4)

        # The 44px touch-target minimum for `.dash-tab-btn` may be supplied by
        # the project's `@media (pointer: coarse) { ... } ` rule in
        # assets/style.css (it already is, today). CLAUDE.md and
        # tools/verify/audit.py both document that
        # `matchMedia('(pointer: coarse)')` is FALSE under headless Chrome and
        # cannot be forced via `Emulation.setEmitTouchEventsForMouse` — so if
        # the tab strip's height still depends on that media query, headless
        # rendering will measure it short even though a real phone renders it
        # correctly, and asserting the rendered box would be a false failure
        # baked into the harness (exactly what caused ~30 bogus tap-target
        # failures before audit.py switched that one check to reading the CSS
        # SOURCE). We measure the rendered box first — it's the strongest
        # evidence when it clears the bar on its own — and only fall back to
        # the source, scoped specifically to `.dash-tab-btn` inside a
        # `pointer: coarse` block, if the render comes up short. Which path
        # actually fires is decided at run time below, not assumed here.
        _css_path = os.path.join(ROOT, "assets", "style.css")
        with open(_css_path, encoding="utf-8") as _fh:
            _css = _fh.read()
        _coarse_block = ""
        _m = re.search(r"@media\s*\(pointer:\s*coarse\)\s*\{", _css)
        if _m:
            depth = 0
            start = _m.end() - 1  # index of the media query's own '{'
            for j in range(start, len(_css)):
                if _css[j] == "{":
                    depth += 1
                elif _css[j] == "}":
                    depth -= 1
                    if depth == 0:
                        _coarse_block = _css[start:j + 1]
                        break
        _tab_btn_44_via_coarse = ".dash-tab-btn" in _coarse_block and (
            "44px" in _coarse_block or "2.75rem" in _coarse_block
        )

        async def _measure_tab_bar(width, height, mobile):
            await c.viewport(width, height, mobile=mobile)
            await c.js("switchView('dashboard'); return 1;")
            await asyncio.sleep(1.2)
            return await c.js("""
              const bar = document.getElementById('dash-tab-bar');
              const btns = Array.from(document.querySelectorAll('.dash-tab-btn'));
              const barRect = bar.getBoundingClientRect();
              const rects = btns.map(b => b.getBoundingClientRect());
              return {
                hasScrollHint: bar.classList.contains('scroll-hint'),
                scrollW: bar.scrollWidth, clientW: bar.clientWidth,
                count: btns.length,
                widths: rects.map(r => Math.round(r.width)),
                heights: rects.map(r => Math.round(r.height)),
                lefts: rects.map(r => Math.round(r.left)),
                rights: rects.map(r => Math.round(r.right)),
                tops: rects.map(r => Math.round(r.top)),
                barLeft: Math.round(barRect.left),
                barRight: Math.round(barRect.right),
                prevExists: !!document.getElementById('dash-tab-prev'),
                nextExists: !!document.getElementById('dash-tab-next'),
              };""")

        for width, height, mobile, label in (
            (390, 844, True, "390px"),
            (1440, 900, False, "1440px"),
        ):
            r = await _measure_tab_bar(width, height, mobile)

            check(f"[{label}] dash-tab-bar does not scroll",
                  r["scrollW"] <= r["clientW"] + 4,
                  f"scrollW={r['scrollW']} clientW={r['clientW']}")
            check(f"[{label}] .scroll-hint removed — nothing left to hint at",
                  not r["hasScrollHint"], r["hasScrollHint"])
            check(f"[{label}] #dash-tab-prev deleted", not r["prevExists"], r["prevExists"])
            check(f"[{label}] #dash-tab-next deleted", not r["nextExists"], r["nextExists"])

            check(f"[{label}] all six .dash-tab-btn are present",
                  r["count"] == 6, r["count"])
            check(f"[{label}] every tab has a non-zero rendered box",
                  r["count"] == 6
                  and all(w > 0 for w in r["widths"])
                  and all(h > 0 for h in r["heights"]),
                  {"widths": r["widths"], "heights": r["heights"]})
            # The requirement this protects: "Matriks Kesiapan" must not be
            # clipped at the left the way `.scroll-hint`'s fade used to clip it.
            check(f"[{label}] first tab is not clipped at the bar's left edge",
                  bool(r["lefts"]) and r["lefts"][0] >= r["barLeft"] - 2,
                  {"tabLeft": r["lefts"][0] if r["lefts"] else None, "barLeft": r["barLeft"]})
            check(f"[{label}] last tab is not clipped at the bar's right edge",
                  bool(r["rights"]) and r["rights"][-1] <= r["barRight"] + 2,
                  {"tabRight": r["rights"][-1] if r["rights"] else None, "barRight": r["barRight"]})

            min_h = min(r["heights"]) if r["heights"] else 0
            if min_h >= 44 - 0.5:
                check(f"[{label}] every tab is >=44px tall (touch-target rule)",
                      True,
                      f"measured {min_h}px rendered — the grid's own content "
                      f"(icon+label, padding) clears 44px unconditionally, not "
                      f"only under pointer:coarse")
            else:
                check(f"[{label}] every tab is >=44px tall (touch-target rule, "
                      f"asserted from CSS SOURCE — rendered box measured "
                      f"{min_h}px because matchMedia('(pointer: coarse)') "
                      f"cannot be forced headless, see comment above)",
                      _tab_btn_44_via_coarse,
                      {"measured_px": min_h,
                       "style.css has '.dash-tab-btn { min-height: 44px }' "
                       "inside @media (pointer: coarse)": _tab_btn_44_via_coarse})

            tops = r["tops"][:6]
            distinct_tops = sorted(set(tops))
            if width < 640:
                # `grid-cols-3` under `sm:` — two rows of three, not a scroller.
                rows = {}
                for t in tops:
                    rows[t] = rows.get(t, 0) + 1
                check(f"[{label}] tabs form exactly two rows",
                      len(distinct_tops) == 2, tops)
                check(f"[{label}] three tabs per row",
                      sorted(rows.values()) == [3, 3], rows)
            else:
                check(f"[{label}] tabs form exactly one row (grid-cols-6 from sm:)",
                      len(distinct_tops) == 1, tops)

        check("mobile dashboard: 0 console errors", not c.drain_console(IGNORE))
    finally:
        await c.close()

    print(f"\n{ok} ok, {fail} FAIL")
    if fail:
        print("\n✗ a rev0.4.2 frontend change has regressed")
        return 1
    print("\nOK — every rev0.4.2 frontend change behaves as intended")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
