from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session
from datetime import datetime, timedelta
from typing import List
import bcrypt
import jwt
import os
import uuid

import models
import schemas
from database import engine, SessionLocal

models.Base.metadata.create_all(bind=engine)

app = FastAPI(title="SIMA-KAI Asset API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ------------------------------------------------------------------
# DATABASE SESSION
# ------------------------------------------------------------------

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# ------------------------------------------------------------------
# WEBSOCKET — real-time broadcast to all connected browsers
# ------------------------------------------------------------------
    
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    async def broadcast(self, message: str):
        for connection in self.active_connections:
            await connection.send_text(message)

manager = ConnectionManager()

@app.get("/api/config")
def get_config():
    ngrok_url = os.environ.get("NGROK_URL", "").rstrip("/")
    return {"ngrok_url": ngrok_url}

# ------------------------------------------------------------------
# SECURITY
# ------------------------------------------------------------------

SECRET_KEY = "KAI_warehouse_super_secret_key"  # Use env var in production
ALGORITHM  = "HS256"

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/login")

def get_password_hash(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))

def create_access_token(data: dict) -> str:
    payload = data.copy()
    payload["exp"] = datetime.utcnow() + timedelta(hours=12)
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> models.User:
    try:
        payload  = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username = payload.get("sub")
        if not username:
            raise HTTPException(status_code=401, detail="Token invalid")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Token invalid")

    user = db.query(models.User).filter(models.User.username == username).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user

def require_role(allowed_roles: list):
    def checker(current_user: models.User = Depends(get_current_user)):
        if current_user.role not in allowed_roles:
            raise HTTPException(status_code=403, detail="Anda tidak memiliki izin untuk melakukan aksi ini.")
        return current_user
    return checker

# ==================================================================
# AUTH ENDPOINTS
# ==================================================================

@app.post("/api/register")
def register_user(user: schemas.UserCreate, db: Session = Depends(get_db)):
    """
    Bootstrap endpoint — only works when zero users exist in the DB.
    After the first SUPER_ADMIN is created, this endpoint returns 403.
    Use /api/users/create for all subsequent user creation.
    """
    if db.query(models.User).count() > 0:
        raise HTTPException(status_code=403, detail="Registrasi publik ditutup. Hubungi admin.")

    if db.query(models.User).filter_by(username=user.username).first():
        raise HTTPException(status_code=400, detail="Username sudah terdaftar.")

    db.add(models.User(
        username=user.username,
        hashed_password=get_password_hash(user.password) if user.password else None,
        role=user.role,
        assigned_region=user.assigned_region
    ))
    db.commit()
    return {"message": f"User {user.username} berhasil didaftarkan sebagai {user.role}."}


# @app.post("/api/login", response_model=schemas.Token)
# def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
#     """
#     Authenticate and return a 12-hour JWT.
#     The token embeds username and role for client-side role checking.
#     """
#     user = db.query(models.User).filter_by(username=form_data.username).first()
#     if not user:
#         raise HTTPException(status_code=401, detail="Username tidak ditemukan.")
#     if user.hashed_password and not verify_password(form_data.password, user.hashed_password):
#         raise HTTPException(status_code=401, detail="Password salah.")

#     return {
#         "access_token": create_access_token({"sub": user.username, "role": user.role}),
#         "token_type": "bearer"
#     }

@app.post("/api/login", response_model=schemas.Token)
def login(form_data: schemas.LoginForm, db: Session = Depends(get_db)):
    user = db.query(models.User).filter_by(username=form_data.username).first()

    if not user:
        # First time — auto-register with provided role and region
        if not form_data.assigned_region:
            if form_data.role == "SUPER_ADMIN":
                # SUPER_ADMIN can register without a region
                form_data.assigned_region = None
            else:
                raise HTTPException(status_code=400, detail="Region wajib diisi untuk pendaftaran pertama.")
        user = models.User(
            username=form_data.username,
            hashed_password=None,
            role=form_data.role,
            assigned_region=form_data.assigned_region
        )
        db.add(user)
        db.commit()
        db.refresh(user)

    return {
        "access_token": create_access_token({"sub": user.username, "role": user.role}),
        "token_type": "bearer"
    }

