# RAMCES — Development Roadmap

**Audience:** whoever maintains SIMA-KAI / RAMCES next.
**Scope:** what to *do* to the system. For how the system already *works*, read
`CLAUDE.md` — this document deliberately does not repeat it.

For the end-user manual see [PANDUAN-RAMCES.md](PANDUAN-RAMCES.md) (Indonesian).

Every number below was measured against the local seeded database
(200 assets — 83 AFKIR / 58 SO / 59 TSO — 628 mutasi, 802 kondisi, 559 kalibrasi,
203 spareparts across 3 gudang, 955 stock movements), not estimated.

---

## 1. Where the project stands

Branch `rev0.4.0-beta`. Four rounds of work have landed:

| Round | What it delivered |
|---|---|
| Correctness pass | Search/sort unification, the Balaiyasa rule, inventory ledger, certificate upload |
| Design pass | `assets/style.css` component layer (`.card`, `.btn`, `.badge`, `.modal-*`, `.table-std`) |
| Performance pass | GZip, cache headers, lazy XLSX/jsPDF, WebP hero, `Map` indexes, debounced search, connection pool, `asyncio.gather` broadcast — and the split of `app.js` into 14 ordered classic scripts |
| Defect + a11y pass | The seven fixes in §3, plus `js/a11y-modal.js` |

### Measured baseline — keep these honest

Endpoint payloads, gzipped vs raw, at 117 active assets:

| Endpoint | Raw | Wire (gzip) | Time |
|---|---|---|---|
| `/api/aset` | 38.8 KB | 4.9 KB | 35 ms |
| `/api/history/summary` | 98.6 KB | 9.5 KB | 139 ms |
| `/api/inventaris/parts` | 133.1 KB | 10.3 KB | 109 ms |
| `/api/inventaris/stok` | 28.0 KB | 2.7 KB | 92 ms |
| `/api/aset/dashboard/perbaikan` | 6.7 KB | 1.3 KB | 117 ms |
| `/api/export/riwayat` | 223.3 KB | 14.2 KB | 120 ms |
| `/api/export/mutasi` | 116.5 KB | 9.7 KB | 76 ms |

Static assets: `index.html` 385.8 KB raw, `js/` ~475 KB raw / ~123 KB gzipped,
`assets/style.css` 27.7 KB → 6.4 KB, `landing.html` 87.5 KB.

Conditional requests now work on every static route — `/`, `/js/*.js`,
`/landing.html` and `/assets/*` all answer **304 with a zero-byte body** when the
client's ETag still matches.

---

## 2. BLOCKER — there is no authentication

Nothing else in this document matters until this is done.

`/api/login` never verifies a password, and no password field exists anywhere in
`index.html`, `landing.html` or `js/`. When a username does not exist the
endpoint **creates it with whatever role the client claimed**. Anyone who can
reach the app types a name, clicks **SUPER ADMIN**, and receives a
full-privilege token. `bcrypt`, `get_password_hash()` and `verify_password()`
all exist in `main.py` and are simply never called on this path.

The fix, in order:

1. Add a password field to the login flow and to `POST /api/users/create`.
2. Hash on first registration; `verify_password()` on every subsequent login.
3. Stop auto-registering unknown usernames — never with `SUPER_ADMIN` or
   `ADMIN_WILAYAH`.
4. Set a real `SECRET_KEY` (it falls back to a hardcoded default) and drop the
   `allow_origins=["*"]` + `allow_credentials=True` pairing, which is invalid
   anyway. The SPA is same-origin, so CORS can probably go entirely.

> **Regional scoping is a separate concern and must survive this work.**
> `assert_region_scope()` / `assert_aset_region_scope()` are what confine an
> `ADMIN_WILAYAH` to its own region; they are correct now (§3) and are not made
> redundant by adding passwords. Do not fold one into the other.

Also still true: `database.py` falls back to a hardcoded URL containing a real
password. That fallback must not survive the repo leaving this machine.

---

## 3. Fixed in the last round — do not re-report

Each was reproduced live before the fix and verified live after (32 backend
checks + 24 accessibility checks, all passing).

