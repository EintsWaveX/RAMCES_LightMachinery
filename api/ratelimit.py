"""
In-process rate limiting for the unauthenticated endpoints.

`/api/login` had none. Nothing anywhere counted a failed attempt, logged one, or
slowed the next, a bcrypt verify is the only thing that stood between an
attacker and an unlimited online guessing run against a known username, and the
seeded fleet makes usernames easy to guess.

── A LEAF MODULE ──

It imports nothing from `api/` and nothing imports `main`. That is the package
invariant (see api/__init__.py) and it is why the buckets live here rather than
beside the login route that uses them.

── What this is NOT ──

It is a single-process, in-memory counter. It does not survive a restart, and
two uvicorn workers keep two independent sets of buckets, with `--workers 4` an
attacker effectively gets four times the budget. That is a real limitation and
the honest fix is Redis or a reverse proxy. It is still worth having: the threat
it actually addresses is an unattended script hammering one deployment, and it
turns an unbounded run into a bounded one even at 4x.

── Why a captcha and NEVER a lockout ──

Locking an account after N failures, keyed on username, is a denial-of-service
primitive: anyone who knows a username can lock its owner out by failing
deliberately. So a tripped bucket asks for a CAPTCHA instead. The user can still
get in; the script cannot proceed without solving one per attempt.

`X-Forwarded-For` is honoured ONLY when `TRUSTED_PROXY=1`, because behind no
proxy the header is attacker-controlled and every request could claim a fresh
IP, which would make the IP buckets decorative. The deployment story for this
project is ngrok/Tailscale, so this will matter.
"""

import os
import threading
import time

# ── Buckets ───────────────────────────────────────────────────────────
#
# (max_hits, window_seconds), keyed by a bucket name. The login pair is
# deliberately asymmetric: an office NAT shares one IP across many legitimate
# users, so `login:ip` is generous, while `login:user` is tight because one
# ACCOUNT failing ten times in a quarter of an hour is already abnormal.
LIMITS = {
    "login:ip": (20, 300),        # 20 attempts / 5 min from one address
    "login:user": (10, 900),      # 10 attempts / 15 min against one username
    "register:ip": (5, 3600),     # 5 sign-ups / hour from one address
    "captcha:ip": (30, 300),      # 30 challenges / 5 min, one per attempt, plus reloads
}

# A ceiling on distinct keys, so the dict cannot itself become the attack: an
# unbounded map keyed on attacker-supplied usernames is a memory exhaustion bug
# wearing a rate limiter's clothes. When full, the oldest half is dropped.
_MAX_KEYS = 20_000

_hits: dict = {}
_lock = threading.Lock()


def _prune_locked(now: float) -> None:
    """Drop expired entries; if still over the ceiling, drop the oldest half."""
    for key, stamps in list(_hits.items()):
        window = LIMITS.get(key.split("|", 1)[0], (0, 300))[1]
        fresh = [t for t in stamps if now - t < window]
        if fresh:
            _hits[key] = fresh
        else:
            del _hits[key]

    if len(_hits) > _MAX_KEYS:
        oldest = sorted(_hits.items(), key=lambda kv: max(kv[1]))
        for key, _ in oldest[: len(oldest) // 2]:
            _hits.pop(key, None)


def hit(bucket: str, ident: str) -> bool:
    """
    Record one attempt. Returns True while still within the limit.

    Counts EVERY attempt, including the one that trips the limit, so a caller
    that keeps trying stays tripped rather than being let through every other
    request.
    """
    limit, window = LIMITS.get(bucket, (0, 300))
    if not limit:
        return True
    key = f"{bucket}|{ident}"
    now = time.time()
    with _lock:
        if len(_hits) > _MAX_KEYS:
            _prune_locked(now)
        stamps = [t for t in _hits.get(key, ()) if now - t < window]
        stamps.append(now)
        _hits[key] = stamps
        return len(stamps) <= limit


def tripped(bucket: str, ident: str) -> bool:
    """Is this key over its limit right now? Does NOT record an attempt."""
    limit, window = LIMITS.get(bucket, (0, 300))
    if not limit:
        return False
    key = f"{bucket}|{ident}"
    now = time.time()
    with _lock:
        stamps = [t for t in _hits.get(key, ()) if now - t < window]
        return len(stamps) >= limit


def clear(bucket: str, ident: str) -> None:
    """
    Forget a key. Called after a SUCCESSFUL login.

    Without this, a user who mistypes their password nine times and then gets it
    right stays one attempt away from a captcha for the next quarter of an hour,
    which punishes exactly the person the limit is not aimed at.
    """
    with _lock:
        _hits.pop(f"{bucket}|{ident}", None)


def client_ip(request) -> str:
    """
    The caller's address.

    `X-Forwarded-For` is trusted ONLY when TRUSTED_PROXY=1. Off by default,
    because with no proxy in front the header is attacker-supplied: a script
    that sets a different one per request gets a fresh bucket every time and the
    IP limits become decoration. Set it when, and only when, something you
    control terminates the connection.
    """
    if os.getenv("TRUSTED_PROXY", "").strip() in ("1", "true", "TRUE", "yes"):
        fwd = request.headers.get("x-forwarded-for", "")
        if fwd:
            # Left-most entry is the original client; the rest are proxies.
            return fwd.split(",")[0].strip()
    return getattr(getattr(request, "client", None), "host", "") or "unknown"