@app.post("/api/users/create")
def create_user(
    user_data: schemas.UserCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_role(["SUPER_ADMIN", "ADMIN_DAOP"]))
):
    """
    Hierarchical user creation:
    - SUPER_ADMIN → can create any role with any region
    - ADMIN_DAOP  → can only create TEKNISI, region locked to their own
    """
    if db.query(models.User).filter_by(username=user_data.username).first():
        raise HTTPException(status_code=400, detail="Username sudah terdaftar.")

    if current_user.role == "ADMIN_DAOP":
        if user_data.role != "TEKNISI":
            raise HTTPException(status_code=403, detail="ADMIN_DAOP hanya bisa membuat akun TEKNISI.")
        region = current_user.assigned_region
    else:
        region = user_data.assigned_region

    db.add(models.User(
        username=user_data.username,
        hashed_password=get_password_hash(user_data.password) if user_data.password else None,
        role=user_data.role,
        assigned_region=region
    ))
    db.commit()
    return {"message": f"User {user_data.username} berhasil dibuat sebagai {user_data.role}."}

@app.delete("/api/users/me")
def delete_own_account(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    db.delete(current_user)
    db.commit()
    return {"message": f"Akun {current_user.username} berhasil dihapus."}

# ==================================================================
# WEBSOCKET
# ==================================================================

@app.websocket("/ws/updates")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        manager.disconnect(websocket)

# ==================================================================
# MASTER DATA — GET endpoints are public (no auth) so the frontend
# can populate dropdowns on login. Write ops are SUPER_ADMIN only.
# ==================================================================

# ── MASTER ALAT ───────────────────────────────────────────────────

@app.get("/api/master/alat")
def get_master_alat(db: Session = Depends(get_db)):
    """Return all active tool categories."""
    return db.query(models.MasterAlat).filter_by(aktif=True).all()

@app.post("/api/master/alat", dependencies=[Depends(require_role(["SUPER_ADMIN"]))])
def create_master_alat(data: schemas.MasterAlatCreate, db: Session = Depends(get_db)):
    if db.query(models.MasterAlat).filter_by(kode=data.kode).first():
        raise HTTPException(status_code=400, detail="Kode alat sudah ada.")
    db.add(models.MasterAlat(kode=data.kode, nama=data.nama, deskripsi=data.deskripsi))
    db.commit()
    return {"message": f"Alat {data.nama} berhasil ditambahkan."}

@app.put("/api/master/alat/{kode}", dependencies=[Depends(require_role(["SUPER_ADMIN"]))])
def update_master_alat(kode: str, data: schemas.MasterAlatCreate, db: Session = Depends(get_db)):
    item = db.query(models.MasterAlat).filter_by(kode=kode).first()
    if not item:
        raise HTTPException(status_code=404, detail="Kode alat tidak ditemukan.")
    item.nama      = data.nama
    item.deskripsi = data.deskripsi
    db.commit()
    return {"message": f"Alat {kode} berhasil diperbarui."}

@app.delete("/api/master/alat/{kode}", dependencies=[Depends(require_role(["SUPER_ADMIN"]))])
def delete_master_alat(kode: str, db: Session = Depends(get_db)):
    item = db.query(models.MasterAlat).filter_by(kode=kode).first()
    if not item:
        raise HTTPException(status_code=404, detail="Kode alat tidak ditemukan.")
    # Soft delete — preserves historical aset references
    item.aktif = False
    db.commit()
    return {"message": f"Alat {kode} berhasil dinonaktifkan."}

# ── MASTER LOKASI ─────────────────────────────────────────────────

@app.get("/api/master/lokasi")
def get_master_lokasi(db: Session = Depends(get_db)):
    """Return all active locations (PUSAT, DAOP, DIVRE, BALAIYASA)."""
    return db.query(models.Lokasi).filter_by(aktif=True).all()

@app.post("/api/master/lokasi", dependencies=[Depends(require_role(["SUPER_ADMIN"]))])
def create_master_lokasi(data: schemas.LokasiCreate, db: Session = Depends(get_db)):
    valid_tipes = ["PUSAT", "DAOP", "DIVRE", "BALAIYASA"]
    if data.tipe_lokasi not in valid_tipes:
        raise HTTPException(status_code=400, detail=f"Tipe lokasi tidak valid. Gunakan: {valid_tipes}")
    if db.query(models.Lokasi).filter_by(kode_lokasi=data.kode_lokasi).first():
        raise HTTPException(status_code=400, detail="Kode lokasi sudah ada.")
    db.add(models.Lokasi(
        kode_lokasi=data.kode_lokasi,
        nama_lokasi=data.nama_lokasi,
        tipe_lokasi=data.tipe_lokasi
    ))
    db.commit()
    return {"message": f"Lokasi {data.nama_lokasi} berhasil ditambahkan."}

@app.put("/api/master/lokasi/{kode}", dependencies=[Depends(require_role(["SUPER_ADMIN"]))])
def update_master_lokasi(kode: str, data: schemas.LokasiCreate, db: Session = Depends(get_db)):
    item = db.query(models.Lokasi).filter_by(kode_lokasi=kode).first()
    if not item:
        raise HTTPException(status_code=404, detail="Lokasi tidak ditemukan.")
    item.nama_lokasi = data.nama_lokasi
    item.tipe_lokasi = data.tipe_lokasi
    db.commit()
    return {"message": f"Lokasi {kode} berhasil diperbarui."}

@app.delete("/api/master/lokasi/{kode}", dependencies=[Depends(require_role(["SUPER_ADMIN"]))])
def delete_master_lokasi(kode: str, db: Session = Depends(get_db)):
    item = db.query(models.Lokasi).filter_by(kode_lokasi=kode).first()
    if not item:
        raise HTTPException(status_code=404, detail="Lokasi tidak ditemukan.")
    item.aktif = False
    db.commit()
    return {"message": f"Lokasi {kode} berhasil dinonaktifkan."}

# ── MASTER UPT ────────────────────────────────────────────────────

@app.get("/api/master/upt")
def get_master_upt(db: Session = Depends(get_db)):
    """Return all active UPTs across all regions."""
    return db.query(models.MasterUPT).filter_by(aktif=True).all()

@app.get("/api/master/upt/{kode_lokasi}")
def get_upt_by_lokasi(kode_lokasi: str, db: Session = Depends(get_db)):
    """Return active UPTs filtered by a specific lokasi code."""
    return db.query(models.MasterUPT).filter(
        models.MasterUPT.kode_lokasi == kode_lokasi,
        models.MasterUPT.aktif == True
    ).all()

@app.post("/api/master/upt", dependencies=[Depends(require_role(["SUPER_ADMIN"]))])
def create_master_upt(data: schemas.MasterUPTCreate, db: Session = Depends(get_db)):
    if db.query(models.MasterUPT).filter_by(nama_upt=data.nama_upt, kode_lokasi=data.kode_lokasi).first():
        raise HTTPException(status_code=400, detail="UPT sudah ada untuk lokasi ini.")
    db.add(models.MasterUPT(nama_upt=data.nama_upt, kode_lokasi=data.kode_lokasi))
    db.commit()
    return {"message": f"UPT {data.nama_upt} berhasil ditambahkan."}

@app.put("/api/master/upt/{upt_id}", dependencies=[Depends(require_role(["SUPER_ADMIN"]))])
def update_master_upt(upt_id: int, data: schemas.MasterUPTCreate, db: Session = Depends(get_db)):
    item = db.query(models.MasterUPT).filter_by(id=upt_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="UPT tidak ditemukan.")
    item.nama_upt    = data.nama_upt
    item.kode_lokasi = data.kode_lokasi
    db.commit()
    return {"message": "UPT berhasil diperbarui."}

@app.delete("/api/master/upt/{upt_id}", dependencies=[Depends(require_role(["SUPER_ADMIN"]))])
def delete_master_upt(upt_id: int, db: Session = Depends(get_db)):
    item = db.query(models.MasterUPT).filter_by(id=upt_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="UPT tidak ditemukan.")
    item.aktif = False
    db.commit()
    return {"message": "UPT berhasil dinonaktifkan."}

# ==================================================================
# ASET ENDPOINTS
# ==================================================================

@app.post("/api/aset", response_model=schemas.AsetResponse)
async def create_aset(
    aset_in: schemas.AsetCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_role(["SUPER_ADMIN", "ADMIN_DAOP"]))
):
    """
    Register a new asset.
    UID is auto-generated (WH-XXXXXXXX). kode_id must be unique.
    Status defaults to 'BARU' on creation.
    """
    if db.query(models.Aset).filter_by(kode_id=aset_in.kode_id).first():
        raise HTTPException(status_code=400, detail="Kode ID sudah terdaftar.")

    new_uid = "WH-" + str(uuid.uuid4())[:8].upper()
    db_aset = models.Aset(
        uid=new_uid,
        kode_id=aset_in.kode_id,
        kode_alat=aset_in.kode_alat,
        kode_lokasi=aset_in.kode_lokasi,
        pengadaan=aset_in.pengadaan,
        tahun_pembelian=aset_in.tahun_pembelian,
        unit_peruntukan=aset_in.unit_peruntukan,
        status_kondisi="BARU",
        creator=current_user.username
    )
    db.add(db_aset)
    db.commit()
    db.refresh(db_aset)

    await manager.broadcast("REFRESH_ASSET_LIST")
    return {
        "uid":             db_aset.uid,
        "kode_id":         db_aset.kode_id,
        "kode_alat":       db_aset.kode_alat,
        "kode_lokasi":     db_aset.kode_lokasi,
        "pengadaan":       db_aset.pengadaan,
        "tahun_pembelian": db_aset.tahun_pembelian,
        "unit_peruntukan": db_aset.unit_peruntukan,
        "status_kondisi":  db_aset.status_kondisi,
        "status":          db_aset.status_kondisi,
        "is_afkir":        db_aset.is_afkir,
        "creator":         db_aset.creator,
        "created_at":      db_aset.created_at,
        "alat":   db_aset.alat_ref.nama        if db_aset.alat_ref   else db_aset.kode_alat,
        "lokasi": db_aset.lokasi_ref.nama_lokasi if db_aset.lokasi_ref else db_aset.kode_lokasi,
    }


