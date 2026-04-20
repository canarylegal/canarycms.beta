"""Outlook .msg → RFC822 .eml conversion (uses third-party extract-msg; see PyPI for license)."""

from __future__ import annotations

from email.policy import SMTP
from pathlib import Path


def outlook_msg_path_to_eml_bytes(path: Path) -> bytes:
    """Parse an Outlook .msg file and return the same message as RFC822 bytes."""
    import extract_msg

    m = extract_msg.openMsg(str(path))
    try:
        em = m.asEmailMessage()
        return em.as_bytes(policy=SMTP)
    finally:
        m.close()
