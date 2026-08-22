# RAMCES, Development Roadmap

**Audience:** whoever maintains RAMCES next.
**Scope:** what to *do* to the system. For how the system already *works*, read
[CLAUDE.md](../CLAUDE.md), this document deliberately does not repeat it.

- End-user manual: [PANDUAN-RAMCES.md](PANDUAN-RAMCES.md) (Indonesian)
- Setting up from an empty database: [MULAI-DARI-NOL.md](MULAI-DARI-NOL.md)
- Coverage against the client's own acceptance criteria:
  [CAKUPAN-TIMELINE-MAGANG.md](CAKUPAN-TIMELINE-MAGANG.md)

Every number here was measured against the local seeded database, not estimated.

> **This document was rewritten at `rev0.4.3-alpha`.** The previous version was
> written against `rev0.4.0-beta` and opened with *"§2 BLOCKER, there is no
> authentication … nothing else in this document matters until this is done."*
> That had been false for two releases, and it listed as pending several things
> that had already shipped. A maintainer handed it would have started by
> rebuilding a login system that already existed. If you find this file
> disagreeing with the code again, fix the file, a stale roadmap is worse than
> no roadmap, because it is trusted.

---

## 1. Where the project stands

Branch `rev0.4.6-alpha`. Version naming is `revX.Y.Z-alpha` / `-beta`; the older
`-fe-be` suffix is retired.

| Round | What it delivered |
|---|---|
| Correctness | Search/sort unification, the Balaiyasa rule, the inventory ledger, certificate upload |
| Design | `assets/style.css` component layer (`.card`, `.btn`, `.badge`, `.modal-*`, `.table-std`) |
| Performance | GZip, cache headers + real 304s, lazy XLSX/jsPDF, WebP hero, `Map` indexes, debounced search, connection pool, `asyncio.gather` broadcast |
| Defect + a11y | `js/a11y-modal.js`; every dialog has role/label/Esc/focus-trap |
| Katalog + inventory | `KATALOG SFM.xlsx` as the master; spareparts consumed by repairs in one transaction |
| **rev0.5.0/0.5.1** | Authentication; `main.py` 5,901 → 324 lines split into `api/`; per-view redesign |
| **rev0.4.2** | Self-registration + approval + captcha + rate limiting; `manage.py`; `dokumen_alat`; declarative role gating |
| **rev0.4.3** | Hierarki Part (BOM tree), Kartu Riwayat Part, Fast/Slow moving, the pengadaan scope rule |
| **rev0.4.4** | `seeds/simulasi.py`, marked, reversible operational history for the real fleet |
| **rev0.4.5** | Server-side paging, end to end: boot 1,062 KB → 19 KB. `api/query.py` (the server twin of the one matcher), `/ringkasan`, and one window scan instead of four |
| **rev0.4.6** | MTBF/MTTR · calibration due-date reminder · stock opname, **the client matrix closes** |

### Current baseline, keep these honest

```text
routes            95        openapi paths     66
shadow pairs       0        require_role      47 guards
broadcasts        40        manage.py verify  16/16
audit findings     0        console errors     0  (8 views x 2 widths x 2 themes)
test_paging.py    46 filter + 16 riwayat + 10 order cases, client == server
boot payload      19 KB / 7 requests   (was 1,062 KB) · per view ~1.2 KB
syntax.py         17/17 js files parse

CLEAN IMPORT (manage.py seed, nothing optional):
  kategori_alat 104 · lokasi        273 · alat_varian   87
  aset         1121 · riwayat      1121 · pengguna       2
  gudang          3 · sparepart     203 · sparepart_stok 973
  dokumen_alat   33 (30 primary, 0 orphaned files on disk)
  every asset SO, five dashboard panels are empty, and that is honest

WITH `--simulasi` (opt-in, every row marked, fully reversible):
  riwayat_kondisi ~3200 · riwayat_mutasi ~1000 · riwayat_kalibrasi ~26
  pemakaian_sparepart ~77 · pengguna 3 (+SIMULASI)
  84.7% SO · 11.3% TSO · 3.9% AFKIR
  `manage.py hapus-simulasi` returns every one of those to the clean import
```

Seeding a genuinely empty database takes **9 seconds** end to end; the
simulation adds about the same again.

---

## 2. What is DONE, do not re-report

Each was reproduced live before the fix and verified live after.

