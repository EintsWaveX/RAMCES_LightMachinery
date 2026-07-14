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

# Import from our previous files
import models
import schemas
from database import engine, SessionLocal

# Create all tables in the PostgreSQL database (if they don't exist yet)
models.Base.metadata.create_all(bind=engine)

app = FastAPI(title="Warehouse Asset API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Dependency to get the database session
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# Keep a list of all active browser connections
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

# --- SECURITY CONFIGURATION ---
SECRET_KEY = "KAI_warehouse_super_secret_key"  # Change this in production
ALGORITHM  = "HS256"

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/login")

def get_password_hash(password):
    pwd_bytes = password.encode('utf-8')
    return bcrypt.hashpw(pwd_bytes, bcrypt.gensalt()).decode('utf-8')

def verify_password(plain_password, hashed_password):
    pwd_bytes    = plain_password.encode('utf-8')
    hashed_bytes = hashed_password.encode('utf-8')
    return bcrypt.checkpw(pwd_bytes, hashed_bytes)

def create_access_token(data: dict):
    to_encode = data.copy()
    expire    = datetime.utcnow() + timedelta(hours=12)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    try:
        payload  = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise HTTPException(status_code=401, detail="Token invalid")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Token invalid")

    user = db.query(models.User).filter(models.User.username == username).first()
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")
    return user

def require_role(allowed_roles: list):
    def role_checker(current_user: models.User = Depends(get_current_user)):
        if current_user.role not in allowed_roles:
            raise HTTPException(
                status_code=403,
                detail="Anda tidak memiliki izin untuk melakukan aksi ini."
            )
        return current_user
    return role_checker

# ---------------------------------------------------------
# ENDPOINT 0.1: USER AUTHENTICATION
# ---------------------------------------------------------
@app.post("/api/register")
def register_user(user: schemas.UserCreate, db: Session = Depends(get_db)):
    """
    Register a new user.
    This endpoint is only available if there are no users in the database.
    Once a user exists, registration is closed to the public.
    """
    
    user_count = db.query(models.User).count()
    if user_count > 0:
        raise HTTPException(status_code=403, detail="Registrasi publik ditutup. Hubungi admin.")

    db_user = db.query(models.User).filter(models.User.username == user.username).first()
    if db_user:
        raise HTTPException(status_code=400, detail="Username sudah terdaftar")

    hashed_pw = get_password_hash(user.password)
    new_user  = models.User(
        username=user.username,
        hashed_password=hashed_pw,
        role=user.role,
        assigned_region=user.assigned_region
    )

    db.add(new_user)
    db.commit()
    return {"message": f"User {user.username} berhasil didaftarkan sebagai {user.role}"}

# ---------------------------------------------------------
# ENDPOINT 0.2: LOGIN & GET TOKEN
# ---------------------------------------------------------
@app.post("/api/login", response_model=schemas.Token)
def login_for_access_token(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    """
    Login and retrieve access token.
    The token is valid for 12 hours and must be included in the Authorization header for protected endpoints.
    """
    
    user = db.query(models.User).filter(models.User.username == form_data.username).first()

    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Username atau password salah")

    access_token = create_access_token(data={"sub": user.username, "role": user.role})
    return {"access_token": access_token, "token_type": "bearer"}

# ---------------------------------------------------------
# ENDPOINT 0.3: WEBSOCKET FOR REAL-TIME UPDATES
# ---------------------------------------------------------
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

# ---------------------------------------------------------
# ENDPOINT 1: INPUT ALAT KERJA BARU
# ---------------------------------------------------------
@app.post("/api/aset", response_model=schemas.AsetResponse)
async def create_aset(
    aset_in: schemas.AsetCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_role(["SUPER_ADMIN", "ADMIN_DAOP"]))
):
    """
    Create a new asset.
    - Only SUPER_ADMIN and ADMIN_DAOP can create assets.
    - The asset's UID is auto-generated and returned in the response.
    - The creator field is automatically set to the current user's username.
    """

    existing_aset = db.query(models.Aset).filter(models.Aset.kode_id == aset_in.kode_id).first()
    if existing_aset:
        raise HTTPException(status_code=400, detail="Kode ID sudah terdaftar.")

    new_uid  = "WH-" + str(uuid.uuid4())[:8].upper()
    db_aset  = models.Aset(
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
        "uid":              db_aset.uid,
        "kode_id":          db_aset.kode_id,
        "kode_alat":        db_aset.kode_alat,
        "kode_lokasi":      db_aset.kode_lokasi,
        "pengadaan":        db_aset.pengadaan,
        "tahun_pembelian":  db_aset.tahun_pembelian,
        "unit_peruntukan":  db_aset.unit_peruntukan,
        "status_kondisi":   db_aset.status_kondisi,
        "status":           db_aset.status_kondisi,
        "is_afkir":         db_aset.is_afkir,
        "creator":          db_aset.creator,
        "created_at":       db_aset.created_at,
        "alat":   db_aset.katalog.nama_alat    if db_aset.katalog    else db_aset.kode_alat,
        "lokasi": db_aset.lokasi_ref.nama_lokasi if db_aset.lokasi_ref else db_aset.kode_lokasi,
    }

# ---------------------------------------------------------
# ENDPOINT 2: UPDATE KONDISI & CATAT RIWAYAT
# ---------------------------------------------------------
@app.post("/api/perbaikan")
async def catat_perbaikan(
    laporan: schemas.PerbaikanCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Record a repair/maintenance entry for an asset.
    - The asset's status is updated to the new status provided.
    - Only authenticated users can record repairs.
    - The repair entry includes the date, location, UPT, technician, new status,
      and optional notes.
    """
    
    aset = db.query(models.Aset).filter(models.Aset.uid == laporan.aset_uid).first()
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")

    if laporan.status_baru not in ["SO", "TSO"]:
        raise HTTPException(status_code=400, detail="Status harus SO atau TSO.")

    riwayat = models.RiwayatPerbaikan(
        aset_uid=laporan.aset_uid,
        tanggal_perbaikan=laporan.tanggal_perbaikan,
        lokasi_perbaikan=laporan.lokasi_perbaikan,
        upt_perbaikan=laporan.upt_perbaikan,
        teknisi=laporan.teknisi,
        status_baru=laporan.status_baru,
        keterangan=laporan.keterangan
    )

    aset.status_kondisi = laporan.status_baru

    db.add(riwayat)
    db.commit()

    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": f"Data perbaikan untuk {aset.kode_id} berhasil dicatat."}

# ---------------------------------------------------------
# ENDPOINT 3: AMBIL SEMUA DATA ASET (requires auth)
# ---------------------------------------------------------
@app.get("/api/aset")
def get_all_aset(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """
    Retrieve a list of all active assets.
    """
    
    asets = db.query(models.Aset).filter(models.Aset.is_afkir == False).all()

    results = []
    for a in asets:
        results.append({
            "uid":     a.uid,
            "kode_id": a.kode_id,
            "status":  a.status_kondisi,
            "alat":    a.katalog.nama_alat    if a.katalog    else "Unknown",
            "lokasi":  a.lokasi_ref.nama_lokasi if a.lokasi_ref else "Unknown",
            "creator": a.creator
        })
    return results

# ---------------------------------------------------------
# ENDPOINT 4: AMBIL RIWAYAT PERBAIKAN SPESIFIK (requires auth)
# ---------------------------------------------------------
@app.get("/api/riwayat/{aset_uid}")
def get_riwayat_aset(
    aset_uid: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Returns the repair history for a specific asset, ordered by creation date.
    """
    
    aset = db.query(models.Aset).filter(models.Aset.uid == aset_uid).first()
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan")

    riwayat = (
        db.query(models.RiwayatPerbaikan)
        .filter(models.RiwayatPerbaikan.aset_uid == aset_uid)
        .order_by(models.RiwayatPerbaikan.created_at.asc())
        .all()
    )

    results = []
    for i, r in enumerate(riwayat, start=1):
        results.append({
            "no":         i,
            "date":       f"{r.tanggal_perbaikan.strftime('%Y-%m-%d')} {r.created_at.strftime('%H:%M:%S')}",
            "upt":        f"{r.upt_perbaikan} ({r.lokasi_perbaikan})" if r.upt_perbaikan and r.lokasi_perbaikan else "Unknown",
            "teknisi":    r.teknisi,
            "kondisi":    r.status_baru,
            "keterangan": r.keterangan
        })

    return results

# ---------------------------------------------------------
# ENDPOINT 5: DECOMMISSIONING
# ---------------------------------------------------------
@app.post("/api/aset/afkir/{uid}")
async def afkir_aset(
    uid: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_role(["SUPER_ADMIN", "ADMIN_DAOP"]))
):
    """
    Decommission an asset by marking it as afkir.
    This action is irreversible and will hide the asset from all listings.
    """
    
    aset = db.query(models.Aset).filter(models.Aset.uid == uid).first()
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")

    aset.is_afkir = True
    db.commit()

    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": f"Aset {aset.kode_id} telah berhasil di-afkir."}

# ---------------------------------------------------------
# ENDPOINT 6: ADMIN USER MANAGEMENT (HIERARCHICAL)
# ---------------------------------------------------------
@app.post("/api/users/create")
async def create_user_hierarchical(
    user_data: schemas.UserCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_role(["SUPER_ADMIN", "ADMIN_DAOP"]))
):
    """
    Create a new user with hierarchical role restrictions:
    - SUPER_ADMIN can create any role (SUPER_ADMIN, ADMIN_DAOP, TEKNISI)
    - ADMIN_DAOP can only create TEKNISI accounts, and the assigned_region is automatically set to the ADMIN_DAOP's region.
    """
    
    db_user = db.query(models.User).filter(models.User.username == user_data.username).first()
    if db_user:
        raise HTTPException(status_code=400, detail="Username sudah terdaftar.")

    if current_user.role == "ADMIN_DAOP":
        if user_data.role != "TEKNISI":
            raise HTTPException(status_code=403, detail="ADMIN_DAOP hanya bisa membuat akun TEKNISI.")
        region = current_user.assigned_region
    else:
        region = user_data.assigned_region

    hashed_pw = get_password_hash(user_data.password)
    new_user  = models.User(
        username=user_data.username,
        hashed_password=hashed_pw,
        role=user_data.role,
        assigned_region=region
    )

    db.add(new_user)
    db.commit()
    return {"message": f"User {user_data.username} berhasil dibuat sebagai {user_data.role}."}

