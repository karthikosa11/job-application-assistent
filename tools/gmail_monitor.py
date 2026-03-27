"""
Gmail monitor — polls every 5 minutes for job-related reply emails.

Improvement over naive domain heuristics:
  Uses Claude to extract the hiring company name from email content,
  then fuzzy-matches it against logged applications via difflib.
  Falls back to domain parsing only if Claude returns UNKNOWN.
"""

import difflib
import json
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

load_dotenv()

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent.parent
TOKEN_FILE = BASE_DIR / "token.json"
CREDS_FILE = BASE_DIR / "credentials.json"
CONFIG_FILE = BASE_DIR / "data" / "config.json"

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file",
]

POLL_INTERVAL = 300  # 5 minutes

# ATS/recruiter platform email domains that don't reveal the actual company
ATS_DOMAINS = {
    "greenhouse", "greenhouse-mail", "lever", "workday", "myworkdayjobs",
    "icims", "smartrecruiters", "jobvite", "taleo", "successfactors",
    "workable", "bamboohr", "recruiting", "jobs", "noreply", "no-reply",
    "donotreply", "do-not-reply", "notifications", "careers",
}

# Email classification → Sheets status mapping
STATUS_MAP = {
    "Interview Request": "Interview",
    "Screening": "Screening",
    "Offer": "Offer",
    "Rejection": "Rejected",
    "General Response": None,   # Don't update status for generic emails
    "Not Job Related": None,
}

_timer: threading.Timer = None
_running = False


def _load_config() -> dict:
    try:
        return json.loads(CONFIG_FILE.read_text())
    except Exception:
        return {}


def _save_config(cfg: dict):
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2))


def _get_gmail_service():
    creds = None
    if TOKEN_FILE.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(str(CREDS_FILE), SCOPES)
            creds = flow.run_local_server(port=0)
        TOKEN_FILE.write_text(creds.to_json())
    return build("gmail", "v1", credentials=creds)


def _get_or_create_label(service, label_name: str) -> str:
    """Return the label ID, creating it if it doesn't exist."""
    labels = service.users().labels().list(userId="me").execute().get("labels", [])
    for label in labels:
        if label["name"] == label_name:
            return label["id"]
    result = service.users().labels().create(
        userId="me",
        body={"name": label_name, "labelListVisibility": "labelHide", "messageListVisibility": "hide"}
    ).execute()
    return result["id"]


def _extract_body(payload) -> str:
    """Recursively extract plain text body from a Gmail message payload."""
    mime_type = payload.get("mimeType", "")
    if mime_type == "text/plain":
        data = payload.get("body", {}).get("data", "")
        if data:
            import base64
            return base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="replace")
    if "parts" in payload:
        for part in payload["parts"]:
            text = _extract_body(part)
            if text:
                return text
    return ""


def _find_matching_application(company_name: str, applications: list) -> dict | None:
    """
    Fuzzy-match a company name against logged applications.
    Returns the best matching application dict, or None.
    """
    if not applications or not company_name or company_name == "UNKNOWN":
        return None

    company_names = [a.get("company", "") for a in applications]
    low_names = [c.lower() for c in company_names]
    query = company_name.lower()

    # Try difflib fuzzy match (handles "Stripe Inc." vs "Stripe")
    matches = difflib.get_close_matches(query, low_names, n=1, cutoff=0.7)
    if matches:
        idx = low_names.index(matches[0])
        return applications[idx]

    # Fallback: substring containment
    for i, app in enumerate(applications):
        c = company_names[i].lower()
        if query in c or c in query:
            return app

    return None


def _domain_fallback(sender: str) -> str:
    """Extract company name from email domain as a last resort."""
    if "@" not in sender:
        return "UNKNOWN"
    domain = sender.split("@")[-1].split(">")[0].strip().rstrip(".")
    parts = domain.split(".")
    if len(parts) >= 2:
        candidate = parts[-2].lower()
        if candidate not in ATS_DOMAINS:
            return candidate.capitalize()
    return "UNKNOWN"


