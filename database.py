import os

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

load_dotenv()

# Format: postgresql://<username>:<password>@<host>:<port>/<database_name>
#
# Read from DATABASE_URL, with NO fallback. There used to be a hardcoded local
# development URL here so a fresh checkout booted with no setup, but it carried
# a real password in a tracked file, which is a liability the moment the repo
# leaves one machine. Copy `.env.example` to `.env` instead; the error below
# says exactly that.
SQLALCHEMY_DATABASE_URL = (os.getenv("DATABASE_URL") or "").strip()
if not SQLALCHEMY_DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL belum diset. Salin .env.example menjadi .env, lalu isi:\n\n"
        "    DATABASE_URL=postgresql://postgres:<password>@localhost:5000/warehouse_monitoring\n"
    )

# ── Engine ────────────────────────────────────────────────────────────────
#
# This was previously a bare `create_engine(URL)`, which inherits a pool of 5
# connections plus 10 overflow, a hard ceiling of 15 concurrent DB-touching
# requests, after which request 16 blocks for 30 seconds and then 500s. Several
# endpoints hold their connection for the length of the handler, so a handful of
# people on the Riwayat screen was enough to stall everything else.
#
# `pool_pre_ping` is the setting that matters most in practice: without it,
# every connection killed by a PostgreSQL restart, an idle timeout or a NAT
# reaper stays in the pool and raises `OperationalError: server closed the
# connection` on first use. The symptom is random 500s that only a full app
# restart clears. Pre-ping costs one cheap round trip per checkout and makes
# that class of failure disappear.
engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    pool_size=20,
    max_overflow=30,
    pool_pre_ping=True,
    # Recycle below the usual 1-hour idle cutoffs on managed Postgres and most
    # connection proxies, so a connection is never handed out near its death.
    pool_recycle=1800,
    # Fail fast rather than making the caller wait out the 30s default; a
    # saturated pool should surface as an error, not as a hung page.
    pool_timeout=10,
    connect_args={"connect_timeout": 5, "application_name": "ramces"},
)

# SessionLocal will be used to create individual database sessions for each request
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Base class that our database models will inherit from
Base = declarative_base()
