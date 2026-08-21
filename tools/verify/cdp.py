"""
Drive Chrome over the DevTools Protocol.

Node and Playwright are not installed on this machine, but Chrome is, and
Python 3.10 has `requests` + `websockets` — which is everything needed. Because
the RAMCES frontend keeps everything on the global scope (classic scripts, no
modules), `Runtime.evaluate` can call the app's own functions directly:
handleLogin(), switchView(), assetMatchesSearch(), refreshTambahPreview().

Three things that cost time before, encoded here so they cannot recur:

1. The websocket reader task starts BEFORE the first CDP command, and its
   reference is kept — an unreferenced asyncio task can be garbage-collected
   mid-run, which looks exactly like a silently dropped response.
2. A per-port --user-data-dir. Without it a second Chrome hands its arguments
   to the first instance and exits, so the new port never opens.
3. Every evaluated snippet is wrapped in an IIFE. Runtime.evaluate runs in the
   page's global scope, so a bare `const s` twice is a redeclaration error that
   poisons every later call.
"""

import asyncio
import base64
import json
import os
import shutil
import subprocess
import sys
import time

import tempfile

import requests
import websockets

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

# Chrome profiles go to the SYSTEM temp dir, never beside this file. A profile is
# ~300 files of caches, cookies and shader blobs; written into the repo it lands
# in `git status` and, on one run, very nearly in a commit.
SCRATCH = os.path.join(tempfile.gettempdir(), "ramces-chrome")
os.makedirs(SCRATCH, exist_ok=True)


