"""
Flask API server — multi-user production version.
All routes require a valid JWT (Authorization: Bearer <token>).
Data is scoped to the authenticated user.

Run locally:  python server.py
Run in prod:  gunicorn server:app --bind 0.0.0.0:8080 --workers 2
"""

import base64
import json
import logging
import os
import re
import sys
import tempfile
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, g, jsonify, redirect, request
from flask_cors import CORS

load_dotenv()

sys.path.insert(0, str(Path(__file__).parent))

from tools.auth import (
    APP_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
    create_jwt, google_auth_url, exchange_code_for_tokens,
    get_google_userinfo, require_auth,
)
from tools.crypto import decrypt, encrypt
from tools.database import SessionLocal, init_db
from tools.models import Application, User, UserConfig

app = Flask(__name__)
# Allow chrome-extension://* and localhost for dev
CORS(app, origins=["chrome-extension://*", "http://localhost:*", "http://127.0.0.1:*"])

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


# ─── Startup: create tables (SQLite dev / first-run safety net) ───────────────

@app.before_request
def _ensure_db():
    """One-time table creation guard (idempotent)."""
    pass  # Alembic handles migrations; init_db() called at bottom for SQLite dev


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _api_keys(user: User) -> dict:
    """Return decrypted API keys dict for a user."""
    return {
        "anthropic": decrypt(user.anthropic_api_key or ""),
        "openai":    decrypt(user.openai_api_key or ""),
        "gemini":    decrypt(user.gemini_api_key or ""),
    }


def _keyword_job_type(text: str) -> str:
    t = text.lower()
    patterns = [
        (r"\bc2c\b|corp.to.corp",                  "C2C"),
        (r"\bw-?2\b",                              "W2"),
        (r"\bcontract.to.hire\b|contract to hire", "Contract-to-Hire"),
        (r"\bfull[- ]time\b|fulltime",             "Full Time"),
        (r"\bpart[- ]time\b|parttime",             "Part Time"),
        (r"\bcontract\b",                          "Contract"),
    ]
    for pattern, label in patterns:
        if re.search(pattern, t):
            return label
    return ""


# ─── Auth ─────────────────────────────────────────────────────────────────────

@app.route("/auth/google")
def auth_google():
    """Redirect user to Google OAuth consent screen."""
    redirect_uri = f"{APP_URL}/auth/google/callback"
    # Pass the extension's chromiumapp.org URI via state so we can redirect back
    ext_redirect = request.args.get("ext_redirect", "")
    url = google_auth_url(redirect_uri, state=ext_redirect)
    return redirect(url)


@app.route("/auth/google/callback")
def auth_google_callback():
    """Exchange auth code, upsert user, issue JWT, redirect back to extension."""
    code = request.args.get("code")
    ext_redirect = request.args.get("state", "")
    if not code:
        return jsonify({"error": "No code returned from Google"}), 400

    redirect_uri = f"{APP_URL}/auth/google/callback"
    try:
        tokens = exchange_code_for_tokens(code, redirect_uri)
        userinfo = get_google_userinfo(tokens["access_token"])
    except Exception as e:
        logger.error("Google OAuth exchange failed: %s", e)
        return jsonify({"error": "OAuth exchange failed"}), 500

    google_id = userinfo.get("sub")
    email = userinfo.get("email", "")
    name = userinfo.get("name", "")
    picture = userinfo.get("picture", "")

    # Build token JSON for Sheets access (store access + refresh token)
    google_token_data = {
        "token": tokens.get("access_token"),
        "refresh_token": tokens.get("refresh_token"),
        "token_uri": "https://oauth2.googleapis.com/token",
        "client_id": GOOGLE_CLIENT_ID,
        "client_secret": GOOGLE_CLIENT_SECRET,
        "scopes": tokens.get("scope", "").split(),
    }

    db = SessionLocal()
    try:
        user = db.query(User).filter_by(google_id=google_id).first()
        if not user:
            user = User(google_id=google_id, email=email, name=name, picture_url=picture)
            db.add(user)
            db.flush()
            db.add(UserConfig(user_id=user.id))
        else:
            user.email = email
            user.name = name
            user.picture_url = picture
        # Always update the google token (refresh it on every login)
        user.google_token_json = encrypt(json.dumps(google_token_data))
        db.commit()
        jwt_token = create_jwt(user.id, email)
    finally:
        db.close()

    # Redirect back to extension with token
    if ext_redirect and "chromiumapp.org" in ext_redirect:
        return redirect(f"{ext_redirect}?token={jwt_token}")
    # Fallback: return JSON (for testing in browser)
    return jsonify({"token": jwt_token, "name": name, "email": email})


