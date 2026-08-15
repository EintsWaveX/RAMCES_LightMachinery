"""
Login, the current user, and user administration.

`/api/login` used to verify no password at all and CREATED any unknown username
with whatever role the request body claimed — so anyone who could reach the app
typed a name, sent role="SUPER_ADMIN", and received a full-privilege token. The
shape that replaced it is load-bearing:

- **`login()` verifies a bcrypt hash and never creates accounts.** An unknown
  username returns 401 with the SAME generic message as a wrong password; a
  distinct "user not found" tells an attacker which usernames are real. The
  unknown path is still hashed against `_DUMMY_HASH` so both take the same time.
- **`role` and `id_lokasi` on `LoginForm` are IGNORED.** They are read from the
  stored row. The fields survive on the model only so an older client parses.
- **`POST /api/users/create` requires a password** (min 8, `validate_password`)
  and validates `role` against the closed `ROLES` tuple.
- Rows seeded before authentication have `hashed_password IS NULL`, cannot log
  in, and are flagged via `has_password` on `GET /api/users`. The hash itself is
  never sent.

`get_all_users` reads live presence off the ConnectionManager
(`manager.online_usernames()` / `presence_of()`), which is why api/realtime.py
has to be importable rather than living in main.py beside the WebSocket route.

⚠️ ROUTE ORDER ⚠️
`DELETE /api/users/me` MUST stay registered before `DELETE /api/users/{user_id}`.
Starlette matches in registration order, so with the parameterised route first
"me" was coerced to an int, failed, and returned 422 — `delete_own_account` was
unreachable for its whole life. Fixed in rev0.5.2; do not reorder them back.

ROLE CHECKS ARE ALLOW-LISTS, NEVER `!= "TEKNISI"`. The negative form silently
admits every role added after it is written, and rev0.5.2 added two
(`PETUGAS_GUDANG`, `PIMPINAN`). `USER_ADMIN_ROLES` in api/deps.py is the list;
`AW_GRANTABLE_ROLES` below is what a regional admin may hand out.

Still open here: no password expiry. Rate limiting and the failed-attempt path
live in api/ratelimit.py.
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

import models
from api import captcha, ratelimit
from api.deps import (
    ROLES,
    USER_ADMIN_ROLES,
    _DUMMY_HASH,
    assert_region_scope,
    build_region_labels,
    create_access_token,
    get_current_user,
    get_db,
    get_parent_lokasi_code,
    get_password_hash,
    require_role,
    resolve_lokasi_scope,
    validate_password,
    verify_password,
)
from api.realtime import manager
from api.schemas import (
    LoginForm,
    PasswordSet,
    RegisterForm,
    Token,
    UserApprove,
    UserCreate,
    UserUpdate,
)

router = APIRouter()

# What an ADMIN_WILAYAH may create, edit or delete. It is a REGIONAL appointment
# holder, so it staffs its own region — technicians and the warehouse clerk —
# but cannot mint another regional admin, a national read-only account, or a
# super admin. Used by create_user, update_user, delete_user and the approval
# endpoint, so the four cannot disagree about what "manage my region" means.
AW_GRANTABLE_ROLES = ("TEKNISI", "PETUGAS_GUDANG")



# One message for every failure mode below. Distinguishing "user tidak ada"
# from "password salah" tells an attacker which usernames are real, which is the
# only thing they need before guessing passwords.
_LOGIN_GAGAL = "Username atau password salah."


# What a suspended or unapproved account is told. Deliberately specific: unlike
# a wrong password, this is not something an attacker learns anything from — you
# already proved you hold the credentials — and the user genuinely needs to know
# that waiting for an admin is the next step rather than retyping.
_STATUS_PESAN = {
    "PENDING": (
        "Akun Anda masih menunggu persetujuan admin. Anda akan bisa masuk "
        "setelah disetujui."
    ),
    "DITOLAK": "Pendaftaran akun Anda ditolak. Hubungi admin wilayah Anda.",
    "NONAKTIF": "Akun Anda dinonaktifkan. Hubungi admin wilayah Anda.",
}


def _captcha_required(ip: str, username: str) -> bool:
    """
    Should this attempt have to solve a captcha?

    PROGRESSIVE: only once a bucket has already tripped. A captcha on every
    login would be a permanent tax on the people the limit is not aimed at —
    technicians signing in on a phone at a resort — to slow an attack that has
    not started. And it is never a LOCKOUT: a lockout keyed on username is a
    denial-of-service primitive, since anyone who knows a username can trigger
    it deliberately.
    """
    return ratelimit.tripped("login:ip", ip) or ratelimit.tripped(
        "login:user", (username or "").lower()
    )


@router.post("/api/login", response_model=Token)
def login(form_data: LoginForm, request: Request, db: Session = Depends(get_db)):
    """
    Verify a username and password and issue a 12-hour bearer token.

    ── What this endpoint deliberately does NOT do ──
    It does not create accounts. It previously registered any unknown username
    on the spot, with whatever `role` the request body claimed — so anyone who
    could reach the app typed a name, sent role="SUPER_ADMIN", and received a
    full-privilege token, which made every require_role([...]) guard behind it
    decorative. Accounts are now created only through POST /api/users/create or
    through the approval of a POST /api/register, both of which are guarded.

    `role` and `id_lokasi` in the request body are IGNORED. Both come from the
    stored row, because a client that can choose its own role has no security
    at all. The fields remain on LoginForm only so older clients still parse.

    ── Rate limiting ──
    Two buckets, IP and username. Tripping either does not lock anything; it
    starts requiring a captcha, and the response carries `X-Captcha-Required: 1`
    so a client that did not send one knows to show the field and retry.
    """
    ip = ratelimit.client_ip(request)
    uname = (form_data.username or "").strip()
    need_captcha = _captcha_required(ip, uname)

    ratelimit.hit("login:ip", ip)
    ratelimit.hit("login:user", uname.lower())

    if need_captcha:
        ok, alasan = captcha.verify(
            form_data.captcha_token or "", form_data.captcha_answer or ""
        )
        if not ok:
            raise HTTPException(
                status_code=401,
                detail=alasan,
                headers={"X-Captcha-Required": "1"},
            )

    user = db.query(models.Pengguna).filter_by(username=uname).first()

    if user is None:
        # Hash anyway so a missing username and a wrong password take the same
        # time; bcrypt is slow enough that skipping it is measurable.
        verify_password(form_data.password or "", _DUMMY_HASH)
        raise HTTPException(
            status_code=401,
            detail=_LOGIN_GAGAL,
            headers={"X-Captcha-Required": "1"} if _captcha_required(ip, uname) else {},
        )

    if not user.hashed_password:
        # Seeded or pre-migration rows. They cannot log in, and the message says
        # what to do rather than pretending the password was wrong.
        raise HTTPException(
            status_code=403,
            detail=(
                "Akun ini belum memiliki password. Hubungi SUPER ADMIN untuk "
                "menyetel password melalui Pusat Data ▸ Pengguna."
            ),
        )

    if not form_data.password or not verify_password(
        form_data.password, user.hashed_password
    ):
        raise HTTPException(
            status_code=401,
            detail=_LOGIN_GAGAL,
            headers={"X-Captcha-Required": "1"} if _captcha_required(ip, uname) else {},
        )

    # AFTER the password check, deliberately. Reporting "menunggu persetujuan"
    # to anyone who merely types the username would turn this endpoint into an
    # oracle for which accounts exist and what state they are in — the same
    # reason a wrong password and an unknown username share one message.
    status = (user.status or "AKTIF").upper()
    if status != "AKTIF":
        raise HTTPException(
            status_code=403,
            detail=_STATUS_PESAN.get(status, "Akun Anda tidak aktif."),
        )

    # A correct password clears the counters. Without this, someone who mistypes
    # nine times and then succeeds stays one attempt from a captcha for the next
    # quarter of an hour — punishing precisely the person this does not target.
    ratelimit.clear("login:ip", ip)
    ratelimit.clear("login:user", uname.lower())

    user.last_seen = datetime.now()
    db.commit()

    return {
        "access_token": create_access_token(
            {
                "sub": user.username,
                "role": user.role,
                "id_pengguna": user.id_pengguna,
                "id_lokasi": user.id_lokasi,
            }
        ),
        "token_type": "bearer",
    }


@router.get("/api/captcha")
def get_captcha(request: Request):
    """
    A fresh challenge: `{token, svg, expires_in}`.

    Unauthenticated by necessity — it is used by the login and registration
    forms — and therefore rate-limited itself, or it becomes a free CPU sink.
    The SVG travels inside the JSON rather than as a second `<img src>` request,
    so there is no challenge id, nothing to store, and nothing to go stale
    between two uvicorn workers. See api/captcha.py.
    """
    ip = ratelimit.client_ip(request)
    if not ratelimit.hit("captcha:ip", ip):
        raise HTTPException(
            status_code=429,
            detail="Terlalu banyak permintaan captcha. Coba lagi beberapa menit lagi.",
        )
    return captcha.issue()


@router.post("/api/register")
def register(form: RegisterForm, request: Request, db: Session = Depends(get_db)):
    """
    Self-registration. Creates a PENDING account that CANNOT log in yet.

    Three things this deliberately does not do:

      * **It does not accept a role or a region.** `RegisterForm` has no such
        fields. Letting the client choose was the escalation removed in
        rev0.5.0; an unauthenticated form that accepted them would be the same
        hole wearing a friendlier label. The role written here is an inert
        placeholder that grants nothing, and an admin assigns the real one at
        approval.
      * **It does not issue a token.** Registering is not signing in.
      * **It does not say whether the username was taken.** A registration form
        that distinguishes "sudah terdaftar" from success is a username
        enumeration oracle open to the whole internet — worse than the login
        one, because no password is needed to query it. Both answers are the
        same sentence; a genuine user who owns the name recovers through the
        admin, which is the path they need anyway.
    """
    ip = ratelimit.client_ip(request)
    if not ratelimit.hit("register:ip", ip):
        raise HTTPException(
            status_code=429,
            detail="Terlalu banyak pendaftaran dari jaringan ini. Coba lagi nanti.",
        )

    ok, alasan = captcha.verify(form.captcha_token, form.captcha_answer)
    if not ok:
        raise HTTPException(status_code=400, detail=alasan)

    username = (form.username or "").strip()
    if len(username) < 3 or len(username) > 50:
        raise HTTPException(status_code=400, detail="Username harus 3–50 karakter.")
    validate_password(form.password)

    _DITERIMA = (
        "Pendaftaran diterima. Akun Anda menunggu persetujuan admin — Anda akan "
        "bisa masuk setelah disetujui."
    )

    if db.query(models.Pengguna).filter_by(username=username).first():
        # Same sentence as success. See the docstring.
        return {"message": _DITERIMA}

    db.add(
        models.Pengguna(
            username=username,
            hashed_password=get_password_hash(form.password),
            # An inert placeholder. It is never consulted while status is
            # PENDING — login refuses the account outright — and the approval
            # endpoint overwrites it. TEKNISI is used rather than something like
            # "NONE" so the row satisfies the ROLES tuple if anything ever reads
            # it without checking status first.
            role="TEKNISI",
            id_lokasi=None,
            status="PENDING",
            nama_lengkap=(form.nama_lengkap or "").strip() or None,
            created_at=datetime.now(),
        )
    )
    db.commit()
    return {"message": _DITERIMA}


@router.post("/api/users/{user_id}/approve")
async def approve_user(
    user_id: int,
    body: UserApprove,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(require_role(list(USER_ADMIN_ROLES))),
):
    """
    Approve a PENDING registration, assigning its role and region.

    A DEDICATED endpoint rather than a `status` value on `UserUpdate`: this is
    the moment privilege is granted, and it should be findable, guardable and
    auditable on its own rather than smuggled through the general-purpose edit
    form alongside a role change.
    """
    user = db.query(models.Pengguna).filter_by(id_pengguna=user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Pengguna tidak ditemukan.")
    if (user.status or "").upper() != "PENDING":
        raise HTTPException(
            status_code=400, detail="Hanya akun berstatus PENDING yang bisa disetujui."
        )

    if body.role not in ROLES:
        raise HTTPException(status_code=400, detail=f"Peran tidak dikenal: {body.role}")

    # A regional admin staffs its own region and cannot mint a peer, a national
    # read-only account or a super admin — the same list create_user, update_user
    # and delete_user use, so the four cannot disagree about what the appointment
    # means.
    if current_user.role == "ADMIN_WILAYAH":
        if body.role not in AW_GRANTABLE_ROLES:
            raise HTTPException(
                status_code=403,
                detail=f"ADMIN WILAYAH hanya bisa menyetujui peran: {', '.join(AW_GRANTABLE_ROLES)}.",
            )
        assert_region_scope(
            db, current_user, body.id_lokasi,
            "Hanya bisa menyetujui pengguna di wilayah Anda.",
        )

    user.role = body.role
    user.id_lokasi = body.id_lokasi or None
    user.status = "AKTIF"
    user.approved_by = current_user.id_pengguna
    user.approved_at = datetime.now()
    db.commit()
    await manager.broadcast("REFRESH_PRESENCE")
    return {"message": f"Akun {user.username} disetujui sebagai {body.role}."}


@router.post("/api/users/{user_id}/tolak")
async def reject_user(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(require_role(list(USER_ADMIN_ROLES))),
):
    """
    Reject a PENDING registration.

    The row is KEPT with `status='DITOLAK'` rather than deleted, for two
    reasons: deleting frees the username for immediate re-registration, which
    makes rejection meaningless against anyone persistent; and a rejected
    application is a fact an admin may need to look up later.
    """
    user = db.query(models.Pengguna).filter_by(id_pengguna=user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Pengguna tidak ditemukan.")
    if (user.status or "").upper() != "PENDING":
        raise HTTPException(
            status_code=400, detail="Hanya akun berstatus PENDING yang bisa ditolak."
        )

    user.status = "DITOLAK"
    user.approved_by = current_user.id_pengguna
    user.approved_at = datetime.now()
    db.commit()
    await manager.broadcast("REFRESH_PRESENCE")
    return {"message": f"Pendaftaran {user.username} ditolak."}


@router.get("/api/me")
def get_me(
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    The logged-in user plus their resolved home region.

    `default_region` is the DAOP/DIVRE/BALAIYASA the UI should preselect: a user
    may be assigned a UPT code (JR1.3), a parent code (D1), or nothing at all.
    Resolving it here keeps the parent-derivation rule in one place instead of
    making the frontend re-implement it.
    """
    own = current_user.id_lokasi or ""
    default_region = get_parent_lokasi_code(own) or own
    _ids, parent, _children = resolve_lokasi_scope(db, default_region)
    region_name, region_label, kota = build_region_labels(parent, default_region, db)
    return {
        "username": current_user.username,
        "role": current_user.role,
        "id_pengguna": current_user.id_pengguna,
        "id_lokasi": current_user.id_lokasi,
        "default_region": default_region,
        "region_name": region_name,
        "region_label": region_label,
        "kota": kota,
    }