class Chrome:
    def __init__(self, port=9222, width=1440, height=900):
        self.port = port
        self.width = width
        self.height = height
        self.proc = None
        self.ws = None
        self._id = 0
        self._pending = {}
        self._events = []
        self._reader = None
        self.console = []

    # ── lifecycle ────────────────────────────────────────────────
    def _launch(self):
        # Per-port profile dir: a shared one makes the second Chrome hand off to
        # the first and never open its own debugging port.
        profile = os.path.join(SCRATCH, f"chrome-profile-{self.port}")
        shutil.rmtree(profile, ignore_errors=True)
        os.makedirs(profile, exist_ok=True)
        self.proc = subprocess.Popen(
            [
                CHROME,
                "--headless=new",
                f"--remote-debugging-port={self.port}",
                f"--user-data-dir={profile}",
                f"--window-size={self.width},{self.height}",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-extensions",
                "--disable-gpu",
                "--hide-scrollbars",
                "about:blank",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        for _ in range(100):
            try:
                r = requests.get(f"http://127.0.0.1:{self.port}/json/version", timeout=1)
                if r.ok:
                    return
            except Exception:
                pass
            time.sleep(0.2)
        raise RuntimeError(f"Chrome did not open port {self.port}")

    async def start(self):
        self._launch()
        tabs = requests.get(f"http://127.0.0.1:{self.port}/json").json()
        page = next(t for t in tabs if t["type"] == "page")
        self.ws = await websockets.connect(
            page["webSocketDebuggerUrl"], max_size=64 * 1024 * 1024
        )
        # Reader first, and keep the reference.
        self._reader = asyncio.create_task(self._read())
        await self.send("Runtime.enable")
        await self.send("Page.enable")
        await self.send("Log.enable")
        await self.send("Network.enable")

    async def _read(self):
        try:
            async for raw in self.ws:
                msg = json.loads(raw)
                if "id" in msg:
                    fut = self._pending.pop(msg["id"], None)
                    if fut and not fut.done():
                        fut.set_result(msg)
                else:
                    self._events.append(msg)
                    self._note_console(msg)
        except Exception:
            pass

    def _note_console(self, msg):
        m = msg.get("method")
        p = msg.get("params", {})
        if m == "Runtime.consoleAPICalled" and p.get("type") in ("error", "warning"):
            text = " ".join(
                str(a.get("value", a.get("description", ""))) for a in p.get("args", [])
            )
            self.console.append((p["type"], text))
        elif m == "Runtime.exceptionThrown":
            d = p.get("exceptionDetails", {})
            self.console.append((
                "exception",
                d.get("exception", {}).get("description") or d.get("text", ""),
            ))
        elif m == "Log.entryAdded":
            e = p.get("entry", {})
            if e.get("level") in ("error", "warning"):
                self.console.append((e["level"], f"{e.get('text','')} {e.get('url','')}"))

    async def send(self, method, **params):
        self._id += 1
        mid = self._id
        fut = asyncio.get_running_loop().create_future()
        self._pending[mid] = fut
        await self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        msg = await asyncio.wait_for(fut, timeout=60)
        if "error" in msg:
            raise RuntimeError(f"{method}: {msg['error']}")
        return msg.get("result", {})

    async def close(self):
        if self._reader:
            self._reader.cancel()
        try:
            if self.ws:
                await self.ws.close()
        except Exception:
            pass
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except Exception:
                self.proc.kill()

    # ── page ─────────────────────────────────────────────────────
    async def goto(self, url, wait=2.0):
        """Navigate, wait for the document to finish loading, THEN settle.

        `wait` used to be the whole story, and every caller guessed 3.0 s. On a
        cold browser index.html (~460 KB, 23 script tags) sometimes needs more,
        so the guess was lost occasionally rather than never — and the symptom
        was never "slow page", it was the next assertion reporting that the
        login form or the register button did not exist. Intermittent failures
        that name the wrong cause are the most expensive kind.

        Polling `readyState === 'complete'` first is the fix, and it is enough
        on its own for the js/ files: they are CLASSIC scripts with no `defer`,
        so they have all evaluated before the document is complete. The original
        `wait` is still honoured afterwards, unchanged, because several callers
        use it to let the app's own async boot (login, master data, the first
        rollups) settle — this only ever ADDS time where the page was not ready.
        """
        await self.send("Page.navigate", url=url)
        await self.wait_for("document.readyState === 'complete'", timeout=30.0)
        await asyncio.sleep(wait)

    async def wait_for(self, expr, timeout=15.0, every=0.25):
        """Poll until a JS expression is truthy. Returns True, or False on timeout.

        `goto(wait=N)` is a wall-clock guess, and index.html is ~460 KB pulling
        23 scripts — so on a cold browser the guess is lost occasionally rather
        than never. That is the worst failure mode a harness can have: the check
        that runs next reports "the register button is gone" when the truth is
        "the page had not parsed yet", and it does so intermittently. Poll for
        the condition the test actually depends on instead.

        Never raises: a timeout returns False so the caller's own check() reports
        the real assertion rather than the harness exploding with a KeyError.
        """
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if await self.eval(f"(function(){{ return !!({expr}); }})()"):
                    return True
            except Exception:
                pass  # document not ready enough to evaluate yet
            await asyncio.sleep(every)
        return False

    async def viewport(self, width, height, mobile=False):
        self.width, self.height = width, height
        await self.send(
            "Emulation.setDeviceMetricsOverride",
            width=width, height=height,
            deviceScaleFactor=1, mobile=mobile,
        )

    async def eval(self, expr, awaitPromise=False):
        """Evaluate an expression. ALWAYS wrapped in an IIFE by the caller's
        convention — see js() below, which does it for you."""
        r = await self.send(
            "Runtime.evaluate",
            expression=expr,
            returnByValue=True,
            awaitPromise=awaitPromise,
            userGesture=True,
        )
        if "exceptionDetails" in r:
            d = r["exceptionDetails"]
            raise RuntimeError(
                d.get("exception", {}).get("description") or d.get("text", "eval failed")
            )
        return r.get("result", {}).get("value")

    async def js(self, body, awaitPromise=False):
        """Run a statement body inside an async IIFE and return its value."""
        return await self.eval(
            f"(async () => {{ {body} }})()", awaitPromise=True
        )

    async def screenshot(self, path, full=False):
        r = await self.send("Page.captureScreenshot", format="png", captureBeyondViewport=full)
        with open(path, "wb") as fh:
            fh.write(base64.b64decode(r["data"]))
        return path

    def drain_console(self, ignore=()):
        out = [
            (lvl, txt) for lvl, txt in self.console
            if not any(pat in txt for pat in ignore)
        ]
        self.console = []
        return out

    # ── app helpers ──────────────────────────────────────────────
    async def login(self, username, password, wait_ms=5000):
        """Sign in through the real form, and wait for the token to land.

        Returns the decoded role. `getJwtPayload` takes the token as an
        argument — it does not read sessionStorage itself.
        """
        return await self.js(f"""
            const u = document.getElementById('login-username');
            const p = document.getElementById('login-password');
            if (!u || !p) return 'no login form';
            u.value = {json.dumps(username)};
            p.value = {json.dumps(password)};
            const f = document.getElementById('form-login') || u.closest('form');
            if (!f) return 'no form element';
            f.dispatchEvent(new Event('submit', {{ bubbles: true, cancelable: true }}));
            const deadline = Date.now() + {wait_ms};
            while (Date.now() < deadline) {{
                const t = sessionStorage.getItem('authToken');
                if (t) return (getJwtPayload(t) || {{}}).role || 'no role in token';
                await new Promise(r => setTimeout(r, 100));
            }}
            return 'timed out';
        """, awaitPromise=True)

    async def role(self):
        return await self.js("""
            const t = sessionStorage.getItem('authToken');
            return t ? (getJwtPayload(t) || {}).role : null;
        """)

    async def horizontal_overflow(self):
        """Elements wider than the viewport — the 390px sideways-scroll check."""
        return await self.js("""
            const vw = document.documentElement.clientWidth;
            const bad = [];
            for (const el of document.querySelectorAll('body *')) {
                if (!el.offsetParent && el.tagName !== 'BODY') continue;
                const r = el.getBoundingClientRect();
                if (r.width === 0) continue;
                if (r.right > vw + 1.5 || r.left < -1.5) {
                    const sel = el.tagName.toLowerCase()
                        + (el.id ? '#' + el.id : '')
                        + (el.className && typeof el.className === 'string'
                            ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.')
                            : '');
                    bad.push({ sel, left: Math.round(r.left), right: Math.round(r.right) });
                }
            }
            return {
                docScrollW: document.documentElement.scrollWidth,
                clientW: vw,
                overflows: bad.slice(0, 12),
            };
        """)
