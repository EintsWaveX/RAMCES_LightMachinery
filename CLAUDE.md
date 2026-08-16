# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SIMA-KAI (UI brand name: **RAMCES**) — an asset-management system for PT Kereta Api Indonesia's light machinery (*alat kerja*): generators, tampers, rail grinders, etc. It tracks each asset's condition history, transfers between regions, calibration records, and a sparepart inventory ledger.

Domain vocabulary, DB column names, and all UI strings are **Indonesian**. Keep new user-facing text and column names in Indonesian to match.

## Commands

There is no test suite, linter, build step, or dependency manifest in the repo.

```bash
# Run the server (serves both the API and the SPA on the same origin)
py -3.10 -m uvicorn main:app --reload

# ── manage.py: the ONE database CLI ──────────────────────────────────
# `seed.py` and `reset.py` were two loose root scripts holding nothing but
# argparse, 229 lines between them, with the destructive one a tab-completion
# away from the safe one. They are now subcommands.

# Seed / top up (drops nothing). Every step is IDEMPOTENT: running this twice
# changes nothing the second time, and `verify` asserts that.
py -3.10 manage.py seed
py -3.10 manage.py list                # the steps and what each one does
py -3.10 manage.py seed --only dokumen # re-attach the client's PDFs only
py -3.10 manage.py verify              # check without writing anything
py -3.10 manage.py status              # row counts per table, no writes

# DESTRUCTIVE: drop every table, recreate, and reseed from scratch.
# Prompts for the literal word RESET; --yes skips the prompt.
py -3.10 manage.py reset

# ...plus 100 demo assets and a simulated maintenance history.
# OFF BY DEFAULT: the imported fleet is real, and inventing repair records
# against it would be indistinguishable from fact later. Without this flag the
# repair dashboard, the MCF curve and Laporan Perbaikan render EMPTY.
py -3.10 manage.py reset --yes --with-history

# ── Simulated operational history for the REAL fleet ─────────────────
# Also OFF BY DEFAULT, and safe for a different reason: every row it writes is
# attributed to a dedicated SIMULASI account and tagged [SIMULASI], and the
# undo restores the database exactly. See "Simulated history" below.
py -3.10 manage.py seed --simulasi        # or: seed --only simulasi
py -3.10 manage.py hapus-simulasi         # remove all of it, exactly
```

`--aset N` is a TARGET POPULATION, not a number to add, and it is refused
outright without `--with-history` rather than silently ignored — it used to
thread all the way into `run_steps()` and then be dropped because the dummy step
was not selected, writing nothing and saying nothing.

**Only Python 3.10 has the dependencies installed** (fastapi 0.139, sqlalchemy 2.0, bcrypt, pyjwt, psycopg2, python-dotenv, openpyxl). `python` on PATH resolves to 3.14 and will fail with `ModuleNotFoundError`. Always use `py -3.10`.

Requires a running PostgreSQL and a `.env`. **Copy `.env.example` to `.env` before
first run** — there are no fallbacks any more, and both missing values fail the boot
loudly with the line to add:

- `DATABASE_URL` — required. The hardcoded local URL that used to stand in for it
  carried a real password in a tracked file.
- `SECRET_KEY` — required. It used to fall back to a constant published in
  `main.py`, which means anyone holding that file could mint a `SUPER_ADMIN`
  token without ever calling `/api/login`. Generate one with
  `py -3.10 -c "import secrets; print(secrets.token_urlsafe(48))"`.
- `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` — optional. The seed's
  `pengguna` step creates this account; with no password set it generates one and
  prints it **once**.
- `PUBLIC_URL` / `NGROK_URL` — optional external base URL, used *only* to build
  QR/landing links when the page is viewed on localhost (see `/api/config`).

## Layout

| File | Role |
|---|---|
| [main.py](main.py) (~320 lines) | App construction only — GZip, the Cache-Control middleware, the WebSocket endpoint, the router includes, static serving |
| [api/](api/) (14 modules) | The FastAPI backend, split out of main.py in rev0.5.1. See below. |
| [models.py](models.py) | All SQLAlchemy models |
| [js/](js/) (17 files, ~13k lines) | The frontend — vanilla JS, no modules, no build step. See below. |
| [index.html](index.html) (~6k lines) | SPA shell; every view/modal exists in the DOM at once |
| [manage.py](manage.py) | The one database CLI — `seed` / `reset` / `verify` / `status` / `list` |

Docs: [docs/MULAI-DARI-NOL.md](docs/MULAI-DARI-NOL.md) is the from-empty-database
setup path (measured: 9 seconds to seed, 16/16 verify);
[docs/CAKUPAN-TIMELINE-MAGANG.md](docs/CAKUPAN-TIMELINE-MAGANG.md) maps the
client's feature matrix line by line to what actually exists.

