# tools/verify — the verification harness

There is no test suite in this project and no Node.js on the machine, so this is
what stands in for both. Everything here is re-runnable and writes nothing to the
database that it does not clean up again.

It lives in the repo rather than in a scratch directory because a harness that
disappears with the session is a harness that gets rebuilt from memory next time,
slightly differently, and stops being a baseline.

## Running it

Most of it needs the app up:

```bash
py -3.10 -m uvicorn main:app --port 8017
```

The browser scripts need Chrome at
`C:\Program Files\Google\Chrome\Application\chrome.exe` and drive it over the
DevTools Protocol — no Playwright, no Node.

| Script | Needs | What it proves |
|---|---|---|
| `gate.ps1` | — | G1–G3b in one call: imports, route set, shadowing, OpenAPI, invariants, unresolved names |
| `snap.py <label>` | — | Snapshots routes + OpenAPI + shadow pairs into `_snapshots/` |
| `invariants.py` | — | Guards, broadcasts, one `get_db`, and that no `api/` module imports `main` |
| `coverage.py` | DB | Every row in `modules/` is in the database, counted on both sides — and every file in `uploads/dokumen_alat/` is reachable from a `dokumen_alat` row |
| `smoke.py` | app | 26 read endpoints, plus the 304, auth and static-refusal contracts |
| `mutate.py` | app | The write path: repair + `pemakaian` + both broadcasts + short-stock rollback, then cleans up and asserts the counts came back |
| `walk.py` | app, Chrome | 8 views × 2 widths × 2 themes: console errors and horizontal overflow |
| `test_parent.py` | app, Chrome | All **four** copies of the parent-derivation rule agree on 273 codes |
| `test_kdak.py` | app, Chrome | The live `id_aset` preview matches what the server actually mints |
| `test_ux.py` | app, Chrome | The rev0.5.1 per-view features still behave |
| `test_simulasi.py` | DB, app | The simulated-history step: marked, idempotent, plausible, and **exactly reversible**. Snapshots every row count plus each asset's `(status, lokasi)`, generates, and fails if the undo is not byte-for-byte |
| `test_rev043.py` | app, Chrome | The rev0.4.3 inventory work: the BOM tree (coverage honesty + stock agreeing with the Items Master + the collapse rule), the part history card, fast/slow partitioning the catalogue, the vanished "Di Atas Maksimum" band, and the pengadaan scope rule in BOTH halves |
| `syntax.py` | Chrome | **Does js/ PARSE?** `new Function(src)` per file in headless Chrome — the `node --check` this project cannot have. Catches the SyntaxError class (`await` in a non-async function, a stray brace) that blanks the page and that every other checker passes |
| `test_boot.py` | app, Chrome | **The rev0.4.5 gate.** Measures what the SPA downloads to put a screen up: counts every `/api/` request through a login and five views. Asserts the boot is under 400 KB, that no view walks the fleet page by page, that `db` / `_historySummary` hold a PAGE, and that the export still fetches every row on demand |
| `test_paging.py` | app, Chrome | **The rev0.4.5 gate.** Runs the client matcher (`assetMatchesSearch` / `lokasiMatchesCode` / `_historySearchMatches` — the shipped functions, in Chrome) and the server's `api/query.py` filters over the same fleet, and asserts identical id lists. 46 filter, 16 Pantau Riwayat and 10 ordering cases |
| `test_rev042.py` | app, Chrome | The rev0.4.2 frontend: registration panel, progressive captcha, role gating, the peruntukan-filtered UPT list, the KDAK form fitting, landing.html's sign-in, `dokumen_alat`, and the scroll affordance |
| `test_auth.py` | app | Registration, approval, suspension, the captcha token, and the rate limiter. **The one script here that is not immediately re-runnable** — it exhausts the limits it tests, so it detects a hot bucket and exits 2 rather than reporting a false failure. Restart the app to clear them |
| `audit.py` | app, Chrome | UI/UX findings sweep — a report, **not** a gate |
| `negcheck.py` | — | Breaks `index.html` five ways and confirms `check_html.py` catches each, then restores it byte-for-byte |
| `cdp.py` | — | The Chrome driver the browser scripts import; not run directly |

## Baselines

Hold these unless a change is deliberate:

```
routes                88      (87 + /api/aset/dashboard/ringkasan, rev0.4.5)
openapi paths         60
shadow pairs           0
require_role          43 guards
broadcasts            37
manage.py verify   16/16
audit.py findings      0
test_paging.py        46 filter + 16 riwayat + 10 order cases, all agreeing
boot payload          19 KB in 7 requests   (was 1,062 KB in 6)
  per view opened     ~1.2 KB               (one page of 20)
syntax.py             17/17 files parse

with `--simulasi` (opt-in, and every row is marked):
  aset unchanged · riwayat_kondisi +~2000 · riwayat_mutasi +~1000
  spread 84.7% SO / 11.3% TSO / 3.9% AFKIR · pengguna 2 -> 3 (SIMULASI)
  `manage.py hapus-simulasi` returns every one of those to baseline
row counts        kategori_alat 104 · lokasi        273 · alat_varian   87
                  aset         1121 · riwayat      1121 · pengguna       2
                  gudang          3 · sparepart     203 · sparepart_stok 973
                  dokumen_alat   33 (30 primary, 0 orphan files on disk)
```

**`manage.py verify` must report `aset nyata = 1121` as an EQUALITY.** It used to
be a `expected <= n < expected * 2` range, loose enough to hide eleven runs of a
non-idempotent dummy step. Demo assets are counted separately by their `DEMO-`
serial.

`sparepart_stok` is only stable because `seeds/inventaris.py` seeds its RNG. It
did not used to be, and two identical resets produced different ledgers.

## Three CDP gotchas, already handled in `cdp.py`

1. Start the websocket reader task **before** the first command, and keep a
   reference to it — an unreferenced `asyncio` task can be garbage-collected
   mid-run, which looks exactly like silently dropped responses.
2. Use a **per-port** `--user-data-dir`, or a second Chrome hands its arguments
   to the first and never opens its own port.
3. Wrap every evaluated snippet in an IIFE. `Runtime.evaluate` runs in the page's
   global scope, so a bare `const s` twice is a redeclaration error that poisons
   every later call.

## One thing this harness cannot measure

`matchMedia('(pointer: coarse)')` is **false** under headless emulation and
cannot be forced with `Emulation.setEmitTouchEventsForMouse`. The 44px minimum
tap target in `assets/style.css` lives behind `@media (pointer: coarse)`, so any
box measured here reflects the *mouse* layout, not the phone one. An earlier
audit reported ~30 undersized tap targets on that basis; all of them were
artifacts. Test touch sizing on real hardware, or assert the CSS rule exists —
do not measure the rendered box.