| Area | Was | Now |
|---|---|---|
| **Authentication** | `/api/login` verified no password and CREATED any unknown username with whatever role the body claimed | bcrypt + JWT, five roles, no auto-registration, `SECRET_KEY` mandatory, CORS removed |
| **Self-registration** | none | `POST /api/register` → PENDING → admin `/approve` or `/tolak`. The registrant never picks a role |
| **Rate limiting** | none at all on `/api/login` | `api/ratelimit.py`; progressive captcha, never a lockout; success clears the counters |
| **Suspension** | a 12-hour token outlived it | `get_current_user` checks `status` and answers 401 |
| **Regional scoping** | broken in both directions | `assert_region_scope` / `assert_aset_region_scope` on all six mutating paths |
| **Procurement scope** | ADMIN_WILAYAH could register PUSAT assets | `assert_pengadaan_scope`, 400 on create and edit |
| **Frontend role gating** | 4 elements, `switchView` unguarded | `NAV_ACCESS`/`VIEW_ACCESS`/`WRITE_ACCESS` + a guard inside `switchView` |
| **FK `ondelete`** | deleting a user 500'd | `SET NULL` / `CASCADE` applied by a guarded `DO $$` block |
| **`lokasi` re-read per request** | 4x per dashboard load | 60 s TTL cache of plain tuples, explicitly invalidated |
| **Exports built in memory** | 223 KB and growing | `StreamingResponse` over a row-at-a-time generator |
| **Pagination** | the whole fleet at every login, 1,062 KB, 460 ms, linear in fleet size | server-side filter + sort + page; boot is 19 KB and flat. `test_paging.py` proves the server's filters equal the client matcher's |
| **Seeding** | a second run DOUBLED the fleet; the dummy step was never idempotent | `manage.py`, identity gates, `DEMO-` serials, 16/16 asserted |
| **Documents** | 3 PDFs (5.6 MB) reachable by nothing | `dokumen_alat`; verified from the DISK side |
| **`landing.html` sign-in** | 422'd for every user, and let you pick your own role | username + password + progressive captcha |
| **`uploads/` static leak** | a certificate saved as `.jpg` was readable with no token | the catch-all refuses the whole tree |
| **Mobile** | designed at desktop width and allowed to shrink | `.table-stack`, bottom nav, 44px targets, `.scroll-hint` |
| **An all-green demo** | every asset SO; five panels empty, nothing to show a client | `seeds/simulasi.py`, marked with a SIMULASI account, tagged `[SIMULASI]`, idempotent, and exactly reversible |

---

## 3. Known gaps, ranked by what breaks first

### 3.1 ~~Server-side paging for the deep screens~~, CLOSED

**The scaling wall is gone. The boot went from 1,062 KB to 19 KB**, measured in
a real browser by `tools/verify/test_boot.py`, and it no longer grows with the
fleet at all.

```text
                        before      after
login -> first screen  1,062 KB     19 KB   (7 requests)
opening a deep screen        0     ~1.2 KB  (one page of 20)
scaling                 linear     flat
```

Three pieces, and the release is only correct because of the third:

1. **`/api/aset` and `/api/history/summary` take the complete filter set** the
   sort modals can produce, `q`, `alat`, `pengadaan`, `peruntukan`, `lokasi`,
   `upt`, `status`, `tahun_from/to`, `id_from/to`, `milik_saya` / `punya`, plus
   `sort` and `dir`, and the answers are **exact**, not the superset gate they
   used to be. Both deep screens render straight from a page.
2. **`GET /api/aset/dashboard/ringkasan`** supplies every fleet-wide number the
   four dashboard panels, both KPI strips, the KDAK tiles, every year dropdown
   and the KDAK id preview's sequence number. ~6 KB regardless of fleet size.
   `ensureFleet()` still fetches every row for the three things that genuinely
   need one line per asset, the Excel/PDF export and the KDAK grouping
   modals, but on demand, not at login.
3. **`api/query.py` is a line-by-line port of `js/search.js`**, and
   `tools/verify/test_paging.py` proves it by running the shipped client
   functions in real Chrome and the server filters over the same fleet and
   comparing id lists: 46 filter, 16 Pantau Riwayat and 10 ordering cases, all
   agreeing. Without that, "faster" would have meant "differently wrong".

What to know before touching it is in [CLAUDE.md](../CLAUDE.md) under *Nothing
holds the fleet any more*. The short version: `db` and `_historySummary` are
ONE PAGE each, and scanning them for a fleet-wide answer fails silently with a
plausible smaller number.

### 3.2 ~~The repair-events window subquery runs four times per dashboard load~~, CLOSED

`_scoped_repair_events` returns a subquery EXPRESSION, so each of the four
`db.execute()` calls re-ran it, including the deliberately unfiltered `LAG` over
all of `riwayat_kondisi`, and re-planned the nested query four times.

