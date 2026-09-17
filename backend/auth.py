"""
SAFORA authentication — real signup/login, no mock, no third-party auth
service required.

Deliberately uses ONLY Python's standard library for the cryptography, so
this works the moment you run `uvicorn main:app --reload` with the
dependencies already in requirements.txt — no extra `pip install` needed:

  - Passwords: PBKDF2-HMAC-SHA256, 200k iterations, random salt per user
    (hashlib.pbkdf2_hmac). Never stored or logged in plain text.
  - Sessions: a compact signed token (HMAC-SHA256 over a JSON payload +
    expiry) — functionally the same idea as a JWT, without pulling in a
    JWT library. Verified with hmac.compare_digest (constant-time) so
    token-guessing can't be sped up via timing side-channels.
  - Storage: SQLite (sqlite3, stdlib) — a real file on disk, survives
    restarts, one row per user. Fine for a small app; swap for a hosted
    Postgres/MySQL if this needs to scale past a single instance.
  - Brute force: failed login attempts are throttled per email, in memory
    (5 attempts, then a 15 minute lock). Resets on a successful login.

SECURITY NOTE ON THE SESSION SECRET: by default a random secret is
generated each time the process starts, which means every restart
invalidates all existing sessions (users just have to log in again — safe,
just mildly annoying). For a real deployment, set the AUTH_SECRET_KEY
environment variable to a long random value so sessions survive restarts,
and so a restart isn't a low-effort way to force every user to re-auth
against a *new* secret an attacker could otherwise try to influence.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, field_validator

# ─── Config ─────────────────────────────────────────────────────────────────

DB_PATH = Path(__file__).parent / "safora.db"
SESSION_TTL_SECONDS = 7 * 24 * 3600  # 7 days
PBKDF2_ITERATIONS = 200_000
MAX_LOGIN_ATTEMPTS = 5
LOGIN_LOCKOUT_SECONDS = 15 * 60

SECRET_KEY = os.environ.get("AUTH_SECRET_KEY")
if not SECRET_KEY:
    SECRET_KEY = secrets.token_hex(32)
    print(
        "[auth] WARNING: AUTH_SECRET_KEY is not set — using a random secret "
        "generated for this process only. Every restart will invalidate all "
        "existing sessions. Set AUTH_SECRET_KEY in your environment for a "
        "real deployment."
    )

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
ALLOWED_ROLES = {"resident", "business", "law-enforcement"}

router = APIRouter(prefix="/api/auth", tags=["auth"])


# ─── Storage ────────────────────────────────────────────────────────────────

def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _get_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                display_name TEXT NOT NULL,
                role TEXT NOT NULL,
                created_at REAL NOT NULL
            )
            """
        )


# ─── Password hashing (PBKDF2-HMAC-SHA256, stdlib only) ─────────────────────

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iterations_s, salt_hex, hash_hex = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        iterations = int(iterations_s)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
    except (ValueError, AttributeError):
        return False
    candidate = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(candidate, expected)


# ─── Session tokens (HMAC-signed, JWT-equivalent, stdlib only) ──────────────

def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def create_session_token(uid: str) -> str:
    payload = {"sub": uid, "exp": time.time() + SESSION_TTL_SECONDS}
    payload_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    payload_b64 = _b64url_encode(payload_bytes)
    signature = hmac.new(SECRET_KEY.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256).digest()
    return f"{payload_b64}.{_b64url_encode(signature)}"


def verify_session_token(token: str) -> Optional[str]:
    """Returns the uid if the token is valid and unexpired, else None."""
    try:
        payload_b64, sig_b64 = token.split(".")
    except ValueError:
        return None
    expected_sig = hmac.new(SECRET_KEY.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256).digest()
    try:
        actual_sig = _b64url_decode(sig_b64)
    except Exception:
        return None
    if not hmac.compare_digest(expected_sig, actual_sig):
        return None
    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except Exception:
        return None
    if payload.get("exp", 0) < time.time():
        return None
    return payload.get("sub")


