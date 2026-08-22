"""
RAMCES, application assembly.

This file used to be the whole backend, 5.9k lines of it. It now holds only what
cannot live in a router: the app object and its middleware, the WebSocket
endpoint and its presence heartbeat, the router includes, and the static file
serving that must be registered last.

Everything else is the `api/` package, see api/__init__.py for the layout and
for the one invariant that keeps it working: **no module in api/ may import
main**, because main imports all of them to call include_router.

Boot order below is load-bearing and unchanged from the single-file version:
create_all() → load_dotenv() → _ensure_schema() → app. `_ensure_schema()` in
particular must run before anything queries, because two of its statements
normalise `status_terakhir`/`kondisi` to upper case and several queries compare
those columns raw so their declared indexes stay usable.
"""

import asyncio
import os
from datetime import datetime
from typing import Optional

import jwt
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

import models
from database import engine, SessionLocal


# Inisialisasi Database
models.Base.metadata.create_all(bind=engine)
load_dotenv()


# The migration mechanism, idempotent, IF NOT EXISTS-guarded DDL. It is DEFINED
# in api/schema.py but still CALLED here, at the point in the module body it has
# always occupied: after create_all() and before the app exists. Keeping the call
# at import time is deliberate. Moving it into a lifespan would be a behaviour
# change smuggled into a re-organisation, and two of its statements normalise
# `status_terakhir`/`kondisi` to upper case, a contract get_all_aset and
# export_mutasi rely on when they compare those columns raw.
from api.schema import _ensure_schema  # noqa: E402

_ensure_schema()

app = FastAPI(title="RAMCES Asset API")

# Everything this app serves is text: app.js was 470 KB on the wire, index.html
# 383 KB, and /api/history/summary 98.6 KB, all uncompressed. This JSON and JS
# compresses roughly 8:1, which makes one line of middleware the single largest
# performance win available here.
#
# `minimum_size` skips tiny responses where the gzip header costs more than it
# saves. WebSocket frames bypass HTTP middleware entirely, so /ws/updates is
# unaffected.
app.add_middleware(GZipMiddleware, minimum_size=1000)

# NO CORS middleware, deliberately.
#
# This app serves its own frontend: `GET /` returns index.html and the catch-all
# static route serves js/, assets/ and landing.html from the same origin, so no
# cross-origin request is ever made and CORS has nothing to permit. The previous
# configuration paired `allow_origins=["*"]` with `allow_credentials=True`,
# which is an invalid combination the CORS spec requires browsers to reject,
# it granted nothing and only advertised that any origin was welcome to try.
#
# If a genuinely separate frontend is ever added, re-add CORSMiddleware with an
# EXPLICIT origin list, never "*" alongside credentials.

# The cache policy, the uploads tree and `file_response_conditional` live in
# api/files.py. They had to move together with BASE_DIR: the routers reach both
# the upload helpers (master, aset) and the 304 wrapper (the public foto_alat
# route in master.py), so keeping them here would make every one of those files
# import main.py. Only what the static routes below actually use is imported.
from api.files import (  # noqa: E402
    BASE_DIR,
    _MEDIA_TYPES,
    _STATIC_EXT,
    _cache_control_for,
    file_response_conditional,
)

# `SECRET_KEY`/`ALGORITHM` are for the WebSocket handshake below, which decodes
# the token itself: the browser WebSocket API cannot set an Authorization
# header, so `Depends(get_current_user)` is not available to it.
from api.deps import ALGORITHM, SECRET_KEY  # noqa: E402

# ConnectionManager and the `manager` singleton live in api/realtime.py. The
# WebSocket ROUTE stays here, but the registry it fans out through has to be
# importable by the routers: every mutating endpoint awaits
# manager.broadcast(...) after commit, and main.py imports those routers to
# include them, so keeping `manager` here would be a hard import cycle.
from api.realtime import manager  # noqa: E402

