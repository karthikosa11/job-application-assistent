"""
Google Sheets logger for job applications.

Columns A–P: Date Applied, Company, Role, Status, Job Type,
Resume (JSON), Job URL, Platform, App ID, Notes, Last Updated,
Gmail Thread ID, Resume Drive Link, Confidence, Job Description, Cover Letter
"""

import json
import logging
import uuid
from datetime import datetime

logger = logging.getLogger(__name__)

HEADERS = [
    "Date Applied", "Company", "Role", "Status", "Job Type",
    "Resume Attachment", "Job URL", "Platform", "Application ID",
    "Notes", "Last Updated", "Gmail Thread ID", "Resume Drive Link", "Confidence",
    "Job Description", "Cover Letter",
]

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file",
]


def _get_service(google_token_json: str):
    """Build a Sheets API service from a serialized token JSON string."""
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build

    creds = Credentials.from_authorized_user_info(json.loads(google_token_json), SCOPES)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
    return build("sheets", "v4", credentials=creds)


def _col_letter(idx: int) -> str:
    if idx < 26:
        return chr(65 + idx)
    return chr(64 + idx // 26) + chr(65 + idx % 26)


def _ensure_headers(service, sheets_id: str) -> None:
    result = service.spreadsheets().values().get(
        spreadsheetId=sheets_id, range="Sheet1!A1:Z1"
    ).execute()
    existing = result.get("values", [[]])[0] if result.get("values") else []

    if not existing:
        service.spreadsheets().values().update(
            spreadsheetId=sheets_id, range="Sheet1!A1",
            valueInputOption="RAW", body={"values": [HEADERS]},
        ).execute()
        return

    updates = [
        {"range": f"Sheet1!{_col_letter(i)}1", "values": [[expected]]}
        for i, expected in enumerate(HEADERS)
        if (existing[i] if i < len(existing) else "") != expected
    ]
    if updates:
        service.spreadsheets().values().batchUpdate(
            spreadsheetId=sheets_id,
            body={"valueInputOption": "RAW", "data": updates},
        ).execute()


# ─── Public API ──────────────────────────────────────────────────────────────

def log_application(data: dict, sheets_id: str | None, google_token_json: str | None) -> dict:
    """
    Append a new row to the user's Google Sheet.
    Returns data dict augmented with application_id and date_applied.
    If sheets_id or google_token_json are not set, skips Sheets silently.
    """
    app_id = str(uuid.uuid4())[:8].upper()
    today = datetime.utcnow().strftime("%Y-%m-%d")
    now = datetime.utcnow().strftime("%b %d, %Y %I:%M %p UTC")

    if sheets_id and google_token_json:
        try:
            service = _get_service(google_token_json)
            _ensure_headers(service, sheets_id)

            resume_attachment = data.get("resume_attachment") or {}
            resume_json = json.dumps(resume_attachment) if resume_attachment else ""
            drive_link = resume_attachment.get("url", "") if resume_attachment else ""

            row = [
                today,
                data.get("company", ""),
                data.get("role", ""),
                data.get("status", "Applied"),
                data.get("job_type", ""),
                resume_json,
                data.get("job_url", ""),
                data.get("platform", ""),
                app_id,
                data.get("notes", ""),
                now,
                "",                                         # Gmail Thread ID
                drive_link,
                str(data.get("confidence", "")),
                data.get("job_description", "")[:10000],
                data.get("cover_letter", ""),
            ]

            service.spreadsheets().values().append(
                spreadsheetId=sheets_id, range="Sheet1!A1",
                valueInputOption="RAW", insertDataOption="INSERT_ROWS",
                body={"values": [row]},
            ).execute()
            logger.info("Sheets: logged application %s for %s", app_id, data.get("company"))
        except Exception as e:
            logger.warning("Sheets log_application failed (non-fatal): %s", e)

    return {**data, "application_id": app_id, "date_applied": today}


def get_all_applications(sheets_id: str | None, google_token_json: str | None) -> list:
    """Return all application rows. Returns [] if Sheets not configured."""
    if not sheets_id or not google_token_json:
        return []
    try:
        service = _get_service(google_token_json)
        result = service.spreadsheets().values().get(
            spreadsheetId=sheets_id, range="Sheet1!A:P"
        ).execute()
        rows = result.get("values", [])
        if len(rows) <= 1:
            return []

        headers = rows[0]
        apps = []
        for row in rows[1:]:
            padded = row + [""] * (len(headers) - len(row))
            entry = dict(zip(headers, padded))
            raw = entry.get("Resume Attachment", "")
            if raw:
                try:
                    entry["Resume Attachment"] = json.loads(raw)
                except Exception:
                    pass
            apps.append(entry)
        apps.reverse()
        return apps
    except Exception as e:
        logger.warning("Sheets get_all_applications failed: %s", e)
        return []


def update_status(
    app_id: str, new_status: str,
    sheets_id: str | None, google_token_json: str | None,
) -> bool:
    """Update status for an application by ID. Returns True on success."""
    if not sheets_id or not google_token_json:
        return False
    try:
        service = _get_service(google_token_json)
        result = service.spreadsheets().values().get(
            spreadsheetId=sheets_id, range="Sheet1!I:K"
        ).execute()
        rows = result.get("values", [])
        for i, row in enumerate(rows[1:], start=2):
            if row and row[0] == app_id:
                now = datetime.utcnow().isoformat()
                service.spreadsheets().values().batchUpdate(
                    spreadsheetId=sheets_id,
                    body={"valueInputOption": "RAW", "data": [
                        {"range": f"Sheet1!D{i}", "values": [[new_status]]},
                        {"range": f"Sheet1!K{i}", "values": [[now]]},
                    ]},
                ).execute()
                return True
    except Exception as e:
        logger.warning("Sheets update_status failed: %s", e)
    return False


def append_notes(
    app_id: str, text: str,
    sheets_id: str | None, google_token_json: str | None,
) -> bool:
    """Append notes for an application. Returns True on success."""
    if not sheets_id or not google_token_json:
        return False
    try:
        service = _get_service(google_token_json)
        result = service.spreadsheets().values().get(
            spreadsheetId=sheets_id, range="Sheet1!I:K"
        ).execute()
        rows = result.get("values", [])
        for i, row in enumerate(rows[1:], start=2):
            if row and row[0] == app_id:
                existing_notes = ""
                notes_result = service.spreadsheets().values().get(
                    spreadsheetId=sheets_id, range=f"Sheet1!J{i}"
                ).execute()
                vals = notes_result.get("values", [[]])
                if vals and vals[0]:
                    existing_notes = vals[0][0]
                new_notes = f"{existing_notes}\n{text}".strip()
                now = datetime.utcnow().isoformat()
                service.spreadsheets().values().batchUpdate(
                    spreadsheetId=sheets_id,
                    body={"valueInputOption": "RAW", "data": [
                        {"range": f"Sheet1!J{i}", "values": [[new_notes]]},
                        {"range": f"Sheet1!K{i}", "values": [[now]]},
                    ]},
                ).execute()
                return True
    except Exception as e:
        logger.warning("Sheets append_notes failed: %s", e)
    return False
