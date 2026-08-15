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
| `coverage.py` | DB | Every row in `modules/` is in the database, counted on both sides |
| `smoke.py` | app | 26 read endpoints, plus the 304, auth and static-refusal contracts |
| `mutate.py` | app | The write path: repair + `pemakaian` + both broadcasts + short-stock rollback, then cleans up and asserts the counts came back |
| `walk.py` | app, Chrome | 8 views × 2 widths × 2 themes: console errors and horizontal overflow |
| `test_parent.py` | app, Chrome | All **four** copies of the parent-derivation rule agree on 273 codes |
| `test_kdak.py` | app, Chrome | The live `id_aset` preview matches what the server actually mints |
| `test_ux.py` | app, Chrome | The rev0.5.1 per-view features still behave |
| `audit.py` | app, Chrome | UI/UX findings sweep — a report, **not** a gate |
| `negcheck.py` | — | Breaks `index.html` five ways and confirms `check_html.py` catches each, then restores it byte-for-byte |
| `cdp.py` | — | The Chrome driver the browser scripts import; not run directly |

## Baselines

Hold these unless a change is deliberate:

```
routes            81
shadow pairs       0
require_role      41 guards
broadcasts        35
seed.py --verify  11/11
row counts        kategori_alat 104 · lokasi   273 · alat_varian  87
                  aset         1121 · riwayat 1121 · pengguna      2
                  gudang          3 · sparepart 203 · sparepart_stok 973
```

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
