"""
Resume manager — now backed by PostgreSQL (metadata + text) + S3 (PDF files).
All public functions accept a db session and user_id.
"""

import base64
import io
import os
import re
import tempfile

import boto3
import requests
from botocore.exceptions import ClientError
from sqlalchemy.orm import Session

from tools.models import Resume, UserConfig

S3_BUCKET = os.getenv("S3_BUCKET_NAME", "")
S3_REGION = os.getenv("S3_REGION", "us-east-1")

_s3 = None


def _get_s3():
    global _s3
    if _s3 is None:
        _s3 = boto3.client("s3", region_name=S3_REGION)
    return _s3


def _safe_name(name: str) -> str:
    return re.sub(r"[^\w\-]", "_", name.strip().lower())[:50]


def _extract_pdf_text(pdf_bytes: bytes) -> str:
    try:
        import pdfplumber
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            pages = [page.extract_text() or "" for page in pdf.pages]
        return "\n".join(pages).strip()
    except Exception as e:
        return f"[PDF text extraction failed: {e}]"


def _upload_to_s3(user_id: str, safe_name: str, pdf_bytes: bytes) -> str:
    """Upload PDF to S3 and return the S3 key."""
    if not S3_BUCKET:
        return ""
    key = f"resumes/{user_id}/{safe_name}.pdf"
    _get_s3().put_object(
        Bucket=S3_BUCKET,
        Key=key,
        Body=pdf_bytes,
        ContentType="application/pdf",
    )
    return key


def _delete_from_s3(s3_key: str) -> None:
    if not S3_BUCKET or not s3_key:
        return
    try:
        _get_s3().delete_object(Bucket=S3_BUCKET, Key=s3_key)
    except ClientError:
        pass


# ─── Public API ──────────────────────────────────────────────────────────────

def save_pdf(db: Session, user_id: str, name: str, file_bytes: bytes) -> dict:
    safe = _safe_name(name)
    text = _extract_pdf_text(file_bytes)
    s3_key = _upload_to_s3(user_id, safe, file_bytes)

    resume = db.query(Resume).filter_by(user_id=user_id, name=name).first()
    if resume:
        resume.content_text = text
        resume.s3_key = s3_key or resume.s3_key
        resume.resume_type = "pdf"
    else:
        resume = Resume(
            user_id=user_id, name=name, safe_name=safe,
            resume_type="pdf", content_text=text, s3_key=s3_key,
        )
        db.add(resume)
    db.commit()
    db.refresh(resume)
    return {"type": "pdf", "name": name, "path": s3_key}


def save_pdf_base64(db: Session, user_id: str, name: str, b64_data: str) -> dict:
    if "," in b64_data:
        b64_data = b64_data.split(",", 1)[1]
    return save_pdf(db, user_id, name, base64.b64decode(b64_data))


