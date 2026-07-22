import os
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
from sqlalchemy import or_
from sqlalchemy.orm import Session
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


class MasterAlatCreate(BaseModel):
    kode_alat: str
    nama_alat: str


class LokasiCreate(BaseModel):
    id_lokasi: str
    nama_lokasi: str
    tipe: str


class AsetCreate(BaseModel):
    id_aset: str
    kode_alat: str
    id_lokasi: str
    tanggal_pembelian: date
    sumber_pengadaan: str


class PerbaikanCreate(BaseModel):
    id_aset: str
    kondisi: str
    keterangan: Optional[str] = "-"


class MutasiCreate(BaseModel):
    id_aset: str
    id_lokasi_tujuan: str
    alasan_mutasi: Optional[str] = None


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
    data: UserCreate,
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
        manager.disconnect(websocket)


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
        # Menangani case-insensitive jika nilai tipe di DB bervariasi
        conditions = [models.Lokasi.tipe.ilike(f"%{t}%") for t in tipe]
        query = query.filter(or_(*conditions))
    else:
        # Default: Jika client tidak mengirimkan parameter tipe,
        # langsung filter hanya DAOP, DIVRE, dan BALAI YASA
        query = query.filter(
            or_(
                models.Lokasi.tipe.ilike("%DAOP%"),
                models.Lokasi.tipe.ilike("%DIVRE%"),
                models.Lokasi.tipe.ilike("%BALAIYASA%"),
            )
        )

    return query.all()


@app.post("/api/master/lokasi", dependencies=[Depends(require_role(["SUPER_ADMIN"]))])
def create_master_lokasi(data: LokasiCreate, db: Session = Depends(get_db)):
    if db.query(models.Lokasi).filter_by(id_lokasi=data.id_lokasi).first():
        raise HTTPException(status_code=400, detail="ID Lokasi sudah ada.")
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
    if db.query(models.Aset).filter_by(id_aset=aset_in.id_aset).first():
        raise HTTPException(status_code=400, detail="ID Aset sudah terdaftar.")

    db_aset = models.Aset(
        id_aset=aset_in.id_aset,
        kode_alat=aset_in.kode_alat,
        id_lokasi=aset_in.id_lokasi,
        tanggal_pembelian=aset_in.tanggal_pembelian,
        sumber_pengadaan=aset_in.sumber_pengadaan,
        status_terakhir="SO",
    )
    db.add(db_aset)
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
        .filter(models.Aset.status_terakhir != "AFKIR")
        .all()
    )

    return [
        {
            "id_aset": a.id_aset,
            "kode_alat": a.kategori.nama_alat if a.kategori else a.kode_alat,
            "id_lokasi": a.lokasi_ref.nama_lokasi if a.lokasi_ref else a.id_lokasi,
            "status_terakhir": a.status_terakhir,
            "sumber_pengadaan": a.sumber_pengadaan,
            "tanggal_pembelian": a.tanggal_pembelian,
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

    db.add(
        models.RiwayatKondisi(
            id_aset=laporan.id_aset,
            id_pengguna=current_user.id_pengguna,
            kondisi=laporan.kondisi,
            keterangan=laporan.keterangan,
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
    aset.id_lokasi = mutasi.id_lokasi_tujuan
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
        .filter_by(id_aset=id_aset)
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
    original_lokasi = (
        mutasi[0].id_lokasi_asal if mutasi else (aset.id_lokasi if aset else "—")
    )

    results = []
    for m in mutasi:
        results.append(
            {
                "id_lokasi_asal": m.lokasi_asal.nama_lokasi
                if m.lokasi_asal
                else m.id_lokasi_asal,
                "id_lokasi_tujuan": m.lokasi_tujuan.nama_lokasi
                if m.lokasi_tujuan
                else m.id_lokasi_tujuan,
                "waktu_mutasi": m.waktu_mutasi.strftime("%Y-%m-%d %H:%M:%S")
                if m.waktu_mutasi
                else None,
                "id_pengguna": m.pengguna_ref.username
                if m.pengguna_ref
                else m.id_pengguna,
                "alasan_mutasi": m.alasan_mutasi or "—",
            }
        )

    return {
        "mutasi": results,
        "original_lokasi": original_lokasi,
        "sudah_kembali": aset.id_lokasi == original_lokasi if aset else False,
        "lokasi_sekarang": aset.lokasi_ref.nama_lokasi
        if aset and aset.lokasi_ref
        else "—",
    }


@app.get("/api/history/summary")
def get_history_summary(
    db: Session = Depends(get_db),
    current_user: models.Pengguna = Depends(get_current_user),
):
    asets = db.query(models.Aset).filter(models.Aset.status_terakhir != "AFKIR").all()
    results = []

    for a in asets:
        latest_repair = (
            db.query(models.RiwayatKondisi)
            .filter_by(id_aset=a.id_aset)
            .order_by(models.RiwayatKondisi.waktu_lapor.desc())
            .first()
        )
        all_mutasi = (
            db.query(models.RiwayatMutasi)
            .filter_by(id_aset=a.id_aset)
            .order_by(models.RiwayatMutasi.waktu_mutasi.asc())
            .all()
        )
        latest_mutasi = all_mutasi[-1] if all_mutasi else None

        results.append(
            {
                "id_aset": a.id_aset,
                "kode_alat": a.kategori.nama_alat if a.kategori else a.kode_alat,
                "id_lokasi": a.lokasi_ref.nama_lokasi if a.lokasi_ref else a.id_lokasi,
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
                },
                "mutasi": {
                    "count": len(all_mutasi),
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
                    == (all_mutasi[0].id_lokasi_asal if all_mutasi else a.id_lokasi),
                    "original_lokasi": all_mutasi[0].lokasi_asal.nama_lokasi
                    if all_mutasi and all_mutasi[0].lokasi_asal
                    else a.id_lokasi,
                }
                if all_mutasi
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
            riwayat = (
                db.query(models.RiwayatKondisi)
                .filter_by(id_aset=a.id_aset)
                .order_by(models.RiwayatKondisi.waktu_lapor.asc())
                .all()
            )

            if not riwayat:
                rows.append(
                    {
                        "no": None,
                        "tanggal": "—",
                        "id_aset": a.id_aset,
                        "kode_alat": nama_alat,
                        "id_lokasi_asal": nama_lokasi,
                        "id_pengguna": "—",
                        "kondisi": a.status_terakhir,
                        "keterangan": "Belum ada riwayat",
                    }
                )
            else:
                for i, r in enumerate(riwayat, start=1):
                    rows.append(
                        {
                            "no": i,
                            "tanggal": r.waktu_lapor.strftime("%Y-%m-%d")
                            if r.waktu_lapor
                            else "—",
                            "id_aset": a.id_aset,
                            "kode_alat": nama_alat,
                            "id_lokasi_asal": nama_lokasi,
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
            db.query(models.Aset).filter(models.Aset.status_terakhir != "AFKIR").all()
        ),
        "afkir": build_rows(
            db.query(models.Aset).filter(models.Aset.status_terakhir == "AFKIR").all()
        ),
    }


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
# ── STATIC FILES ──────────────────────────────────────────────────
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