@app.route("/auth/me")
@require_auth
def auth_me():
    user: User = g.user
    return jsonify({
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "picture_url": user.picture_url,
        "has_anthropic_key": bool(user.anthropic_api_key),
        "has_sheets": bool(user.sheets_id),
    })


# ─── Health ──────────────────────────────────────────────────────────────────

@app.route("/health")
def health():
    return jsonify({"status": "ok"})


# ─── Config ──────────────────────────────────────────────────────────────────

@app.route("/config", methods=["GET"])
@require_auth
def get_config():
    user: User = g.user
    db = g.db
    cfg = db.query(UserConfig).filter_by(user_id=user.id).first()
    keys = _api_keys(user)
    return jsonify({
        "active_resume": cfg.active_resume_name if cfg else None,
        "daily_summary_enabled": cfg.daily_summary_enabled if cfg else True,
        "daily_summary_time": cfg.daily_summary_time if cfg else "09:00",
        "daily_summary_timezone": cfg.daily_summary_timezone if cfg else "UTC",
        # Masked API key indicators
        "has_anthropic_key": bool(keys["anthropic"]),
        "has_openai_key": bool(keys["openai"]),
        "has_gemini_key": bool(keys["gemini"]),
        "has_sheets": bool(user.sheets_id),
        "sheets_id": user.sheets_id or "",
        "whatsapp_recipient": user.whatsapp_recipient or "",
    })


@app.route("/config", methods=["POST"])
@require_auth
def save_config():
    user: User = g.user
    db = g.db
    data = request.get_json(force=True)

    cfg = db.query(UserConfig).filter_by(user_id=user.id).first()
    if not cfg:
        cfg = UserConfig(user_id=user.id)
        db.add(cfg)

    if "daily_summary_enabled" in data:
        cfg.daily_summary_enabled = bool(data["daily_summary_enabled"])
    if "daily_summary_time" in data:
        cfg.daily_summary_time = data["daily_summary_time"]
    if "daily_summary_timezone" in data:
        cfg.daily_summary_timezone = data["daily_summary_timezone"]

    # API keys — encrypt before storing
    if "anthropic_api_key" in data:
        user.anthropic_api_key = encrypt(data["anthropic_api_key"]) if data["anthropic_api_key"] else None
    if "openai_api_key" in data:
        user.openai_api_key = encrypt(data["openai_api_key"]) if data["openai_api_key"] else None
    if "gemini_api_key" in data:
        user.gemini_api_key = encrypt(data["gemini_api_key"]) if data["gemini_api_key"] else None

    # WhatsApp config
    if "whatsapp_phone_id" in data:
        user.whatsapp_phone_id = data["whatsapp_phone_id"]
    if "whatsapp_token" in data:
        user.whatsapp_token = encrypt(data["whatsapp_token"]) if data["whatsapp_token"] else None
    if "whatsapp_recipient" in data:
        user.whatsapp_recipient = data["whatsapp_recipient"]

    # Google Sheets
    if "sheets_id" in data:
        user.sheets_id = data["sheets_id"]

    db.commit()
    return jsonify({"ok": True})


# ─── AI Suggestion ───────────────────────────────────────────────────────────

@app.route("/suggest", methods=["POST"])
@require_auth
def suggest():
    user: User = g.user
    db = g.db
    data = request.get_json(force=True)
    field_label = data.get("field_label", "")
    field_type  = data.get("field_type", "text")
    page_context = data.get("page_context", {})

    if not field_label:
        return jsonify({"error": "field_label required"}), 400

    keys = _api_keys(user)
    if not keys["anthropic"]:
        return jsonify({"error": "Anthropic API key not configured. Add it in Options."}), 402

    try:
        from tools import claude_assist, memory_store, resume_manager

        resume_name = resume_manager.get_active_name(db, user.id)
        resume_text = resume_manager.get_resume_text(db, user.id, resume_name) if resume_name else ""
        matches = memory_store.search(db, user.id, field_label, top_k=3)
        memory_context = memory_store.format_memory_context(matches)

        suggestion = claude_assist.get_suggestion(
            field_label=field_label,
            field_type=field_type,
            page_context=page_context,
            resume_text=resume_text,
            memory_context=memory_context,
            api_key=keys["anthropic"],
        )
        return jsonify({"suggestion": suggestion})
    except Exception as e:
        logger.error("/suggest error: %s", e)
        return jsonify({"error": str(e)}), 500