@app.get("/api/aset")
def get_all_aset(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Return all active (non-afkir) assets with resolved display names.
    Also includes the current lokasi so the card shows the asset's
    present location, which may differ from its original kode_lokasi
    after a mutation.
    """
    asets = db.query(models.Aset).filter_by(is_afkir=False).all()
    return [
        {
            "uid":     a.uid,
            "kode_id": a.kode_id,
            "status":  a.status_kondisi,
            "alat":    a.alat_ref.nama          if a.alat_ref   else a.kode_alat,
            "lokasi":  a.lokasi_ref.nama_lokasi  if a.lokasi_ref else a.kode_lokasi,
            "creator": a.creator
        }
        for a in asets
    ]


@app.get("/api/aset/{uid}")
def get_aset_detail(
    uid: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Return full detail for a single asset including its mutation history.
    Absorbed from main_.py's /api/aset/{id_aset} — rewritten for ORM.
    """
    aset = db.query(models.Aset).filter_by(uid=uid, is_afkir=False).first()
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")

    return {
        "uid":             aset.uid,
        "kode_id":         aset.kode_id,
        "kode_alat":       aset.kode_alat,
        "kode_lokasi":     aset.kode_lokasi,
        "pengadaan":       aset.pengadaan,
        "tahun_pembelian": aset.tahun_pembelian,
        "unit_peruntukan": aset.unit_peruntukan,
        "status":          aset.status_kondisi,
        "is_afkir":        aset.is_afkir,
        "creator":         aset.creator,
        "created_at":      aset.created_at,
        "alat":   aset.alat_ref.nama          if aset.alat_ref   else aset.kode_alat,
        "lokasi": aset.lokasi_ref.nama_lokasi  if aset.lokasi_ref else aset.kode_lokasi,
    }


@app.post("/api/aset/afkir/{uid}")
async def afkir_aset(
    uid: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_role(["SUPER_ADMIN", "ADMIN_DAOP"]))
):
    """
    Soft-delete (decommission) an asset.
    Afkir assets are hidden from all listings but their records and history
    are preserved for audit purposes.
    """
    aset = db.query(models.Aset).filter_by(uid=uid).first()
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")

    aset.is_afkir = True
    db.commit()

    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": f"Aset {aset.kode_id} telah berhasil di-afkir."}

