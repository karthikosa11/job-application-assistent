"""
Google Drive uploader for resume PDFs.
Uploads a PDF to the authenticated user's Drive and returns a shareable link.
"""

import io
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload

BASE_DIR   = Path(__file__).parent.parent
CREDS_FILE = BASE_DIR / "credentials.json"
TOKEN_FILE = BASE_DIR / "token.json"

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file",
]


def _get_service():
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
    return build("drive", "v3", credentials=creds)


def upload_pdf(pdf_path: Path, filename: str) -> str:
    """
    Upload a PDF file to Google Drive.
    Makes it publicly readable and returns the shareable view URL.
    """
    service = _get_service()

    file_metadata = {"name": filename}
    media = MediaIoBaseUpload(
        io.BytesIO(pdf_path.read_bytes()),
        mimetype="application/pdf",
        resumable=False,
    )
    file = service.files().create(
        body=file_metadata,
        media_body=media,
        fields="id",
    ).execute()

    file_id = file.get("id")

    # Make it readable by anyone with the link
    service.permissions().create(
        fileId=file_id,
        body={"role": "reader", "type": "anyone"},
    ).execute()

    return f"https://drive.google.com/file/d/{file_id}/view"
