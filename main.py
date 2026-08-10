import asyncio
import os
import re
from dotenv import load_dotenv
from fastapi import (
    FastAPI,
    Depends,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
    Query,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.security import OAuth2PasswordBearer
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session, joinedload
from datetime import datetime, timedelta, date
from typing import List, Optional
from sqlalchemy import or_, func
import bcrypt
import jwt

# ── IMPORTS ────────────────────────────────────────────────────────
import models
from database import engine, SessionLocal
from pydantic import BaseModel


# Inisialisasi Database
models.Base.metadata.create_all(bind=engine)
load_dotenv()

app = FastAPI(title="SIMA-KAI Asset API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==================================================================
# ── PYDANTIC SCHEMAS (Pengganti schemas.py) ───────────────────────
# ==================================================================


class Token(BaseModel):
    access_token: str
    token_type: str


class LoginForm(BaseModel):
    username: str
    role: str = "TEKNISI"
    id_lokasi: Optional[str] = None


class UserCreate(BaseModel):
    username: str
    password: Optional[str] = None
    role: str
    id_lokasi: Optional[str] = None


class UserUpdate(BaseModel):
    role: str
    id_lokasi: Optional[str] = None


class MasterAlatCreate(BaseModel):
    kode_alat: str
    nama_alat: str


class LokasiCreate(BaseModel):
    id_lokasi: str
    nama_lokasi: str
    tipe: str


class AsetCreate(BaseModel):
    # id_aset: str
    kode_alat: str
    id_lokasi: str
    tanggal_pembelian: date
    sumber_pengadaan: str
    parent_lokasi: str
    peruntukan: str


class AsetUpdate(BaseModel):
    kode_alat: str
    id_lokasi: str
    tanggal_pembelian: date
    sumber_pengadaan: str
    parent_lokasi: str
    peruntukan: str


class PerbaikanCreate(BaseModel):
    id_aset: str
    kondisi: str
    keterangan: Optional[str] = "-"
    peruntukan: Optional[str] = None
    id_lokasi: Optional[str] = None


class MutasiCreate(BaseModel):
    id_aset: str
    id_lokasi_tujuan: str
    alasan_mutasi: Optional[str] = None


class KalibrasiCreate(BaseModel):
    id_aset: str
    tanggal_kalibrasi: date
    tanggal_berlaku: Optional[date] = None
    status: str = "LULUS"
    pelaksana_kalibrasi: Optional[str] = None
    nomor_sertifikat: Optional[str] = None
    keterangan: Optional[str] = None


# ==================================================================
# ── DATABASE SESSION & WEBSOCKET ──────────────────────────────────
# ==================================================================


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        async with self._lock:
            self.active_connections.append(websocket)

    async def disconnect(self, websocket: WebSocket):
        async with self._lock:
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)

    async def broadcast(self, message: str):
        async with self._lock:
            connections = list(self.active_connections)
        for connection in connections:
            try:
                await connection.send_text(message)
            except Exception:
                # Client disconnected between copy and send
                pass


manager = ConnectionManager()


@app.get("/api/config")
def get_config():
    ngrok_url = os.environ.get("NGROK_URL", "").rstrip("/")
    return {"ngrok_url": ngrok_url}


# ==================================================================
# ── SECURITY & AUTHENTICATION ─────────────────────────────────────
# ==================================================================

SECRET_KEY = os.environ.get("SECRET_KEY", "KAI_warehouse_super_secret_key")
ALGORITHM = "HS256"

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/login")


def get_password_hash(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))


def create_access_token(data: dict) -> str:
    payload = data.copy()
    payload["exp"] = datetime.utcnow() + timedelta(hours=12)
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(
    token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)
) -> models.Pengguna:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username = payload.get("sub")
        if not username:
            raise HTTPException(status_code=401, detail="Token invalid")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Token invalid")

    user = (
        db.query(models.Pengguna).filter(models.Pengguna.username == username).first()
    )
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def require_role(allowed_roles: list):
    def checker(current_user: models.Pengguna = Depends(get_current_user)):
        if current_user.role not in allowed_roles:
            raise HTTPException(
                status_code=403,
                detail="Anda tidak memiliki izin untuk melakukan aksi ini.",
            )
        return current_user

    return checker


# ── AUTH ENDPOINTS ──


@app.post("/api/login", response_model=Token)
def login(form_data: LoginForm, db: Session = Depends(get_db)):
    user = db.query(models.Pengguna).filter_by(username=form_data.username).first()

    if not user:
        # Pendaftaran otomatis untuk login pertama (Sesuai alur UI sebelumnya)
        if not form_data.id_lokasi and form_data.role != "SUPER_ADMIN":
            raise HTTPException(
                status_code=400, detail="Region wajib diisi untuk pendaftaran pertama."
            )

        user = models.Pengguna(
            username=form_data.username,
            hashed_password=None,
            role=form_data.role,
            id_lokasi=form_data.id_lokasi if form_data.role != "SUPER_ADMIN" else None,
        )
        db.add(user)
        db.commit()
        db.refresh(user)

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


@app.post("/api/users/create")
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
        if user_data.role != "TEKNISI":
            raise HTTPException(
                status_code=403, detail="ADMIN_WILAYAH hanya bisa membuat akun TEKNISI."
            )
        region = current_user.id_lokasi
    else:
        region = user_data.id_lokasi

    db.add(
        models.Pengguna(
            username=user_data.username,
            hashed_password=get_password_hash(user_data.password)
            if user_data.password
            else None,
            role=user_data.role,
            id_lokasi=region,
        )
    )
    db.commit()
    return {"message": f"User {user_data.username} berhasil dibuat."}


