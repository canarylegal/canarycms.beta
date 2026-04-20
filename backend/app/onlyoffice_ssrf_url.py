"""
ONLYOFFICE Document Server runs in Docker and downloads document.url / POSTs callbacks server-side.

A very common misconfiguration is ONLYOFFICE_APP_URL_INTERNAL=http://192.168.x.x:8000 in `.env`
(thinking it should match CANARY_PUBLIC_URL). That puts the host LAN IP in the JWT; from inside the
`onlyoffice` container that address is often unroutable, so the editor stays blank and grep finds
nothing useful in DS logs.

We normalize private/host-loopback URLs to http://backend:8000 unless ONLYOFFICE_ALLOW_LAN_INTERNAL=1.
"""

from __future__ import annotations

import ipaddress
import logging
import os
import socket
from urllib.parse import urlparse

log = logging.getLogger(__name__)

_DEFAULT_DOCKER = "http://backend:8000"

# Shared Address Space (RFC 6598, 100.64.0.0/10) — used by Tailscale and carrier NAT.
# Python's ipaddress module does NOT classify this range as ip.is_private (it's not RFC 1918),
# so we check it explicitly. OO DS's request-filtering-agent blocks these IPs even when
# allowPrivateIPAddress=true, because it treats them as a separate "shared" category.
_CGNAT_RANGE = ipaddress.ip_network("100.64.0.0/10")


def _try_ipv4_peer_base(service: str, port: int) -> str | None:
    """Resolve a Compose DNS name to an IPv4 literal URL (http://172.x.x.x:port).

    ONLYOFFICE Document Server (Node) often fails to fetch ``document.url`` when the JWT uses
    ``http://backend:8000`` or ``host.docker.internal`` (DNS/IPv6 quirks), so backend logs never show
    ``GET /webdav/sessions/...``. Peers on the same Docker network can still reach the API by IPv4.
    """
    try:
        for res in socket.getaddrinfo(service, port, socket.AF_INET, socket.SOCK_STREAM):
            ip = res[4][0]
            return f"http://{ip}:{port}"
    except OSError as e:
        log.debug("onlyoffice_ssrf: could not resolve %s to IPv4: %s", service, e)
    return None


def default_internal_base_for_ds() -> str:
    """
    Base URL for JWT ``document.url`` and ``callbackUrl`` (Document Server → Canary, server-side).

    - If ``ONLYOFFICE_APP_URL_INTERNAL`` is set, apply :func:`normalize_onlyoffice_ssrf_base`.
    - Else default to ``http://backend:8000`` (normalized). ONLYOFFICE treats JWT-signed ``document.url``
      as trusted; using the Compose DNS name matches their guidance and avoids odd literal-IP paths.
    - If ``ONLYOFFICE_PREFER_IPV4_FOR_DS`` is true, use ``http://<ipv4>:8000`` for ``backend`` (or
      ``ONLYOFFICE_DOCKER_PEER_SERVICE``) when resolution succeeds — opt-in for broken Docker DNS.
    """
    explicit = (os.getenv("ONLYOFFICE_APP_URL_INTERNAL") or "").strip().rstrip("/")
    if explicit:
        return normalize_onlyoffice_ssrf_base(explicit)

    prefer_ipv4 = (os.getenv("ONLYOFFICE_PREFER_IPV4_FOR_DS") or "").strip().lower() in (
        "1",
        "true",
        "yes",
    )
    if prefer_ipv4:
        peer = (os.getenv("ONLYOFFICE_DOCKER_PEER_SERVICE") or "backend").strip() or "backend"
        port = 8000
        try:
            port = int((os.getenv("ONLYOFFICE_DOCKER_PEER_PORT") or "8000").strip() or "8000")
        except ValueError:
            port = 8000

        ip_url = _try_ipv4_peer_base(peer, port)
        if ip_url:
            log.info(
                "onlyoffice_ssrf: ONLYOFFICE_PREFER_IPV4_FOR_DS: using %s for DS JWT (peer=%s)",
                ip_url,
                peer,
            )
            return ip_url

    return normalize_onlyoffice_ssrf_base(_DEFAULT_DOCKER)


def normalize_onlyoffice_ssrf_base(url: str) -> str:
    """
    Return a base URL that Document Server can use from its container to reach Canary.

    - Preserves ``backend``, ``host.docker.internal``, public hostnames, and non-IP hostnames.
    - Replaces RFC1918 / loopback / link-local *IP literals* with ``http://backend:8000`` by default.
    """
    u = (url or "").strip().rstrip("/")
    if not u:
        return _DEFAULT_DOCKER

    flag = (os.getenv("ONLYOFFICE_ALLOW_LAN_INTERNAL") or "").strip().lower()
    if flag in ("1", "true", "yes"):
        return u

    try:
        p = urlparse(u)
        host = (p.hostname or "").lower()
        if not host:
            return u
        # Docker Compose service names
        if host in ("backend", "frontend", "onlyoffice", "db", "canary-backend", "canary-onlyoffice"):
            return u
        if host == "host.docker.internal":
            return u

        if host == "localhost":
            log.warning(
                "onlyoffice_ssrf: ONLYOFFICE URL host is localhost — from inside the onlyoffice container "
                "that is usually wrong. Using %s. Set ONLYOFFICE_ALLOW_LAN_INTERNAL=1 to force %s.",
                _DEFAULT_DOCKER,
                u,
            )
            return _DEFAULT_DOCKER

        try:
            ip = ipaddress.ip_address(host)
            blocked = (
                ip.is_private
                or ip.is_link_local
                or ip.is_loopback
                or ip in _CGNAT_RANGE  # Tailscale / carrier-grade NAT (100.64.0.0/10, RFC 6598)
            )
            if blocked:
                log.warning(
                    "onlyoffice_ssrf: replacing %s with %s (Document Server cannot reliably reach %s from "
                    "inside Docker; use the Compose service URL or set ONLYOFFICE_ALLOW_LAN_INTERNAL=1).",
                    u,
                    _DEFAULT_DOCKER,
                    host,
                )
                return _DEFAULT_DOCKER
        except ValueError:
            # Not an IP literal — e.g. public DNS name; keep as-is.
            pass
    except Exception:
        return u
    return u