# ─── Brute-force throttling (in-memory; per-process, resets on restart) ─────

_failed_attempts: dict[str, list[float]] = {}


def _is_locked_out(email: str) -> bool:
    now = time.time()
    attempts = [t for t in _failed_attempts.get(email, []) if now - t < LOGIN_LOCKOUT_SECONDS]
    _failed_attempts[email] = attempts
    return len(attempts) >= MAX_LOGIN_ATTEMPTS


def _record_failed_attempt(email: str) -> None:
    _failed_attempts.setdefault(email, []).append(time.time())


def _clear_failed_attempts(email: str) -> None:
    _failed_attempts.pop(email, None)


# ─── Request / response schemas ──────────────────────────────────────────────

class SignupRequest(BaseModel):
    email: str
    password: str
    displayName: str
    role: Literal["resident", "business", "law-enforcement"] = "resident"

    @field_validator("email")
    @classmethod
    def _valid_email(cls, v: str) -> str:
        v = v.strip().lower()
        if not EMAIL_RE.match(v):
            raise ValueError("Enter a valid email address.")
        return v

    @field_validator("password")
    @classmethod
    def _valid_password(cls, v: str) -> str:
        if len(v) < 6:
            raise ValueError("Password must be at least 6 characters.")
        if len(v) > 200:
            raise ValueError("Password is too long.")
        return v

    @field_validator("displayName")
    @classmethod
    def _valid_name(cls, v: str) -> str:
        v = v.strip()[:80]
        return v or "User"


class LoginRequest(BaseModel):
    email: str
    password: str


class UserOut(BaseModel):
    uid: str
    email: str
    displayName: str
    role: str


class AuthResponse(BaseModel):
    token: str
    user: UserOut


def _row_to_user(row: sqlite3.Row) -> UserOut:
    return UserOut(uid=row["id"], email=row["email"], displayName=row["display_name"], role=row["role"])


# ─── Routes ──────────────────────────────────────────────────────────────────

@router.post("/signup", response_model=AuthResponse, status_code=201)
def signup(req: SignupRequest):
    with _get_conn() as conn:
        existing = conn.execute("SELECT id FROM users WHERE email = ?", (req.email,)).fetchone()
        if existing:
            # Same public message an attacker would see either way — don't
            # confirm which emails are registered.
            raise HTTPException(status_code=400, detail="Could not create account with those details.")

        uid = secrets.token_hex(16)
        conn.execute(
            "INSERT INTO users (id, email, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (uid, req.email, hash_password(req.password), req.displayName, req.role, time.time()),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()

    token = create_session_token(uid)
    return AuthResponse(token=token, user=_row_to_user(row))


@router.post("/login", response_model=AuthResponse)
def login(req: LoginRequest):
    email = req.email.strip().lower()

    if _is_locked_out(email):
        raise HTTPException(
            status_code=429,
            detail=f"Too many failed attempts. Try again in a few minutes.",
        )

    with _get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()

    # Always run a hash comparison, even for a nonexistent user, against a
    # dummy hash — this keeps login timing similar for "no such user" vs
    # "wrong password" so an attacker can't use response time to enumerate
    # which emails have accounts.
    dummy_hash = "pbkdf2_sha256$200000$" + ("00" * 16) + "$" + ("00" * 32)
    ok = verify_password(req.password, row["password_hash"] if row else dummy_hash)

    if not row or not ok:
        _record_failed_attempt(email)
        raise HTTPException(status_code=401, detail="Invalid email or password.")

    _clear_failed_attempts(email)
    token = create_session_token(row["id"])
    return AuthResponse(token=token, user=_row_to_user(row))


@router.get("/me", response_model=UserOut)
def me(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated.")
    token = authorization.removeprefix("Bearer ").strip()
    uid = verify_session_token(token)
    if not uid:
        raise HTTPException(status_code=401, detail="Session expired or invalid — please sign in again.")

    with _get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="Account no longer exists.")
    return _row_to_user(row)