`_repair_facts()` now scans it **once**, grouped by `(bucket, lokasi, alat)`, and
the headline totals, the trend series, the per-resort table and the per-alat
table are summed out of that one result set in Python. The grouping key is the
resolution the trend is drawn at, so nothing is approximated.

Measured against a `--simulasi` database (3,218 `riwayat_kondisi` rows, which is
what made the cost visible at all):

```text
the four scans alone     64 ms (Semua Tahun) · 73 ms (one year)
one grouped pass         25 ms               · 19 ms
endpoint, end to end    100-123 ms  ->  45-60 ms
14 payloads compared before and after: byte-identical
```

### 3.3 The rate limiter is per-process

`api/ratelimit.py` holds its buckets in memory, so two uvicorn workers keep two
independent sets and `--workers 4` effectively quadruples an attacker's budget;
a restart forgets everything. The honest fix is Redis or a reverse proxy. It
still converts an unbounded online guessing run into a bounded one, which is the
threat it is aimed at.

### 3.4 `aset` has a composite string primary key

`<urutan>.<kode_alat>.<pengadaan>.<yy>.<peruntukan>.<lokasi>` encodes five mutable
attributes, so editing any of them regenerates the PK and rewrites every child
row. A surrogate `BIGSERIAL` with `id_aset` kept as a unique business key would
make it a single-row update. Do it after §3.1.

### 3.5 `resolve_home_lokasi()` is N+1 inside the export loops

The lokasi table is cached now, but the `RiwayatMutasi` lookup for an asset
sitting at a Balaiyasa still fires per asset. Rare in practice; batch it if
workshop traffic grows.

### 3.6 Tailwind runs as a CDN JIT compiler in the browser

It rewrites the DOM at runtime, must stay eager (deferring it flashes unstyled
content), and prints a production warning on every load. Replacing it needs a
build step the project deliberately does not have. **Decide explicitly rather
than drift.**

### 3.7 `index.html` is ~6k lines and stays one file

Splitting it needs that same build step, and would break both "every view exists
in the DOM at once" and `js/views/inventaris.js`'s eval-time DOM caching.

### 3.8 Smaller

- No password expiry, and no PERSISTED audit log of failed sign-ins, the rate
  limiter counts them in memory only.
- `sparepart_kategori` names are matched by **exact string** on bulk import;
  unknown categories are rejected rather than created.
- `id_lokasi` / `site_from` / `site_to` on `sparepart_stok` are legacy
  region-tree columns kept only so existing transfer history keeps rendering.
  Dead weight for new writes; plan a migration rather than adding more.
- `SparePart` has no `stok_max`. `_stok_status()` keeps the branch documented as
  reserved, and `STOK_STATUS_ORDER` deliberately omits it, see rev0.4.3.
- Clicking a modal backdrop does not close it. Deliberately: several dialogs are
  long forms and a stray click would discard typed input. Revisit only with a
  dirty-state guard.
- Tables were left on inline Tailwind. `.table-std td` (0,1,1) outranks the
  per-cell `.px-4` (0,1,0) that 22 tables rely on, so adopting it is a restyle
  per table, not a find-and-replace.
- **`GET /api/aset/afkir` is the last unpaged list endpoint**, a bare `.all()`
  over every scrapped asset, 44 rows today. After rev0.4.5 it is the only one
  left, and `js/views/afkir.js` is the only view that still holds a whole list
  client-side. Fine at this size; it is recorded here so the next person does
  not have to rediscover that it is the exception.

---

## 4. Client-matrix features, CLOSED at rev0.4.6

From [CAKUPAN-TIMELINE-MAGANG.md](CAKUPAN-TIMELINE-MAGANG.md). Three of the
original seven closed in rev0.4.3, and the last three buildable ones closed in
rev0.4.6.

| Feature | Shipped in | How |
|---|---|---|
| **MTBF / MTTR** | rev0.4.6 | Two more columns on the window scan `_repair_facts()` already makes, `lag(waktu_lapor)` beside `lag(kondisi)`. Rendered as tiles on the Kurva MCF panel, because MCF/MTBF/MTTR are one reliability story. Verified by recomputing both in plain Python and comparing |
| **Calibration reminder** | rev0.4.6 | `GET /api/kalibrasi/jatuh-tempo`, a STATE rather than a notification, so no notifications table, and nothing to mark read. Surfaced as a `JATUH TEMPO`/`SEGERA` card badge, a filter on the Kalibrasi tab, and one standing entry in the bell |
| **Stock opname** | rev0.4.6 | `opname_sesi` / `opname_baris`, posting through the existing `ADJ_IN`/`ADJ_OUT` ledger in one transaction. The variance is measured against the CURRENT balance, not the opening snapshot, see CLAUDE.md |
| **In-app QR scanner** | | The ONLY line still open, and deliberately: the field flow already works through the phone's native camera, which is what technicians actually do. Needs browser camera permission for marginal gain |

