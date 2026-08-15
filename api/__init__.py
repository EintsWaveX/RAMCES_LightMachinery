"""
The RAMCES HTTP API, split out of what used to be a single 5.9k-line main.py.

Layout
------
    deps.py        get_db, auth, require_role, the lokasi/region scope helpers
    files.py       PROJECT_ROOT, the uploads tree, cache headers, 304 support
    realtime.py    ConnectionManager + the `manager` singleton
    schema.py      _ensure_schema() — the migration mechanism
    schemas.py     every Pydantic request model
    auth.py        login, /me, users CRUD
    master.py      alat kerja, lokasi, UPT, Model/Type, documents
    aset.py        aset CRUD, afkir, mutasi, kalibrasi, the public QR card
    riwayat.py     kondisi/perbaikan, history summary, the streaming exports
    inventaris.py  sparepart, gudang, the stok ledger, pemakaian
    dashboard.py   the perbaikan and MCF dashboards

THE ONE INVARIANT: no module in this package may import `main`.

`main.py` imports every router here to call `include_router`, so an import back
the other way is a hard cycle. That is why `manager` lives in `realtime.py` and
`file_response_conditional` in `files.py` rather than in `main.py` beside the
WebSocket route and the static routes that also use them.

This module is deliberately EMPTY of re-exports. `from api import auth` would
otherwise execute every sibling, and a future cycle would surface as an
unreadable partially-initialised module instead of a clean ImportError.
"""