# ─── Memory ──────────────────────────────────────────────────────────────────

@app.route("/memory", methods=["POST"])
@require_auth
def save_memory():
    user: User = g.user
    db = g.db
    data = request.get_json(force=True)
    question = data.get("question", "")
    answer   = data.get("answer", "")
    if not question or not answer:
        return jsonify({"error": "question and answer required"}), 400
    from tools import memory_store
    entry = memory_store.save(db, user.id, question, answer, data.get("metadata"))
    return jsonify(entry)


@app.route("/memory/search", methods=["GET"])
@require_auth
def search_memory():
    user: User = g.user
    db = g.db
    query = request.args.get("q", "")
    top_k = int(request.args.get("top_k", 5))
    if not query:
        return jsonify([])
    from tools import memory_store
    return jsonify(memory_store.search(db, user.id, query, top_k=top_k))


@app.route("/memory", methods=["GET"])
@require_auth
def get_memory():
    user: User = g.user
    db = g.db
    from tools import memory_store
    return jsonify(memory_store.get_all(db, user.id))


@app.route("/memory/<entry_id>", methods=["DELETE"])
@require_auth
def delete_memory(entry_id):
    user: User = g.user
    db = g.db
    from tools import memory_store
    ok = memory_store.delete(db, user.id, entry_id)
    return jsonify({"ok": ok})


# ─── Resumes ─────────────────────────────────────────────────────────────────

@app.route("/resumes", methods=["GET"])
@require_auth
def list_resumes():
    user: User = g.user
    db = g.db
    from tools import resume_manager
    return jsonify(resume_manager.list_resumes(db, user.id))


@app.route("/resumes/upload-pdf", methods=["POST"])
@require_auth
def upload_resume_pdf():
    user: User = g.user
    db = g.db
    data = request.get_json(force=True)
    name = data.get("name", "resume")
    b64  = data.get("file_data", "")
    if not b64:
        return jsonify({"error": "file_data required"}), 400
    try:
        from tools import resume_manager
        result = resume_manager.save_pdf_base64(db, user.id, name, b64)
        return jsonify(result)
    except Exception as e:
        logger.error("/resumes/upload-pdf error: %s", e)
        return jsonify({"error": str(e)}), 500


@app.route("/resumes/from-url", methods=["POST"])
@require_auth
def resume_from_url():
    user: User = g.user
    db = g.db
    data = request.get_json(force=True)
    name = data.get("name", "resume")
    url  = data.get("url", "")
    if not url:
        return jsonify({"error": "url required"}), 400
    try:
        from tools import resume_manager
        return jsonify(resume_manager.save_from_url(db, user.id, name, url))
    except Exception as e:
        logger.error("/resumes/from-url error: %s", e)
        return jsonify({"error": str(e)}), 500


@app.route("/resumes/from-text", methods=["POST"])
@require_auth
def resume_from_text():
    user: User = g.user
    db = g.db
    data = request.get_json(force=True)
    name    = data.get("name", "resume")
    content = data.get("content", "")
    if not content.strip():
        return jsonify({"error": "content required"}), 400
    from tools import resume_manager
    return jsonify(resume_manager.save_text(db, user.id, name, content))


@app.route("/resumes/active", methods=["GET"])
@require_auth
def get_active_resume():
    user: User = g.user
    db = g.db
    from tools import resume_manager
    return jsonify(resume_manager.get_active_resume(db, user.id))


@app.route("/resumes/active", methods=["POST"])
@require_auth
def set_active_resume():
    user: User = g.user
    db = g.db
    data = request.get_json(force=True)
    name = data.get("name", "")
    if not name:
        return jsonify({"error": "name required"}), 400
    from tools import resume_manager
    resume_manager.set_active(db, user.id, name)
    return jsonify({"ok": True})


@app.route("/resumes/<name>", methods=["DELETE"])
@require_auth
def delete_resume(name):
    user: User = g.user
    db = g.db
    from tools import resume_manager
    ok = resume_manager.delete_resume(db, user.id, name)
    return jsonify({"ok": ok})