@router.post("/api/users/create")
def create_user(
    user_data: UserCreate,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(
        require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"])
    ),
):
    if db.query(models.Pengguna).filter_by(username=user_data.username).first():
        raise HTTPException(status_code=400, detail="Username sudah terdaftar.")

    if current_user.role == "ADMIN_WILAYAH":
        if user_data.role not in AW_GRANTABLE_ROLES:
            raise HTTPException(
                status_code=403,
                detail=f"ADMIN_WILAYAH hanya bisa membuat akun: "
                       f"{', '.join(AW_GRANTABLE_ROLES)}.",
            )
        region = current_user.id_lokasi
    else:
        region = user_data.id_lokasi

    if user_data.role not in ROLES:
        raise HTTPException(
            status_code=400, detail=f"Role tidak dikenal: {user_data.role!r}."
        )

    # Required, not optional. A row with no hash cannot log in at all now, so
    # creating one silently would hand the admin a broken account.
    validate_password(user_data.password)

    db.add(
        models.Pengguna(
            username=user_data.username,
            hashed_password=get_password_hash(user_data.password),
            role=user_data.role,
            id_lokasi=region,
            # An admin-created account is active immediately — the approval step
            # exists to vet SELF-registration, and an admin creating an account
            # has already done the vetting.
            status="AKTIF",
            nama_lengkap=(user_data.nama_lengkap or "").strip() or None,
            created_at=datetime.now(),
        )
    )
    db.commit()
    return {"message": f"User {user_data.username} berhasil dibuat."}