| # | Defect | Fix |
|---|---|---|
| 1 | Editing an asset from **Kelola Data Alat Kerja** silently nulled `nomor_seri` and `id_varian` | The form now sends both; `update_aset()` also distinguishes "absent" from "explicitly null" via `model_fields_set` |
| 2 | `ADMIN_WILAYAH` scoping broken **in both directions** — locked out of its own `JR1.*` assets (token carries `D1`, assets live at UPT codes), while `create` / `kondisi` / `kalibrasi` had no check at all | One pair of helpers built on `resolve_lokasi_scope()`, applied to all six mutating paths; the asset variant resolves *home* location so a workshop trip does not lock the owner out |
| 3 | Unknown `peruntukan` became the literal `"X"`; anything not `"PUSAT"` became procurement code `2` | `normalise_peruntukan()` / `normalise_sumber_pengadaan()` raise 400 |
| 4 | `nomor_urut = count + 1` — deleting any asset permanently dead-ended the next create with *"Terjadi konflik ID"* | Derived from `max(urutan) + 1` |
| 5 | Sending a TSO asset to a Balaiyasa **removed it from its DAOP's `sedang` count** | `sedang` and `workshop_list` scope by `home_lokasi_expr`; still grouped by current position, so `sedang == sum(workshop_list[].jumlah)` holds |
| 6 | `Cache-Control: no-cache` never produced a 304 — Starlette's `FileResponse` emits an ETag but never reads `If-None-Match` | `file_response_conditional()`, borrowing `StaticFiles.is_not_modified`. Note it **must** be passed `stat_result`, or the headers are empty when compared |
| 7 | 33 modals with no `role`/`aria-modal`/label, no Esc, no focus trap, no focus return; 5 native `confirm()` calls | `js/a11y-modal.js` (runtime, generic); the five calls now `await customConfirm()` |

---

## 4. Fixed in the UI hardening pass

A second sweep drove every view at desktop and phone width, in both themes, and
opened all 30 modals. Zero console errors were found anywhere. What it did find:

| Defect | Fix |
|---|---|
| **Admin menu survived a role downgrade.** `checkAuth()` only ever *removed* `hidden` from `#nav-masterdata`/`#nav-afkir`/`#admin-helper`; nothing put it back. SUPER_ADMIN → `forceLogout(false)` (the 401 path in `apiFetch`, which does not reload) → TEKNISI login on the same document left both admin screens on the menu. Server still returned 403, so never an escalation — but the menu contradicted the permissions. | `checkAuth()` now sets every role-gated item explicitly in both directions via `classList.toggle("hidden", …)` |
| **Esc could leave a dialog open.** The close control is clicked rather than hiding the panel (so `customConfirm` resolves), but some controls are inert — `customConfirm` nulls its own handlers once resolved, and `#master-edit-modal` / `#inv-category-modal` name their button after the *panel* (`close-master-edit`, `inv-category-modal-close`) rather than the backdrop. | `requestClose()` also accepts `[id^="close-"]` / `[id$="-close"]` inside the dialog, and verifies the dialog actually closed — falling back to hiding it |
| **36 icon-only buttons announced as just "button".** | 8 distinct controls got `aria-label` in the markup; the 28 close buttons are named "Tutup" at runtime by `js/a11y-modal.js`, so modals added later are covered automatically |
| **Muted badges failed contrast in dark mode** — `#6b7280` on `#374151` is 2.31:1, well under the 4.5:1 floor for 10px bold text. | `.badge-neutral` retuned; every badge now measures ≥ 4.52:1 in dark |
| **20 badge spans were hand-rolled inline Tailwind**, one of the drifting copies the component layer exists to retire. | All converted to `.badge` + modifier. `.badge` was already a pixel-exact match, so nothing moved visually. `.badge-afkir` split from `.badge-neutral` (the app draws AFKIR red, not grey) and `.badge-move` added for "SEDANG TERMUTASI" |
| **Pagination was clipped and unreachable on phones.** The button row was `flex` with no wrap, and nothing in the ancestor chain scrolls horizontally. | `flex-wrap` + `sm:ml-auto` in the shared paginator, so every list is fixed at once. The per-page `<select>` also gained a real `for`/`aria-label` pair |
| **The sidebar opened over the app on phones.** `checkAuth()` called `toggleSidebar()` unconditionally, so every mobile session began by dismissing the drawer. | Guarded to `innerWidth >= 1024` |