# ─── Applications ────────────────────────────────────────────────────────────

@app.route("/log_application", methods=["POST"])
@require_auth
def log_application():
    user: User = g.user
    db = g.db
    data = request.get_json(force=True)
    company = data.get("company", "")
    role    = data.get("role", "")
    if not company or not role:
        return jsonify({"error": "company and role required"}), 400

    keys = _api_keys(user)

    # Auto-extract job type
    job_type = data.get("job_type", "")
    if not job_type:
        job_desc = data.get("job_description", "") or data.get("page_context", {}).get("description", "")
        if job_desc and keys["anthropic"]:
            try:
                from tools import claude_assist
                job_type = claude_assist.extract_job_type(job_desc, api_key=keys["anthropic"]) or ""
            except Exception as e:
                logger.warning("Job type AI extraction failed (%s), using keyword fallback", e)
                job_type = _keyword_job_type(job_desc)
        elif job_desc:
            job_type = _keyword_job_type(job_desc)

    import uuid as _uuid
    from datetime import datetime, timezone
    app_id = str(_uuid.uuid4())[:8].upper()
    today  = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    resume_attachment = data.get("resume_attachment") or {}
    # If no URL in attachment, look up active resume from DB directly
    if not resume_attachment.get("url"):
        try:
            from tools import resume_manager
            active_info = resume_manager.get_active_resume(db, user.id)
            att = active_info.get("attachment") or {}
            if att.get("url"):
                resume_attachment = att
        except Exception as _re:
            logger.warning("Could not fetch active resume for log_application: %s", _re)
    drive_link = resume_attachment.get("url", "")

    # Persist in DB
    application = Application(
        user_id=user.id,
        application_uuid=app_id,
        company=company,
        role=role,
        status=data.get("status", "Applied"),
        job_type=job_type,
        resume_name=(resume_attachment.get("name", "") if resume_attachment else ""),
        resume_attachment_json=json.dumps(resume_attachment) if resume_attachment else "",
        job_url=data.get("job_url", ""),
        platform=data.get("platform", ""),
        notes=data.get("notes", ""),
        resume_drive_link=drive_link,
        confidence=data.get("confidence"),
        job_description=(data.get("job_description", "") or "")[:10000],
        cover_letter=data.get("cover_letter", ""),
    )
    db.add(application)
    db.commit()

    # Optional: sync to user's Google Sheet
    try:
        from tools import sheets_logger
        google_token = decrypt(user.google_token_json or "")
        sheets_logger.log_application(
            {**data, "job_type": job_type, "resume_attachment": resume_attachment},
            sheets_id=user.sheets_id,
            google_token_json=google_token or None,
        )
    except Exception as e:
        logger.warning("Sheets sync failed (non-fatal): %s", e)

    return jsonify({**data, "application_id": app_id, "date_applied": today, "job_type": job_type})


@app.route("/applications", methods=["GET"])
@require_auth
def get_applications():
    user: User = g.user
    db = g.db
    apps = (
        db.query(Application)
        .filter_by(user_id=user.id)
        .order_by(Application.applied_at.desc())
        .all()
    )
    result = []
    for a in apps:
        attachment = {}
        if a.resume_attachment_json:
            try:
                attachment = json.loads(a.resume_attachment_json)
            except Exception:
                pass
        result.append({
            "Application ID": a.application_uuid,
            "Date Applied": a.applied_at.strftime("%Y-%m-%d") if a.applied_at else "",
            "Company": a.company,
            "Role": a.role,
            "Status": a.status,
            "Job Type": a.job_type or "",
            "Resume Attachment": attachment,
            "Job URL": a.job_url or "",
            "Platform": a.platform or "",
            "Notes": a.notes or "",
            "Last Updated": a.last_updated.isoformat() if a.last_updated else "",
            "Resume Drive Link": a.resume_drive_link or "",
            "Confidence": a.confidence or "",
            "Job Description": a.job_description or "",
            "Cover Letter": a.cover_letter or "",
        })
    return jsonify(result)


