"""
Everything that touches the filesystem: the project root, the uploads tree, the
cache policy, and conditional (304) file responses.

Why this is a module of its own rather than staying in main.py:

- `_save_upload` / `_drop_upload` are called from the master routes (alat kerja
  documents, Model/Type photos and documents) AND from the aset routes
  (calibration certificates), so they cannot live in either one.
- `file_response_conditional` is used by main.py's static routes AND by
  `serve_foto_varian` in api/master.py — the public, unauthenticated photo route.
  Leaving it in main.py would make master.py import main.py, which is the cycle
  this package exists to avoid.

PROJECT_ROOT is the one line in the whole split that can fail silently. It used
to be `os.path.dirname(os.path.abspath(__file__))` in main.py at the repo root;
copied into api/ unchanged it resolves to `…/api`, and the os.makedirs calls
below would cheerfully create `api/uploads/sertifikat/` without raising. Every
existing certificate would 404 while new uploads appeared to succeed. Hence the
double dirname and the tripwire underneath it.
"""

import os
import secrets
import shutil
from typing import Optional

from fastapi import HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

# ── Where the project lives ───────────────────────────────────────
# This file is <root>/api/files.py, so the root is two dirnames up.
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

if not os.path.isfile(os.path.join(PROJECT_ROOT, "index.html")):
    raise RuntimeError(
        f"PROJECT_ROOT salah: {PROJECT_ROOT} (index.html tidak ditemukan di sana). "
        "Uploads dan static file akan menunjuk ke direktori yang keliru."
    )

# Kept under its historical name; main.py's static routes read it.
BASE_DIR = PROJECT_ROOT


# ── Cache policy ──────────────────────────────────────────────────
# FileResponse already emits ETag and Last-Modified, but without Cache-Control
# the browser revalidates nothing and re-downloads on every navigation.
#
# Code and markup use `no-cache`, which does NOT mean "don't cache" — it means
# "cache, but revalidate": the browser sends If-None-Match and usually gets a
# 304 with an empty body. That keeps deploys instant while still avoiding the
# transfer. Images and fonts are content that only changes under a new filename,
# so they get a year.
_CACHE_REVALIDATE = "no-cache"
_CACHE_IMMUTABLE = "public, max-age=31536000, immutable"
_LONG_CACHE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".svg", ".woff", ".woff2"}

# Extensions the catch-all static route will serve, and the Content-Type each
# gets. Shared with the public Model/Type photo route so the two cannot answer
# with different headers for the same file type.
_STATIC_EXT = {
    ".html", ".js", ".css", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp",
}
_MEDIA_TYPES = {
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".css": "text/css",
    ".js": "application/javascript",
}


def _cache_control_for(ext: str) -> str:
    return _CACHE_IMMUTABLE if ext in _LONG_CACHE_EXT else _CACHE_REVALIDATE


# ── The uploads tree ──────────────────────────────────────────────
UPLOAD_DIR = os.path.join(PROJECT_ROOT, "uploads")
SERTIFIKAT_DIR = os.path.join(UPLOAD_DIR, "sertifikat")
# Model/Type attachments. The photo directory is served PUBLICLY (landing.html
# is scanned with no session); documents are Bearer-authenticated like
# certificates. Keeping them in separate directories is what makes that
# distinction impossible to get wrong at serve time.
FOTO_ALAT_DIR = os.path.join(UPLOAD_DIR, "foto_alat")
DOKUMEN_ALAT_DIR = os.path.join(UPLOAD_DIR, "dokumen_alat")

ALLOWED_CERT_EXT = {".pdf", ".png", ".jpg", ".jpeg", ".webp"}
ALLOWED_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
# Reference documents (Spek Lengkap / Manual Instruction) accept Office formats
# on top of the certificate set: the client's drop includes
# "SOP PERAWATAN PORTABLE BALLAST TAMPER.docx", which the certificate allowlist
# rejected with a 400 at download time — the file was ingested and linked, and
# then refused to open.
ALLOWED_DOK_EXT = ALLOWED_CERT_EXT | {".docx", ".doc", ".xlsx", ".xls"}
MAX_CERT_BYTES = 10 * 1024 * 1024  # 10 MB