@app.get("/api/users")
def get_all_users(
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    if current_user.role == "TEKNISI":
        raise HTTPException(status_code=403, detail="Akses ditolak.")

    query = db.query(models.Pengguna)
    if current_user.role == "ADMIN_WILAYAH":
        query = query.filter(
            models.Pengguna.id_lokasi == current_user.id_lokasi,
            models.Pengguna.role.in_(["ADMIN_WILAYAH", "TEKNISI"]),
        )

    users = query.order_by(models.Pengguna.role, models.Pengguna.username).all()
    return [
        {
            "id_pengguna": u.id_pengguna,
            "username": u.username,
            "role": u.role,
            "id_lokasi": u.id_lokasi,
        }
        for u in users
    ]


@app.put("/api/users/{user_id}")
def update_user(
    user_id: int,
    data: UserUpdate,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    if current_user.role == "TEKNISI":
        raise HTTPException(status_code=403, detail="Akses ditolak.")

    target = db.query(models.Pengguna).filter_by(id_pengguna=user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User tidak ditemukan.")

    if current_user.role == "ADMIN_WILAYAH":
        if target.id_lokasi != current_user.id_lokasi:
            raise HTTPException(
                status_code=403, detail="Hanya bisa mengedit user di region Anda."
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


@app.delete("/api/users/{user_id}")
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    if current_user.role == "TEKNISI":
        raise HTTPException(status_code=403, detail="Akses ditolak.")
    target = db.query(models.Pengguna).filter_by(id_pengguna=user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User tidak ditemukan.")
    if current_user.id_pengguna == target.id_pengguna:
        raise HTTPException(
            status_code=400, detail="Tidak bisa menghapus akun sendiri dari sini."
        )

    db.delete(target)
    db.commit()
    return {"message": "User berhasil dihapus."}


@app.delete("/api/users/me")
def delete_own_account(
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    db.delete(current_user)
    db.commit()
    return {"message": "Akun berhasil dihapus."}


# ==================================================================
# ── WEBSOCKET ─────────────────────────────────────────────────────
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
        await manager.disconnect(websocket)


# ==================================================================
# ── MASTER DATA ENDPOINTS ─────────────────────────────────────────
# ==================================================================


@app.get("/api/master/alat")
def get_master_alat(db: Session = Depends(get_db)):
    return db.query(models.KategoriAlat).all()


@app.post("/api/master/alat", dependencies=[Depends(require_role(["SUPER_ADMIN"]))])
def create_master_alat(data: MasterAlatCreate, db: Session = Depends(get_db)):
    if db.query(models.KategoriAlat).filter_by(kode_alat=data.kode_alat).first():
        raise HTTPException(status_code=400, detail="Kode alat sudah ada.")
    db.add(models.KategoriAlat(kode_alat=data.kode_alat, nama_alat=data.nama_alat))
    db.commit()
    return {"message": "Alat berhasil ditambahkan."}


@app.put(
    "/api/master/alat/{kode}", dependencies=[Depends(require_role(["SUPER_ADMIN"]))]
)
def update_master_alat(
    kode: str, data: MasterAlatCreate, db: Session = Depends(get_db)
):
    item = db.query(models.KategoriAlat).filter_by(kode_alat=kode).first()
    if not item:
        raise HTTPException(status_code=404, detail="Kode alat tidak ditemukan.")
    item.nama_alat = data.nama_alat
    db.commit()
    return {"message": "Alat diperbarui."}


@app.delete(
    "/api/master/alat/{kode}", dependencies=[Depends(require_role(["SUPER_ADMIN"]))]
)
def delete_master_alat(kode: str, db: Session = Depends(get_db)):
    item = db.query(models.KategoriAlat).filter_by(kode_alat=kode).first()
    if not item:
        raise HTTPException(status_code=404, detail="Kode alat tidak ditemukan.")
    db.delete(item)
    db.commit()
    return {"message": "Alat dihapus."}


@app.get("/api/master/lokasi")
def get_master_lokasi(tipe: List[str] = Query(None), db: Session = Depends(get_db)):
    query = db.query(models.Lokasi)
    if tipe:
        # Exact match for known types, case-insensitive
        valid_types = {"PUSAT", "DAOP", "DIVRE", "BALAIYASA", "UPT"}
        filtered_types = [t.upper() for t in tipe if t.upper() in valid_types]
        if filtered_types:
            query = query.filter(models.Lokasi.tipe.in_(filtered_types))
    # return query.order_by(models.Lokasi.tipe, models.Lokasi.nama_lokasi).all()
    return query.all()


@app.post("/api/master/lokasi", dependencies=[Depends(require_role(["SUPER_ADMIN"]))])
def create_master_lokasi(data: LokasiCreate, db: Session = Depends(get_db)):
    if db.query(models.Lokasi).filter_by(id_lokasi=data.id_lokasi).first():
        raise HTTPException(status_code=400, detail="ID Lokasi sudah ada.")
    if (
        db.query(models.Lokasi)
        .filter(models.Lokasi.nama_lokasi.ilike(data.nama_lokasi))
        .first()
    ):
        raise HTTPException(status_code=400, detail="Nama lokasi sudah digunakan.")
    db.add(
        models.Lokasi(
            id_lokasi=data.id_lokasi, nama_lokasi=data.nama_lokasi, tipe=data.tipe
        )
    )
    db.commit()
    return {"message": "Lokasi berhasil ditambahkan."}


@app.put(
    "/api/master/lokasi/{kode}", dependencies=[Depends(require_role(["SUPER_ADMIN"]))]
)
def update_master_lokasi(kode: str, data: LokasiCreate, db: Session = Depends(get_db)):
    item = db.query(models.Lokasi).filter_by(id_lokasi=kode).first()
    if not item:
        raise HTTPException(status_code=404, detail="Lokasi tidak ditemukan.")
    item.nama_lokasi = data.nama_lokasi
    item.tipe = data.tipe
    db.commit()
    return {"message": "Lokasi diperbarui."}


@app.delete(
    "/api/master/lokasi/{kode}", dependencies=[Depends(require_role(["SUPER_ADMIN"]))]
)
def delete_master_lokasi(kode: str, db: Session = Depends(get_db)):
    item = db.query(models.Lokasi).filter_by(id_lokasi=kode).first()
    if not item:
        raise HTTPException(status_code=404, detail="Lokasi tidak ditemukan.")
    db.delete(item)
    db.commit()
    return {"message": "Lokasi dihapus."}


@app.get("/api/master/upt")
def get_master_upt(db: Session = Depends(get_db)):
    # Fallback/Legacy jika UI masih memanggil endpoint ini
    return db.query(models.Lokasi).filter_by(tipe="UPT").all()


# ==================================================================
# ── TRANSAKSIONAL ASET & RIWAYAT ──────────────────────────────────
# ==================================================================


@app.post("/api/aset")
async def create_aset(
    aset_in: AsetCreate,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(
        require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"])
    ),
):
    # 1. Hitung urutan (Sequence) berdasarkan kode_alat
    # Ini mencari tahu sudah ada berapa alat tipe ini di database
    jumlah_aset_sejenis = (
        db.query(models.Aset).filter(models.Aset.kode_alat == aset_in.kode_alat).count()
    )
    nomor_urut = jumlah_aset_sejenis + 1

    # 2. Format komponen ID
    id_pengadaan = 1 if aset_in.sumber_pengadaan == "PUSAT" else 2

    tahun = aset_in.tanggal_pembelian.year
    year_str = str(tahun)[-2:] if tahun >= 2000 else str(tahun)

    # 3. Rakit Final ID Aset
    # Format: nomor_urut.kode_alat.id_pengadaan.tahun.unit.parent_lokasi
    # Contoh: 6.RGM.1.24.A.D1
    peruntukan_map = {
        "JALAN REL": "A",
        "JEMBATAN": "B",
        "MEKANIK": "C",
        "BALAIYASA": "D",
    }
    kode_peruntukan = peruntukan_map.get(aset_in.peruntukan.upper(), "X")

    generated_id_aset = f"{nomor_urut}.{aset_in.kode_alat}.{id_pengadaan}.{year_str}.{kode_peruntukan}.{aset_in.parent_lokasi}"

    # Pastikan tidak ada duplikasi akibat bentrok (meskipun sangat kecil kemungkinannya)
    if db.query(models.Aset).filter_by(id_aset=generated_id_aset).first():
        raise HTTPException(
            status_code=400, detail="Terjadi konflik ID. Silakan coba lagi."
        )

    # 4. Simpan ke database
    db_aset = models.Aset(
        id_aset=generated_id_aset,
        kode_alat=aset_in.kode_alat,
        id_lokasi=aset_in.id_lokasi,  # Disimpan dengan kode UPT asli (e.g. JR1.1)
        tanggal_pembelian=aset_in.tanggal_pembelian,
        sumber_pengadaan=aset_in.sumber_pengadaan,
        status_terakhir="SO",
        peruntukan=aset_in.peruntukan.upper(),
    )
    db.add(db_aset)

    # Inisiasi Riwayat Awal (Sesuai perbaikan arsitektur sebelumnya)
    inisiasi_riwayat = models.RiwayatKondisi(
        id_aset=generated_id_aset,
        id_pengguna=current_user.id_pengguna,
        kondisi="SO",
        keterangan="Aset Baru",
    )
    db.add(inisiasi_riwayat)

    db.commit()
    await manager.broadcast("REFRESH_ASSET_LIST")

    return {"message": "Aset berhasil ditambahkan", "id_aset": db_aset.id_aset}


@app.get("/api/aset")
def get_all_aset(
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    asets = (
        db.query(models.Aset)
        .options(joinedload(models.Aset.kategori), joinedload(models.Aset.lokasi_ref))
        .filter(func.upper(models.Aset.status_terakhir) != "AFKIR")
        .all()
    )

    return [
        {
            "id_aset": a.id_aset,
            "kode_alat": a.kode_alat,
            "kode_alat_name": a.kategori.nama_alat if a.kategori else a.kode_alat,
            "id_lokasi": a.id_lokasi,
            "lokasi_name": a.lokasi_ref.nama_lokasi if a.lokasi_ref else a.id_lokasi,
            "peruntukan": a.peruntukan,
            "status_terakhir": a.status_terakhir,
            "sumber_pengadaan": a.sumber_pengadaan,
            "tanggal_pembelian": str(a.tanggal_pembelian)
            if a.tanggal_pembelian
            else None,
        }
        for a in asets
    ]


@app.get("/api/aset/afkir", dependencies=[Depends(require_role(["SUPER_ADMIN"]))])
def get_afkir_aset(db: Session = Depends(get_db)):
    asets = (
        db.query(models.Aset)
        .options(joinedload(models.Aset.kategori), joinedload(models.Aset.lokasi_ref))
        .filter(func.upper(models.Aset.status_terakhir) == "AFKIR")
        .all()
    )
    return [
        {
            "id_aset": a.id_aset,
            "kode_alat": a.kategori.nama_alat if a.kategori else a.kode_alat,
            "id_lokasi": a.lokasi_ref.nama_lokasi if a.lokasi_ref else a.id_lokasi,
            "status_terakhir": a.status_terakhir,
            "tanggal_pembelian": str(a.tanggal_pembelian)
            if a.tanggal_pembelian
            else None,
            "waktu_update": a.waktu_update.strftime("%Y-%m-%d %H:%M:%S")
            if a.waktu_update
            else None,
        }
        for a in asets
    ]


@app.post("/api/aset/afkir/{id_aset}")
async def afkir_aset(
    id_aset: str,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(
        require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"])
    ),
):
    aset = db.query(models.Aset).filter_by(id_aset=id_aset).first()
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")
    # aset.is_afkir = True
    aset.status_terakhir = "AFKIR"
    db.commit()
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Aset berhasil di-afkir."}


@app.post(
    "/api/aset/pulihkan/{id_aset}",
    dependencies=[Depends(require_role(["SUPER_ADMIN"]))],
)
async def pulihkan_aset(id_aset: str, db: Session = Depends(get_db)):
    aset = db.query(models.Aset).filter_by(id_aset=id_aset).first()
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")
    if aset.status_terakhir != "AFKIR":
        raise HTTPException(
            status_code=400, detail="Aset ini tidak dalam status AFKIR."
        )
    aset.status_terakhir = "SO"
    db.commit()
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": f"Aset {id_aset} berhasil dipulihkan."}


@app.post("/api/perbaikan")
@app.post("/api/riwayat-kondisi")
async def catat_perbaikan(
    laporan: PerbaikanCreate,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    aset = db.query(models.Aset).filter_by(id_aset=laporan.id_aset).first()
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")

    # # NORMALISASI INPUT PERUNTUKAN DI SINI
    # if laporan.peruntukan:
    #     p_val = laporan.peruntukan.strip().upper()
    #     # Pemetaan ketat jika frontend mengirimkan A, B, C, D alih-alih teks penuh
    #     peruntukan_map = {
    #         "a": "JALAN REL",
    #         "b": "JEMBATAN",
    #         "c": "MEKANIK",
    #         "d": "BALAIYASA",
    #     }
    #     # Gunakan mapping, atau gunakan nilai aslinya jika sudah berupa teks penuh
    #     aset.peruntukan = peruntukan_map.get(p_val, p_val)

    # Normalise peruntukan for per-row storage (accepts A/B/C/D or full text)
    peruntukan_row = None
    if laporan.peruntukan:
        p_val = laporan.peruntukan.strip().upper()
        peruntukan_map_row = {
            "A": "JALAN REL", "B": "JEMBATAN", "C": "MEKANIK", "D": "BALAIYASA",
            "JALAN REL": "JALAN REL", "JEMBATAN": "JEMBATAN", "MEKANIK": "MEKANIK", "BALAIYASA": "BALAIYASA"
        }
        peruntukan_row = peruntukan_map_row.get(p_val, laporan.peruntukan.upper())

    # Resolve lokasi: prefer the sent id_lokasi, fall back to aset's current lokasi
    id_lokasi_row = laporan.id_lokasi or aset.id_lokasi

    db.add(
        models.RiwayatKondisi(
            id_aset=laporan.id_aset,
            id_pengguna=current_user.id_pengguna,
            kondisi=laporan.kondisi,
            keterangan=laporan.keterangan,
            id_lokasi=id_lokasi_row,
            peruntukan=peruntukan_row,
        )
    )
    aset.status_terakhir = laporan.kondisi
    db.commit()
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Laporan kondisi berhasil dicatat."}


@app.post("/api/mutasi")
async def submit_mutasi(
    mutasi: MutasiCreate,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(
        require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"])
    ),
):
    aset = (
        db.query(models.Aset)
        .filter(
            models.Aset.id_aset == mutasi.id_aset,
            models.Aset.status_terakhir != "AFKIR",
        )
        .first()
    )
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")

    if aset.id_lokasi == mutasi.id_lokasi_tujuan:
        raise HTTPException(status_code=400, detail="Lokasi tujuan sama dengan asal.")

    if (
        current_user.role == "ADMIN_WILAYAH"
        and aset.id_lokasi != current_user.id_lokasi
    ):
        raise HTTPException(
            status_code=403, detail="Hanya bisa memindahkan aset dari wilayah sendiri."
        )

    db.add(
        models.RiwayatMutasi(
            id_aset=mutasi.id_aset,
            id_lokasi_asal=aset.id_lokasi,
            id_lokasi_tujuan=mutasi.id_lokasi_tujuan,
            id_pengguna=current_user.id_pengguna,
            alasan_mutasi=mutasi.alasan_mutasi,
        )
    )

    db.query(models.Aset).filter(models.Aset.id_aset == mutasi.id_aset).update(
        {"id_lokasi": mutasi.id_lokasi_tujuan}, synchronize_session=False
    )

    db.commit()
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Aset berhasil dimutasi."}


# ==================================================================
# ── DATA HISTORY & SUMMARY ────────────────────────────────────────
# ==================================================================


@app.get("/api/riwayat-kondisi/{id_aset}")
def get_riwayat_aset(
    id_aset: str,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    riwayat = (
        db.query(models.RiwayatKondisi)
        .filter(
            models.RiwayatKondisi.id_aset == id_aset,
            models.RiwayatKondisi.kondisi != "KALIBRASI",
        )
        .order_by(models.RiwayatKondisi.waktu_lapor.asc())
        .all()
    )
    
    return [
        {
            "no": i,
            "waktu_lapor": r.waktu_lapor.strftime("%Y-%m-%d %H:%M:%S")
            if r.waktu_lapor
            else None,
            "id_pengguna": r.pengguna_ref.username if r.pengguna_ref else r.id_pengguna,
            "kondisi": r.kondisi,
            "keterangan": r.keterangan or "—",
            "id_lokasi": r.id_lokasi or "",
            "nama_lokasi": r.lokasi_ref.nama_lokasi if r.lokasi_ref else (r.id_lokasi or "—"),
            "peruntukan": r.peruntukan or "",
        }
        for i, r in enumerate(riwayat, start=1)
    ]


@app.post("/api/kalibrasi")
async def create_kalibrasi(
    data: KalibrasiCreate,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    aset = db.query(models.Aset).filter_by(id_aset=data.id_aset).first()
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")

    if data.status not in {"LULUS", "GAGAL", "BERSYARAT"}:
        raise HTTPException(status_code=400, detail="Status kalibrasi tidak valid.")

    tanggal_berlaku = data.tanggal_berlaku or data.tanggal_kalibrasi

    record = models.RiwayatKalibrasi(
        id_aset=data.id_aset,
        id_pengguna=current_user.id_pengguna,
        tanggal_kalibrasi=data.tanggal_kalibrasi,
        tanggal_berlaku=tanggal_berlaku,
        status=data.status,
        pelaksana_kalibrasi=data.pelaksana_kalibrasi,
        nomor_sertifikat=data.nomor_sertifikat,
        keterangan=data.keterangan,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Laporan kalibrasi berhasil disimpan.", "id_kalibrasi": record.id_kalibrasi}


@app.get("/api/kalibrasi/{id_aset}")
def get_kalibrasi_by_aset(
    id_aset: str,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    riwayat = (
        db.query(models.RiwayatKalibrasi)
        .filter(models.RiwayatKalibrasi.id_aset == id_aset)
        .order_by(models.RiwayatKalibrasi.tanggal_kalibrasi.asc(), models.RiwayatKalibrasi.waktu_input.asc())
        .all()
    )

    pengguna_ids = {r.id_pengguna for r in riwayat if r.id_pengguna}
    pengguna_map = {
        p.id_pengguna: p.username
        for p in db.query(models.Pengguna).filter(models.Pengguna.id_pengguna.in_(pengguna_ids)).all()
    }

    return [
        {
            "no": i,
            "id_kalibrasi": r.id_kalibrasi,
            "tanggal_kalibrasi": str(r.tanggal_kalibrasi) if r.tanggal_kalibrasi else None,
            "tanggal_berlaku": str(r.tanggal_berlaku) if r.tanggal_berlaku else None,
            "status": r.status,
            "pelaksana_kalibrasi": r.pelaksana_kalibrasi or "—",
            "nomor_sertifikat": r.nomor_sertifikat or "—",
            "keterangan": r.keterangan or "—",
            "waktu_input": r.waktu_input.strftime("%Y-%m-%d %H:%M:%S") if r.waktu_input else None,
            "id_pengguna": pengguna_map.get(r.id_pengguna, str(r.id_pengguna) if r.id_pengguna else "—"),
        }
        for i, r in enumerate(riwayat, start=1)
    ]


@app.get("/api/mutasi/{id_aset}")
def get_mutasi_by_aset(
    id_aset: str,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    mutasi = (
        db.query(models.RiwayatMutasi)
        .filter_by(id_aset=id_aset)
        .order_by(models.RiwayatMutasi.waktu_mutasi.asc())
        .all()
    )

    aset = db.query(models.Aset).filter_by(id_aset=id_aset).first()
    # original_lokasi should be the parent region code, not UPT code
    # For mutations, use the asal lokasi; for no mutations, use asset's current parent
    if mutasi:
        original_lokasi = mutasi[0].id_lokasi_asal
    elif aset:
        # Try to get parent from UPT code, fallback to asset's lokasi
        # This requires a helper or we just send the code and let frontend resolve
        original_lokasi = aset.id_lokasi
    else:
        original_lokasi = "—"

    results = []
    for m in mutasi:
        results.append(
            {
                "id_lokasi_asal": m.id_lokasi_asal,
                "id_lokasi_asal_name": m.lokasi_asal.nama_lokasi
                if m.lokasi_asal
                else m.id_lokasi_asal,
                "id_lokasi_tujuan": m.id_lokasi_tujuan,
                "id_lokasi_tujuan_name": m.lokasi_tujuan.nama_lokasi
                if m.lokasi_tujuan
                else m.id_lokasi_tujuan,
                "waktu_mutasi": m.waktu_mutasi.strftime("%Y-%m-%d %H:%M:%S")
                if m.waktu_mutasi
                else None,
                "nama_petugas": m.pengguna_ref.username
                if m.pengguna_ref
                else (str(m.id_pengguna) if m.id_pengguna else "—"),
                "alasan_mutasi": m.alasan_mutasi or "—",
            }
        )
        
    original_lokasi_obj = (
        db.query(models.Lokasi).filter_by(id_lokasi=original_lokasi).first()
        if original_lokasi and original_lokasi != "—"
        else None
    )
    return {
        "mutasi": results,
        "original_lokasi": original_lokasi,
        "original_lokasi_name": original_lokasi_obj.nama_lokasi if original_lokasi_obj else original_lokasi,
        "sudah_kembali": aset.id_lokasi == original_lokasi if aset else False,
        "lokasi_sekarang": aset.id_lokasi if aset else "—",
        "lokasi_sekarang_name": aset.lokasi_ref.nama_lokasi
        if aset and aset.lokasi_ref
        else "—",
    }


@app.get("/api/history/summary")
def get_history_summary(
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    from sqlalchemy.orm import joinedload
    from sqlalchemy import func

    # Batch load all assets with their relationships
    asets = (
        db.query(models.Aset)
        .options(joinedload(models.Aset.kategori), joinedload(models.Aset.lokasi_ref))
        .filter(models.Aset.status_terakhir != "AFKIR")
        .all()
    )

    if not asets:
        return []

    aset_ids = [a.id_aset for a in asets]

    # Batch load latest repair per asset using window function approach
    latest_repair_subq = (
        db.query(
            models.RiwayatKondisi.id_aset,
            models.RiwayatKondisi.kondisi,
            models.RiwayatKondisi.keterangan,
            models.RiwayatKondisi.waktu_lapor,
            models.RiwayatKondisi.id_pengguna,
            # models.RiwayatKondisi.id_lokasi,
            func.row_number()
            .over(
                partition_by=models.RiwayatKondisi.id_aset,
                order_by=models.RiwayatKondisi.waktu_lapor.desc(),
            )
            .label("rn"),
        )
        .filter(models.RiwayatKondisi.id_aset.in_(aset_ids))
        .subquery()
    )

    latest_repairs = (
        db.query(latest_repair_subq).filter(latest_repair_subq.c.rn == 1).all()
    )
    repair_map = {r.id_aset: r for r in latest_repairs}

    # Batch load all mutasi for these assets
    all_mutasi = (
        db.query(models.RiwayatMutasi)
        .options(
            joinedload(models.RiwayatMutasi.lokasi_asal),
            joinedload(models.RiwayatMutasi.lokasi_tujuan),
            joinedload(models.RiwayatMutasi.pengguna_ref),
        )
        .filter(models.RiwayatMutasi.id_aset.in_(aset_ids))
        .order_by(models.RiwayatMutasi.waktu_mutasi.asc())
        .all()
    )

    # Group mutasi by asset
    mutasi_map = {}
    for m in all_mutasi:
        if m.id_aset not in mutasi_map:
            mutasi_map[m.id_aset] = []
        mutasi_map[m.id_aset].append(m)

    # Batch load pengguna for repairs
    pengguna_ids = list(set(r.id_pengguna for r in latest_repairs if r.id_pengguna))
    pengguna_map = {}
    if pengguna_ids:
        penggunas = (
            db.query(models.Pengguna)
            .filter(models.Pengguna.id_pengguna.in_(pengguna_ids))
            .all()
        )
        pengguna_map = {p.id_pengguna: p for p in penggunas}

    kalibrasi_map = {}
    for kal in db.query(models.RiwayatKalibrasi).all():
        kalibrasi_map.setdefault(kal.id_aset, []).append(kal)

    results = []
    for a in asets:
        latest_repair = repair_map.get(a.id_aset)
        all_mutasi_for_a = mutasi_map.get(a.id_aset, [])
        latest_mutasi = all_mutasi_for_a[-1] if all_mutasi_for_a else None
        all_kalibrasi_for_a = kalibrasi_map.get(a.id_aset, [])
        latest_kalibrasi = all_kalibrasi_for_a[-1] if all_kalibrasi_for_a else None

        results.append(
            {
                "id_aset": a.id_aset,
                "kode_alat": a.kategori.nama_alat if a.kategori else a.kode_alat,
                "id_lokasi": a.id_lokasi,
                "peruntukan": a.peruntukan,
                "id_lokasi_name": a.lokasi_ref.nama_lokasi
                if a.lokasi_ref
                else a.id_lokasi,
                "status_terakhir": a.status_terakhir,
                "repair": {
                    "latest_date": latest_repair.waktu_lapor.strftime(
                        "%Y-%m-%d %H:%M:%S"
                    )
                    if latest_repair and latest_repair.waktu_lapor
                    else None,
                    "latest_kondisi": latest_repair.kondisi
                    if latest_repair
                    else a.status_terakhir,
                    "latest_keterangan": latest_repair.keterangan
                    if latest_repair
                    else None,
                    "latest_teknisi": pengguna_map.get(
                        latest_repair.id_pengguna
                    ).username
                    if latest_repair and latest_repair.id_pengguna in pengguna_map
                    else (str(latest_repair.id_pengguna) if latest_repair else None),
                },
                "has_kalibrasi": bool(all_kalibrasi_for_a),
                "kalibrasi": {
                    "latest_date": latest_kalibrasi.tanggal_kalibrasi.strftime(
                        "%Y-%m-%d"
                    )
                    if latest_kalibrasi and latest_kalibrasi.tanggal_kalibrasi
                    else None,
                    "latest_tanggal_kalibrasi": latest_kalibrasi.tanggal_kalibrasi.strftime(
                        "%Y-%m-%d"
                    )
                    if latest_kalibrasi and latest_kalibrasi.tanggal_kalibrasi
                    else None,
                    "latest_berlaku": latest_kalibrasi.tanggal_berlaku.strftime(
                        "%Y-%m-%d"
                    )
                    if latest_kalibrasi and latest_kalibrasi.tanggal_berlaku
                    else None,
                    "latest_waktu_input": latest_kalibrasi.waktu_input.strftime(
                        "%Y-%m-%d %H:%M:%S"
                    )
                    if latest_kalibrasi and latest_kalibrasi.waktu_input
                    else None,
                    "latest_status": latest_kalibrasi.status if latest_kalibrasi else None,
                    "latest_pelaksana": latest_kalibrasi.pelaksana_kalibrasi
                    if latest_kalibrasi and latest_kalibrasi.pelaksana_kalibrasi
                    else (
                        pengguna_map.get(latest_kalibrasi.id_pengguna).username
                        if latest_kalibrasi and latest_kalibrasi.id_pengguna in pengguna_map
                        else None
                    ),
                    "latest_nomor_sertifikat": latest_kalibrasi.nomor_sertifikat
                    if latest_kalibrasi
                    else None,
                    "latest_keterangan": latest_kalibrasi.keterangan
                    if latest_kalibrasi
                    else None,
                }
                if latest_kalibrasi
                else None,
                "mutasi": {
                    "count": len(all_mutasi_for_a),
                    "latest_date": latest_mutasi.waktu_mutasi.strftime(
                        "%Y-%m-%d %H:%M:%S"
                    )
                    if latest_mutasi and latest_mutasi.waktu_mutasi
                    else None,
                    "latest_lokasi_tuju": latest_mutasi.lokasi_tujuan.nama_lokasi
                    if latest_mutasi and latest_mutasi.lokasi_tujuan
                    else None,
                    "latest_oleh": latest_mutasi.pengguna_ref.username
                    if latest_mutasi and latest_mutasi.pengguna_ref
                    else None,
                    "latest_alasan": latest_mutasi.alasan_mutasi
                    if latest_mutasi
                    else None,
                    "sudah_kembali": a.id_lokasi
                    == (
                        all_mutasi_for_a[0].id_lokasi_asal
                        if all_mutasi_for_a
                        else a.id_lokasi
                    ),
                    "original_lokasi_code": all_mutasi_for_a[0].id_lokasi_asal
                    if all_mutasi_for_a and all_mutasi_for_a[0].id_lokasi_asal
                    else a.id_lokasi,
                    "original_lokasi_name": all_mutasi_for_a[0].lokasi_asal.nama_lokasi
                    if all_mutasi_for_a and all_mutasi_for_a[0].lokasi_asal
                    else (
                        a.lokasi_ref.nama_lokasi if a.lokasi_ref else a.id_lokasi
                    ),
                }
                if all_mutasi_for_a
                else None,
            }
        )
    return results


# ==================================================================
# ── EXPORT ────────────────────────────────────────────────────────
# ==================================================================


@app.get("/api/export/riwayat")
def export_riwayat(
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    def build_rows(asets):
        rows = []
        for a in asets:
            nama_alat = a.kategori.nama_alat if a.kategori else a.kode_alat
            nama_lokasi = a.lokasi_ref.nama_lokasi if a.lokasi_ref else a.id_lokasi
            
            # Query riwayat with joinedload on lokasi_ref to efficiently fetch UPT/lokasi info
            riwayat = (
                db.query(models.RiwayatKondisi)
                .options(joinedload(models.RiwayatKondisi.lokasi_ref))
                .filter_by(id_aset=a.id_aset)
                .order_by(models.RiwayatKondisi.waktu_lapor.asc())
                .all()
            )

            if not riwayat:
                default_upt = a.lokasi_ref.nama_lokasi if a.lokasi_ref else (a.id_lokasi or "—")
                rows.append(
                    {
                        "no": None,
                        "tanggal": "—",
                        "id_aset": a.id_aset,
                        "kode_alat": nama_alat,
                        "id_lokasi": a.id_lokasi,
                        "peruntukan": a.peruntukan,
                        "id_lokasi_asal": nama_lokasi,
                        "upt": default_upt,
                        "id_pengguna": "—",
                        "kondisi": a.status_terakhir,
                        "keterangan": "Belum ada riwayat",
                    }
                )
            else:
                for i, r in enumerate(riwayat, start=1):
                    # Direct database lookup for UPT/lokasi name instead of text parsing
                    upt_name = (
                        r.lokasi_ref.nama_lokasi 
                        if r.lokasi_ref 
                        else (r.id_lokasi or "—")
                    )
                    
                    rows.append(
                        {
                            "no": i,
                            "tanggal": r.waktu_lapor.strftime("%Y-%m-%d %H:%M:%S")
                            if r.waktu_lapor
                            else "—",
                            "id_aset": a.id_aset,
                            "kode_alat": nama_alat,
                            "id_lokasi": r.id_lokasi,
                            "peruntukan": r.peruntukan,
                            "id_lokasi_asal": nama_lokasi,
                            "upt": upt_name,
                            "id_pengguna": r.pengguna_ref.username
                            if r.pengguna_ref
                            else str(r.id_pengguna),
                            "kondisi": r.kondisi,
                            "keterangan": r.keterangan or "—",
                        }
                    )
        return rows

    return {
        "active": build_rows(
            db.query(models.Aset)
            .options(joinedload(models.Aset.lokasi_ref), joinedload(models.Aset.kategori))
            .filter(models.Aset.status_terlahir != "AFKIR" if hasattr(models.Aset, "status_terlahir") else models.Aset.status_terakhir != "AFKIR")
            .all()
        ),
        "afkir": build_rows(
            db.query(models.Aset)
            .options(joinedload(models.Aset.lokasi_ref), joinedload(models.Aset.kategori))
            .filter(models.Aset.status_terakhir == "AFKIR")
            .all()
        ),
    }


@app.get("/api/export/mutasi")
def export_mutasi(
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    asets = db.query(models.Aset).filter(models.Aset.status_terakhir != "AFKIR").all()
    rows = []
    for a in asets:
        nama_alat = a.kategori.nama_alat if a.kategori else a.kode_alat
        nama_lokasi = a.lokasi_ref.nama_lokasi if a.lokasi_ref else a.id_lokasi
        mutasi_list = (
            db.query(models.RiwayatMutasi)
            .filter_by(id_aset=a.id_aset)
            .order_by(models.RiwayatMutasi.waktu_mutasi.asc())
            .all()
        )
        if not mutasi_list:
            continue
        for i, m in enumerate(mutasi_list, start=1):
            rows.append(
                {
                    "no": i,
                    "id_aset": a.id_aset,
                    "kode_alat": nama_alat,
                    "lokasi_asal": m.lokasi_asal.nama_lokasi
                    if m.lokasi_asal
                    else m.id_lokasi_asal,
                    "lokasi_tujuan": m.lokasi_tujuan.nama_lokasi
                    if m.lokasi_tujuan
                    else m.id_lokasi_tujuan,
                    "waktu_mutasi": m.waktu_mutasi.strftime("%Y-%m-%d %H:%M:%S")
                    if m.waktu_mutasi
                    else "—",
                    "oleh": m.pengguna_ref.username
                    if m.pengguna_ref
                    else str(m.id_pengguna),
                    "alasan": m.alasan_mutasi or "—",
                }
            )
    return rows


@app.delete("/api/aset/{id_aset}")
async def delete_aset(
    id_aset: str,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(
        require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"])
    ),
):
    aset = db.query(models.Aset).filter_by(id_aset=id_aset).first()
    if not aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")

    if (
        current_user.role == "ADMIN_WILAYAH"
        and aset.id_lokasi != current_user.id_lokasi
    ):
        raise HTTPException(
            status_code=403, detail="Hanya bisa menghapus aset dari wilayah Anda."
        )

    # Cascade delete child records first
    db.query(models.RiwayatKondisi).filter_by(id_aset=id_aset).delete()
    db.query(models.RiwayatMutasi).filter_by(id_aset=id_aset).delete()
    db.delete(aset)
    db.commit()
    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": f"Aset {id_aset} berhasil dihapus permanen."}


@app.put("/api/aset/{id_aset}")
async def update_aset(
    id_aset: str,
    aset_in: AsetUpdate,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(
        require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"])
    ),
):
    old_aset = db.query(models.Aset).filter_by(id_aset=id_aset).first()
    if not old_aset:
        raise HTTPException(status_code=404, detail="Aset tidak ditemukan.")

    if (
        current_user.role == "ADMIN_WILAYAH"
        and old_aset.id_lokasi != current_user.id_lokasi
    ):
        raise HTTPException(
            status_code=403, detail="Hanya bisa mengedit aset dari wilayah Anda."
        )

    # Rebuild the generated ID from updated fields
    peruntukan_map = {"JALAN REL": "A", "JEMBATAN": "B", "MEKANIK": "C", "BALAIYASA": "D"}
    kode_peruntukan = peruntukan_map.get(aset_in.peruntukan.upper(), "X")
    id_pengadaan = 1 if aset_in.sumber_pengadaan == "PUSAT" else 2
    tahun = aset_in.tanggal_pembelian.year
    year_str = str(tahun)[-2:] if tahun >= 2000 else str(tahun)

    # Preserve original sequence number from the old ID
    old_parts = id_aset.split(".")
    nomor_urut = old_parts[0] if old_parts[0].isdigit() else "1"

    new_id_aset = f"{nomor_urut}.{aset_in.kode_alat}.{id_pengadaan}.{year_str}.{kode_peruntukan}.{aset_in.parent_lokasi}"

    if new_id_aset == id_aset:
        # ID unchanged — simple field update
        old_aset.kode_alat = aset_in.kode_alat
        old_aset.id_lokasi = aset_in.id_lokasi
        old_aset.tanggal_pembelian = aset_in.tanggal_pembelian
        old_aset.sumber_pengadaan = aset_in.sumber_pengadaan
        old_aset.peruntukan = aset_in.peruntukan.upper()
        db.commit()
        await manager.broadcast("REFRESH_ASSET_LIST")
        return {"message": "Aset berhasil diperbarui.", "id_aset": new_id_aset}

    # ID changes — check for collision
    if db.query(models.Aset).filter_by(id_aset=new_id_aset).first():
        raise HTTPException(
            status_code=400,
            detail=f"ID baru '{new_id_aset}' sudah digunakan oleh aset lain."
        )

    # 1. Insert new aset row first so FK target exists before child records point to it
    new_aset = models.Aset(
        id_aset=new_id_aset,
        kode_alat=aset_in.kode_alat,
        id_lokasi=aset_in.id_lokasi,
        tanggal_pembelian=aset_in.tanggal_pembelian,
        sumber_pengadaan=aset_in.sumber_pengadaan,
        status_terakhir=old_aset.status_terakhir,
        peruntukan=aset_in.peruntukan.upper(),
    )
    db.add(new_aset)
    db.flush()  # write new_aset row; FK target now exists in DB

    # 2. Re-parent all child records to the new ID (FK target now valid)
    db.query(models.RiwayatKondisi).filter_by(id_aset=id_aset).update(
        {"id_aset": new_id_aset}, synchronize_session=False
    )
    db.query(models.RiwayatMutasi).filter_by(id_aset=id_aset).update(
        {"id_aset": new_id_aset}, synchronize_session=False
    )
    db.query(models.RiwayatKalibrasi).filter_by(id_aset=id_aset).update(
        {"id_aset": new_id_aset}, synchronize_session=False
    )

    # 3. Now safe to delete the old aset row (no children reference it anymore)
    db.delete(old_aset)
    db.commit()

    await manager.broadcast("REFRESH_ASSET_LIST")
    return {"message": "Aset berhasil diperbarui.", "id_aset": new_id_aset}


# ==================================================================
# ── INVENTARIS — Sparepart Management ─────────────────────────────
# ==================================================================

# ── Pydantic Schemas ──

class SparePartKategoriCreate(BaseModel):
    nama: str
    subsistem: Optional[str] = None
    kode_alat: Optional[str] = None


class SparePartCreate(BaseModel):
    sku: Optional[str] = None
    nama_part: str
    id_kategori: Optional[int] = None
    kode_alat: Optional[str] = None
    unit: str = "Pcs"
    harga_satuan: Optional[int] = None
    stok_min: int = 0
    auto_demand: bool = False
    supplier: Optional[str] = None
    deskripsi: Optional[str] = None
    part_number: Optional[str] = None
    is_critical: bool = False
    serial_numbers: Optional[str] = None
    lookup_tags: Optional[str] = None
    linked_vehicle: Optional[str] = None
    warranty_months: Optional[int] = None
    ref_part: Optional[str] = None
    # Initial stock
    jumlah_awal: int = 0
    id_lokasi_awal: Optional[str] = None


class SparePartUpdate(BaseModel):
    nama_part: Optional[str] = None
    id_kategori: Optional[int] = None
    kode_alat: Optional[str] = None
    unit: Optional[str] = None
    harga_satuan: Optional[int] = None
    stok_min: Optional[int] = None
    auto_demand: Optional[bool] = None
    supplier: Optional[str] = None
    deskripsi: Optional[str] = None
    part_number: Optional[str] = None
    is_critical: Optional[bool] = None
    serial_numbers: Optional[str] = None
    lookup_tags: Optional[str] = None
    linked_vehicle: Optional[str] = None
    warranty_months: Optional[int] = None
    ref_part: Optional[str] = None


class StokTransferCreate(BaseModel):
    id_part: int
    jumlah: int
    id_lokasi_asal: Optional[str] = None     # None = global pool
    id_lokasi_tujuan: Optional[str] = None   # None = global pool
    transfer_by: Optional[str] = None
    transfer_to: Optional[str] = None
    catatan: Optional[str] = None


class StokAdjustCreate(BaseModel):
    id_part: int
    tipe_gerakan: str   # IN | OUT
    jumlah: int
    id_lokasi: Optional[str] = None
    keterangan: Optional[str] = None


# ── Helper: compute net stock ──────────────────────────────────────

def _net_stok(db: Session, id_part: int, id_lokasi: Optional[str] = None) -> int:
    """Return net stock for a part. id_lokasi=None → global (all lokasi summed)."""
    q = db.query(
        func.coalesce(
            func.sum(
                func.case(
                    (models.SparePartStok.tipe_gerakan == "IN",  models.SparePartStok.jumlah),
                    else_=-models.SparePartStok.jumlah
                )
            ), 0
        )
    ).filter(models.SparePartStok.id_part == id_part)
    if id_lokasi is not None:
        q = q.filter(models.SparePartStok.id_lokasi == id_lokasi)
    return q.scalar() or 0


# ── Part Categories ────────────────────────────────────────────────

@app.get("/api/inventaris/kategori")
def get_inv_kategori(db: Session = Depends(get_db)):
    rows = db.query(models.SparePartKategori).order_by(
        models.SparePartKategori.subsistem, models.SparePartKategori.nama
    ).all()
    return [
        {
            "id_kategori": r.id_kategori,
            "nama": r.nama,
            "subsistem": r.subsistem,
            "kode_alat": r.kode_alat,
        }
        for r in rows
    ]


@app.post("/api/inventaris/kategori",
          dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"]))])
def create_inv_kategori(data: SparePartKategoriCreate, db: Session = Depends(get_db)):
    if db.query(models.SparePartKategori).filter_by(nama=data.nama).first():
        raise HTTPException(status_code=400, detail="Kategori sudah ada.")
    row = models.SparePartKategori(
        nama=data.nama, subsistem=data.subsistem, kode_alat=data.kode_alat
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"message": "Kategori ditambahkan.", "id_kategori": row.id_kategori}


@app.delete("/api/inventaris/kategori/{id_kategori}",
            dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"]))])
def delete_inv_kategori(id_kategori: int, db: Session = Depends(get_db)):
    row = db.query(models.SparePartKategori).filter_by(id_kategori=id_kategori).first()
    if not row:
        raise HTTPException(status_code=404, detail="Kategori tidak ditemukan.")
    db.delete(row)
    db.commit()
    return {"message": "Kategori dihapus."}


# ── Parts CRUD ─────────────────────────────────────────────────────

@app.get("/api/inventaris/parts")
def get_inv_parts(
    id_lokasi: Optional[str] = None,
    id_kategori: Optional[int] = None,
    kode_alat: Optional[str] = None,
    mode: str = "global",   # global | per_lokasi
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    q = db.query(models.SparePart)
    if id_kategori:
        q = q.filter(models.SparePart.id_kategori == id_kategori)
    if kode_alat:
        q = q.filter(models.SparePart.kode_alat == kode_alat)
    parts = q.order_by(models.SparePart.nama_part).all()

    result = []
    for p in parts:
        stok = _net_stok(db, p.id_part, id_lokasi if mode == "per_lokasi" else None)
        kat = p.kategori_ref
        alat = p.kategori_alat_ref
        result.append({
            "id_part": p.id_part,
            "sku": p.sku,
            "nama_part": p.nama_part,
            "id_kategori": p.id_kategori,
            "nama_kategori": kat.nama if kat else None,
            "subsistem": kat.subsistem if kat else None,
            "kode_alat": p.kode_alat,
            "nama_alat": alat.nama_alat if alat else None,
            "unit": p.unit,
            "harga_satuan": p.harga_satuan,
            "stok_min": p.stok_min,
            "stok_sekarang": stok,
            "is_critical": p.is_critical or (stok <= p.stok_min and p.stok_min > 0),
            "auto_demand": p.auto_demand,
            "supplier": p.supplier,
            "deskripsi": p.deskripsi,
            "part_number": p.part_number,
            "linked_vehicle": p.linked_vehicle,
            "warranty_months": p.warranty_months,
        })
    return result


@app.post("/api/inventaris/parts",
          dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"]))])
async def create_inv_part(
    data: SparePartCreate,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    # Auto-generate SKU if not provided
    if not data.sku:
        count = db.query(models.SparePart).count()
        data.sku = f"SP{count + 1:05d}"
    if db.query(models.SparePart).filter_by(sku=data.sku).first():
        raise HTTPException(status_code=400, detail="SKU sudah ada.")

    part = models.SparePart(
        sku=data.sku, nama_part=data.nama_part, id_kategori=data.id_kategori,
        kode_alat=data.kode_alat, unit=data.unit, harga_satuan=data.harga_satuan,
        stok_min=data.stok_min, auto_demand=data.auto_demand, supplier=data.supplier,
        deskripsi=data.deskripsi, part_number=data.part_number,
        is_critical=data.is_critical, serial_numbers=data.serial_numbers,
        lookup_tags=data.lookup_tags, linked_vehicle=data.linked_vehicle,
        warranty_months=data.warranty_months, ref_part=data.ref_part,
    )
    db.add(part)
    db.flush()

    if data.jumlah_awal > 0:
        db.add(models.SparePartStok(
            id_part=part.id_part,
            id_lokasi=data.id_lokasi_awal,
            tipe_gerakan="IN",
            jumlah=data.jumlah_awal,
            harga_satuan=data.harga_satuan,
            keterangan="Stok awal",
            id_pengguna=current_user.id_pengguna,
        ))

    db.commit()
    db.refresh(part)
    await manager.broadcast("REFRESH_INVENTARIS")
    return {"message": "Part berhasil ditambahkan.", "id_part": part.id_part, "sku": part.sku}


@app.put("/api/inventaris/parts/{id_part}",
         dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"]))])
async def update_inv_part(
    id_part: int, data: SparePartUpdate, db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    part = db.query(models.SparePart).filter_by(id_part=id_part).first()
    if not part:
        raise HTTPException(status_code=404, detail="Part tidak ditemukan.")
    for field, val in data.dict(exclude_unset=True).items():
        setattr(part, field, val)
    db.commit()
    await manager.broadcast("REFRESH_INVENTARIS")
    return {"message": "Part diperbarui."}


@app.delete("/api/inventaris/parts/{id_part}",
            dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"]))])
async def delete_inv_part(
    id_part: int, db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    part = db.query(models.SparePart).filter_by(id_part=id_part).first()
    if not part:
        raise HTTPException(status_code=404, detail="Part tidak ditemukan.")
    db.delete(part)
    db.commit()
    await manager.broadcast("REFRESH_INVENTARIS")
    return {"message": "Part dihapus."}


# ── Stock: Transfer ────────────────────────────────────────────────

@app.post("/api/inventaris/transfer",
          dependencies=[Depends(require_role(["SUPER_ADMIN", "ADMIN_WILAYAH", "TEKNISI"]))])
async def create_transfer(
    data: StokTransferCreate, db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    part = db.query(models.SparePart).filter_by(id_part=data.id_part).first()
    if not part:
        raise HTTPException(status_code=404, detail="Part tidak ditemukan.")

    # Check available stock at source
    stok_asal = _net_stok(db, data.id_part, data.id_lokasi_asal)
    if stok_asal < data.jumlah:
        raise HTTPException(
            status_code=400,
            detail=f"Stok tidak mencukupi. Tersedia: {stok_asal}, diminta: {data.jumlah}."
        )

    now = datetime.now()

    # OUT from source
    out_row = models.SparePartStok(
        id_part=data.id_part,
        id_lokasi=data.id_lokasi_asal,
        tipe_gerakan="OUT",
        jumlah=data.jumlah,
        harga_satuan=part.harga_satuan,
        keterangan=f"Transfer ke {data.id_lokasi_tujuan or 'GLOBAL'}",
        id_pengguna=current_user.id_pengguna,
        waktu=now,
        site_from=data.id_lokasi_asal,
        site_to=data.id_lokasi_tujuan,
        transfer_by=data.transfer_by or current_user.username,
        transfer_to=data.transfer_to,
        catatan=data.catatan,
    )
    db.add(out_row)
    db.flush()

    # IN to destination
    in_row = models.SparePartStok(
        id_part=data.id_part,
        id_lokasi=data.id_lokasi_tujuan,
        tipe_gerakan="IN",
        jumlah=data.jumlah,
        harga_satuan=part.harga_satuan,
        keterangan=f"Transfer dari {data.id_lokasi_asal or 'GLOBAL'}",
        id_pengguna=current_user.id_pengguna,
        waktu=now,
        site_from=data.id_lokasi_asal,
        site_to=data.id_lokasi_tujuan,
        transfer_by=data.transfer_by or current_user.username,
        transfer_to=data.transfer_to,
        catatan=data.catatan,
        id_ref_transfer=out_row.id_stok,
    )
    db.add(in_row)
    db.commit()
    await manager.broadcast("REFRESH_INVENTARIS")
    return {"message": "Transfer berhasil.", "id_out": out_row.id_stok, "id_in": in_row.id_stok}


@app.get("/api/inventaris/transfer")
def get_transfer_history(
    id_lokasi: Optional[str] = None,
    id_part: Optional[int] = None,
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    q = (
        db.query(models.SparePartStok)
        .filter(models.SparePartStok.site_from != None)  # noqa: E711
        .filter(models.SparePartStok.tipe_gerakan == "OUT")  # one row per transfer
        .order_by(models.SparePartStok.waktu.desc())
    )
    if id_lokasi:
        q = q.filter(
            (models.SparePartStok.site_from == id_lokasi) |
            (models.SparePartStok.site_to == id_lokasi)
        )
    if id_part:
        q = q.filter(models.SparePartStok.id_part == id_part)

    rows = q.all()
    result = []
    for r in rows:
        p = r.part_ref
        sf = r.site_from_ref
        st = r.site_to_ref
        result.append({
            "id_stok": r.id_stok,
            "waktu": r.waktu.strftime("%Y-%m-%d %H:%M") if r.waktu else None,
            "nama_part": p.nama_part if p else str(r.id_part),
            "jumlah": r.jumlah,
            "unit": p.unit if p else "",
            "nama_alat": p.kategori_alat_ref.nama_alat if p and p.kategori_alat_ref else "",
            "site_from": sf.nama_lokasi if sf else (r.site_from or "GLOBAL"),
            "site_to": st.nama_lokasi if st else (r.site_to or "GLOBAL"),
            "transfer_by": r.transfer_by or "—",
            "transfer_to": r.transfer_to or "—",
            "catatan": r.catatan or "—",
        })
    return result


# ── Dashboard Summary ──────────────────────────────────────────────

@app.get("/api/inventaris/dashboard")
def get_inv_dashboard(
    id_lokasi: Optional[str] = None,     # parent lokasi filter (DAOP/DIVRE)
    mode: str = "global",                # global | per_lokasi
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    """
    Returns aggregated stats for the Inventaris Dashboard tab.
    id_lokasi = parent lokasi code → auto-includes all its UPT children.
    """
    all_parts = db.query(models.SparePart).all()

    # Resolve child UPT lokasi ids for filtering
    child_lokasi_ids: Optional[list] = None
    if id_lokasi:
        # UPTs that "belong" to this parent use the parent code as part of their id_lokasi
        # Convention from seed.py: UPT id_lokasi contains the parent prefix e.g. "JR1.1" → D1
        # We filter sparepart_stok by lokasi where id_lokasi LIKE parent%
        child_rows = db.query(models.Lokasi).filter(
            models.Lokasi.id_lokasi.like(f"{id_lokasi}%")
        ).all()
        child_lokasi_ids = [r.id_lokasi for r in child_rows] or [id_lokasi]

    total_parts = len(all_parts)
    total_types = len(set(p.kode_alat for p in all_parts if p.kode_alat))
    total_value = 0
    auto_demand_count = sum(1 for p in all_parts if p.auto_demand)
    critical_list = []
    by_subsistem: dict[str, int] = {}
    by_alat: dict[str, int] = {}
    supplier_set: set = set()
    total_suppliers = 0

    for p in all_parts:
        if mode == "per_lokasi" and child_lokasi_ids:
            stok = sum(_net_stok(db, p.id_part, loc) for loc in child_lokasi_ids)
        else:
            stok = _net_stok(db, p.id_part)

        val = (p.harga_satuan or 0) * max(stok, 0)
        total_value += val

        if p.supplier:
            supplier_set.add(p.supplier)

        kat = p.kategori_ref
        sub = kat.subsistem if kat else "LAINNYA"
        by_subsistem[sub] = by_subsistem.get(sub, 0) + 1

        alat_key = p.kode_alat or "LAINNYA"
        by_alat[alat_key] = by_alat.get(alat_key, 0) + 1

        is_crit = p.is_critical or (p.stok_min > 0 and stok <= p.stok_min)
        if is_crit:
            critical_list.append({
                "id_part": p.id_part,
                "sku": p.sku,
                "nama_part": p.nama_part,
                "stok_sekarang": stok,
                "stok_min": p.stok_min,
                "unit": p.unit,
                "kode_alat": p.kode_alat,
                "nama_alat": p.kategori_alat_ref.nama_alat if p.kategori_alat_ref else None,
            })

    total_suppliers = len(supplier_set)

    # Monthly usage trend (last 12 months, OUT movements)
    twelve_ago = datetime.now() - timedelta(days=365)
    monthly_q = (
        db.query(
            func.strftime("%Y-%m", models.SparePartStok.waktu).label("bulan"),
            func.sum(models.SparePartStok.jumlah).label("jumlah"),
        )
        .filter(
            models.SparePartStok.tipe_gerakan == "OUT",
            models.SparePartStok.waktu >= twelve_ago,
        )
    )
    if mode == "per_lokasi" and child_lokasi_ids:
        monthly_q = monthly_q.filter(models.SparePartStok.id_lokasi.in_(child_lokasi_ids))
    monthly_data = monthly_q.group_by("bulan").order_by("bulan").all()

    return {
        "total_parts": total_parts,
        "total_types": total_types,
        "total_value": total_value,
        "auto_demand": auto_demand_count,
        "total_suppliers": total_suppliers,
        "critical_count": len(critical_list),
        "critical_list": critical_list[:50],   # cap at 50 for UI
        "by_subsistem": by_subsistem,
        "by_alat": by_alat,
        "monthly_usage": [
            {"bulan": r.bulan, "jumlah": int(r.jumlah)} for r in monthly_data
        ],
    }


# ── One-time Seed Trigger (SUPER_ADMIN only) ───────────────────────

@app.post("/api/inventaris/seed",
          dependencies=[Depends(require_role(["SUPER_ADMIN"]))])
def trigger_seed(db: Session = Depends(get_db)):
    """Triggers the sparepart catalog seed. Safe to call multiple times."""
    try:
        from seed import seed_spareparts
        seed_spareparts()
        return {"message": "Seed sparepart selesai."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================================================================
# ── PUBLIC ENDPOINTS (Landing Page / QR) ──────────────────────────
# ==================================================================


@app.get("/api/public/aset/{id_aset}")
def get_public_aset(id_aset: str, db: Session = Depends(get_db)):
    aset = (
        db.query(models.Aset)
        .filter(models.Aset.id_aset == id_aset, models.Aset.status_terakhir != "AFKIR")
        .first()
    )
    if not aset:
        raise HTTPException(
            status_code=404, detail="Aset tidak ditemukan atau di-afkir."
        )

    return {
        "id_aset": aset.id_aset,
        "kode_alat": aset.kategori.nama_alat if aset.kategori else aset.kode_alat,
        "id_lokasi": aset.lokasi_ref.nama_lokasi if aset.lokasi_ref else aset.id_lokasi,
        "status_terakhir": aset.status_terakhir,
        "tanggal_pembelian": aset.tanggal_pembelian,
    }


# ==================================================================
# ── ASSET FILES ──────────────────────────────────────────────────
# ==================================================================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

assets_dir = os.path.join(BASE_DIR, "assets")
if os.path.exists(assets_dir):
    app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

@app.get("/")
async def serve_index():
    return FileResponse(os.path.join(BASE_DIR, "index.html"))

@app.get("/{file_path:path}")
async def serve_static(file_path: str):
    # Prevent directory traversal
    if ".." in file_path or file_path.startswith("/"):
        raise HTTPException(status_code=403, detail="Access denied.")
    
    allowed_extensions = {'.html', '.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp'}
    ext = os.path.splitext(file_path)[1].lower()
    if ext not in allowed_extensions:
        raise HTTPException(status_code=404, detail="File not found.")
    
    path = os.path.join(BASE_DIR, file_path)
    real_path = os.path.realpath(path)
    real_base = os.path.realpath(BASE_DIR)
    
    if not real_path.startswith(real_base):
        raise HTTPException(status_code=403, detail="Access denied.")
    
    if os.path.exists(real_path) and os.path.isfile(real_path):
        media_type = None
        if ext == '.svg':
            media_type = "image/svg+xml"
        elif ext == '.png':
            media_type = "image/png"
        elif ext == '.jpg' or ext == '.jpeg':
            media_type = "image/jpeg"
        elif ext == '.gif':
            media_type = "image/gif"
        elif ext == '.ico':
            media_type = "image/x-icon"
        elif ext == '.webp':
            media_type = "image/webp"
        elif ext == '.css':
            media_type = "text/css"
        elif ext == '.js':
            media_type = "application/javascript"
        
        return FileResponse(real_path, media_type=media_type)
    
    raise HTTPException(status_code=404, detail="File not found.")