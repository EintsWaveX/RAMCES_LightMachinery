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

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

import models
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
from api.schemas import LoginForm, PasswordSet, Token, UserCreate, UserUpdate

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


@router.post("/api/login", response_model=Token)
def login(form_data: LoginForm, db: Session = Depends(get_db)):
    """
    Verify a username and password and issue a 12-hour bearer token.

    ── What this endpoint deliberately does NOT do ──
    It does not create accounts. It previously registered any unknown username
    on the spot, with whatever `role` the request body claimed — so anyone who
    could reach the app typed a name, sent role="SUPER_ADMIN", and received a
    full-privilege token, which made every require_role([...]) guard behind it
    decorative. Accounts are now created only through POST /api/users/create,
    which is itself role-guarded.

    `role` and `id_lokasi` in the request body are IGNORED. Both come from the
    stored row, because a client that can choose its own role has no security
    at all. The fields remain on LoginForm only so older clients still parse.
    """
    user = db.query(models.Pengguna).filter_by(username=form_data.username).first()

    if user is None:
        # Hash anyway so a missing username and a wrong password take the same
        # time; bcrypt is slow enough that skipping it is measurable.
        verify_password(form_data.password or "", _DUMMY_HASH)
        raise HTTPException(status_code=401, detail=_LOGIN_GAGAL)

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
        raise HTTPException(status_code=401, detail=_LOGIN_GAGAL)

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