@app.route("/applications/<application_id>/notes", methods=["PATCH"])
@require_auth
def patch_notes(application_id):
    user: User = g.user
    db = g.db
    data = request.get_json(force=True)
    append_text = data.get("append", "")
    if not append_text:
        return jsonify({"error": "append required"}), 400

    app = db.query(Application).filter_by(user_id=user.id, application_uuid=application_id).first()
    if not app:
        return jsonify({"error": "Application not found"}), 404

    app.notes = f"{app.notes or ''}\n{append_text}".strip()
    db.commit()

    # Optional Sheets sync
    try:
        from tools import sheets_logger
        google_token = decrypt(user.google_token_json or "")
        sheets_logger.append_notes(
            application_id, append_text,
            sheets_id=user.sheets_id,
            google_token_json=google_token or None,
        )
    except Exception:
        pass

    return jsonify({"ok": True})


# ─── Chat ─────────────────────────────────────────────────────────────────────

@app.route("/chat/models", methods=["GET"])
@require_auth
def chat_models():
    user: User = g.user
    keys = _api_keys(user)
    from chat_handler import get_available_models
    return jsonify(get_available_models(api_keys=keys))


@app.route("/chat", methods=["POST"])
@require_auth
def chat_route():
    user: User = g.user
    data = request.get_json(force=True)
    model_id = data.get("model", "claude-sonnet-4-6")
    messages = data.get("messages", [])
    system   = data.get("system", "")
    if not messages:
        return jsonify({"error": "messages required"}), 400
    keys = _api_keys(user)
    try:
        from chat_handler import chat as llm_chat
        reply = llm_chat(model_id, messages, system, api_keys=keys)
        return jsonify({"reply": reply})
    except Exception as e:
        logger.error("/chat error: %s", e)
        return jsonify({"error": str(e)}), 500


# ─── Extract PDF text ─────────────────────────────────────────────────────────

@app.route("/extract-pdf-text", methods=["POST"])
@require_auth
def extract_pdf_text():
    data = request.get_json(force=True)
    b64  = data.get("file_data", "")
    if not b64:
        return jsonify({"error": "file_data required"}), 400
    try:
        import io, pdfplumber
        raw = b64.split(",", 1)[1] if "," in b64 else b64
        pdf_bytes = base64.b64decode(raw)
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            text = "\n".join(p.extract_text() or "" for p in pdf.pages).strip()
        return jsonify({"text": text})
    except Exception as e:
        logger.error("/extract-pdf-text error: %s", e)
        return jsonify({"error": str(e)}), 500


# ─── AI context extraction ────────────────────────────────────────────────────

@app.route("/extract_context", methods=["POST"])
@require_auth
def extract_context():
    user: User = g.user
    data = request.get_json(force=True)
    page_text = data.get("page_text", "")
    if not page_text.strip():
        return jsonify({"role": "", "company": ""})
    keys = _api_keys(user)
    try:
        from tools import claude_assist
        result = claude_assist.extract_job_context(page_text, api_key=keys["anthropic"] or None)
        return jsonify(result)
    except Exception as e:
        logger.warning("/extract_context error: %s", e)
        return jsonify({"role": "", "company": ""})


# ─── Cover letter ─────────────────────────────────────────────────────────────

@app.route("/cover_letter", methods=["POST"])
@require_auth
def cover_letter():
    user: User = g.user
    db = g.db
    data = request.get_json(force=True)
    company         = data.get("company", "")
    role            = data.get("role", "")
    job_description = data.get("job_description", "")
    if not job_description:
        return jsonify({"error": "job_description required"}), 400

    keys = _api_keys(user)
    if not keys["anthropic"]:
        return jsonify({"error": "Anthropic API key not configured"}), 402

    try:
        from tools import claude_assist, resume_manager
        resume_name = resume_manager.get_active_name(db, user.id)
        resume_text = resume_manager.get_resume_text(db, user.id, resume_name) if resume_name else ""
        letter = claude_assist.generate_cover_letter(
            resume_text, job_description, company, role, api_key=keys["anthropic"]
        )
        return jsonify({"cover_letter": letter})
    except Exception as e:
        logger.error("/cover_letter error: %s", e)
        return jsonify({"error": str(e)}), 500


# ─── Startup ─────────────────────────────────────────────────────────────────

# Init SQLite tables for local development (Alembic handles Postgres in prod)
if os.getenv("DATABASE_URL", "").startswith("sqlite") or not os.getenv("DATABASE_URL"):
    try:
        init_db()
    except Exception as e:
        logger.warning("init_db failed: %s", e)

if __name__ == "__main__":
    port = int(os.getenv("SERVER_PORT", 8765))
    logger.info("Starting Job Assistant API on port %d", port)
    app.run(host="127.0.0.1", port=port, debug=False)