**The whole matrix is now green except the QR button.** Two of these three used
to be blocked on the system being *used* rather than built, shipping a
reliability metric that reads 0.0 teaches users to ignore that panel, and it is
hard to win that attention back. rev0.4.4's marked, reversible simulation is
what removed that block without pretending the data is real.

---

## 5. Suggested order

Renumbered at `rev0.4.6`. Everything the previous list ranked 1, 4b is done; what
is below it kept its relative order.

| # | Work | Effort | Risk of leaving it |
|---|---|---|---|
| 1 | Surrogate PK for `aset` (§3.4) | Large | Editing any id segment rewrites every child row. The largest remaining structural debt |
| 2 | Redis-backed rate limiting (§3.3) | Small | Only matters once deployed multi-worker, but then it matters immediately |
| 3 | Persisted audit log of failed sign-ins (§3.8) | Small | The rate limiter counts them in memory only, so a restart forgets an attack |
| 4 | In-app QR scan button | Small | The last client-matrix line, and the doc rates it low value: the field flow already works through the phone's native camera |
| 6 | Batch the `resolve_home_lokasi()` N+1 in the export loops (§3.5) | Small | Rare in practice; only bites if workshop traffic grows |
| 5 | Tailwind build step (§3.6) | Medium | Only if a build step becomes acceptable, decide explicitly rather than drift |

### Done, most recent first

| Round | Work |
|---|---|
| rev0.4.6 | MTBF/MTTR · calibration reminder · stock opname, the client matrix closes |
| rev0.4.5 | Server-side paging (§3.1), boot 1,062 KB → 19 KB · repair-dashboard single window scan (§3.2), 2× |
| rev0.4.4 | `seeds/simulasi.py`, marked, reversible operational history |
| rev0.4.3 | Hierarki Part · Kartu Riwayat Part · Fast/Slow moving · pengadaan scope |

---

## 6. Verifying changes without Node.js

Node is not installed, so `node --check` and every linter built on it are
unavailable, and there is no pyflakes for `py -3.10`. **`tools/verify/` is what
stands in for a test suite**, read its
[README](../tools/verify/README.md) first.

Three static checkers run in a second and need nothing:

```bash
py -3.10 tools/check_js.py        # duplicate top-level decls, eval-order, brackets
py -3.10 tools/check_html.py      # 5 index.html invariants
py -3.10 tools/check_py_names.py  # unresolved globals in main.py + api/
```

A fourth needs Chrome and answers the one question the others cannot:

```bash
py -3.10 tools/verify/syntax.py   # does js/ actually PARSE?
```

`check_js.py` has no JavaScript engine, it tokenises and counts brackets. An
`await` inside a listener that is not `async` is a SyntaxError that blanks the
page, and it passes every other check. `syntax.py` compiles each file with
`new Function(source)` in headless Chrome, which parses without executing.

`check_js.py`'s duplicate check is the one that matters most: two files
declaring the same top-level `let`/`const` is a fatal `SyntaxError` that blanks
the entire page, and nothing else reports it.

The rest need the app on :8017; the browser scripts drive real Chrome over the
DevTools Protocol (no Playwright, no Node). `gate.ps1` covers routes, OpenAPI and
the package invariants in one call.

### Two traps that have each cost a session

- **The app auto-restores a session from `sessionStorage` on load**, so a
  "fresh" document is not fresh until you clear it and reload. Assert your
  preconditions before trusting a result.
- **`matchMedia('(pointer: coarse)')` is false under headless emulation** and
  cannot be forced. The `@media (pointer: coarse)` block is what supplies the
  44px tap targets, and it applies on real hardware, so measuring rendered box
  sizes headless reports ~30 phantom failures. `audit.py` asserts the CSS rule
  from source instead.

### Always clean up

Exercising the API writes real rows into the local PostgreSQL. Delete every
asset, sparepart, gudang and `pengguna` row a check creates, then re-assert the
counts in §1. `mutate.py`, `test_auth.py`, `test_rev042.py` and `test_rev043.py`
all do this themselves; anything written by hand must too. Test data left in the
seeded database is indistinguishable from demo data later.

---

*Last updated against `rev0.4.6-alpha`.*
