"""
A stateless CAPTCHA: HMAC-signed token in, inline SVG out.

── Why stateless ──

The obvious design is a server-side challenge store keyed by an id, expired by a
TTL. It breaks here in two ways that both look like "captcha salah" on a
CORRECT answer, which is the worst failure a captcha can have:

  * the project is developed under `uvicorn --reload`, and every reload empties
    an in-memory store while the browser still holds a challenge id;
  * more than one worker means the process that ISSUED the challenge is usually
    not the process that verifies it.

So nothing is stored. The token IS the challenge: a signed, expiring blob
carrying the answer's hash. Any worker can verify one, and a restart invalidates
nothing.

── Why SVG ──

There is no canvas anywhere in this frontend, no image pipeline, and Pillow is
not among the installed dependencies. An SVG is text: it goes in the same JSON
as the token, needs no second request, no `<img src>` and no cache headers, and
it scales on a phone. The distortion is deliberately mild, this defends against
an unattended script, not against a paid solving service, and a captcha a
technician in a hi-vis vest cannot read at a resort is worse than none.

── Replay ──

A signed token would otherwise be reusable until it expires: solve once, replay
the same (token, answer) pair as fast as the network allows. Consumed nonces are
therefore kept in a small in-process set until their token would have expired
anyway. That set is the ONE piece of state here, it is bounded, and losing it on
restart costs at most a replay inside a two-minute window.

Alphabet excludes O/0/I/l/1, the characters people misread and then blame the
form for.
"""

import base64
import hmac
import hashlib
import json
import os
import secrets
import threading
import time

# No O, 0, I, l or 1.
ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
LENGTH = 5
TTL_SECONDS = 180  # long enough to read, type and submit on a phone

_rng = secrets.SystemRandom()


def _secret() -> bytes:
    """
    The signing key.

    Derived from SECRET_KEY rather than reusing it: this signs a throwaway
    challenge and JWTs sign identity, and one key doing both means a flaw in
    either reaches the other. SECRET_KEY has no fallback and the app refuses to
    boot without it, so this cannot silently become a constant.
    """
    base = os.getenv("SECRET_KEY", "")
    if not base:
        raise RuntimeError(
            "SECRET_KEY tidak diset — captcha tidak bisa menandatangani token. "
            "Salin .env.example ke .env dan isi SECRET_KEY."
        )
    return hashlib.sha256(f"captcha:{base}".encode()).digest()


# ── Replay protection ─────────────────────────────────────────────────
_used: dict = {}
_used_lock = threading.Lock()
_USED_MAX = 10_000


def _consume(nonce: str) -> bool:
    """True the first time a nonce is seen, False on every replay."""
    now = time.time()
    with _used_lock:
        for key, stamp in list(_used.items()):
            if now - stamp > TTL_SECONDS:
                del _used[key]
        if len(_used) > _USED_MAX:
            _used.clear()  # bounded, and losing it costs one TTL window
        if nonce in _used:
            return False
        _used[nonce] = now
        return True


# ── Token ─────────────────────────────────────────────────────────────

def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _sign(payload: bytes) -> str:
    return _b64(hmac.new(_secret(), payload, hashlib.sha256).digest())


def _answer_hash(answer: str, nonce: str) -> str:
    """
    The answer is stored HASHED, never in clear.

    The token travels to the browser, so a plain answer inside it is simply the
    answer written on the back of the card. Salted with the nonce so two
    challenges with the same solution do not produce the same hash.
    """
    return hashlib.sha256(f"{nonce}:{answer.upper()}".encode()).hexdigest()


def issue() -> dict:
    """A fresh challenge: `{token, svg, expires_in}`."""
    text = "".join(_rng.choice(ALPHABET) for _ in range(LENGTH))
    nonce = _b64(secrets.token_bytes(12))
    body = json.dumps(
        {"n": nonce, "h": _answer_hash(text, nonce), "e": int(time.time()) + TTL_SECONDS},
        separators=(",", ":"),
    ).encode()
    token = f"{_b64(body)}.{_sign(body)}"
    return {"token": token, "svg": render_svg(text), "expires_in": TTL_SECONDS}


