import os

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

load_dotenv()

# Format: postgresql://<username>:<password>@<host>:<port>/<database_name>
#
# The credentials are read from DATABASE_URL when it is set (put it in .env),
# falling back to the local development database so an existing checkout keeps
# working with no setup. Committing a real password is a liability the moment
# this repo leaves one machine — see the deployment notes in CLAUDE.md.
_DEFAULT_URL = "postgresql://postgres:Nue23072005*@localhost:5000/warehouse_monitoring"
SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL", _DEFAULT_URL)

# ── Engine ────────────────────────────────────────────────────────────────
#
# This was previously a bare `create_engine(URL)`, which inherits a pool of 5
# connections plus 10 overflow — a hard ceiling of 15 concurrent DB-touching
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
    connect_args={"connect_timeout": 5, "application_name": "sima-kai"},
)

# SessionLocal will be used to create individual database sessions for each request
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Base class that our database models will inherit from
Base = declarative_base()
