import base64
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import Callable

from fastapi import Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .core import settings
from .db import get_db
from .models import User

AUTH_COOKIE_NAME = "c360_session"
AUTH_PBKDF2_ITERATIONS = 210_000


class AuthUserOut(BaseModel):
    id: str
    email: str
    display_name: str
    role: str
    ae_code: str | None = None
    must_change_password: bool = False


class LoginRequest(BaseModel):
    email: str
    password: str


def _secret() -> bytes:
    secret = getattr(settings, "auth_secret", None) or settings.database_url
    return str(secret).encode("utf-8")


def hash_password(password: str, salt: str | None = None) -> str:
    salt_bytes = bytes.fromhex(salt) if salt else secrets.token_bytes(16)
    derived = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt_bytes,
        AUTH_PBKDF2_ITERATIONS,
    )
    return "pbkdf2_sha256${iterations}${salt}${hash}".format(
        iterations=AUTH_PBKDF2_ITERATIONS,
        salt=salt_bytes.hex(),
        hash=derived.hex(),
    )


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        algorithm, iterations, salt, expected_hash = stored_hash.split("$")
    except ValueError:
        return False

    if algorithm != "pbkdf2_sha256":
        return False

    derived = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        bytes.fromhex(salt),
        int(iterations),
    ).hex()
    return hmac.compare_digest(derived, expected_hash)


SETUP_TOKEN_TTL_DAYS = 7


def _hash_token(token: str) -> str:
    # Setup tokens are bearer credentials (whoever holds the link can set the password),
    # so only a hash is ever stored — same reasoning as password_hash, cheaper than PBKDF2
    # since the token itself is already high-entropy random, not user-chosen.
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def generate_setup_token() -> tuple[str, str, datetime]:
    """Returns (plain_token, token_hash, expires_at). The plain token is shown exactly
    once, in the API response right after creation — nothing else on the server ever
    sees it again."""
    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(days=SETUP_TOKEN_TTL_DAYS)
    return token, _hash_token(token), expires_at


def find_user_by_setup_token(db: Session, token: str) -> User | None:
    if not token:
        return None
    user = db.scalar(select(User).where(User.setup_token_hash == _hash_token(token)))
    if not user or not user.setup_token_expires_at:
        return None
    expires_at = user.setup_token_expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at < datetime.now(timezone.utc):
        return None
    return user


def _sign(value: str) -> str:
    signature = hmac.new(_secret(), value.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{value}.{signature}"


def _unsign(token: str) -> str | None:
    if "." not in token:
        return None
    value, signature = token.rsplit(".", 1)
    expected = hmac.new(_secret(), value.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        return None
    return value


# B-2: tokens used to be `sign(user_id)` with no expiry at all -- a leaked cookie was
# valid forever, and logout could never revoke it. The signed value now carries the
# issue time (`user_id:issued_at_epoch`) so a token past this TTL is rejected even if
# its signature is still valid. This intentionally invalidates every session issued
# before this change, since old tokens have no ":" to split on.
AUTH_SESSION_TTL_SECONDS = 60 * 60 * 24 * 14  # 14 days


def create_session_token(user_id: str) -> str:
    issued_at = int(datetime.now(timezone.utc).timestamp())
    return _sign(f"{user_id}:{issued_at}")


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = request.cookies.get(AUTH_COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    value = _unsign(token)
    if not value:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    try:
        user_id, issued_at_str = value.rsplit(":", 1)
        issued_at = int(issued_at_str)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    if datetime.now(timezone.utc).timestamp() - issued_at > AUTH_SESSION_TTL_SECONDS:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired")

    user = db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    return user


def require_role(roles: str | list[str]) -> Callable:
    allowed = {roles} if isinstance(roles, str) else set(roles)

    def dependency(user: User = Depends(get_current_user)) -> User:
        # super_admin bypasses every role check unconditionally — it's the one role
        # guaranteed to pass any require_role(...), including ones added later that
        # forget to list it explicitly.
        if user.role == "super_admin":
            return user
        if user.role not in allowed:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
        return user

    return dependency


def get_ae_scope(user: User = Depends(get_current_user)) -> str | None:
    """None means unrestricted (admin/sales_lead). A non-None string is the
    ae_code every scoped query must filter to for this request.

    An 'ae'-role user with no ae_code configured gets 403 rather than either
    extreme (seeing nothing silently, or falling through to unrestricted) —
    that's a setup error an admin needs to fix, not a state the app should
    paper over.
    """
    if user.role != "ae":
        return None
    if not user.ae_code:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Your account has no AE code configured — contact an admin.")
    return user.ae_code


def serialize_user(user: User) -> AuthUserOut:
    return AuthUserOut(
        id=str(user.id),
        email=user.email,
        display_name=user.display_name,
        role=user.role,
        ae_code=user.ae_code,
        must_change_password=user.must_change_password,
    )