os.makedirs(SERTIFIKAT_DIR, exist_ok=True)
os.makedirs(FOTO_ALAT_DIR, exist_ok=True)
os.makedirs(DOKUMEN_ALAT_DIR, exist_ok=True)


def _save_upload(
    upload: UploadFile,
    dest_dir: str,
    stem: str,
    allowed_ext: set,
    max_bytes: int = MAX_CERT_BYTES,
) -> str:
    """
    Persist an uploaded file and return the stored basename.

    The client-supplied name is used ONLY to read the extension — the stored
    name is generated from `stem` plus a random token, so a hostile filename
    can never influence the path written to disk. Every upload route in this
    application goes through here; do not open a second path to the filesystem.
    """
    ext = os.path.splitext(upload.filename or "")[1].lower()
    if ext not in allowed_ext:
        raise HTTPException(
            status_code=400,
            detail=f"Format tidak didukung. Gunakan: {', '.join(sorted(allowed_ext))}.",
        )

    upload.file.seek(0, os.SEEK_END)
    size = upload.file.tell()
    upload.file.seek(0)
    if size == 0:
        raise HTTPException(status_code=400, detail="Berkas kosong.")
    if size > max_bytes:
        raise HTTPException(
            status_code=400,
            detail=f"Berkas terlalu besar (maks {max_bytes // (1024 * 1024)} MB).",
        )

    stored = f"{stem}_{secrets.token_hex(8)}{ext}"
    dest = os.path.join(dest_dir, stored)
    with open(dest, "wb") as fh:
        shutil.copyfileobj(upload.file, fh)
    return stored


def _save_certificate(upload: UploadFile, id_kalibrasi: int) -> str:
    """Calibration certificate → uploads/sertifikat/."""
    return _save_upload(
        upload, SERTIFIKAT_DIR, f"kalibrasi_{id_kalibrasi}", ALLOWED_CERT_EXT
    )


def _drop_upload(dest_dir: str, stored: Optional[str]) -> None:
    """Delete a previously stored file, tolerating its absence.

    `basename` guards the same way the save path does: the column should only
    ever hold a bare filename, but a corrupted row must not let a delete escape
    the upload directory.
    """
    if not stored:
        return
    path = os.path.join(dest_dir, os.path.basename(stored))
    if os.path.isfile(path):
        try:
            os.remove(path)
        except OSError:
            pass


# ── Conditional responses ─────────────────────────────────────────
# Starlette's FileResponse emits ETag and Last-Modified but never *reads*
# If-None-Match, so it always returns 200 with the whole body. Paired with the
# `no-cache` above — which asks the browser to revalidate on every load — that
# meant index.html and all fourteen js/ files were re-sent in full every time,
# even though the point of `no-cache` is to make revalidation cheap. Measured:
# /assets/style.css (the StaticFiles mount, which does check) answered 304 while
# /, /js/*.js and /landing.html all answered 200.
#
# StaticFiles owns the conditional-request logic; borrowing its comparison keeps
# the catch-all byte-for-byte consistent with the /assets mount rather than
# growing a second, subtly different implementation.
_conditional = StaticFiles(directory=PROJECT_ROOT)


def file_response_conditional(request: Request, path: str, media_type: str = None):
    """FileResponse, downgraded to a bodyless 304 when the client's copy is current.

    `stat_result` must be passed explicitly: FileResponse only calls
    `set_stat_headers()` from its constructor when it already has one, otherwise
    it stats the file later inside `__call__`. Constructing it without one
    therefore leaves `response.headers` with no `etag` and no `last-modified` at
    all, and the comparison below silently has nothing to compare.
    """
    try:
        stat_result = os.stat(path)
    except OSError:
        raise HTTPException(status_code=404, detail="File not found.")
    response = FileResponse(path, media_type=media_type, stat_result=stat_result)
    if _conditional.is_not_modified(response.headers, request.headers):
        return Response(status_code=304, headers=response.headers)
    return response
