"""
Permissive CORS for /webdav.

ONLYOFFICE Desktop (and similar) may load remote URLs through an embedded web view that applies
browser CORS rules. The main API keeps a strict allowlist for the SPA; WebDAV uses token-in-path
auth instead of cookies.

Browsers reject ``Access-Control-Allow-Origin: *`` together with ``Access-Control-Allow-Credentials:
true``. :class:`CORSMiddleware` sets credentials on responses, so we **drop** credentials for
``/webdav`` and either echo the request ``Origin`` (when present) or use ``*``.
"""

from __future__ import annotations

import logging

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

_access = logging.getLogger("uvicorn.access")

_WEBDAV_CORS = {
    "Access-Control-Allow-Methods": "OPTIONS, GET, HEAD, PUT, PROPFIND, LOCK, UNLOCK",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": (
        "Lock-Token, ETag, Content-Length, Content-Type, Last-Modified, Content-Disposition, DAV"
    ),
    "Access-Control-Max-Age": "86400",
}


def _merge_cors(request: Request, response: Response) -> Response:
    # Incompatible pair breaks fetch() in embedded web views (see user curl with ACAC + *).
    # MutableHeaders has no .pop(); use del + __contains__.
    _acac = "access-control-allow-credentials"
    if _acac in response.headers:
        del response.headers[_acac]

    origin = (request.headers.get("origin") or "").strip()
    if origin:
        response.headers["Access-Control-Allow-Origin"] = origin
        if hasattr(response.headers, "add_vary_header"):
            response.headers.add_vary_header("Origin")
        else:
            vary = response.headers.get("vary")
            response.headers["Vary"] = f"{vary}, Origin" if vary else "Origin"
    else:
        response.headers["Access-Control-Allow-Origin"] = "*"

    for k, v in _WEBDAV_CORS.items():
        response.headers[k] = v
    return response


class WebdavPublicCORSMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if not request.url.path.startswith("/webdav"):
            return await call_next(request)
        response = await call_next(request)
        client = request.client.host if request.client else "-"
        _access.info(
            '%s - "%s %s HTTP/%s" %s',
            client,
            request.method,
            request.url.path,
            request.scope.get("http_version", "1.1"),
            response.status_code,
        )
        return _merge_cors(request, response)
