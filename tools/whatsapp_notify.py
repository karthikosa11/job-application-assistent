"""
WhatsApp notifications via Meta WhatsApp Business Cloud API.
https://developers.facebook.com/docs/whatsapp/cloud-api

Three message types:
  1. Application submitted   — when a job is logged
  2. Status update           — when Gmail detects a reply
  3. Daily summary           — scheduled digest of all applications
"""

import os
from datetime import datetime, timezone

import requests
from dotenv import load_dotenv

load_dotenv()

PHONE_NUMBER_ID = os.getenv("WHATSAPP_PHONE_NUMBER_ID", "")
ACCESS_TOKEN = os.getenv("WHATSAPP_ACCESS_TOKEN", "")
RECIPIENT = os.getenv("WHATSAPP_RECIPIENT", "")  # e.g. 919876543210 (no +)

STATUS_EMOJI = {
    "Applied": "📝",
    "Screening": "🔍",
    "Interview": "🎯",
    "Offer": "🎉",
    "Rejected": "❌",
    "Ghosted": "👻",
}


def _send_message(text: str) -> bool:
    """Send a WhatsApp text message via Meta Cloud API. Returns True on success."""
    if not all([PHONE_NUMBER_ID, ACCESS_TOKEN, RECIPIENT]):
        print("[WhatsApp] Credentials not configured — skipping notification.")
        return False

    url = f"https://graph.facebook.com/v20.0/{PHONE_NUMBER_ID}/messages"
    headers = {
        "Authorization": f"Bearer {ACCESS_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {
        "messaging_product": "whatsapp",
        "to": RECIPIENT,
        "type": "text",
        "text": {"body": text},
    }
    try:
        resp = requests.post(url, json=payload, headers=headers, timeout=10)
        resp.raise_for_status()
        return True
    except requests.RequestException as e:
        print(f"[WhatsApp] Send failed: {e}")
        return False


def send_application_submitted(company: str, role: str, resume_name: str = "", job_url: str = "") -> bool:
    """Send a notification when a new job application is logged."""
    now = datetime.now(timezone.utc).strftime("%d %b %Y, %H:%M UTC")
    resume_line = f"📄 Resume: {resume_name}\n" if resume_name else ""
    url_line = f"🔗 {job_url}\n" if job_url else ""

    text = (
        f"📝 *New Job Application Logged*\n\n"
        f"🏢 Company: {company}\n"
        f"💼 Role: {role}\n"
        f"{resume_line}"
        f"{url_line}"
        f"📅 {now}"
    )
    return _send_message(text)


def send_status_update(company: str, role: str, old_status: str, new_status: str) -> bool:
    """Send a notification when a job application status changes."""
    now = datetime.now(timezone.utc).strftime("%d %b %Y, %H:%M UTC")
    emoji = STATUS_EMOJI.get(new_status, "🔔")

    text = (
        f"{emoji} *Application Status Update*\n\n"
        f"🏢 Company: {company}\n"
        f"💼 Role: {role}\n"
        f"📊 Status: {old_status} → *{new_status}*\n"
        f"📅 {now}"
    )
    return _send_message(text)


def send_daily_summary(applications: list) -> bool:
    """
    Send a daily digest of all job applications.
    applications: list of dicts from sheets_logger.get_all_applications()
    """
    if not applications:
        text = "📊 *Daily Job Search Summary*\n\nNo applications tracked yet."
        return _send_message(text)

    today = datetime.now(timezone.utc)

    # Count by status
    status_counts = {}
    for app in applications:
        s = app.get("status", "Applied")
        status_counts[s] = status_counts.get(s, 0) + 1

    # Count this week (last 7 days)
    week_count = 0
    for app in applications:
        try:
            d = datetime.strptime(app.get("date_applied", ""), "%Y-%m-%d")
            if (today.date() - d.date()).days <= 7:
                week_count += 1
        except ValueError:
            pass

    total = len(applications)

    # Build status breakdown lines
    status_lines = ""
    for status in ["Applied", "Screening", "Interview", "Offer", "Rejected", "Ghosted"]:
        count = status_counts.get(status, 0)
        if count > 0:
            e = STATUS_EMOJI.get(status, "•")
            status_lines += f"  {e} {status}: {count}\n"

    # Recent activity (last 3 entries by date)
    recent = applications[:3]
    recent_lines = ""
    for app in recent:
        e = STATUS_EMOJI.get(app.get("status", ""), "•")
        recent_lines += f"  {e} {app.get('company', '?')} — {app.get('role', '?')}\n"

    date_str = today.strftime("%d %b %Y")
    text = (
        f"📊 *Daily Job Search Summary*\n"
        f"_{date_str}_\n\n"
        f"📈 Total Applications: *{total}*\n"
        f"🗓 This Week: *{week_count}*\n\n"
        f"*Status Breakdown:*\n{status_lines}\n"
        f"*Recent:*\n{recent_lines}"
    )
    return _send_message(text.strip())