# Re-export. seeds/pengguna.py does `from main import get_password_hash` to seed
# the bootstrap SUPER_ADMIN. seeds/ is gitignored, so nothing in the tracked
# tree points at it and no check here covers it, if this line goes, the
# `pengguna` seed step breaks and nobody finds out until the next reseed.
from api.deps import get_password_hash  # noqa: E402,F401


@app.get("/api/config")
def get_config():
    # Externally-reachable base URL, used only to build QR/landing links when
    # the app is being viewed on localhost. Tunnel-agnostic (Tailscale Funnel,
    # ngrok, reverse proxy); NGROK_URL is kept as a legacy alias.
    public_url = (
        os.environ.get("PUBLIC_URL") or os.environ.get("NGROK_URL") or ""
    ).rstrip("/")
    return {"public_url": public_url, "ngrok_url": public_url}


# ==================================================================
# ── WEBSOCKET ─────────────────────────────────────────────────────
# ==================================================================


def _username_from_token(token: Optional[str]) -> Optional[str]:
    """Decode a JWT for the WebSocket handshake. Returns None if unusable."""
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload.get("sub")
    except jwt.PyJWTError:
        return None


def _touch_last_seen(username: Optional[str], view: Optional[str] = None):
    """Stamp presence on the user row using a short-lived standalone session."""
    if not username:
        return
    db = SessionLocal()
    try:
        user = db.query(models.Pengguna).filter_by(username=username).first()
        if user:
            user.last_seen = datetime.now()
            if view:
                user.last_view = view
            db.commit()
    except Exception:
        db.rollback()
    finally:
        db.close()


# Last time each user's row was actually written. The heartbeat fires every 30s
# per open tab, and `last_seen` is only ever read to render "online N minutes
# ago", so writing it that often was pure load for no visible difference.
_LAST_STAMP: dict = {}
_STAMP_INTERVAL_SECONDS = 60


async def _touch_last_seen_async(username: Optional[str], view: Optional[str] = None):
    """
    Presence stamp, off the event loop and throttled.

    `_touch_last_seen` is blocking psycopg2, and every caller of it lives inside
    the `async` WebSocket handler, so a connect, SELECT, UPDATE and COMMIT ran
    on the event loop, stalling every other request and socket on the worker. It
    also opened its own session outside `get_db()`, competing for the same pool;
    when that pool was exhausted the loop froze for the full pool timeout.

    A view change always writes (it is a real state change the Pengguna list
    shows); a bare heartbeat writes at most once a minute.
    """
    if not username:
        return
    now = datetime.now()
    if view is None:
        last = _LAST_STAMP.get(username)
        if last and (now - last).total_seconds() < _STAMP_INTERVAL_SECONDS:
            return
    _LAST_STAMP[username] = now
    await asyncio.to_thread(_touch_last_seen, username, view)


@app.websocket("/ws/updates")
async def websocket_endpoint(websocket: WebSocket, token: Optional[str] = None):
    """
    Live-update channel, now identity-aware.

    The token arrives as a query param because the browser WebSocket API cannot
    set an Authorization header. It is optional: an anonymous socket still gets
    broadcasts (so nothing regresses), it simply doesn't register presence.

    Client → server messages:
      "ping"        → "pong"  (heartbeat)
      "view:<name>" → records which screen the user is on
    """
    username = _username_from_token(token)
    await manager.connect(websocket, username)
    if username:
        await _touch_last_seen_async(username)
        await manager.broadcast("REFRESH_PRESENCE")
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
                # The heartbeat doubles as the liveness stamp, throttled, so a
                # room full of open tabs is not a room full of UPDATEs.
                await _touch_last_seen_async(username)
            elif data.startswith("view:") and username:
                view = data.split(":", 1)[1][:50] or None
                await manager.set_view(username, view)
                await _touch_last_seen_async(username, view)
                await manager.broadcast("REFRESH_PRESENCE")
    except WebSocketDisconnect:
        await manager.disconnect(websocket, username)
        if username:
            # Force the final stamp past the throttle: this is the timestamp
            # "terakhir aktif" will show from now on.
            _LAST_STAMP.pop(username, None)
            await _touch_last_seen_async(username)
            await manager.broadcast("REFRESH_PRESENCE")
    except Exception:
        # Never let a malformed frame leak a socket from the registry.
        await manager.disconnect(websocket, username)