def save_from_url(db: Session, user_id: str, name: str, url: str) -> dict:
    safe = _safe_name(name)
    resp = requests.get(url, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
    resp.raise_for_status()

    content_type = resp.headers.get("Content-Type", "")
    is_pdf = url.lower().endswith(".pdf") or "pdf" in content_type or "export=download" in url.lower()

    if is_pdf:
        text = _extract_pdf_text(resp.content)
        s3_key = _upload_to_s3(user_id, safe, resp.content)
        r_type = "pdf"
    else:
        text = resp.text
        s3_key = ""
        r_type = "url"

    resume = db.query(Resume).filter_by(user_id=user_id, name=name).first()
    if resume:
        resume.content_text = text
        resume.source_url = url
        resume.resume_type = r_type
        resume.s3_key = s3_key or resume.s3_key
    else:
        resume = Resume(
            user_id=user_id, name=name, safe_name=safe,
            resume_type=r_type, content_text=text, source_url=url, s3_key=s3_key,
        )
        db.add(resume)
    db.commit()
    return {"type": r_type, "name": name, "url": url}


def save_text(db: Session, user_id: str, name: str, content: str) -> dict:
    safe = _safe_name(name)
    resume = db.query(Resume).filter_by(user_id=user_id, name=name).first()
    if resume:
        resume.content_text = content.strip()
        resume.resume_type = "text"
    else:
        resume = Resume(
            user_id=user_id, name=name, safe_name=safe,
            resume_type="text", content_text=content.strip(),
        )
        db.add(resume)
    db.commit()
    return {"type": "text", "name": name, "preview": content[:200]}


def get_resume_text(db: Session, user_id: str, name: str) -> str:
    resume = db.query(Resume).filter_by(user_id=user_id, name=name).first()
    return resume.content_text or "" if resume else ""


def list_resumes(db: Session, user_id: str) -> list:
    cfg = db.query(UserConfig).filter_by(user_id=user_id).first()
    active = cfg.active_resume_name if cfg else None

    resumes = db.query(Resume).filter_by(user_id=user_id).order_by(Resume.created_at).all()
    result = []
    for r in resumes:
        entry = {
            "name": r.name,
            "safe_name": r.safe_name,
            "type": r.resume_type,
            "preview": (r.content_text or "")[:150],
            "is_active": (active == r.name),
        }
        if r.resume_type == "url" and r.source_url:
            entry["url"] = r.source_url
        elif r.resume_type == "pdf" and r.s3_key:
            entry["url"] = f"https://{S3_BUCKET}.s3.{S3_REGION}.amazonaws.com/{r.s3_key}"
        if r.drive_url:
            entry["drive_url"] = r.drive_url
        result.append(entry)
    return result


def set_active(db: Session, user_id: str, name: str) -> None:
    cfg = db.query(UserConfig).filter_by(user_id=user_id).first()
    if cfg:
        cfg.active_resume_name = name
    else:
        from tools.models import UserConfig as UC
        db.add(UC(user_id=user_id, active_resume_name=name))
    db.commit()


def get_active_name(db: Session, user_id: str) -> str | None:
    cfg = db.query(UserConfig).filter_by(user_id=user_id).first()
    return cfg.active_resume_name if cfg else None


def get_active_resume(db: Session, user_id: str) -> dict:
    """Return the active resume name + attachment object (for the extension)."""
    name = get_active_name(db, user_id)
    if not name:
        return {"active_resume": None, "attachment": None}
    resume = db.query(Resume).filter_by(user_id=user_id, name=name).first()
    if not resume:
        return {"active_resume": name, "attachment": None}
    attachment = {
        "type": resume.resume_type,
        "name": resume.name,
    }
    if resume.resume_type == "url" and resume.source_url:
        attachment["url"] = resume.source_url
    elif resume.resume_type == "pdf" and resume.drive_url:
        attachment["url"] = resume.drive_url
    elif resume.resume_type == "pdf" and resume.s3_key:
        attachment["url"] = f"https://{S3_BUCKET}.s3.{S3_REGION}.amazonaws.com/{resume.s3_key}"
    else:
        attachment["preview"] = (resume.content_text or "")[:200]
    return {"active_resume": name, "attachment": attachment}


def set_drive_url(db: Session, user_id: str, name: str, drive_url: str) -> None:
    resume = db.query(Resume).filter_by(user_id=user_id, name=name).first()
    if resume:
        resume.drive_url = drive_url
        db.commit()


def delete_resume(db: Session, user_id: str, name: str) -> bool:
    resume = db.query(Resume).filter_by(user_id=user_id, name=name).first()
    if not resume:
        return False
    if resume.s3_key:
        _delete_from_s3(resume.s3_key)
    db.delete(resume)

    # Clear active if it was this resume
    cfg = db.query(UserConfig).filter_by(user_id=user_id).first()
    if cfg and cfg.active_resume_name == name:
        remaining = db.query(Resume).filter_by(user_id=user_id).filter(Resume.name != name).first()
        cfg.active_resume_name = remaining.name if remaining else None

    db.commit()
    return True