def verify(token: str, answer: str) -> tuple:
    """
    Check an answer. Returns `(ok, reason)`; `reason` is user-facing Indonesian.

    Every failure is distinguishable to the CALLER, so the log and the handler
    can tell an expired token from a wrong answer, but the handler is expected
    to show the same generic wording either way, for the same reason
    `/api/login` does.
    """
    if not token or not answer:
        return False, "Captcha belum diisi."
    try:
        body_b64, sig = token.split(".", 1)
        body = _unb64(body_b64)
    except Exception:
        return False, "Captcha tidak valid."

    # compare_digest, not `==`: a plain comparison returns early on the first
    # differing byte and leaks the signature one byte at a time under timing.
    if not hmac.compare_digest(sig, _sign(body)):
        return False, "Captcha tidak valid."

    try:
        data = json.loads(body)
    except Exception:
        return False, "Captcha tidak valid."

    if int(data.get("e", 0)) < time.time():
        return False, "Captcha sudah kedaluwarsa. Muat ulang."

    nonce = data.get("n", "")
    if not hmac.compare_digest(
        data.get("h", ""), _answer_hash(answer.strip(), nonce)
    ):
        return False, "Captcha salah."

    # LAST, so a wrong answer does not burn the challenge, otherwise one typo
    # forces a reload, which is exactly the friction this is meant to avoid for
    # legitimate users.
    if not _consume(nonce):
        return False, "Captcha sudah dipakai. Muat ulang."

    return True, ""


# ── Rendering ─────────────────────────────────────────────────────────

def render_svg(text: str) -> str:
    """
    The challenge as an inline SVG string.

    Mild, legible distortion: per-character rotation, vertical jitter and
    varying font size, over a few crossing lines and scattered dots. Enough to
    defeat naive OCR run by a script; not enough to defeat a person, which is
    the trade this project wants.

    `currentColor` is used throughout so it inherits the page's text colour and
    is legible in BOTH themes without the caller passing a palette, this is
    rendered into a light and a dark login screen and into landing.html, which
    follows the system theme independently.
    """
    width, height = 190, 62
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" role="img" aria-label="Kode captcha">'
    ]

    # Noise BEHIND the glyphs, so it never obscures a stroke enough to make a
    # character ambiguous.
    for _ in range(4):
        x1, y1 = _rng.randint(0, 30), _rng.randint(4, height - 4)
        x2, y2 = _rng.randint(width - 30, width), _rng.randint(4, height - 4)
        cx, cy = _rng.randint(40, width - 40), _rng.randint(0, height)
        parts.append(
            f'<path d="M{x1},{y1} Q{cx},{cy} {x2},{y2}" fill="none" '
            f'stroke="currentColor" stroke-width="1" opacity="0.28"/>'
        )
    for _ in range(28):
        parts.append(
            f'<circle cx="{_rng.randint(0, width)}" cy="{_rng.randint(0, height)}" '
            f'r="{_rng.choice([1, 1, 1.5])}" fill="currentColor" opacity="0.22"/>'
        )

    step = (width - 24) / max(len(text), 1)
    for i, ch in enumerate(text):
        x = 16 + i * step + _rng.randint(-2, 2)
        y = height / 2 + _rng.randint(-4, 6) + 9
        size = _rng.randint(28, 34)
        angle = _rng.randint(-22, 22)
        parts.append(
            f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" '
            f'font-family="Georgia,\'Times New Roman\',serif" font-weight="700" '
            f'fill="currentColor" opacity="0.92" '
            f'transform="rotate({angle} {x:.1f} {y:.1f})">{ch}</text>'
        )

    parts.append("</svg>")
    return "".join(parts)