Verified live: 13/13 targeted checks, plus the 32 backend and 24 accessibility
checks still green.

### Still open, deliberately

- **The app ignores `prefers-color-scheme`.** Dark mode is a `dark` class on
  `<html>` persisted in `localStorage`, so a viewer whose OS is dark still gets
  light on first load. Defensible, but worth a one-line default.
- **125 form controls have no `<label for>`**, relying on adjacent text or a
  placeholder. Screen readers announce many of them as unlabelled. Mechanical to
  fix but touches a lot of markup.
- **28% of buttons use `.btn`**; the rest are hand-rolled Tailwind, and only
  2 of 24 tables use `.table-std`. Not a bug — the known cost of retiring the
  inline styling gradually.

## 4b. UX and consistency pass

Driven by the recommendations at the end of §4, all verified live (13 checks).

| Change | Why |
|---|---|
| **Kurva MCF is its own dashboard tab.** Moved out of `dash-panel-perbaikan`, where it sat under an inner scroll container. It carries its own Lokasi/Tahun row; `repair-dashboard.js` still holds exactly one copy of the filter state (`_lokasiFilter`, `_tahunFilter`, `_semuaTahun`) and syncs both rows, so switching tabs never appears to change the filter. | It took four scripted attempts to locate the chart programmatically. A user would not have found it. |
| **"Sedang Perbaikan" now reads "(saat ini)"** and carries a `title`. | It is the only point-in-time figure in a row of year-scoped ones, and the single most misread number on the dashboard. |
| **Theme follows `prefers-color-scheme`** when nothing is stored; an explicit choice still wins, and the OS is followed live only for users who never chose. Mirrored in `landing.html`. | A dark-mode user got a full-brightness page on every first visit. |
| **`landing.html` registers presence.** Opens `/ws/updates?token=…` once signed in, sends `view:Kartu Aset (QR)`, heartbeats at 30 s, reconnects with backoff + jitter, re-checks on `visibilitychange`. A dot in the header shows the state. Anonymous scans stay anonymous. | Presence is keyed off the WebSocket, and this page never opened one — a technician filing from the field showed as offline the whole time. |
| **`landing.html` styling.** Header fits one line at 390 px (was three); the Spesifikasi card moved off the red/danger palette onto the app's blue, its variant pill onto `.badge-info`, its field labels to neutral grey. | It read as an error state for what is reference data, and did not match the equivalent block in `index.html`. |
| **Buttons on the component layer: 28% → 53%** (62/217 → 118/219). Converted only exactly-repeated class strings whose component equivalent is a pixel match. Added `.btn-icon-close` for the 25 modal × buttons, deliberately keeping the round 1.75 rem form. | Twenty-five copies of one rule is exactly the drift `assets/style.css` exists to retire. |
| **Form controls: 117 unnamed → 19.** 92 existing `<label>` elements linked via `for=` (verified: 154 labels, zero dangling, zero duplicate targets); 6 given `aria-label` from their placeholder. | Screen readers announced most filters and search boxes as unlabelled. |

### Deliberately not done

- **Tables were left alone.** `.table-std` styles `th`/`td` directly, and
  `.table-std td` (0,1,1) outranks the per-cell utilities like `.px-4` (0,1,0)
  that all 22 remaining tables rely on. Adopting it is a restyle of every cell,
  not a refactor — it needs a visual pass per table, not a find-and-replace.
- **19 form controls still unnamed**, all with no adjacent label to link and no
  placeholder to borrow. They need names written by hand.

### A measurement trap worth knowing

Badge backgrounds in dark mode are `rgba(…, .25)`. `getComputedStyle` returns
the declared value, not the composited one, so a naive contrast check scores
them as if opaque and reports ~2.3:1 for pairs that actually render at 4.8:1.
Composite over the nearest opaque ancestor before computing the ratio. Measured
after that correction: **light worst 4.52:1, dark worst 4.82:1** — both above
the 4.5:1 floor.