Supporting: [database.py](database.py) (engine/session/pool), [landing.html](landing.html) (standalone public page reached by scanning an asset's QR code — `/landing.html?uid=<id_aset>`), [assets/](assets/) (static, mounted at `/assets` — `style.css` holds the design tokens and component layer, and is loaded by **both** index.html and landing.html).

**Seeding — the `seeds/` package, TRACKED.** `manage.py` is only a CLI over an
ordered registry of idempotent steps; each step is one module:

| Step | Module | What it writes |
|---|---|---|
| `katalog` | `seeds/katalog.py` | 104 alat kerja, 16 lokasi, 257 UPT (`lokasi` total 273) |
| `dokumen` | `seeds/dokumen.py` | the client's 25 spektek/manual files → `uploads/dokumen_alat/`, as 33 `dokumen_alat` rows across 27 tool types |
| `model` | `seeds/model_type.py` | `alat_varian` from the Rekap + legacy + remapped codes |
| `aset` | `seeds/aset.py` | the real 1,121-asset fleet |
| `inventaris` | `seeds/inventaris.py` | gudang → kategori → sparepart → stok awal, in that order |
| `pengguna` | `seeds/pengguna.py` | the bootstrap `SUPER_ADMIN` |
| `dummy` | `seeds/dummy.py` | **off by default** — 100 demo assets (`nomor_seri` `DEMO-…`) + a simulated history |
| `simulasi` | `seeds/simulasi.py` | **off by default** — marked operational history for every asset that has none |

`seeds/verify.py` runs after every seed and after `manage.py reset`; a failed assertion is a
non-zero exit. `seed_katalog.py` keeps its role as the DATA (the transcription of the
client's spreadsheets and `Rekap Spek RAMCES.docx`) and holds no writers;
`seed_aset_real.py` still owns READING and cleaning the workbook.

`modules/` is the client's source drop (katalog spreadsheets, the import workbook,
~40 MB of manual/spektek PDFs). The seed modules read it directly, so a checkout
without it can still boot but cannot reseed or attach documents.

The backend serves the frontend: `GET /` returns `index.html`, and a catch-all `GET /{file_path:path}` serves extension-allowlisted static files from the project root. There is no separate dev server — everything is same-origin.

### The `api/` package — routers, and one invariant

`main.py` was 5,901 lines. It is now fourteen modules plus a ~320-line assembly
file. **Route paths and methods did not change**, and neither did the OpenAPI
document — that was the gate the whole move was verified against.

| Module | Contents |
|---|---|
| `api/deps.py` | The hinge. Lokasi hierarchy + the TTL cache, `resolve_lokasi_scope`, `assert_*_region_scope`, `normalise_*`, `get_db`, `SECRET_KEY`/bcrypt/`require_role`, the paging envelope |
| `api/files.py` | `PROJECT_ROOT`, the uploads tree, the cache-header policy, `file_response_conditional` |
| `api/realtime.py` | `ConnectionManager` + the `manager` singleton |
| `api/schema.py` | `_ensure_schema()` — defined here, still CALLED from main.py at import |
| `api/schemas.py` | Every Pydantic request model, in one module |
| `api/captcha.py` | Stateless HMAC-signed challenge, rendered as inline SVG. Leaf module — imports nothing from `api/` |
| `api/ratelimit.py` | In-process buckets for `/api/login`, `/api/register`, `/api/captcha`. Also a leaf |
| `api/auth.py` · `master.py` · `aset.py` · `riwayat.py` · `inventaris.py` · `dashboard.py` | The routers |

**THE INVARIANT: no module in `api/` may import `main`.** `main.py` imports every
router to call `include_router`, so an import back is a hard cycle. That is why
`manager` lives in `realtime.py` and `file_response_conditional` in `files.py`
rather than beside the WebSocket route and the static routes that also use them.

Other things that are load-bearing and easy to undo:

- **Routers are bare `APIRouter()`** — no prefix, no tags, no router-level
  dependencies. Paths are already absolute, and tags would change `openapi.json`,
  which is the verification gate.
- **`PROJECT_ROOT` is a double `dirname`** in `files.py`, with a tripwire that
  checks `index.html` is next to it. Copied naively into `api/`, the old
  `dirname(abspath(__file__))` silently resolves to `…/api` and `os.makedirs`
  cheerfully creates `api/uploads/` — every existing certificate then 404s while
  uploads appear to succeed.
- **`_ensure_schema()`, `create_all` and `load_dotenv` stay at import time.** A
  lifespan would be a behaviour change smuggled into a re-organisation, and
  `_ensure_schema()`'s `UPPER()` normalisation is an implicit contract for the
  queries that compare `status_terakhir` raw.
- **`GET /` and `GET /{file_path:path}` are the last two routes registered.** The
  catch-all matches everything.
- `main.py` re-exports `get_password_hash` for `seeds/pengguna.py`, which does
  `from main import get_password_hash`. `seeds/` is gitignored, so nothing in the
  tracked tree points at it.
- **`DELETE /api/users/{user_id}` is registered before `DELETE /api/users/me`**,
  so `/me` matches the first route, fails int coercion and 422s —
  `delete_own_account` is unreachable. Pre-existing, preserved deliberately
  through the split, and flagged in `api/auth.py`'s docstring. Fixing it is a
  one-line reorder that belongs in its own commit.

### The `js/` split — plain scripts, fixed order

`app.js` was a single 11.6k-line file. It is now sixteen **classic scripts** loaded in a fixed order by the tag list at the bottom of [index.html](index.html). No bundler, no ES modules, and the `window.foo = foo` convention is unchanged — the `onclick=` handlers these files generate inside template strings resolve against the global scope, so the exports must stay global.

| Load order | File | Contents |
|---|---|---|
| 1 | `js/core.js` | Global state, `getParentLokasiCode`, JWT/profile/clock, loading overlay, sidebar, paginator, `showToast`/`customConfirm`, date formatters, `loadScript`/`ensureXLSX`/`ensureJsPDF`, `KAI_VIZ` |
| 2 | `js/a11y-modal.js` | Dialog semantics, Esc, focus trap and focus return for every modal (self-contained IIFE) |
| 3 | `js/captcha.js` | The captcha widget (`window.RamcesCaptcha`). **Also loaded by landing.html** — self-contained IIFE for exactly that reason |
| 4 | `js/api.js` | `apiFetch`, `fetchAsetFromServer`, `fetchMasterData` |
| 5 | `js/search.js` | The shared matcher, the Map indexes, `decodeAsetId`, `resolveLokasi`, `_historySummary` |
| 6 | `js/shell.js` | Auth, `switchView`, `setupEventListeners`, WebSocket/presence/polling |
| 7–15 | `js/views/*.js` | `dashboard`, `aset`, `riwayat`, `kdak`, `afkir`, `masterdata`, `sort-modals`, `laporan`, `repair-dashboard` |
| 16 | `js/views/spektek.js` | `renderSpekCard()` — the Model/Type spec card. **Also loaded by landing.html**, along with `js/captcha.js` and nothing else |
| 17 | `js/views/inventaris.js` | Kelola Inventaris — must stay last, see below |

Two rules govern this:

- **Order only matters for top-level code.** Function declarations hoist and every cross-file call happens at runtime, so `core.js` may call something defined in `views/inventaris.js`. What must not happen is one file's *top-level* code reading — or CALLING — something a later file declares. This is not theoretical: a `debounce()` call added at `core.js` eval time, where `debounce` lives in `search.js`, threw and killed the rest of `core.js`, blanking the whole page. **`tools/check_js.py` check 4 now catches exactly this**, including inside immediately-invoked wrappers, which is where it happened. Everything else — an event handler, a callback, a named function nobody has called yet — runs after every file is evaluated and is safe.
- **They share one global lexical scope.** The same top-level `let`/`const` in two files is a fatal `SyntaxError` that blanks the entire page, and nothing warns you. There is no Node.js on this machine to lint with, so this is checked by a script instead (see Verification below).

`js/views/inventaris.js` must stay **last**: alone among the view files it caches its DOM nodes at eval time rather than looking them up lazily.

### Verification without Node.js

Node is not installed, so `node --check` and every linter built on it are
unavailable — and there is no pyflakes for `py -3.10` either. Three checkers
stand in for all of it. Run all three after any large mechanical edit:

```bash
py -3.10 tools/check_js.py        # js/ — see the four checks below
py -3.10 tools/check_html.py      # index.html — five checks
py -3.10 tools/check_py_names.py  # main.py + api/ — unresolved global names
```

**`tools/check_html.py`** asserts the invariants this file describes in prose
and that nothing else enforces: every `.view-section` is reachable from a
`data-view` button (`view-edit` and `view-history-detail` are exempt
drill-downs); every modal root has a close control; no duplicate `id`; every
`<table class="table-stack">` has a `<thead>` with a non-empty `<th>`; and the
`js/` `<script>` order matches `LOAD_ORDER` in `check_js.py` with nothing
deferred. It identifies modal roots the way `js/a11y-modal.js` does — a `div`
with `fixed inset-0` or `.modal-backdrop` — because 28 ids ending in `-modal`
are *buttons*, and a naive `[id$="-modal"]` selector counts them.

**`tools/check_py_names.py`** catches the one failure a large backend move
actually causes: a function moves to a new module while a helper it CALLS stays
behind. Python resolves globals at call time, so that imports cleanly, produces
an identical route table and a byte-identical `openapi.json` — then raises
`NameError` the first time that one endpoint is requested. It happened twice
during the rev0.5.1 split (`_varian_payload`, `_net_stok_map`). The analysis is
deliberately flat rather than scope-aware, which makes it blind to "defined in
the wrong function" but gives it zero false positives.

[tools/jslex.py](tools/jslex.py) is a small JS-aware tokenizer (it tracks strings, template literals with nested `${}`, comments and regex literals); [tools/check_js.py](tools/check_js.py) uses it for four checks:

1. bracket balance per file;
2. **no identifier declared twice across files** — a fatal `SyntaxError` that blanks the whole page and that nothing else reports;
3. call targets declared nowhere (a function lost in a move);
4. **eval-time calls into a file that loads later** — see the ordering rule above. `LOAD_ORDER` in that file mirrors the `<script>` tags at the bottom of index.html and must be kept in step.

Checks 2 and 4 are the important ones: both blank the page, and neither produces any other signal.

Its third section reports a handful of permanent false positives (object method shorthand such as `afterDatasetsDraw(chart) {…}`, and the `JR(` inside the lokasi regex) which read as calls. Only new entries there mean anything.

## Authentication — implemented, and the shape of it matters

`/api/login` used to verify no password at all, and *created* any unknown username
with whatever role the request body claimed. Anyone who could reach the app typed a
name, sent `role="SUPER_ADMIN"`, and received a full-privilege token; every
`require_role([...])` guard behind it was decorative. That is fixed. What replaced it:

- **`login()` verifies a bcrypt hash and never creates accounts.** An unknown
  username is a 401 with the same generic message as a wrong password — a distinct
  "user not found" tells an attacker which usernames are real. An unknown name is
  still hashed against `_DUMMY_HASH` so both paths take the same time.
- **`role` and `id_lokasi` on `LoginForm` are IGNORED.** They are read from the
  stored row. The fields remain on the model only so an older client still parses.
- **The login screen is ONE step.** It used to be three: username → *pick your own
  role from three cards* → pick your own region. Both of those are properties of the
  account, not choices, and asking for them WAS the escalation. Removing them also
  removed the confirmation dialog that recited the answers back.
- **`POST /api/users/create` requires a password** (min 8 chars, `validate_password`)
  and validates `role` against the closed `ROLES` tuple.
- **`POST /api/users/{id}/password`** is the recovery path: your own password with
  the old one, or anyone's as `SUPER_ADMIN`. Every row seeded before authentication
  has `hashed_password IS NULL`, cannot log in, and is flagged in Pusat Data ▸
  Pengguna via `has_password` on `GET /api/users` (the hash itself is never sent).
- **`SECRET_KEY` has no fallback and the app refuses to boot without it.**
- **CORS middleware is gone entirely.** The SPA is same-origin so nothing needed it,
  and the previous `allow_origins=["*"]` + `allow_credentials=True` pairing is one
  the CORS spec requires browsers to reject — it granted nothing and only advertised
  that any origin was welcome to try.

### Self-registration, approval, captcha and rate limiting

- **`POST /api/register` creates a PENDING account** that cannot log in. It takes
  username, password, an optional full name and a captcha — and deliberately NOT
  a role or a region. Letting a registrant pick either would be the rev0.5.0
  escalation with a friendlier label. An admin assigns both at approval.
- **It is not a username oracle.** A taken username returns the SAME sentence as
  a successful registration, because an unauthenticated form that distinguishes
  the two can be queried by anyone with no password at all.
- **`POST /api/users/{id}/approve` and `/tolak` are dedicated endpoints**, not a
  `status` value on `UserUpdate`. Approval is the moment privilege is granted, so
  it gets a route that can be found, guarded and audited on its own. `UserUpdate`
  accepts `AKTIF`/`NONAKTIF` and 400s on anything else. Rejection KEEPS the row as
  `DITOLAK` rather than deleting it — deleting frees the username for immediate
  re-registration.
- **`get_current_user` checks `status`, not just `login()`.** Tokens last 12
  hours, so a suspension enforced only at sign-in leaves the suspended user
  working for the rest of the day. It answers **401**, not 403, because
  `apiFetch` force-logs-out on 401 and treats 403 as an ordinary response.
- **The status check in `login()` comes AFTER password verification**, so it
  cannot become an oracle for which accounts exist and in what state.
- **[api/ratelimit.py](api/ratelimit.py)** — in-process buckets: `login:ip`
  20/5min · `login:user` 10/15min · `register:ip` 5/hr · `captcha:ip` 30/5min. A
  successful login CLEARS its own counters, so a user who mistypes nine times and
  then succeeds is not left one attempt from a captcha for a quarter of an hour.
  `X-Forwarded-For` is honoured only when `TRUSTED_PROXY=1` — behind no proxy the
  header is attacker-supplied and every request could claim a fresh IP.
- **The captcha is PROGRESSIVE and NEVER a lockout.** It appears only once a
  bucket has tripped, signalled by `X-Captcha-Required: 1`. A lockout keyed on
  username is a denial-of-service primitive: anyone who knows a username could
  lock its owner out by failing deliberately.
- **[api/captcha.py](api/captcha.py) is STATELESS** — an HMAC-signed, expiring
  token carrying a salted hash of the answer, rendered as an inline SVG returned
  in the same JSON. A TTL-cache challenge store breaks under `--reload` and
  multi-worker, showing "captcha salah" on a *correct* answer, which is the worst
  failure a captcha can have. Its signing key is DERIVED from `SECRET_KEY` rather
  than reusing it, so a flaw in one does not reach the other. Replay is blocked by
  a bounded consumed-nonce set, checked LAST so a wrong answer does not burn the
  challenge. Alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789` — no `O/0/I/l/1`.
- **`LoginForm.captcha_*` are Optional on the model and enforced in the handler.**
  Required fields would 422 every ordinary login — which is exactly how
  landing.html's sign-in was broken.

Still open: no password expiry, and no persisted audit log of failed attempts
(the rate limiter counts them in memory only).

## Architecture notes that matter

### Schema migrations: `_ensure_schema()`, not Alembic

`models.Base.metadata.create_all()` creates missing *tables* but never ALTERs an existing one. There is no Alembic. **`_ensure_schema()` at the top of [main.py](main.py) is the migration mechanism** — a list of idempotent, `IF NOT EXISTS`-guarded DDL statements run on every boot, each in its own transaction so one failure doesn't roll back the rest.

When adding a column or index to an existing table, add it to `models.py` **and** append the matching statement to that list, or every already-populated database will silently lack it.

### Alat kerja and Model/Type are two levels, and the katalog is the master

There are exactly two levels of tool identity. Conflating them is the mistake
this codebase already made once.

- **Alat kerja** (`kategori_alat`) — the tool TYPE. The authoritative master is
  the client's `modules/KATALOG SFM.xlsx ▸ KATALOG ALAT KERJA` sheet: **103
  rows**, each carrying an `Alat Ukur` and a `Kalibrasi` flag. Three of them
  have no code in the sheet, so `GCL` / `TRK` / `WST` are minted in
  `seed_katalog.py`. `BKC` ("SSPC VIS 3", 39 real assets) is listed there as
  *Tidak Ditemukan* and is seeded from a separate `KATALOG_TAMBAHAN` list —
  104 rows in total.
- **Model/Type** (`alat_varian`) — a specific make and model of that tool, e.g.
  `MILWAUKEE M18 ONEFHIWF34` under `IMP IMPACT WRENCH`.

`seed.py` used to carry an `EXTRA_ALAT_DATA` list of 26 invented codes so the
sparepart catalogue had something to hang off. Most were MODELS — `HTT 220 V`,
`HTT 3 PHASE`, `GEISMAR HTT` and `HTT PORTABLE` are four models of the single
katalog entry `HTT HAND TIE TAMPER` — and four **collided** with a katalog code
meaning something else (`MPR`, `AUK`, `STM`, `MBT`). `EXTRA_ALAT_REMAP` in
`seed_katalog.py` maps every one of them to `(real kode_alat, model name)`; the
katalog wins every collision.

**`kategori_alat.perlu_kalibrasi` gates the Kalibrasi form** — in `view-edit`,
on landing.html's tab strip, and on its "BLM KALIBRASI" badge. A genset is
serviced, not calibrated; offering the form only invites records that cannot
mean anything. It replaced a hardcoded `KALIBRASI_ALAT = {"TGT","TRG","USM","RFD"}`
set, which was a guess made when the master held nine tools.

### The Model/Type spec block is the Rekap template, not free columns

`Rekap Spek RAMCES.docx` fixes the block at seven rows: **Merk, Model/Type, and
five FREE-FORM `Spesifikasi Utama` rows** whose labels differ per tool — "Max.
Torque" on an impact wrench, "Runtime" on a work light, "Cutting Wheel" on a
rail saw. That is why `alat_varian` stores `spek1_label`/`spek1_nilai` … pairs
rather than named columns.

`kapasitas` / `daya` / `dimensi` / `berat` still exist in the table **only** so
the one-off backfill in `_ensure_schema()` can fold them into the first four
slots. Nothing writes or renders them. Do not add a consumer.

- `_varian_payload()` in [main.py](main.py) is the ONE shape for a model: it
  collapses the five slots into `spesifikasi: [{label, nilai}]`, precomputes
  `judul` ("[MERK] [MODEL/TYPE]", max 50 chars — the Rekap's own rule) and
  resolves each attachment to a single URL. `GET /api/master/varian`, the create
  response and `get_public_aset` all go through it.
- `renderSpekCard()` in [js/views/spektek.js](js/views/spektek.js) is the ONE
  renderer, shared by landing.html, the Form Pemeliharaan header and the asset
  detail screen. landing.html imports no other `js/` file specifically so this
  block cannot drift between the QR card and the SPA.
- **`merk` and `tipe_model` are required on create/update.** 49 of the 87
  seeded models have no Merk — they are bare rows the asset importer created
  from the workbook's free-text `Model` column, and they render as visibly
  incomplete on purpose.

**Photos are public; documents are not.** landing.html is reached by scanning a
QR code with no session, so `GET /uploads/foto_alat/{file}` is unauthenticated —
which is why photos live in their own directory. `Spek Lengkap` and `Manual
Instruction` go to `uploads/dokumen_alat/` and are Bearer-authenticated like
calibration certificates. Related: the catch-all static route now **refuses the
whole `uploads/` tree**; before that, a certificate uploaded as `.jpg` was
readable at `/uploads/sertifikat/<name>` with no token.

### Documents belong to the ALAT KERJA, and models inherit them

The client files its 20 spektek PDFs and 5 manual books against tool TYPES, not
against models. Three facts follow, and none of them fit `alat_varian`:

- one file covers FOUR tools (`Spektek Genset, Pompa Air, Shear Wrench dan Impact
  Wrench.pdf`), another covers three;
- several cover tools with no Model/Type row at all;
- 49 of the 87 seeded models are bare rows the importer created from a free-text
  column, so anything hanging only off a model would show nothing for them.

So `kategori_alat` carries `url_spek` / `file_spek` / `url_manual` / `file_manual`
too, and **`_varian_payload()` falls back to them** when a model has neither of its
own, flagging the result `spek_from_katalog` / `manual_from_katalog`.
`renderSpekCard()` labels those `(umum)` with a sentence explaining it — a document
that describes a tool type must never be presented as the exact machine's spec.

`seeds/dokumen.py` holds the one mapping table from filename → `kode_alat` list. It
is corroborated by the katalog's own `kelompok` column: all 13 `JEMBATAN`-tagged
codes are covered and 10 of the 11 `FASILITAS` ones (`MLP` has no file in the drop).
33 attachments across 27 tool types; `seeds/verify.py` asserts every mapped code
exists.

### `dokumen_alat`: a tool can have more than one document

`kategori_alat.file_spek` / `file_manual` are ONE column each, and the client's
drop does not fit in one. `AMB`, `IMP` and `LMP` are each covered by TWO spektek
PDFs, and the seeder wrote both to the same column in table order — so the second
silently overwrote the first and 5.6 MB sat in `uploads/dokumen_alat/` reachable
by nothing:

    3,659,815 B  spektek_AMB_spektek-alat-uji-beton.pdf
    1,075,277 B  spektek_LMP_lampu-penerangan-spektek.pdf
      858,303 B  spektek_IMP_spektek-impact-wrench-milwawkee.pdf

Every existing check passed while this was true: the files were copied, the codes
existed, the attachment count was met. Only asking the question **from the disk
side** finds it, which is what `seeds/verify.py` and `tools/verify/coverage.py`
now do — the assertion is "every file in `uploads/dokumen_alat/` is reachable
from a row", and it is 33 → 33 → 0 orphans.

- **[models.py](models.py) `DokumenAlat`** — `(kode_alat, jenis SPEK|MANUAL,
  nama_file, judul, kelompok, utama)`. **DECLARED in models.py on purpose**:
  `manage.py reset` drops via `Base.metadata.drop_all`, which only knows about
  declared tables, so a raw-DDL-only table survives the drop and then collides
  with the recreate on the very next boot. `_ensure_schema()` adds only what
  `create_all` cannot express — the `jenis` CHECK and the partial unique index
  that makes "exactly one primary document per (tool, kind)" a database fact.
- **`kategori_alat.file_spek` STAYS**, holding the `utama=True` row. That is what
  keeps `_varian_payload()`'s tool-type fallback and landing.html's spec card
  working unchanged — this was an additive change, not a rewrite of the one
  payload shape every screen shares.
- **`dokumen_payload()` in [api/master.py](api/master.py)** is the one shape, SPEK
  before MANUAL and primary first. `/api/master/varian` eager-loads the collection
  with a `selectinload` — ONE extra query for 87 models, not 87.
- **`get_public_aset` returns `dokumen` at the TOP LEVEL**, outside
  `spesifikasi`. 49 of the 87 seeded models are bare rows and many assets resolve
  to no model at all, and those are exactly the machines whose only documentation
  is the tool-type spektek. Hanging the list off the model would have hidden it
  from the technicians most likely to need it — `renderSpekCard()` therefore takes
  an `opts.dokumen` and renders a documents-only card when `spec` is null.

`ALLOWED_DOK_EXT` is wider than `ALLOWED_CERT_EXT` because the drop includes a
`.docx` SOP, which the certificate allowlist ingested happily and then refused to
serve with a 400.

### The `lokasi` hierarchy is encoded in IDs, not in a `parent_id` column

The `lokasi` table is flat. A UPT/resort's parent is derived from its ID string: `JR1.3` → DAOP `D1`, `JRIII.7` → DIVRE `VIII` (roman numerals remap: I→VI, II→VII, III→VIII, IV→VIV), `BY1A` → Balaiyasa `BY1`.

**The resort tree has TWO branches: `JR` (jalan rel) and `JB` (jembatan).** All
three parsers matched `^JR` only, so every one of the 38 JB resorts in the
katalog resolved to *no parent* — putting their assets (253 of them) outside
every regional filter, scope check and dashboard bucket while looking perfectly
fine in the master table. The regexes are now `^J[RB]`, and the dot is optional
on the roman branch because the katalog's `JBII` ("JB II Padang") carries no
sub-number.

This rule is **duplicated in FOUR places** that must stay in sync, and
`tools/verify/test_parent.py` asserts all four agree on 273 codes:
- `get_parent_lokasi_code()` in [api/deps.py](api/deps.py) — the server's copy
- `get_parent_lokasi_code()` in [seeds/katalog.py](seeds/katalog.py) — the seed's
- `getParentLokasiCode()` in [js/core.js](js/core.js) — the SPA's
- `getParentLokasiCode()` in [landing.html](landing.html) — the QR page declares
  its own, because it loads no `js/` file that could supply one

`seed_all()` asserts the whole tree on every run via `verify_upt_parents()`:
each of the 240 katalog UPT codes must resolve to the parent the sheet names.
That check exists because the missing JB branch was invisible for exactly as
long as nobody compared the two.

Never filter regions with `LIKE 'D1%'` — it fails to match `JR1.3` and `LIKE 'VI%'` over-matches VI/VII/VIII/VIV. Use `resolve_lokasi_scope()`, which returns the explicit set of covered `id_lokasi` values for an `IN ()`.

`short_lokasi_label()` is deliberately the *only* place location display strings are formed. It stays **JR-only** on purpose: it strips the prefix, and the two branches reuse the same numbering — "JR 1.1 Jakartakota" and "JB 1.1 Tanah Abang" are different places, so a jembatan resort keeps its letter.

### Balaiyasa is a workshop, never a reporting region

An asset visits a Balaiyasa for repair but is never *based* at one, and a repair carried out there still belongs to the DAOP/DIVRE that owns the asset. Five things enforce this and all five must hold:

- [seeds/dummy.py](seeds/dummy.py) writes every `RiwayatKondisi.id_lokasi` with the asset's `home_lokasi`, never the workshop it was mutated to. The `RiwayatMutasi` rows still record the physical trip.
- `POST /api/perbaikan` in [main.py](main.py) rewrites a workshop `id_lokasi` to `resolve_home_lokasi()` before inserting.
- `get_aset_perbaikan_dashboard()` drops `balaiyasa_lokasi_ids()` from its resort buckets unless the user explicitly scoped *to* a Balaiyasa.
- The same function's `sedang` count and `workshop_list` scope by `home_lokasi_expr` — `resolve_home_lokasi()` expressed in SQL — not by the raw `aset.id_lokasi`. Scoping those by current position deleted a machine from its own DAOP's under-repair count the moment it was sent to a workshop. They are still *grouped* by current position, so the row shows where the machine physically is; keeping the filter and the grouping in step is what preserves `sedang == sum(workshop_list[].jumlah)`.
- `assert_aset_region_scope()` resolves the home location before applying an `ADMIN_WILAYAH`'s regional limit, so a region is never locked out of the assets it has itself sent for repair — including recalling them.

Attributing a repair to the workshop is what used to grow a "BALAIYASA …" row in Laporan Perbaikan and drop the completion outside the owning DAOP's scope. The reconciling identity is `masuk == selesai + diafkir + sedang`, and it holds exactly on "Semua Tahun"; for a single year it cannot, because `sedang` is deliberately a point-in-time count of currently-TSO assets rather than a year-scoped one.

### One matcher for search, filters and card labels

All searching is client-side over in-memory arrays; there is no `q=` parameter anywhere in [main.py](main.py). [js/search.js](js/search.js) is that single search block (`getParentLokasiCode` itself lives in [js/core.js](js/core.js)):

- `assetLokasiIdentity(item)` — the **only** place an asset's location is decided (`{uptCode, parentCode, uptName, parentName}`), preferring the asset's *home* over its current position. Cards, search, filters, sort and grouping all call it, so a label printed on a card is by construction findable by searching that string.
- `lokasiMatchesTerm()` — understands three term shapes: a region label (`"DAOP 1"` → exact code-set membership, so DAOP 10 is excluded), a bare code (`"D1"` → exact equality), or free text (substring over **names only**; substring over codes is what lets `D1` hit `D10`).
- `assetMatchesSearch(item, term, extra)` — location via the above, everything else plain substring. `extra` lets a view add its own fields.
- `canonicalPengadaan()` / `_pengadaanMatches()` — collapse every stored spelling (`DAOP/DIVRE`, `DAOP / DIVRE`, `DIVRE`, `"2"`) onto two constants and compare exactly.

Do not add an unanchored `includes()` against a location name; that is the bug class this block exists to prevent.

### Asset IDs are composite and parsed on both sides

Format: `<urutan>.<kode_alat>.<pengadaan>.<yy>.<peruntukan>.<lokasi>` — e.g. `6.RGM.1.24.A.D1`. Generated in `create_aset()` in [main.py](main.py); decoded by `decodeAsetId()` in [js/search.js](js/search.js) and again in [landing.html](landing.html). A legacy dash-separated form (`RGM-24-A-D1`) is still parsed. `peruntukan` codes: A=JALAN REL, B=JEMBATAN, C=MEKANIK, D=BALAIYASA. The location segment may itself contain dots (`JR1.1`), so decoders re-join the tail.

### The UPT code prefix IS the peruntukan

Verified 1:1 across all 254 rows of the client's `KATALOG UPT`, and the asset
importer derives it that way: `JR` → JALAN REL, `JB` → JEMBATAN, `ME` → MEKANIK.
`BY*` is a Balaiyasa workshop, not an operating unit.

It is a **CREATION-TIME rule, not a permanent invariant**. Peruntukan is what the
machine is FOR; a jalan rel tamper lent to a jembatan resort is still a jalan rel
tamper, and `mutasi` moves `id_lokasi` without touching `peruntukan` or the
composite id. `seeds/verify.py` therefore checks it only over assets with **no
mutation history** — asking for agreement everywhere would assert something the
application itself does not maintain, and would start failing the first time
anyone used the transfer form.

Three consequences:

- **`applyUptSelect(locCode, el, peruntukan)` in [js/core.js](js/core.js) filters
  the option list.** With JALAN REL + DAOP 1 it used to offer 31 options — 25 JR,
  4 JB, 2 ME — so six of them produced an asset whose `id_aset` peruntukan segment
  contradicted the resort named in the same id. Omitting the third argument keeps
  the old unfiltered behaviour, which is what the Kalibrasi and Mutasi forms want:
  they pick where a machine IS, not what it is for.
- **`kdakSyncUpt(which)` in [js/views/kdak.js](js/views/kdak.js) is wired to BOTH
  inputs** — the peruntukan radio and the region select. Wiring only the region
  would make the filter apply in one order of use and not the other. On opening
  the edit form, an asset's stored UPT is re-selected only if the filter still
  offers it; when it does not, it is dropped rather than forced back in, so saving
  corrects the row instead of preserving the contradiction.
- **A pair with no resorts shows a real empty state**, not an empty dropdown. Every
  DAOP/DIVRE happens to have all three resort types today, so the reachable case
  is BALAIYASA under a DAOP parent.

Keep in step: `UPT_PREFIX_BY_PERUNTUKAN` in js/core.js, `UPT_PREFIX_TO_LETTER` in
seeds/dummy.py, and `normalise_peruntukan()` in api/deps.py.

### `peruntukan` and `sumber_pengadaan` are closed sets, and they are load-bearing

Both are baked into the asset's composite primary key, so a bad value is not a display bug — it is a malformed PK that cannot be corrected later without rewriting every child row. `normalise_peruntukan()` and `normalise_sumber_pengadaan()` in [main.py](main.py) are the only accepted way in, and both raise 400 rather than guessing.

They replaced two silent fallbacks: `peruntukan_map.get(value, "X")` minted an ID segment no decoder maps and that every peruntukan filter skips, and `1 if value == "PUSAT" else 2` turned *anything* unrecognised into DAOP/DIVRE. An unchecked radio in the Kelola Data Alat Kerja edit form submitted `""` and hit both.

Relatedly, `AsetUpdate` leaves `id_varian` and `nomor_seri` optional, so `update_aset()` distinguishes "absent" from "explicitly null" via `model_fields_set` — a payload that does not mention them leaves them alone. Omitting them used to null both out, and the KDAK edit form sent exactly such a payload, so every edit there destroyed the asset's specification and serial number. Both KDAK forms now EDIT those two fields (step "1b. Model/Type" plus Nomor Seri) and send them explicitly on every submit, so clearing a field actually clears it.

The sequence number in the ID comes from `max(urutan) + 1`, never a row count: with `count + 1`, deleting any asset of that `kode_alat` made the next create reuse a live number and fail the collision check permanently, since each retry recomputed the same count.

### Asset status

`aset.status_terakhir` ∈ `SO` (siap operasi) / `TSO` (tidak siap operasi) / `AFKIR` (written off). There is no `is_afkir` boolean — afkir is a status value, and nearly every asset query filters `!= "AFKIR"`. Every status change also appends a `RiwayatKondisi` row; the asset row is a denormalized cache of the latest one.

### Inventory is an append-only ledger

`sparepart_stok` holds one row per movement, never a running balance. `SparePartStok.GERAKAN_MASUK` / `GERAKAN_KELUAR` in [models.py](models.py) are the single source of truth for which movement types add vs. remove stock; net stock and stock value are computed by `_net_stok_expr()` / `_nilai_stok_expr()` in [main.py](main.py). Don't compute stock any other way.

`gudang` (warehouse) is intentionally flat and **independent** of the DAOP/UPT `lokasi` tree. **`id_gudang` is the pool every balance is scoped by** — the movement form, the opening balance on part creation, and both halves of a transfer all write it. `id_lokasi`/`site_from`/`site_to` are older region-tree fields kept only so existing transfer history keeps rendering; writing an opening balance against `id_lokasi` alone makes the stock invisible to every warehouse-scoped screen and impossible to issue.

The end-to-end flow is **gudang → kategori → sparepart → pergerakan → stok**, and it is ordered: with no warehouse, the movement form has nothing to write to and refuses every submit. Gudang CRUD lives in two places on purpose — **Pusat Data ▸ Gudang** for management, and a shortcut modal inside Kelola Inventaris so the flow can be completed without leaving the view.

### A repair consumes parts in ONE transaction

`pemakaian_sparepart` links a repair (`riwayat_kondisi`) to the parts it used.
It is written only by `catat_perbaikan()`, from a `pemakaian: [...]` array that
rides on the **same** `POST /api/perbaikan` body as the condition report.

Everything about that is deliberate:

- **One transaction, one commit.** A short stock rolls the condition report
  back rather than recording a repair that consumed nothing — and equally, a
  failed report cannot have already taken parts out of the warehouse. The
  `db.flush()` inside `_record_pemakaian()` is what makes it possible:
  `id_riwayat` is a serial and does not exist until the INSERT is issued.
- **Quantities are summed per (part, gudang) BEFORE the check.** Two lines for
  the same part in one submit must be checked against their combined total;
  checking them one at a time would let 2 × 6 units pass against a stock of 10.
- **It never computes stock.** Each row points at the `OUT` movement it wrote
  via `id_stok`; `sparepart_stok` stays the single source of truth. Sufficiency
  is checked with the same `_net_stok_map()` the standalone movement endpoint
  uses, not a second implementation.
- **Broadcast both** `REFRESH_ASSET_LIST` **and** `REFRESH_INVENTARIS` — the
  ledger changed, and inventory clients otherwise never learn.

`sparepart.id_varian` is the compatibility link. **NULL means "fits every model
of this tool"**, which is the common case, so
`/api/inventaris/parts?kode_alat=&id_varian=` returns model-specific parts *plus*
the universal ones. The seed only sets `id_varian` where an old catalogue code
named one of SEVERAL competing models of the same tool (the HTT family);
claiming model-specificity elsewhere made the picker return nothing at all for
almost every real asset, because real assets carry Rekap/import models while the
catalogue was pinned to the remapped legacy ones. When the strict filter does
match nothing, the form says so and offers an explicit "Tampilkan semua
sparepart" — never a silent widening.

`f_masuk` in `_scoped_repair_events()` counts entries INTO the down state
(`kondisi='TSO' AND prev IS DISTINCT FROM 'TSO'`), not every TSO row. It was
the latter, which quietly broke `masuk == selesai + diafkir + sedang` the moment
anyone filed a second fault report on a machine that was still down — an
ordinary thing to do, and one that recording sparepart usage makes routine.

### Auth and roles

JWT bearer tokens (12h expiry), bcrypt password hashes. **FIVE roles**, enforced via the `require_role([...])` dependency factory — the tuple is `ROLES` in [api/deps.py](api/deps.py):

- `SUPER_ADMIN` — everything, including master data CRUD, afkir/pulihkan, and user deletion
- `ADMIN_WILAYAH` — scoped to its own `id_lokasi`; can only create `TEKNISI` accounts and only mutate/transfer assets in its own region. `require_role` cannot express this, so it is enforced inline by **`assert_region_scope()` / `assert_aset_region_scope()`** — use those, never a bare `==`. A token only ever carries a *parent* code (`D1`, `VIII`, `BY1`), because the login region selector lists DAOP/DIVRE/BALAIYASA rows and excludes UPTs, while assets live at UPT codes like `JR1.7`. Comparing the two directly rejected an admin's own assets **and** left the paths that had no check at all writable from any region; both directions are now one helper built on `resolve_lokasi_scope()`. It guards create/edit/delete/mutasi/kondisi/kalibrasi; `TEKNISI` is deliberately left unscoped for condition reporting.
- `TEKNISI` — read plus condition reporting. Deliberately UNSCOPED for condition
  reporting: filing a machine as broken is the one thing a technician does
  standing next to it, and a region check there blocks the report, not the mistake
- `PETUGAS_GUDANG` — the warehouse. The only non-admin who may move stock
- `PIMPINAN` — read-only, plus Proses Laporan. Writes nothing at all

**Role checks are ALLOW-LISTS, never `!= "TEKNISI"`.** The negative form silently
admits every role added after it is written, and two were added.

On the client, `NAV_ACCESS` / `VIEW_ACCESS` / `WRITE_ACCESS` in [js/core.js](js/core.js)
are the ONE description of who sees what; `applyRoleGating()` and the guard at the
top of `switchView()` in [js/shell.js](js/shell.js) are the only consumers. Gating
the sidebar alone was never enough — 34 template-string `onclick=` handlers call
`switchView()` directly. It is convenience, not control: the server is the
enforcement.

The frontend stores the token in `sessionStorage` and reads role/`id_lokasi` straight out of the JWT payload client-side (`getJwtPayload`) for UI gating — server-side checks are the real enforcement.

### Live updates: WebSocket broadcast, string messages

**`landing.html` opens the same socket.** Presence lives in `ConnectionManager`
and is keyed off the WebSocket, so a page that never opens one has invisible
users. The QR card page connects once signed in, sends `view:Kartu Aset (QR)`,
and shows a dot in its header; an anonymous scan deliberately does not connect,
so it never registers presence. Any future page that a logged-in user can sit on
needs the same treatment or its users read as offline.


`/ws/updates?token=<jwt>` (token rides as a query param because the browser WebSocket API can't set headers). The `ConnectionManager` also doubles as the presence registry — sockets keyed by username, a set per user so multiple tabs count as one online user. `pengguna.last_seen`/`last_view` is what remains after the socket closes.

Broadcasts are three bare strings: `REFRESH_ASSET_LIST`, `REFRESH_INVENTARIS`, `REFRESH_PRESENCE`. **Any endpoint that mutates data must `await manager.broadcast(...)` after commit** — that is the only way connected clients learn about the change. Handlers that broadcast must be `async def`.

The client reconnects with exponential backoff + jitter and falls back to periodic polling while the socket is down (`startPollingFallback`); the WS scheme is derived from `window.location.protocol`, never from tunnel config, so it works behind TLS-terminating tunnels.

### Frontend conventions

No modules, no bundler. The seventeen files in [js/](js/) share one global scope and hold top-level functions plus mutable state (`db`, `lokasiData`, `uptDatabase`, `authToken`, …) declared in [js/core.js](js/core.js); the `onclick=` handlers generated inside template strings resolve against the global scope, so cross-file callers reach functions via explicit `window.foo = foo` exports. Libraries come from CDN `<script>` tags in [index.html](index.html): Tailwind (config inline in the head), Chart.js, SheetJS (`xlsx`), jsPDF + autotable, qrcodejs, Font Awesome. Excel/PDF export is done **client-side**; the `/api/export/*` endpoints only return JSON rows.

Views are `.view-section` divs toggled by `switchView(viewId)` via an `is-visible` class — all views live in the DOM simultaneously, so code frequently guards work with `document.getElementById(id)?.classList.contains("is-visible")`. Dark mode is a `dark` class on `<html>` persisted in `localStorage`.

All authenticated calls go through `apiFetch(endpoint, options)`, which injects the bearer token, drives the global loading overlay (skip it with `{ background: true }`), and force-logs-out on 401. Unauthenticated master-data calls use raw `fetch`. `apiAuth()` in [landing.html](landing.html) is the same contract for that page.

**`apiFetch` only *throws* on 401.** A 400/403/404 arrives as an ordinary response, so every mutation must check `if (!res.ok)` explicitly — otherwise a rejected submit reports success and closes the form.

Both `apiFetch` and `apiAuth` deliberately skip the JSON `Content-Type` for `FormData` and `URLSearchParams` bodies, because only the browser knows a multipart boundary. Certificate uploads depend on that.

### Modal accessibility lives in one file, not in the markup

There are **34** modal roots in [index.html](index.html) — a full-screen backdrop `div` whose id ends `-modal` and which carries `fixed inset-0`, shown by removing a `hidden` class. (A `[id$="-modal"]` selector counts 60; the other 27 are `close-*-modal` and `inv-btn-open-*-modal` **buttons**. Filter on the classes, not the id alone.)

[js/a11y-modal.js](js/a11y-modal.js) gives all of them dialog semantics at runtime: `role="dialog"`, `aria-modal`, and an `aria-labelledby` pointed at the panel's own heading; Esc to close; a Tab/Shift-Tab trap plus a `focusin` backstop; focus moved into the dialog on open and handed back to the opener on close. A `MutationObserver` on `class` drives open/close detection and picks up modals that views build from template strings later.

Two things must not be undone:

- **Esc closes through the dialog's own close control** (`#close-<id>`, then `[data-modal-close]`, then a `button[id$="-cancel"]`), never by setting `hidden` directly. `customConfirm()` resolves its promise from the button handler, so hiding the panel behind its back leaves every awaiting caller hanging forever.
- **Closing a stacked dialog returns focus to the dialog underneath**, not to the original opener — `customConfirm()` over an open form is the common case, and hiding the panel that held focus otherwise drops the user on `<body>`, which fires no `focusin` for the trap to correct.

The whole file is an IIFE, so it adds no top-level identifier to the shared global scope beyond `window.closeModalA11y` and `window.a11yModalCount()`.

### Dashboard filters live PER TAB, not above the tabs

There used to be one filter bar (`Semua Alat Kerja / Pengadaan / Tahun`) above all
six tabs, and three of them ignored it: Tren Perbaikan had its own year picker, and
Laporan Perbaikan and Kurva MCF have their own Lokasi + Tahun row. A control that
visibly applies to half the screen is worse than none, because nothing says which
half. The four-swatch *Keterangan* legend beside it described MATRIX CELL colours, so
on five of six panels it explained something that was not on screen.

Both now live per panel:

- `_dashFilters[tabId]` — each tab holds its **own** selection. Narrowing Grafik
  Ketersediaan to one tool leaves Matriks Kesiapan untouched.
- `_DASH_FILTER_SPEC` — one declarative entry per tab (`fields`, `legend`,
  `tahunAllLabel`). Adding a filter is a line here, never markup in index.html.
- `_renderDashFilterRow(tabId)` — the single builder, mounted into
  `#dash-filters-<tab>`. It rebuilds on every render because the year counts change
  whenever the asset list is refetched, and it wires its handlers by delegation on
  the row so re-rendering cannot multiply listeners.
- Only the **active** tab's row is rebuilt; the others keep their DOM and selection.
- `trend` sets `tahunAllLabel: null` — the chart plots twelve months of ONE year, so
  an all-years option is a selection it cannot honour. It used to accept one and
  silently substitute the current calendar year, which read as the filter being
  ignored.
- The KPI strip sits above the tabs but follows the **active** tab's filter, so
  `#dash-kpi-scope` states what it is counting. On `perbaikan` / `mcf` — which filter
  by Lokasi, not by tool — it falls back to fleet totals and says so.

### Year dropdowns: only years that hold data, each with its count

The client's rule, applied to all eight year pickers in the app:

    2026 (326)      2025 (729)      2024 (66)

What it replaced walked from the oldest year present to the current one and printed
every gap as a selectable `2019 (kosong)`. `fillYearSelect()` in
[js/views/sort-modals.js](js/views/sort-modals.js) is the single implementation:

- options come only from the counts map, newest first;
- the **currently selected** value is always kept even at zero (rendered `(0)`), so a
  refetch can never silently reset a filter the user set;
- `selectedIndex < 0` is corrected to 0, which is what used to leave a blank box;
- counts are scoped to the CALLING menu's rows, so the number beside a year in
  Pantau Riwayat is history rows and in Pulihkan Aset Afkir is scrapped assets.

The two server-driven pickers match: `available_years` on
`/api/aset/dashboard/perbaikan` and `/mcf` returns `[{tahun, jumlah}]` from
`_repair_year_counts()`, and `syncTahunOptions()` prints the same shape.

### The dashboard tab strip is a fixed list in two places

`_DASH_TABS` in [js/views/dashboard.js](js/views/dashboard.js) is index-aligned
with the `.dash-tab-btn` buttons, the `.dash-panel` ids (`dash-panel-<id>`) and
the `.dash-dot` markers in [index.html](index.html). Adding a tab means touching
all four, plus the dispatch in `_renderDashActivePanel()`.

`perbaikan` and `mcf` are both filled by the single `load()` in
[js/views/repair-dashboard.js](js/views/repair-dashboard.js), so activating
either one calls `initRepairDashboard()`. They carry separate Lokasi/Tahun rows
(`rd-*` and `rd-mcf-*`) but **one copy of the state** — `LOKASI_SELECTS` /
`TAHUN_SELECTS` keep both rows displaying it. Never give a second row its own
state variable; switching tabs would then appear to change the filter.

### Mobile is a first-class target now

The app was designed at desktop width and allowed to shrink. The audit found 24
tables, 20 horizontal scrollers and not one column-priority rule anywhere in
index.html: a technician on a phone got a 240-column matrix to pan across and a
drawer as the only way to change screen. Four primitives fixed that; all live in
[assets/style.css](assets/style.css) under `MOBILE FIRST`.

- **`.table-stack`** — under 640px each `<tr>` becomes a card and each `<td>` prints
  its caption from `data-label`. **Do not write `data-label` by hand.**
  `stampTableLabels()` in [js/core.js](js/core.js) copies the captions down from the
  table's own `<thead>` at runtime and a `MutationObserver` re-runs it whenever a
  view replaces its rows — 23 tables, several hundred cells built inside template
  strings, and no second copy to keep in step. A table with no header row opts itself
  back out, because an unlabelled stack is less readable than the scrolling table it
  replaced. The dashboard matrix is deliberately excluded: its columns ARE the data.
  Scroll wrappers carry `.table-stack-wrap` so they stop scrolling once stacked.
- **`#mobile-bottom-nav`** — five slots under `lg:`. The middle one is a raised
  primary action rather than a fifth destination, because reporting a machine's
  condition is the one thing a technician does standing next to it and it was four
  taps deep behind the drawer. `syncBottomNav()` is driven from `switchView()`, not
  from the click, so arriving any other way still lights the right slot.
  `#view-container` gets bottom padding to clear the bar plus the safe-area inset.
- **Touch targets** — a `@media (pointer: coarse)` block gives buttons, selects and
  tabs a 44px minimum. Dense table-row buttons get an expanded transparent hit area
  instead, so a list does not double in height.
- **Contrast** — `text-gray-400` on white is 2.8:1 and was the app's default for
  field labels. It is remapped onto a token that passes 4.5:1.

### The bell is a real feed, not decoration

It carried a hardcoded red dot and no click handler — it permanently claimed unread
news that did not exist and could not be dismissed. It now shows the WebSocket
broadcasts this session received (`REFRESH_ASSET_LIST` / `REFRESH_INVENTARIS` /
`REFRESH_PRESENCE`), which the app was already acting on invisibly. `pushActivity()`
in [js/shell.js](js/shell.js) is called from `ws.onmessage` before the dispatch.

Session-scoped on purpose: there is no notifications table, and inventing one means
deciding what "read" means per user across devices. The durable record is Pantau
Riwayat Aset, which the panel footer points at.

### Styling: use the component layer

[assets/style.css](assets/style.css) defines design tokens (`--surface`, `--border`, `--text`, …, redefined under `.dark`) and a component layer: `.card` / `.card-head` / `.card-body`, `.stat-card`, `.btn` + `.btn-primary|accent|ghost|danger|success`, `.btn-icon`, `.badge` + `.badge-so|tso|afkir|move|warn|info|neutral`, `.modal-backdrop` / `.modal-panel` / `.modal-head|body|foot`, `.toolbar`, `.table-std`, `.tab`, `.empty-state`, `.def-grid`, `.filter-section`, `.file-drop`.

Added in rev0.5.1, each replacing something that had been hand-rolled two or
three times:

- **`.segmented` / `.segmented-btn` / `.is-active`** — the mode switches. Drive
  it with `setSegmented(ids, activeId)` in [js/core.js](js/core.js); it keeps
  `aria-selected` in step, which the Tailwind-array versions never did.
- **`.chip-row` / `.chip` / `.chip-x` / `.chip-clear`** — active filter state.
  Distinct from `.filter-chip`, which is the "N filter aktif" counter on a
  collapsed `<details>` in Laporan and stays as it is.
- **`.step` / `.step-title` / `.id-preview`** — the KDAK stepper. The step number
  comes from `data-step`, so `1b` works.
- **`.skeleton-text|-sm|-lg` / `.skeleton-card` / `.skeleton-row`** — sized
  variants over the existing `.skeleton`.
- **`.table-timeline`** — turns `.table-stack` rows into a timeline under 640px.
- **`#exp-actions`** (sticky export bar) and the `#view-database.is-compact` /
  `#view-masterdata.is-drilled` view-scoped state classes.

**Status badges go through `.badge` — never inline Tailwind.** Twenty spans in [js/views/aset.js](js/views/aset.js), [js/views/kdak.js](js/views/kdak.js) and [js/views/afkir.js](js/views/afkir.js) hand-rolled the same six colour pairs, and the muted one drifted to `#6b7280` on `#374151` — 2.31:1, unreadable in dark mode at 10px bold. `.badge` is a pixel-exact match for the string they used, so the conversion moved nothing visually. `.badge-afkir` is red (the app has always drawn AFKIR red; it used to share the grey `.badge-neutral` rule, which disagreed with every screen) and `.badge-move` is the orange "SEDANG TERMUTASI" state, kept distinct from amber `.badge-warn` because the two appear on the same card.

Prefer these over hand-written inline Tailwind for new markup. The pre-existing screens are still largely inline Tailwind; that inconsistency is exactly what the layer exists to retire, and SO/TSO colours in particular are now defined **once** here rather than in three drifting copies.

### Role gating in the UI must be set, not just cleared

`checkAuth()` in [js/shell.js](js/shell.js) decides which menu items a role sees.
It must set the state of **every** gated item in **both** directions —
`classList.toggle("hidden", role !== …)` — never just remove `hidden` for the
privileged role. It previously only un-hid Pusat Data / Pulihkan Aset Afkir for
`SUPER_ADMIN` and nothing ever put them back, so any role change that did not
reload the document left the higher role's menu on screen. `forceLogout(false)`
— the 401 path inside `apiFetch` — is exactly that: a token expiring under a
super admin, then a technician logging in at the same workstation, and both
admin screens still listed. The server answered 403 behind them, so it was never
an escalation, but the menu contradicted the permissions.

The same function only opens the sidebar when `innerWidth >= 1024`. It used to
call `toggleSidebar()` unconditionally, which on a phone slid the drawer over
the dashboard the user had just logged in to see.

### Theme resolution

A stored `localStorage.theme` always wins; with nothing stored the app follows
`prefers-color-scheme`, and keeps following it live until the user picks. The
same block is duplicated at the top of [landing.html](landing.html) on purpose —
the two pages share `sessionStorage` and a technician crosses between them
mid-task, so a theme that flipped on the way across would read as a bug.

### Uploads

Calibration certificates are stored under `uploads/sertifikat/` with a server-generated filename (never a client-supplied path — see `_save_certificate()`), and `riwayat_kalibrasi.file_sertifikat` holds only that basename. The `uploads/` directory is gitignored runtime data.

The flow is deliberately **two-step**: `POST /api/kalibrasi` creates the record and returns `id_kalibrasi`, then `POST /api/kalibrasi/{id}/sertifikat` attaches the file as `FormData`. Both `#form-kalib` handlers (index.html and landing.html) capture the create response for exactly this reason.

Download is Bearer-authenticated, so a plain `<a href>` 401s — go through `apiFetch` → `res.blob()` → `URL.createObjectURL` (`window.downloadSertifikat`).

### Performance decisions already made

Don't undo these — each was measured.

- **GZip is on** (`GZipMiddleware`, `minimum_size=1000`). It takes `js/` from ~475 KB to ~123 KB and `index.html` from 383 KB to 41 KB. Everything this app serves is text.
- **`Cache-Control` is stamped by a middleware**, not per-route: `no-cache` (revalidate via ETag → cheap 304) for html/js/css, `max-age=31536000, immutable` for images. `/api/` and `/ws/` are excluded. The 304 half needs `file_response_conditional()`: Starlette's `FileResponse` emits an ETag but never *reads* `If-None-Match`, so `/`, `/js/*` and `/landing.html` answered a full 200 on every load while only `/assets/*` (the `StaticFiles` mount, which does check) answered 304. Any new route returning a `FileResponse` for a cacheable file wants that wrapper, which borrows `StaticFiles.is_not_modified` rather than growing a second comparison.
- **SheetJS and jsPDF load on demand**, not in `<head>`. Together they are ~1.3 MB and are only reachable from Laporan, the bulk importers and the QR label. Use `await ensureXLSX()` / `await ensureJsPDF()` at the *entry point* of any new code path that touches them; the many synchronous `XLSX.*` calls downstream need no change. Chart.js stays eager (the dashboard is the first screen after login) but carries `defer`. Tailwind must stay eager — it is a JIT compiler that rewrites the DOM, and deferring it causes a flash of unstyled content.
- **The hero background is WebP at 1600 px (145 KB)**, down from an 8.16 MB PNG. It sits under an 85 %-opacity gradient, so the resolution was never visible. `hero_bg.jpg` is the fallback; there is no PNG any more.
- **`assetLokasiIdentity` and `_eventCount` read `Map` indexes**, not `Array.find`. The Maps (`_uptByCode`, `_lokasiByCode`, `_summaryById`) are rebuilt by `rebuildLokasiIndexes()` / `rebuildSummaryIndex()` wherever their source array is *replaced*. Never mutate those arrays in place without rebuilding, or identities go stale silently rather than crashing.
- **All six search boxes are debounced** at 200 ms via `debounce()` in core.
- **The Model/Type payloads are cached client-side twice** — `_varianCache` in [js/views/aset.js](js/views/aset.js) for the spec card, and `_varianByAlat` in [js/views/masterdata.js](js/views/masterdata.js) for the KDAK dropdowns. `loadAlatVarian()` runs at boot in `checkAuth()`, not lazily from Pusat Data, because the KDAK forms need the index whether or not that screen was ever opened. Both are refreshed on `REFRESH_ASSET_LIST`.
- **The connection pool is configured** in [database.py](database.py) — `pool_size=20, max_overflow=30, pool_pre_ping=True`. The default bare `create_engine()` gave a ceiling of 15 and no pre-ping, which meant random 500s after every PostgreSQL restart.
- **`broadcast()` fans out with `asyncio.gather` and a 2 s per-socket timeout**, and prunes dead sockets. It used to send sequentially with no timeout while being awaited inside every mutating endpoint.
- **`_touch_last_seen` runs via `asyncio.to_thread` and is throttled to 60 s.** It is blocking psycopg2 called from the `async` WebSocket handler on every heartbeat.
- **Two statements in `_ensure_schema()` are existence-guarded** (`ALTER COLUMN … TYPE` and `ADD CONSTRAINT … CHECK`). Both take an `ACCESS EXCLUSIVE` lock and rewrite/rescan the whole `sparepart_stok` table, and `_ensure_schema()` runs at *import* — so unguarded they locked the table on every restart, per worker. Any new statement of that shape needs the same treatment.
- **`status_terakhir` is normalised to upper case by `_ensure_schema()`**, so queries compare it raw. Do not reintroduce `func.upper(...)` on it — that makes both declared indexes unusable and turns the filter into a sequential scan.

## Git

Branch naming is `revX.Y.Z-alpha` / `-beta` (the older `-fe-be` suffix marked
which side changed and is no longer used); work merges to `master`.

**The seeding pipeline is TRACKED** — `manage.py`, `seeds/`, `seed_katalog.py`,
`seed_katalog_sfm.py`, `seed_aset_real.py`. It used to be ignored, and that cost
real review coverage: `seed_katalog.py` was tracked while `seeds/katalog.py` was
not, so gutting the first and rewiring the second showed up in git as exactly
half a change. It is ~2,300 lines with no secrets, it decides whether 1,121 real
assets import correctly, and `manage.py reset` is the most destructive command in
the project — all reasons to review it, not to hide it.

Ignored: `.env`, `modules/` (the client's ~41 MB source drop, a HARD dependency
for seeding), `uploads/`, `sql_backup/`, `temp/`, `*.sql`, and
`tools/verify/_snapshots/`. The harness itself is tracked; its output is not.

## Known gaps

Ranked by what breaks first as the fleet grows.

- **Pagination is transport-only so far.** `/api/aset` and `/api/history/summary` now
  return the `{total, limit, offset, items}` envelope and accept
  `q` / `kode_alat` / `id_lokasi` / `status` / `tahun`; `fetchAllPages()` in
  [js/api.js](js/api.js) walks the pages into `db` with a progress caption. That
  removes the single 4.5 MB / 16 MB response and the stall, but **not the total
  bytes** — the frontend still caches the whole fleet and filters it client-side
  through the one matcher in [js/search.js](js/search.js). The server filters exist
  as a *superset gate* precisely so the deep screens (Kelola Data Aset, Pantau
  Riwayat) can move to server-side paging later without another API change. Doing
  that means teaching those two views to render from a page rather than from `db`.
- **The repair-events window subquery runs four times per dashboard load**
  (`_scoped_repair_events` is a subquery *expression*, re-executed by each of the
  four `db.execute()` calls), and it contains a deliberately unfiltered `LAG` over
  the whole `riwayat_kondisi` table. Wants a materialised CTE or a rollup table.
- **`resolve_home_lokasi()` is still N+1 inside the export loops.** The lokasi table
  itself is cached now, but the `RiwayatMutasi` lookup for an asset sitting at a
  Balaiyasa still fires per asset. Rare in practice; batch it if workshop traffic
  grows.
- **`aset` has a composite string primary key** encoding
  kode/pengadaan/year/peruntukan/lokasi, so editing any of those regenerates the PK
  and rewrites every child row. A surrogate `BIGSERIAL` with `id_aset` as a unique
  business key would make it a single-row update.

- **`index.html` is ~5.9k lines and stays one file.** Splitting it needs a build step
  the project deliberately does not have, and would break both "every view exists in
  the DOM at once" and `inventaris.js`'s eval-time DOM caching.
- **The rate limiter is per-process and in-memory.** Two uvicorn workers keep two
  independent sets of buckets, so `--workers 4` effectively quadruples an
  attacker's budget, and a restart forgets everything. The honest fix is Redis or
  a reverse proxy. It still turns an unbounded online guessing run into a bounded
  one, which is the threat it is actually aimed at.
- **No password expiry, and no PERSISTED audit log of failed attempts** — the
  rate limiter counts them in memory only.
- **Tailwind runs as a CDN JIT compiler in the browser.** Replacing it with a
  compiled stylesheet needs a build step.
- `SparePart` has no `stok_max` column, so `_stok_status()` is always called with
  `stok_max=None` and `"DI ATAS MAX"` is unreachable by construction. It is
  therefore absent from `STOK_STATUS_ORDER` and from `STOK_BANDS`, while the
  branch itself stays in `_stok_status()` documented as reserved.
  **This entry used to claim the tile "has been removed" while only half of it
  had been** — the tile was gone from `STOK_STATUS_META` but the BAND survived,
  so `bandTotals` summed an empty filter and the dashboard chart carried a
  segment, and its legend an entry, reading "Di Atas Maksimum 0 (0.0%)" on every
  load. Fixed in rev0.4.3; `tools/verify/test_rev043.py` now asserts that no
  legend entry is a structural zero.
- `sparepart_kategori` names are matched by exact string on bulk import; there is no
  fuzzy match, and unknown categories are rejected rather than created.

### Closed

- ~~The `dummy` seed step was not idempotent~~ — it had no identity gate at all,
  so every run appended another 100 assets (1121 → 1221 → 1321) while
  `--verify` reported PASS both times. Demo assets now carry a `DEMO-` serial
  stamped at creation, `total_aset` is a TARGET rather than an amount to add, and
  `seeds/verify.py` counts demo and workbook assets **separately** with the
  workbook side an equality — the old check was a deliberately loose
  `expected <= n < expected * 2` range that left room for eleven such runs.
- ~~Three documents, 5.6 MB, were unreachable~~ — `kategori_alat.file_spek` is
  one column and `AMB`, `IMP` and `LMP` each have two, so the second overwrote
  the first. See the `dokumen_alat` section. `tools/verify/coverage.py` now asks
  the question from the DISK side, which is the only direction that finds it.
- ~~The demo generator broke the peruntukan rule~~ — it picked a peruntukan
  letter at random, independently of the resort it had just placed the asset at,
  minting `JALAN REL` machines homed at `JB1.1`. It now derives the letter from
  the resort prefix and redistributes only within the same unit.
- ~~`landing.html`'s sign-in was broken AND a privilege escalation~~ — it posted
  no password against a required field, so every QR-page sign-in 422'd, and it
  offered role/region dropdowns letting the user declare their own privileges.
  Rewritten as username + password + progressive captcha.
- ~~`reset.py --aset N` was a silent no-op~~ — now refused with a message,
  before anything is dropped.
- ~~No rate limiting on `/api/login`~~ — see the authentication section.
- ~~Deleting an asset whose repair consumed spare parts returned 500~~ — fixed;
  `pemakaian_sparepart.id_riwayat` cascades.

- ~~No authentication~~ — implemented; see the authentication section.
- ~~The exports build everything in memory~~ — `export_riwayat` and `export_mutasi`
  are `StreamingResponse` over a row-at-a-time JSON generator (`_stream_json_array` /
  `_stream_json_rows`). The wire format is byte-identical, so no client changed.
- ~~The `lokasi` table is re-read several times per request~~ — `lokasi_rows()` caches
  it as plain named tuples for 60 s, with `balaiyasa_lokasi_ids()` precomputed on the
  same pass and `invalidate_lokasi_cache()` called by the lokasi CRUD endpoints.
  Never cache ORM instances here: they detach when their Session closes.
- ~~Foreign keys have no `ondelete`~~ — `id_pengguna` FKs are `SET NULL` and `id_aset`
  FKs are `CASCADE`, applied by a guarded `DO $$` block in `_ensure_schema()` that
  looks constraint names up rather than hardcoding them.
  `riwayat_kalibrasi.id_pengguna` was made nullable to allow it.
- ~~The seed silently doubled the real fleet~~ — `seed_aset_real()` renumbered on
  sequence collision instead of recognising a row it had already imported, so a
  second `seed.py` run inserted all 1,121 assets again. The database this pass
  started against held **2,242**. `seeds/aset.py` now keys on identity and counts
  duplicates within a bucket; `seeds/verify.py` asserts the total against the
  workbook. Three consecutive runs produce byte-identical counts.
- ~~Modal accessibility~~ — all dialogs carry `role`/`aria-modal`/a label, Esc and the
  focus trap work, and no native `confirm()` remains outside the `customConfirm()`
  fallback.
- ~~Mobile was never designed for~~ — see "Mobile is a first-class target now".

## rev0.5.1 — what it closed

rev0.5.0 left two things on its own honest list; rev0.5.1 is both of them.

**The `api/` package split** and **`tools/check_html.py`** — see the sections
above. The split was verified route-by-route: the sorted `(path, methods)` set,
the shadowing relationships, and `openapi.json` are all identical before and
after, which is what proves no `require_role` guard was lost on the continuation
line of a wrapped decorator.

**Per-view redesign detail**, now done across seven screens:

- **KDAK** — both asset forms are a numbered stepper with a **live `id_aset`
  preview**. The rules in `previewIdAset`/`_kdakReadSegments`
  ([js/views/kdak.js](js/views/kdak.js)) mirror `create_aset`/`update_aset`
  exactly, and the preview was checked against what the server actually mints.
  The sequence number is estimated from `db` on create (`max(urutan)+1`, the
  same rule the server uses) and known exactly on edit, where `update_aset`
  preserves it. Changing a key segment on the edit form raises a warning, since
  it re-parents every child row.
- **Kelola Inventaris** — a flow header stating the ordered chain gudang →
  kategori → sparepart → pergerakan → stok, marking the first incomplete step
  and linking to it. It hides itself once the chain is complete: it is
  scaffolding for an empty system, not permanent chrome. `_flowLedgerTotal` is
  fetched at boot **because `_ledgerTotal` is only populated once the Transaksi
  tab has been opened** — reading that alone made a fully-stocked system report
  its last step as incomplete.
- **Filter chips** — `renderFilterChips()` in
  [js/views/sort-modals.js](js/views/sort-modals.js) is ONE renderer for three
  views. `_sortFilters`, `_afkirSortFilters` and `_kdakSortFilters` are three
  variables holding one shape, so a key added in one place surfaces in all
  three. Plus a persisted density toggle on Kelola Data Aset.
- **Pantau Riwayat** — `.segmented` replaced two near-identical 30-line copies
  (`_setHistoryTab`, `switchDetailTab`) that each swapped six hand-maintained
  Tailwind class arrays; both now call `setSegmented()` in
  [js/core.js](js/core.js). Per-mode `.empty-state`s distinguish "nothing
  recorded" from "nothing matches your filter". `.table-timeline` turns the
  stacked detail rows into a timeline under 640px, matching the Mutasi panel.
- **Proses Laporan** — the Excel/PDF buttons are a sticky bar (`#exp-actions`)
  clearing the mobile nav and the safe-area inset, and it repeats the row count
  because the info strip has long scrolled away by then.
- **Pusat Data** — two-level under `lg:`: the six tabs become a list, and the
  panel appears only once a master is chosen. One `.is-drilled` class; above
  `lg:` the stylesheet ignores it and the desktop layout is untouched. The five
  free-form spec pairs are framed as label/value with real Rekap examples.
- **Skeletons** — `.skeleton` was dead CSS. `skeletonRows()`/`skeletonCards()`
  in core.js paint in-place placeholders and the loaders pass
  `{ background: true }`, so the blanking overlay is left for login, the paged
  fleet bootstrap and destructive submits. A `MutationObserver` clears
  `aria-busy` when the placeholders go, rather than relying on every loader's
  success path remembering to.

### Still not done

- Server-side paging for the deep screens (see Known gaps).
- The repair-events window subquery still runs four times per dashboard load.

## rev0.4.2-alpha — what it closed

Version naming changed here: `revX.Y.Z-alpha` / `-beta`, no `-fe-be` suffix.

1. **`manage.py`** replaced `seed.py` + `reset.py`. The destructive verb is now
   behind a subcommand rather than behind a filename one tab away from the safe
   one, and `--aset` without `--with-history` is refused instead of ignored.
2. **The `dummy` step became idempotent** — see Closed. Its RNG is seeded too, so
   `manage.py reset --with-history` is reproducible; two resets of the same
   database produce the same 100 machines with the same history, which is what
   lets the harness hold a baseline at all.
3. **`dokumen_alat`** made 3 documents (5.6 MB) reachable. See its section.
4. **Self-registration, approval, captcha and rate limiting.** See the
   authentication section. `/api/login` had no rate limiting of any kind.
5. **`landing.html`'s sign-in works**, and no longer asks the user to declare
   their own role and region.
6. **Frontend role gating became declarative** — `NAV_ACCESS` / `VIEW_ACCESS` /
   `WRITE_ACCESS`, plus a guard inside `switchView()` and the `data-write`
   attribute. `PETUGAS_GUDANG` and `PIMPINAN` reached the Pusat Data role select,
   which had offered three of the five roles for a whole release.
7. **The KDAK forms fit.** `max-w-lg` → `max-w-2xl` with `.step-pair` pairing
   steps 2/3 and 5/6 at `sm:` and up: 916px of content in a 737px scroller became
   653px in 661px, so the live `id_aset` preview and step 1 are on screen
   together — which is the entire point of a live preview.
8. **UPT lists are filtered by peruntukan.** See its section.
9. **`.scroll-hint`** — a fade at whichever end of a horizontal strip still has
   content, driven by `wireScrollHints()` in js/core.js. The dashboard tab bar is
   905px in 308px at 390 with `scrollbar-none`: three of its six tabs existed with
   nothing on screen suggesting so. Also applied to the Laporan export tab strip.
10. **`tools/verify/audit.py` distinguishes "scrolls" from "scrolls SILENTLY"**,
    and asserts the `@media (pointer: coarse)` 44px rule from the SOURCE rather
    than measuring rendered boxes — `matchMedia('(pointer: coarse)')` is false
    under headless emulation and cannot be forced, so ~30 reported tap-target
    failures were an artifact of the harness every single run.
11. **`customConfirm()` takes an options object** (`{title, message, confirmText,
    danger, html}`) as well as a plain string. Approving a registration needs a
    role and a region chosen at the moment of approval, and a second bespoke modal
    for one two-field question is how a codebase ends up with five dialogs that
    behave differently. It still resolves from the button handlers, which
    js/a11y-modal.js depends on.

### Simulated history: marked, and exactly reversible

A default seed produces an **entirely green** system — every asset `SO`, one
opening condition row each, and zero mutations, calibrations or part usage. Five
dashboard panels are empty or meaningless as a result, and the client's workbook
has **no condition column at all**, so nothing is being discarded on import: any
variety has to be fabricated.

`seeds/simulasi.py` fabricates it without abandoning the rule the rest of
`seeds/` enforces (*repair records invented against a real fleet are
indistinguishable from fact a year later*). It satisfies what that rule protects
instead:

- **Every fabricated row is attributed to a `SIMULASI` account** and tagged
  `[SIMULASI]` in `keterangan`. `id_pengguna` exists on `riwayat_kondisi`,
  `riwayat_mutasi`, `riwayat_kalibrasi` and `sparepart_stok`, so one join finds
  all of it; `pemakaian_sparepart` is reached through `id_riwayat`/`id_stok`.
- **The account cannot log in** — `hashed_password` stays NULL, like `SYSTEM`.
- **`manage.py hapus-simulasi` restores EXACTLY**, and needs no snapshot table:
  the opening `RiwayatKondisi` carries the import location and starting
  condition, and the simulation never touches it. Asserted row-for-row by
  `tools/verify/test_simulasi.py`.
- **One row per asset marks where fabricated history begins** ("Awal periode
  pemantauan simulasi"). It is also what makes the idempotency gate exact:
  gating on "has any simulated condition row" missed assets that legitimately
  generate no events — 326 assets bought in 2026 whose first gap already runs
  past today — and a second `--simulasi` added 429 more rows.

**One generator, not two.** The state machine lived inside `seeds/dummy.py`'s
creation loop, which is why it only ever ran against the 100 demo assets. It is
now in `seeds/simulasi.py` and `dummy.py` imports it, so the demo fleet's
history is marked too — it was equally fabricated and equally unmarked before.

#### Tuning it is a modelling problem, not a weights problem

The first cut reused the demo weights and produced **21% written off and 37%
currently broken**. Three corrections, each recorded in the module:

- **Time-to-repair is not time-between-failures.** One event gap made every
  repair take 2–13 months, so a machine that broke usually had not been fixed by
  the time the simulation reached today. Splitting `GAP_SEHAT_HARI` from
  `GAP_PERBAIKAN_HARI` moved SO from 60% to 85% on its own.
- **Write-off is budget-constrained.** AFKIR is an absorbing state, so any
  per-event probability compounds toward scrapping everything. `AFKIR_QUOTA_PCT`
  is scaled to **the population this run touches** — sized against the whole
  fleet, a `--only dummy` run let 100 demo machines absorb a budget meant for
  1,221 and came out 29% scrapped.
- **A machine does not stay broken forever.** An asset left TSO by a failure
  older than `TSO_BASI_HARI` is repaired, which keeps `sedang` the point-in-time
  count it is meant to be.

Result: **84.7% SO · 11.3% TSO · 3.9% AFKIR** on the real fleet, 92/4/4 on the
demo one. `seeds/verify.py` asserts the band **over the simulated assets only** —
measured fleet-wide, a `--only dummy` run reads 97% available and says nothing
about the generator.

#### Two bugs it exposed

- **The registration row was dated the seed run, not the purchase.**
  `seeds/aset.py` left `waktu_lapor` to its `CURRENT_TIMESTAMP` default, so
  every "Aset Baru" record carried today's date. Invisible while it was the only
  row an asset had; the moment history existed it sorted LAST, and the `LAG` in
  `_scoped_repair_events()` read the registration as the newest event and
  counted a phantom completion. Now stamped at 08:00 on the purchase date, with
  an idempotent backfill for databases seeded before the fix.
- **`tools/verify/smoke.py` never tested "Semua Tahun".** It sent `?tahun=all`,
  which is not a valid int, so the endpoint fell back to the current year — and
  a single year *cannot* satisfy `masuk == selesai + diafkir + sedang`, because
  `sedang` is not year-scoped. It passed anyway for as long as every term was 0.
  **The parameter is `all_years`**, and the identity is now a real assertion
  rather than a note appended to a label.

## rev0.4.3-alpha — what it closed

Four of the seven client-matrix gaps, all on the Part Inventory side, and none
needing a schema change.

1. **Hierarki Suku Cadang** (`GET /api/inventaris/hirarki`) — the client's B-6,
   the only line marked *High* with no implementation at all. Three design
   decisions carry it:
   - the selector lists **only tool types that have parts** (17 of 104) and
     states the coverage, because offering all 104 would leave 87 choices
     rendering an empty tree — which reads as a broken feature rather than as an
     answer;
   - stock comes from `_net_stok_map()` / `_stok_status()`, the same helpers the
     Items Master uses, so the tree cannot disagree with any other screen;
   - the renderer **collapses a `kategori` level with one child**. Every
     `(kode_alat, subsistem)` pair has exactly one kategori, named
     "SUBSISTEM — TOOL", so drawing it would add a level that always has one
     child and restates its parent. The rule is about SHAPE — split the
     catalogue later and the level reappears on its own.
2. **Kartu Riwayat Suku Cadang** (`GET /api/inventaris/parts/{id_part}`) — B-5.
   Identity plus the balance **per gudang**, which neither existing endpoint
   carried. Read-only and ungated: a technician who may not edit a part still
   needs to know where it is.
3. **Fast / Slow moving** — `_movement_breakdown()` gained an optional `sejak`.
   A **12-month window**, fixed rather than following the Dari/Sampai filter,
   which is routinely set to one month; a "slow moving" list that reshuffled
   whenever someone changed a date box would not mean anything. Terciles over
   the parts that MOVED — ranking the whole catalogue would dump everything
   unmoved into "slow". The third bucket is **"Tanpa Pergerakan"**, not "dead
   stock": a spare for a rarely-failing machine that has not been needed in a
   year is doing its job.
4. **`assert_pengadaan_scope()`** — `ADMIN_WILAYAH` may not register or edit an
   asset to PUSAT. A 400, not a nudge, because `sumber_pengadaan` is baked into
   the composite primary key. Deliberately NOT folded into
   `normalise_sumber_pengadaan()`, which is role-blind: that answers "is this a
   legal value?", this answers "may *you* write it?".
   Client-side the radio is hidden **and disabled** — hiding a checked radio
   would submit its value invisibly, and a hidden `required` one is an
   unfocusable invalid control.

Also fixed: `setInvTab()` un-hid the four inventory write buttons whenever the
Parts tab opened, which would have undone rev0.4.2's `data-write` gating for a
read-only role. A tab switcher must never grant a control the role gate removed.

### Still not done after rev0.4.3

- Server-side paging for the deep screens.
- The repair-events window subquery still runs four times per dashboard load.
- The rate limiter is per-process; multi-worker deployments need Redis.
- No persisted audit log of failed sign-ins.
- **MTBF/MTTR and the calibration reminder are blocked on DATA, not code** —
  0 repair records and 0 calibration records, so both would ship reading zero.
- Stock opname is the last client-matrix item that needs a new table.

The full ranked list, with effort and the risk of leaving each, lives in
[docs/RENCANA-PENGEMBANGAN.md](docs/RENCANA-PENGEMBANGAN.md) — kept in ONE place
so the two cannot drift. (rev0.4.2 carried its own near-identical copy of this
list; rev0.4.3 folded them together.)