# ---------------------------------------------------------
# ENDPOINT 7: PUBLIC ASSET INFO — no auth required
#   Used by landing.html after a QR scan.
#   Returns only the fields safe for public display.
# ---------------------------------------------------------
@app.get("/api/public/aset/{uid}")
def get_public_aset(uid: str, db: Session = Depends(get_db)):
    """
    Returns minimal, read-only asset information without requiring a JWT.
    This endpoint is intentionally unauthenticated so that field workers
    can scan a QR code and view the asset card + repair form without logging in.

    Only non-afkir assets are served; afkir assets return 404.
    """
    
    aset = (
        db.query(models.Aset)
        .filter(models.Aset.uid == uid, models.Aset.is_afkir == False)
        .first()
    )
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan atau sudah di-afkir.")

    # Latest repair entry (for "last checked" display)
    latest_riwayat = (
        db.query(models.RiwayatPerbaikan)
        .filter(models.RiwayatPerbaikan.aset_uid == uid)
        .order_by(models.RiwayatPerbaikan.created_at.desc())
        .first()
    )

    return {
        "uid":            aset.uid,
        "kode_id":        aset.kode_id,
        "status":         aset.status_kondisi,
        "alat":           aset.katalog.nama_alat      if aset.katalog    else aset.kode_alat,
        "lokasi":         aset.lokasi_ref.nama_lokasi if aset.lokasi_ref else aset.kode_lokasi,
        "unit_peruntukan": aset.unit_peruntukan,
        "tahun_pembelian": aset.tahun_pembelian,
        "last_updated":   latest_riwayat.created_at.strftime("%d %b %Y %H:%M") if latest_riwayat else None,
        "last_teknisi":   latest_riwayat.teknisi if latest_riwayat else None,
    }