# ==================================================================
# ── ROUTERS ───────────────────────────────────────────────────────
# ==================================================================
# Bare APIRouter()s, no prefix, no tags, no router-level dependencies. Every
# route already carries its absolute /api/... path, so a prefix would change it;
# tags and router-level dependencies would change the OpenAPI document, which is
# the gate this re-organisation is verified against.
#
# These are included BEFORE the /assets mount and the two static routes below,
# because `GET /{file_path:path}` matches literally everything and must be the
# last route registered in the whole application.
#
# Order between the routers themselves does not matter: every path is disjoint
# by segment count or by a distinct literal segment. The one genuine shadowing
# relationship in the app is inside api/auth.py (see the warning in its
# docstring), and grouping cannot affect it.
from api import auth, aset, dashboard, inventaris, master, riwayat  # noqa: E402

app.include_router(auth.router)
app.include_router(master.router)
app.include_router(aset.router)
app.include_router(riwayat.router)
app.include_router(inventaris.router)
app.include_router(dashboard.router)


# ==================================================================
# ── ASSET FILES ──────────────────────────────────────────────────
# ==================================================================
# BASE_DIR / PROJECT_ROOT come from api/files.py, which derives them with a
# double dirname so they keep pointing at the repository root from inside the
# package. Do NOT reintroduce a local `os.path.dirname(os.path.abspath(__file__))`.
assets_dir = os.path.join(BASE_DIR, "assets")
if os.path.exists(assets_dir):
    app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")


@app.middleware("http")
async def add_cache_headers(request, call_next):
    """
    Stamp Cache-Control on static responses.

    StaticFiles (the /assets mount) does not set it either, so this covers both
    that mount and the catch-all below in one place. API responses are left
    alone, they must never be cached.
    """
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/api/") or path.startswith("/ws/"):
        return response
    ext = os.path.splitext(path)[1].lower()
    if ext or path == "/":
        response.headers.setdefault("Cache-Control", _cache_control_for(ext))
    return response


# `file_response_conditional` lives in api/files.py, it is shared with the
# public Model/Type photo route in api/master.py, so it cannot live here.


@app.get("/")
async def serve_index(request: Request):
    return file_response_conditional(request, os.path.join(BASE_DIR, "index.html"))

@app.get("/{file_path:path}")
async def serve_static(file_path: str, request: Request):
    # Prevent directory traversal
    if ".." in file_path or file_path.startswith("/"):
        raise HTTPException(status_code=403, detail="Access denied.")

    # `uploads/` sits inside BASE_DIR, so this catch-all used to serve anything
    # in it whose extension was in the allowlist. A calibration certificate
    # uploaded as .jpg or .png was therefore readable at
    # /uploads/sertifikat/<name> with NO token, straight past
    # `download_sertifikat`'s auth. The only sanctioned public path into the
    # tree is `/uploads/foto_alat/…`, which is its own route registered above
    # this one; everything else must go through an authenticated handler.
    if file_path.replace("\\", "/").lower().startswith("uploads/"):
        raise HTTPException(status_code=404, detail="File not found.")

    ext = os.path.splitext(file_path)[1].lower()
    if ext not in _STATIC_EXT:
        raise HTTPException(status_code=404, detail="File not found.")

    path = os.path.join(BASE_DIR, file_path)
    real_path = os.path.realpath(path)
    real_base = os.path.realpath(BASE_DIR)

    if not real_path.startswith(real_base):
        raise HTTPException(status_code=403, detail="Access denied.")

    if os.path.exists(real_path) and os.path.isfile(real_path):
        return file_response_conditional(
            request, real_path, media_type=_MEDIA_TYPES.get(ext)
        )

    raise HTTPException(status_code=404, detail="File not found.")
