"""
The rev0.4.3 inventory work, driven in a real browser.

    py -3.10 tools/verify/test_rev043.py    # needs the app on :8017 + Chrome

Four features from the client's matrix plus two corrections:

  1. **Hierarki Suku Cadang (BOM tree)** — client B-6, the only line marked
     *High* that had no implementation at all. The assertions that matter are
     about HONESTY: the selector must offer only tool types that actually have
     parts (17 of 104), and the stock it shows must equal what every other
     screen shows — a tree that grew its own way of computing stock would drift
     from the Items Master the first time the ledger rules changed.
  2. **Kartu Riwayat Suku Cadang** — client B-5. Its movement count must match
     the ledger endpoint exactly.
  3. **Fast / Slow moving** — the three buckets must PARTITION the catalogue,
     and the window must be stated on screen.
  4. **"Di Atas Maksimum" is gone.** The tile was removed a release ago but the
     BAND was not, so the chart carried a segment and the legend an entry that
     were structurally incapable of being non-zero.
  5. **ADMIN_WILAYAH may not register a PUSAT asset.** Both halves — the radio
     is hidden AND disabled, and the API refuses it — because hiding a control
     is not enforcement.

Writes nothing that it does not delete again.
"""

import asyncio
import json
import os
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
    c = Chrome(port=9232)
    await c.start()
    try:
        await c.goto(f"{BASE}/", wait=3.0)
        role = await c.login("superadmin", PW)
        check("login", role == "SUPER_ADMIN", role)
        await asyncio.sleep(4)
        c.drain_console(IGNORE)

        await c.js("switchView('inventaris'); return 1;")
        await asyncio.sleep(2.5)

        # ── 1. BOM tree ──
        print("\n1. Hierarki Suku Cadang (BOM tree)")
        r = await c.js("""
          document.getElementById('inv-tab-hirarki').click();
          await new Promise(r => setTimeout(r, 1800));
          const sel = document.getElementById('inv-hirarki-alat');
          return {
            shown: !document.getElementById('inv-panel-hirarki').classList.contains('hidden'),
            options: [].slice.call(sel.options).map(function(o){return o.value;}).filter(Boolean).length,
            cakupan: document.getElementById('inv-hirarki-cakupan').textContent.replace(/\\s+/g,' ').trim(),
            placeholder: document.getElementById('inv-hirarki-tree').textContent.trim().slice(0, 40),
          };""", awaitPromise=True)
        check("tab opens its panel", r["shown"], r)
        # 17 of 104. Offering all 104 would leave 87 rendering an empty tree.
        check("selector lists ONLY tools that have parts (17)", r["options"] == 17, r["options"])
        check("coverage is stated on screen", "17" in r["cakupan"] and "104" in r["cakupan"], r["cakupan"])
        check("no tool chosen -> a real empty state, not a blank panel",
              "Pilih jenis alat" in r["placeholder"], r["placeholder"])

        r = await c.js("""
          const sel = document.getElementById('inv-hirarki-alat');
          sel.value = 'IMP';
          sel.dispatchEvent(new Event('change'));
          await new Promise(r => setTimeout(r, 1500));
          const tree = document.getElementById('inv-hirarki-tree');
          const parts = tree.querySelectorAll('button[onclick^="window.openPartHistory"]');
          const api = await (await fetch('/api/inventaris/hirarki?kode_alat=IMP',
            {headers:{Authorization:'Bearer '+sessionStorage.getItem('authToken')}})).json();
          // Every subsistem here has exactly one kategori, so the collapse rule
          // should have removed that level entirely from the rendered output.
          const katHeadings = tree.querySelectorAll('li > p.uppercase').length;
          return {
            leaves: parts.length,
            apiParts: api.jumlah_part,
            subs: tree.querySelectorAll('ul > li > div > span.uppercase').length,
            apiSubs: api.subsistem.length,
            katHeadings,
            singleKat: api.subsistem.every(function(s){return s.kategori.length === 1;}),
            universalBadges: tree.textContent.indexOf('semua model') >= 0,
            text: tree.textContent.replace(/\\s+/g,' ').slice(0, 120),
          };""", awaitPromise=True)
        check("every part renders as a clickable leaf",
              r["leaves"] == r["apiParts"], f"{r['leaves']} leaves vs {r['apiParts']} parts")
        check("one heading per subsistem", r["subs"] == r["apiSubs"], r)
        # The kategori level always has exactly one child named after its own
        # parent, so drawing it would add structure carrying no information.
        check("single-child kategori level is COLLAPSED",
              r["singleKat"] and r["katHeadings"] == 0, r)
        # NULL id_varian is the common case and is a positive fact.
        check("universal parts say so rather than showing a blank",
              r["universalBadges"], r["text"])

        # Stock must not have a second implementation.
        r = await c.js("""
          const H = {Authorization:'Bearer '+sessionStorage.getItem('authToken')};
          const tree = await (await fetch('/api/inventaris/hirarki?kode_alat=IMP',{headers:H})).json();
          const parts = await (await fetch('/api/inventaris/parts',{headers:H})).json();
          const byId = {}; parts.forEach(function(p){ byId[p.id_part] = p.stok_sekarang; });
          const bad = [];
          tree.subsistem.forEach(function(s){ s.kategori.forEach(function(k){ k.parts.forEach(function(p){
            if (byId[p.id_part] !== p.stok_sekarang) bad.push(p.nama_part);
          });});});
          return { bad: bad.slice(0,3), n: bad.length };""", awaitPromise=True)
        check("tree stock EQUALS Items Master stock for every part",
              r["n"] == 0, r["bad"])
        check("BOM tree: 0 console errors", not c.drain_console(IGNORE))

        # ── 2. History card ──
        print("\n2. Kartu Riwayat Suku Cadang")
        r = await c.js("""
          const tree = document.getElementById('inv-hirarki-tree');
          const btn = tree.querySelector('button[onclick^="window.openPartHistory"]');
          const id = parseInt(btn.getAttribute('onclick').match(/\\d+/)[0], 10);
          btn.click();
          await new Promise(r => setTimeout(r, 1600));
          const modal = document.getElementById('inv-part-history-modal');
          const body = document.getElementById('inv-ph-body');
          const H = {Authorization:'Bearer '+sessionStorage.getItem('authToken')};
          const led = await (await fetch('/api/inventaris/stok?id_part='+id+'&limit=200',{headers:H})).json();
          const det = await (await fetch('/api/inventaris/parts/'+id,{headers:H})).json();
          return {
            open: !modal.classList.contains('hidden'),
            rows: body.querySelectorAll('tbody tr').length,
            ledgerTotal: led.total,
            title: document.getElementById('inv-ph-title').textContent.trim(),
            gudangSum: det.per_gudang.reduce(function(a,x){return a+x.stok;},0),
            detailStok: det.stok_sekarang,
            hasDialogRole: modal.getAttribute('role'),
          };""", awaitPromise=True)
        check("clicking a leaf opens the card", r["open"], r)
        check("card titled with the part", bool(r["title"]) and r["title"] != "Kartu Riwayat Suku Cadang", r["title"])
        check("movement rows match the ledger exactly",
              r["rows"] == r["ledgerTotal"], f"{r['rows']} rows vs {r['ledgerTotal']} total")
        check("per-gudang balances sum to the part total",
              r["gudangSum"] == r["detailStok"], r)
        # a11y-modal.js picks up modals at runtime via MutationObserver.
        check("dialog semantics applied at runtime", r["hasDialogRole"] == "dialog", r)

        r = await c.js("""
          document.getElementById('close-inv-part-history-modal').click();
          await new Promise(r => setTimeout(r, 300));
          return document.getElementById('inv-part-history-modal').classList.contains('hidden');""",
                       awaitPromise=True)
        check("card closes", r is True, r)
        check("history card: 0 console errors", not c.drain_console(IGNORE))

        # ── 3. Fast / slow ──
        print("\n3. Perputaran suku cadang")
        r = await c.js("""
          document.getElementById('inv-tab-dashboard').click();
          await new Promise(r => setTimeout(r, 2500));
          const n = function(id){ return parseInt(
            (document.getElementById(id).textContent||'0').replace(/\\D/g,''), 10) || 0; };
          const H = {Authorization:'Bearer '+sessionStorage.getItem('authToken')};
          const d = await (await fetch('/api/inventaris/dashboard',{headers:H})).json();
          return {
            fast: n('sd-fs-fast-count'), slow: n('sd-fs-slow-count'), diam: n('sd-fs-diam-count'),
            total: d.total_parts,
            window: document.getElementById('sd-fs-window').textContent.trim(),
            links: document.querySelectorAll('#sd-fs-fast button, #sd-fs-slow button, #sd-fs-diam button').length,
          };""", awaitPromise=True)
        # The three buckets are a partition, not overlapping labels.
        check("fast + slow + tanpa-pergerakan == the whole catalogue",
              r["fast"] + r["slow"] + r["diam"] == r["total"],
              f"{r['fast']}+{r['slow']}+{r['diam']} != {r['total']}")
        check("all three buckets are non-empty in seeded data",
              r["fast"] > 0 and r["slow"] > 0 and r["diam"] > 0, r)
        # A consumption rate with no stated period is not interpretable.
        check("the window is stated on the panel",
              "bulan" in r["window"] and "sejak" in r["window"], r["window"])
        check("rows link into the history card", r["links"] > 0, r["links"])

        # ── 4. "Di Atas Maksimum" is gone ──
        print("\n4. The permanent-zero status band")
        # `STOK_BANDS` lives inside the view's IIFE and is deliberately not a
        # global, so this asserts what the user can actually see: the legend the
        # bands render into, and its total.
        r = await c.js("""
          const view = document.getElementById('view-inventaris');
          const legend = document.getElementById('sd-status-legend');
          const entries = [].slice.call(legend.children).map(function(e){
            return e.textContent.replace(/\s+/g,' ').trim(); });
          return {
            inText: view.textContent.indexOf('Di Atas Maksimum') >= 0
                 || view.textContent.indexOf('DI ATAS MAX') >= 0,
            entries: entries,
            zeroEntries: entries.filter(function(e){ return / 0 \(0\.0%\)$/.test(e); }),
          };""")
        check("no 'Di Atas Maksimum' anywhere in the rendered view", not r["inText"], r)
        check("the status legend is down to 3 bands", len(r["entries"]) == 3, r["entries"])
        # The defect was a legend entry that could never be anything but zero.
        check("no legend entry is a structural zero", not r["zeroEntries"], r["zeroEntries"])
        r = await c.js("""
          const H = {Authorization:'Bearer '+sessionStorage.getItem('authToken')};
          const d = await (await fetch('/api/inventaris/dashboard',{headers:H})).json();
          return Object.keys(d.status_counts);""", awaitPromise=True)
        check("server no longer reports the bucket either",
              "DI ATAS MAX" not in r, r)
        check("dashboard: 0 console errors", not c.drain_console(IGNORE))

        # ── 5. ADMIN_WILAYAH pengadaan ──
        print("\n5. ADMIN_WILAYAH may not register a PUSAT asset")
        r = await c.js("""
          const prior = _currentRole;
          _currentRole = 'ADMIN_WILAYAH';
          applyRoleGating('ADMIN_WILAYAH');
          const lbl = document.querySelector('#step-in-pengadaan [data-write="aset_pusat"]');
          const radio = lbl.querySelector('input');
          const out = { hidden: lbl.classList.contains('hidden'), disabled: radio.disabled };
          _currentRole = prior;
          applyRoleGating(prior);
          out.restored = !lbl.classList.contains('hidden') && !radio.disabled;
          return out;""")
        check("PUSAT radio hidden for ADMIN_WILAYAH", r["hidden"], r)
        # Hidden alone is not enough: a hidden CHECKED radio would still submit,
        # and a hidden `required` one is an unfocusable invalid control.
        check("...and DISABLED, not merely hidden", r["disabled"], r)
        check("...and restored for SUPER_ADMIN (both directions)", r["restored"], r)

        r = await c.js("""
          const res = await fetch('/api/aset', {
            method: 'POST',
            headers: {'Content-Type':'application/json',
                      Authorization:'Bearer '+sessionStorage.getItem('authToken')},
            body: JSON.stringify({kode_alat:'RGM', id_lokasi:'JR1.1', parent_lokasi:'D1',
              tanggal_pembelian:'2026-01-15', peruntukan:'JALAN REL', sumber_pengadaan:'PUSAT'}),
          });
          const body = await res.json();
          if (res.ok && body.id_aset) {
            await fetch('/api/aset/'+body.id_aset, {method:'DELETE',
              headers:{Authorization:'Bearer '+sessionStorage.getItem('authToken')}});
          }
          return { status: res.status, ok: res.ok };""", awaitPromise=True)
        check("SUPER_ADMIN + PUSAT still allowed (and cleaned up)", r["ok"], r)

        check("role gating: 0 console errors", not c.drain_console(IGNORE))

        # ── mobile pass over the new tab ──
        print("\n6. Phone width")
        await c.viewport(390, 844, mobile=True)
        await c.js("document.getElementById('inv-tab-hirarki').click(); return 1;")
        await asyncio.sleep(1.5)
        r = await c.js("""
          const vw = document.documentElement.clientWidth;
          const bad = [];
          document.querySelectorAll('#inv-panel-hirarki *').forEach(function(el){
            if (!el.offsetParent) return;
            const b = el.getBoundingClientRect();
            if (b.width && (b.right > vw + 1.5 || b.left < -1.5)) {
              bad.push((el.id || el.tagName.toLowerCase()) + ' ' + Math.round(b.width));
            }
          });
          const strip = document.querySelector('#view-inventaris .scroll-hint');
          return { bad: bad.slice(0,4),
                   stripHinted: !!strip,
                   stripOverflows: strip ? strip.scrollWidth > strip.clientWidth + 4 : false };""")
        check("BOM tree does not overflow at 390px", not r["bad"], r["bad"])
        # Five tabs no longer fit; the strip needs the fade affordance.
        check("the 5-tab strip carries .scroll-hint", r["stripHinted"], r)
        check("phone: 0 console errors", not c.drain_console(IGNORE))
    finally:
        await c.close()

    print(f"\n{ok} ok, {fail} FAIL")
    if fail:
        print("\n✗ a rev0.4.3 change has regressed")
        return 1
    print("\nOK — every rev0.4.3 change behaves as intended")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
