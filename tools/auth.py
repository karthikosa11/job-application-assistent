"""
Authentication helpers.

- Google OAuth2 flow (server-side redirect, works with chrome.identity.launchWebAuthFlow)
- JWT creation / verification
- @require_auth Flask decorator
"""

import os
import functools
from datetime import datetime, timedelta, timezone

import jwt
import requests
from flask import request, jsonify, g

JWT_SECRET = os.getenv("JWT_SECRET", "dev-secret-change-in-production")
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_DAYS = 30

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
APP_URL = os.getenv("APP_URL", "http://127.0.0.1:8765")


# ─── JWT ──────────────────────────────────────────────────────────────────────

def create_jwt(user_id: str, email: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "exp": datetime.now(timezone.utc) + timedelta(days=JWT_EXPIRY_DAYS),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_jwt(token: str) -> dict | None:
    """Return decoded payload or None if invalid/expired."""
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None


# ─── Decorator ────────────────────────────────────────────────────────────────

def require_auth(f):
    """Flask route decorator — validates Bearer JWT and loads g.user."""
    @functools.wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return jsonify({"error": "Missing or invalid Authorization header"}), 401
        token = auth_header[7:]
        payload = decode_jwt(token)
        if payload is None:
            return jsonify({"error": "Token expired or invalid"}), 401

        from tools.database import SessionLocal
        from tools.models import User
        db = SessionLocal()
        try:
            user = db.query(User).filter_by(id=payload["sub"]).first()
            if user is None:
                return jsonify({"error": "User not found"}), 401
            g.user = user
            g.db = db
            return f(*args, **kwargs)
        except Exception:
            db.close()
            raise
        finally:
            # Only close if the route didn't already use it
            # (routes that commit inside will still reach here)
            try:
                db.close()
            except Exception:
                pass
    return decorated


# ─── Google OAuth helpers ─────────────────────────────────────────────────────

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"

SCOPES = "openid email profile https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file"


def google_auth_url(redirect_uri: str, state: str = "") -> str:
    """Build the Google OAuth2 authorization URL."""
    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPES,
        "access_type": "offline",
        "prompt": "consent",
    }
    if state:
        params["state"] = state
    query = "&".join(f"{k}={requests.utils.quote(str(v))}" for k, v in params.items())
    return f"{GOOGLE_AUTH_URL}?{query}"


def exchange_code_for_tokens(code: str, redirect_uri: str) -> dict:
    """Exchange an authorization code for access + refresh tokens."""
    resp = requests.post(GOOGLE_TOKEN_URL, data={
        "code": code,
        "client_id": GOOGLE_CLIENT_ID,
        "client_secret": GOOGLE_CLIENT_SECRET,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }, timeout=10)
    resp.raise_for_status()
    return resp.json()


def get_google_userinfo(access_token: str) -> dict:
    """Fetch user profile from Google using an access token."""
    resp = requests.get(
        GOOGLE_USERINFO_URL,
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()
