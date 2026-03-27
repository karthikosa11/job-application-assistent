import os
import sys
from logging.config import fileConfig
from pathlib import Path

from sqlalchemy import create_engine, pool
from alembic import context

# Load .env before importing tools.database (DATABASE_URL is read at import time)
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")

# Make tools/ importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from tools.database import Base, DATABASE_URL  # noqa: E402
import tools.models  # noqa: F401, E402 — register all models with Base

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=DATABASE_URL,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    # Create engine directly from DATABASE_URL — avoids configparser % interpolation issues
    connectable = create_engine(DATABASE_URL, poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