# ==================================================================
# PERBAIKAN (REPAIR LOG)
# ==================================================================

@app.post("/api/perbaikan")
async def catat_perbaikan(
    laporan: schemas.PerbaikanCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Append-only repair log entry.
    Updates the asset's current status_kondisi as a side effect.
    Both the insert and the update are committed atomically.
    """
    aset = db.query(models.Aset).filter_by(uid=laporan.aset_uid).first()
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")

    if laporan.status_baru not in ["SO", "TSO"]:
        raise HTTPException(status_code=400, detail="Status harus SO atau TSO.")

    db.add(models.RiwayatPerbaikan(
        aset_uid=laporan.aset_uid,
        tanggal_perbaikan=laporan.tanggal_perbaikan,
        lokasi_perbaikan=laporan.lokasi_perbaikan,
        upt_perbaikan=laporan.upt_perbaikan,
        teknisi=laporan.teknisi,
        status_baru=laporan.status_baru,
        keterangan=laporan.keterangan
    ))
    aset.status_kondisi = laporan.status_baru
    db.commit()

    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": f"Data perbaikan untuk {aset.kode_id} berhasil dicatat."}


@app.get("/api/riwayat/{aset_uid}")
def get_riwayat_aset(
    aset_uid: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """Return chronological repair history for a specific asset."""
    if not db.query(models.Aset).filter_by(uid=aset_uid).first():
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")

    riwayat = (
        db.query(models.RiwayatPerbaikan)
        .filter_by(aset_uid=aset_uid)
        .order_by(models.RiwayatPerbaikan.created_at.asc())
        .all()
    )

    return [
        {
            "no":         i,
            "date":       r.created_at.strftime('%Y-%m-%d %H:%M:%S'),
            "upt":        f"{r.upt_perbaikan} ({r.lokasi_perbaikan})" if r.upt_perbaikan and r.lokasi_perbaikan else r.upt_perbaikan or "—",
            "teknisi":    r.teknisi,
            "kondisi":    r.status_baru,
            "keterangan": r.keterangan or "—",
        }
        for i, r in enumerate(riwayat, start=1)
    ]

# ==================================================================
# MUTASI (ASSET RELOCATION) — absorbed from main_.py
# ==================================================================

@app.post("/api/mutasi")
async def submit_mutasi(
    mutasi: schemas.MutasiCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_role(["SUPER_ADMIN", "ADMIN_DAOP"]))
):
    """
    Relocate an asset to a new location.
    Records the move in riwayat_mutasi and updates aset.kode_lokasi.
    Both writes are committed atomically — if either fails, neither is saved.

    Rules:
    - Source and destination must differ.
    - Asset must exist and not be afkir.
    - ADMIN_DAOP can only move assets within or from their own region.
    """
    aset = db.query(models.Aset).filter_by(uid=mutasi.aset_uid, is_afkir=False).first()
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")

    lokasi_asal = aset.kode_lokasi
    if lokasi_asal == mutasi.kode_lokasi_tuju:
        raise HTTPException(status_code=400, detail="Lokasi tujuan tidak boleh sama dengan lokasi asal.")

    # ADMIN_DAOP can only move assets that currently live in their region
    if current_user.role == "ADMIN_DAOP" and lokasi_asal != current_user.assigned_region:
        raise HTTPException(
            status_code=403,
            detail="ADMIN_DAOP hanya bisa memindahkan aset dari wilayahnya sendiri."
        )

    lokasi_tuju = db.query(models.Lokasi).filter_by(kode_lokasi=mutasi.kode_lokasi_tuju, aktif=True).first()
    if not lokasi_tuju:
        raise HTTPException(status_code=404, detail="Lokasi tujuan tidak ditemukan atau tidak aktif.")

    try:
        # 1. Append to mutation ledger
        db.add(models.RiwayatMutasi(
            aset_uid=mutasi.aset_uid,
            kode_lokasi_asal=lokasi_asal,
            kode_lokasi_tuju=mutasi.kode_lokasi_tuju,
            dilakukan_oleh=current_user.username,
            alasan=mutasi.alasan
        ))

        # 2. Update asset's current location
        aset.kode_lokasi = mutasi.kode_lokasi_tuju

        db.commit()
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Gagal memproses mutasi: {str(e)}")

    await manager.broadcast("REFRESH_ASSET_LIST")
    return {
        "message": f"Aset {aset.kode_id} berhasil dimutasi ke {lokasi_tuju.nama_lokasi}.",
        "aset_uid":         aset.uid,
        "lokasi_asal":      lokasi_asal,
        "lokasi_tuju":      mutasi.kode_lokasi_tuju,
        "dilakukan_oleh":   current_user.username,
    }


@app.get("/api/mutasi")
def get_all_mutasi(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_role(["SUPER_ADMIN", "ADMIN_DAOP"]))
):
    """
    Full mutation audit log.
    ADMIN_DAOP sees only mutations involving their own region (as source or destination).
    SUPER_ADMIN sees all.
    """
    query = db.query(models.RiwayatMutasi).order_by(models.RiwayatMutasi.created_at.desc())

    if current_user.role == "ADMIN_DAOP":
        region = current_user.assigned_region
        query = query.filter(
            (models.RiwayatMutasi.kode_lokasi_asal == region) |
            (models.RiwayatMutasi.kode_lokasi_tuju == region)
        )

    results = []
    for m in query.all():
        results.append({
            "id":               m.id,
            "aset_uid":         m.aset_uid,
            "kode_id":          m.aset_ref.kode_id if m.aset_ref else "—",
            "alat":             m.aset_ref.alat_ref.nama if (m.aset_ref and m.aset_ref.alat_ref) else "—",
            "lokasi_asal":      m.lokasi_asal.nama_lokasi if m.lokasi_asal else m.kode_lokasi_asal,
            "lokasi_tuju":      m.lokasi_tuju.nama_lokasi if m.lokasi_tuju else m.kode_lokasi_tuju,
            "dilakukan_oleh":   m.dilakukan_oleh,
            "alasan":           m.alasan or "—",
            "created_at":       m.created_at.strftime("%Y-%m-%d %H:%M:%S"),
        })
    return results


@app.get("/api/mutasi/{aset_uid}")
def get_mutasi_by_aset(
    aset_uid: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Mutation history for a single asset.
    Returns an empty list if the asset has never been relocated.
    """
    if not db.query(models.Aset).filter_by(uid=aset_uid).first():
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")

    mutasi = (
        db.query(models.RiwayatMutasi)
        .filter_by(aset_uid=aset_uid)
        .order_by(models.RiwayatMutasi.created_at.desc())
        .all()
    )

    return [
        {
            "id":             m.id,
            "lokasi_asal":    m.lokasi_asal.nama_lokasi if m.lokasi_asal else m.kode_lokasi_asal,
            "lokasi_tuju":    m.lokasi_tuju.nama_lokasi if m.lokasi_tuju else m.kode_lokasi_tuju,
            "dilakukan_oleh": m.dilakukan_oleh,
            "alasan":         m.alasan or "—",
            "created_at":     m.created_at.strftime("%Y-%m-%d %H:%M:%S"),
        }
        for m in mutasi
    ]

# ==================================================================
# STATIC FILE SERVING — must be last so API routes take priority
# ==================================================================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app.mount("/static", StaticFiles(directory=BASE_DIR), name="static")

@app.get("/")
async def serve_index():
    return FileResponse(os.path.join(BASE_DIR, "index.html"))

@app.get("/{file_name}.html")
async def serve_html(file_name: str):
    path = os.path.join(BASE_DIR, f"{file_name}.html")
    if os.path.exists(path):
        return FileResponse(path)
    raise HTTPException(status_code=404, detail="File not found.")

@app.get("/{file_name}.js")
async def serve_js(file_name: str):
    path = os.path.join(BASE_DIR, f"{file_name}.js")
    if os.path.exists(path):
        return FileResponse(path, media_type="application/javascript")
    raise HTTPException(status_code=404, detail="File not found.")

@app.get("/{file_name}.css")
async def serve_css(file_name: str):
    path = os.path.join(BASE_DIR, f"{file_name}.css")
    if os.path.exists(path):
        return FileResponse(path, media_type="text/css")
    raise HTTPException(status_code=404, detail="File not found.")