## 5. Known gaps, ranked by what breaks first

### 5.1 No pagination on `/api/aset` or `/api/history/summary`

Measured: **340 B/asset** for `/api/aset`, **864 B/asset** for
`/api/history/summary`. At 10,000 assets that is **~3.4 MB** and **~8.6 MB** raw
per call (~430 KB / ~830 KB gzipped), fetched on every login and after every
mutation.

`get_transfer_history` and `get_stok_movements` already implement the right
`{total, limit, offset, items}` envelope — copy it. The blocker is the frontend:
`db` caches the whole fleet in memory and re-filters it client-side, so this is a
frontend change as much as a backend one.

### 5.2 Exports build everything in memory

`export_riwayat` is 223 KB at 117 assets and scales linearly with history rows;
it would be ~30 MB and ~110,000 queries at 10k assets. Wants `StreamingResponse`
plus a CSV generator, and an eager-loaded query rather than per-asset loops.

### 5.3 The repair-events window subquery runs four times per dashboard load

`_scoped_repair_events` is a subquery *expression*, re-executed by each of the
four `db.execute()` calls, and it contains a deliberately unfiltered `LAG` over
the whole `riwayat_kondisi` table. Wants a materialised CTE or a rollup table.
The dashboard already costs 117 ms at this data size.

### 5.4 The `lokasi` table is re-read several times per request

`resolve_lokasi_scope`, `balaiyasa_lokasi_ids` and `resolve_home_lokasi` each run
their own `db.query(models.Lokasi).all()`; the repair dashboard alone loads it
four times, and §3's `home_lokasi_expr` added another consumer. It is ~250 rows
and changes monthly — a TTL cache of plain tuples (not ORM instances, which
detach) would remove all of it.

### 5.5 Foreign keys have no `ondelete`

Reproduced live: deleting a user who has ever filed a mutasi raises
`ForeignKeyViolation` → HTTP 500. `id_pengguna` FKs want `SET NULL`; `id_aset`
FKs want `CASCADE`. Note `riwayat_kalibrasi_id_aset_fkey` already has `CASCADE`,
so the table is inconsistent as well as wrong.

### 5.6 `aset` has a composite string primary key

`<urutan>.<kode_alat>.<pengadaan>.<yy>.<peruntukan>.<lokasi>` encodes five
mutable attributes, so editing any of them regenerates the PK and rewrites every
child row (`update_aset` does exactly this today). A surrogate `BIGSERIAL` with
`id_aset` kept as a unique business key would make it a single-row update.

### 5.7 Tailwind runs as a CDN JIT compiler in the browser

It rewrites the DOM at runtime, must stay eager (deferring it flashes unstyled
content), and prints a production warning on every load. Replacing it with a
compiled stylesheet needs a build step, which the project deliberately does not
have. Decide explicitly rather than drift.

### 5.8 Verified clean — do not re-audit

All **46** mutating `apiFetch` calls check `res.ok` before reporting success.
A naive scan flags ~19 of them because the check sits more than a dozen lines
below the call or after a ternary's second branch; every one was read and is
correct. The trap is real and documented in CLAUDE.md — it just is not present.

### 5.9 Smaller

- `SparePart` has no `stok_max`, so `_stok_status()` is always called with
  `stok_max=None`. **CLAUDE.md claims the "DI ATAS MAX" tile was removed — it was
  not.** The inventory dashboard's *Status Barang* legend still renders
  **"Di Atas Maksimum 0 (0.0%)"** on every load, which is exactly the permanent
  zero the note says was avoided. Either add the column or drop the legend entry,
  and correct CLAUDE.md either way.
- `sparepart_kategori` names are matched by **exact string** on bulk import;
  unknown categories are rejected rather than created, with no fuzzy match.
- `id_lokasi` / `site_from` / `site_to` on `sparepart_stok` are legacy
  region-tree columns kept only so existing transfer history keeps rendering.
  They are dead weight for new writes; plan a migration rather than adding more.
