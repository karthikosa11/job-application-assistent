"""
SQLAlchemy ORM models for all persisted entities.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tools.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _uuid() -> str:
    return str(uuid.uuid4())


# ─── Users ────────────────────────────────────────────────────────────────────

class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    google_id: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    name: Mapped[str | None] = mapped_column(String(255))
    picture_url: Mapped[str | None] = mapped_column(Text)

    # API keys — stored encrypted via crypto.py
    anthropic_api_key: Mapped[str | None] = mapped_column(Text)
    openai_api_key: Mapped[str | None] = mapped_column(Text)
    gemini_api_key: Mapped[str | None] = mapped_column(Text)

    # WhatsApp (Meta Cloud API) — optional
    whatsapp_phone_id: Mapped[str | None] = mapped_column(Text)
    whatsapp_token: Mapped[str | None] = mapped_column(Text)   # encrypted
    whatsapp_recipient: Mapped[str | None] = mapped_column(Text)

    # Google Sheets — optional
    sheets_id: Mapped[str | None] = mapped_column(Text)
    google_token_json: Mapped[str | None] = mapped_column(Text)  # encrypted

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)

    # Relationships
    config: Mapped["UserConfig | None"] = relationship(
        "UserConfig", back_populates="user", uselist=False, cascade="all, delete-orphan"
    )
    resumes: Mapped[list["Resume"]] = relationship(
        "Resume", back_populates="user", cascade="all, delete-orphan"
    )
    memory_entries: Mapped[list["MemoryEntry"]] = relationship(
        "MemoryEntry", back_populates="user", cascade="all, delete-orphan"
    )
    applications: Mapped[list["Application"]] = relationship(
        "Application", back_populates="user", cascade="all, delete-orphan"
    )


# ─── User Config ──────────────────────────────────────────────────────────────

class UserConfig(Base):
    __tablename__ = "user_configs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False)

    active_resume_name: Mapped[str | None] = mapped_column(Text)
    daily_summary_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    daily_summary_time: Mapped[str] = mapped_column(String(10), default="09:00")
    daily_summary_timezone: Mapped[str] = mapped_column(String(100), default="UTC")
    last_gmail_check: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    gmail_label: Mapped[str] = mapped_column(String(255), default="job-tracker-processed")

    user: Mapped["User"] = relationship("User", back_populates="config")


# ─── Resumes ──────────────────────────────────────────────────────────────────

class Resume(Base):
    __tablename__ = "resumes"
    __table_args__ = (UniqueConstraint("user_id", "name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    name: Mapped[str] = mapped_column(String(255), nullable=False)       # display name
    safe_name: Mapped[str] = mapped_column(String(255), nullable=False)  # slug used as S3 key prefix
    resume_type: Mapped[str] = mapped_column(String(10), nullable=False) # pdf | url | text
    content_text: Mapped[str | None] = mapped_column(Text)               # extracted plain text
    source_url: Mapped[str | None] = mapped_column(Text)                 # original URL (url-type)
    s3_key: Mapped[str | None] = mapped_column(Text)                     # S3 object key for PDF
    drive_url: Mapped[str | None] = mapped_column(Text)                  # Google Drive link

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    user: Mapped["User"] = relationship("User", back_populates="resumes")


# ─── Memory Entries ───────────────────────────────────────────────────────────

class MemoryEntry(Base):
    __tablename__ = "memory_entries"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    entry_id: Mapped[str] = mapped_column(String(20), nullable=False)    # short 8-char ID for API
    question: Mapped[str] = mapped_column(Text, nullable=False)
    answer: Mapped[str] = mapped_column(Text, nullable=False)
    used_count: Mapped[int] = mapped_column(Integer, default=1)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_used: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    # Metadata
    meta_company: Mapped[str | None] = mapped_column(Text)
    meta_role: Mapped[str | None] = mapped_column(Text)
    meta_platform: Mapped[str | None] = mapped_column(Text)

    user: Mapped["User"] = relationship("User", back_populates="memory_entries")


# ─── Applications ─────────────────────────────────────────────────────────────

class Application(Base):
    __tablename__ = "applications"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    application_uuid: Mapped[str] = mapped_column(String(20), nullable=False)  # 8-char short ID
    company: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(50), default="Applied")
    job_type: Mapped[str | None] = mapped_column(Text)
    resume_name: Mapped[str | None] = mapped_column(Text)
    resume_attachment_json: Mapped[str | None] = mapped_column(Text)    # JSON string
    job_url: Mapped[str | None] = mapped_column(Text)
    platform: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    last_updated: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)
    gmail_thread_id: Mapped[str | None] = mapped_column(Text)
    resume_drive_link: Mapped[str | None] = mapped_column(Text)
    confidence: Mapped[int | None] = mapped_column(Integer)
    job_description: Mapped[str | None] = mapped_column(Text)
    cover_letter: Mapped[str | None] = mapped_column(Text)
    applied_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    user: Mapped["User"] = relationship("User", back_populates="applications")