# ---------------------------------------------------------
# ENDPOINT 8: PUBLIC REPAIR HISTORY — no auth required
#   Returns the repair history for display on the landing page.
# ---------------------------------------------------------
@app.get("/api/public/riwayat/{uid}")
def get_public_riwayat(uid: str, db: Session = Depends(get_db)):
    """
    Returns the repair history for an asset without authentication.
    Limited to the 10 most recent entries to keep the public page light.
    """
    
    aset = (
        db.query(models.Aset)
        .filter(models.Aset.uid == uid, models.Aset.is_afkir == False)
        .first()
    )
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")

    riwayat = (
        db.query(models.RiwayatPerbaikan)
        .filter(models.RiwayatPerbaikan.aset_uid == uid)
        .order_by(models.RiwayatPerbaikan.created_at.desc())
        .limit(10)
        .all()
    )

    return [
        {
            "no":         i + 1,
            "date":       r.tanggal_perbaikan.strftime("%d %b %Y"),
            "upt":        r.upt_perbaikan or "—",
            "teknisi":    r.teknisi,
            "kondisi":    r.status_baru,
            "keterangan": r.keterangan or "—",
        }
        for i, r in enumerate(riwayat)
    ]

# ---------------------------------------------------------
# SERVE HTML FILES (Add this at the very bottom)
# ---------------------------------------------------------

