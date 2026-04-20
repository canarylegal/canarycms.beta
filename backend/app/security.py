import os
import time
from dataclasses import dataclass

import pyotp
from jose import JWTError, jwt
from passlib.context import CryptContext


# Use PBKDF2 to avoid bcrypt backend quirks in containers and the 72-byte limit.
pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)


def _require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


JWT_SECRET = _require_env("JWT_SECRET")
JWT_ALG = "HS256"
JWT_TTL_SECONDS = int(os.getenv("JWT_TTL_SECONDS", "28800"))  # 8h


def create_access_token(*, user_id: str, role: str) -> str:
    now = int(time.time())
    payload = {
        "sub": user_id,
        "role": role,
        "iat": now,
        "exp": now + JWT_TTL_SECONDS,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


@dataclass(frozen=True)
class TokenPayload:
    user_id: str
    role: str


EML_OPEN_TTL_SECONDS = int(os.getenv("EML_OPEN_TTL_SECONDS", "120"))


@dataclass(frozen=True)
class EmlOpenTokenPayload:
    user_id: str
    case_id: str
    file_id: str


def create_eml_open_token(*, user_id: str, case_id: str, file_id: str) -> str:
    """Short-lived JWT for GET without Authorization (opens mail client / download hand-off)."""
    now = int(time.time())
    payload = {
        "sub": user_id,
        "purpose": "eml_open",
        "case_id": case_id,
        "file_id": file_id,
        "iat": now,
        "exp": now + EML_OPEN_TTL_SECONDS,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


def decode_eml_open_token(token: str) -> EmlOpenTokenPayload:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except JWTError as e:
        raise ValueError("Invalid or expired token") from e
    if payload.get("purpose") != "eml_open":
        raise ValueError("Invalid token")
    case_id = payload.get("case_id")
    file_id = payload.get("file_id")
    sub = payload.get("sub")
    if not isinstance(case_id, str) or not isinstance(file_id, str) or not isinstance(sub, str):
        raise ValueError("Invalid token payload")
    return EmlOpenTokenPayload(user_id=sub, case_id=case_id, file_id=file_id)


def decode_access_token(token: str) -> TokenPayload:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except JWTError as e:
        raise ValueError("Invalid token") from e

    sub = payload.get("sub")
    role = payload.get("role")
    if not isinstance(sub, str) or not isinstance(role, str):
        raise ValueError("Invalid token payload")
    return TokenPayload(user_id=sub, role=role)


def generate_totp_secret() -> str:
    return pyotp.random_base32()


def build_totp_uri(*, secret: str, email: str, issuer: str) -> str:
    return pyotp.totp.TOTP(secret).provisioning_uri(name=email, issuer_name=issuer)


def verify_totp(*, secret: str, code: str) -> bool:
    try:
        return pyotp.TOTP(secret).verify(code, valid_window=1)
    except Exception:
        return False
