"""
SQLAlchemy database setup.

Reads DATABASE_URL from environment.
For local development, falls back to a SQLite file so the app starts
without a Postgres instance.
"""

import os
from contextlib import contextmanager

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./data/jobassist.db")

# psycopg2 driver expects postgresql://, but some hosting platforms
# (Heroku, Railway legacy) emit postgres://  — normalise it.
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(
    DATABASE_URL,
    connect_args=connect_args,
    pool_pre_ping=True,   # detect stale connections
    pool_recycle=300,     # recycle every 5 min (important for RDS)
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    """Yield a database session (use as a dependency or context manager)."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def db_session():
    """Context-manager wrapper for use outside of Flask request context."""
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def init_db():
    """Create all tables (used in dev/SQLite; production uses Alembic)."""
    from tools import models  # noqa: F401  — register models with Base
    Base.metadata.create_all(bind=engine)
