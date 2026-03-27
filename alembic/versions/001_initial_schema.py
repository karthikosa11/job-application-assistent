"""Initial schema — users, configs, resumes, memory, applications

Revision ID: 001
Revises:
Create Date: 2026-03-23
"""

from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("google_id", sa.String(255), unique=True, nullable=False),
        sa.Column("email", sa.String(255), unique=True, nullable=False),
        sa.Column("name", sa.String(255)),
        sa.Column("picture_url", sa.Text),
        sa.Column("anthropic_api_key", sa.Text),
        sa.Column("openai_api_key", sa.Text),
        sa.Column("gemini_api_key", sa.Text),
        sa.Column("whatsapp_phone_id", sa.Text),
        sa.Column("whatsapp_token", sa.Text),
        sa.Column("whatsapp_recipient", sa.Text),
        sa.Column("sheets_id", sa.Text),
        sa.Column("google_token_json", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table(
        "user_configs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False),
        sa.Column("active_resume_name", sa.Text),
        sa.Column("daily_summary_enabled", sa.Boolean, server_default="true"),
        sa.Column("daily_summary_time", sa.String(10), server_default="'09:00'"),
        sa.Column("daily_summary_timezone", sa.String(100), server_default="'UTC'"),
        sa.Column("last_gmail_check", sa.DateTime(timezone=True)),
        sa.Column("gmail_label", sa.String(255), server_default="'job-tracker-processed'"),
    )

    op.create_table(
        "resumes",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("safe_name", sa.String(255), nullable=False),
        sa.Column("resume_type", sa.String(10), nullable=False),
        sa.Column("content_text", sa.Text),
        sa.Column("source_url", sa.Text),
        sa.Column("s3_key", sa.Text),
        sa.Column("drive_url", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "name", name="uq_resume_user_name"),
    )

    op.create_table(
        "memory_entries",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("entry_id", sa.String(20), nullable=False),
        sa.Column("question", sa.Text, nullable=False),
        sa.Column("answer", sa.Text, nullable=False),
        sa.Column("used_count", sa.Integer, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("last_used", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("meta_company", sa.Text),
        sa.Column("meta_role", sa.Text),
        sa.Column("meta_platform", sa.Text),
    )

    op.create_table(
        "applications",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("application_uuid", sa.String(20), nullable=False),
        sa.Column("company", sa.Text, nullable=False),
        sa.Column("role", sa.Text, nullable=False),
        sa.Column("status", sa.String(50), server_default="'Applied'"),
        sa.Column("job_type", sa.Text),
        sa.Column("resume_name", sa.Text),
        sa.Column("resume_attachment_json", sa.Text),
        sa.Column("job_url", sa.Text),
        sa.Column("platform", sa.Text),
        sa.Column("notes", sa.Text),
        sa.Column("last_updated", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("gmail_thread_id", sa.Text),
        sa.Column("resume_drive_link", sa.Text),
        sa.Column("confidence", sa.Integer),
        sa.Column("job_description", sa.Text),
        sa.Column("cover_letter", sa.Text),
        sa.Column("applied_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # Indexes for common queries
    op.create_index("ix_resumes_user_id", "resumes", ["user_id"])
    op.create_index("ix_memory_entries_user_id", "memory_entries", ["user_id"])
    op.create_index("ix_applications_user_id", "applications", ["user_id"])
    op.create_index("ix_applications_applied_at", "applications", ["applied_at"])


def downgrade() -> None:
    op.drop_table("applications")
    op.drop_table("memory_entries")
    op.drop_table("resumes")
    op.drop_table("user_configs")
    op.drop_table("users")