@router.post("/api/users/{id_pengguna}/password")
def set_user_password(
    id_pengguna: int,
    data: PasswordSet,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    Set a password — either your own (old password required) or, as SUPER_ADMIN,
    anyone's (a reset, no old password needed).

    This is what makes the "akun belum memiliki password" state recoverable:
    every seeded or pre-migration row is unusable until a SUPER_ADMIN sets one
    here, and there is no other way in.
    """
    target = db.query(models.Pengguna).filter_by(id_pengguna=id_pengguna).first()
    if not target:
        raise HTTPException(status_code=404, detail="Pengguna tidak ditemukan.")

    is_self = target.id_pengguna == current_user.id_pengguna
    if not is_self and current_user.role != "SUPER_ADMIN":
        raise HTTPException(
            status_code=403, detail="Hanya SUPER ADMIN yang dapat menyetel password lain."
        )

    # Changing your own password proves you know the current one — otherwise an
    # unattended session becomes a permanent account takeover.
    if is_self and target.hashed_password:
        if not data.password_lama or not verify_password(
            data.password_lama, target.hashed_password
        ):
            raise HTTPException(status_code=400, detail="Password lama salah.")

    validate_password(data.password_baru)
    target.hashed_password = get_password_hash(data.password_baru)
    db.commit()
    return {"message": f"Password {target.username} berhasil diperbarui."}


@router.get("/api/users")
def get_all_users(
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    # Allow-list, not `!= "TEKNISI"`: the negative form silently admitted every
    # role added after it was written, and rev0.5.2 added two.
    if current_user.role not in USER_ADMIN_ROLES:
        raise HTTPException(status_code=403, detail="Akses ditolak.")

    query = db.query(models.Pengguna)
    if current_user.role == "ADMIN_WILAYAH":
        # Through resolve_lokasi_scope, never a bare `==`. A token carries a
        # PARENT code (D1) while the users it manages carry UPT codes (JR1.7),
        # so the equality form matched nothing and a regional admin saw an empty
        # user list — the exact failure this helper's docstring describes.
        scope, _parent, _children = resolve_lokasi_scope(db, current_user.id_lokasi)
        query = query.filter(
            models.Pengguna.id_lokasi.in_(scope or [current_user.id_lokasi]),
            models.Pengguna.role.in_(
                ["ADMIN_WILAYAH", "PETUGAS_GUDANG", "TEKNISI"]
            ),
        )

    users = query.order_by(models.Pengguna.role, models.Pengguna.username).all()

    # "Online" means an open WebSocket right now — not a recent last_seen, which
    # would keep showing people as present long after they closed the tab.
    online = manager.online_usernames()
    lokasi_names = {
        l.id_lokasi: l.nama_lokasi for l in db.query(models.Lokasi).all()
    }

    result = []
    for u in users:
        pres = manager.presence_of(u.username)
        result.append(
            {
                "id_pengguna": u.id_pengguna,
                "username": u.username,
                "role": u.role,
                "id_lokasi": u.id_lokasi,
                "nama_lokasi": lokasi_names.get(u.id_lokasi) or u.id_lokasi,
                # Whether the account can log in at all. The HASH is never sent —
                # only the fact that one exists — so Pusat Data can flag rows
                # that predate authentication and are therefore locked out.
                "has_password": bool(u.hashed_password),
                # AKTIF | PENDING | DITOLAK | NONAKTIF. Pusat Data ▸ Pengguna
                # renders PENDING rows as an approvals queue — without this the
                # only way to find a registration would be to notice a new name.
                "status": (u.status or "AKTIF").upper(),
                "nama_lengkap": u.nama_lengkap,
                "created_at": u.created_at.strftime("%Y-%m-%d %H:%M:%S")
                if u.created_at
                else None,
                "online": u.username in online,
                "last_seen": u.last_seen.strftime("%Y-%m-%d %H:%M:%S")
                if u.last_seen
                else None,
                # Live view wins over the persisted one: the column is only a
                # fallback for someone who is currently offline.
                "last_view": pres.get("view") or u.last_view,
                "aktif_sejak": pres.get("since").strftime("%Y-%m-%d %H:%M:%S")
                if pres.get("since")
                else None,
            }
        )
    return result


@router.put("/api/users/{user_id}")
def update_user(
    user_id: int,
    data: UserUpdate,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    if current_user.role not in USER_ADMIN_ROLES:
        raise HTTPException(status_code=403, detail="Akses ditolak.")

    target = db.query(models.Pengguna).filter_by(id_pengguna=user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User tidak ditemukan.")

    if current_user.role == "ADMIN_WILAYAH":
        assert_region_scope(
            db, current_user, target.id_lokasi,
            "Hanya bisa mengedit user di region Anda.",
        )
        # An ADMIN_WILAYAH must not be able to promote anyone past itself, nor
        # grant a role it cannot create.
        if data.role not in AW_GRANTABLE_ROLES:
            raise HTTPException(
                status_code=403,
                detail=f"ADMIN_WILAYAH hanya bisa memberi peran: "
                       f"{', '.join(AW_GRANTABLE_ROLES)}.",
            )
        data.id_lokasi = current_user.id_lokasi

    if current_user.id_pengguna == target.id_pengguna:
        raise HTTPException(
            status_code=400, detail="Tidak bisa mengedit akun sendiri dari menu ini."
        )

    # Suspend / reinstate only. PENDING and DITOLAK are reachable ONLY through
    # /approve and /tolak: granting privilege is a distinct act and belongs on a
    # route that can be found and audited, not on a value smuggled through the
    # general-purpose edit form. Sending either here is a 400, not a silent
    # no-op, because a rejected value that appears to save is worse than an
    # error.
    if data.status is not None:
        want = (data.status or "").strip().upper()
        if want not in ("AKTIF", "NONAKTIF"):
            raise HTTPException(
                status_code=400,
                detail="Status hanya bisa AKTIF atau NONAKTIF di sini. "
                       "Gunakan /approve atau /tolak untuk akun PENDING.",
            )
        if (target.status or "AKTIF").upper() == "PENDING":
            raise HTTPException(
                status_code=400,
                detail="Akun PENDING harus disetujui atau ditolak, bukan diubah statusnya.",
            )
        target.status = want

    target.role = data.role
    target.id_lokasi = data.id_lokasi
    db.commit()
    return {"message": "User berhasil diperbarui."}


# Registered BEFORE /api/users/{user_id}. Starlette matches in registration
# order, so with the parameterised route first "me" was coerced to an int,
# failed, and returned 422 — delete_own_account was unreachable for its whole
# life. The literal path must come first; this is the ordering, not a
# preference.
@router.delete("/api/users/me")
def delete_own_account(
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    db.delete(current_user)
    db.commit()
    return {"message": "Akun berhasil dihapus."}


@router.delete("/api/users/{user_id}")
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    if current_user.role not in USER_ADMIN_ROLES:
        raise HTTPException(status_code=403, detail="Akses ditolak.")
    target = db.query(models.Pengguna).filter_by(id_pengguna=user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User tidak ditemukan.")
    if current_user.id_pengguna == target.id_pengguna:
        raise HTTPException(
            status_code=400, detail="Tidak bisa menghapus akun sendiri dari sini."
        )
    # There was NO region check here at all, so an ADMIN_WILAYAH could delete
    # any user id it liked — including a SUPER_ADMIN. `update_user` above had
    # one and this did not, which is the kind of asymmetry that only shows up
    # when the two are read side by side.
    if current_user.role == "ADMIN_WILAYAH":
        assert_region_scope(
            db, current_user, target.id_lokasi,
            "Hanya bisa menghapus user di region Anda.",
        )
        if target.role not in AW_GRANTABLE_ROLES:
            raise HTTPException(
                status_code=403,
                detail="ADMIN_WILAYAH tidak bisa menghapus akun setingkat atau di atasnya.",
            )

    db.delete(target)
    db.commit()
    return {"message": "User berhasil dihapus."}