- `landing.html` header wraps to three lines at 390 px ("RAMCES Light
  Machinery — Kartu Aset"). Cosmetic, visible in the manual's screenshots.
- Clicking a modal backdrop does not close it. Deliberately not added — several
  dialogs are long forms and a stray click would discard typed input. Revisit
  only with a dirty-state guard.

---

## 6. Suggested order

| # | Work | Effort | Risk of leaving it |
|---|---|---|---|
| 1 | Authentication (§2) | Medium | **Critical** — every guard behind it is decorative |
| 2 | Nav-visibility asymmetry (§4) | Trivial | Low, but it makes the UI contradict the server |
| 3 | FK `ondelete` (§5.5) | Small | User deletion 500s today |
| 4 | `lokasi` TTL cache (§5.4) | Small | Pure win, no behaviour change |
| 5 | Repair-dashboard CTE (§5.3) | Medium | Dashboard is the first screen after login |
| 6 | Pagination (§5.1) | Large (FE+BE) | The wall the system hits as the fleet grows |
| 7 | Streaming exports (§5.2) | Medium | Memory blow-up at scale |
| 8 | Surrogate PK (§5.6) | Large | Makes every edit cheap; do after pagination |
| 9 | Tailwind build step (§5.7) | Medium | Only if a build step becomes acceptable |

Items 2–4 are each an afternoon and carry no behavioural risk; they are good
warm-up work for someone new to the codebase.

---

## 7. Verifying changes without Node.js

Node is not installed on this machine, so `node --check` and every linter built
on it are unavailable. Two things fill the gap.

### JavaScript integrity

```bash
py -3.10 tools/check_js.py
```

`tools/jslex.py` is a JS-aware tokenizer (strings, template literals with nested
`${}`, comments, regex literals); `check_js.py` uses it to verify bracket balance
per file, assert **no identifier is declared twice across files**, and report
call targets declared nowhere.

The duplicate check is the one that matters: two files declaring the same
top-level `let`/`const` is a fatal `SyntaxError` that blanks the entire page, and
nothing else will tell you. Section 3 has permanent false positives (object
method shorthand, browser globals such as `MutationObserver`, the `JR(` inside
the lokasi regex) — only *new* entries mean anything.

### Driving the real app

Playwright is not installed, but **this does not put the browser out of reach**.
Chrome is at `C:\Program Files\Google\Chrome\Application\chrome.exe`, and Python
3.10 has `requests` and `websockets` — enough to drive Chrome over the DevTools
Protocol directly:

```bash
chrome.exe --headless=new --remote-debugging-port=9333 \
           --user-data-dir=<scratch> --window-size=1440,900 about:blank
```

Then over the WebSocket from `http://127.0.0.1:9333/json`:

| CDP method | Use |
|---|---|
| `Page.navigate` | Load the app |
| `Runtime.evaluate` | Call the app's own globals — `handleLogin()`, `switchView()`, `assetMatchesSearch()`, `apiFetch()` |
| `Runtime.enable` + `Log.enable` | Collect console errors and exceptions |
| `Page.captureScreenshot` | PNG/JPEG/**WebP** — how the manual's screenshots were made |
| `Emulation.setDeviceMetricsOverride` | Phone-width layout checks |

Because the frontend keeps everything on the global scope, invariants can be
asserted against real seeded data instead of by reading source. Two traps worth
knowing:

- The app **auto-restores a session from `sessionStorage` on load**, so a "fresh"
  document is not fresh until you clear it and reload. Assert your preconditions
  before trusting a result — this is what caught §4 being real rather than an
  artifact of test ordering.
- Do not hold a page promise across an `await` in an evaluated script; V8 may
  collect it and the CDP call dies with *"Promise was collected"*. Fire and
  observe instead.

### Always clean up

Exercising the API writes real rows into the local PostgreSQL. Delete every
asset, sparepart, gudang and `pengguna` row created during a check, then
re-assert the counts against the values at the top of this document. Test data
left in the seeded database is indistinguishable from demo data later.

---

*Last updated against `rev0.4.0-beta`.*
