"""
Self-registration, approval, the captcha, and the rate limiter.

    py -3.10 tools/verify/test_auth.py      # needs the app on :8017

All of this is new in rev0.4.2 and none of it existed to be regression-tested
before: `/api/login` had NO rate limiting of any kind, and there was no
registration path at all.

Four properties are worth holding, because each was a deliberate decision that a
later change could quietly undo:

  * the captcha is **progressive** — absent on a first attempt, demanded only
    once a bucket trips — and is **never a lockout**, because a lockout keyed on
    username is a denial-of-service primitive: anyone who knows a username could
    lock its owner out by failing deliberately;
  * a successful login **clears its counters**, so a user who mistypes nine times
    and then succeeds is not one attempt from a captcha for the next quarter of
    an hour. This is also what stops the rest of this harness tripping the
    limiter on itself — every other script here logs in repeatedly;
  * registration does not reveal whether a username is taken. An unauthenticated
    form that distinguishes "sudah terdaftar" from success is a username
    enumeration oracle open to anyone, with no password needed to query it;
  * `get_current_user` checks `status`, so suspending an account kills the
    12-hour token it is already holding rather than waiting for it to expire.

Creates one account, `_verif_reg_user`, and deletes it again. The failed-login
attempts against `_verif_rl_user` never create anything — login does not create
accounts, which is itself the rev0.5.0 fix.
"""

import base64
import json
import os
import re
import sys

# The Windows console defaults to cp1252 and cannot encode the ✓ / ✗ / · markers
# these scripts print. Without this a FAILING run died inside print() rather
# than reporting the failure — the one moment the output matters most.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT)

import requests  # noqa: E402
from dotenv import load_dotenv  # noqa: E402

from smoke import _env  # noqa: E402

# Before importing api.captcha. This script verifies the token IN PROCESS as
# well as over HTTP, and `_secret()` derives its signing key from SECRET_KEY and
# raises without it — deliberately, because a captcha with a constant key is not
# a captcha. Loading .env here is what makes the two processes agree.
load_dotenv(os.path.join(ROOT, ".env"))

BASE = "http://127.0.0.1:8017"
PW = _env("BOOTSTRAP_ADMIN_PASSWORD")

ok = fail = 0


