from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

# Replace with your actual PostgreSQL credentials
# Format: postgresql://<username>:<password>@<host>:<port>/<database_name>
SQLALCHEMY_DATABASE_URL = "postgresql://postgres:123@localhost:5432/sistem_aset_kai"

# The engine is the core interface to the database
engine = create_engine(SQLALCHEMY_DATABASE_URL)

# SessionLocal will be used to create individual database sessions for each request
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Base class that our database models will inherit from
Base = declarative_base()

