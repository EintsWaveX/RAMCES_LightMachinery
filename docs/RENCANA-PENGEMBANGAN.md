# RAMCES — Development Roadmap

**Audience:** whoever maintains SIMA-KAI / RAMCES next.
**Scope:** what to *do* to the system. For how the system already *works*, read
[CLAUDE.md](../CLAUDE.md) — this document deliberately does not repeat it.

- End-user manual: [PANDUAN-RAMCES.md](PANDUAN-RAMCES.md) (Indonesian)
- Setting up from an empty database: [MULAI-DARI-NOL.md](MULAI-DARI-NOL.md)
- Coverage against the client's own acceptance criteria:
  [CAKUPAN-TIMELINE-MAGANG.md](CAKUPAN-TIMELINE-MAGANG.md)

Every number here was measured against the local seeded database, not estimated.

> **This document was rewritten at `rev0.4.3-alpha`.** The previous version was
> written against `rev0.4.0-beta` and opened with *"§2 BLOCKER — there is no
> authentication … nothing else in this document matters until this is done."*
> That had been false for two releases, and it listed as pending several things
> that had already shipped. A maintainer handed it would have started by
> rebuilding a login system that already existed. If you find this file
> disagreeing with the code again, fix the file — a stale roadmap is worse than
> no roadmap, because it is trusted.

---

## 1. Where the project stands

Branch `rev0.4.3-alpha`. Version naming is `revX.Y.Z-alpha` / `-beta`; the older
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

### Current baseline — keep these honest

```
routes            87        openapi paths     59
shadow pairs       0        require_role      43 guards
broadcasts        37        manage.py verify  13/13
audit findings     0        console errors     0  (8 views x 2 widths x 2 themes)

kategori_alat 104 · lokasi        273 · alat_varian   87
aset         1121 · riwayat      1121 · pengguna       2
gudang          3 · sparepart     203 · sparepart_stok 973
dokumen_alat   33 (30 primary, 0 orphaned files on disk)
```

Seeding a genuinely empty database takes **9 seconds** end to end.

---

## 2. What is DONE — do not re-report

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
| **Pagination transport** | one 4.5 MB / 16 MB response | `{total, limit, offset, items}` + `fetchAllPages()` |
| **Seeding** | a second run DOUBLED the fleet; the dummy step was never idempotent | `manage.py`, identity gates, `DEMO-` serials, 13/13 asserted |
| **Documents** | 3 PDFs (5.6 MB) reachable by nothing | `dokumen_alat`; verified from the DISK side |
| **`landing.html` sign-in** | 422'd for every user, and let you pick your own role | username + password + progressive captcha |
| **`uploads/` static leak** | a certificate saved as `.jpg` was readable with no token | the catch-all refuses the whole tree |
| **Mobile** | designed at desktop width and allowed to shrink | `.table-stack`, bottom nav, 44px targets, `.scroll-hint` |

---

## 3. Known gaps, ranked by what breaks first

### 3.1 Server-side paging for the deep screens — the scaling wall

Transport is done: `/api/aset` and `/api/history/summary` return the envelope and
accept `q` / `kode_alat` / `id_lokasi` / `status` / `tahun`. **The total bytes are
not** — the frontend still caches the whole fleet in `db` and filters client-side
through the one matcher in `js/search.js`.

The server filters exist as a *superset gate* precisely so Kelola Data Aset and
Pantau Riwayat can move to server-side paging without another API change. Doing
it means teaching those two views to render from a page rather than from `db`.
That is the work; the API is ready.

### 3.2 The repair-events window subquery runs four times per dashboard load

`_scoped_repair_events` is a subquery *expression*, re-executed by each of the
four `db.execute()` calls, and it contains a deliberately unfiltered `LAG` over
the whole `riwayat_kondisi` table. Wants a materialised CTE or a rollup table.
The dashboard is the first screen after login.

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

- No password expiry, and no PERSISTED audit log of failed sign-ins — the rate
  limiter counts them in memory only.
- `sparepart_kategori` names are matched by **exact string** on bulk import;
  unknown categories are rejected rather than created.
