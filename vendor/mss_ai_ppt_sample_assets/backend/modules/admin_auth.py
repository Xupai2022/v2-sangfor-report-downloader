"""Admin authentication module.

This module provides authentication utilities for the admin dashboard,
including password hashing, verification, and session management.
"""

import bcrypt
import secrets
from typing import Optional, Dict
from datetime import datetime, timedelta, timezone
import logging

logger = logging.getLogger(__name__)


class SessionStore:
    """In-memory session store for admin authentication.

    For single admin user scenario, in-memory storage is sufficient.
    For multi-instance deployment, consider using Redis.
    """

    def __init__(self):
        self._sessions: Dict[str, Dict[str, any]] = {}

    def create(self, username: str) -> str:
        """Create a new session and return session token."""
        token = secrets.token_urlsafe(32)
        now = datetime.now(timezone.utc)
        self._sessions[token] = {
            "username": username,
            "created_at": now,
            "last_accessed": now,
        }
        logger.info(f"Created session for user: {username}")
        return token

    def verify(self, token: str) -> Optional[str]:
        """Verify session token and return username if valid."""
        session = self._sessions.get(token)
        if not session:
            return None

        # Update last accessed time
        session["last_accessed"] = datetime.now(timezone.utc)
        return session["username"]

    def delete(self, token: str) -> bool:
        """Delete session token."""
        if token in self._sessions:
            username = self._sessions[token].get("username")
            del self._sessions[token]
            logger.info(f"Deleted session for user: {username}")
            return True
        return False

    def cleanup_expired(self, max_age_seconds: int = 604800):
        """Clean up expired sessions (older than max_age_seconds)."""
        now = datetime.now(timezone.utc)
        expired_tokens = []

        for token, session in self._sessions.items():
            age = (now - session["created_at"]).total_seconds()
            if age > max_age_seconds:
                expired_tokens.append(token)

        for token in expired_tokens:
            self.delete(token)

        if expired_tokens:
            logger.info(f"Cleaned up {len(expired_tokens)} expired sessions")


# Global session store instance
_session_store = SessionStore()


def get_password_hash(password: str) -> str:
    """Generate bcrypt hash for password.

    Args:
        password: Plain text password

    Returns:
        Bcrypt hashed password string
    """
    salt = bcrypt.gensalt(rounds=12)
    hashed = bcrypt.hashpw(password.encode('utf-8'), salt)
    return hashed.decode('utf-8')


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify password against bcrypt hash.

    Args:
        plain_password: Plain text password to verify
        hashed_password: Bcrypt hashed password

    Returns:
        True if password matches, False otherwise
    """
    try:
        return bcrypt.checkpw(
            plain_password.encode('utf-8'),
            hashed_password.encode('utf-8')
        )
    except Exception as e:
        logger.error(f"Password verification error: {e}")
        return False


def create_session(username: str) -> str:
    """Create a new admin session.

    Args:
        username: Admin username

    Returns:
        Session token string
    """
    return _session_store.create(username)


def verify_session(session_token: str) -> Optional[str]:
    """Verify admin session token.

    Args:
        session_token: Session token to verify

    Returns:
        Username if session is valid, None otherwise
    """
    return _session_store.verify(session_token)


def delete_session(session_token: str) -> bool:
    """Delete admin session.

    Args:
        session_token: Session token to delete

    Returns:
        True if session was deleted, False if not found
    """
    return _session_store.delete(session_token)


def cleanup_expired_sessions(max_age_seconds: int = 604800):
    """Clean up expired admin sessions.

    Args:
        max_age_seconds: Maximum age in seconds before session expires
    """
    _session_store.cleanup_expired(max_age_seconds)
