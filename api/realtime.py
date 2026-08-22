"""
Live updates and presence.

`ConnectionManager` is both the broadcast fan-out and the presence registry, and
it is reached from roughly forty call sites spread across auth, master, aset,
riwayat and inventaris, every endpoint that mutates data must
`await manager.broadcast(...)` after commit, because that is the only way
connected clients learn about the change.

That is why the class and the singleton live in a leaf module rather than beside
the WebSocket route in main.py: main.py imports every router to call
include_router, so a router importing main.py back would be a hard cycle. The
`@app.websocket("/ws/updates")` route itself stays in main.py; only the registry
it fans out through is importable.

Dependencies are deliberately minimal, asyncio, datetime, typing and
fastapi.WebSocket. Nothing here touches the database or the app object.
"""

import asyncio
from datetime import datetime
from typing import List, Optional

from fastapi import WebSocket


class ConnectionManager:
    """
    Live-update fan-out, plus the presence registry.

    Sockets are keyed by username so "who is online" is answerable without a
    database round trip. A user may hold several sockets at once (two tabs), so
    each username maps to a SET, they go offline only when the last one drops.
    """

    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self._lock = asyncio.Lock()
        # username → set of sockets
        self.user_sockets: dict = {}
        # username → { "view": str, "since": datetime }
        self.presence: dict = {}

    async def connect(self, websocket: WebSocket, username: Optional[str] = None):
        await websocket.accept()
        async with self._lock:
            self.active_connections.append(websocket)
            if username:
                self.user_sockets.setdefault(username, set()).add(websocket)
                self.presence.setdefault(
                    username, {"view": None, "since": datetime.now()}
                )

    async def disconnect(self, websocket: WebSocket, username: Optional[str] = None):
        async with self._lock:
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)
            if username and username in self.user_sockets:
                self.user_sockets[username].discard(websocket)
                # Only truly offline once every tab has closed.
                if not self.user_sockets[username]:
                    self.user_sockets.pop(username, None)
                    self.presence.pop(username, None)

    async def set_view(self, username: str, view: Optional[str]):
        """Record which screen a user is looking at (for the Pengguna list)."""
        if not username:
            return
        async with self._lock:
            entry = self.presence.setdefault(
                username, {"view": None, "since": datetime.now()}
            )
            if entry.get("view") != view:
                entry["view"] = view
                entry["since"] = datetime.now()

    def online_usernames(self) -> set:
        return set(self.user_sockets.keys())

    def presence_of(self, username: str) -> dict:
        return self.presence.get(username) or {}

    async def broadcast(self, message: str):
        """
        Fan a message out to every connected socket, in parallel and bounded.

        This used to send SEQUENTIALLY with no timeout, and it is awaited inside
        every mutating endpoint, so one client on a stalled mobile connection
        with a full TCP send buffer blocked the POST response for the user who
        made the change, and delayed every other client behind it.

        Failures now prune the socket instead of being swallowed: the previous
        bare `except: pass` left half-open connections in the list forever, to
        be retried on every subsequent broadcast.
        """
        async with self._lock:
            connections = list(self.active_connections)
        if not connections:
            return

        async def _send(ws):
            try:
                await asyncio.wait_for(ws.send_text(message), timeout=2.0)
            except Exception:
                await self.disconnect(ws)

        await asyncio.gather(
            *(_send(c) for c in connections), return_exceptions=True
        )


manager = ConnectionManager()