def poll_inbox():
    """
    Poll Gmail for unprocessed job-related emails.
    Classifies each, matches to an application, updates Sheets, sends WhatsApp.
    """
    try:
        from claude_assist import classify_email_status, extract_company_from_email
        from sheets_logger import get_all_applications, update_status
        from whatsapp_notify import send_status_update
    except ImportError as e:
        logger.error("[Gmail] Import error: %s", e)
        return

    cfg = _load_config()
    label_name = cfg.get("gmail_label", "job-tracker-processed")

    try:
        service = _get_gmail_service()
    except Exception as e:
        logger.warning("[Gmail] Auth failed: %s", e)
        return

    label_id = _get_or_create_label(service, label_name)
    last_check = cfg.get("last_gmail_check")

    # Build search query
    query_parts = [
        "is:unread",
        f"-label:{label_name}",
        "("
        "subject:(application OR applied OR interview OR offer OR position OR role OR job OR candidate OR opportunity) OR "
        "from:(careers OR jobs OR recruiting OR talent OR hr OR noreply) "
        ")"
    ]
    if last_check:
        # Gmail date query uses epoch seconds
        try:
            ts = int(datetime.fromisoformat(last_check).timestamp())
            query_parts.append(f"after:{ts}")
        except Exception:
            pass

    query = " ".join(query_parts)

    try:
        result = service.users().messages().list(userId="me", q=query, maxResults=20).execute()
        messages = result.get("messages", [])
    except Exception as e:
        logger.error("[Gmail] List messages failed: %s", e)
        return

    if not messages:
        cfg["last_gmail_check"] = datetime.now(timezone.utc).isoformat()
        _save_config(cfg)
        return

    applications = get_all_applications()

    for msg_ref in messages:
        try:
            msg = service.users().messages().get(
                userId="me", id=msg_ref["id"], format="full"
            ).execute()

            headers = {h["name"]: h["value"] for h in msg["payload"].get("headers", [])}
            subject = headers.get("Subject", "")
            sender = headers.get("From", "")
            body = _extract_body(msg["payload"])
            thread_id = msg.get("threadId", "")

            # Classify email
            classification = classify_email_status(subject, body)
            new_status = STATUS_MAP.get(classification)

            if new_status is None:
                # Not a meaningful status change — just label and skip
                service.users().messages().modify(
                    userId="me", id=msg_ref["id"],
                    body={"addLabelIds": [label_id], "removeLabelIds": ["UNREAD"]}
                ).execute()
                continue

            # Extract company name via Claude (primary)
            company_name = extract_company_from_email(subject, body, sender)

            # Domain fallback if Claude couldn't determine it
            if company_name == "UNKNOWN":
                company_name = _domain_fallback(sender)

            # Find matching application
            app = _find_matching_application(company_name, applications)

            if app:
                old_status = app.get("status", "Applied")
                if old_status != new_status:
                    updated = update_status(app["application_id"], new_status, thread_id)
                    if updated:
                        send_status_update(app["company"], app["role"], old_status, new_status)
                        logger.info("[Gmail] %s → %s for %s (%s)",
                                    old_status, new_status, app["company"], app["role"])
            else:
                logger.info("[Gmail] No application match found for company: %s (subject: %s)",
                            company_name, subject)

            # Label message as processed
            service.users().messages().modify(
                userId="me", id=msg_ref["id"],
                body={"addLabelIds": [label_id], "removeLabelIds": ["UNREAD"]}
            ).execute()

        except Exception as e:
            logger.error("[Gmail] Error processing message %s: %s", msg_ref["id"], e)
            continue

    cfg["last_gmail_check"] = datetime.now(timezone.utc).isoformat()
    _save_config(cfg)
    logger.info("[Gmail] Processed %d messages.", len(messages))


def _poll_and_reschedule():
    global _timer
    poll_inbox()
    if _running:
        _timer = threading.Timer(POLL_INTERVAL, _poll_and_reschedule)
        _timer.daemon = True
        _timer.start()


def start_polling():
    """Start background Gmail polling. Call once on server startup."""
    global _running, _timer
    if _running:
        return
    _running = True
    _timer = threading.Timer(10, _poll_and_reschedule)  # first poll after 10s
    _timer.daemon = True
    _timer.start()
    logger.info("[Gmail] Polling started (every %ds).", POLL_INTERVAL)


def stop_polling():
    global _running, _timer
    _running = False
    if _timer:
        _timer.cancel()
        _timer = None
