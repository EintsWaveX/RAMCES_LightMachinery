"""
The bootstrap SUPER_ADMIN account.

`/api/login` no longer registers unknown usernames, it used to create any name
the client sent, with whatever role the client claimed, which meant anyone
reaching the app could type a name, send role="SUPER_ADMIN" and receive a
full-privilege token. Closing that hole means a freshly seeded database has no
way in unless the seed makes one.

── The password ──

Read from `BOOTSTRAP_ADMIN_PASSWORD` in `.env`. With nothing set, a random one
is generated and printed ONCE: the database stores only a bcrypt hash, so an
unrecorded password is unrecoverable except by another SUPER_ADMIN resetting it
through Pusat Data ▸ Pengguna.

An existing account is never re-passworded. Re-running the seed against a live
system must not reset the administrator's credentials.
"""

import os
import secrets

import models

# Unambiguous alphabet, no O/0, no l/1/I, because this gets read aloud.
_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789"


def _random_password(length: int = 16) -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(length))


def run(db):
    # Imported here, not at module scope: main.py runs _ensure_schema() at
    # import time and the seed orchestrator has already done create_all().
    from main import get_password_hash

    username = (os.getenv("BOOTSTRAP_ADMIN_USERNAME") or "superadmin").strip()
    row = db.query(models.Pengguna).filter_by(username=username).first()

    if row is not None and row.hashed_password:
        print(f"  pengguna      : '{username}' sudah ada, password tidak diubah")
    else:
        password = (os.getenv("BOOTSTRAP_ADMIN_PASSWORD") or "").strip()
        generated = not password
        if generated:
            password = _random_password()

        if row is None:
            row = models.Pengguna(username=username, role="SUPER_ADMIN", id_lokasi=None)
            db.add(row)
        row.role = "SUPER_ADMIN"
        row.hashed_password = get_password_hash(password)

        print(f"  pengguna      : SUPER_ADMIN '{username}' siap")
        if generated:
            print("\n" + "!" * 62)
            print(f"  PASSWORD AWAL : {password}")
            print("  Catat sekarang. Sistem hanya menyimpan versi teracak dan")
            print("  tidak dapat menampilkannya lagi. Setel BOOTSTRAP_ADMIN_PASSWORD")
            print("  di .env untuk menentukan sendiri.")
            print("!" * 62 + "\n")

    # Accounts that predate authentication cannot log in, hashed_password is
    # NULL and login() refuses them with a message pointing at Pusat Data. Say
    # so here too, so it is not discovered at a login prompt.
    stale = (
        db.query(models.Pengguna)
        .filter(models.Pengguna.hashed_password.is_(None))
        .count()
    )
    # `SYSTEM` is excluded deliberately. It is the attribution author
    # `seeds/aset.py` stamps on all 1,121 imported RiwayatKondisi rows, imported
    # history has no human author, and inventing one would be worse than saying
    # so. It must NEVER have a password, so counting it among the accounts an
    # admin ought to fix made a fresh, correct install open with a warning about
    # itself. What remains is genuinely stranded: rows seeded before
    # authentication existed, which cannot log in until someone sets one.
    stale_real = (
        db.query(models.Pengguna)
        .filter(
            models.Pengguna.hashed_password.is_(None),
            models.Pengguna.username != "SYSTEM",
        )
        .count()
    )
    if stale_real:
        print(
            f"  ! {stale_real} akun lama tanpa password — tidak bisa masuk sampai "
            "SUPER ADMIN menyetelnya di Pusat Data ▸ Pengguna"
        )
    elif stale:
        print(
            "  · akun SYSTEM tanpa password (penulis riwayat impor, memang tidak "
            "bisa dipakai masuk)"
        )