- `id_lokasi` / `site_from` / `site_to` on `sparepart_stok` are legacy
  region-tree columns kept only so existing transfer history keeps rendering.
  Dead weight for new writes; plan a migration rather than adding more.
- `SparePart` has no `stok_max`. `_stok_status()` keeps the branch documented as
  reserved, and `STOK_STATUS_ORDER` deliberately omits it — see rev0.4.3.
- Clicking a modal backdrop does not close it. Deliberately: several dialogs are
  long forms and a stray click would discard typed input. Revisit only with a
  dirty-state guard.
- Tables were left on inline Tailwind. `.table-std td` (0,1,1) outranks the
  per-cell `.px-4` (0,1,0) that 22 tables rely on, so adopting it is a restyle
  per table, not a find-and-replace.

---

## 4. Remaining client-matrix features

From [CAKUPAN-TIMELINE-MAGANG.md](CAKUPAN-TIMELINE-MAGANG.md). Three of the
original seven closed in rev0.4.3; these are what is left.

| Feature | Blocked on | Notes |
|---|---|---|
| **MTBF / MTTR** | **data, not code** | `_scoped_repair_events()` already isolates the exact transitions; one added `lag(waktu_lapor)` supplies the durations. But the fleet has **0 repair records**, so it would ship reading 0.0 hours. Build it once technicians have filed some. |
| **Calibration reminder** | **data + a surface** | 18 tool types and 75 live assets need calibration; there are **0 calibration records**. Also needs a notification surface the app does not have — the bell is session-scoped with no notifications table, deliberately. |
| **Stock opname** | a new table | The only remaining gap needing schema: an opname session (count → variance → adjustment). `ADJ_IN`/`ADJ_OUT` already exist as the adjustment mechanism, so it is additive. |
| **In-app QR scanner** | nothing, but low value | The field flow already works: the phone's native camera opens `landing.html?uid=…`. Needs camera-permission handling for marginal gain. |

**The pattern worth noticing:** two of the four are blocked on the system being
*used*, not on it being built. Shipping a reliability metric that reads 0.0
teaches users to ignore that panel, and it is hard to win that attention back.

---

## 5. Suggested order

| # | Work | Effort | Risk of leaving it |
|---|---|---|---|
| 1 | Server-side paging for the deep screens (§3.1) | Large (FE) | The wall the system hits as the fleet grows |
| 2 | Repair-dashboard CTE (§3.2) | Medium | Dashboard is the first screen after login |
| 3 | Stock opname | Medium | Last client-matrix item that is purely build work |
| 4 | MTBF/MTTR + calibration reminder | Small each | **Wait for data.** Neither is a code problem |
| 5 | Surrogate PK (§3.4) | Large | Makes every edit cheap; do after paging |
| 6 | Redis-backed rate limiting (§3.3) | Small | Only matters once deployed multi-worker |
| 7 | Tailwind build step (§3.6) | Medium | Only if a build step becomes acceptable |

---

## 6. Verifying changes without Node.js

Node is not installed, so `node --check` and every linter built on it are
unavailable, and there is no pyflakes for `py -3.10`. **`tools/verify/` is what
stands in for a test suite** — read its
[README](../tools/verify/README.md) first.

Three static checkers run in a second and need nothing:

```bash
py -3.10 tools/check_js.py        # duplicate top-level decls, eval-order, brackets
py -3.10 tools/check_html.py      # 5 index.html invariants
py -3.10 tools/check_py_names.py  # unresolved globals in main.py + api/
```

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
  44px tap targets, and it applies on real hardware — so measuring rendered box
  sizes headless reports ~30 phantom failures. `audit.py` asserts the CSS rule
  from source instead.

### Always clean up

Exercising the API writes real rows into the local PostgreSQL. Delete every
asset, sparepart, gudang and `pengguna` row a check creates, then re-assert the
counts in §1. `mutate.py`, `test_auth.py`, `test_rev042.py` and `test_rev043.py`
all do this themselves; anything written by hand must too. Test data left in the
seeded database is indistinguishable from demo data later.

---

*Last updated against `rev0.4.3-alpha`.*