def check(label, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  ok   {label}")
    else:
        fail += 1
        print(f"  FAIL {label}   {detail}")


def note(label, detail=""):
    print(f"  ·    {label}   {detail}")


class LimiterHot(Exception):
    """The captcha bucket is spent — not a contract failure."""


def solve():
    """
    A fresh challenge, solved by reading the glyphs back out of the SVG.

    This proves the ROUND TRIP, not the difficulty. The distortion exists to
    cost a bot more than a `<text>` query costs; here we are reading the
    server's own response before it is ever rasterised, which is a thing only
    something already inside the response can do.
    """
    c = requests.get(f"{BASE}/api/captcha")
    if c.status_code == 429:
        raise LimiterHot()
    j = c.json()
    return j["token"], "".join(re.findall(r">([A-Z0-9])</text>", j["svg"]))


def limiter_is_hot():
    """
    True when a previous run's buckets have not expired yet.

    THIS SCRIPT EXHAUSTS THE LIMITS IT TESTS — that is unavoidable, and it is
    the one thing here that is not idempotent. Running it twice inside five
    minutes would otherwise report the progressive-captcha assertions as broken
    when they are simply already tripped, which is the worst kind of false
    negative: it looks exactly like the regression it is meant to catch.
    """
    return requests.get(f"{BASE}/api/captcha").status_code == 429


def captcha_crypto():
    """The token itself, verified in-process against api/captcha.py."""
    from api import captcha as cap

    print("\n1. Captcha token")
    r = requests.get(f"{BASE}/api/captcha")
    j = r.json()
    check("GET /api/captcha 200", r.ok)
    check("returns token + svg", "token" in j and j["svg"].startswith("<svg"))
    # currentColor, so one challenge is legible in the light login screen, the
    # dark one, and landing.html — which follows the system theme independently.
    check("svg uses currentColor (theme-agnostic)", "currentColor" in j["svg"])

    letters = re.findall(r">([A-Z0-9])</text>", j["svg"])
    check("svg carries 5 glyphs", len(letters) == 5, letters)
    answer = "".join(letters)

    check("solving it verifies", cap.verify(j["token"], answer)[0])
    check("replay is refused", not cap.verify(j["token"], answer)[0])

    j2 = requests.get(f"{BASE}/api/captcha").json()
    check("wrong answer refused", not cap.verify(j2["token"], "ZZZZZ")[0])
    # The nonce is consumed LAST, so one typo does not force a reload — which is
    # exactly the friction a progressive captcha exists to avoid.
    check(
        "wrong answer does NOT burn the challenge",
        cap.verify(j2["token"], "".join(re.findall(r">([A-Z0-9])</text>", j2["svg"])))[0],
    )
    check("tampered token refused", not cap.verify(j2["token"][:-3] + "aaa", "AAAAA")[0])
    check("no O/0/I/l/1 in the alphabet", not (set("O0Il1") & set(cap.ALPHABET)))


def registration_and_approval():
    print("\n2. Registration, approval, suspension")
    user = "_verif_reg_user"

    token, ans = solve()
    r = requests.post(
        f"{BASE}/api/register",
        json={
            "username": user,
            "password": "rahasia12345",
            "nama_lengkap": "Verifikasi Otomatis",
            "captcha_token": token,
            "captcha_answer": ans,
        },
    )
    check("POST /api/register 200", r.ok, r.text[:140])

    token, ans = solve()
    r2 = requests.post(
        f"{BASE}/api/register",
        json={
            "username": user,
            "password": "lainlain12345",
            "captcha_token": token,
            "captcha_answer": ans,
        },
    )
    check(
        "a taken username is NOT an oracle (same body as success)",
        r2.ok and r2.json() == r.json(),
        r2.text[:140],
    )

    r3 = requests.post(
        f"{BASE}/api/register",
        json={"username": "_verif_nocap", "password": "rahasia12345",
              "captcha_token": "", "captcha_answer": ""},
    )
    check("register without a captcha is refused", r3.status_code in (400, 422), r3.status_code)

    r = requests.post(f"{BASE}/api/login", json={"username": user, "password": "rahasia12345"})
    check("PENDING account cannot log in (403)", r.status_code == 403, r.status_code)
    check("...and is told to wait for an admin", "persetujuan" in r.text.lower(), r.text[:100])

    sa = requests.post(f"{BASE}/api/login", json={"username": "superadmin", "password": PW})
    check("superadmin login", sa.ok, sa.text[:140])
    if not sa.ok:
        return None
    hdr = {"Authorization": f"Bearer {sa.json()['access_token']}"}

    users = requests.get(f"{BASE}/api/users", headers=hdr).json()
    row = next((u for u in users if u["username"] == user), None)
    check("PENDING row appears in /api/users", row and row["status"] == "PENDING", row)
    check("nama_lengkap surfaced", row and row["nama_lengkap"] == "Verifikasi Otomatis")
    # The registrant chose neither. Both are assigned at approval.
    check("region is NULL until approved", row and not row["id_lokasi"], row)
    if not row:
        return None

    uid = row["id_pengguna"]
    r = requests.post(
        f"{BASE}/api/users/{uid}/approve",
        headers=hdr,
        json={"role": "PETUGAS_GUDANG", "id_lokasi": "D1"},
    )
    check("approve 200", r.ok, r.text[:140])

    r = requests.post(f"{BASE}/api/login", json={"username": user, "password": "rahasia12345"})
    check("approved account CAN log in", r.ok, r.text[:140])
    if not r.ok:
        return uid
    tok = r.json()["access_token"]
    payload = json.loads(base64.urlsafe_b64decode(tok.split(".")[1] + "=="))
    check("token carries the ASSIGNED role, not a claimed one",
          payload["role"] == "PETUGAS_GUDANG", payload)

    r = requests.post(f"{BASE}/api/users/{uid}/approve", headers=hdr, json={"role": "TEKNISI"})
    check("re-approving a non-PENDING account is 400", r.status_code == 400, r.status_code)

    # The point of checking status in get_current_user rather than only in login.
    r = requests.put(
        f"{BASE}/api/users/{uid}",
        headers=hdr,
        json={"role": "PETUGAS_GUDANG", "id_lokasi": "D1", "status": "NONAKTIF"},
    )
    check("suspend via PUT 200", r.ok, r.text[:140])
    r = requests.get(f"{BASE}/api/me", headers={"Authorization": f"Bearer {tok}"})
    check("the LIVE token stops working immediately (401)", r.status_code == 401, r.status_code)

    r = requests.put(
        f"{BASE}/api/users/{uid}",
        headers=hdr,
        json={"role": "PETUGAS_GUDANG", "id_lokasi": "D1", "status": "PENDING"},
    )
    check("PUT cannot set PENDING — /approve and /tolak own that (400)",
          r.status_code == 400, r.status_code)
    return uid


def rate_limiting(exhaust=False):
    print("\n3. Rate limiting and the progressive captcha")

    # A per-run username, so the `login:user` bucket (10 / 15 min) is always
    # fresh. Without it a second run inside a quarter of an hour would find the
    # bucket already tripped and report "the first failure asks for no captcha"
    # as broken, when it is simply not the first failure any more.
    user = f"_verif_rl_{os.getpid()}"

    # `login:ip` (20 / 5 min) is shared with every other script in this harness
    # and cannot be made per-run. If it is already hot, the progressive
    # assertions are unmeasurable rather than false.
    # A DIFFERENT username, so the probe does not consume one of the ten
    # attempts the loop below is counting — it did, and the trip landed at 9.
    probe = requests.post(
        f"{BASE}/api/login",
        json={"username": f"_verif_probe_{os.getpid()}", "password": "x"},
    )
    if probe.headers.get("X-Captcha-Required") == "1":
        note("login:ip bucket already hot from an earlier run",
             "progressive assertions skipped — wait 5 minutes for a clean read")
        return

    first_hdr = None
    tripped_at = None
    r = None
    for i in range(1, 26):
        r = requests.post(f"{BASE}/api/login", json={"username": user, "password": "salahsalah"})
        if i == 1:
            first_hdr = r.headers.get("X-Captcha-Required")
        if r.headers.get("X-Captcha-Required") == "1" and tripped_at is None:
            tripped_at = i
        if r.status_code == 429:
            break

    check("the FIRST failure asks for no captcha (progressive)", first_hdr is None, first_hdr)
    check("captcha demanded once the login:user bucket trips (10)",
          tripped_at == 10, f"tripped at attempt {tripped_at}")
    # Never 423/429 on login: a tripped bucket asks for a captcha, it does not
    # lock the account, because a username-keyed lockout is a DoS primitive.
    check("...and it is never a lockout: still 401", r.status_code == 401, r.status_code)

    r = requests.post(f"{BASE}/api/login", json={"username": user, "password": "salahsalah"})
    check("tripped + no captcha -> 'Captcha belum diisi'", "belum diisi" in r.text, r.text[:110])

    token, ans = solve()
    r = requests.post(
        f"{BASE}/api/login",
        json={"username": user, "password": "salahsalah",
              "captcha_token": token, "captcha_answer": ans},
    )
    check("tripped + correct captcha -> falls through to the password check",
          "Username atau password" in r.text, r.text[:110])

    r2 = requests.post(
        f"{BASE}/api/login",
        json={"username": user, "password": "salahsalah",
              "captcha_token": token, "captcha_answer": ans},
    )
    check("the SERVER refuses a replayed captcha", "dipakai" in r2.text, r2.text[:110])

    token, ans = solve()
    r = requests.post(
        f"{BASE}/api/login",
        json={"username": "superadmin", "password": PW,
              "captcha_token": token, "captcha_answer": ans},
    )
    check("real credentials + captcha still get in", r.ok, f"{r.status_code} {r.text[:110]}")

    # Without this the whole rest of the harness would eventually trip the
    # limiter on itself — every browser script here signs in repeatedly.
    r = requests.post(f"{BASE}/api/login", json={"username": "superadmin", "password": PW})
    check("success CLEARED the counters (no captcha next time)",
          r.ok and r.headers.get("X-Captcha-Required") is None,
          f"{r.status_code} {r.headers.get('X-Captcha-Required')}")

    # LAST, and opt-in. It burns the `captcha:ip` bucket for five minutes, which
    # would make an immediate re-run of this script fail at its very first
    # assertion — so it is off unless asked for.
    if exhaust:
        codes = [requests.get(f"{BASE}/api/captcha").status_code for _ in range(40)]
        check("/api/captcha is itself rate-limited (429 seen)", 429 in codes,
              sorted(set(codes)))
    else:
        note("captcha:ip exhaustion not run",
             "pass --exhaust to check it (burns the bucket for 5 minutes)")


def cleanup():
    """Remove the account this script created, and say how many."""
    from sqlalchemy import create_engine, text

    eng = create_engine(os.environ["DATABASE_URL"])
    with eng.begin() as conn:
        n = conn.execute(
            text(r"delete from pengguna where username like '\_verif\_%'")
        ).rowcount
        total = conn.execute(text("select count(*) from pengguna")).scalar()
    print(f"\n  cleanup: removed {n} test account(s); pengguna = {total}")


def main():
    exhaust = "--exhaust" in sys.argv

    if limiter_is_hot():
        print(
            "The captcha:ip bucket is spent from an earlier run.\n"
            "This script exhausts the limits it tests, so it is the one thing in\n"
            "tools/verify/ that is not immediately re-runnable. Wait ~5 minutes,\n"
            "or restart the app — the buckets are in-process.\n"
        )
        return 2

    try:
        captcha_crypto()
        registration_and_approval()
        rate_limiting(exhaust=exhaust)
    except LimiterHot:
        print("\n  ! ran out of captcha budget mid-run — see the note above")
        cleanup()
        return 2

    cleanup()
    print(f"\n{ok} ok, {fail} FAIL")
    if fail:
        print("\n✗ auth/captcha/rate-limit contract broken")
        return 1
    print("\nOK — registration, approval, captcha and rate limiting all hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
