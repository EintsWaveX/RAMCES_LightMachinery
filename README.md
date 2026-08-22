# RAMCES

**Light machinery asset monitoring for PT Kereta Api Indonesia (Persero) — Track & Bridge Division**

RAMCES tracks PT KAI's light work equipment — gensets, drills, rail grinding
machines, track geometry trolleys, impact wrenches and similar — from
registration through to condition reporting, calibration, inter-region transfer,
spare-part consumption, and eventual write-off.

It is built to catalogue **103 equipment types across 254 work units in 13
regions** nationwide, with role-scoped access so a regional admin sees their
region and head office sees everything.

---

## Status

Internship deliverable, developed for PT KAI's Track & Bridge Division and
**still under active development** (currently `rev0.5.0-alpha`, 46 commits).
The application runs end to end against seeded and staging data; the production
rollout with live asset records is pending.

Two developers. This repository contains no production data, no credentials, and
no internal PT KAI network details — `.env` is git-ignored and only
`.env.example` is tracked.

---

## What it does

| Area | Capability |
|---|---|
| **Assets** | Registration, search, QR asset cards, write-off (*afkir*) and restore |
| **Condition** | Field condition reports, repair tracking, calibration due dates |
| **Transfers** | Inter-region asset movement (*mutasi*) with a full audit trail |
| **Inventory** | Spare parts, warehouses, a stock ledger, consumption against repairs, stock-take (*opname*) sessions |
| **Dashboards** | Fleet condition overview, repair dashboard, MCF and MTBF/MTTR metrics, drill-down |
| **Reporting** | Streaming Excel and PDF exports |
| **Live updates** | WebSocket push so a change made by one user appears on every open screen |

---

## Architecture

```
main.py            app assembly, middleware, WebSocket endpoint, static serving
database.py        engine + SessionLocal
models.py          16 SQLAlchemy tables
api/               the HTTP API, one module per domain
  deps.py            get_db, auth, require_role, region-scope helpers
  schema.py          _ensure_schema() — idempotent, IF NOT EXISTS-guarded DDL
  schemas.py         Pydantic request models
  realtime.py        ConnectionManager + the `manager` singleton
  files.py           uploads tree, cache headers, 304 support
  auth.py            login, /me, user CRUD
  master.py          equipment types, locations, work units, documents
  aset.py            asset CRUD, afkir, mutasi, kalibrasi, public QR card
  riwayat.py         condition/repair history, summaries, streaming exports
  inventaris.py      spare parts, warehouses, stock ledger, consumption
  dashboard.py       repair and MCF dashboards
js/                 frontend: core, api client, shell, one module per view
seeds/              seed data generators
tools/              static checks for HTML, JS, and Python naming
docs/               user and developer documentation (Indonesian)
```

**Stack:** Python · FastAPI · SQLAlchemy · PostgreSQL · JWT · WebSocket ·
vanilla JavaScript (no SPA framework) · Tailwind · Chart.js

### The one invariant

**No module in `api/` may import `main`.** `main.py` imports every router to
call `include_router`, so an import back the other way is a hard cycle. That is
why `manager` lives in `realtime.py` and `file_response_conditional` in
`files.py`, rather than beside the routes in `main.py` that use them.

### Boot order is load-bearing

`create_all()` → `load_dotenv()` → `_ensure_schema()` → `app`

`_ensure_schema()` must run before anything queries: two of its statements
normalise `status_terakhir` and `kondisi` to upper case, and several queries
compare those columns raw so their declared indexes stay usable.

---

## Access control

Five roles, defined as a closed tuple in `api/deps.py`:

| Role | Scope |
|---|---|
| `SUPER_ADMIN` | Everything, nationwide — master data, write-off/restore, users |
| `ADMIN_WILAYAH` | Everything inside its own region, except master data |
| `PETUGAS_GUDANG` | The warehouse; the only non-admin who may move stock |
| `TEKNISI` | Field work — report condition, record calibration, consume parts on a repair. Reads the rest |
| `PIMPINAN` | Read-only, plus report generation. Writes nothing |

Region-scoped roles are an explicit allow-list, not a negative check — `id_lokasi
IS NULL` means nationwide. The same applies to user administration. Both are
written as allow-lists deliberately: a negative check (`!= "TEKNISI"`) silently
admits every role added after it was written, which is exactly how a permission
widening leaks.

---

## Engineering notes

**Response compression.** Everything this app serves is text — `app.js` was
470 KB on the wire, `index.html` 383 KB, `/api/history/summary` 98.6 KB, all
uncompressed. GZip middleware compresses that roughly **8:1**, making one line
of middleware the single largest performance win available. `minimum_size`
skips responses where the gzip header would cost more than it saves; WebSocket
frames bypass HTTP middleware entirely, so `/ws/updates` is unaffected.

**Server-side paging.** Listing endpoints page at the database rather than
loading a full table and slicing in the browser, which also collapsed four
window scans into one.

**Migrations without a migration tool.** `_ensure_schema()` is idempotent,
`IF NOT EXISTS`-guarded DDL run at import time. Adding the two newest roles
needed no migration at all: `pengguna.role` is `String(20)` with no enum, FK, or
CHECK constraint, so existing values stayed valid members of the widened tuple.

---

## Running it locally

**Requires:** Python 3.10+, PostgreSQL

```bash
cp .env.example .env        # then fill in SECRET_KEY, DATABASE_URL, bootstrap admin
pip install fastapi uvicorn sqlalchemy psycopg2-binary python-jose[cryptography] \
            passlib[bcrypt] python-dotenv python-multipart openpyxl
python -m uvicorn main:app --reload
```

Seed data:

```bash
python seed_katalog.py      # equipment catalogue
python seed_aset_real.py    # assets
python manage.py            # admin utilities
```

Then open <http://localhost:8000>.

---

## Documentation

Full documentation lives in `docs/`, written in Indonesian:

- **`PANDUAN-RAMCES.md`** — end-user guide, written for field technicians with
  no technical background. Every screenshot is taken from the running app.
- **`MULAI-DARI-NOL.md`** — setup from scratch
- **`RENCANA-PENGEMBANGAN.md`** — development roadmap
- **`CAKUPAN-TIMELINE-MAGANG.md`** — internship scope and timeline