# Get the directory where this file is located
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Serve static files (CSS, JS, images)
app.mount("/static", StaticFiles(directory=BASE_DIR), name="static")

# Serve HTML files
@app.get("/")
async def serve_index():
    """Serve the main index.html file"""
    return FileResponse(os.path.join(BASE_DIR, "index.html"))

@app.get("/landing.html")
async def serve_landing():
    """Serve the landing.html file"""
    return FileResponse(os.path.join(BASE_DIR, "landing.html"))

# Catch-all route to serve any other HTML files
# Place this LAST so it doesn't override API routes
@app.get("/{file_name}.html")
async def serve_html(file_name: str):
    """Serve any HTML file"""
    file_path = os.path.join(BASE_DIR, f"{file_name}.html")
    if os.path.exists(file_path):
        return FileResponse(file_path)
    raise HTTPException(status_code=404, detail="File not found")

@app.get("/{file_name}.js")
async def serve_js(file_name: str):
    """Serve JavaScript files"""
    file_path = os.path.join(BASE_DIR, f"{file_name}.js")
    if os.path.exists(file_path):
        return FileResponse(file_path, media_type="application/javascript")
    raise HTTPException(status_code=404, detail="File not found")

@app.get("/{file_name}.css")
async def serve_css(file_name: str):
    """Serve CSS files"""
    file_path = os.path.join(BASE_DIR, f"{file_name}.css")
    if os.path.exists(file_path):
        return FileResponse(file_path, media_type="text/css")
    raise HTTPException(status_code=404, detail="File not found")

@app.get("/data.json")
async def serve_data_json():
    """Serve the data.json file for UPT database"""
    file_path = os.path.join(BASE_DIR, "data.json")
    if os.path.exists(file_path):
        return FileResponse(file_path, media_type="application/json")
    raise HTTPException(status_code=404, detail="data.json not found")